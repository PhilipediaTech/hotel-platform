import { Prisma } from '../generated/prisma/client.ts';
import type { Db } from './db.ts';
import { requireTenant, TenancyError, type TenantContext } from './tenancy.ts';

// Prisma client extension (spec tab 2, "Tenancy"): every query on a tenant model gets the
// current tenant's IDs added to its filter, every write gets them set, and anything outside
// a tenant context throws. Module repositories use this client; the plain client is for
// identity and platform code that is cross-tenant by nature (sign-in, sessions, sign-up).
//
// Each model is listed with its scope. A model that isn't listed is refused, so a new table
// must be classified here before tenant code can touch it.

type Scope =
  /** Rows belong to one property (and its organisation). */
  | { kind: 'property'; organisationField?: string }
  /** Rows belong to the organisation (all its properties). */
  | { kind: 'organisation' }
  /** The organisation row itself. */
  | { kind: 'organisation-root' };

export const TENANT_MODELS: Record<string, Scope> = {
  Organisation: { kind: 'organisation-root' },
  Property: { kind: 'organisation' },
  Department: { kind: 'property', organisationField: 'organisationId' },
  PropertyCounter: { kind: 'property' },
  Role: { kind: 'organisation' },
  Membership: { kind: 'organisation' },
  Invitation: { kind: 'organisation' },
  FeatureFlag: { kind: 'organisation' },
  // Events can name any property of the organisation, or none (organisation-level).
  AuditEvent: { kind: 'organisation' },
  // Outbox rows: like audit events, any property of the organisation or none.
  DomainEvent: { kind: 'organisation' },
  ApprovalPolicy: { kind: 'property', organisationField: 'organisationId' },
  ApprovalRequest: { kind: 'property', organisationField: 'organisationId' },
  // Every file kind so far belongs to a property; organisation-level files (null property)
  // would need their own scope.
  FileObject: { kind: 'property', organisationField: 'organisationId' },
  RoomType: { kind: 'property', organisationField: 'organisationId' },
  Room: { kind: 'property', organisationField: 'organisationId' },
  RoomBlock: { kind: 'property' },
  RevenueCode: { kind: 'property' },
  // Versions have no property column: reach them through their (scoped) rule.
  TaxRule: { kind: 'property' },
  CancellationPolicy: { kind: 'property' },
  RatePlan: { kind: 'property', organisationField: 'organisationId' },
  RateDay: { kind: 'property' },
  ImportJob: { kind: 'property' },
  RoomTypeInventory: { kind: 'property' },
  Quote: { kind: 'property' },
  // Guests and companies belong to the organisation: every property sees them.
  Guest: { kind: 'organisation' },
  Company: { kind: 'organisation' },
  Reservation: { kind: 'property', organisationField: 'organisationId' },
  // Status history and stay nights have no property column: reach them through their
  // (scoped) reservation and stay.
  Stay: { kind: 'property' },
  RoomAllocation: { kind: 'property' },
  IdDocument: { kind: 'property' },
  KeyIssue: { kind: 'property' },
  BusinessDay: { kind: 'property' },
  Folio: { kind: 'property', organisationField: 'organisationId' },
  FolioLine: { kind: 'property' },
  RegistrationCard: { kind: 'property' },
  // Components have no property column: reach them through their (scoped) rate plan.
};

/** Fields (and values) that pin a row of `model` to `tenant`. */
function scopeFields(model: string, tenant: TenantContext): Record<string, string> {
  const scope = TENANT_MODELS[model];
  if (!scope) {
    throw new TenancyError(`${model} is not a tenant model; use the base client for it`);
  }
  switch (scope.kind) {
    case 'organisation-root':
      return { id: tenant.organisationId };
    case 'organisation':
      return { organisationId: tenant.organisationId };
    case 'property':
      return {
        propertyId: tenant.propertyId,
        ...(scope.organisationField ? { [scope.organisationField]: tenant.organisationId } : {}),
      };
  }
}

const FILTERED = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'delete',
  'deleteMany',
  'upsert',
]);
const CREATES = new Set(['create', 'createMany', 'createManyAndReturn']);

type Data = Record<string, unknown>;

/** Sets the scope fields on new rows; a row aimed at another tenant is a bug, so it throws. */
function scopedData(model: string, data: Data, fields: Record<string, string>): Data {
  for (const [field, value] of Object.entries(fields)) {
    if (field in data && data[field] !== value) {
      throw new TenancyError(`${model}.${field} must be the current tenant's`);
    }
  }
  return { ...data, ...fields };
}

/** Updates may not move a row to another tenant. */
function checkUpdate(model: string, data: Data, fields: Record<string, string>): void {
  for (const [field, value] of Object.entries(fields)) {
    if (field in data && data[field] !== value) {
      throw new TenancyError(`${model}.${field} can't be changed to another tenant`);
    }
  }
}

export const tenantExtension = Prisma.defineExtension({
  name: 'tenancy',
  query: {
    $allModels: {
      $allOperations({ model, operation, args, query }) {
        const fields = scopeFields(model, requireTenant());
        const a = args as Data;

        if (FILTERED.has(operation)) {
          // Spread rather than AND, so unique lookups keep their unique field at the top
          // level (Prisma accepts extra filters next to it). Scope values win over the caller's.
          a['where'] = { ...(a['where'] as Data | undefined), ...fields };
          if (operation === 'upsert') {
            a['create'] = scopedData(model, a['create'] as Data, fields);
            checkUpdate(model, a['update'] as Data, fields);
          } else if (operation.startsWith('update')) {
            checkUpdate(model, a['data'] as Data, fields);
          }
        } else if (CREATES.has(operation)) {
          const data = a['data'] as Data | Data[];
          a['data'] = Array.isArray(data)
            ? data.map((row) => scopedData(model, row, fields))
            : scopedData(model, data, fields);
        } else {
          throw new TenancyError(`${model}.${operation} is not supported on the tenant client`);
        }
        return query(a);
      },
    },
  },
});

/** The tenant-scoped client for module code. */
export function createTenantDb(db: Db) {
  return db.$extends(tenantExtension);
}

export type TenantDb = ReturnType<typeof createTenantDb>;
