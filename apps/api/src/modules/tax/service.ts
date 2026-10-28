import {
  localDate,
  TAX_LINE_GROUPS,
  type RevenueCodeBody,
  type RevenueCodeItem,
  type RevenueCodePatchBody,
  type TaxConfirmation,
  type TaxRuleBody,
  type TaxRuleItem,
  type TaxVersionBody,
} from '@hotel/shared';
import type { z } from 'zod';
import type {
  Prisma,
  RevenueCode,
  TaxRule,
  TaxRuleVersion,
} from '../../generated/prisma/client.ts';
import { recordAudit } from '../../core/audit.ts';
import type { Clock } from '../../core/clock.ts';
import { pgErrorInfo, type Db } from '../../core/db.ts';
import { AppError } from '../../core/errors.ts';
import type { TenantDb } from '../../core/tenant-db.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import { taxSettingsOf } from './defaults.ts';

// Revenue codes, tax rules and dated versions (PRD M4-17, M4 rules 1–2; T-032). The
// calculator itself is shared (@hotel/shared tax.ts) so quotes, postings and the screen agree.

export interface TaxDeps {
  db: Db;
  tenantDb: TenantDb;
  clock: Clock;
}

type Tx = Parameters<Parameters<TenantDb['$transaction']>[0]>[0];
type CodeOut = z.input<typeof RevenueCodeItem>;
type RuleOut = z.input<typeof TaxRuleItem>;

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const day = (d: Date) => d.toISOString().slice(0, 10);
const dbDate = (date: string) => new Date(`${date}T00:00:00Z`);
const isTaxLineGroup = (group: string) => (TAX_LINE_GROUPS as readonly string[]).includes(group);

const invalid = (path: string, message: string) =>
  new AppError('VALIDATION_ERROR', message, {
    issues: [{ path: `body.${path}`, code: 'custom', message }],
  });

async function propertyOf(deps: TaxDeps, tenant: TenantContext) {
  return deps.db.property.findUniqueOrThrow({
    where: { id: tenant.propertyId },
    select: { id: true, timeZone: true, settings: true },
  });
}

// ── Revenue codes ──────────────────────────────────────────────────────────────────────

const codeItem = (c: RevenueCode): CodeOut => ({
  id: c.id,
  code: c.code,
  name: c.name,
  group: c.group,
  taxRuleIds: c.taxRuleIds,
  active: c.active,
});

export async function listRevenueCodes(deps: TaxDeps): Promise<CodeOut[]> {
  const codes = await deps.tenantDb.revenueCode.findMany({ orderBy: { code: 'asc' } });
  return codes.map(codeItem);
}

/** Taxes go on income codes only, and must be this property's rules. */
async function checkTaxes(tx: Tx, group: string, taxRuleIds: string[]): Promise<void> {
  if (taxRuleIds.length === 0) return;
  if (isTaxLineGroup(group)) {
    throw invalid('taxRuleIds', 'Tax and service charge codes carry no taxes of their own');
  }
  const found = await tx.taxRule.count({ where: { id: { in: taxRuleIds } } });
  if (found !== taxRuleIds.length) throw invalid('taxRuleIds', 'Choose taxes of this property');
}

const auditCode = (c: RevenueCode) => ({
  // `code` is a secret key name in audit rows (MFA codes), so it is spelled out.
  revenueCode: c.code,
  name: c.name,
  group: c.group,
  taxRuleIds: c.taxRuleIds,
  active: c.active,
});

export async function createRevenueCode(
  deps: TaxDeps,
  body: z.output<typeof RevenueCodeBody>,
): Promise<CodeOut> {
  try {
    return await deps.tenantDb.$transaction(async (tx) => {
      await checkTaxes(tx, body.group, body.taxRuleIds);
      const created = await tx.revenueCode.create({
        data: body as Prisma.RevenueCodeUncheckedCreateInput,
      });
      await recordAudit(tx, {
        action: 'revenuecode.created',
        entityType: 'revenue_code',
        entityId: created.id,
        after: auditCode(created),
      });
      return codeItem(created);
    });
  } catch (err) {
    const info = pgErrorInfo(err);
    if (info?.sqlState === '23505' && info.constraint === 'revenue_codes_property_id_code_key') {
      throw invalid('code', 'Another revenue code uses this code');
    }
    throw err;
  }
}

export async function updateRevenueCode(
  deps: TaxDeps,
  revenueCodeId: string,
  body: z.output<typeof RevenueCodePatchBody>,
): Promise<CodeOut> {
  return deps.tenantDb.$transaction(async (tx) => {
    const before = await tx.revenueCode.findUnique({ where: { id: revenueCodeId } });
    if (!before) throw new AppError('NOT_FOUND', 'Revenue code not found');
    if (body.taxRuleIds) await checkTaxes(tx, before.group, body.taxRuleIds);
    if (body.active === false && isTaxLineGroup(before.group)) {
      const rules = await tx.taxRule.count({ where: { revenueCodeId: before.id } });
      if (rules > 0) {
        throw new AppError('STATE_TRANSITION_INVALID', 'A tax still posts to this code', {
          taxRules: rules,
        });
      }
    }
    const after = await tx.revenueCode.update({ where: { id: before.id }, data: body });
    const was = auditCode(before);
    const now = auditCode(after);
    const changed = (Object.keys(now) as (keyof typeof now)[]).filter(
      (k) => JSON.stringify(was[k]) !== JSON.stringify(now[k]),
    );
    if (changed.length > 0) {
      await recordAudit(tx, {
        action: 'revenuecode.updated',
        entityType: 'revenue_code',
        entityId: before.id,
        before: Object.fromEntries(changed.map((k) => [k, was[k]])),
        after: Object.fromEntries(changed.map((k) => [k, now[k]])),
      });
    }
    return codeItem(after);
  });
}

// ── Tax rules ──────────────────────────────────────────────────────────────────────────

type RuleRow = TaxRule & { versions: TaxRuleVersion[] };

function ruleItem(rule: RuleRow, today: string): RuleOut {
  const versions = [...rule.versions].sort(
    (a, b) => a.effectiveFrom.getTime() - b.effectiveFrom.getTime(),
  );
  const current = versions.find(
    (v) => day(v.effectiveFrom) <= today && (!v.effectiveTo || today < day(v.effectiveTo)),
  );
  return {
    id: rule.id,
    name: rule.name,
    authority: rule.authority,
    revenueCodeId: rule.revenueCodeId,
    versions: versions.map((v) => ({
      id: v.id,
      effectiveFrom: day(v.effectiveFrom),
      effectiveTo: v.effectiveTo ? day(v.effectiveTo) : null,
      rateBps: v.rateBps,
      basis: v.basis,
      sequence: v.sequence,
      inclusive: v.inclusive,
      createdAt: iso(v.createdAt),
    })),
    currentVersionId: current?.id ?? null,
  };
}

async function confirmation(
  deps: TaxDeps,
  settings: Prisma.JsonValue,
): Promise<z.input<typeof TaxConfirmation>> {
  const taxes = taxSettingsOf(settings);
  const by = taxes.confirmedById
    ? await deps.db.user.findUnique({ where: { id: taxes.confirmedById } })
    : null;
  return {
    examples: taxes.examples === true,
    confirmedAt: taxes.confirmedAt ?? null,
    confirmedBy: by ? { id: by.id, name: by.name } : null,
  };
}

export async function listTaxRules(deps: TaxDeps, tenant: TenantContext) {
  const property = await propertyOf(deps, tenant);
  const today = localDate(deps.clock(), property.timeZone);
  const rules = await deps.tenantDb.taxRule.findMany({
    include: { versions: true },
    orderBy: { name: 'asc' },
  });
  return {
    data: rules.map((r) => ruleItem(r, today)),
    confirmation: await confirmation(deps, property.settings),
  };
}

const auditVersion = (v: z.output<typeof TaxVersionBody>) => ({
  effectiveFrom: v.effectiveFrom,
  rateBps: v.rateBps,
  basis: v.basis,
  sequence: v.sequence,
  inclusive: v.inclusive,
});

function checkStart(version: z.output<typeof TaxVersionBody>, today: string, path: string) {
  if (version.effectiveFrom < today) {
    throw invalid(path, 'Tax changes start today or later; posted lines keep their taxes');
  }
}

export async function createTaxRule(
  deps: TaxDeps,
  tenant: TenantContext,
  body: z.output<typeof TaxRuleBody>,
): Promise<RuleOut> {
  const property = await propertyOf(deps, tenant);
  const today = localDate(deps.clock(), property.timeZone);
  checkStart(body.version, today, 'version.effectiveFrom');
  return deps.tenantDb.$transaction(async (tx) => {
    const code = await tx.revenueCode.findUnique({ where: { id: body.revenueCodeId } });
    if (!code?.active || !isTaxLineGroup(code.group)) {
      throw invalid('revenueCodeId', 'Choose an active tax or service charge code');
    }
    const rule = await tx.taxRule.create({
      data: {
        name: body.name,
        authority: body.authority,
        revenueCodeId: code.id,
        versions: {
          create: { ...body.version, effectiveFrom: dbDate(body.version.effectiveFrom) },
        },
      } as Prisma.TaxRuleUncheckedCreateInput,
      include: { versions: true },
    });
    await recordAudit(tx, {
      action: 'taxrule.created',
      entityType: 'tax_rule',
      entityId: rule.id,
      after: { name: rule.name, authority: rule.authority, ...auditVersion(body.version) },
    });
    return ruleItem(rule, today);
  });
}

export async function addTaxRuleVersion(
  deps: TaxDeps,
  tenant: TenantContext,
  taxRuleId: string,
  body: z.output<typeof TaxVersionBody>,
): Promise<RuleOut> {
  const property = await propertyOf(deps, tenant);
  const today = localDate(deps.clock(), property.timeZone);
  checkStart(body, today, 'effectiveFrom');
  return deps.tenantDb.$transaction(async (tx) => {
    // The rule through the tenant client (versions have no property of their own); lock it so
    // two changes to one tax queue up.
    const rule = await tx.taxRule.findUnique({ where: { id: taxRuleId } });
    if (!rule) throw new AppError('NOT_FOUND', 'Tax rule not found');
    await tx.$queryRaw`SELECT id FROM tax_rules WHERE id = ${rule.id}::uuid FOR UPDATE`;
    // Versions are reached through their rule: the tenant client scopes rules, not versions.
    const withLatest = await tx.taxRule.findUniqueOrThrow({
      where: { id: rule.id },
      include: { versions: { orderBy: { effectiveFrom: 'desc' }, take: 1 } },
    });
    const latest = withLatest.versions[0];
    if (latest && day(latest.effectiveFrom) >= body.effectiveFrom) {
      throw invalid(
        'effectiveFrom',
        `Start after the latest version (from ${day(latest.effectiveFrom)})`,
      );
    }
    await tx.taxRule.update({
      where: { id: rule.id },
      data: {
        versions: {
          // The version in force ends where the new one starts.
          ...(latest && latest.effectiveTo === null
            ? {
                update: {
                  where: { id: latest.id },
                  data: { effectiveTo: dbDate(body.effectiveFrom) },
                },
              }
            : {}),
          create: { ...body, effectiveFrom: dbDate(body.effectiveFrom) },
        },
      },
    });
    await recordAudit(tx, {
      action: 'taxrule.version_added',
      entityType: 'tax_rule',
      entityId: rule.id,
      before: latest
        ? {
            effectiveFrom: day(latest.effectiveFrom),
            rateBps: latest.rateBps,
            basis: latest.basis,
            sequence: latest.sequence,
            inclusive: latest.inclusive,
          }
        : undefined,
      after: auditVersion(body),
    });
    const fresh = await tx.taxRule.findUniqueOrThrow({
      where: { id: rule.id },
      include: { versions: true },
    });
    return ruleItem(fresh, today);
  });
}

/** The owner or finance checked the rates (with their accountant): the checklist step is done. */
export async function confirmTaxes(deps: TaxDeps, tenant: TenantContext) {
  return deps.db.$transaction(async (tx) => {
    const property = await tx.property.findUniqueOrThrow({ where: { id: tenant.propertyId } });
    const settings =
      property.settings &&
      typeof property.settings === 'object' &&
      !Array.isArray(property.settings)
        ? property.settings
        : {};
    const taxes = {
      ...taxSettingsOf(property.settings),
      confirmedAt: iso(deps.clock()),
      confirmedById: tenant.userId,
    };
    const updated = await tx.property.update({
      where: { id: property.id },
      data: { settings: { ...settings, taxes } },
    });
    await recordAudit(tx, {
      action: 'tax.confirmed',
      entityType: 'property',
      entityId: property.id,
      after: { examples: taxes.examples === true },
    });
    return confirmation(deps, updated.settings);
  });
}
