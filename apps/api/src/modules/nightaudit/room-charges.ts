import { splitPackage } from '@hotel/shared';
import type { RevenueCode } from '../../generated/prisma/client.ts';
import type { ExecuteContext } from '../../core/approvals.ts';
import { recordAudit } from '../../core/audit.ts';
import type { Clock } from '../../core/clock.ts';
import type { TenantDb } from '../../core/tenant-db.ts';
import { openFolio, postChargeLines, routedWindow } from '../folios/service.ts';

// Room and package postings (M4 rule 8 steps 4–5; T-073). A night posts once per stay: the
// room line is keyed by (property, stay, night) in room_charge_postings, so a rerun or a
// resumed run never charges a night twice. A package night posts its components to their own
// codes and the room line gets the rest, as the quote priced it (T-041). A day-use stay posts
// its one price at check-in, through the same key, so night audit finds it already posted.

type Tx = Parameters<Parameters<TenantDb['$transaction']>[0]>[0];
type Ctx = ExecuteContext & { now: Date };

const day = (d: Date) => d.toISOString().slice(0, 10);
const dbDate = (date: string) => new Date(`${date}T00:00:00Z`);

/** Why a night could not be posted: the step lists it as an exception to resolve. */
export class PostingProblem extends Error {
  readonly type: string;

  constructor(type: string, message: string) {
    super(message);
    this.name = 'PostingProblem';
    this.type = type;
  }
}

/** The room revenue code (ROOM if there are several), as quotes price it. */
export async function roomCodeOf(tx: Tx): Promise<RevenueCode | null> {
  const codes = await tx.revenueCode.findMany({ where: { group: 'ROOM', active: true } });
  return codes.find((c) => c.code === 'ROOM') ?? codes[0] ?? null;
}

/** Locks the stay: one posting of a night at a time. */
async function lockStay(tx: Tx, stayId: string) {
  await tx.$queryRaw`SELECT id FROM stays WHERE id = ${stayId}::uuid FOR UPDATE`;
}

async function stayFor(tx: Tx, stayId: string) {
  return tx.stay.findUniqueOrThrow({
    where: { id: stayId },
    include: {
      room: true,
      ratePlan: { include: { components: true } },
      // Nights have no property column: read through the (scoped) stay.
      nights: true,
    },
  });
}

async function folioFor(
  tx: Tx,
  stay: Awaited<ReturnType<typeof stayFor>>,
  clock: Clock,
  businessDate: string,
) {
  const folioId = await openFolio(tx, stay, clock, businessDate);
  const folio = await tx.folio.findUniqueOrThrow({
    where: { id: folioId },
    include: { windows: true, routingRules: true },
  });
  if (folio.status !== 'OPEN') {
    throw new PostingProblem(
      'FOLIO_NOT_OPEN',
      `Folio ${folio.number} is ${folio.status.toLowerCase()}: reopen it or post this night by hand`,
    );
  }
  return folio;
}

/** The night's price and how a package splits it. */
function priceOf(stay: Awaited<ReturnType<typeof stayFor>>, night: string) {
  const row = stay.nights.find((n) => day(n.date) === night);
  if (!row) {
    throw new PostingProblem('NO_PRICE', `The stay has no price for the night of ${night}`);
  }
  const plan = stay.ratePlan;
  if (plan.kind === 'PACKAGE' && plan.components.length > 0) {
    try {
      return splitPackage(row.amountMinor, plan.components, stay.adults + stay.children);
    } catch {
      throw new PostingProblem(
        'NO_PRICE',
        `Package ${plan.code} costs more in parts than its price on ${night}`,
      );
    }
  }
  return { roomMinor: row.amountMinor, components: [] };
}

/**
 * Posts the room line of `night` for a stay on `businessDate`, once: answers false when the
 * night was already posted. Throws PostingProblem when it cannot be posted.
 */
export async function postRoomNight(
  ctx: Ctx,
  args: { stayId: string; night: string; businessDate: string; clock: Clock },
): Promise<{ posted: boolean; amountMinor: bigint }> {
  const { tx } = ctx;
  await lockStay(tx, args.stayId);
  const done = await tx.roomChargePosting.findFirst({
    where: { stayId: args.stayId, night: dbDate(args.night) },
  });
  if (done) return { posted: false, amountMinor: 0n };
  const stay = await stayFor(tx, args.stayId);
  const code = await roomCodeOf(tx);
  if (!code) {
    throw new PostingProblem('NO_ROOM_CODE', 'There is no active room revenue code to post to');
  }
  const price = priceOf(stay, args.night);
  const folio = await folioFor(tx, stay, args.clock, args.businessDate);
  const windowId = routedWindow(folio, code);
  if (!windowId) throw new PostingProblem('FOLIO_NOT_OPEN', `Folio ${folio.number} has no window`);
  const room = stay.room?.number ?? '—';
  const ids = await postChargeLines(ctx, {
    folio,
    windowId,
    code,
    description: stay.isDayUse ? `Day-use, room ${room}` : `Room ${room}, night of ${args.night}`,
    quantity: 1,
    unitAmountMinor: price.roomMinor,
    note: null,
    sourceType: 'STAY_NIGHT',
    sourceId: stay.id,
    businessDate: args.businessDate,
  });
  const lineId = ids[0] ?? '';
  await tx.roomChargePosting.create({
    data: {
      propertyId: stay.propertyId,
      stayId: stay.id,
      night: dbDate(args.night),
      businessDate: dbDate(args.businessDate),
      folioLineId: lineId,
    },
  });
  await recordAudit(tx, {
    action: 'folio.room_posted',
    entityType: 'folio',
    entityId: folio.id,
    after: { lineId, stayId: stay.id, night: args.night, amountMinor: price.roomMinor },
  });
  // People added to the stay (T-056, M14-03): each one's nightly charge, with the room night
  // and under its code and taxes, so the night's key posts them once too. A day-use stay is
  // priced per stay and has none.
  let extraMinor = 0n;
  if (!stay.isDayUse) {
    const people = await tx.stayOccupant.findMany({
      where: { stayId: stay.id, removedAt: null, nightlyChargeMinor: { gt: 0n } },
      orderBy: [{ addedAt: 'asc' }, { id: 'asc' }],
    });
    for (const person of people) {
      const extra = await postChargeLines(ctx, {
        folio,
        windowId,
        code,
        description: `Extra ${person.kind === 'ADULT' ? 'adult' : 'child'}: ${person.firstName} ${person.lastName}, night of ${args.night}`,
        quantity: 1,
        unitAmountMinor: person.nightlyChargeMinor,
        note: null,
        sourceType: 'OCCUPANT_NIGHT',
        sourceId: person.id,
        businessDate: args.businessDate,
      });
      extraMinor += person.nightlyChargeMinor;
      await recordAudit(tx, {
        action: 'folio.occupant_posted',
        entityType: 'folio',
        entityId: folio.id,
        after: {
          lineId: extra[0],
          stayId: stay.id,
          occupantId: person.id,
          night: args.night,
          amountMinor: person.nightlyChargeMinor,
        },
      });
    }
  }
  return { posted: true, amountMinor: price.roomMinor + extraMinor };
}

/**
 * Posts a package night's components (step 5), each once: a component already on the folio
 * for that day, reversed or not, is not posted again. Answers how many lines it posted.
 */
export async function postPackageNight(
  ctx: Ctx,
  args: { stayId: string; night: string; businessDate: string; clock: Clock },
): Promise<number> {
  const { tx } = ctx;
  await lockStay(tx, args.stayId);
  const stay = await stayFor(tx, args.stayId);
  if (stay.ratePlan.kind !== 'PACKAGE' || stay.ratePlan.components.length === 0) return 0;
  const price = priceOf(stay, args.night);
  const folio = await folioFor(tx, stay, args.clock, args.businessDate);
  const codes = await tx.revenueCode.findMany({
    where: { id: { in: stay.ratePlan.components.map((c) => c.revenueCodeId) } },
  });
  let posted = 0;
  for (const [i, part] of price.components.entries()) {
    const component = stay.ratePlan.components[i];
    const code = codes.find((c) => c.id === part.revenueCodeId);
    if (!component || !code || part.amountMinor === 0n) continue;
    const already = await tx.folioLine.findFirst({
      where: {
        folioId: folio.id,
        sourceType: 'PACKAGE',
        sourceId: component.id,
        businessDate: dbDate(args.businessDate),
      },
    });
    if (already) continue;
    const windowId = routedWindow(folio, code);
    if (!windowId) continue;
    const ids = await postChargeLines(ctx, {
      folio,
      windowId,
      code,
      description: `${part.name}, night of ${args.night}`,
      quantity: 1,
      unitAmountMinor: part.amountMinor,
      note: null,
      sourceType: 'PACKAGE',
      sourceId: component.id,
      businessDate: args.businessDate,
    });
    await recordAudit(tx, {
      action: 'folio.package_posted',
      entityType: 'folio',
      entityId: folio.id,
      after: { lineId: ids[0], stayId: stay.id, night: args.night, component: part.name },
    });
    posted += 1;
  }
  return posted;
}

/** A day-use stay's price goes on the bill when the guest checks in (it is not a night). */
export async function postDayUse(ctx: Ctx, stay: { id: string; arrival: Date }, clock: Clock) {
  const night = day(stay.arrival);
  await postRoomNight(ctx, { stayId: stay.id, night, businessDate: night, clock });
  await postPackageNight(ctx, { stayId: stay.id, night, businessDate: night, clock });
}
