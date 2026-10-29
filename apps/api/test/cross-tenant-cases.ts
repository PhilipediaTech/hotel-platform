import type { OperationId } from '@hotel/shared';
import { expect } from 'vitest';
import type { Db } from '../src/core/db.ts';
import { makeRole, makeRoom, makeRoomType, makeUser } from './factories.ts';
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

async function bFile(db: Db, world: TenantWorld, propertyId: string) {
  const organisationId = orgOf(world, propertyId);
  const id = crypto.randomUUID();
  await db.fileObject.create({
    data: {
      id,
      organisationId,
      propertyId,
      storageKey: `org/${organisationId}/property/${propertyId}/${id}`,
      contentType: 'image/png',
      sizeBytes: 100,
      scan: 'CLEAN',
      entityType: 'RoomType',
      uploadedById: world.bStaff.id,
    },
  });
  return { fileId: id };
}

/** B's own property: the path names it while the header names A's. */
const bProperty = (_db: Db, _world: TenantWorld, propertyId: string) =>
  Promise.resolve({ propertyId });

async function bPropertyUnchanged(db: Db, world: TenantWorld) {
  const b1 = await db.property.findUniqueOrThrow({ where: { id: world.b1.id } });
  expect([b1.name, b1.status]).toEqual([world.b1.name, 'SETUP']);
}

async function bRoomType(db: Db, world: TenantWorld, propertyId: string) {
  const type = await makeRoomType(db, { id: propertyId, organisationId: orgOf(world, propertyId) });
  return { roomTypeId: type.id };
}

async function bRoom(db: Db, world: TenantWorld, propertyId: string) {
  const type = await makeRoomType(db, { id: propertyId, organisationId: orgOf(world, propertyId) });
  const room = await makeRoom(db, type, { number: '101' });
  return { roomId: room.id, roomTypeId: type.id };
}

async function bBlock(db: Db, world: TenantWorld, propertyId: string) {
  const { roomId } = await bRoom(db, world, propertyId);
  const block = await db.roomBlock.create({
    data: {
      propertyId,
      roomId,
      kind: 'OUT_OF_ORDER',
      startDate: new Date('2099-01-01'),
      endDate: new Date('2099-01-05'),
      reason: 'Leak test',
      createdById: world.bStaff.id,
    },
  });
  return { blockId: block.id };
}

async function bRoomUnchanged(db: Db, _world: TenantWorld, theirs: Record<string, string>) {
  const room = await db.room.findUniqueOrThrow({ where: { id: theirs['roomId'] ?? '' } });
  expect([room.floor, room.version, room.hkStatus]).toEqual([null, 0, 'DIRTY']);
}

async function bTaxRule(db: Db, _world: TenantWorld, propertyId: string) {
  const code = await db.revenueCode.create({
    data: { propertyId, code: 'VAT', name: 'VAT', group: 'TAX' },
  });
  const rule = await db.taxRule.create({
    data: {
      propertyId,
      name: 'VAT',
      authority: 'FIRS',
      revenueCodeId: code.id,
      versions: {
        create: { effectiveFrom: new Date('2020-01-01'), rateBps: 750, sequence: 1 },
      },
    },
  });
  return { taxRuleId: rule.id, revenueCodeId: code.id };
}

async function bTaxesUnchanged(db: Db, world: TenantWorld) {
  expect(await db.revenueCode.count({ where: { propertyId: world.b1.id } })).toBe(1);
  expect(await db.taxRule.count({ where: { propertyId: world.b1.id } })).toBe(1);
  expect(await db.taxRuleVersion.count({ where: { taxRule: { propertyId: world.b1.id } } })).toBe(
    1,
  );
  const code = await db.revenueCode.findFirstOrThrow({ where: { propertyId: world.b1.id } });
  expect([code.name, code.taxRuleIds]).toEqual(['VAT', []]);
}

async function bPolicy(db: Db, _world: TenantWorld, propertyId: string) {
  const policy = await db.cancellationPolicy.create({
    data: { propertyId, name: 'Flexible', rules: [], noShowFee: { feeType: 'NIGHTS', value: 1 } },
  });
  return { cancellationPolicyId: policy.id };
}

async function bPlan(
  db: Db,
  world: TenantWorld,
  propertyId: string,
  kind: 'BAR' | 'PACKAGE' = 'BAR',
) {
  const { cancellationPolicyId } = await bPolicy(db, world, propertyId);
  const type = await makeRoomType(db, { id: propertyId, organisationId: orgOf(world, propertyId) });
  const plan = await db.ratePlan.create({
    data: {
      organisationId: orgOf(world, propertyId),
      propertyId,
      code: kind,
      name: 'Best available',
      kind,
      cancellationPolicyId,
      currency: 'NGN',
    },
  });
  return { ratePlanId: plan.id, cancellationPolicyId, roomTypeId: type.id };
}

/** B's day-use plan with a room of its type (T-052). */
async function bDayUsePlan(db: Db, world: TenantWorld, propertyId: string) {
  const { cancellationPolicyId } = await bPolicy(db, world, propertyId);
  const { roomId, roomTypeId } = await bRoom(db, world, propertyId);
  const plan = await db.ratePlan.create({
    data: {
      organisationId: orgOf(world, propertyId),
      propertyId,
      code: 'DAY',
      name: 'Day use',
      kind: 'DAY_USE',
      dayUseMaxMinutes: 360,
      cancellationPolicyId,
      currency: 'NGN',
    },
  });
  return { ratePlanId: plan.id, roomTypeId, roomId };
}

async function bRatesUnchanged(db: Db, world: TenantWorld) {
  expect(await db.ratePlan.count({ where: { propertyId: world.b1.id } })).toBe(1);
  expect(await db.cancellationPolicy.count({ where: { propertyId: world.b1.id } })).toBe(1);
  expect(await db.rateDay.count({ where: { propertyId: world.b1.id } })).toBe(0);
  const plan = await db.ratePlan.findFirstOrThrow({ where: { propertyId: world.b1.id } });
  expect([plan.name, plan.version]).toEqual(['Best available', 0]);
}

/** B's checked import (VALIDATED) of an uploaded file of kind ImportJob. */
async function bImport(db: Db, world: TenantWorld, propertyId: string) {
  const { fileId } = await bFile(db, world, propertyId);
  await db.fileObject.update({ where: { id: fileId }, data: { entityType: 'ImportJob' } });
  const job = await db.importJob.create({
    data: {
      propertyId,
      kind: 'ROOMS',
      fileId,
      status: 'VALIDATED',
      report: {
        total: 0,
        errorCount: 0,
        errors: [],
        summary: {},
        preview: [],
        applied: null,
        data: [],
      },
      createdById: world.bStaff.id,
    },
  });
  return { importId: job.id, fileId };
}

async function bImportUnchanged(db: Db, world: TenantWorld) {
  const jobs = await db.importJob.findMany({ where: { propertyId: world.b1.id } });
  expect(jobs.map((j) => j.status)).toEqual(['VALIDATED']);
}

/** B's room type with an inventory day (2099-01-01). */
async function bInventory(db: Db, world: TenantWorld, propertyId: string) {
  const { roomTypeId } = await bRoomType(db, world, propertyId);
  await db.roomTypeInventory.create({
    data: { propertyId, roomTypeId, date: new Date('2099-01-01'), capacity: 3 },
  });
  return { roomTypeId };
}

async function bGuest(db: Db, world: TenantWorld, propertyId: string) {
  const guest = await db.guest.create({
    data: { organisationId: orgOf(world, propertyId), firstName: 'Bola', lastName: 'Leak' },
  });
  const company = await db.company.create({
    data: { organisationId: orgOf(world, propertyId), kind: 'COMPANY', name: 'Leak Ltd' },
  });
  return { guestId: guest.id, companyId: company.id };
}

async function bGuestUnchanged(db: Db, world: TenantWorld) {
  const guests = await db.guest.findMany({ where: { organisationId: world.orgB.id } });
  expect(guests.map((g) => [g.firstName, g.vip, g.mergedIntoId])).toEqual([['Bola', false, null]]);
  const companies = await db.company.findMany({ where: { organisationId: world.orgB.id } });
  expect(companies.map((c) => [c.name, c.active])).toEqual([['Leak Ltd', true]]);
}

/** B's confirmed reservation with one stay, made from a quote of B's plan. */
async function bReservation(db: Db, world: TenantWorld, propertyId: string) {
  const organisationId = orgOf(world, propertyId);
  const plan = await bPlan(db, world, propertyId);
  const { guestId } = await bGuest(db, world, propertyId);
  const quote = await db.quote.create({
    data: {
      propertyId,
      ratePlanId: plan.ratePlanId,
      roomTypeId: plan.roomTypeId,
      arrival: new Date('2099-01-01'),
      departure: new Date('2099-01-02'),
      nights: [
        {
          date: '2099-01-01',
          amountMinor: '100',
          ruleVersion: 1,
          pricedBy: plan.ratePlanId,
          lines: [],
          guests: 1,
        },
      ],
      taxes: [],
      totalMinor: 100n,
      currency: 'NGN',
      expiresAt: new Date('2099-01-01'),
    },
  });
  const reservation = await db.reservation.create({
    data: {
      organisationId,
      propertyId,
      confirmationNo: 'B-00001',
      bookerGuestId: guestId,
      source: 'PHONE',
      history: { create: { toStatus: 'CONFIRMED' } },
    },
  });
  const stay = await db.stay.create({
    data: {
      propertyId,
      reservationId: reservation.id,
      guestId,
      roomTypeId: plan.roomTypeId,
      ratePlanId: plan.ratePlanId,
      quoteId: quote.id,
      arrival: quote.arrival,
      departure: quote.departure,
      status: 'CONFIRMED',
    },
  });
  return { reservationId: reservation.id, stayId: stay.id, guestId, quoteId: quote.id };
}

async function bReservationUnchanged(db: Db, world: TenantWorld) {
  const rows = await db.reservation.findMany({
    where: { propertyId: world.b1.id },
    include: { stays: true },
  });
  expect(rows.map((r) => [r.status, r.version, r.notes, r.stays.length])).toEqual([
    ['CONFIRMED', 0, null, 1],
  ]);
}

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
  getFileDownloadUrl: { seed: bFile },
  createFileUploadUrl: {
    seed: bFile,
    creates: true,
    body: () => ({ entityType: 'RoomType', contentType: 'image/png', sizeBytes: 100 }),
    untouched: async (db, world) => {
      expect(await db.fileObject.count({ where: { organisationId: world.orgB.id } })).toBe(1);
    },
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
  getOrganisation: {
    seed: (_db, world) => Promise.resolve({ organisationId: world.orgB.id }),
    listIds: (body) => [(body as { id: string }).id],
  },
  updateOrganisation: {
    seed: () => Promise.resolve({}),
    creates: true,
    body: () => ({ name: 'Leak Org' }),
    untouched: async (db, world) => {
      const org = await db.organisation.findUniqueOrThrow({ where: { id: world.orgB.id } });
      expect(org.name).toBe(world.orgB.name);
    },
  },
  listProperties: { seed: bProperty, listIds: ids },
  createProperty: {
    seed: () => Promise.resolve({}),
    creates: true,
    body: () => ({ name: 'Leak Hotel' }),
    untouched: async (db, world) => {
      expect(await db.property.count({ where: { organisationId: world.orgB.id } })).toBe(1);
    },
  },
  getProperty: { seed: bProperty },
  updateProperty: {
    seed: bProperty,
    body: () => ({ name: 'Leak' }),
    untouched: bPropertyUnchanged,
  },
  goLiveProperty: { seed: bProperty, untouched: bPropertyUnchanged },
  listRoomTypes: { seed: bRoomType, listIds: ids },
  createRoomType: {
    seed: bRoomType,
    creates: true,
    body: () => ({ code: 'LEAK', name: 'Leak' }),
    untouched: async (db, world) => {
      expect(await db.roomType.count({ where: { propertyId: world.b1.id } })).toBe(1);
    },
  },
  updateRoomType: {
    seed: bRoomType,
    body: () => ({ name: 'Leak' }),
    untouched: async (db, _w, theirs) => {
      const type = await db.roomType.findUniqueOrThrow({
        where: { id: theirs['roomTypeId'] ?? '' },
      });
      expect(type.name).not.toBe('Leak');
    },
  },
  listRooms: {
    seed: bRoom,
    listIds: (body) =>
      (body as { data: { id: string; roomTypeId: string }[] }).data.flatMap((r) => [
        r.id,
        r.roomTypeId,
      ]),
  },
  createRoom: {
    // B's room type from A1: refused as unknown, and nothing is created in B.
    seed: bRoomType,
    creates: true,
    body: (theirs) => ({ number: '999', roomTypeId: theirs['roomTypeId'] }),
    untouched: async (db, world) => {
      expect(await db.room.count({ where: { propertyId: world.b1.id } })).toBe(0);
    },
  },
  updateRoom: { seed: bRoom, body: () => ({ floor: '9' }), untouched: bRoomUnchanged },
  setHkStatus: {
    seed: bRoom,
    body: () => ({ hkStatus: 'INSPECTED' }),
    untouched: async (db, _w, theirs) => {
      const room = await db.room.findUniqueOrThrow({ where: { id: theirs['roomId'] ?? '' } });
      expect(room.hkStatus).not.toBe('INSPECTED');
    },
  },
  createRoomBlock: {
    seed: bRoom,
    creates: true,
    body: (theirs) => ({
      roomId: theirs['roomId'],
      kind: 'OUT_OF_ORDER',
      startDate: '2099-02-01',
      endDate: '2099-02-03',
      reason: 'Leak',
    }),
    untouched: async (db, world, theirs) => {
      expect(await db.roomBlock.count({ where: { propertyId: world.b1.id } })).toBe(0);
      await bRoomUnchanged(db, world, theirs);
    },
  },
  listRevenueCodes: { seed: bTaxRule, listIds: ids },
  createRevenueCode: {
    // B's tax from A1: refused as unknown, and nothing is created in B.
    seed: bTaxRule,
    creates: true,
    body: (theirs) => ({
      code: 'LEAK',
      name: 'Leak',
      group: 'ROOM',
      taxRuleIds: [theirs['taxRuleId']],
    }),
    untouched: bTaxesUnchanged,
  },
  updateRevenueCode: {
    seed: bTaxRule,
    body: () => ({ name: 'Leak' }),
    untouched: bTaxesUnchanged,
  },
  listTaxRules: {
    seed: bTaxRule,
    listIds: (body) =>
      (body as { data: { id: string; revenueCodeId: string }[] }).data.flatMap((r) => [
        r.id,
        r.revenueCodeId,
      ]),
  },
  createTaxRule: {
    seed: bTaxRule,
    creates: true,
    body: (theirs) => ({
      name: 'Leak',
      authority: 'X',
      revenueCodeId: theirs['revenueCodeId'],
      version: { effectiveFrom: '2099-01-01', rateBps: 100, sequence: 1 },
    }),
    untouched: bTaxesUnchanged,
  },
  addTaxRuleVersion: {
    seed: bTaxRule,
    body: () => ({ effectiveFrom: '2099-01-01', rateBps: 100, sequence: 1 }),
    untouched: bTaxesUnchanged,
  },
  confirmTaxes: {
    seed: bTaxRule,
    creates: true,
    untouched: async (db, world) => {
      const b1 = await db.property.findUniqueOrThrow({ where: { id: world.b1.id } });
      expect(b1.settings).toEqual({});
    },
  },
  listCancellationPolicies: { seed: bPolicy, listIds: ids },
  createCancellationPolicy: {
    seed: bPlan,
    creates: true,
    body: () => ({ name: 'Leak', rules: [], noShowFee: { feeType: 'NIGHTS', value: 1 } }),
    untouched: bRatesUnchanged,
  },
  listRatePlans: {
    seed: bPlan,
    listIds: (body) =>
      (body as { data: { id: string; cancellationPolicyId: string }[] }).data.flatMap((p) => [
        p.id,
        p.cancellationPolicyId,
      ]),
  },
  createRatePlan: {
    // B's parent and policy from A1: refused as unknown, and nothing is created in B.
    seed: bPlan,
    creates: true,
    body: (theirs) => ({
      code: 'LEAK',
      name: 'Leak',
      kind: 'DERIVED',
      parentRatePlanId: theirs['ratePlanId'],
      derivationBps: -1000,
      cancellationPolicyId: theirs['cancellationPolicyId'],
    }),
    untouched: bRatesUnchanged,
  },
  updateRatePlan: { seed: bPlan, body: () => ({ name: 'Leak' }), untouched: bRatesUnchanged },
  getRateCalendar: {
    seed: bPlan,
    query: (theirs) => ({
      ratePlanId: theirs['ratePlanId'] ?? '',
      from: '2099-01-01',
      to: '2099-01-07',
    }),
  },
  updateRateCalendar: {
    seed: bPlan,
    creates: true,
    body: (theirs) => ({
      ratePlanId: theirs['ratePlanId'],
      roomTypeIds: [theirs['roomTypeId']],
      from: '2099-01-01',
      to: '2099-01-02',
      set: { amountMinor: '5000000' },
    }),
    untouched: bRatesUnchanged,
  },
  listPackages: {
    seed: (db, world, propertyId) => bPlan(db, world, propertyId, 'PACKAGE'),
    listIds: ids,
  },
  setPackageComponents: {
    seed: (db, world, propertyId) => bPlan(db, world, propertyId, 'PACKAGE'),
    creates: true,
    body: (theirs) => ({ ratePlanId: theirs['ratePlanId'], components: [] }),
    untouched: bRatesUnchanged,
  },
  validateImport: {
    // B's file from A1: refused as unknown, and no import is created in B.
    seed: bImport,
    creates: true,
    body: (theirs) => ({ kind: 'ROOMS', fileId: theirs['fileId'] }),
    untouched: bImportUnchanged,
  },
  getImport: { seed: bImport },
  applyImport: { seed: bImport, untouched: bImportUnchanged },
  getInventory: {
    seed: bInventory,
    query: () => ({ from: '2099-01-01', to: '2099-01-02' }),
    listIds: (body) => (body as { days: { roomTypeId: string }[] }).days.map((d) => d.roomTypeId),
  },
  setOverbooking: {
    seed: bInventory,
    creates: true,
    body: (theirs) => ({
      roomTypeIds: [theirs['roomTypeId']],
      from: '2099-01-01',
      to: '2099-01-01',
      limit: 2,
    }),
    untouched: async (db, world) => {
      const rows = await db.roomTypeInventory.findMany({ where: { propertyId: world.b1.id } });
      expect(rows.map((r) => r.overbookLimit)).toEqual([0]);
    },
  },
  getAvailability: {
    seed: bPlan,
    query: () => ({ arrival: '2099-01-01', departure: '2099-01-02', adults: '1' }),
    listIds: (body) =>
      (
        body as { roomTypes: { roomTypeId: string; plans: { ratePlanId: string }[] }[] }
      ).roomTypes.flatMap((t) => [t.roomTypeId, ...t.plans.map((p) => p.ratePlanId)]),
  },
  createQuote: {
    // B's room type and plan from A1: refused as unknown, and no quote is stored in B.
    seed: bPlan,
    creates: true,
    body: (theirs) => ({
      roomTypeId: theirs['roomTypeId'],
      ratePlanId: theirs['ratePlanId'],
      arrival: '2099-01-01',
      departure: '2099-01-02',
      adults: 1,
    }),
    untouched: async (db, world) => {
      expect(await db.quote.count({ where: { propertyId: world.b1.id } })).toBe(0);
    },
  },
  listGuests: { seed: bGuest, listIds: ids },
  createGuest: {
    seed: bGuest,
    creates: true,
    body: () => ({ firstName: 'Ada', lastName: 'Obi' }),
    untouched: bGuestUnchanged,
  },
  getGuest: { seed: bGuest },
  updateGuest: { seed: bGuest, body: () => ({ firstName: 'Leak' }), untouched: bGuestUnchanged },
  mergeGuests: {
    seed: bGuest,
    body: (theirs) => ({ otherGuestId: theirs['guestId'] }),
    untouched: bGuestUnchanged,
  },
  flagGuest: {
    seed: bGuest,
    body: () => ({ vip: true, doNotRent: false, reason: 'Leak' }),
    untouched: bGuestUnchanged,
  },
  listCompanies: { seed: bGuest, listIds: ids },
  createCompany: {
    seed: bGuest,
    creates: true,
    body: () => ({ kind: 'COMPANY', name: 'Leak 2' }),
    untouched: bGuestUnchanged,
  },
  getCompany: { seed: bGuest },
  updateCompany: { seed: bGuest, body: () => ({ active: false }), untouched: bGuestUnchanged },
  listReservations: { seed: bReservation, listIds: ids },
  createReservation: {
    // B's quote and guest from A1: refused, and nothing is booked in B.
    seed: bReservation,
    creates: true,
    body: (theirs) => ({
      source: 'PHONE',
      booker: { guestId: theirs['guestId'] },
      stays: [{ quoteId: theirs['quoteId'] }],
    }),
    untouched: bReservationUnchanged,
  },
  getReservation: { seed: bReservation },
  updateReservation: {
    seed: bReservation,
    body: () => ({ notes: 'Leak' }),
    untouched: bReservationUnchanged,
  },
  cancelReservation: {
    seed: bReservation,
    body: () => ({ reason: 'OTHER' }),
    untouched: bReservationUnchanged,
  },
  reinstateReservation: { seed: bReservation, untouched: bReservationUnchanged },
  getReservationHistory: { seed: bReservation },
  listAssignableRooms: { seed: bReservation },
  checkIn: {
    seed: bReservation,
    body: () => ({ registration: {} }),
    untouched: async (db, w) => {
      expect(await db.registrationCard.count()).toBe(0);
      await bReservationUnchanged(db, w);
    },
  },
  getRegistrationCard: { seed: bReservation },
  listKeys: { seed: bReservation },
  issueKeys: {
    seed: bReservation,
    body: () => ({ count: 1 }),
    untouched: async (db) => {
      expect(await db.keyIssue.count()).toBe(0);
    },
  },
  assignRoom: {
    seed: bReservation,
    body: () => ({ roomId: null }),
    untouched: async (db, _w, theirs) => {
      expect(await db.roomAllocation.count({ where: { stayId: theirs['stayId'] ?? '' } })).toBe(0);
      await bReservationUnchanged(db, _w);
    },
  },
  moveStay: {
    seed: bReservation,
    body: (theirs) => ({ roomId: theirs['quoteId'], reason: 'Leak' }),
    untouched: async (db, _w, theirs) => {
      expect(await db.roomAllocation.count({ where: { stayId: theirs['stayId'] ?? '' } })).toBe(0);
      await bReservationUnchanged(db, _w);
    },
  },
  getCalendar: {
    seed: bReservation,
    query: () => ({ from: '2099-01-01', to: '2099-01-03' }),
    listIds: (body) =>
      (body as { data: { id: string; reservationId: string }[] }).data.flatMap((s) => [
        s.id,
        s.reservationId,
      ]),
  },
  getDayUseAvailability: {
    seed: bDayUsePlan,
    query: () => ({ date: '2099-01-01', start: '10:00', minutes: '60', adults: '1' }),
    listIds: (body) =>
      (
        body as {
          roomTypes: {
            roomTypeId: string;
            plans: { ratePlanId: string }[];
            rooms: { id: string }[];
          }[];
        }
      ).roomTypes.flatMap((t) => [
        t.roomTypeId,
        ...t.plans.map((p) => p.ratePlanId),
        ...t.rooms.map((r) => r.id),
      ]),
  },
  createDayUse: {
    // B's room type, plan and room from A1: refused, and nothing is sold in B.
    seed: bDayUsePlan,
    creates: true,
    body: (theirs) => ({
      date: '2099-01-01',
      start: '10:00',
      minutes: 60,
      roomTypeId: theirs['roomTypeId'],
      ratePlanId: theirs['ratePlanId'],
      roomId: theirs['roomId'],
      adults: 1,
      booker: { firstName: 'Leak', lastName: 'Test' },
    }),
    untouched: async (db, world) => {
      expect(await db.stay.count({ where: { propertyId: world.b1.id } })).toBe(0);
      expect(await db.roomAllocation.count()).toBe(0);
    },
  },
  checkOut: {
    seed: bReservation,
    body: () => ({}),
    untouched: bReservationUnchanged,
  },
  releaseRoomBlock: {
    seed: bBlock,
    untouched: async (db, _w, theirs) => {
      const block = await db.roomBlock.findUniqueOrThrow({
        where: { id: theirs['blockId'] ?? '' },
      });
      expect(block.releasedAt).toBeNull();
    },
  },
};
