import { HOTEL_PERMISSION_CODES, permissionDef, type RoleLimitsValue } from '@hotel/shared';
import type { Logger } from 'pino';
import type { Invitation, Membership, Role, User } from '../../generated/prisma/client.ts';
import type { AuthContext } from '../../core/auth.ts';
import type { Clock } from '../../core/clock.ts';
import type { Config } from '../../core/config.ts';
import { pgErrorInfo, type Db } from '../../core/db.ts';
import type { EmailProvider } from '../../core/email.ts';
import { AppError } from '../../core/errors.ts';
import { hashPassword } from '../../core/passwords.ts';
import type { TenantDb } from '../../core/tenant-db.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import { hashToken, newToken } from '../../core/tokens.ts';
import { OWNER_LOCKED_PERMISSIONS, OWNER_ROLE_NAME } from '../identity/role-templates.ts';
import { appLink, issueLinkToken } from '../identity/service.ts';
import { invitationMessage } from './emails.ts';

// Users and roles (PRD M1-04, M1-05; T-013). Rules:
// - no escalation: you give, take or edit only roles whose permissions you hold, and only
//   users who hold no permission you lack; never yourself (approved 2026-10-26)
// - the organisation always keeps an active owner, and the Owner role keeps its admin codes
// - removing a role ends access through it on the next request (tenancy is re-checked on
//   every request), so no session revocation is needed for it (spec issue 35)

export interface AccessDeps {
  db: Db;
  tenantDb: TenantDb;
  config: Config;
  clock: Clock;
  email: EmailProvider;
  logger: Logger;
}

const DAY = 24 * 60 * 60_000;
export const INVITATION_TTL_MS = 7 * DAY;
export const MANAGER_RESET_TTL_MS = DAY;

type Scope = 'PROPERTY' | 'ORGANISATION';

const scopeOf = (propertyId: string | null): Scope => (propertyId ? 'PROPERTY' : 'ORGANISATION');

function validation(path: string, message: string): AppError {
  return new AppError('VALIDATION_ERROR', message, {
    issues: [{ path, code: 'custom', message }],
  });
}

function isOwnerRole(role: Pick<Role, 'isSystem' | 'name'>): boolean {
  return role.isSystem && role.name === OWNER_ROLE_NAME;
}

const missing = (codes: Iterable<string>, held: ReadonlySet<string>) =>
  [...codes].filter((code) => !held.has(code));

// ---------------------------------------------------------------------------------------
// Permissions and roles (M1-05)

export function listPermissions() {
  return HOTEL_PERMISSION_CODES.map((code) => {
    const def = permissionDef(code);
    return {
      code,
      group: def?.group ?? 'access',
      label: def?.label ?? code,
      limits: [...(def?.limits ?? [])],
    };
  });
}

function toRole(role: Role, memberCount: number) {
  return {
    id: role.id,
    name: role.name,
    isSystem: role.isSystem,
    requiresMfa: role.requiresMfa,
    permissions: role.permissions,
    limits: role.limits as RoleLimitsValue,
    memberCount,
  };
}

async function memberCounts(deps: AccessDeps): Promise<Map<string, number>> {
  const rows = await deps.tenantDb.membership.groupBy({
    by: ['roleId'],
    where: { active: true },
    _count: { _all: true },
  });
  return new Map(rows.map((r) => [r.roleId, r._count._all]));
}

export async function listRoles(deps: AccessDeps) {
  const [roles, counts] = await Promise.all([
    deps.tenantDb.role.findMany({ orderBy: [{ isSystem: 'desc' }, { name: 'asc' }] }),
    memberCounts(deps),
  ]);
  return roles.map((r) => toRole(r, counts.get(r.id) ?? 0));
}

function checkLimits(limits: RoleLimitsValue, permissions: readonly string[]): void {
  const extra = Object.keys(limits).filter((code) => !permissions.includes(code));
  if (extra.length > 0) {
    throw validation(
      'body.limits',
      `Limits are only for permissions the role has: ${extra.join(', ')}`,
    );
  }
}

function nameTaken(err: unknown): boolean {
  return pgErrorInfo(err)?.sqlState === '23505';
}

export async function createRole(
  deps: AccessDeps,
  body: { name: string; permissions: string[]; limits: RoleLimitsValue; requiresMfa: boolean },
) {
  checkLimits(body.limits, body.permissions);
  try {
    const role = await deps.tenantDb.role.create({
      data: {
        name: body.name,
        permissions: body.permissions,
        limits: body.limits,
        requiresMfa: body.requiresMfa,
        isSystem: false,
      } as never, // organisationId is stamped by the tenant client
    });
    return toRole(role, 0);
  } catch (err) {
    if (nameTaken(err)) throw validation('body.name', 'A role with this name already exists.');
    throw err;
  }
}

export async function updateRole(
  deps: AccessDeps,
  roleId: string,
  body: Partial<{
    name: string;
    permissions: string[];
    limits: RoleLimitsValue;
    requiresMfa: boolean;
  }>,
) {
  const role = await deps.tenantDb.role.findUnique({ where: { id: roleId } });
  if (!role) throw new AppError('NOT_FOUND', 'Role not found.');
  if (role.isSystem && body.name !== undefined && body.name !== role.name) {
    throw new AppError(
      'STATE_TRANSITION_INVALID',
      'Built-in role names can’t change; create a new role instead.',
    );
  }
  const permissions = body.permissions ?? role.permissions;
  const limits = body.limits ?? (role.limits as RoleLimitsValue);
  if (isOwnerRole(role)) {
    const lost = missing(OWNER_LOCKED_PERMISSIONS, new Set(permissions));
    if (lost.length > 0) {
      throw new AppError(
        'STATE_TRANSITION_INVALID',
        `The Owner role must keep ${lost.join(', ')}.`,
      );
    }
    if (body.requiresMfa === false) {
      throw new AppError(
        'STATE_TRANSITION_INVALID',
        'The Owner role always requires two-step sign-in.',
      );
    }
  }
  checkLimits(limits, permissions);
  try {
    const updated = await deps.tenantDb.role.update({
      where: { id: role.id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        permissions,
        limits,
        ...(body.requiresMfa !== undefined ? { requiresMfa: body.requiresMfa } : {}),
      },
    });
    return toRole(updated, (await memberCounts(deps)).get(role.id) ?? 0);
  } catch (err) {
    if (nameTaken(err)) throw validation('body.name', 'A role with this name already exists.');
    throw err;
  }
}

// ---------------------------------------------------------------------------------------
// Users (M1-04)

type MembershipWithRole = Membership & { role: Role };

/** Memberships that apply in the tenant's property: this property's and org-wide ones. */
function applicable(deps: AccessDeps, tenant: TenantContext, userId?: string) {
  return deps.tenantDb.membership.findMany({
    where: {
      active: true,
      ...(userId ? { userId } : {}),
      OR: [{ propertyId: tenant.propertyId }, { propertyId: null }],
    },
    include: { role: true, user: true },
    orderBy: { createdAt: 'asc' },
  });
}

const permissionsOf = (memberships: readonly MembershipWithRole[]) =>
  new Set(memberships.flatMap((m) => m.role.permissions));

function canManage(
  tenant: TenantContext,
  userId: string,
  memberships: readonly MembershipWithRole[],
): boolean {
  return (
    userId !== tenant.userId && missing(permissionsOf(memberships), tenant.permissions).length === 0
  );
}

function toStaffUser(
  tenant: TenantContext,
  user: User,
  memberships: readonly MembershipWithRole[],
) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    status: user.status,
    mfaEnabled: user.mfaEnabled,
    lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
    roles: memberships.map((m) => ({
      membershipId: m.id,
      roleId: m.roleId,
      roleName: m.role.name,
      scope: scopeOf(m.propertyId),
    })),
    canManage: canManage(tenant, user.id, memberships),
  };
}

/** Offset cursor: a small admin list, ordered by name. */
const encodeCursor = (offset: number) => Buffer.from(String(offset)).toString('base64url');
function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const n = Number(Buffer.from(cursor, 'base64url').toString());
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

export async function listUsers(
  deps: AccessDeps,
  tenant: TenantContext,
  query: { limit: number; cursor?: string | undefined },
) {
  const rows = await applicable(deps, tenant);
  const byUser = new Map<string, { user: User; memberships: MembershipWithRole[] }>();
  for (const m of rows) {
    const entry = byUser.get(m.userId) ?? { user: m.user, memberships: [] };
    entry.memberships.push(m);
    byUser.set(m.userId, entry);
  }
  const all = [...byUser.values()].sort(
    (a, b) => a.user.name.localeCompare(b.user.name) || a.user.id.localeCompare(b.user.id),
  );
  const offset = decodeCursor(query.cursor);
  const slice = all.slice(offset, offset + query.limit);
  return {
    data: slice.map(({ user, memberships }) => toStaffUser(tenant, user, memberships)),
    nextCursor: offset + query.limit < all.length ? encodeCursor(offset + query.limit) : null,
  };
}

/** Loads a user the caller may change, or throws (404 / self / escalation). */
async function manageable(deps: AccessDeps, tenant: TenantContext, userId: string) {
  const memberships = await applicable(deps, tenant, userId);
  const user = memberships[0]?.user;
  if (!user) throw new AppError('NOT_FOUND', 'User not found.');
  if (userId === tenant.userId) {
    throw new AppError(
      'STATE_TRANSITION_INVALID',
      'You can’t change your own access. Ask another manager.',
    );
  }
  const lacking = missing(permissionsOf(memberships), tenant.permissions);
  if (lacking.length > 0) {
    throw new AppError('FORBIDDEN', 'This person has permissions you don’t have.', {
      permissions: lacking,
    });
  }
  return { user, memberships };
}

async function revokeAllSessions(db: Db, userId: string, now: Date): Promise<void> {
  await db.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now } });
}

/** Active users holding the Owner role organisation-wide, other than `exceptUserId`. */
async function otherActiveOwners(deps: AccessDeps, exceptUserId: string): Promise<number> {
  return deps.tenantDb.membership.count({
    where: {
      active: true,
      propertyId: null,
      userId: { not: exceptUserId },
      role: { isSystem: true, name: OWNER_ROLE_NAME },
      user: { status: 'ACTIVE' },
    },
  });
}

export async function updateUser(
  deps: AccessDeps,
  tenant: TenantContext,
  userId: string,
  body: {
    roleIds?: string[] | undefined;
    orgRoleIds?: string[] | undefined;
    status?: 'ACTIVE' | 'DISABLED' | undefined;
    resetMfa?: true | undefined;
  },
) {
  const { user, memberships } = await manageable(deps, tenant, userId);
  if (body.orgRoleIds !== undefined && !tenant.permissions.has('role.manage')) {
    throw new AppError('FORBIDDEN', 'Only owners change organisation-wide roles.', {
      permission: 'role.manage',
    });
  }

  const requested = [...(body.roleIds ?? []), ...(body.orgRoleIds ?? [])];
  const roles = await deps.tenantDb.role.findMany({ where: { id: { in: requested } } });
  const roleById = new Map(roles.map((r) => [r.id, r]));
  for (const [field, ids] of [
    ['roleIds', body.roleIds],
    ['orgRoleIds', body.orgRoleIds],
  ] as const) {
    if (ids?.some((id) => !roleById.has(id))) throw validation(`body.${field}`, 'Unknown role.');
  }

  // Every role given or taken must be within the caller's own permissions.
  const current = (propertyId: string | null) =>
    memberships.filter((m) => m.propertyId === propertyId);
  const changes: {
    add: { roleId: string; propertyId: string | null }[];
    remove: MembershipWithRole[];
  } = { add: [], remove: [] };
  for (const [ids, propertyId] of [
    [body.roleIds, tenant.propertyId],
    [body.orgRoleIds, null],
  ] as const) {
    if (ids === undefined) continue;
    const existing = current(propertyId);
    changes.remove.push(...existing.filter((m) => !ids.includes(m.roleId)));
    for (const id of new Set(ids)) {
      if (!existing.some((m) => m.roleId === id)) changes.add.push({ roleId: id, propertyId });
    }
  }
  for (const role of [
    ...changes.add.map((a) => roleById.get(a.roleId)),
    ...changes.remove.map((m) => m.role),
  ]) {
    if (!role) continue;
    const lacking = missing(role.permissions, tenant.permissions);
    if (lacking.length > 0) {
      throw new AppError('FORBIDDEN', `You can’t give or take the ${role.name} role.`, {
        roleId: role.id,
        permissions: lacking,
      });
    }
  }

  // The organisation always keeps an active owner.
  const isOwner = memberships.some((m) => m.propertyId === null && isOwnerRole(m.role));
  const losesOwner =
    changes.remove.some((m) => m.propertyId === null && isOwnerRole(m.role)) ||
    (isOwner && body.status === 'DISABLED');
  if (losesOwner && (await otherActiveOwners(deps, user.id)) === 0) {
    throw new AppError(
      'STATE_TRANSITION_INVALID',
      'The organisation needs at least one active owner.',
    );
  }

  const now = deps.clock();
  await deps.tenantDb.$transaction(async (tx) => {
    if (changes.remove.length > 0) {
      await tx.membership.deleteMany({ where: { id: { in: changes.remove.map((m) => m.id) } } });
    }
    for (const add of changes.add) {
      await tx.membership.create({
        data: { userId: user.id, roleId: add.roleId, propertyId: add.propertyId } as never,
      });
    }
  });
  if (body.status) {
    await deps.db.user.update({ where: { id: user.id }, data: { status: body.status } });
    if (body.status === 'DISABLED') await revokeAllSessions(deps.db, user.id, now);
  }
  if (body.resetMfa) {
    await deps.db.$transaction([
      deps.db.user.update({
        where: { id: user.id },
        data: { mfaEnabled: false, mfaSecretEnc: null, mfaLastUsedStep: null },
      }),
      deps.db.mfaRecoveryCode.deleteMany({ where: { userId: user.id } }),
    ]);
    await revokeAllSessions(deps.db, user.id, now);
  }

  const after = await applicable(deps, tenant, user.id);
  const fresh = await deps.db.user.findUniqueOrThrow({ where: { id: user.id } });
  return toStaffUser(tenant, fresh, after);
}

/** Issue 34: a one-time reset link a manager hands to (e.g.) phone-only staff. */
export async function createPasswordResetLink(
  deps: AccessDeps,
  tenant: TenantContext,
  userId: string,
) {
  const { user } = await manageable(deps, tenant, userId);
  if (user.status !== 'ACTIVE') {
    throw new AppError(
      'STATE_TRANSITION_INVALID',
      'Only active accounts can reset their password.',
    );
  }
  const token = await issueLinkToken(
    deps.db,
    deps,
    user.id,
    'PASSWORD_RESET',
    MANAGER_RESET_TTL_MS,
  );
  return {
    link: appLink(deps, '/reset-password', token),
    expiresAt: new Date(deps.clock().getTime() + MANAGER_RESET_TTL_MS).toISOString(),
  };
}

// ---------------------------------------------------------------------------------------
// Invitations (M1-04)

type InvitationRow = Invitation & { role: Role; invitedBy: User };

function toInvitation(inv: InvitationRow) {
  return {
    id: inv.id,
    email: inv.email,
    phone: inv.phone,
    roleId: inv.roleId,
    roleName: inv.role.name,
    scope: scopeOf(inv.propertyId),
    invitedBy: { id: inv.invitedBy.id, name: inv.invitedBy.name },
    createdAt: inv.createdAt.toISOString(),
    expiresAt: inv.expiresAt.toISOString(),
  };
}

const pending = (now: Date) => ({ acceptedAt: null, revokedAt: null, expiresAt: { gt: now } });

export async function listInvitations(deps: AccessDeps, tenant: TenantContext) {
  const rows = await deps.tenantDb.invitation.findMany({
    where: {
      ...pending(deps.clock()),
      OR: [{ propertyId: tenant.propertyId }, { propertyId: null }],
    },
    include: { role: true, invitedBy: true },
    orderBy: { createdAt: 'desc' },
  });
  return rows.map(toInvitation);
}

export async function createInvitation(
  deps: AccessDeps,
  tenant: TenantContext,
  body: { email?: string | undefined; phone?: string | undefined; roleId: string; scope: Scope },
) {
  const role = await deps.tenantDb.role.findUnique({ where: { id: body.roleId } });
  if (!role) throw validation('body.roleId', 'Unknown role.');
  const lacking = missing(role.permissions, tenant.permissions);
  if (lacking.length > 0) {
    throw new AppError('FORBIDDEN', `You can’t invite people as ${role.name}.`, {
      permissions: lacking,
    });
  }
  if (body.scope === 'ORGANISATION' && !tenant.permissions.has('role.manage')) {
    throw new AppError('FORBIDDEN', 'Only owners invite people for every property.', {
      permission: 'role.manage',
    });
  }
  const propertyId = body.scope === 'PROPERTY' ? tenant.propertyId : null;
  const contact = body.email ? { email: body.email } : { phone: body.phone ?? '' };

  const existing = await deps.db.user.findUnique({ where: contact as { email: string } });
  if (existing) {
    const has = await deps.tenantDb.membership.count({
      where: { userId: existing.id, roleId: role.id, propertyId, active: true },
    });
    if (has > 0)
      throw new AppError('STATE_TRANSITION_INVALID', 'This person already has that role here.');
  }

  const now = deps.clock();
  const token = newToken();
  const invitation = await deps.tenantDb.$transaction(async (tx) => {
    // Inviting the same person to the same place again replaces the earlier invitation.
    await tx.invitation.updateMany({
      where: { ...contact, propertyId, ...pending(now) },
      data: { revokedAt: now },
    });
    return tx.invitation.create({
      data: {
        ...contact,
        propertyId,
        roleId: role.id,
        invitedById: tenant.userId,
        tokenHash: hashToken(deps.config.sessionSecret, token),
        expiresAt: new Date(now.getTime() + INVITATION_TTL_MS),
      } as never,
      include: { role: true, invitedBy: true, organisation: true, property: true },
    });
  });

  const link = appLink(deps, '/accept-invitation', token);
  if (body.email) {
    await deps.email.send(
      invitationMessage(body.email, {
        inviterName: invitation.invitedBy.name,
        organisationName: invitation.organisation.name,
        propertyName: invitation.property?.name ?? null,
        roleName: role.name,
        link,
      }),
    );
  }
  // Phone: no WhatsApp/SMS until T-024, so the inviter shares the link (approved fallback).
  return { invitation: toInvitation(invitation), link: body.phone ? link : null };
}

export async function revokeInvitation(deps: AccessDeps, invitationId: string) {
  const result = await deps.tenantDb.invitation.updateMany({
    where: { id: invitationId, ...pending(deps.clock()) },
    data: { revokedAt: deps.clock() },
  });
  if (result.count === 0) throw new AppError('NOT_FOUND', 'Invitation not found.');
}

// Public: preview and accept, by token (no tenant context; the plain client) --------------

function tokenInvalid(): AppError {
  return new AppError(
    'VALIDATION_ERROR',
    'This invitation is invalid, used or expired. Ask for a new one.',
    {
      reason: 'TOKEN_INVALID',
    },
  );
}

async function findPending(deps: AccessDeps, token: string) {
  const invitation = await deps.db.invitation.findUnique({
    where: { tokenHash: hashToken(deps.config.sessionSecret, token) },
    include: { role: true, organisation: true, property: true },
  });
  const now = deps.clock();
  if (!invitation || invitation.acceptedAt || invitation.revokedAt || invitation.expiresAt <= now) {
    throw tokenInvalid();
  }
  return invitation;
}

function contactOf(inv: Pick<Invitation, 'email' | 'phone'>) {
  return inv.email ? { email: inv.email } : { phone: inv.phone ?? '' };
}

export async function previewInvitation(deps: AccessDeps, token: string) {
  const inv = await findPending(deps, token);
  const account = await deps.db.user.findUnique({ where: contactOf(inv) as { email: string } });
  return {
    organisationName: inv.organisation.name,
    propertyName: inv.property?.name ?? null,
    roleName: inv.role.name,
    email: inv.email,
    phone: inv.phone,
    accountExists: account !== null,
  };
}

export async function acceptInvitation(
  deps: AccessDeps,
  auth: AuthContext | null,
  body: { token: string; name?: string | undefined; password?: string | undefined },
): Promise<void> {
  const inv = await findPending(deps, body.token);
  const contact = contactOf(inv);
  const now = deps.clock();
  let user = await deps.db.user.findUnique({ where: contact as { email: string } });

  if (user) {
    // An existing account accepts while signed in to it.
    if (!auth?.session.mfaPassed) {
      throw new AppError('UNAUTHENTICATED', 'Sign in to your account to accept this invitation.');
    }
    if (auth.user.id !== user.id) {
      throw new AppError('FORBIDDEN', 'This invitation is for another account.', {
        reason: 'OTHER_ACCOUNT',
      });
    }
    if (user.status === 'DISABLED') {
      throw new AppError('FORBIDDEN', 'This account is disabled.', { reason: 'ACCOUNT_DISABLED' });
    }
  } else {
    const issues = [
      ...(body.name ? [] : [{ path: 'body.name', code: 'custom', message: 'Enter your name' }]),
      ...(body.password
        ? []
        : [{ path: 'body.password', code: 'custom', message: 'Choose a password' }]),
    ];
    if (issues.length > 0)
      throw new AppError('VALIDATION_ERROR', 'Request validation failed.', { issues });
  }

  const passwordHash = user ? null : await hashPassword(body.password ?? '');
  await deps.db.$transaction(async (tx) => {
    // Single use, even when two tabs accept at once.
    const claimed = await tx.invitation.updateMany({
      where: { id: inv.id, acceptedAt: null, revokedAt: null, expiresAt: { gt: now } },
      data: { acceptedAt: now },
    });
    if (claimed.count !== 1) throw tokenInvalid();
    user ??= await tx.user.create({
      data: {
        ...contact,
        name: body.name ?? '',
        passwordHash,
        status: 'ACTIVE',
        // The link went to this address: it is proven.
        ...(inv.email ? { emailVerifiedAt: now } : {}),
      },
    });
    await tx.invitation.update({ where: { id: inv.id }, data: { acceptedById: user.id } });
    const has = await tx.membership.findFirst({
      where: {
        userId: user.id,
        organisationId: inv.organisationId,
        propertyId: inv.propertyId,
        roleId: inv.roleId,
      },
    });
    if (has && !has.active)
      await tx.membership.update({ where: { id: has.id }, data: { active: true } });
    if (!has) {
      await tx.membership.create({
        data: {
          userId: user.id,
          organisationId: inv.organisationId,
          propertyId: inv.propertyId,
          roleId: inv.roleId,
        },
      });
    }
  });
}
