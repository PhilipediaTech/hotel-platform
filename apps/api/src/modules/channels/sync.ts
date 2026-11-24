import { createHash } from 'node:crypto';
import { addDays, INVENTORY_DAYS, localDate } from '@hotel/shared';
import type { Logger } from 'pino';
import type { Prisma, RateDay } from '../../generated/prisma/client.ts';
import {
  ChannelError,
  type ChannelAvailabilityValue,
  type ChannelManager,
  type ChannelPushResult,
  type ChannelRestrictionValue,
} from '../../core/channel-manager.ts';
import type { Clock } from '../../core/clock.ts';
import { pgErrorInfo, type Db } from '../../core/db.ts';
import { decimal } from '../../core/exports.ts';
import { defineJob } from '../../core/jobs.ts';
import { sellingPrice } from '../rates/service.ts';

// Availability, prices and restrictions to the channel manager (PRD M11-07; T-152).
//
// Every minute the worker works out, for each active connection, what the channel manager
// should show from today to the end of the inventory horizon: rooms left per mapped room
// type, and per mapped rate plan its price (derived plans worked out from their parent) and
// restrictions. It compares that with what the channel manager last accepted
// (channel_ari_sent) and sends only the dates that differ, as date ranges. So nothing is
// queued that can be lost: a send that fails, or is cut short by the rate limit, is simply
// still different on the next run and goes again.
//
// - Work starts at once when a database trigger has left a sign of change, and at the latest
//   every 15 minutes (a safety net for any write the triggers do not see).
// - Channex allows 10 calls a minute per property for each endpoint; a run makes at most 4
//   of each, and runs never overlap (a lease), so no minute sees more than 8.
// - A refused or failed send waits: Retry-After when given, else 1, 2, 4… up to 30 minutes.
// - A 200 with warnings is logged as WARNING and counts as sent.
// - Once a day (and on request) everything is sent again: what was sent is forgotten, and
//   the same comparison then sends it all, over as many runs as the rate limit needs.
// - T-154 (Channex certification): changes are sent once they have been quiet for two minutes
//   (at the latest ten minutes after the first), so edits made one after another go in one
//   call, as Channex requires; the daily full send runs off-peak, at a time between 02:00
//   and 05:00 hotel time fixed per property, so properties are spread out.
// - A night with no price is sent as stop-sell; a plan taken off (unticked, deactivated) is
//   closed on every date once. OTAs get rooms left without the overbooking allowance.

const CHUNK = 2000;
const CALLS_PER_RUN = 4;
const LEASE_MS = 5 * 60_000;
const CHECK_EVERY_MS = 15 * 60_000;
/** Changes wait for this much quiet, so edits made one after another go in one call. */
const QUIET_MS = 2 * 60_000;
/** …but never longer than this after the first change. */
const BATCH_MAX_MS = 10 * 60_000;
/** The daily full send starts between 02:00 and 04:59 hotel time (off-peak, per Channex). */
const SLOT_FROM_MINUTES = 2 * 60;
const SLOT_SPREAD_MINUTES = 3 * 60;
const MAX_WAIT_MS = 30 * 60_000;

export interface SyncOptions {
  /** Values per call (2000). */
  chunk?: number;
  /** Calls per endpoint per run (4). */
  callsPerRun?: number;
  /** Quiet needed after the last change before sending (2 minutes). */
  quietMs?: number;
}

type Kind = 'AVAILABILITY' | 'RESTRICTIONS';

/** One mapping's wanted value per date, encoded as a string to compare with what was sent. */
interface Wanted {
  mappingId: string;
  kind: Kind;
  externalId: string;
  values: Map<string, string>;
}

interface Range {
  mappingId: string;
  externalId: string;
  dateFrom: string;
  dateTo: string;
  value: string;
}

const day = (d: Date) => d.toISOString().slice(0, 10);
const dbDate = (date: string) => new Date(`${date}T00:00:00Z`);

// ── Encoding ───────────────────────────────────────────────────────────────────────────

interface Restriction {
  rate: string | null;
  minStay: number;
  maxStay: number;
  cta: boolean;
  ctd: boolean;
  stopSell: boolean;
}

const CLOSED: Restriction = {
  rate: null,
  minStay: 1,
  maxStay: 0,
  cta: false,
  ctd: false,
  stopSell: true,
};

export function encodeRestriction(r: Restriction): string {
  const flag = (b: boolean) => (b ? '1' : '0');
  return [r.rate ?? '', r.minStay, r.maxStay, flag(r.cta), flag(r.ctd), flag(r.stopSell)].join('|');
}

function decodeRestriction(value: string): Restriction {
  const [rate = '', min = '1', max = '0', cta, ctd, stop] = value.split('|');
  return {
    rate: rate === '' ? null : rate,
    minStay: Number(min),
    maxStay: Number(max),
    cta: cta === '1',
    ctd: ctd === '1',
    stopSell: stop === '1',
  };
}

/** What a rate day sells as: no price → stop-sell. */
export function restrictionOf(own: RateDay | undefined, price: bigint | null): Restriction {
  if (price === null) return CLOSED;
  return {
    rate: decimal(price),
    minStay: Math.max(1, own?.minStay ?? 1),
    maxStay: own?.maxStay ?? 0,
    cta: own?.closedToArrival ?? false,
    ctd: own?.closedToDeparture ?? false,
    stopSell: own?.stopSell ?? false,
  };
}

/**
 * Dates whose wanted value differs from the sent one, joined into ranges of consecutive dates
 * with the same value.
 */
export function changedRanges(
  wanted: Wanted,
  sent: Record<string, string>,
  dates: readonly string[],
): Range[] {
  const out: Range[] = [];
  let open: Range | null = null;
  let previous: string | null = null;
  for (const date of dates) {
    const value = wanted.values.get(date);
    const changed = value !== undefined && sent[date] !== value;
    if (changed && open && open.value === value && previous === open.dateTo) {
      open.dateTo = date;
    } else if (changed) {
      open = {
        mappingId: wanted.mappingId,
        externalId: wanted.externalId,
        dateFrom: date,
        dateTo: date,
        value,
      };
      out.push(open);
    } else {
      open = null;
    }
    previous = date;
  }
  return out;
}

// ── What the channel manager should show ──────────────────────────────────────────────

type Connection = Prisma.ChannelConnectionGetPayload<{ include: { mappings: true } }>;

async function wantedValues(db: Db, connection: Connection, dates: string[]): Promise<Wanted[]> {
  const propertyId = connection.propertyId;
  const range = { gte: dbDate(dates[0] ?? ''), lte: dbDate(dates.at(-1) ?? '') };
  const typeMaps = connection.mappings.filter((m) => m.kind === 'ROOM_TYPE');
  const rateMaps = connection.mappings.filter((m) => m.kind === 'RATE_PLAN');

  const [types, inventory] = await Promise.all([
    db.roomType.findMany({ where: { propertyId } }),
    db.roomTypeInventory.findMany({
      where: { propertyId, roomTypeId: { in: typeMaps.map((m) => m.roomTypeId) }, date: range },
    }),
  ]);
  const activeType = new Map(types.map((t) => [t.id, t.active]));
  const left = new Map(
    inventory.map((i) => [
      `${i.roomTypeId}|${day(i.date)}`,
      Math.max(0, i.capacity - i.outOfOrder - i.sold - i.held),
    ]),
  );
  const out: Wanted[] = typeMaps.map((m) => ({
    mappingId: m.id,
    kind: 'AVAILABILITY',
    externalId: m.externalId,
    values: new Map(
      dates.map((date) => [
        date,
        String(activeType.get(m.roomTypeId) ? (left.get(`${m.roomTypeId}|${date}`) ?? 0) : 0),
      ]),
    ),
  }));

  const planIds = [...new Set(rateMaps.map((m) => m.ratePlanId ?? ''))];
  const plans = await db.ratePlan.findMany({ where: { propertyId, id: { in: planIds } } });
  const parentIds = plans.flatMap((p) => (p.parentRatePlanId ? [p.parentRatePlanId] : []));
  const days = await db.rateDay.findMany({
    where: { propertyId, ratePlanId: { in: [...planIds, ...parentIds] }, date: range },
  });
  const dayBy = new Map(days.map((d) => [`${d.ratePlanId}|${d.roomTypeId}|${day(d.date)}`, d]));
  const planBy = new Map(plans.map((p) => [p.id, p]));
  for (const m of rateMaps) {
    const plan = planBy.get(m.ratePlanId ?? '');
    const sells =
      m.active &&
      plan?.active === true &&
      activeType.get(m.roomTypeId) === true &&
      (plan.roomTypeIds.length === 0 || plan.roomTypeIds.includes(m.roomTypeId));
    const values = new Map<string, string>();
    for (const date of dates) {
      if (!sells) {
        values.set(date, encodeRestriction(CLOSED));
        continue;
      }
      const own = dayBy.get(`${plan.id}|${m.roomTypeId}|${date}`);
      const parent = plan.parentRatePlanId
        ? dayBy.get(`${plan.parentRatePlanId}|${m.roomTypeId}|${date}`)
        : undefined;
      values.set(date, encodeRestriction(restrictionOf(own, sellingPrice(plan, own, parent))));
    }
    out.push({ mappingId: m.id, kind: 'RESTRICTIONS', externalId: m.externalId, values });
  }
  return out;
}

// ── Sending ────────────────────────────────────────────────────────────────────────────

async function log(
  db: Db,
  connection: Connection,
  entry: {
    kind: Kind | 'FULL_SYNC';
    status: 'OK' | 'WARNING' | 'FAILED';
    items: number;
    taskId?: string | null;
    message?: string | null;
    details?: unknown;
  },
) {
  await db.channelSyncLog.create({
    data: {
      propertyId: connection.propertyId,
      connectionId: connection.id,
      kind: entry.kind,
      status: entry.status,
      items: entry.items,
      taskId: entry.taskId ?? null,
      message: entry.message ?? null,
      ...(entry.details !== undefined ? { details: entry.details as Prisma.InputJsonValue } : {}),
    },
  });
}

/** Saves the ranges just accepted as what the channel manager now shows. */
async function remember(db: Db, connection: Connection, ranges: Range[], today: string) {
  const byMapping = new Map<string, Range[]>();
  for (const r of ranges) byMapping.set(r.mappingId, [...(byMapping.get(r.mappingId) ?? []), r]);
  await db.$transaction(async (tx) => {
    for (const [mappingId, mine] of byMapping) {
      const row = await tx.channelAriSent.findUnique({ where: { mappingId } });
      const values: Record<string, string> = {};
      for (const [date, v] of Object.entries((row?.values ?? {}) as Record<string, string>)) {
        if (date >= today) values[date] = v;
      }
      for (const r of mine) {
        for (let date = r.dateFrom; date <= r.dateTo; date = addDays(date, 1)) {
          values[date] = r.value;
        }
      }
      await tx.channelAriSent.upsert({
        where: { mappingId },
        create: {
          mappingId,
          propertyId: connection.propertyId,
          connectionId: connection.id,
          values,
        },
        update: { values },
      });
    }
  });
}

function toChannel(kind: Kind, propertyId: string, ranges: Range[]) {
  if (kind === 'AVAILABILITY') {
    return ranges.map((r): ChannelAvailabilityValue => ({
      propertyId,
      roomTypeId: r.externalId,
      dateFrom: r.dateFrom,
      dateTo: r.dateTo,
      availability: Number(r.value),
    }));
  }
  return ranges.map((r): ChannelRestrictionValue => {
    const v = decodeRestriction(r.value);
    return {
      propertyId,
      ratePlanId: r.externalId,
      dateFrom: r.dateFrom,
      dateTo: r.dateTo,
      ...(v.rate !== null ? { rate: v.rate } : {}),
      minStayArrival: v.minStay,
      maxStay: v.maxStay,
      closedToArrival: v.cta,
      closedToDeparture: v.ctd,
      stopSell: v.stopSell,
    };
  });
}

/** Wait after the n-th failure in a row: Retry-After when longer, else 1, 2, 4… ≤ 30 min. */
export function retryDelayMs(failures: number, retryAfterSeconds: number | null): number {
  const backoff = Math.min(MAX_WAIT_MS, 60_000 * 2 ** Math.max(0, failures - 1));
  return Math.max(backoff, (retryAfterSeconds ?? 0) * 1000);
}

/** Minutes after local midnight of this property's daily full send: 02:00–04:59, spread. */
export function fullSyncSlot(propertyId: string): number {
  const n = createHash('sha256').update(propertyId).digest().readUInt16BE(0);
  return SLOT_FROM_MINUTES + (n % SLOT_SPREAD_MINUTES);
}

/** The latest time the property's daily slot came round (now, if it is that minute). */
export function lastFullSyncSlot(now: Date, timeZone: string, slot: number): Date {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const minutes = part('hour') * 60 + part('minute');
  const since = (minutes - slot + 1440) % 1440;
  const intoMinute = now.getUTCSeconds() * 1000 + now.getUTCMilliseconds();
  return new Date(now.getTime() - since * 60_000 - intoMinute);
}

export type SyncOutcome = 'SKIPPED' | 'WAITING' | 'UP_TO_DATE' | 'SENT' | 'MORE_TO_SEND' | 'FAILED';

/** One run for one connection: claim it, compare, send what differs. */
export async function syncConnection(
  db: Db,
  channel: ChannelManager,
  clock: Clock,
  connectionId: string,
  options: SyncOptions = {},
): Promise<SyncOutcome> {
  const chunk = options.chunk ?? CHUNK;
  const calls = options.callsPerRun ?? CALLS_PER_RUN;
  const quietMs = options.quietMs ?? QUIET_MS;
  const now = clock();
  const claimed = await db.channelConnection.updateMany({
    where: {
      id: connectionId,
      status: 'ACTIVE',
      externalPropertyId: { not: null },
      AND: [
        { OR: [{ syncLockedUntil: null }, { syncLockedUntil: { lt: now } }] },
        { OR: [{ syncRetryAt: null }, { syncRetryAt: { lte: now } }] },
      ],
    },
    data: { syncLockedUntil: new Date(now.getTime() + LEASE_MS) },
  });
  if (claimed.count !== 1) return 'SKIPPED';
  let connection = await db.channelConnection.findUniqueOrThrow({
    where: { id: connectionId },
    // Oldest mapping first, so the order of what is sent never changes between runs.
    include: { mappings: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } },
  });
  const release = (data: Prisma.ChannelConnectionUpdateInput) =>
    db.channelConnection.update({
      where: { id: connectionId },
      data: { ...data, syncLockedUntil: null },
    });

  try {
    const property = await db.property.findUniqueOrThrow({
      where: { id: connection.propertyId },
      select: { timeZone: true },
    });
    // Daily, off-peak: forget what was sent, so everything goes again.
    const slot = lastFullSyncSlot(now, property.timeZone, fullSyncSlot(connection.propertyId));
    const fullDue =
      !connection.fullSyncPending && (!connection.fullSyncAt || connection.fullSyncAt < slot);
    if (fullDue) {
      await db.$transaction([
        db.channelAriSent.deleteMany({ where: { connectionId } }),
        db.channelConnection.update({
          where: { id: connectionId },
          data: { fullSyncPending: true },
        }),
      ]);
      connection = { ...connection, fullSyncPending: true };
    }
    const lastChange = await db.channelAriChange.findFirst({
      where: { propertyId: connection.propertyId },
      orderBy: { id: 'desc' },
      select: { id: true },
    });
    const due =
      connection.fullSyncPending ||
      lastChange !== null ||
      !connection.ariCheckedAt ||
      now.getTime() - connection.ariCheckedAt.getTime() >= CHECK_EVERY_MS;
    if (!due) {
      await release({});
      return 'SKIPPED';
    }
    // Edits still coming: wait for them all, so they go in one call (database time: the
    // triggers stamp changes with it).
    if (lastChange && !connection.fullSyncPending && quietMs > 0) {
      const [w] = await db.$queryRaw<{ recent: boolean | null; overdue: boolean | null }[]>`
        SELECT bool_or(at > now() - ${quietMs} * interval '1 millisecond') AS recent,
               bool_or(at <= now() - ${BATCH_MAX_MS} * interval '1 millisecond') AS overdue
        FROM channel_ari_changes WHERE property_id = ${connection.propertyId}::uuid`;
      if (w?.recent && !w.overdue) {
        await release({});
        return 'WAITING';
      }
    }

    const today = localDate(now, property.timeZone);
    const dates = Array.from({ length: INVENTORY_DAYS }, (_, i) => addDays(today, i));
    const wanted = await wantedValues(db, connection, dates);
    const sentRows = await db.channelAriSent.findMany({ where: { connectionId } });
    const sentBy = new Map(sentRows.map((r) => [r.mappingId, r.values as Record<string, string>]));
    const pending: Record<Kind, Range[]> = { AVAILABILITY: [], RESTRICTIONS: [] };
    for (const w of wanted) {
      pending[w.kind].push(...changedRanges(w, sentBy.get(w.mappingId) ?? {}, dates));
    }

    let sent = 0;
    let more = false;
    const propertyId = connection.externalPropertyId ?? '';
    for (const kind of ['AVAILABILITY', 'RESTRICTIONS'] as const) {
      const ranges = pending[kind];
      for (let i = 0; i < ranges.length; i += chunk) {
        if (i / chunk >= calls) {
          more = true;
          break;
        }
        const batch = ranges.slice(i, i + chunk);
        const values = toChannel(kind, propertyId, batch);
        let result: ChannelPushResult;
        try {
          result =
            kind === 'AVAILABILITY'
              ? await channel.updateAvailability(values as ChannelAvailabilityValue[])
              : await channel.updateRestrictions(values as ChannelRestrictionValue[]);
        } catch (err) {
          if (!(err instanceof ChannelError)) throw err;
          const failures = connection.syncFailures + 1;
          await log(db, connection, {
            kind,
            status: 'FAILED',
            items: batch.length,
            message: err.message,
            ...(err.details ? { details: { channel: err.details } } : {}),
          });
          await release({
            syncFailures: failures,
            syncError: err.message,
            syncRetryAt: new Date(now.getTime() + retryDelayMs(failures, err.retryAfterSeconds)),
          });
          return 'FAILED';
        }
        await remember(db, connection, batch, today);
        sent += batch.length;
        const warned = result.warnings.length > 0;
        await log(db, connection, {
          kind,
          status: warned ? 'WARNING' : 'OK',
          items: batch.length,
          taskId: result.taskId,
          message: warned ? `${result.warnings.length} values were not taken as sent` : null,
          ...(warned ? { details: { warnings: result.warnings.slice(0, 50) } } : {}),
        });
      }
    }

    if (more) {
      // The rest goes on the next run; the sign of change stays.
      await release({ syncFailures: 0, syncError: null, syncRetryAt: null });
      return 'MORE_TO_SEND';
    }
    if (lastChange) {
      await db.channelAriChange.deleteMany({
        where: { propertyId: connection.propertyId, id: { lte: lastChange.id } },
      });
    }
    if (connection.fullSyncPending) {
      await log(db, connection, {
        kind: 'FULL_SYNC',
        status: 'OK',
        items: sent,
        message: 'Everything was sent again',
      });
    }
    await release({
      ariCheckedAt: now,
      syncFailures: 0,
      syncError: null,
      syncRetryAt: null,
      ...(connection.fullSyncPending ? { fullSyncPending: false, fullSyncAt: now } : {}),
    });
    return sent > 0 ? 'SENT' : 'UP_TO_DATE';
  } catch (err) {
    await release({}).catch(() => undefined);
    throw err;
  }
}

/** Every minute: each active connection whose turn it is (M11-07). */
export async function syncAll(
  db: Db,
  channel: ChannelManager,
  clock: Clock,
  logger: Logger,
  options: SyncOptions = {},
): Promise<void> {
  if (channel.name === 'OFF') return;
  const now = clock();
  const connections = await db.channelConnection.findMany({
    where: {
      status: 'ACTIVE',
      externalPropertyId: { not: null },
      OR: [{ syncRetryAt: null }, { syncRetryAt: { lte: now } }],
    },
    select: { id: true, propertyId: true },
    orderBy: { createdAt: 'asc' },
  });
  for (const c of connections) {
    try {
      const outcome = await syncConnection(db, channel, clock, c.id, options);
      if (outcome !== 'SKIPPED' && outcome !== 'WAITING' && outcome !== 'UP_TO_DATE') {
        logger.info({ propertyId: c.propertyId, outcome }, 'Channel sync');
      }
    } catch (err) {
      // One property's problem never stops the others.
      logger.error({ propertyId: c.propertyId, db: pgErrorInfo(err) }, 'Channel sync failed');
    }
  }
}

export const channelSyncJob = (deps: { channel: ChannelManager }) =>
  defineJob({
    name: 'channel-sync',
    schedule: { cron: '* * * * *' },
    // A run that hangs gives way to the next one.
    options: { expireInSeconds: 5 * 60, retryLimit: 0 },
    run: (_data, ctx) => syncAll(ctx.db, deps.channel, ctx.clock, ctx.logger),
  });
