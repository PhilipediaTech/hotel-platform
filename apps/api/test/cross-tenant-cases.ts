import { randomUUID } from 'node:crypto';
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

const SPACE_BODY = {
  code: 'LEAK',
  name: 'Leak',
  layouts: [{ name: 'Theatre', capacity: 10 }],
};
const ENQUIRY_BODY = { contactName: 'Leak', eventType: 'Leak' };

async function bSpace(db: Db, world: TenantWorld, propertyId: string) {
  const space = await db.space.create({
    data: {
      organisationId: orgOf(world, propertyId),
      propertyId,
      code: 'HALL',
      name: 'Theirs',
      layouts: { create: { propertyId, name: 'Theatre', capacity: 50 } },
    },
    include: { layouts: true },
  });
  return { spaceId: space.id, layoutId: space.layouts[0]?.id ?? '' };
}

async function bSpaceUnchanged(db: Db, world: TenantWorld, theirs: Record<string, string>) {
  const space = await db.space.findUniqueOrThrow({ where: { id: theirs['spaceId'] ?? '' } });
  expect(space.name).toBe('Theirs');
  expect(await db.space.count({ where: { code: 'LEAK', propertyId: world.b1.id } })).toBe(0);
}

async function bEventBooking(db: Db, world: TenantWorld, propertyId: string) {
  const { spaceId, layoutId } = await bSpace(db, world, propertyId);
  const organisationId = orgOf(world, propertyId);
  const enquiry = await db.eventEnquiry.create({
    data: {
      organisationId,
      propertyId,
      contactName: 'Theirs',
      eventType: 'Wedding',
      createdById: world.bStaff.id,
    },
  });
  const booking = await db.eventBooking.create({
    data: {
      organisationId,
      propertyId,
      enquiryId: enquiry.id,
      spaceId,
      layoutId,
      title: 'Theirs',
      status: 'HOLD',
      startsAt: new Date('2099-05-01T10:00:00Z'),
      endsAt: new Date('2099-05-01T12:00:00Z'),
      blockedFrom: new Date('2099-05-01T10:00:00Z'),
      blockedUntil: new Date('2099-05-01T12:00:00Z'),
      expectedGuests: 5,
      holdExpiresAt: new Date('2099-04-01T10:00:00Z'),
      createdById: world.bStaff.id,
    },
  });
  return { spaceId, layoutId, enquiryId: enquiry.id, bookingId: booking.id };
}

async function bEventUnchanged(db: Db, world: TenantWorld, theirs: Record<string, string>) {
  const booking = await db.eventBooking.findUniqueOrThrow({
    where: { id: theirs['bookingId'] ?? '' },
  });
  expect(booking.status).toBe('HOLD');
  const enquiry = await db.eventEnquiry.findUniqueOrThrow({
    where: { id: theirs['enquiryId'] ?? '' },
  });
  expect(enquiry.contactName).toBe('Theirs');
  expect(
    await db.eventEnquiry.count({ where: { contactName: 'Leak', propertyId: world.b1.id } }),
  ).toBe(0);
  expect(await db.eventBooking.count({ where: { title: 'Leak', propertyId: world.b1.id } })).toBe(
    0,
  );
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

/** A WhatsApp conversation at B (T-115). */
async function bThread(db: Db, world: TenantWorld, propertyId: string) {
  const thread = await db.messageThread.create({
    data: {
      organisationId: orgOf(world, propertyId),
      propertyId,
      phone: '+2348030000099',
      lastInboundAt: new Date(),
      lastMessageAt: new Date(),
      lastPreview: 'Theirs',
      unreadCount: 2,
    },
  });
  return { threadId: thread.id };
}

async function bThreadUnchanged(db: Db) {
  expect((await db.messageThread.findMany()).map((t) => t.unreadCount)).toEqual([2]);
  expect(await db.message.count()).toBe(0);
}

/** B's booking page and a promo code (T-112). */
/** B's own cancellation rule (T-121c). */
async function bEventSettings(db: Db, _world: TenantWorld, propertyId: string) {
  await db.property.update({
    where: { id: propertyId },
    data: {
      settings: {
        eventCancellation: { noticeHours: 99, earlyHours: 9, earlyKeepBps: 9, laterKeepBps: 9 },
      },
    },
  });
  return { noticeHours: '99' };
}

async function bEventSettingsUnchanged(db: Db, world: TenantWorld) {
  const b = await db.property.findUniqueOrThrow({ where: { id: world.b1.id } });
  const rule = (b.settings as { eventCancellation?: { noticeHours: number } }).eventCancellation;
  expect(rule?.noticeHours).toBe(99);
}

/** A service of B's, booked by B's in-house guest (T-122). */
async function bService(db: Db, world: TenantWorld, propertyId: string) {
  const theirs = await bInHouse(db, world, propertyId);
  const code = await db.revenueCode.create({
    data: { propertyId, code: 'SVCB', name: 'Services', group: 'OTHER' },
  });
  const service = await db.service.create({
    data: {
      organisationId: orgOf(world, propertyId),
      propertyId,
      code: 'SPA',
      name: 'Theirs',
      category: 'SPA',
      priceMinor: 100n,
      durationMinutes: 60,
      opensAt: '00:00',
      closesAt: '23:59',
      maxAdvanceDays: 365,
      revenueCodeId: code.id,
    },
  });
  const booking = await db.serviceBooking.create({
    data: {
      propertyId,
      serviceId: service.id,
      stayId: theirs.stayId,
      guestName: 'Theirs',
      startsAt: new Date('2099-06-01T10:00:00Z'),
      endsAt: new Date('2099-06-01T11:00:00Z'),
      amountMinor: 100n,
      createdById: world.bStaff.id,
    },
  });
  return { ...theirs, serviceId: service.id, bookingId: booking.id };
}

async function bServiceUnchanged(db: Db, world: TenantWorld, theirs: Record<string, string>) {
  const service = await db.service.findUniqueOrThrow({ where: { id: theirs['serviceId'] ?? '' } });
  expect(service.name).toBe('Theirs');
  const booking = await db.serviceBooking.findUniqueOrThrow({
    where: { id: theirs['bookingId'] ?? '' },
  });
  expect(booking.status).toBe('BOOKED');
  expect(await db.service.count({ where: { code: 'LEAK', propertyId: world.b1.id } })).toBe(0);
  expect(
    await db.serviceBooking.count({ where: { guestName: 'Leak', propertyId: world.b1.id } }),
  ).toBe(0);
}

/** B's group block and allotment, each holding one room type on one night (T-123). */
async function bGroupBlocks(db: Db, world: TenantWorld, propertyId: string) {
  const organisationId = orgOf(world, propertyId);
  const plan = await bPlan(db, world, propertyId);
  const agent = await db.company.create({
    data: { organisationId, kind: 'TRAVEL_AGENT', name: 'Theirs agent' },
  });
  const make = async (kind: 'GROUP' | 'ALLOTMENT', code: string) => {
    const block = await db.groupBlock.create({
      data: {
        organisationId,
        propertyId,
        kind,
        code,
        name: 'Theirs',
        companyId: kind === 'ALLOTMENT' ? agent.id : null,
        ratePlanId: plan.ratePlanId,
        arrival: new Date('2099-06-01'),
        departure: new Date('2099-06-02'),
        releaseDate: kind === 'GROUP' ? new Date('2099-05-01') : null,
        releaseDays: kind === 'ALLOTMENT' ? 7 : null,
        createdById: world.bStaff.id,
        nights: {
          create: {
            propertyId,
            roomTypeId: plan.roomTypeId,
            date: new Date('2099-06-01'),
            rooms: 1,
            remaining: 1,
          },
        },
      },
    });
    return block.id;
  };
  return {
    ...plan,
    groupId: await make('GROUP', 'THEIRS-G'),
    allotmentId: await make('ALLOTMENT', 'THEIRS-A'),
    agentId: agent.id,
  };
}

async function bGroupBlock(db: Db, world: TenantWorld, propertyId: string) {
  const theirs = await bGroupBlocks(db, world, propertyId);
  return { ...theirs, blockId: theirs.groupId };
}

async function bAllotment(db: Db, world: TenantWorld, propertyId: string) {
  const theirs = await bGroupBlocks(db, world, propertyId);
  return { ...theirs, blockId: theirs.allotmentId };
}

async function bGroupBlocksUnchanged(db: Db, world: TenantWorld) {
  const blocks = await db.groupBlock.findMany({ where: { propertyId: world.b1.id } });
  expect(blocks.map((b) => [b.code, b.name, b.status]).sort()).toEqual([
    ['THEIRS-A', 'Theirs', 'ACTIVE'],
    ['THEIRS-G', 'Theirs', 'ACTIVE'],
  ]);
  expect(await db.reservation.count({ where: { groupBlockId: { not: null } } })).toBe(0);
}

/** B's company account with an invoice and a payment, and B's folio owing money (T-126). */
async function bArAccount(db: Db, world: TenantWorld, propertyId: string) {
  const theirs = await bFolio(db, world, propertyId);
  const organisationId = orgOf(world, propertyId);
  const company = await db.company.create({
    data: { organisationId, kind: 'COMPANY', name: 'Theirs Ltd' },
  });
  const account = await db.arAccount.create({
    data: { organisationId, propertyId, companyId: company.id, creditLimitMinor: 1000000n },
  });
  const invoice = await db.arInvoice.create({
    data: {
      propertyId,
      arAccountId: account.id,
      number: 'AR-THEIRS',
      amountMinor: 1000n,
      issuedOn: new Date('2026-11-01'),
      dueOn: new Date('2026-12-01'),
    },
  });
  const payment = await db.arPayment.create({
    data: {
      propertyId,
      arAccountId: account.id,
      method: 'BANK_TRANSFER',
      amountMinor: 500n,
      receivedOn: new Date('2026-11-05'),
      createdById: world.bStaff.id,
    },
  });
  return { ...theirs, accountId: account.id, invoiceId: invoice.id, paymentId: payment.id };
}

/** B's company account, with the company named (T-163). */
async function bGroupCompany(db: Db, world: TenantWorld, propertyId: string) {
  const theirs = await bArAccount(db, world, propertyId);
  const account = await db.arAccount.findUniqueOrThrow({ where: { id: theirs.accountId } });
  return { ...theirs, companyId: account.companyId };
}

async function bArUnchanged(db: Db, world: TenantWorld) {
  const accounts = await db.arAccount.findMany({ where: { propertyId: world.b1.id } });
  expect(accounts.map((a) => [a.creditLimitMinor, a.status])).toEqual([[1000000n, 'ACTIVE']]);
  expect(await db.arInvoice.count({ where: { propertyId: world.b1.id } })).toBe(1);
  expect(await db.arPayment.count({ where: { propertyId: world.b1.id } })).toBe(1);
  expect(await db.arAllocation.count()).toBe(0);
  expect(await db.payment.count({ where: { method: 'AR_TRANSFER' } })).toBe(0);
}

/** B's unmatched statement line, the same as B's city-ledger receipt (T-128). */
async function bBankLine(db: Db, world: TenantWorld, propertyId: string) {
  const theirs = await bArAccount(db, world, propertyId);
  const line = await db.bankStatementLine.create({
    data: {
      propertyId,
      importId: '0d0d0d0d-0000-4000-8000-0000000000bb',
      bankAccount: 'Theirs',
      postedOn: new Date('2026-11-05'),
      description: 'THEIR RECEIPT',
      amountMinor: 500n,
      fingerprint: 'theirs',
      importedById: world.bStaff.id,
    },
  });
  return { ...theirs, lineId: line.id };
}

async function bBankLineUnchanged(db: Db, world: TenantWorld) {
  const lines = await db.bankStatementLine.findMany({ where: { propertyId: world.b1.id } });
  expect(lines.map((l) => [l.description, l.status])).toEqual([['THEIR RECEIPT', 'UNMATCHED']]);
  expect(await db.reconciliationMatch.count()).toBe(0);
}

/** B's checked-out agent booking with a due commission (T-127). */
async function bCommission(db: Db, world: TenantWorld, propertyId: string) {
  const theirs = await bArAccount(db, world, propertyId);
  const account = await db.arAccount.findUniqueOrThrow({ where: { id: theirs.accountId } });
  await db.company.update({
    where: { id: account.companyId },
    data: { kind: 'TRAVEL_AGENT', commissionBps: 1000 },
  });
  await db.reservation.update({
    where: { id: theirs.reservationId },
    data: { travelAgentId: account.companyId },
  });
  await db.stay.update({
    where: { id: theirs.stayId },
    data: { status: 'CHECKED_OUT', checkedOutAt: new Date('2026-01-15T10:00:00Z') },
  });
  const commission = await db.commission.create({
    data: {
      propertyId,
      travelAgentId: account.companyId,
      stayId: theirs.stayId,
      checkedOutOn: new Date('2026-01-15'),
      baseMinor: 1000n,
      rateBps: 1000,
      amountMinor: 100n,
    },
  });
  return { ...theirs, commissionId: commission.id, agentId: account.companyId };
}

async function bCommissionUnchanged(db: Db, world: TenantWorld) {
  const rows = await db.commission.findMany();
  expect(rows.map((c) => [c.status, c.baseMinor, c.amountMinor])).toEqual([['DUE', 1000n, 100n]]);
  expect(await db.arPayment.count({ where: { propertyId: world.b1.id } })).toBe(1);
  expect(await db.arAllocation.count()).toBe(0);
}

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

/** B's clean room, inspected once, and B's housekeeping settings (T-129). */
async function bInspection(db: Db, world: TenantWorld, propertyId: string) {
  const theirs = await bRoom(db, world, propertyId);
  await db.room.update({ where: { id: theirs.roomId }, data: { hkStatus: 'CLEAN' } });
  const inspector = await db.user.findFirstOrThrow();
  await db.inspection.create({
    data: {
      propertyId,
      roomId: theirs.roomId,
      inspectorId: inspector.id,
      passed: true,
      failReasons: [],
    },
  });
  await db.property.update({
    where: { id: propertyId },
    data: { settings: { housekeeping: { inspectionRequired: true } } },
  });
  return theirs;
}

async function bInspectionUnchanged(db: Db, world: TenantWorld) {
  const rooms = await db.room.findMany({ where: { propertyId: world.b1.id } });
  expect(rooms.map((r) => r.hkStatus)).toEqual(['CLEAN']);
  expect(await db.inspection.count({ where: { propertyId: world.b1.id } })).toBe(1);
  const b = await db.property.findUniqueOrThrow({ where: { id: world.b1.id } });
  expect(b.settings).toMatchObject({ housekeeping: { inspectionRequired: true } });
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

/** B's asset with a fault task on it, work logged (T-130). */
async function bAsset(db: Db, world: TenantWorld, propertyId: string) {
  const theirs = await bTask(db, world, propertyId);
  const asset = await db.asset.create({
    data: { propertyId, tag: 'B-AC', name: 'Their AC', category: 'Air conditioning' },
  });
  await db.task.update({
    where: { id: theirs.taskId },
    data: {
      assetId: asset.id,
      workOrder: { create: { labourMinutes: 30, costMinor: 500n, vendorName: 'B vendor' } },
    },
  });
  return { ...theirs, assetId: asset.id };
}

async function bAssetUnchanged(db: Db, world: TenantWorld) {
  const assets = await db.asset.findMany({ where: { propertyId: world.b1.id } });
  expect(assets.map((a) => [a.tag, a.status, a.location])).toEqual([['B-AC', 'IN_SERVICE', null]]);
  const tasks = await db.task.findMany({
    where: { propertyId: world.b1.id },
    include: { workOrder: true },
  });
  expect(tasks.map((t) => [t.assetId, t.workOrder?.labourMinutes])).toEqual([[assets[0]?.id, 30]]);
}

/** B's run-hours plan on their asset (T-131). */
async function bPmPlan(db: Db, world: TenantWorld, propertyId: string) {
  const theirs = await bAsset(db, world, propertyId);
  const plan = await db.preventivePlan.create({
    data: {
      propertyId,
      title: 'Their oil change',
      assetId: theirs.assetId,
      trigger: 'RUN_HOURS',
      everyHours: 250,
      meterHours: 100,
      lastServiceHours: 0,
    },
  });
  return { ...theirs, planId: plan.id };
}

async function bPmPlanUnchanged(db: Db, world: TenantWorld) {
  const plans = await db.preventivePlan.findMany({ where: { propertyId: world.b1.id } });
  expect(plans.map((p) => [p.title, p.meterHours, p.active, p.openTaskId])).toEqual([
    ['Their oil change', 100, true, null],
  ]);
}

/** B's generator on their asset, running, with a fuel check; and a meter reading (T-132). */
async function bGenerator(db: Db, world: TenantWorld, propertyId: string) {
  const theirs = await bAsset(db, world, propertyId);
  const userId = (await db.user.findFirstOrThrow()).id;
  const generator = await db.generator.create({
    data: {
      propertyId,
      assetId: theirs.assetId,
      name: 'Their generator',
      tankLitresMilli: 1_000_000,
      runs: { create: { startedAt: new Date(Date.now() - 3_600_000), startedById: userId } },
      fuelMovements: { create: { kind: 'LEVEL_CHECK', litresMilli: 500_000, byUserId: userId } },
    },
    include: { runs: true },
  });
  await db.meterReading.create({
    data: { propertyId, meter: 'GRID', reading: 1000n, byUserId: userId },
  });
  return { ...theirs, generatorId: generator.id, runId: generator.runs[0]?.id ?? '' };
}

async function bGeneratorUnchanged(db: Db, world: TenantWorld) {
  const gens = await db.generator.findMany({
    where: { propertyId: world.b1.id },
    include: { runs: true, fuelMovements: true },
  });
  expect(gens.map((g) => [g.name, g.runs.map((r) => r.stoppedAt), g.fuelMovements.length])).toEqual(
    [['Their generator', [null], 1]],
  );
  const readings = await db.meterReading.findMany({ where: { propertyId: world.b1.id } });
  expect(readings.map((r) => [r.meter, r.reading])).toEqual([['GRID', 1000n]]);
}

/** B's held lost-and-found item, past its keep-until date (T-133). */
async function bLostItem(db: Db, world: TenantWorld, propertyId: string) {
  const theirs = await bRoom(db, world, propertyId);
  const userId = (await db.user.findFirstOrThrow()).id;
  const item = await db.lostFoundItem.create({
    data: {
      propertyId,
      number: 1,
      description: 'Their phone',
      category: 'Phone',
      foundAt: new Date(),
      roomId: theirs.roomId,
      foundById: userId,
      storageLocation: 'Their office',
      custodianId: userId,
      keepUntil: new Date('2026-01-01T00:00:00Z'),
      events: { create: { kind: 'LOGGED', byUserId: userId } },
    },
  });
  return { ...theirs, itemId: item.id };
}

async function bLostItemUnchanged(db: Db, world: TenantWorld) {
  const items = await db.lostFoundItem.findMany({
    where: { propertyId: world.b1.id },
    include: { events: true },
  });
  expect(items.map((i) => [i.description, i.status, i.storageLocation, i.events.length])).toEqual([
    ['Their phone', 'HELD', 'Their office', 1],
  ]);
}

/** B's daily checklist with a pending run (T-134). */
async function bChecklist(db: Db, _world: TenantWorld, propertyId: string) {
  const userId = (await db.user.findFirstOrThrow()).id;
  const { organisationId } = await db.property.findUniqueOrThrow({ where: { id: propertyId } });
  const department = await db.department.create({
    data: { organisationId, propertyId, code: 'THEIRS', name: 'Their department' },
  });
  const checklist = await db.checklist.create({
    data: {
      propertyId,
      name: 'Their pool checks',
      departmentId: department.id,
      items: ['Chlorine level'],
      frequency: 'DAILY',
      dueTime: '09:00',
      createdById: userId,
    },
  });
  const run = await db.checklistRun.create({
    data: {
      propertyId,
      checklistId: checklist.id,
      dueOn: new Date('2030-01-01T00:00:00Z'),
      dueAt: new Date('2030-01-01T08:00:00Z'),
      items: ['Chlorine level'],
    },
  });
  return { checklistId: checklist.id, runId: run.id, departmentId: department.id };
}

async function bChecklistUnchanged(db: Db, world: TenantWorld) {
  const lists = await db.checklist.findMany({
    where: { propertyId: world.b1.id },
    include: { runs: true },
  });
  expect(lists.map((l) => [l.name, l.active, l.runs.map((r) => [r.status, r.problems])])).toEqual([
    ['Their pool checks', true, [['PENDING', 0]]],
  ]);
}

/** B's staff member with a certification and an emergency contact (T-136). */
async function bStaff(db: Db, _world: TenantWorld, propertyId: string) {
  const { organisationId } = await db.property.findUniqueOrThrow({ where: { id: propertyId } });
  const department = await db.department.create({
    data: { organisationId, propertyId, code: 'THEIRS', name: 'Their department' },
  });
  const staff = await db.staffProfile.create({
    data: {
      propertyId,
      number: 1,
      name: 'Their cook',
      departmentId: department.id,
      jobTitle: 'Cook',
      employmentType: 'MONTHLY_SALARY',
      startDate: new Date('2026-01-01T00:00:00Z'),
      emergencyName: 'Their contact',
      certifications: {
        create: { name: 'Their cert', expiresOn: new Date('2026-11-20T00:00:00Z') },
      },
    },
    include: { certifications: true },
  });
  return {
    staffId: staff.id,
    certificationId: staff.certifications[0]?.id ?? '',
    departmentId: department.id,
  };
}

async function bStaffUnchanged(db: Db, world: TenantWorld) {
  const staff = await db.staffProfile.findMany({
    where: { propertyId: world.b1.id },
    include: { certifications: true },
  });
  expect(
    staff.map((x) => [x.name, x.status, x.emergencyName, x.certifications.map((c) => c.name)]),
  ).toEqual([['Their cook', 'ACTIVE', 'Their contact', ['Their cert']]]);
}

/** B's duty, rota (a shift and a draft slot) and a pending leave request (T-137). */
async function bWork(db: Db, world: TenantWorld, propertyId: string) {
  const { organisationId } = await db.property.findUniqueOrThrow({ where: { id: propertyId } });
  const department = await db.department.create({
    data: { organisationId, propertyId, code: 'THEIRS', name: 'Their department' },
  });
  const staff = await db.staffProfile.create({
    data: {
      propertyId,
      number: 1,
      name: 'Their cook',
      userId: world.bStaff.id,
      departmentId: department.id,
      jobTitle: 'Cook',
      employmentType: 'MONTHLY_SALARY',
      startDate: new Date('2026-01-01T00:00:00Z'),
    },
  });
  const duty = await db.duty.create({
    data: { propertyId, staffId: staff.id, title: 'Their duty', weekdays: [1] },
  });
  const shift = await db.rotaPattern.create({
    data: {
      propertyId,
      departmentId: department.id,
      name: 'Their shift',
      startTime: '07:00',
      endTime: '15:00',
    },
  });
  const slot = await db.shiftAssignment.create({
    data: {
      propertyId,
      patternId: shift.id,
      staffId: staff.id,
      date: new Date('2026-11-17T00:00:00Z'),
    },
  });
  const leave = await db.leaveRequest.create({
    data: {
      propertyId,
      staffId: staff.id,
      type: 'ANNUAL',
      startDate: new Date('2026-11-17T00:00:00Z'),
      endDate: new Date('2026-11-18T00:00:00Z'),
    },
  });
  return {
    departmentId: department.id,
    staffId: staff.id,
    dutyId: duty.id,
    shiftId: shift.id,
    assignmentId: slot.id,
    leaveId: leave.id,
  };
}

async function bWorkUnchanged(db: Db, world: TenantWorld) {
  const where = { propertyId: world.b1.id };
  expect((await db.duty.findMany({ where })).map((d) => [d.title, d.active])).toEqual([
    ['Their duty', true],
  ]);
  expect((await db.rotaPattern.findMany({ where })).map((p) => [p.name, p.active])).toEqual([
    ['Their shift', true],
  ]);
  expect((await db.shiftAssignment.findMany({ where })).map((a) => a.status)).toEqual(['DRAFT']);
  expect((await db.leaveRequest.findMany({ where })).map((l) => l.status)).toEqual(['PENDING']);
}

/** B's attendance: a clocked-in profile and its settings with a network address (T-138). */
async function bAttendance(db: Db, world: TenantWorld, propertyId: string) {
  const staff = await db.staffProfile.create({
    data: {
      propertyId,
      number: 1,
      name: 'Their cook',
      userId: world.bStaff.id,
      jobTitle: 'Cook',
      employmentType: 'HOURLY',
      startDate: new Date('2026-01-01T00:00:00Z'),
    },
  });
  const event = await db.attendanceEvent.create({
    data: {
      propertyId,
      staffId: staff.id,
      kind: 'IN',
      at: new Date(),
      channel: 'PHONE',
      recordedById: world.bStaff.id,
    },
  });
  const address = '198.51.100.7';
  const property = await db.property.findUniqueOrThrow({ where: { id: propertyId } });
  await db.property.update({
    where: { id: propertyId },
    data: {
      settings: {
        ...((property.settings ?? {}) as object),
        attendance: {
          employmentTypes: ['HOURLY'],
          phoneAllowed: true,
          network: { enabled: true, addresses: [address] },
          location: { enabled: false, latitude: null, longitude: null, radiusMeters: 200 },
          privacyNotice: 'Their own privacy notice for location checks.',
        },
      } as never,
    },
  });
  return { staffId: staff.id, eventId: event.id, address };
}

async function bAttendanceUnchanged(db: Db, world: TenantWorld) {
  const events = await db.attendanceEvent.findMany({ where: { propertyId: world.b1.id } });
  expect(events.map((e) => e.kind)).toEqual(['IN']);
  const staff = await db.staffProfile.findFirstOrThrow({ where: { propertyId: world.b1.id } });
  expect(staff.locationConsentAt).toBeNull();
  const property = await db.property.findUniqueOrThrow({ where: { id: world.b1.id } });
  const settings = (property.settings ?? {}) as { attendance?: { network?: unknown } };
  expect(settings.attendance?.network).toEqual({ enabled: true, addresses: ['198.51.100.7'] });
}

/** B's draft timesheet and pending advance for November 2026 (T-139). */
async function bPayroll(db: Db, world: TenantWorld, propertyId: string) {
  const staff = await db.staffProfile.create({
    data: {
      propertyId,
      number: 1,
      name: 'Their cook',
      jobTitle: 'Cook',
      employmentType: 'HOURLY',
      startDate: new Date('2026-01-01T00:00:00Z'),
    },
  });
  const timesheet = await db.timesheet.create({
    data: {
      propertyId,
      staffId: staff.id,
      periodStart: new Date('2026-11-01T00:00:00Z'),
      periodEnd: new Date('2026-11-30T00:00:00Z'),
      workedMinutes: 600,
      overtimeMinutes: 120,
      daysWorked: 1,
      openClocks: 0,
      days: [{ date: '2026-11-02', minutes: 600, overtimeMinutes: 120 }],
      calculatedAt: new Date(),
      createdById: world.bStaff.id,
    },
  });
  const item = await db.payItem.create({
    data: {
      propertyId,
      staffId: staff.id,
      type: 'ADVANCE',
      amountMinor: 100000n,
      currency: 'NGN',
      payMonth: new Date('2026-11-01T00:00:00Z'),
      description: 'Their advance',
      requestedById: world.bStaff.id,
    },
  });
  return { staffId: staff.id, timesheetId: timesheet.id, payItemId: item.id };
}

async function bPayrollUnchanged(db: Db, world: TenantWorld) {
  const where = { propertyId: world.b1.id };
  expect((await db.timesheet.findMany({ where })).map((t) => [t.status, t.workedMinutes])).toEqual([
    ['DRAFT', 600],
  ]);
  expect((await db.payItem.findMany({ where })).map((p) => [p.type, p.status])).toEqual([
    ['ADVANCE', 'PENDING'],
  ]);
}

/** B's staff member with a filed contract, and B's own document retention (T-140). */
async function bStaffDocs(db: Db, world: TenantWorld, propertyId: string) {
  const organisationId = orgOf(world, propertyId);
  const staff = await db.staffProfile.create({
    data: {
      propertyId,
      number: 1,
      name: 'Their cook',
      jobTitle: 'Cook',
      employmentType: 'MONTHLY_SALARY',
      startDate: new Date('2026-01-01T00:00:00Z'),
    },
  });
  const file = await db.fileObject.create({
    data: {
      organisationId,
      propertyId,
      storageKey: `test/${crypto.randomUUID()}`,
      contentType: 'application/pdf',
      sizeBytes: 1000,
      scan: 'CLEAN',
      entityType: 'StaffDocument',
      uploadedById: world.bStaff.id,
    },
  });
  const doc = await db.staffDocument.create({
    data: {
      propertyId,
      staffId: staff.id,
      type: 'CONTRACT',
      title: 'Their contract',
      fileId: file.id,
      uploadedById: world.bStaff.id,
    },
  });
  const property = await db.property.findUniqueOrThrow({ where: { id: propertyId } });
  await db.property.update({
    where: { id: propertyId },
    data: {
      settings: {
        ...((property.settings ?? {}) as object),
        staffDocuments: {
          retention: { CONTRACT: 99, GUARANTOR: 72, ID: 12, CERTIFICATE: 24, OTHER: 24 },
        },
      } as never,
    },
  });
  // retention: B's own value, which must never show to A.
  return { staffId: staff.id, documentId: doc.id, fileId: file.id, retention: '99' };
}

async function bStaffDocsUnchanged(db: Db, world: TenantWorld) {
  const docs = await db.staffDocument.findMany({ where: { propertyId: world.b1.id } });
  expect(docs.map((d) => d.title)).toEqual(['Their contract']);
  expect(await db.fileObject.count({ where: { id: docs[0]?.fileId ?? '' } })).toBe(1);
  const property = await db.property.findUniqueOrThrow({ where: { id: world.b1.id } });
  const settings = (property.settings ?? {}) as {
    staffDocuments?: { retention?: { CONTRACT?: number } };
  };
  expect(settings.staffDocuments?.retention?.CONTRACT).toBe(99);
}

/** B's outlet with a section, an item on B's revenue code, and an option (T-141). */
async function bOutlet(db: Db, _world: TenantWorld, propertyId: string) {
  const code = await db.revenueCode.create({
    data: { propertyId, code: 'THEIR-FNB', name: 'Their F&B', group: 'FNB', taxRuleIds: [] },
  });
  const outlet = await db.outlet.create({
    data: { propertyId, code: 'THEIRS', name: 'Their bar' },
  });
  const category = await db.menuCategory.create({
    data: { propertyId, outletId: outlet.id, name: 'Their drinks' },
  });
  const item = await db.menuItem.create({
    data: {
      propertyId,
      categoryId: category.id,
      name: 'Their beer',
      priceMinor: 100000n,
      revenueCodeId: code.id,
    },
  });
  const modifier = await db.menuModifier.create({
    data: { propertyId, itemId: item.id, name: 'Their ice' },
  });
  return {
    outletId: outlet.id,
    categoryId: category.id,
    itemId: item.id,
    modifierId: modifier.id,
    revenueCodeId: code.id,
  };
}

async function bOutletUnchanged(db: Db, world: TenantWorld) {
  const where = { propertyId: world.b1.id };
  expect((await db.outlet.findMany({ where })).map((o) => [o.name, o.active])).toEqual([
    ['Their bar', true],
  ]);
  expect((await db.menuCategory.findMany({ where })).map((c) => c.name)).toEqual(['Their drinks']);
  expect(
    (await db.menuItem.findMany({ where })).map((i) => [i.name, i.priceMinor.toString(), i.active]),
  ).toEqual([['Their beer', '100000', true]]);
  expect((await db.menuModifier.findMany({ where })).map((m) => m.name)).toEqual(['Their ice']);
}

/** B's in-house guest and Pool bar, with an outlet shift and an open order on it (T-142). */
/** B's store: a unit, a location, an item with 5 on hand, a requisition and an open count. */
async function bStock(db: Db, world: TenantWorld, propertyId: string) {
  const unit = await db.stockUnit.create({ data: { propertyId, code: 'BTL', name: 'Bottle' } });
  const location = await db.stockLocation.create({
    data: { propertyId, code: 'THEIRS', name: 'Their store' },
  });
  const item = await db.stockItem.create({
    data: { propertyId, code: 'THEIR-GIN', name: 'Their gin', unitId: unit.id },
  });
  const movement = await db.stockMovement.create({
    data: {
      propertyId,
      itemId: item.id,
      locationId: location.id,
      kind: 'ADJUSTMENT',
      quantityMilli: 5000n,
      unitCostMinor: 0n,
      reason: 'Opening',
      byUserId: world.bStaff.id,
    },
  });
  const department = await db.department.create({
    data: { organisationId: world.orgB.id, propertyId, code: 'THEIRS', name: 'Their bar' },
  });
  const requisition = await db.requisition.create({
    data: { propertyId, number: 1, departmentId: department.id, requestedById: world.bStaff.id },
  });
  const line = await db.requisitionLine.create({
    data: { propertyId, requisitionId: requisition.id, itemId: item.id, quantityMilli: 2000n },
  });
  const stocktake = await db.stocktake.create({
    data: { propertyId, number: 1, locationId: location.id, startedById: world.bStaff.id },
  });
  await db.stocktakeLine.create({
    data: { propertyId, stocktakeId: stocktake.id, itemId: item.id },
  });
  return {
    unitId: unit.id,
    locationId: location.id,
    itemId: item.id,
    movementId: movement.id,
    departmentId: department.id,
    requisitionId: requisition.id,
    lineId: line.id,
    stocktakeId: stocktake.id,
  };
}

/** B's menu item with a recipe using their stock item, and their outlet's location (T-157). */
async function bRecipe(db: Db, world: TenantWorld, propertyId: string) {
  const menu = await bOutlet(db, world, propertyId);
  const unit = await db.stockUnit.create({ data: { propertyId, code: 'KG', name: 'Kilogram' } });
  const location = await db.stockLocation.create({
    data: { propertyId, code: 'KIT', name: 'Their kitchen' },
  });
  const stock = await db.stockItem.create({
    data: { propertyId, code: 'RICE', name: 'Their rice', unitId: unit.id },
  });
  await db.outlet.update({ where: { id: menu.outletId }, data: { stockLocationId: location.id } });
  await db.recipe.create({
    data: {
      propertyId,
      menuItemId: menu.itemId,
      updatedAt: new Date('2026-11-10T09:00:00Z'),
      updatedById: world.bStaff.id,
      lines: { create: { propertyId, stockItemId: stock.id, quantityMilli: 250n } },
    },
  });
  return { ...menu, menuItemId: menu.itemId, stockItemId: stock.id, stockLocationId: location.id };
}

async function bRecipeUnchanged(db: Db, world: TenantWorld) {
  const where = { propertyId: world.b1.id };
  expect((await db.recipeLine.findMany({ where })).map((l) => l.quantityMilli)).toEqual([250n]);
  expect((await db.outlet.findMany({ where })).map((o) => o.stockLocationId !== null)).toEqual([
    true,
  ]);
}

/** B's purchasing: a supplier, an approved order for 3 of their gin, and one receipt of 1. */
async function bPurchasing(db: Db, world: TenantWorld, propertyId: string) {
  const stock = await bStock(db, world, propertyId);
  const supplier = await db.supplier.create({ data: { propertyId, name: 'Their supplier' } });
  const order = await db.purchaseOrder.create({
    data: {
      propertyId,
      number: 1,
      supplierId: supplier.id,
      status: 'PARTIAL',
      totalMinor: 300n,
      createdById: world.bStaff.id,
      approvedById: world.bStaff.id,
      approvedAt: new Date(),
    },
  });
  const line = await db.purchaseOrderLine.create({
    data: {
      propertyId,
      purchaseOrderId: order.id,
      itemId: stock.itemId,
      quantityMilli: 3000n,
      unitPriceMinor: 100n,
      receivedMilli: 1000n,
    },
  });
  const receipt = await db.goodsReceipt.create({
    data: {
      propertyId,
      number: 1,
      purchaseOrderId: order.id,
      locationId: stock.locationId,
      receivedById: world.bStaff.id,
    },
  });
  return {
    ...stock,
    supplierId: supplier.id,
    orderId: order.id,
    orderLineId: line.id,
    receiptId: receipt.id,
  };
}

async function bPurchasingUnchanged(db: Db, world: TenantWorld) {
  const where = { propertyId: world.b1.id };
  expect((await db.supplier.findMany({ where })).map((x) => [x.name, x.active])).toEqual([
    ['Their supplier', true],
  ]);
  expect(
    (await db.purchaseOrder.findMany({ where, include: { lines: true } })).map((o) => [
      o.status,
      o.lines.map((l) => [l.quantityMilli, l.receivedMilli]),
    ]),
  ).toEqual([['PARTIAL', [[3000n, 1000n]]]]);
  expect(await db.goodsReceipt.count({ where })).toBe(1);
  expect(await db.stockMovement.count({ where: { ...where, kind: 'RECEIPT' } })).toBe(0);
}

/** B's books: a category, a float with ₦10 in it, and one expense of ₦4 paid from it. */
async function bExpenses(db: Db, world: TenantWorld, propertyId: string) {
  const category = await db.expenseCategory.create({
    data: { propertyId, code: 'THEIRS', name: 'Their category' },
  });
  const department = await db.department.create({
    data: { organisationId: world.orgB.id, propertyId, code: 'THEIRS', name: 'Their dept' },
  });
  const float = await db.pettyCashFloat.create({ data: { propertyId, name: 'Their float' } });
  await db.pettyCashTopUp.create({
    data: { propertyId, floatId: float.id, amountMinor: 1000n, byUserId: world.bStaff.id },
  });
  const expense = await db.expense.create({
    data: {
      propertyId,
      number: 1,
      spentOn: new Date('2026-11-01T00:00:00Z'),
      categoryId: category.id,
      departmentId: department.id,
      payee: 'Their payee',
      description: 'Their expense',
      amountMinor: 400n,
      paidFrom: 'PETTY_CASH',
      floatId: float.id,
      recordedById: world.bStaff.id,
    },
  });
  return {
    categoryId: category.id,
    departmentId: department.id,
    floatId: float.id,
    expenseId: expense.id,
  };
}

async function bExpensesUnchanged(db: Db, world: TenantWorld) {
  const where = { propertyId: world.b1.id };
  expect((await db.expenseCategory.findMany({ where })).map((c) => [c.name, c.active])).toEqual([
    ['Their category', true],
  ]);
  expect(
    (await db.pettyCashFloat.findMany({ where })).map((f) => [f.name, f.active, f.custodianId]),
  ).toEqual([['Their float', true, null]]);
  expect((await db.pettyCashTopUp.findMany({ where })).map((t) => t.amountMinor)).toEqual([1000n]);
  expect((await db.expense.findMany({ where })).map((e) => [e.amountMinor, e.voidedAt])).toEqual([
    [400n, null],
  ]);
}

/** B's accounting: a mapped account and one kept export. */
async function bAccounting(db: Db, world: TenantWorld, propertyId: string) {
  const mapping = await db.accountingMapping.create({
    data: { propertyId, kind: 'CONTROL', key: 'GUEST_LEDGER', accountCode: '1200' },
  });
  const exported = await db.accountingExport.create({
    data: {
      propertyId,
      number: 1,
      fromDate: new Date('2026-11-01T00:00:00Z'),
      toDate: new Date('2026-11-01T00:00:00Z'),
      journalCount: 0,
      lineCount: 0,
      debitTotalMinor: 0n,
      content: 'Journal',
      sha256: 'theirs',
      createdById: world.bStaff.id,
    },
  });
  return { mappingId: mapping.id, exportId: exported.id };
}

async function bAccountingUnchanged(db: Db, world: TenantWorld) {
  const where = { propertyId: world.b1.id };
  expect((await db.accountingMapping.findMany({ where })).map((m) => m.accountCode)).toEqual([
    '1200',
  ]);
  expect(await db.accountingExport.count({ where })).toBe(1);
}

/** B's channel connection, active, with its room type mapped. */
async function bChannel(db: Db, world: TenantWorld, propertyId: string) {
  const plan = await bPlan(db, world, propertyId);
  const connection = await db.channelConnection.create({
    data: {
      propertyId,
      provider: 'CHANNEX',
      externalPropertyId: 'their-property',
      status: 'ACTIVE',
      connectedById: world.bStaff.id,
      fullSyncPending: false,
    },
  });
  await db.channelMapping.create({
    data: {
      propertyId,
      connectionId: connection.id,
      kind: 'ROOM_TYPE',
      roomTypeId: plan.roomTypeId,
      externalId: 'their-room-type',
    },
  });
  return { ...plan, connectionId: connection.id };
}

async function bChannelUnchanged(db: Db, world: TenantWorld) {
  const where = { propertyId: world.b1.id };
  expect(
    (await db.channelConnection.findMany({ where })).map((c) => [c.status, c.fullSyncPending]),
  ).toEqual([['ACTIVE', false]]);
  expect(await db.channelMapping.count({ where })).toBe(1);
  expect(await db.channelSyncLog.count({ where })).toBe(0);
}

/** B's connection with an OTA booking held for their staff (T-153). */
async function bChannelBooking(db: Db, world: TenantWorld, propertyId: string) {
  const channel = await bChannel(db, world, propertyId);
  const held = await db.channelBookingRevision.create({
    data: {
      propertyId,
      connectionId: channel.connectionId,
      externalId: 'their-revision',
      externalBookingId: 'their-booking',
      kind: 'NEW',
      guestName: 'Their guest',
      payload: { booking_id: 'their-booking', status: 'new', currency: 'USD' },
      receivedAt: new Date('2026-11-10T08:00:00Z'),
      outcome: 'HELD',
      holdReason: 'CURRENCY',
      message: 'The booking is in USD',
    },
  });
  return { ...channel, channelBookingId: held.id };
}

async function bChannelBookingUnchanged(db: Db, world: TenantWorld) {
  await bChannelUnchanged(db, world);
  const where = { propertyId: world.b1.id };
  expect(
    (await db.channelBookingRevision.findMany({ where })).map((r) => [r.outcome, r.message]),
  ).toEqual([['HELD', 'The booking is in USD']]);
  expect(await db.reservation.count({ where: { ...where, source: 'OTA_CHANNEL' } })).toBe(0);
}

/** B's guest reviewed their stay and waits for a reply; B's review settings are on (T-155). */
async function bReview(db: Db, world: TenantWorld, propertyId: string) {
  const theirs = await bReservation(db, world, propertyId);
  await db.guest.update({ where: { id: theirs.guestId }, data: { email: 'b-guest@example.test' } });
  await db.property.update({
    where: { id: propertyId },
    data: {
      settings: { reviews: { enabled: true, delayHours: 5, publicReviewUrl: null } } as never,
    },
  });
  const review = await db.guestReview.create({
    data: {
      id: randomUUID(),
      propertyId,
      reservationId: theirs.reservationId,
      stayId: theirs.stayId,
      guestId: theirs.guestId,
      tokenHash: 'their-review-token-hash',
      channel: 'EMAIL',
      requestedAt: new Date('2026-11-10T08:00:00Z'),
      expiresAt: new Date('2026-12-10T08:00:00Z'),
      rating: 3,
      comment: 'Their comment',
      submittedAt: new Date('2026-11-10T09:00:00Z'),
      draft: 'Their draft',
    },
  });
  return { ...theirs, reviewId: review.id };
}

async function bReviewUnchanged(db: Db, world: TenantWorld) {
  const where = { propertyId: world.b1.id };
  expect(
    (await db.guestReview.findMany({ where })).map((r) => [r.draft, r.reply, r.repliedAt]),
  ).toEqual([['Their draft', null, null]]);
  expect(await db.notificationDelivery.count({ where: { templateCode: 'REVIEW_REPLY' } })).toBe(0);
  const property = await db.property.findUniqueOrThrow({ where: { id: world.b1.id } });
  expect((property.settings as { reviews: { delayHours: number } }).reviews.delayHours).toBe(5);
}

/** B's settled folio, with e-invoicing on and its TIN set (T-160). */
async function bEinvoice(db: Db, world: TenantWorld, propertyId: string) {
  const theirs = await bFolio(db, world, propertyId);
  await db.folio.update({ where: { id: theirs.folioId }, data: { status: 'SETTLED' } });
  await db.property.update({
    where: { id: propertyId },
    data: {
      taxRegistration: { tin: '99999999-0001' },
      settings: { einvoicing: { enabled: true, enabledAt: '2000-01-01T00:00:00.000Z' } } as never,
    },
  });
  return { ...theirs, windowNumber: '1' };
}

async function bEinvoiceUnchanged(db: Db, world: TenantWorld) {
  expect(await db.einvoiceSubmission.count({ where: { propertyId: world.b1.id } })).toBe(0);
  const property = await db.property.findUniqueOrThrow({ where: { id: world.b1.id } });
  expect((property.settings as { einvoicing: { enabled: boolean } }).einvoicing.enabled).toBe(true);
}

/** B's partner API key, webhook endpoint and a failed delivery (T-166). */
async function bIntegrations(db: Db, world: TenantWorld, propertyId: string) {
  const key = await db.apiKey.create({
    data: {
      propertyId,
      name: 'Their key',
      prefix: 'hk_theirs0',
      tokenHash: crypto.randomUUID(),
      scopes: ['reservations:read'],
      createdById: world.bStaff.id,
    },
  });
  const endpoint = await db.webhookEndpoint.create({
    data: {
      propertyId,
      url: 'https://theirs.example.test/hooks',
      events: ['reservation.created'],
      secretEnc: Buffer.alloc(40, 1),
      createdById: world.bStaff.id,
    },
  });
  const delivery = await db.webhookDelivery.create({
    data: {
      propertyId,
      endpointId: endpoint.id,
      eventType: 'reservation.created',
      body: '{}',
      status: 'FAILED',
      attempts: 7,
    },
  });
  return { apiKeyId: key.id, endpointId: endpoint.id, deliveryId: delivery.id };
}

async function bIntegrationsUnchanged(db: Db, world: TenantWorld) {
  const where = { propertyId: world.b1.id };
  expect((await db.apiKey.findMany({ where })).map((k) => [k.name, k.revokedAt])).toEqual([
    ['Their key', null],
  ]);
  expect(
    (await db.webhookEndpoint.findMany({ where })).map((e) => [e.url, e.events, e.active]),
  ).toEqual([['https://theirs.example.test/hooks', ['reservation.created'], true]]);
  expect((await db.webhookDelivery.findMany({ where })).map((d) => [d.status, d.attempts])).toEqual(
    [['FAILED', 7]],
  );
}

/** B's support request (T-170): opened by B's staff, one message. */
async function bSupport(db: Db, world: TenantWorld, propertyId: string) {
  const organisationId = orgOf(world, propertyId);
  const ticket = await db.supportTicket.create({
    data: {
      organisationId,
      propertyId,
      openedById: world.bStaff.id,
      subject: 'Their request',
      urgency: 'NORMAL',
    },
  });
  await db.supportMessage.create({
    data: {
      organisationId,
      ticketId: ticket.id,
      authorId: world.bStaff.id,
      fromPlatform: false,
      body: 'Their message',
    },
  });
  return { ticketId: ticket.id };
}

async function bSupportUnchanged(db: Db, world: TenantWorld) {
  const where = { organisationId: world.orgB.id };
  expect(
    (await db.supportTicket.findMany({ where })).map((t) => [t.subject, t.status, t.resolvedAt]),
  ).toEqual([['Their request', 'OPEN', null]]);
  expect((await db.supportMessage.findMany({ where })).map((m) => m.body)).toEqual([
    'Their message',
  ]);
}

/** B's training session with the support team (T-171). */
async function bTraining(db: Db, world: TenantWorld, propertyId: string) {
  const organisationId = orgOf(world, propertyId);
  const role = await makeRole(db, organisationId);
  const session = await db.trainingSession.create({
    data: {
      organisationId,
      propertyId,
      roleId: role.id,
      trainerId: world.bStaff.id,
      scheduledAt: new Date('2026-11-20T09:00:00Z'),
    },
  });
  return { sessionId: session.id };
}

/** B's group: a closed November day kept, and a cedi rate in its own group currency (T-161). */
async function bGroup(db: Db, world: TenantWorld, propertyId: string) {
  const organisationId = orgOf(world, propertyId);
  await db.organisation.update({ where: { id: organisationId }, data: { groupCurrency: 'GHS' } });
  await db.nightAuditRun.create({
    data: {
      propertyId,
      businessDate: new Date('2026-11-01'),
      status: 'COMPLETED',
      currentStep: 10,
      finishedAt: new Date('2026-11-01T23:00:00Z'),
      summary: { reports: { flash: { roomsSold: 9, roomsAvailable: 9 } } } as never,
    },
  });
  const owner = await db.user.findFirstOrThrow({ where: { id: world.aStaff.id } });
  await db.groupExchangeRate.create({
    data: {
      organisationId,
      fromCurrency: 'NGN',
      toCurrency: 'GHS',
      month: new Date('2026-11-01'),
      rateMicros: 9_000n,
      setById: owner.id,
      setAt: new Date('2026-11-01T09:00:00Z'),
    },
  });
  return { propertyId };
}

async function bGroupUnchanged(db: Db, world: TenantWorld) {
  const org = await db.organisation.findUniqueOrThrow({ where: { id: orgOf(world, world.b1.id) } });
  expect(org.groupCurrency).toBe('GHS');
  const rates = await db.groupExchangeRate.findMany({ where: { organisationId: org.id } });
  expect(rates.map((r) => [r.fromCurrency, r.rateMicros])).toEqual([['NGN', 9_000n]]);
}

async function bStockUnchanged(db: Db, world: TenantWorld) {
  const where = { propertyId: world.b1.id };
  expect((await db.stockItem.findMany({ where })).map((i) => [i.name, i.active])).toEqual([
    ['Their gin', true],
  ]);
  expect((await db.stockUnit.findMany({ where })).map((u) => [u.name, u.active])).toEqual([
    ['Bottle', true],
  ]);
  expect((await db.stockLocation.findMany({ where })).map((l) => [l.name, l.active])).toEqual([
    ['Their store', true],
  ]);
  expect(
    (await db.stockMovement.findMany({ where })).map((m) => [m.kind, m.quantityMilli]),
  ).toEqual([['ADJUSTMENT', 5000n]]);
  expect(
    (await db.requisition.findMany({ where, include: { lines: true } })).map((r) => [
      r.status,
      r.lines.map((l) => l.issuedMilli),
    ]),
  ).toEqual([['SUBMITTED', [0n]]]);
  expect(
    (await db.stocktake.findMany({ where, include: { lines: true } })).map((t) => [
      t.status,
      t.lines.map((l) => l.countedMilli),
    ]),
  ).toEqual([['COUNTING', [null]]]);
}

async function bPosOrder(db: Db, world: TenantWorld, propertyId: string) {
  const stay = await bFolio(db, world, propertyId);
  const menu = await bOutlet(db, world, propertyId);
  const shift = await db.cashierShift.create({
    data: { propertyId, userId: world.bStaff.id, outletId: menu.outletId },
  });
  const order = await db.posOrder.create({
    data: {
      propertyId,
      outletId: menu.outletId,
      shiftId: shift.id,
      number: 'P09999',
      label: 'Their table',
      openedById: world.bStaff.id,
    },
  });
  const line = await db.posOrderLine.create({
    data: {
      propertyId,
      orderId: order.id,
      menuItemId: menu.itemId,
      name: 'Their beer',
      quantity: 1,
      unitPriceMinor: 100000n,
      revenueCodeId: menu.revenueCodeId,
      addedById: world.bStaff.id,
    },
  });
  await db.property.update({
    where: { id: propertyId },
    data: { settings: { pos: { roomChargeLimitMinor: '5000' } } },
  });
  return {
    ...menu,
    stayId: stay.stayId,
    folioId: stay.folioId,
    shiftId: shift.id,
    orderId: order.id,
    lineId: line.id,
  };
}

/** B's order with a kitchen item sent to their Kitchen display, waiting (T-156). */
async function bKitchen(db: Db, world: TenantWorld, propertyId: string) {
  const theirs = await bPosOrder(db, world, propertyId);
  await db.menuCategory.updateMany({ where: { propertyId }, data: { kitchenStation: 'Kitchen' } });
  const ticket = await db.kitchenTicket.create({
    data: {
      propertyId,
      outletId: theirs.outletId,
      orderId: theirs.orderId,
      station: 'Kitchen',
      number: 1,
      sentAt: new Date('2026-11-10T09:00:00Z'),
      sentById: world.bStaff.id,
    },
  });
  // A second item, for the kitchen and not sent yet.
  await db.posOrderLine.create({
    data: {
      propertyId,
      orderId: theirs.orderId,
      menuItemId: theirs.itemId,
      name: 'Their suya',
      quantity: 1,
      unitPriceMinor: 100000n,
      revenueCodeId: theirs.revenueCodeId,
      addedById: world.bStaff.id,
      kitchenStation: 'Kitchen',
    },
  });
  await db.posOrderLine.updateMany({
    where: { id: theirs.lineId },
    data: { kitchenStation: 'Kitchen', kitchenTicketId: ticket.id },
  });
  return { ...theirs, ticketId: ticket.id };
}

async function bKitchenUnchanged(db: Db, world: TenantWorld) {
  const where = { propertyId: world.b1.id };
  expect((await db.kitchenTicket.findMany({ where })).map((t) => [t.number, t.bumpedAt])).toEqual([
    [1, null],
  ]);
  // Their unsent item is still unsent.
  expect(
    await db.posOrderLine.count({
      where: { ...where, kitchenStation: 'Kitchen', kitchenTicketId: null },
    }),
  ).toBe(1);
}

async function bPosOrderUnchanged(db: Db, world: TenantWorld) {
  const where = { propertyId: world.b1.id };
  const orders = await db.posOrder.findMany({ where, include: { lines: true } });
  expect(orders.map((o) => [o.label, o.status, o.lines.length])).toEqual([
    ['Their table', 'OPEN', 1],
  ]);
  // M8-04: their item is neither voided nor discounted, and nothing waits for approval.
  expect(orders[0]?.lines.map((l) => [l.voidedAt, l.discountMinor])).toEqual([[null, null]]);
  expect(await db.approvalRequest.count({ where: { action: { startsWith: 'pos.' } } })).toBe(0);
  const shifts = await db.cashierShift.findMany({ where });
  expect(shifts.map((s) => [s.status, s.outletId !== null])).toEqual([['OPEN', true]]);
  expect(await db.folioLine.count({ where: { ...where, sourceType: 'POS_ORDER' } })).toBe(0);
  const property = await db.property.findUniqueOrThrow({ where: { id: world.b1.id } });
  expect(property.settings).toEqual({ pos: { roomChargeLimitMinor: '5000' } });
  await bOutletUnchanged(db, world);
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

async function bInvoiceUntouched(db: Db, world: TenantWorld) {
  const invoices = await db.platformInvoice.findMany({ where: { organisationId: world.orgB.id } });
  expect(invoices.map((i) => i.status)).toEqual(['ISSUED']);
  expect(await db.platformInvoiceCheckout.count()).toBe(0);
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
  addSuggestedTaxes: { seed: bTaxRule, creates: true, untouched: bTaxesUnchanged },
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
  // One plan in several properties (T-162): naming B's property is refused.
  changeGroupRates: {
    seed: async (db, world, propertyId) => ({
      ...(await bPlan(db, world, propertyId)),
      propertyId,
    }),
    creates: true,
    body: (theirs) => ({
      propertyIds: [theirs['propertyId']],
      ratePlanCode: 'BAR',
      from: '2099-01-01',
      to: '2099-01-02',
      price: { mode: 'SET', amountMinor: '5000000' },
    }),
    untouched: bRatesUnchanged,
  },
  // Price suggestions (T-149)
  listPriceSuggestions: {
    seed: bPlan,
    listIds: (body) =>
      (body as { data: { ratePlan: { id: string }; roomType: { id: string } }[] }).data.flatMap(
        (x) => [x.ratePlan.id, x.roomType.id],
      ),
  },
  acceptPriceSuggestions: {
    seed: bPlan,
    creates: true,
    body: (theirs) => ({
      items: [
        {
          ratePlanId: theirs['ratePlanId'],
          roomTypeId: theirs['roomTypeId'],
          date: '2099-01-01',
          amountMinor: '5000000',
        },
      ],
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
  // ID scan (T-150): B's stay, with A's own file ID made up; nothing is read or counted.
  scanIdDocument: {
    seed: bReservation,
    body: () => ({ fileId: '00000000-0000-4000-8000-000000000001' }),
    untouched: async (db, w) => {
      expect(await db.usageCounter.count()).toBe(0);
      await bReservationUnchanged(db, w);
    },
  },
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
  getOnlineCheckIn: {
    seed: bReservation,
  },
  sendGuestLink: {
    seed: bReservation,
    body: () => ({}),
    untouched: async (db) => {
      expect(await db.guestLink.count()).toBe(0);
    },
  },
  listSpaces: {
    seed: bSpace,
    listIds: (body) => (body as { data: { id: string }[] }).data.map((s) => s.id),
  },
  createSpace: {
    seed: bSpace,
    creates: true,
    body: () => SPACE_BODY,
    untouched: bSpaceUnchanged,
  },
  updateSpace: { seed: bSpace, body: () => SPACE_BODY, untouched: bSpaceUnchanged },
  getSpaceAvailability: {
    seed: bSpace,
    listIds: (body) => (body as { data: { space: { id: string } }[] }).data.map((s) => s.space.id),
    query: () => ({ startsAt: '2099-06-01T10:00:00Z', endsAt: '2099-06-01T12:00:00Z' }),
  },
  listEventEnquiries: {
    seed: bEventBooking,
    listIds: (body) => (body as { data: { id: string }[] }).data.map((e) => e.id),
  },
  createEventEnquiry: {
    seed: bEventBooking,
    creates: true,
    body: () => ENQUIRY_BODY,
    untouched: bEventUnchanged,
  },
  updateEventEnquiry: {
    seed: bEventBooking,
    body: () => ({ ...ENQUIRY_BODY, status: 'OPEN' }),
    untouched: bEventUnchanged,
  },
  listEventBookings: {
    seed: bEventBooking,
    listIds: (body) => (body as { data: { id: string }[] }).data.map((b) => b.id),
    query: () => ({ from: '2099-01-01T00:00:00Z', to: '2099-12-31T00:00:00Z' }),
  },
  createEventBooking: {
    seed: bEventBooking,
    creates: true,
    body: (theirs) => ({
      spaceId: theirs['spaceId'],
      layoutId: theirs['layoutId'],
      title: 'Leak',
      startsAt: '2099-07-01T10:00:00Z',
      endsAt: '2099-07-01T12:00:00Z',
      expectedGuests: 1,
      holdUntil: '2099-06-30T10:00:00Z',
    }),
    untouched: bEventUnchanged,
  },
  releaseEventHold: { seed: bEventBooking, body: () => ({}), untouched: bEventUnchanged },
  getEventQuotes: { seed: bEventBooking },
  createEventQuoteVersion: {
    seed: bEventBooking,
    body: () => ({
      lines: [{ kind: 'SPACE', description: 'Leak', quantity: 1, unitMinor: '100' }],
    }),
    untouched: bEventUnchanged,
  },
  getEventContract: { seed: bEventBooking },
  getEventContractPdf: { seed: bEventBooking },
  issueEventContract: {
    seed: bEventBooking,
    body: () => ({
      clientName: 'Leak',
      clientEmail: 'leak@example.com',
      clientPhone: '+2348011111111',
      terms: 'Leak',
      schedule: [{ kind: 'DEPOSIT', dueDate: '2099-01-01', amountMinor: '100' }],
    }),
    untouched: bEventUnchanged,
  },
  signEventContract: {
    seed: bEventBooking,
    body: () => ({ signedByName: 'Leak', signedOn: '2026-01-01' }),
    untouched: bEventUnchanged,
  },
  confirmEventBooking: {
    seed: bEventBooking,
    body: () => ({ override: true, reason: 'Leak' }),
    untouched: bEventUnchanged,
  },
  getEventBrief: { seed: bEventBooking },
  saveEventBrief: {
    seed: bEventBooking,
    body: () => ({ sections: [] }),
    untouched: bEventUnchanged,
  },
  getEventBriefPdf: { seed: bEventBooking },
  getEventCloseOut: { seed: bEventBooking },
  inspectEvent: {
    seed: bEventBooking,
    body: () => ({ notes: 'Leak' }),
    untouched: bEventUnchanged,
  },
  getEventInvoicePdf: { seed: bEventBooking },
  closeEvent: { seed: bEventBooking, body: () => ({}), untouched: bEventUnchanged },
  getEventCancellation: { seed: bEventBooking },
  listGroupBlocks: {
    seed: bGroupBlock,
    listIds: (body) => (body as { data: { id: string }[] }).data.map((b) => b.id),
  },
  createGroupBlock: {
    seed: bGroupBlock,
    creates: true,
    body: (theirs) => ({
      code: 'LEAK',
      name: 'Leak',
      ratePlanId: theirs['ratePlanId'],
      arrival: '2099-07-01',
      departure: '2099-07-02',
      releaseDate: '2099-06-01',
      rooms: [{ roomTypeId: theirs['roomTypeId'], count: 1 }],
    }),
    untouched: bGroupBlocksUnchanged,
  },
  getGroupBlock: { seed: bGroupBlock },
  updateGroupBlock: {
    seed: bGroupBlock,
    body: (theirs) => ({
      code: 'LEAK',
      name: 'Leak',
      ratePlanId: theirs['ratePlanId'],
      releaseDate: '2099-06-01',
      rooms: [{ roomTypeId: theirs['roomTypeId'], count: 0 }],
    }),
    untouched: bGroupBlocksUnchanged,
  },
  releaseGroupBlock: {
    seed: bGroupBlock,
    body: () => ({ cancel: true }),
    untouched: bGroupBlocksUnchanged,
  },
  bookGroupBlockRoomingList: {
    seed: bGroupBlock,
    body: (theirs) => ({
      rooms: [{ firstName: 'Leak', lastName: 'Leak', roomTypeId: theirs['roomTypeId'] }],
    }),
    untouched: bGroupBlocksUnchanged,
  },
  listAllotments: {
    seed: bAllotment,
    listIds: (body) => (body as { data: { id: string }[] }).data.map((b) => b.id),
  },
  createAllotment: {
    seed: bAllotment,
    creates: true,
    body: (theirs) => ({
      code: 'LEAK',
      name: 'Leak',
      ratePlanId: theirs['ratePlanId'],
      arrival: '2099-07-01',
      departure: '2099-07-02',
      companyId: theirs['agentId'],
      releaseDays: 7,
      rooms: [{ roomTypeId: theirs['roomTypeId'], count: 1 }],
    }),
    untouched: bGroupBlocksUnchanged,
  },
  getAllotment: { seed: bAllotment },
  updateAllotment: {
    seed: bAllotment,
    body: (theirs) => ({
      code: 'LEAK',
      name: 'Leak',
      ratePlanId: theirs['ratePlanId'],
      companyId: theirs['agentId'],
      releaseDays: 7,
      rooms: [{ roomTypeId: theirs['roomTypeId'], count: 0 }],
    }),
    untouched: bGroupBlocksUnchanged,
  },
  releaseAllotment: {
    seed: bAllotment,
    body: () => ({ cancel: true }),
    untouched: bGroupBlocksUnchanged,
  },
  bookAllotmentRoomingList: {
    seed: bAllotment,
    body: (theirs) => ({
      rooms: [{ firstName: 'Leak', lastName: 'Leak', roomTypeId: theirs['roomTypeId'] }],
    }),
    untouched: bGroupBlocksUnchanged,
  },
  listArAccounts: {
    seed: bArAccount,
    listIds: (body) => (body as { data: { id: string }[] }).data.map((a) => a.id),
  },
  createArAccount: {
    seed: bArAccount,
    creates: true,
    body: () => ({ companyId: crypto.randomUUID(), creditLimitMinor: '1' }),
    untouched: bArUnchanged,
  },
  getArAccount: { seed: bArAccount },
  // Corporate accounts at group level (T-163)
  listGroupCompanies: {
    seed: bGroupCompany,
    listIds: (body) => (body as { data: { companyId: string }[] }).data.map((c) => c.companyId),
  },
  getGroupCompany: { seed: bGroupCompany },
  updateArAccount: {
    seed: bArAccount,
    body: () => ({ creditLimitMinor: '9', termsDays: 1, status: 'CLOSED' }),
    untouched: bArUnchanged,
  },
  transferToAr: {
    seed: bArAccount,
    body: (theirs) => ({ folioId: theirs['folioId'], amountMinor: '100' }),
    untouched: bArUnchanged,
  },
  recordArPayment: {
    seed: bArAccount,
    body: () => ({ method: 'CASH', amountMinor: '100', receivedOn: '2026-11-01' }),
    untouched: bArUnchanged,
  },
  allocateArPayment: { seed: bArAccount, body: () => ({}), untouched: bArUnchanged },
  getArStatement: {
    seed: bArAccount,
    query: () => ({ from: '2026-11-01', to: '2026-11-30' }),
  },
  getArStatementPdf: {
    seed: bArAccount,
    query: () => ({ from: '2026-11-01', to: '2026-11-30' }),
  },
  sendArStatement: {
    seed: bArAccount,
    body: () => ({ from: '2026-11-01', to: '2026-11-30' }),
    untouched: bArUnchanged,
  },
  getArAgeing: {
    seed: bArAccount,
    listIds: (body) =>
      (body as { accounts: { accountId: string }[] }).accounts.map((a) => a.accountId),
  },
  listCommissions: {
    seed: bCommission,
    listIds: (body) => (body as { data: { id: string }[] }).data.map((c) => c.id),
  },
  calculateCommissions: {
    seed: bCommission,
    // Works over A's own stays: it must leave B's commission alone.
    creates: true,
    body: () => ({ from: '2026-01-01', to: '2026-01-31' }),
    untouched: bCommissionUnchanged,
  },
  settleCommissions: {
    seed: bCommission,
    body: (theirs) => ({
      commissionIds: [theirs['commissionId']],
      as: 'OFFSET',
      settledOn: '2026-01-20',
    }),
    untouched: bCommissionUnchanged,
  },
  importBankStatement: {
    seed: bBankLine,
    // Imports to A's own property and auto-matches A's own lines only.
    creates: true,
    body: () => ({
      bankAccount: 'Ours',
      lines: [{ postedOn: '2026-01-05', description: 'THEIR RECEIPT', amountMinor: '500' }],
    }),
    untouched: bBankLineUnchanged,
  },
  listBankStatementLines: {
    seed: bBankLine,
    query: () => ({ from: '2026-11-01', to: '2026-11-30' }),
    listIds: (body) => (body as { data: { id: string }[] }).data.map((l) => l.id),
  },
  listBookEntries: {
    seed: bBankLine,
    query: () => ({ from: '2026-11-01', to: '2026-11-30' }),
    listIds: (body) => (body as { data: { id: string }[] }).data.map((e) => e.id),
  },
  autoMatchBankLines: {
    seed: bBankLine,
    creates: true,
    body: () => ({}),
    untouched: bBankLineUnchanged,
  },
  matchBankLine: {
    seed: bBankLine,
    body: (theirs) => ({ arPaymentIds: [theirs['paymentId']] }),
    untouched: bBankLineUnchanged,
  },
  explainBankLine: {
    seed: bBankLine,
    body: () => ({ note: 'Not yours' }),
    untouched: bBankLineUnchanged,
  },
  unmatchBankLine: {
    seed: bBankLine,
    body: () => ({ reason: 'Not yours' }),
    untouched: bBankLineUnchanged,
  },
  listServices: {
    seed: bService,
    listIds: (body) => (body as { data: { id: string }[] }).data.map((s) => s.id),
  },
  createService: {
    seed: bService,
    creates: true,
    body: () => ({
      code: 'LEAK',
      name: 'Leak',
      category: 'SPA',
      priceMinor: '100',
      durationMinutes: 60,
      revenueCode: 'SVCB',
    }),
    untouched: bServiceUnchanged,
  },
  updateService: {
    seed: bService,
    body: () => ({
      code: 'LEAK',
      name: 'Leak',
      category: 'SPA',
      priceMinor: '100',
      durationMinutes: 60,
    }),
    untouched: bServiceUnchanged,
  },
  getServiceSlots: { seed: bService, query: () => ({ date: '2099-06-01' }) },
  listServiceBookings: {
    seed: bService,
    query: () => ({ date: '2099-06-01' }),
    listIds: (body) => (body as { data: { id: string }[] }).data.map((b) => b.id),
  },
  createServiceBooking: {
    seed: bService,
    creates: true,
    body: (theirs) => ({
      serviceId: theirs['serviceId'],
      stayId: theirs['stayId'],
      guestName: 'Leak',
      startsAt: '2099-06-01T12:00:00Z',
    }),
    untouched: bServiceUnchanged,
  },
  completeServiceBooking: { seed: bService, body: () => ({}), untouched: bServiceUnchanged },
  cancelServiceBooking: { seed: bService, body: () => ({}), untouched: bServiceUnchanged },
  getEventSettings: {
    seed: bEventSettings,
    listIds: (body) => [
      String((body as { cancellation: { noticeHours: number } }).cancellation.noticeHours),
    ],
  },
  updateEventSettings: {
    seed: bEventSettings,
    creates: true,
    body: () => ({
      cancellation: { noticeHours: 1, earlyHours: 1, earlyKeepBps: 1, laterKeepBps: 1 },
    }),
    untouched: bEventSettingsUnchanged,
  },
  cancelEvent: {
    seed: bEventBooking,
    body: () => ({ reason: 'Leak' }),
    untouched: bEventUnchanged,
  },
  listMessageThreads: {
    seed: bThread,
    listIds: (body) => (body as { data: { id: string }[] }).data.map((t) => t.id),
  },
  getMessageThread: { seed: bThread },
  sendThreadMessage: { seed: bThread, body: () => ({ body: 'Leak' }), untouched: bThreadUnchanged },
  sendThreadFollowUp: { seed: bThread, body: () => ({}), untouched: bThreadUnchanged },
  setThreadAssistant: {
    seed: bThread,
    body: () => ({ active: false }),
    untouched: bThreadUnchanged,
  },
  markThreadRead: { seed: bThread, body: () => ({}), untouched: bThreadUnchanged },
  // Reads only, from the caller's own hotel: nothing of B's can be named in the request.
  askFigures: {
    seed: (_db, _world, propertyId) => Promise.resolve({ propertyId }),
    creates: true,
    body: () => ({ question: 'How is business?' }),
    untouched: async (db) => {
      expect(await db.message.count()).toBe(0);
    },
  },
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
  recordInspection: {
    seed: bInspection,
    body: (theirs) => ({ roomId: theirs['roomId'], passed: false, failReasons: ['Leak'] }),
    untouched: bInspectionUnchanged,
  },
  updateHousekeepingSettings: {
    seed: bInspection,
    creates: true,
    body: () => ({ inspectionRequired: false }),
    untouched: bInspectionUnchanged,
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
  listAssets: {
    seed: bAsset,
    listIds: (body) => (body as { data: { id: string }[] }).data.map((a) => a.id),
  },
  createAsset: {
    seed: bAsset,
    creates: true,
    body: (theirs) => ({
      tag: 'LEAK',
      name: 'Leak',
      category: 'Leak',
      roomId: theirs['roomId'],
    }),
    untouched: bAssetUnchanged,
  },
  getAsset: { seed: bAsset },
  updateAsset: {
    seed: bAsset,
    body: () => ({ location: 'Leak', status: 'RETIRED' }),
    untouched: bAssetUnchanged,
  },
  saveWorkOrder: {
    seed: bAsset,
    body: () => ({ parts: [], labourMinutes: 1, vendorName: null, vendorCostMinor: '0' }),
    untouched: bAssetUnchanged,
  },
  listPreventivePlans: {
    seed: bPmPlan,
    listIds: (body) => (body as { data: { id: string }[] }).data.map((p) => p.id),
  },
  createPreventivePlan: {
    seed: bPmPlan,
    creates: true,
    body: (theirs) => ({
      title: 'Leak plan',
      assetId: theirs['assetId'],
      trigger: 'RUN_HOURS',
      everyHours: 10,
      lastServiceHours: 0,
      meterHours: 100,
    }),
    untouched: bPmPlanUnchanged,
  },
  updatePreventivePlan: {
    seed: bPmPlan,
    body: () => ({ title: 'Leaked', active: false }),
    untouched: bPmPlanUnchanged,
  },
  recordPlanHours: {
    seed: bPmPlan,
    body: () => ({ hours: 999 }),
    untouched: bPmPlanUnchanged,
  },
  listGenerators: {
    seed: bGenerator,
    listIds: (body) => (body as { data: { id: string }[] }).data.map((g) => g.id),
  },
  createGenerator: {
    seed: bGenerator,
    creates: true,
    body: (theirs) => ({ assetId: theirs['assetId'], name: 'Leak', tankLitresMilli: 5000 }),
    untouched: bGeneratorUnchanged,
  },
  getGenerator: { seed: bGenerator },
  startGeneratorRun: {
    seed: bGenerator,
    body: () => ({}),
    untouched: bGeneratorUnchanged,
  },
  stopGeneratorRun: {
    seed: bGenerator,
    body: () => ({}),
    untouched: bGeneratorUnchanged,
  },
  recordFuelMovement: {
    seed: bGenerator,
    creates: true,
    body: (theirs) => ({
      generatorId: theirs['generatorId'],
      kind: 'ISSUED',
      litresMilli: 1000,
    }),
    untouched: bGeneratorUnchanged,
  },
  recordMeterReading: {
    seed: bGenerator,
    creates: true,
    body: () => ({ meter: 'GRID', reading: '5' }),
    untouched: bGeneratorUnchanged,
  },
  listMeterReadings: {
    seed: bGenerator,
    listIds: (body) => (body as { data: { id: string }[] }).data.map((r) => r.id),
  },
  listLostItems: {
    seed: bLostItem,
    listIds: (body) => {
      const b = body as {
        data: { id: string }[];
        custodians: { id: string }[];
        rooms: { id: string }[];
      };
      return [...b.data, ...b.custodians, ...b.rooms].map((x) => x.id);
    },
  },
  createLostItem: {
    seed: bLostItem,
    creates: true,
    body: (theirs) => ({
      description: 'Leak',
      category: 'Other',
      roomId: theirs['roomId'],
      storageLocation: 'Leak',
    }),
    untouched: bLostItemUnchanged,
  },
  getLostItem: { seed: bLostItem },
  moveLostItem: {
    seed: bLostItem,
    body: () => ({ storageLocation: 'Leak', custodianId: '00000000-0000-4000-8000-000000000000' }),
    untouched: bLostItemUnchanged,
  },
  returnLostItem: {
    seed: bLostItem,
    body: () => ({ toName: 'Leak', idNote: 'Leak' }),
    untouched: bLostItemUnchanged,
  },
  disposeLostItem: {
    seed: bLostItem,
    body: () => ({ disposal: 'DISCARDED', note: 'Leak' }),
    untouched: bLostItemUnchanged,
  },
  listChecklists: {
    seed: bChecklist,
    listIds: (body) => {
      const b = body as {
        data: { id: string }[];
        departments: { id: string }[];
        assignees: { id: string }[];
      };
      return [...b.data, ...b.departments, ...b.assignees].map((x) => x.id);
    },
  },
  createChecklist: {
    seed: bChecklist,
    creates: true,
    body: (theirs) => ({
      name: 'Leak',
      departmentId: theirs['departmentId'],
      items: ['Leak'],
      frequency: 'DAILY',
    }),
    untouched: bChecklistUnchanged,
  },
  updateChecklist: {
    seed: bChecklist,
    body: () => ({ name: 'Leak', active: false }),
    untouched: bChecklistUnchanged,
  },
  listChecklistRuns: {
    seed: bChecklist,
    listIds: (body) => (body as { data: { id: string }[] }).data.map((r) => r.id),
  },
  completeChecklistRun: {
    seed: bChecklist,
    body: () => ({ results: [{ ok: false, note: 'Leak' }] }),
    untouched: bChecklistUnchanged,
  },
  listStaff: {
    seed: bStaff,
    listIds: (body) => {
      const b = body as {
        data: { id: string }[];
        departments: { id: string }[];
        people: { id: string }[];
      };
      return [...b.data, ...b.departments, ...b.people].map((x) => x.id);
    },
  },
  createStaff: {
    seed: bStaff,
    creates: true,
    body: (theirs) => ({
      name: 'Leak',
      jobTitle: 'Leak',
      employmentType: 'HOURLY',
      startDate: '2026-01-01',
      departmentId: theirs['departmentId'],
    }),
    untouched: bStaffUnchanged,
  },
  getStaff: { seed: bStaff },
  updateStaff: {
    seed: bStaff,
    body: () => ({ name: 'Leak', endDate: '2026-11-01' }),
    untouched: bStaffUnchanged,
  },
  getEmergencyContact: { seed: bStaff },
  addCertification: {
    seed: bStaff,
    body: () => ({ name: 'Leak' }),
    untouched: bStaffUnchanged,
  },
  updateCertification: {
    seed: bStaff,
    body: () => ({ name: 'Leak' }),
    untouched: bStaffUnchanged,
  },
  removeCertification: { seed: bStaff, untouched: bStaffUnchanged },
  getPosRegister: {
    seed: bPosOrder,
    listIds: (body) => {
      const b = body as { outlets: { id: string }[]; shifts: { id: string; outletId: string }[] };
      return [...b.outlets.map((o) => o.id), ...b.shifts.flatMap((s) => [s.id, s.outletId])];
    },
  },
  openOutletShift: {
    seed: bPosOrder,
    creates: true,
    body: (theirs) => ({ outletId: theirs['outletId'], floatMinor: '0' }),
    untouched: bPosOrderUnchanged,
  },
  closeOutletShift: {
    seed: bPosOrder,
    body: () => ({ counts: [{ method: 'CASH', currency: 'NGN', countedMinor: '0' }] }),
    untouched: bPosOrderUnchanged,
  },
  addOutletVarianceNote: {
    seed: bPosOrder,
    body: () => ({ note: 'Leak' }),
    untouched: bPosOrderUnchanged,
  },
  getOutletMenu: { seed: bPosOrder, query: (theirs) => ({ outletId: theirs['outletId'] ?? '' }) },
  listPosOrders: {
    seed: bPosOrder,
    query: (theirs) => ({ outletId: theirs['outletId'] ?? '' }),
    listIds: ids,
  },
  getPosOrder: { seed: bPosOrder },
  openPosOrder: {
    seed: bPosOrder,
    creates: true,
    body: (theirs) => ({ outletId: theirs['outletId'], label: 'Leak' }),
    untouched: bPosOrderUnchanged,
  },
  addPosOrderLine: {
    seed: bPosOrder,
    body: (theirs) => ({ menuItemId: theirs['itemId'] }),
    untouched: bPosOrderUnchanged,
  },
  settlePosOrder: {
    seed: bPosOrder,
    body: () => ({ payments: [{ method: 'CASH', amountMinor: '100000' }] }),
    untouched: bPosOrderUnchanged,
  },
  voidPosOrderLine: {
    seed: bPosOrder,
    body: () => ({ reason: 'Leak' }),
    untouched: bPosOrderUnchanged,
  },
  discountPosOrderLine: {
    seed: bPosOrder,
    body: () => ({ amountMinor: '100', reason: 'Leak' }),
    untouched: bPosOrderUnchanged,
  },
  chargePosOrderToRoom: {
    seed: bPosOrder,
    body: (theirs) => ({ stayId: theirs['stayId'], signatureFileId: theirs['orderId'] }),
    untouched: bPosOrderUnchanged,
  },
  cancelPosOrder: { seed: bPosOrder, untouched: bPosOrderUnchanged },
  // Recipes (T-157)
  getRecipeBook: {
    seed: bRecipe,
    listIds: (body) => {
      const b = body as {
        outlets: { id: string; items: { menuItemId: string }[] }[];
        stockItems: { id: string }[];
        locations: { id: string }[];
      };
      return [
        ...b.outlets.flatMap((o) => [o.id, ...o.items.map((i) => i.menuItemId)]),
        ...b.stockItems.map((i) => i.id),
        ...b.locations.map((l) => l.id),
      ];
    },
  },
  setRecipe: {
    seed: bRecipe,
    body: (theirs) => ({ lines: [{ stockItemId: theirs['stockItemId'], quantity: '1' }] }),
    untouched: bRecipeUnchanged,
  },
  setOutletStockLocation: {
    seed: bRecipe,
    body: () => ({ stockLocationId: null }),
    untouched: bRecipeUnchanged,
  },
  // Kitchen display (T-156)
  sendPosOrderToKitchen: { seed: bKitchen, untouched: bKitchenUnchanged },
  getKitchenBoard: {
    seed: bKitchen,
    listIds: (body) => {
      const b = body as { outlets: { id: string }[]; waiting: { id: string }[] };
      return [...b.outlets.map((o) => o.id), ...b.waiting.map((t) => t.id)];
    },
  },
  bumpKitchenTicket: { seed: bKitchen, untouched: bKitchenUnchanged },
  recallKitchenTicket: { seed: bKitchen, untouched: bKitchenUnchanged },
  listPosRooms: {
    seed: bPosOrder,
    listIds: (body) => (body as { data: { stayId: string }[] }).data.map((r) => r.stayId),
  },
  // Inventory (T-145)
  listStockItems: {
    seed: bStock,
    listIds: (body) => {
      const b = body as {
        items: { id: string }[];
        units: { id: string }[];
        locations: { id: string }[];
      };
      return [...b.items, ...b.units, ...b.locations].map((x) => x.id);
    },
  },
  createStockItem: {
    seed: bStock,
    creates: true,
    body: (theirs) => ({
      code: 'LEAK',
      name: 'Leak',
      category: null,
      unitId: theirs['unitId'],
      par: null,
      reorderPoint: null,
      unitCostMinor: '0',
    }),
    untouched: bStockUnchanged,
  },
  updateStockItem: { seed: bStock, body: () => ({ name: 'Leak' }), untouched: bStockUnchanged },
  createStockUnit: {
    seed: bStock,
    creates: true,
    body: () => ({ code: 'LK', name: 'Leak' }),
    untouched: bStockUnchanged,
  },
  updateStockUnit: { seed: bStock, body: () => ({ name: 'Leak' }), untouched: bStockUnchanged },
  createStockLocation: {
    seed: bStock,
    creates: true,
    body: () => ({ code: 'LEAK', name: 'Leak' }),
    untouched: bStockUnchanged,
  },
  updateStockLocation: {
    seed: bStock,
    body: () => ({ name: 'Leak' }),
    untouched: bStockUnchanged,
  },
  listStockMovements: {
    seed: bStock,
    listIds: (body) => (body as { data: { id: string }[] }).data.map((m) => m.id),
  },
  adjustStock: {
    seed: bStock,
    creates: true,
    body: (theirs) => ({
      itemId: theirs['itemId'],
      locationId: theirs['locationId'],
      quantity: '-5',
      reason: 'Leak',
    }),
    untouched: bStockUnchanged,
  },
  transferStock: {
    seed: bStock,
    creates: true,
    body: (theirs) => ({
      itemId: theirs['itemId'],
      fromLocationId: theirs['locationId'],
      toLocationId: theirs['unitId'],
      quantity: '1',
    }),
    untouched: bStockUnchanged,
  },
  listRequisitions: {
    seed: bStock,
    listIds: (body) => {
      const b = body as { data: { id: string }[]; departments: { id: string }[] };
      return [...b.data, ...b.departments].map((x) => x.id);
    },
  },
  createRequisition: {
    seed: bStock,
    creates: true,
    body: (theirs) => ({
      departmentId: theirs['departmentId'],
      lines: [{ itemId: theirs['itemId'], quantity: '1' }],
    }),
    untouched: bStockUnchanged,
  },
  cancelRequisition: { seed: bStock, untouched: bStockUnchanged },
  issueRequisition: {
    seed: bStock,
    body: (theirs) => ({
      locationId: theirs['locationId'],
      lines: [{ lineId: theirs['lineId'], quantity: '1' }],
    }),
    untouched: bStockUnchanged,
  },
  closeRequisition: { seed: bStock, body: () => ({ reason: 'Leak' }), untouched: bStockUnchanged },
  listStocktakes: {
    seed: bStock,
    listIds: (body) => (body as { data: { id: string }[] }).data.map((t) => t.id),
  },
  startStocktake: {
    seed: bStock,
    creates: true,
    body: (theirs) => ({ locationId: theirs['locationId'] }),
    untouched: bStockUnchanged,
  },
  getStocktake: { seed: bStock },
  recordStocktakeCounts: {
    seed: bStock,
    body: (theirs) => ({ counts: [{ itemId: theirs['itemId'], counted: '1' }] }),
    untouched: bStockUnchanged,
  },
  postStocktake: { seed: bStock, body: () => ({ reason: 'Leak' }), untouched: bStockUnchanged },
  cancelStocktake: { seed: bStock, untouched: bStockUnchanged },
  // Guest reviews (T-155)
  getReviewSettings: { seed: bReview, listIds: () => [] },
  updateReviewSettings: {
    seed: bReview,
    creates: true,
    body: () => ({ enabled: true, delayHours: 2, publicReviewUrl: null }),
    untouched: bReviewUnchanged,
  },
  listReviews: {
    seed: bReview,
    listIds: (body) => (body as { data: { id: string }[] }).data.map((r) => r.id),
  },
  draftReviewReply: { seed: bReview, untouched: bReviewUnchanged },
  replyToReview: {
    seed: bReview,
    body: () => ({ reply: 'Thank you' }),
    untouched: bReviewUnchanged,
  },
  // Pickup and pace (T-165): B's booking never counts in A's nights.
  getPaceReport: { seed: bReservation, listIds: () => [] },
  // Group dashboards (T-161)
  getGroupDashboard: {
    seed: bGroup,
    query: () => ({ month: '2026-11' }),
    listIds: (body) =>
      (body as { properties: { propertyId: string }[] }).properties.map((p) => p.propertyId),
  },
  getGroupRates: { seed: bGroup, query: () => ({ month: '2026-11' }), listIds: () => [] },
  putGroupRates: {
    seed: bGroup,
    // Changes the caller's own organisation only.
    creates: true,
    body: () => ({ month: '2026-11', groupCurrency: 'USD', rates: [] }),
    untouched: bGroupUnchanged,
  },
  // E-invoicing (T-160)
  getEinvoiceSettings: { seed: bEinvoice, listIds: () => [] },
  updateEinvoiceSettings: {
    seed: bEinvoice,
    // Changes the caller's own property only.
    creates: true,
    body: () => ({ enabled: false }),
    untouched: bEinvoiceUnchanged,
  },
  listEinvoices: {
    seed: bEinvoice,
    listIds: (body) => (body as { data: { folioId: string }[] }).data.map((i) => i.folioId),
  },
  submitEinvoice: { seed: bEinvoice, body: () => ({}), untouched: bEinvoiceUnchanged },
  // Partner API keys and webhooks (T-166)
  listApiKeys: {
    seed: bIntegrations,
    listIds: (body) => (body as { data: { id: string }[] }).data.map((k) => k.id),
  },
  createApiKey: {
    seed: bIntegrations,
    creates: true,
    body: () => ({ name: 'Mine', scopes: ['folios:read'] }),
    untouched: bIntegrationsUnchanged,
  },
  revokeApiKey: { seed: bIntegrations, body: () => ({}), untouched: bIntegrationsUnchanged },
  listWebhookEndpoints: {
    seed: bIntegrations,
    listIds: (body) => (body as { data: { id: string }[] }).data.map((e) => e.id),
  },
  createWebhookEndpoint: {
    seed: bIntegrations,
    creates: true,
    body: () => ({ url: 'https://mine.example.test/hooks', events: ['reservation.created'] }),
    untouched: bIntegrationsUnchanged,
  },
  updateWebhookEndpoint: {
    seed: bIntegrations,
    body: () => ({ active: false, events: ['stay.checked_in'] }),
    untouched: bIntegrationsUnchanged,
  },
  testWebhookEndpoint: {
    seed: bIntegrations,
    body: () => ({}),
    untouched: bIntegrationsUnchanged,
  },
  listWebhookDeliveries: {
    seed: bIntegrations,
    listIds: (body) => (body as { data: { id: string }[] }).data.map((d) => d.id),
  },
  retryWebhookDelivery: {
    seed: bIntegrations,
    body: () => ({}),
    untouched: bIntegrationsUnchanged,
  },
  // In-app support (T-170)
  listSupportTickets: {
    seed: bSupport,
    listIds: (body) => (body as { data: { id: string }[] }).data.map((t) => t.id),
  },
  createSupportTicket: {
    seed: bSupport,
    creates: true,
    body: () => ({ subject: 'Mine', message: 'Help' }),
    untouched: bSupportUnchanged,
  },
  getSupportTicket: { seed: bSupport },
  replySupportTicket: {
    seed: bSupport,
    body: () => ({ message: 'Into theirs' }),
    untouched: bSupportUnchanged,
  },
  resolveSupportTicket: { seed: bSupport, body: () => ({}), untouched: bSupportUnchanged },
  // Getting started (T-172): B's staff never show up in A's team, nor B's steps in A's own.
  listGettingStarted: { seed: bUser, listIds: () => [] },
  listTeamGettingStarted: {
    seed: bUser,
    listIds: (body) => (body as { data: { user: { id: string } }[] }).data.map((m) => m.user.id),
  },
  // Training with the support team (T-171)
  listMyTraining: {
    seed: bTraining,
    listIds: (body) => (body as { data: { id: string }[] }).data.map((s) => s.id),
  },
  // Channel manager (T-151)
  getChannelConnection: {
    seed: bChannel,
    listIds: (body) => {
      const b = body as { roomTypes: { id: string }[]; ratePlans: { id: string }[] };
      return [...b.roomTypes, ...b.ratePlans].map((x) => x.id);
    },
  },
  connectChannel: {
    seed: bChannel,
    creates: true,
    body: (theirs) => ({ ratePlanIds: [theirs['ratePlanId']] }),
    untouched: bChannelUnchanged,
  },
  pauseChannel: {
    seed: bChannel,
    creates: true,
    body: () => ({ paused: true }),
    untouched: bChannelUnchanged,
  },
  // T-152: A has no connection, so B's is never asked to send everything again.
  requestChannelFullSync: { seed: bChannel, creates: true, untouched: bChannelUnchanged },
  // T-153: B's held OTA bookings are neither listed nor tried again nor dismissed from A.
  listChannelBookings: {
    seed: bChannelBooking,
    listIds: (body) => (body as { id: string }[]).map((b) => b.id),
  },
  retryChannelBooking: { seed: bChannelBooking, untouched: bChannelBookingUnchanged },
  dismissChannelBooking: {
    seed: bChannelBooking,
    body: () => ({ note: 'Handled' }),
    untouched: bChannelBookingUnchanged,
  },
  // Accounting exports (T-148)
  getAccountingMappings: {
    seed: bAccounting,
    listIds: (body) => (body as { data: { key: string }[] }).data.map((x) => x.key),
  },
  updateAccountingMappings: {
    seed: bAccounting,
    creates: true,
    body: () => ({
      mappings: [{ kind: 'CONTROL', key: 'GUEST_LEDGER', accountCode: '9999' }],
    }),
    untouched: bAccountingUnchanged,
  },
  listAccountingExports: {
    seed: bAccounting,
    listIds: (body) => (body as { data: { id: string }[] }).data.map((x) => x.id),
  },
  createAccountingExport: {
    seed: bAccounting,
    creates: true,
    body: () => ({ from: '2026-11-01', to: '2026-11-01' }),
    untouched: bAccountingUnchanged,
  },
  getAccountingExport: { seed: bAccounting },
  // Expenses (T-147)
  getExpenseSetup: {
    seed: bExpenses,
    listIds: (body) => {
      const b = body as {
        categories: { id: string }[];
        floats: { id: string }[];
        departments: { id: string }[];
      };
      return [...b.categories, ...b.floats, ...b.departments].map((x) => x.id);
    },
  },
  createExpenseCategory: {
    seed: bExpenses,
    creates: true,
    body: () => ({ code: 'LEAK', name: 'Leak' }),
    untouched: bExpensesUnchanged,
  },
  updateExpenseCategory: {
    seed: bExpenses,
    body: () => ({ name: 'Leak' }),
    untouched: bExpensesUnchanged,
  },
  createPettyCashFloat: {
    seed: bExpenses,
    creates: true,
    body: () => ({ name: 'Leak', custodianId: null }),
    untouched: bExpensesUnchanged,
  },
  updatePettyCashFloat: {
    seed: bExpenses,
    body: () => ({ name: 'Leak' }),
    untouched: bExpensesUnchanged,
  },
  topUpPettyCash: {
    seed: bExpenses,
    body: () => ({ amountMinor: '100' }),
    untouched: bExpensesUnchanged,
  },
  listExpenses: {
    seed: bExpenses,
    listIds: (body) => (body as { data: { id: string }[] }).data.map((x) => x.id),
  },
  recordExpense: {
    seed: bExpenses,
    creates: true,
    body: (theirs) => ({
      spentOn: '2026-11-01',
      categoryId: theirs['categoryId'],
      departmentId: theirs['departmentId'],
      payee: 'Leak',
      description: 'Leak',
      amountMinor: '100',
      paidFrom: 'PETTY_CASH',
      floatId: theirs['floatId'],
      reason: 'Leak',
    }),
    untouched: bExpensesUnchanged,
  },
  voidExpense: { seed: bExpenses, body: () => ({ reason: 'Leak' }), untouched: bExpensesUnchanged },
  // Purchasing (T-146)
  listSuppliers: {
    seed: bPurchasing,
    listIds: (body) => (body as { data: { id: string }[] }).data.map((x) => x.id),
  },
  createSupplier: {
    seed: bPurchasing,
    creates: true,
    body: () => ({ name: 'Leak', contactName: null, phone: null, email: null, note: null }),
    untouched: bPurchasingUnchanged,
  },
  updateSupplier: {
    seed: bPurchasing,
    body: () => ({ name: 'Leak' }),
    untouched: bPurchasingUnchanged,
  },
  listPurchaseOrders: {
    seed: bPurchasing,
    listIds: (body) => (body as { data: { id: string }[] }).data.map((x) => x.id),
  },
  createPurchaseOrder: {
    seed: bPurchasing,
    creates: true,
    body: (theirs) => ({
      supplierId: theirs['supplierId'],
      lines: [{ itemId: theirs['itemId'], quantity: '1', unitPriceMinor: '100' }],
    }),
    untouched: bPurchasingUnchanged,
  },
  getPurchaseOrder: { seed: bPurchasing },
  updatePurchaseOrder: {
    seed: bPurchasing,
    body: (theirs) => ({
      supplierId: theirs['supplierId'],
      lines: [{ itemId: theirs['itemId'], quantity: '1', unitPriceMinor: '100' }],
    }),
    untouched: bPurchasingUnchanged,
  },
  approvePurchaseOrder: {
    seed: bPurchasing,
    body: () => ({ reason: 'Leak' }),
    untouched: bPurchasingUnchanged,
  },
  closePurchaseOrder: {
    seed: bPurchasing,
    body: () => ({ reason: 'Leak' }),
    untouched: bPurchasingUnchanged,
  },
  cancelPurchaseOrder: { seed: bPurchasing, untouched: bPurchasingUnchanged },
  listGoodsReceipts: {
    seed: bPurchasing,
    listIds: (body) => {
      const b = body as {
        awaiting: { id: string }[];
        data: { id: string }[];
        locations: { id: string }[];
      };
      return [...b.awaiting, ...b.data, ...b.locations].map((x) => x.id);
    },
  },
  receiveGoods: {
    seed: bPurchasing,
    creates: true,
    body: (theirs) => ({
      purchaseOrderId: theirs['orderId'],
      locationId: theirs['locationId'],
      lines: [{ lineId: theirs['orderLineId'], quantity: '1' }],
    }),
    untouched: bPurchasingUnchanged,
  },
  getPosSettings: { seed: bPosOrder, listIds: () => [] },
  updatePosSettings: {
    seed: bPosOrder,
    creates: true,
    body: () => ({ roomChargeLimitMinor: '1' }),
    untouched: bPosOrderUnchanged,
  },
  listOutlets: {
    seed: bOutlet,
    listIds: (body) => {
      const b = body as {
        data: { id: string; categories: { id: string; items: { id: string }[] }[] }[];
        revenueCodes: { id: string }[];
      };
      return [
        ...b.data.map((o) => o.id),
        ...b.data.flatMap((o) => o.categories.map((c) => c.id)),
        ...b.data.flatMap((o) => o.categories.flatMap((c) => c.items.map((i) => i.id))),
        ...b.revenueCodes.map((c) => c.id),
      ];
    },
  },
  createOutlet: {
    seed: bOutlet,
    creates: true,
    body: () => ({ code: 'THEIRS', name: 'Leak' }),
    untouched: bOutletUnchanged,
  },
  updateOutlet: {
    seed: bOutlet,
    body: () => ({ name: 'Leak', active: false }),
    untouched: bOutletUnchanged,
  },
  addMenuCategory: { seed: bOutlet, body: () => ({ name: 'Leak' }), untouched: bOutletUnchanged },
  updateMenuCategory: {
    seed: bOutlet,
    body: () => ({ name: 'Leak' }),
    untouched: bOutletUnchanged,
  },
  addMenuItem: {
    seed: bOutlet,
    body: (theirs) => ({ name: 'Leak', priceMinor: '1', revenueCodeId: theirs['revenueCodeId'] }),
    untouched: bOutletUnchanged,
  },
  updateMenuItem: { seed: bOutlet, body: () => ({ priceMinor: '1' }), untouched: bOutletUnchanged },
  addMenuModifier: { seed: bOutlet, body: () => ({ name: 'Leak' }), untouched: bOutletUnchanged },
  updateMenuModifier: {
    seed: bOutlet,
    body: () => ({ name: 'Leak' }),
    untouched: bOutletUnchanged,
  },
  listStaffDocuments: { seed: bStaffDocs },
  addStaffDocument: {
    seed: bStaffDocs,
    body: (theirs) => ({ type: 'ID', title: 'Leak', fileId: theirs['fileId'] }),
    untouched: bStaffDocsUnchanged,
  },
  getStaffDocumentLink: { seed: bStaffDocs },
  removeStaffDocument: { seed: bStaffDocs, untouched: bStaffDocsUnchanged },
  getStaffDocumentSettings: {
    seed: bStaffDocs,
    // The retention answered is A's: B's 99 months never shows.
    listIds: (body) =>
      Object.values((body as { retention: Record<string, number> }).retention).map(String),
  },
  updateStaffDocumentSettings: {
    seed: bStaffDocs,
    creates: true,
    body: () => ({ retention: { CONTRACT: 1, GUARANTOR: 1, ID: 1, CERTIFICATE: 1, OTHER: 1 } }),
    untouched: bStaffDocsUnchanged,
  },
  listTimesheets: {
    seed: bPayroll,
    query: () => ({ month: '2026-11' }),
    listIds: (body) => {
      const b = body as { data: { id: string }[]; staff: { id: string }[] };
      return [...b.data, ...b.staff].map((x) => x.id);
    },
  },
  createTimesheet: {
    seed: bPayroll,
    creates: true,
    body: (theirs) => ({ staffId: theirs['staffId'], from: '2026-12-01', to: '2026-12-07' }),
    untouched: bPayrollUnchanged,
  },
  recalculateTimesheet: { seed: bPayroll, untouched: bPayrollUnchanged },
  approveTimesheet: {
    seed: bPayroll,
    body: () => ({ approvedOvertimeMinutes: 0, note: 'Leak' }),
    untouched: bPayrollUnchanged,
  },
  deleteTimesheet: { seed: bPayroll, untouched: bPayrollUnchanged },
  listPayItems: {
    seed: bPayroll,
    query: () => ({ month: '2026-11' }),
    listIds: (body) => {
      const b = body as { data: { id: string }[]; staff: { id: string }[] };
      return [...b.data, ...b.staff].map((x) => x.id);
    },
  },
  createPayItem: {
    seed: bPayroll,
    creates: true,
    body: (theirs) => ({
      staffId: theirs['staffId'],
      type: 'DEDUCTION',
      amountMinor: '100',
      month: '2026-11',
      description: 'Leak',
    }),
    untouched: bPayrollUnchanged,
  },
  decidePayItem: {
    seed: bPayroll,
    body: () => ({ decision: 'APPROVE' }),
    untouched: bPayrollUnchanged,
  },
  cancelPayItem: { seed: bPayroll, untouched: bPayrollUnchanged },
  getPayrollExport: {
    seed: bPayroll,
    query: () => ({ month: '2026-11' }),
    listIds: (body) => (body as { rows: { staff: { id: string } }[] }).rows.map((r) => r.staff.id),
  },
  addMissedClock: {
    seed: bAttendance,
    creates: true,
    body: (theirs) => ({
      staffId: theirs['staffId'],
      kind: 'OUT',
      at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      note: 'Leak attempt',
    }),
    untouched: bAttendanceUnchanged,
  },
  getMyAttendance: {
    seed: bAttendance,
    listIds: (body) => {
      const b = body as { staff: { id: string } | null; recent: { id: string }[] };
      return [...(b.staff ? [b.staff.id] : []), ...b.recent.map((e) => e.id)];
    },
  },
  clockAttendance: {
    seed: bAttendance,
    creates: true,
    body: () => ({ kind: 'OUT' }),
    untouched: bAttendanceUnchanged,
  },
  setLocationConsent: {
    seed: bAttendance,
    creates: true,
    body: () => ({ consent: true }),
    untouched: bAttendanceUnchanged,
  },
  listAttendance: {
    seed: bAttendance,
    listIds: (body) => {
      const b = body as { events: { id: string }[]; inNow: { id: string }[] };
      return [...b.events, ...b.inNow].map((x) => x.id);
    },
  },
  getAttendanceSettings: {
    seed: bAttendance,
    listIds: (body) =>
      (body as { settings: { network: { addresses: string[] } } }).settings.network.addresses,
  },
  updateAttendanceSettings: {
    seed: bAttendance,
    creates: true,
    body: () => ({
      employmentTypes: ['HOURLY'],
      phoneAllowed: false,
      network: { enabled: false, addresses: [] },
      location: { enabled: false, latitude: null, longitude: null, radiusMeters: 200 },
      privacyNotice: 'A leak attempt notice that is long enough.',
    }),
    untouched: bAttendanceUnchanged,
  },
  listDuties: {
    seed: bWork,
    listIds: (body) => {
      const b = body as { data: { id: string }[]; staff: { id: string }[] };
      return [...b.data, ...b.staff].map((x) => x.id);
    },
  },
  createDuty: {
    seed: bWork,
    creates: true,
    body: (theirs) => ({ staffId: theirs['staffId'], title: 'Leak' }),
    untouched: bWorkUnchanged,
  },
  updateDuty: {
    seed: bWork,
    body: () => ({ title: 'Leak', active: false }),
    untouched: bWorkUnchanged,
  },
  getRota: {
    seed: bWork,
    query: (theirs) => ({
      departmentId: theirs['departmentId'] ?? '',
      from: '2026-11-16',
      to: '2026-11-22',
    }),
  },
  addRotaShift: {
    seed: bWork,
    body: () => ({ name: 'Leak', startTime: '08:00', endTime: '09:00' }),
    untouched: bWorkUnchanged,
  },
  updateRotaShift: {
    seed: bWork,
    body: () => ({ name: 'Leak', active: false }),
    untouched: bWorkUnchanged,
  },
  assignShift: {
    seed: bWork,
    creates: true,
    body: (theirs) => ({
      shiftId: theirs['shiftId'],
      staffId: theirs['staffId'],
      date: '2026-11-19',
    }),
    untouched: bWorkUnchanged,
  },
  unassignShift: { seed: bWork, untouched: bWorkUnchanged },
  publishRota: {
    seed: bWork,
    body: () => ({ from: '2026-11-16', period: 'WEEKLY' }),
    untouched: bWorkUnchanged,
  },
  getMyWork: {
    seed: bWork,
    listIds: (body) => {
      const b = body as {
        duties: { id: string }[];
        shifts: { id: string }[];
        leave: { id: string }[];
      };
      return [...b.duties, ...b.shifts, ...b.leave].map((x) => x.id);
    },
  },
  requestLeave: {
    seed: bWork,
    creates: true,
    body: () => ({ type: 'ANNUAL', startDate: '2026-12-01', endDate: '2026-12-02' }),
    untouched: bWorkUnchanged,
  },
  cancelLeave: { seed: bWork, untouched: bWorkUnchanged },
  listLeave: {
    seed: bWork,
    listIds: (body) => {
      const b = body as { data: { id: string }[] };
      return [...b.data].map((x) => x.id);
    },
  },
  decideLeave: {
    seed: bWork,
    body: () => ({ decision: 'APPROVE' }),
    untouched: bWorkUnchanged,
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
  summariseHandovers: {
    // B's department from A1: not found, and B's handover is never read.
    seed: bHandover,
    body: (theirs) => ({ departmentId: theirs['departmentId'] }),
    untouched: bHandoverUnchanged,
  },
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
  getOperationsReport: {
    seed: bTask,
    listIds: (body) => {
      const b = body as { departments: { departmentId: string }[]; people: { userId: string }[] };
      return [...b.departments.map((d) => d.departmentId), ...b.people.map((x) => x.userId)];
    },
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
  // T-124: never a link for, or a look at, another group's invoice.
  payPlatformInvoice: { seed: bBilling, body: () => ({}), untouched: bInvoiceUntouched },
  checkPlatformInvoice: { seed: bBilling, body: () => ({}), untouched: bInvoiceUntouched },
  // The home spans properties: B's property must never be one of A's cards (T-091).
  getOwnerHome: {
    seed: (_db, _world, propertyId) => Promise.resolve({ propertyId }),
    listIds: (body) => (body as { properties: { id: string }[] }).properties.map((p) => p.id),
  },
};
