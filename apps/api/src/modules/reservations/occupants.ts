import type { OccupantBody, OccupantChargeBody, OccupantKind, StayOccupants } from '@hotel/shared';
import type { z } from 'zod';
import type { StayOccupant } from '../../generated/prisma/client.ts';
import { recordAudit } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import type { TenantDb } from '../../core/tenant-db.ts';
import type { ReservationDeps } from './service.ts';

// Extra people on a stay (PRD M14-02, M14-03; T-056). An added person counts in the stay's
// adults or children while present; the room type's maximum occupancy is the limit. The
// nightly charge is set per person: the plan suggests its extra-adult or extra-child amount
// for a person above the room type's base occupancy, and the desk may set any other amount,
// zero included, with a note. Night audit posts it with the room night (room-charges.ts).

type Tx = Parameters<Parameters<TenantDb['$transaction']>[0]>[0];
type Out = z.input<typeof StayOccupants>;

const OPEN = new Set(['TENTATIVE', 'CONFIRMED', 'CHECKED_IN']);
const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

async function loadStay(tx: Tx, stayId: string) {
  const stay = await tx.stay.findUnique({
    where: { id: stayId },
    include: { roomType: true, ratePlan: true },
  });
  if (!stay) throw new AppError('NOT_FOUND', 'Stay not found');
  return stay;
}

type StayRow = Awaited<ReturnType<typeof loadStay>>;

/** What the plan suggests per night for one more person of `kind` on this stay. */
export function suggestedCharge(stay: StayRow, kind: OccupantKind): bigint {
  if (stay.isDayUse) return 0n;
  const guests = stay.adults + stay.children + 1;
  if (guests <= stay.roomType.baseOccupancy) return 0n;
  return (kind === 'ADULT' ? stay.ratePlan.extraAdultMinor : stay.ratePlan.extraChildMinor) ?? 0n;
}

async function view(tx: Tx, stayId: string): Promise<Out> {
  const stay = await loadStay(tx, stayId);
  const rows = await tx.stayOccupant.findMany({
    where: { stayId },
    include: { addedBy: { select: { name: true } } },
    orderBy: [{ addedAt: 'desc' }, { id: 'asc' }],
  });
  return {
    stayId: stay.id,
    status: stay.status,
    isDayUse: stay.isDayUse,
    adults: stay.adults,
    children: stay.children,
    baseOccupancy: stay.roomType.baseOccupancy,
    maxOccupancy: stay.roomType.maxOccupancy,
    suggested: {
      ADULT: suggestedCharge(stay, 'ADULT').toString(),
      CHILD: suggestedCharge(stay, 'CHILD').toString(),
    },
    stayVersion: stay.version,
    data: rows.map((o) => ({
      id: o.id,
      stayId: o.stayId,
      firstName: o.firstName,
      lastName: o.lastName,
      kind: o.kind,
      phone: o.phone,
      nightlyChargeMinor: o.nightlyChargeMinor.toString(),
      chargeNote: o.chargeNote,
      addedBy: o.addedBy.name,
      addedAt: iso(o.addedAt),
      removedAt: o.removedAt ? iso(o.removedAt) : null,
      version: o.version,
    })),
  };
}

/** One change to a stay's people at a time. */
async function lockStay(tx: Tx, stayId: string) {
  await tx.$queryRaw`SELECT id FROM stays WHERE id = ${stayId}::uuid FOR UPDATE`;
}

function mustBeOpen(stay: StayRow) {
  if (!OPEN.has(stay.status)) {
    throw new AppError(
      'STATE_TRANSITION_INVALID',
      'People can be added or changed only on a booked or checked-in stay',
      { status: stay.status },
    );
  }
}

/** A charge other than the suggestion needs a reason; a day-use stay is priced per stay. */
function checkCharge(stay: StayRow, charge: bigint, suggested: bigint, note: string | null) {
  if (stay.isDayUse && charge > 0n) {
    throw new AppError('VALIDATION_ERROR', 'A day-use stay is priced per stay', {
      issues: [
        {
          path: 'body.nightlyChargeMinor',
          code: 'day_use',
          message: 'Day-use stays have no nightly charge for extra people',
        },
      ],
    });
  }
  if (charge !== suggested && !note) {
    throw new AppError('VALIDATION_ERROR', 'Say why the charge differs from the plan’s', {
      issues: [
        {
          path: 'body.chargeNote',
          code: 'required',
          message: `The plan suggests ${suggested.toString()} (minor units): say why this charge is different`,
        },
      ],
    });
  }
}

const auditOccupant = (o: StayOccupant) => ({
  stayId: o.stayId,
  name: `${o.firstName} ${o.lastName}`,
  kind: o.kind,
  nightlyChargeMinor: o.nightlyChargeMinor.toString(),
  chargeNote: o.chargeNote,
});

export function listOccupants(deps: ReservationDeps, stayId: string): Promise<Out> {
  return deps.tenantDb.$transaction((tx) => view(tx, stayId));
}

export function addOccupant(
  deps: ReservationDeps,
  tenant: TenantContext,
  stayId: string,
  body: z.output<typeof OccupantBody>,
): Promise<Out> {
  return deps.tenantDb.$transaction(async (tx) => {
    await loadStay(tx, stayId); // 404 before taking the lock
    await lockStay(tx, stayId);
    const stay = await loadStay(tx, stayId);
    mustBeOpen(stay);
    const guests = stay.adults + stay.children + 1;
    if (guests > stay.roomType.maxOccupancy) {
      throw new AppError(
        'OCCUPANCY_EXCEEDED',
        `${stay.roomType.name} takes at most ${stay.roomType.maxOccupancy} guests`,
        {
          maxOccupancy: stay.roomType.maxOccupancy,
          adults: stay.adults,
          children: stay.children,
        },
      );
    }
    const suggested = suggestedCharge(stay, body.kind);
    const charge =
      body.nightlyChargeMinor !== undefined ? BigInt(body.nightlyChargeMinor) : suggested;
    checkCharge(stay, charge, suggested, body.chargeNote);
    const occupant = await tx.stayOccupant.create({
      data: {
        propertyId: stay.propertyId,
        stayId: stay.id,
        firstName: body.firstName,
        lastName: body.lastName,
        kind: body.kind,
        phone: body.phone,
        nightlyChargeMinor: charge,
        chargeNote: charge === suggested ? null : body.chargeNote,
        addedById: tenant.userId,
      },
    });
    await tx.stay.update({
      where: { id: stay.id },
      data: {
        ...(body.kind === 'ADULT' ? { adults: { increment: 1 } } : { children: { increment: 1 } }),
        version: { increment: 1 },
      },
    });
    await recordAudit(tx, {
      action: 'stay.occupant_added',
      entityType: 'stay',
      entityId: stay.id,
      after: { ...auditOccupant(occupant), suggestedMinor: suggested.toString() },
      ...(occupant.chargeNote ? { reason: occupant.chargeNote } : {}),
    });
    return view(tx, stay.id);
  });
}

async function present(tx: Tx, stayId: string, occupantId: string, ifMatch: string) {
  const occupant = await tx.stayOccupant.findUnique({ where: { id: occupantId } });
  if (!occupant || occupant.stayId !== stayId) {
    throw new AppError('NOT_FOUND', 'Person not found on this stay');
  }
  const m = /^(?:W\/)?"(\d+)"$/.exec(ifMatch.trim());
  if (!m || Number(m[1]) !== occupant.version) {
    throw new AppError('VERSION_CONFLICT', 'Someone changed this person; reload and try again', {
      version: occupant.version,
    });
  }
  if (occupant.removedAt) {
    throw new AppError('STATE_TRANSITION_INVALID', 'This person was already taken off the stay');
  }
  return occupant;
}

export function changeOccupantCharge(
  deps: ReservationDeps,
  stayId: string,
  occupantId: string,
  ifMatch: string,
  body: z.output<typeof OccupantChargeBody>,
): Promise<Out> {
  return deps.tenantDb.$transaction(async (tx) => {
    await loadStay(tx, stayId);
    await lockStay(tx, stayId);
    const stay = await loadStay(tx, stayId);
    mustBeOpen(stay);
    const before = await present(tx, stayId, occupantId, ifMatch);
    // The suggestion this person was measured against: as if they were the last one added.
    const others = { ...stay, adults: stay.adults, children: stay.children };
    if (before.kind === 'ADULT') others.adults -= 1;
    else others.children -= 1;
    const suggested = suggestedCharge(others, before.kind);
    const charge = BigInt(body.nightlyChargeMinor);
    checkCharge(stay, charge, suggested, body.chargeNote);
    const after = await tx.stayOccupant.update({
      where: { id: before.id },
      data: {
        nightlyChargeMinor: charge,
        chargeNote: charge === suggested ? null : body.chargeNote,
        version: { increment: 1 },
      },
    });
    await recordAudit(tx, {
      action: 'stay.occupant_charge_changed',
      entityType: 'stay',
      entityId: stay.id,
      before: auditOccupant(before),
      after: auditOccupant(after),
      ...(after.chargeNote ? { reason: after.chargeNote } : {}),
    });
    return view(tx, stay.id);
  });
}

export function removeOccupant(
  deps: ReservationDeps,
  tenant: TenantContext,
  stayId: string,
  occupantId: string,
  ifMatch: string,
): Promise<Out> {
  return deps.tenantDb.$transaction(async (tx) => {
    await loadStay(tx, stayId);
    await lockStay(tx, stayId);
    const stay = await loadStay(tx, stayId);
    mustBeOpen(stay);
    const before = await present(tx, stayId, occupantId, ifMatch);
    await tx.stayOccupant.update({
      where: { id: before.id },
      data: { removedAt: deps.clock(), removedById: tenant.userId, version: { increment: 1 } },
    });
    await tx.stay.update({
      where: { id: stay.id },
      data: {
        ...(before.kind === 'ADULT'
          ? { adults: { decrement: 1 } }
          : { children: { decrement: 1 } }),
        version: { increment: 1 },
      },
    });
    await recordAudit(tx, {
      action: 'stay.occupant_removed',
      entityType: 'stay',
      entityId: stay.id,
      before: auditOccupant(before),
    });
    return view(tx, stay.id);
  });
}
