import type { OperationId } from '@hotel/shared';
import { expect } from 'vitest';
import type { Db } from '../src/core/db.ts';
import { makeRole, makeUser } from './factories.ts';
import type { CrossTenantCase, TenantWorld } from './tenancy.ts';

/**
 * One entry per property-scoped route in API_ROUTES. The tenancy suite fails when a
 * property-scoped route has no case here, so every new module route is checked for
 * cross-tenant leaks (test plan, suite 1). Modules add their cases as they are built.
 */

const orgOf = (world: TenantWorld, propertyId: string) =>
  propertyId === world.b1.id ? world.orgB.id : world.orgA.id;

async function bRole(db: Db, world: TenantWorld, propertyId: string) {
  const role = await makeRole(db, orgOf(world, propertyId));
  return { roleId: role.id };
}

async function bUser(db: Db, world: TenantWorld, propertyId: string) {
  const user = await makeUser(db);
  const role = await makeRole(db, orgOf(world, propertyId));
  await db.membership.create({
    data: {
      userId: user.id,
      organisationId: orgOf(world, propertyId),
      propertyId,
      roleId: role.id,
    },
  });
  await db.user.update({ where: { id: user.id }, data: { status: 'ACTIVE' } });
  return { userId: user.id };
}

async function bInvitation(db: Db, world: TenantWorld, propertyId: string) {
  const role = await makeRole(db, orgOf(world, propertyId));
  const invitation = await db.invitation.create({
    data: {
      organisationId: orgOf(world, propertyId),
      propertyId,
      roleId: role.id,
      email: `invitee-${crypto.randomUUID().slice(0, 8)}@example.test`,
      tokenHash: crypto.randomUUID(),
      invitedById: world.bStaff.id,
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  });
  return { invitationId: invitation.id, roleId: role.id };
}

async function bAuditEvents(db: Db, world: TenantWorld, propertyId: string) {
  const organisationId = orgOf(world, propertyId);
  const event = (propertyIdOrNull: string | null) =>
    db.auditEvent.create({
      data: {
        organisationId,
        propertyId: propertyIdOrNull,
        actorType: 'SYSTEM',
        action: 'leak.test',
        entityType: 'leak',
        entityId: crypto.randomUUID(),
      },
    });
  const own = await event(propertyId);
  // Organisation-level events are shared by the organisation's properties, so only
  // another organisation's count as a leak.
  const orgLevel = organisationId === world.orgB.id ? await event(null) : null;
  return {
    eventId: own.id.toString(),
    ...(orgLevel ? { orgEventId: orgLevel.id.toString() } : {}),
  };
}

/** A pending refund request in B, with B's policy (approver: a B role). */
async function bApproval(db: Db, world: TenantWorld, propertyId: string) {
  const organisationId = orgOf(world, propertyId);
  const role = await makeRole(db, organisationId);
  await db.approvalPolicy.upsert({
    where: { propertyId_action: { propertyId, action: 'payment.refund' } },
    update: {},
    create: {
      organisationId,
      propertyId,
      action: 'payment.refund',
      approverRoleIds: [role.id],
      expiryMinutes: 2880,
    },
  });
  const requester = organisationId === world.orgB.id ? world.bStaff : world.aStaff;
  const request = await db.approvalRequest.create({
    data: {
      organisationId,
      propertyId,
      action: 'payment.refund',
      payload: { amountMinor: '5000' },
      payloadHash: 'h',
      reason: 'Leak test',
      requestedById: requester.id,
      expiresAt: new Date(Date.now() + 3_600_000),
    },
  });
  return { approvalId: request.id, roleId: role.id };
}

const bApprovalPending = async (db: Db, _w: TenantWorld, theirs: Record<string, string>) => {
  const request = await db.approvalRequest.findUniqueOrThrow({
    where: { id: theirs['approvalId'] ?? '' },
  });
  expect(request.status).toBe('PENDING');
};

const ids = (body: unknown) => (body as { data: { id: string }[] }).data.map((row) => row.id);

/** B's organisation has exactly the roles it started with plus the seeded ones. */
const bRolesUnchanged = async (db: Db, world: TenantWorld) => {
  const names = (await db.role.findMany({ where: { organisationId: world.orgB.id } })).map(
    (r) => r.name,
  );
  expect(names.some((n) => n.startsWith('Leak '))).toBe(false);
};

export const CROSS_TENANT_CASES: Partial<Record<OperationId, CrossTenantCase>> = {
  listRoles: { seed: bRole, listIds: ids },
  createRole: {
    seed: () => Promise.resolve({}),
    creates: true,
    body: () => ({ name: `Leak ${crypto.randomUUID().slice(0, 6)}`, permissions: [] }),
    untouched: bRolesUnchanged,
  },
  updateRole: {
    seed: bRole,
    body: () => ({ permissions: ['hk.read'] }),
    untouched: async (db, _w, theirs) => {
      const role = await db.role.findUniqueOrThrow({ where: { id: theirs['roleId'] ?? '' } });
      expect(role.permissions).toEqual([]);
    },
  },
  listUsers: { seed: bUser, listIds: ids },
  listAuditEvents: { seed: bAuditEvents, listIds: ids },
  updateUser: {
    seed: bUser,
    body: () => ({ status: 'DISABLED' }),
    untouched: async (db, _w, theirs) => {
      const user = await db.user.findUniqueOrThrow({ where: { id: theirs['userId'] ?? '' } });
      expect(user.status).toBe('ACTIVE');
    },
  },
  createPasswordResetLink: {
    seed: bUser,
    untouched: async (db, _w, theirs) => {
      expect(await db.authToken.count({ where: { userId: theirs['userId'] ?? '' } })).toBe(0);
    },
  },
  listInvitations: { seed: bInvitation, listIds: ids },
  createInvitation: {
    // B's role ID from A1: refused as an unknown role, and nothing is created in B.
    seed: bInvitation,
    creates: true,
    body: (theirs) => ({ email: 'leak@example.test', roleId: theirs['roleId'] }),
    untouched: async (db, world) => {
      expect(
        await db.invitation.count({
          where: { organisationId: world.orgB.id, email: 'leak@example.test' },
        }),
      ).toBe(0);
    },
  },
  revokeInvitation: {
    seed: bInvitation,
    untouched: async (db, _w, theirs) => {
      const inv = await db.invitation.findUniqueOrThrow({
        where: { id: theirs['invitationId'] ?? '' },
      });
      expect(inv.revokedAt).toBeNull();
    },
  },
  listApprovals: { seed: bApproval, listIds: ids },
  getApproval: { seed: bApproval },
  approveApproval: { seed: bApproval, body: () => ({}), untouched: bApprovalPending },
  rejectApproval: { seed: bApproval, body: () => ({ note: 'No' }), untouched: bApprovalPending },
  listApprovalPolicies: {
    seed: bApproval,
    // Policies have no ID of their own; B's approver role must not show up.
    listIds: (body) =>
      (body as { data: { approverRoleIds: string[] }[] }).data.flatMap((p) => p.approverRoleIds),
  },
  updateApprovalPolicies: {
    seed: bApproval,
    creates: true,
    body: (theirs) => ({
      policies: [
        {
          action: 'payment.refund',
          active: true,
          thresholdMinor: null,
          thresholdBps: null,
          approverRoleIds: [theirs['roleId']],
          expiryMinutes: 30,
        },
      ],
    }),
    untouched: async (db, world) => {
      const policies = await db.approvalPolicy.findMany({
        where: { organisationId: world.orgB.id },
      });
      expect(policies.map((p) => [p.action, p.active, p.expiryMinutes])).toEqual([
        ['payment.refund', true, 2880],
      ]);
    },
  },
};
