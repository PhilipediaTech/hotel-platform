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

/** A visitor signed in to B's checked-in stay (T-057). */
async function bVisitor(db: Db, world: TenantWorld, propertyId: string) {
  const theirs = await bInHouse(db, world, propertyId);
  const user = await makeUser(db);
  const visitor = await db.visitor.create({
    data: { propertyId, stayId: theirs.stayId, name: 'Bola B', signedInById: user.id },
  });
  return { ...theirs, visitorId: visitor.id };
}

/** B's booking page and a promo code (T-112). */
async function bBookingPage(db: Db, world: TenantWorld, propertyId: string) {
  const organisationId = orgOf(world, propertyId);
  await db.bookingEngineSettings.create({
    data: { propertyId, organisationId, slug: 'theirs-page', enabled: true },
  });
  const promo = await db.promoCode.create({
    data: { propertyId, organisationId, code: 'THEIRS', discountBps: 1000 },
  });
  return { promoId: promo.id, slug: 'theirs-page' };
}

async function bBookingPageUnchanged(db: Db) {
  expect((await db.bookingEngineSettings.findMany()).map((s) => s.slug)).toEqual(['theirs-page']);
  expect((await db.promoCode.findMany()).map((p) => [p.code, p.active])).toEqual([
    ['THEIRS', true],
  ]);
}

/** A person added to B's checked-in stay (T-056). */
async function bOccupant(db: Db, world: TenantWorld, propertyId: string) {
  const theirs = await bInHouse(db, world, propertyId);
  const user = await makeUser(db);
  const occupant = await db.stayOccupant.create({
    data: {
      propertyId,
      stayId: theirs.stayId,
      firstName: 'Bola',
      lastName: 'B',
      kind: 'ADULT',
      nightlyChargeMinor: 500000n,
      addedById: user.id,
    },
  });
  return { ...theirs, occupantId: occupant.id };
}

async function bOccupantUnchanged(db: Db) {
  const rows = await db.stayOccupant.findMany();
  expect(rows.map((o) => [o.nightlyChargeMinor, o.removedAt, o.version])).toEqual([
    [500000n, null, 0],
  ]);
}

/** B's guest checked in to a room of their type (T-053). */
async function bInHouse(db: Db, world: TenantWorld, propertyId: string) {
  const theirs = await bReservation(db, world, propertyId);
  const stay = await db.stay.findUniqueOrThrow({
    where: { id: theirs.stayId },
    include: { roomType: true },
  });
  const room = await makeRoom(db, stay.roomType, { number: '901' });
  await db.stay.update({
    where: { id: stay.id },
    data: { status: 'CHECKED_IN', checkedInAt: new Date('2099-01-01'), roomId: room.id },
  });
  return theirs;
}

/** B's in-house guest with a folio holding one charge (T-060). */
async function bFolio(db: Db, world: TenantWorld, propertyId: string) {
  const theirs = await bInHouse(db, world, propertyId);
  const folio = await db.folio.create({
    data: {
      organisationId: orgOf(world, propertyId),
      propertyId,
      number: 'F00001',
      reservationId: theirs.reservationId,
      name: 'B Guest',
      currency: 'NGN',
      windows: { create: { number: 1, payerType: 'GUEST' } },
    },
    include: { windows: true },
  });
  await db.stay.update({ where: { id: theirs.stayId }, data: { folioId: folio.id } });
  const code = await db.revenueCode.create({
    data: { propertyId, code: 'MISC', name: 'Other', group: 'OTHER' },
  });
  const line = await db.folioLine.create({
    data: {
      propertyId,
      folioId: folio.id,
      windowId: folio.windows[0]?.id ?? '',
      businessDate: new Date('2099-01-01'),
      kind: 'CHARGE',
      revenueCodeId: code.id,
      description: 'B charge',
      unitAmountMinor: 100n,
      amountMinor: 100n,
      currency: 'NGN',
    },
  });
  return { ...theirs, folioId: folio.id, lineId: line.id };
}

async function bFolioUnchanged(db: Db, world: TenantWorld) {
  const folio = await db.folio.findFirstOrThrow({
    where: { propertyId: world.b1.id },
    include: { windows: true, routingRules: true, lines: true },
  });
  expect([folio.windows.length, folio.routingRules.length, folio.lines.length]).toEqual([1, 0, 1]);
}

/**
 * B's cashier with an open shift (float ₦1), a counted shift waiting for sign-off, and an
 * unconfirmed handover of ₦1 to A's own user: even that must stay out of A's sight (T-061).
 */
async function bShifts(db: Db, world: TenantWorld, propertyId: string) {
  const open = await db.cashierShift.create({
    data: { propertyId, userId: world.bStaff.id, floatMinor: 100n },
  });
  const closing = await db.cashierShift.create({
    data: {
      propertyId,
      userId: world.bStaff.id,
      status: 'CLOSING',
      closedAt: new Date('2099-01-01T18:00:00Z'),
      varianceNote: 'Short',
      counts: {
        create: {
          method: 'CASH',
          currency: 'NGN',
          expectedMinor: 100000n,
          countedMinor: 0n,
          varianceMinor: -100000n,
        },
      },
    },
  });
  const handover = await db.cashHandover.create({
    data: { fromShiftId: open.id, toUserId: world.aStaff.id, amountMinor: 100n, currency: 'NGN' },
  });
  return { shiftId: open.id, closingShiftId: closing.id, handoverId: handover.id };
}

async function bShiftsUnchanged(db: Db, world: TenantWorld) {
  const shifts = await db.cashierShift.findMany({
    where: { propertyId: world.b1.id },
    include: { counts: true, handovers: true },
    orderBy: { status: 'asc' },
  });
  expect(
    shifts.map((x) => [x.status, x.varianceNote, x.counts.length, x.handovers.length]),
  ).toEqual([
    ['OPEN', null, 0, 1],
    ['CLOSING', 'Short', 1, 0],
  ]);
  expect(shifts[0]?.handovers[0]?.confirmedAt).toBeNull();
  expect(await db.leakageAlert.count({ where: { propertyId: world.b1.id } })).toBe(0);
}

/** B's folio with a ₦1 cash payment on B's cashier's shift (T-062). */
async function bFolioPaid(db: Db, world: TenantWorld, propertyId: string) {
  const theirs = await bFolio(db, world, propertyId);
  const shift = await db.cashierShift.create({ data: { propertyId, userId: world.bStaff.id } });
  const window = await db.folioWindow.findFirstOrThrow({ where: { folioId: theirs.folioId } });
  const payment = await db.payment.create({
    data: {
      propertyId,
      folioId: theirs.folioId,
      windowId: window.id,
      method: 'CASH',
      amountMinor: 100n,
      currency: 'NGN',
      baseAmountMinor: 100n,
      provider: 'MANUAL',
      businessDate: new Date('2099-01-01'),
      shiftId: shift.id,
    },
  });
  return { ...theirs, paymentId: payment.id };
}

/** B's booking with a ₦1 cash deposit on B's cashier's shift (T-063). */
async function bDeposit(db: Db, world: TenantWorld, propertyId: string) {
  const theirs = await bReservation(db, world, propertyId);
  const shift = await db.cashierShift.create({ data: { propertyId, userId: world.bStaff.id } });
  const payment = await db.payment.create({
    data: {
      propertyId,
      reservationId: theirs.reservationId,
      method: 'CASH',
      amountMinor: 100n,
      currency: 'NGN',
      baseAmountMinor: 100n,
      provider: 'MANUAL',
      businessDate: new Date('2099-01-01'),
      shiftId: shift.id,
    },
  });
  return { ...theirs, paymentId: payment.id };
}

/** B's exchange rate for XAF on 2099-01-01 (T-065). */
async function bRate(db: Db, world: TenantWorld, propertyId: string) {
  await db.exchangeRate.create({
    data: {
      propertyId,
      currency: 'XAF',
      businessDate: new Date('2099-01-01'),
      rateMicros: 2_500_000n,
      setById: world.bStaff.id,
    },
  });
  return { date: '2099-01-01' };
}

async function bRateUnchanged(db: Db, world: TenantWorld) {
  const rates = await db.exchangeRate.findMany({ where: { propertyId: world.b1.id } });
  expect(rates.map((r) => [r.currency, r.rateMicros])).toEqual([['XAF', 2_500_000n]]);
}

/** B's night audit run, stopped at step 1 (T-073). */
async function bNightAudit(db: Db, _world: TenantWorld, propertyId: string) {
  const run = await db.nightAuditRun.create({
    data: {
      propertyId,
      businessDate: new Date('2099-01-01'),
      status: 'FAILED',
      steps: { create: [{ step: 1, name: 'OPEN_SHIFTS', status: 'BLOCKED' }] },
    },
  });
  return { nightAuditId: run.id };
}

async function bNightAuditUnchanged(db: Db, world: TenantWorld) {
  const runs = await db.nightAuditRun.findMany({
    where: { propertyId: world.b1.id },
    include: { steps: true },
  });
  expect(runs.map((r) => [r.status, r.currentStep, r.steps.map((s) => s.status)])).toEqual([
    ['FAILED', 1, ['BLOCKED']],
  ]);
}

/** B's payment link on its folio, not paid (T-070). */
async function bIntent(db: Db, world: TenantWorld, propertyId: string) {
  const theirs = await bFolio(db, world, propertyId);
  const intent = await db.paymentIntent.create({
    data: {
      propertyId,
      folioId: theirs['folioId'] ?? '',
      windowNumber: 1,
      provider: 'FAKE',
      providerRef: `HP-b-${propertyId}`,
      amountMinor: 100n,
      currency: 'NGN',
      idempotencyKey: `b-${propertyId}`,
      checkoutUrl: 'https://pay.example/b',
      expiresAt: new Date('2099-01-01'),
    },
  });
  return { ...theirs, paymentIntentId: intent.id };
}

async function bIntentsUnchanged(db: Db, world: TenantWorld) {
  const intents = await db.paymentIntent.findMany({ where: { propertyId: world.b1.id } });
  expect(intents.map((i) => i.status)).toEqual(['CREATED']);
}

/** B's virtual account on its folio, and a transfer waiting in its queue (T-071). */
async function bAccount(db: Db, world: TenantWorld, propertyId: string) {
  const theirs = await bFolio(db, world, propertyId);
  const account = await db.virtualAccount.create({
    data: {
      propertyId,
      provider: 'FAKE',
      accountNumber: `99${propertyId.slice(0, 8).replace(/D/g, '1').padEnd(8, '1')}`,
      bankName: 'Fake Bank',
      accountName: 'HOTEL/B GUEST',
      ownerType: 'FOLIO',
      ownerId: theirs['folioId'] ?? '',
    },
  });
  const transfer = await db.unmatchedTransfer.create({
    data: {
      propertyId,
      provider: 'FAKE',
      externalRef: `T-b-${propertyId}`,
      amountMinor: 100n,
      receivedAt: new Date('2099-01-01'),
    },
  });
  return { ...theirs, accountId: account.id, unmatchedTransferId: transfer.id };
}

async function bAccountUnchanged(db: Db, world: TenantWorld) {
  expect(await db.virtualAccount.count({ where: { propertyId: world.b1.id } })).toBe(1);
  const transfers = await db.unmatchedTransfer.findMany({ where: { propertyId: world.b1.id } });
  expect(transfers.map((t) => t.matchedPaymentId)).toEqual([null]);
}

/** B's room on its cleaning list (T-080). */
async function bAssignment(db: Db, world: TenantWorld, propertyId: string) {
  const theirs = await bRoom(db, world, propertyId);
  const a = await db.hkAssignment.create({
    data: {
      propertyId,
      businessDate: new Date('2099-01-01'),
      roomId: theirs.roomId,
      kind: 'DEPARTURE',
    },
  });
  return { ...theirs, assignmentId: a.id };
}

async function bAssignmentUnchanged(db: Db, world: TenantWorld) {
  const rows = await db.hkAssignment.findMany({ where: { propertyId: world.b1.id } });
  expect(rows.map((r) => [r.status, r.attendantId, r.notes])).toEqual([['PENDING', null, null]]);
}

/** B's room with a morning report on it (T-081). */
async function bReport(db: Db, world: TenantWorld, propertyId: string) {
  const theirs = await bRoom(db, world, propertyId);
  const reporter = await db.user.findFirstOrThrow();
  await db.roomStatusReport.create({
    data: {
      propertyId,
      businessDate: new Date('2099-01-01'),
      roomId: theirs.roomId,
      observed: 'VACANT',
      reportedById: reporter.id,
    },
  });
  return theirs;
}

async function bReportUnchanged(db: Db, world: TenantWorld) {
  const rows = await db.roomStatusReport.findMany({ where: { propertyId: world.b1.id } });
  expect(rows.map((r) => r.observed)).toEqual(['VACANT']);
  expect(await db.leakageAlert.count({ where: { propertyId: world.b1.id } })).toBe(0);
}

/** B's department, template and a reported task on B's room (T-082). */
async function bTask(db: Db, world: TenantWorld, propertyId: string) {
  const theirs = await bRoom(db, world, propertyId);
  const organisationId = orgOf(world, propertyId);
  const department = await db.department.create({
    data: { organisationId, propertyId, code: 'MNT', name: 'Maintenance' },
  });
  const template = await db.taskTemplate.create({
    data: { propertyId, type: 'FAULT', name: 'Fault', departmentId: department.id },
  });
  const task = await db.task.create({
    data: {
      organisationId,
      propertyId,
      number: 1,
      type: 'FAULT',
      templateId: template.id,
      title: 'Their fault',
      departmentId: department.id,
      roomId: theirs.roomId,
    },
  });
  return { ...theirs, departmentId: department.id, templateId: template.id, taskId: task.id };
}

async function bTaskUnchanged(db: Db, world: TenantWorld) {
  const tasks = await db.task.findMany({
    where: { propertyId: world.b1.id },
    include: { events: true },
  });
  expect(tasks.map((t) => [t.title, t.status, t.assigneeId, t.events.length])).toEqual([
    ['Their fault', 'REPORTED', null, 0],
  ]);
  expect(await db.taskTemplate.count({ where: { propertyId: world.b1.id } })).toBe(1);
}

/** B's room, named by its QR sticker token (T-082). */
async function bQr(db: Db, world: TenantWorld, propertyId: string) {
  const theirs = await bRoom(db, world, propertyId);
  const room = await db.room.findUniqueOrThrow({ where: { id: theirs.roomId } });
  return { ...theirs, token: room.qrToken };
}

async function bQrUnchanged(db: Db, world: TenantWorld) {
  expect(await db.task.count({ where: { propertyId: world.b1.id } })).toBe(0);
  const rooms = await db.room.findMany({ where: { propertyId: world.b1.id } });
  expect(rooms.map((r) => r.hkStatus)).not.toContain('OUT_OF_ORDER');
}

/** B's department and a handover written there, not acknowledged (T-083). */
async function bHandover(db: Db, world: TenantWorld, propertyId: string) {
  const organisationId = orgOf(world, propertyId);
  const department = await db.department.create({
    data: { organisationId, propertyId, code: 'HK', name: 'Housekeeping' },
  });
  const writer = organisationId === world.orgB.id ? world.bStaff : world.aStaff;
  const note = await db.handoverNote.create({
    data: {
      propertyId,
      departmentId: department.id,
      businessDate: new Date('2026-11-10T00:00:00Z'),
      content: { notes: 'Their handover', snapshot: {} },
      writtenById: writer.id,
    },
  });
  return { departmentId: department.id, handoverId: note.id };
}

async function bHandoverUnchanged(db: Db, world: TenantWorld) {
  const notes = await db.handoverNote.findMany({ where: { propertyId: world.b1.id } });
  expect(notes.map((n) => [(n.content as { notes: string }).notes, n.acknowledgedAt])).toEqual([
    ['Their handover', null],
  ]);
}

/** B's open leakage alert and B's reversal rule, switched off with instant alerts (T-090). */
async function bLeakage(db: Db, _world: TenantWorld, propertyId: string) {
  const alert = await db.leakageAlert.create({
    data: {
      propertyId,
      ruleCode: 'OCCUPIED_NO_FOLIO',
      businessDate: new Date('2026-11-10T00:00:00Z'),
      severity: 'HIGH',
      entityType: 'room',
      entityId: crypto.randomUUID(),
      evidence: { roomNumber: '999' },
      dedupeKey: 'OCCUPIED_NO_FOLIO:leak-test',
    },
  });
  await db.leakageRule.create({
    data: { propertyId, code: 'REVERSAL_PATTERN', enabled: false, notifyInstant: true },
  });
  return { alertId: alert.id, code: 'REVERSAL_PATTERN' };
}

async function bLeakageUnchanged(db: Db, world: TenantWorld) {
  const alerts = await db.leakageAlert.findMany({
    where: { propertyId: world.b1.id },
    include: { outcomes: true },
  });
  expect(alerts.map((a) => [a.status, a.outcomes.length])).toEqual([['OPEN', 0]]);
  const rules = await db.leakageRule.findMany({ where: { propertyId: world.b1.id } });
  expect(rules.map((r) => [r.code, r.enabled, r.notifyInstant])).toEqual([
    ['REVERSAL_PATTERN', false, true],
  ]);
}

/** B's own French wording of the booking email and a message B sent (T-024). */
async function bMessages(db: Db, world: TenantWorld, propertyId: string) {
  const marker = `Their wording ${crypto.randomUUID()}`;
  await db.messageTemplate.create({
    data: {
      organisationId: orgOf(world, propertyId),
      code: 'BOOKING_CONFIRMED',
      channel: 'EMAIL',
      language: 'fr',
      subject: 'Leak test',
      body: marker,
    },
  });
  const delivery = await db.notificationDelivery.create({
    data: {
      propertyId,
      channel: 'WHATSAPP',
      templateCode: 'BOOKING_CONFIRMED',
      recipient: '+2348000000777',
      payload: { vars: {}, language: 'en' },
    },
  });
  return {
    code: 'BOOKING_CONFIRMED',
    channel: 'EMAIL',
    language: 'fr',
    marker,
    deliveryId: delivery.id,
  };
}

async function bMessagesUnchanged(db: Db, world: TenantWorld, theirs: Record<string, string>) {
  const rows = await db.messageTemplate.findMany({ where: { organisationId: world.orgB.id } });
  expect(rows.map((r) => r.body)).toEqual([theirs['marker']]);
  const sent = await db.notificationDelivery.findMany({ where: { propertyId: world.b1.id } });
  expect(sent.map((d) => d.id)).toEqual([theirs['deliveryId']]);
}

/** B's closed day with its kept reports, an open alert and a tax rule (T-092). */
async function bReports(db: Db, _world: TenantWorld, propertyId: string) {
  const date = '2026-11-10';
  await db.nightAuditRun.create({
    data: {
      propertyId,
      businessDate: new Date(`${date}T00:00:00Z`),
      status: 'COMPLETED',
      finishedAt: new Date(),
      summary: { reports: { flash: {}, trialBalance: {}, cashier: { shifts: [] } } },
    },
  });
  await db.businessDay.create({
    data: {
      propertyId,
      date: new Date(`${date}T00:00:00Z`),
      status: 'CLOSED',
      closedAt: new Date(),
    },
  });
  await db.leakageAlert.create({
    data: {
      propertyId,
      ruleCode: 'OCCUPIED_NO_FOLIO',
      businessDate: new Date(`${date}T00:00:00Z`),
      severity: 'HIGH',
      entityType: 'room',
      entityId: crypto.randomUUID(),
      evidence: {},
      dedupeKey: 'OCCUPIED_NO_FOLIO:reports-leak-test',
    },
  });
  const code = await db.revenueCode.create({
    data: { propertyId, code: 'BTAX', name: 'B tax', group: 'TAX' },
  });
  await db.taxRule.create({
    data: { propertyId, name: 'B tax', authority: 'B Revenue Service', revenueCodeId: code.id },
  });
  return { date, rule: 'Occupied without folio', authority: 'B Revenue Service' };
}

const closedDay = {
  seed: bReports,
  query: (t: Record<string, string>) => ({ date: t['date'] ?? '' }),
};

/** B's invoice and legal name (T-100). */
async function bBilling(db: Db, world: TenantWorld, propertyId: string) {
  const organisationId = orgOf(world, propertyId);
  await db.organisation.update({ where: { id: organisationId }, data: { legalName: 'B Legal' } });
  const invoice = await db.platformInvoice.create({
    data: {
      organisationId,
      periodStart: new Date('2026-10-01T00:00:00Z'),
      periodEnd: new Date('2026-10-31T00:00:00Z'),
      activeRooms: 3,
      lines: [],
      totalMinor: 100n,
      currency: 'NGN',
      status: 'ISSUED',
      issuedAt: new Date(),
    },
  });
  return { invoiceId: invoice.id };
}

async function bBillingUnchanged(db: Db, world: TenantWorld) {
  const org = await db.organisation.findUniqueOrThrow({ where: { id: world.orgB.id } });
  expect(org.legalName).toBe('B Legal');
}

const taskWrite = (body?: object) => ({
  seed: bTask,
  ...(body ? { body: () => body } : {}),
  untouched: bTaskUnchanged,
});

/** Stay and reservation IDs on a front desk list (T-053). */
const frontDeskIds = (body: unknown) =>
  (body as { data: { stayId: string; reservationId: string }[] }).data.flatMap((r) => [
    r.stayId,
    r.reservationId,
  ]);

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
  markNoShow: { seed: bReservation, body: () => ({}), untouched: bReservationUnchanged },
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
  getCheckOut: { seed: bInHouse },
  checkOut: {
    seed: bReservation,
    body: () => ({}),
    untouched: bReservationUnchanged,
  },
  listArrivals: {
    // B's stay arrives on 2099-01-01: A1's list for that day must not show it.
    seed: bReservation,
    query: () => ({ date: '2099-01-01' }),
    listIds: frontDeskIds,
  },
  listDepartures: {
    seed: bInHouse,
    query: () => ({ date: '2099-01-02' }),
    listIds: frontDeskIds,
  },
  listInHouse: {
    seed: bInHouse,
    listIds: frontDeskIds,
  },
  // Visitor register (T-057).
  getBookingEngineSettings: {
    seed: bBookingPage,
    listIds: (body) => [(body as { slug: string | null }).slug ?? 'none'],
  },
  saveBookingEngineSettings: {
    seed: bBookingPage,
    creates: true,
    body: () => ({
      slug: 'a-page',
      enabled: false,
      headline: null,
      description: null,
      policies: null,
      photoFileIds: [],
      allowPayFull: true,
      allowDeposit: true,
      depositBps: 3000,
      allowPayAtHotel: true,
    }),
    untouched: async (db) => {
      expect(await db.bookingEngineSettings.count({ where: { slug: 'theirs-page' } })).toBe(1);
    },
  },
  listPromoCodes: {
    seed: bBookingPage,
    listIds: (body) => (body as { data: { id: string }[] }).data.map((p) => p.id),
  },
  createPromoCode: {
    seed: bBookingPage,
    creates: true,
    body: () => ({ code: 'MINE', discountBps: 500 }),
    untouched: async (db) => {
      expect(await db.promoCode.count({ where: { code: 'THEIRS' } })).toBe(1);
    },
  },
  updatePromoCode: {
    seed: bBookingPage,
    body: () => ({ active: false }),
    untouched: bBookingPageUnchanged,
  },
  listVisitors: {
    seed: bVisitor,
    listIds: (body) => (body as { data: { id: string }[] }).data.map((v) => v.id),
  },
  signInVisitor: {
    seed: bInHouse,
    body: (theirs) => ({ stayId: theirs['stayId'], name: 'Leak' }),
    untouched: async (db) => {
      expect(await db.visitor.count()).toBe(0);
    },
  },
  signOutVisitor: {
    seed: bVisitor,
    body: () => ({}),
    untouched: async (db) => {
      expect((await db.visitor.findMany()).map((v) => v.signedOutAt)).toEqual([null]);
    },
  },
  // Extra people on a stay (T-056).
  listOccupants: { seed: bInHouse },
  addOccupant: {
    seed: bInHouse,
    body: () => ({ firstName: 'Leak', lastName: 'Test', kind: 'ADULT' }),
    untouched: async (db) => {
      expect(await db.stayOccupant.count()).toBe(0);
    },
  },
  changeOccupantCharge: {
    seed: bOccupant,
    body: () => ({ nightlyChargeMinor: '1', chargeNote: 'Leak' }),
    untouched: bOccupantUnchanged,
  },
  removeOccupant: {
    seed: bOccupant,
    body: () => ({}),
    untouched: bOccupantUnchanged,
  },
  listStayAlerts: {
    // T-055: B's checked-in guest never shows among A1's alerts.
    seed: bInHouse,
    listIds: frontDeskIds,
  },
  postLateCheckOutFee: {
    seed: bInHouse,
    body: () => ({}),
    untouched: async (db, _world, theirs) => {
      expect(await db.folioLine.count({ where: { sourceId: theirs['stayId'] } })).toBe(0);
    },
  },
  getBusinessDay: {
    // No record in the path: A1 gets its own day; asking for B1 is refused like any route.
    seed: bProperty,
    listIds: () => [],
  },
  extendStay: {
    seed: bInHouse,
    body: () => ({ departure: '2099-01-05' }),
    untouched: async (db, world, theirs) => {
      const stay = await db.stay.findUniqueOrThrow({ where: { id: theirs['stayId'] ?? '' } });
      expect(stay.departure).toEqual(new Date('2099-01-02'));
      await bReservationUnchanged(db, world);
    },
  },
  listFolios: {
    seed: bFolio,
    listIds: (body) => (body as { data: { id: string }[] }).data.map((f) => f.id),
  },
  getFolio: { seed: bFolio },
  openStayFolio: {
    seed: bInHouse,
    untouched: async (db, world) => {
      expect(await db.folio.count({ where: { propertyId: world.b1.id } })).toBe(0);
    },
  },
  postCharge: {
    seed: bFolio,
    body: () => ({ revenueCode: 'MISC', description: 'Leak', unitAmountMinor: '1' }),
    untouched: bFolioUnchanged,
  },
  reverseLine: { seed: bFolio, body: () => ({ reason: 'Leak' }), untouched: bFolioUnchanged },
  addDiscount: {
    seed: bFolio,
    body: (theirs) => ({ lineId: theirs['lineId'], percent: 10, reason: 'Leak' }),
    untouched: bFolioUnchanged,
  },
  addWindow: { seed: bFolio, body: () => ({ payerType: 'GUEST' }), untouched: bFolioUnchanged },
  addRoutingRule: {
    seed: bFolio,
    body: () => ({ revenueGroup: 'OTHER', windowNumber: 1 }),
    untouched: bFolioUnchanged,
  },
  getCurrentShift: {
    seed: bShifts,
    listIds: (body) => {
      const b = body as {
        shift: { id: string } | null;
        awaitingSignOff: { id: string }[];
        incoming: { id: string }[];
      };
      return [
        ...(b.shift ? [b.shift.id] : []),
        ...b.awaitingSignOff.map((x) => x.id),
        ...b.incoming.map((x) => x.id),
      ];
    },
  },
  listShifts: { seed: bShifts, listIds: ids },
  openShift: {
    seed: bShifts,
    creates: true,
    body: () => ({ floatMinor: '0' }),
    untouched: bShiftsUnchanged,
  },
  closeShift: {
    seed: bShifts,
    body: () => ({ counts: [{ method: 'CASH', currency: 'NGN', countedMinor: '0' }] }),
    untouched: bShiftsUnchanged,
  },
  addVarianceNote: {
    seed: async (db, world, propertyId) => {
      const theirs = await bShifts(db, world, propertyId);
      return { ...theirs, shiftId: theirs.closingShiftId };
    },
    body: () => ({ note: 'Leak' }),
    untouched: bShiftsUnchanged,
  },
  signOffShift: {
    seed: async (db, world, propertyId) => {
      const theirs = await bShifts(db, world, propertyId);
      return { ...theirs, shiftId: theirs.closingShiftId };
    },
    body: () => ({}),
    untouched: bShiftsUnchanged,
  },
  createHandover: {
    seed: bShifts,
    creates: true,
    body: () => ({ toUserId: null, amountMinor: '100' }),
    untouched: bShiftsUnchanged,
  },
  confirmHandover: { seed: bShifts, body: () => ({}), untouched: bShiftsUnchanged },
  capturePayment: {
    seed: bFolio,
    creates: true,
    body: (theirs) => ({ folioId: theirs['folioId'], method: 'CASH', amountMinor: '100' }),
    untouched: async (db, world) => {
      expect(await db.payment.count({ where: { propertyId: world.b1.id } })).toBe(0);
    },
  },
  getFolioInvoice: { seed: bFolio },
  getFolioReceipt: {
    seed: bFolioPaid,
    query: (theirs) => ({ paymentId: theirs['paymentId'] ?? '' }),
  },
  getProforma: { seed: bReservation },
  refundPayment: {
    seed: bFolioPaid,
    body: () => ({ amountMinor: '1', reason: 'Leak' }),
    untouched: async (db, world) => {
      expect(
        await db.payment.count({
          where: { propertyId: world.b1.id, refundsPaymentId: { not: null } },
        }),
      ).toBe(0);
    },
  },
  getDepositReceipt: {
    seed: bDeposit,
    query: (theirs) => ({ paymentId: theirs['paymentId'] ?? '' }),
  },
  createFolio: {
    seed: bFolio,
    creates: true,
    body: () => ({ kind: 'HOUSE', name: 'Leak' }),
    untouched: async (db, world) => {
      expect(await db.folio.count({ where: { propertyId: world.b1.id } })).toBe(1);
    },
  },
  transferFolio: {
    seed: bFolio,
    body: (theirs) => ({
      fromWindow: 1,
      toFolioId: theirs['folioId'],
      toWindow: 1,
      amountMinor: '1',
      reason: 'Leak',
    }),
    untouched: bFolioUnchanged,
  },
  getExchangeRates: {
    seed: bRate,
    listIds: (body) => (body as { rates: { currency: string }[] }).rates.map((r) => r.currency),
  },
  putExchangeRates: {
    seed: bRate,
    creates: true,
    body: () => ({ rates: [{ currency: 'XAF', rate: '9' }] }),
    untouched: bRateUnchanged,
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
  getNightAudit: { seed: bNightAudit },
  startNightAudit: {
    seed: bNightAudit,
    creates: true,
    body: () => ({ businessDate: '2099-01-01' }),
    untouched: bNightAuditUnchanged,
  },
  resumeNightAudit: { seed: bNightAudit, untouched: bNightAuditUnchanged },
  getNightAuditReport: {
    seed: async (db, world, propertyId) => ({
      ...(await bNightAudit(db, world, propertyId)),
      report: 'flash',
    }),
  },
  createPaymentIntent: {
    seed: bIntent,
    creates: true,
    body: (theirs) => ({
      folioId: theirs['folioId'],
      amountMinor: '100',
      email: 'leak@example.com',
    }),
    untouched: bIntentsUnchanged,
  },
  listPaymentIntents: {
    seed: bIntent,
    query: (theirs) => ({ folioId: theirs['folioId'] ?? '' }),
    listIds: (body) => (body as { data: { id: string }[] }).data.map((i) => i.id),
  },
  checkPaymentIntent: { seed: bIntent, untouched: bIntentsUnchanged },
  createVirtualAccount: {
    seed: bAccount,
    creates: true,
    body: (theirs) => ({
      ownerType: 'FOLIO',
      ownerId: theirs['folioId'],
      email: 'leak@example.com',
      phone: '+2348000000000',
    }),
    untouched: bAccountUnchanged,
  },
  listVirtualAccounts: {
    seed: bAccount,
    query: (theirs) => ({ ownerType: 'FOLIO', ownerId: theirs['folioId'] ?? '' }),
    listIds: (body) => (body as { data: { id: string }[] }).data.map((a) => a.id),
  },
  listUnmatchedTransfers: {
    seed: bAccount,
    listIds: (body) => (body as { data: { id: string }[] }).data.map((t) => t.id),
  },
  matchUnmatchedTransfer: {
    seed: bAccount,
    body: (theirs) => ({ folioId: theirs['folioId'] }),
    untouched: bAccountUnchanged,
  },
  getHousekeepingBoard: {
    seed: bAssignment,
    listIds: (body) =>
      (body as { rooms: { roomId: string; assignment: { id: string } | null }[] }).rooms.flatMap(
        (r) => [r.roomId, ...(r.assignment ? [r.assignment.id] : [])],
      ),
  },
  assignRooms: {
    seed: bAssignment,
    creates: true,
    body: (theirs) => ({ roomIds: [theirs['roomId']], attendantId: null }),
    untouched: bAssignmentUnchanged,
  },
  listMyAssignments: {
    seed: bAssignment,
    listIds: (body) => (body as { data: { id: string }[] }).data.map((a) => a.id),
  },
  updateAssignment: {
    seed: bAssignment,
    body: () => ({ notes: 'Leak' }),
    untouched: bAssignmentUnchanged,
  },
  listStatusReports: {
    seed: bReport,
    listIds: (body) => (body as { data: { roomId: string }[] }).data.map((r) => r.roomId),
  },
  submitStatusReport: {
    seed: bReport,
    creates: true,
    body: (theirs) => ({ entries: [{ roomId: theirs['roomId'], observed: 'OCCUPIED' }] }),
    untouched: bReportUnchanged,
  },
  listTasks: {
    seed: bTask,
    listIds: (body) => (body as { data: { id: string }[] }).data.map((t) => t.id),
  },
  createTask: {
    seed: bTask,
    creates: true,
    body: (theirs) => ({ templateId: theirs['templateId'], roomId: theirs['roomId'] }),
    untouched: bTaskUnchanged,
  },
  getTaskFormOptions: {
    seed: bTask,
    listIds: (body) => {
      const b = body as { departments: { id: string }[]; rooms: { id: string }[] };
      return [...b.departments.map((d) => d.id), ...b.rooms.map((r) => r.id)];
    },
  },
  getTask: { seed: bTask },
  assignTask: taskWrite({ assigneeId: null }),
  acknowledgeTask: taskWrite(),
  startTask: taskWrite(),
  holdTask: taskWrite({ reason: 'Leak test' }),
  resolveTask: taskWrite({ note: 'Leak test' }),
  verifyTask: taskWrite({}),
  reopenTask: taskWrite({ reason: 'Leak test' }),
  addTaskComment: taskWrite({ note: 'Leak test' }),
  listTaskTemplates: {
    seed: bTask,
    listIds: (body) => (body as { data: { id: string }[] }).data.map((t) => t.id),
  },
  createTaskTemplate: {
    seed: bTask,
    creates: true,
    body: (theirs) => ({ type: 'FAULT', name: 'Leak', departmentId: theirs['departmentId'] }),
    untouched: bTaskUnchanged,
  },
  getQrRoom: { seed: bQr },
  reportQrFault: {
    seed: bQr,
    body: () => ({ category: 'OTHER', severity: 'CRITICAL', outOfOrderUntil: '2099-01-02' }),
    untouched: bQrUnchanged,
  },
  listHandoverNotes: { seed: bHandover, listIds: ids },
  getHandoverDraft: {
    seed: bHandover,
    query: (theirs) => ({ departmentId: theirs['departmentId'] ?? '' }),
  },
  writeHandoverNote: {
    seed: bHandover,
    creates: true,
    body: (theirs) => ({ departmentId: theirs['departmentId'], notes: 'Leak test' }),
    untouched: bHandoverUnchanged,
  },
  acknowledgeHandoverNote: { seed: bHandover, untouched: bHandoverUnchanged },
  listLeakageAlerts: { seed: bLeakage, listIds: ids },
  getLeakageAlert: { seed: bLeakage },
  addLeakageAlertOutcome: {
    seed: bLeakage,
    body: () => ({ outcome: 'EXPLAINED', note: 'Leak test' }),
    untouched: bLeakageUnchanged,
  },
  listLeakageRules: {
    seed: bLeakage,
    // A rule switched off would be B's: A's are all on.
    listIds: (body) =>
      (body as { rules: { code: string; enabled: boolean }[] }).rules
        .filter((r) => !r.enabled)
        .map((r) => r.code),
  },
  updateLeakageRules: {
    seed: bLeakage,
    creates: true,
    body: () => ({ rules: [{ code: 'REVERSAL_PATTERN', enabled: true, notifyInstant: false }] }),
    untouched: bLeakageUnchanged,
  },
  listMessageTemplates: {
    seed: bMessages,
    listIds: (body) => (body as { templates: { body: string }[] }).templates.map((t) => t.body),
  },
  saveMessageTemplate: {
    seed: bMessages,
    creates: true,
    body: () => ({
      code: 'BOOKING_CONFIRMED',
      channel: 'EMAIL',
      language: 'fr',
      subject: 'Leak test',
      body: 'Our wording',
    }),
    untouched: bMessagesUnchanged,
  },
  // A's own (absent) wording may be reset; B's stays.
  resetMessageTemplate: { seed: bMessages, creates: true, untouched: bMessagesUnchanged },
  sendTestMessage: {
    seed: bMessages,
    creates: true,
    body: () => ({ code: 'BOOKING_CONFIRMED', channel: 'WHATSAPP', to: '+2348000000888' }),
    untouched: bMessagesUnchanged,
  },
  listMessageDeliveries: { seed: bMessages, listIds: ids },
  getDashboardReport: {
    seed: bReports,
    listIds: (body) =>
      (body as { alerts: { byRule: { rule: string }[] } }).alerts.byRule.map((r) => r.rule),
  },
  getFlashReport: closedDay,
  getTrialBalanceReport: closedDay,
  getCashierReport: closedDay,
  getTaxReport: {
    seed: bReports,
    query: () => ({ from: '2026-11-01', to: '2026-11-30' }),
    listIds: (body) =>
      (body as { authorities: { authority: string }[] }).authorities.map((a) => a.authority),
  },
  getSubscription: {
    seed: bBilling,
    listIds: (body) => (body as { invoices: { id: string }[] }).invoices.map((i) => i.id),
  },
  updateBillingDetails: {
    seed: bBilling,
    creates: true,
    body: () => ({ legalName: 'A Legal' }),
    untouched: bBillingUnchanged,
  },
  getPlatformInvoicePdf: { seed: bBilling },
  // The home spans properties: B's property must never be one of A's cards (T-091).
  getOwnerHome: {
    seed: (_db, _world, propertyId) => Promise.resolve({ propertyId }),
    listIds: (body) => (body as { properties: { id: string }[] }).properties.map((p) => p.id),
  },
};
