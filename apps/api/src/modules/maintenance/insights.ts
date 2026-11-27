import {
  addDays,
  INSIGHT_FACTOR_BPS,
  INSIGHT_USUAL_DAYS,
  localDate,
  METER_RUN,
  REPEAT_FAULT_COUNT,
  REPEAT_FAULT_DAYS,
  type MaintenanceInsight,
} from '@hotel/shared';
import type { z } from 'zod';
import { recordAudit } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import type { MaintenanceDeps } from './service.ts';

// Maintenance insights (Versions V3 "maintenance anomaly insights"; T-180; Philip approved the
// story, with rules for the figures, and a table for dismissals, 2026-11-27). Worked out from
// the records each time, so they always match what the screens show:
// - repeat faults: 3 or more faults on one asset (or, without an asset, one room) in 30 days;
// - a reopened fault: a fault reopened in the last 30 days;
// - meter use: use per occupied room night above 1.5 times its usual (the median of the
//   earlier intervals in the last 8 weeks) for the last 3 readings in a row;
// - generator fuel: diesel per run-hour between the last two level checks above 1.5 times the
//   usual between earlier checks. (The FUEL_VARIANCE leakage rule looks at fuel that went
//   missing; this looks at fuel the generator burnt.)
// Overdue preventive jobs on the same equipment put an insight first. A dismissal keeps the
// insight's key and evidence: new evidence brings it back.

type Insight = z.input<typeof MaintenanceInsight>;

const DAY = 86_400_000;
const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const OCCUPIED = ['CHECKED_IN', 'CHECKED_OUT'] as const;

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)] ?? null;
}
const above = (value: number, usual: number) => value * 10_000 > usual * INSIGHT_FACTOR_BPS;

export async function maintenanceInsights(
  deps: MaintenanceDeps,
  tenant: TenantContext,
): Promise<Insight[]> {
  const db = deps.tenantDb;
  const now = deps.clock();
  const property = await db.property.findUniqueOrThrow({ where: { id: tenant.propertyId } });
  const zone = property.timeZone;
  const today = localDate(now, zone);
  const faultsFrom = new Date(now.getTime() - REPEAT_FAULT_DAYS * DAY);
  const usualFrom = new Date(now.getTime() - INSIGHT_USUAL_DAYS * DAY);

  const [faults, reopened, plans, assets] = await Promise.all([
    db.task.findMany({
      where: { type: 'FAULT', createdAt: { gte: faultsFrom } },
      select: {
        id: true,
        createdAt: true,
        priority: true,
        roomId: true,
        assetId: true,
        room: { select: { number: true } },
        asset: { select: { tag: true, name: true, roomId: true } },
      },
      orderBy: { createdAt: 'desc' },
    }),
    db.task.findMany({
      where: { type: 'FAULT', events: { some: { kind: 'reopen', at: { gte: faultsFrom } } } },
      select: {
        id: true,
        number: true,
        roomId: true,
        assetId: true,
        room: { select: { number: true } },
        asset: { select: { tag: true, name: true, roomId: true } },
        events: {
          where: { kind: 'reopen', at: { gte: faultsFrom } },
          select: { id: true, at: true },
          orderBy: { at: 'desc' },
        },
      },
    }),
    db.preventivePlan.findMany({
      where: { active: true, assetId: { not: null }, nextDueOn: { lt: new Date(today) } },
      select: { assetId: true },
    }),
    db.asset.findMany({ select: { id: true, roomId: true } }),
  ]);

  const overdueByAsset = new Map<string, number>();
  for (const p of plans) {
    if (p.assetId) overdueByAsset.set(p.assetId, (overdueByAsset.get(p.assetId) ?? 0) + 1);
  }
  const overdueFor = (assetId: string | null, roomId: string | null) =>
    assetId
      ? (overdueByAsset.get(assetId) ?? 0)
      : assets
          .filter((a) => roomId && a.roomId === roomId)
          .reduce((n, a) => n + (overdueByAsset.get(a.id) ?? 0), 0);
  const subjectOf = (t: (typeof faults)[number] | (typeof reopened)[number]) =>
    t.assetId && t.asset
      ? {
          type: 'ASSET' as const,
          id: t.assetId,
          label: `${t.asset.tag} ${t.asset.name}`,
          roomId: t.roomId ?? t.asset.roomId,
        }
      : t.roomId && t.room
        ? { type: 'ROOM' as const, id: t.roomId, label: `Room ${t.room.number}`, roomId: t.roomId }
        : null;

  const out: Insight[] = [];

  // Repeat faults, by asset or else by room.
  const groups = new Map<string, typeof faults>();
  for (const f of faults) {
    const s = subjectOf(f);
    if (!s) continue;
    const key = `${s.type}:${s.id}`;
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  for (const [subjectKey, list] of groups) {
    if (list.length < REPEAT_FAULT_COUNT) continue;
    const [newest] = list;
    const s = newest ? subjectOf(newest) : null;
    if (!newest || !s) continue;
    const overdue = overdueFor(s.type === 'ASSET' ? s.id : null, s.roomId);
    out.push({
      key: `REPEAT_FAULTS:${subjectKey}`,
      fingerprint: newest.id,
      kind: 'REPEAT_FAULTS',
      severity:
        list.length >= REPEAT_FAULT_COUNT + 2 || list.some((t) => t.priority === 'CRITICAL')
          ? 'HIGH'
          : 'NORMAL',
      subject: { type: s.type, id: s.id, label: s.label },
      roomId: s.roomId,
      value: list.length,
      usual: null,
      taskIds: list.map((t) => t.id),
      overduePlans: overdue,
      since: iso(list.at(-1)?.createdAt ?? now),
    });
  }

  // Faults reopened: the fix didn't hold.
  for (const t of reopened) {
    const s = subjectOf(t);
    const [latest] = t.events;
    if (!s || !latest) continue;
    out.push({
      key: `REOPENED_FAULT:TASK:${t.id}`,
      fingerprint: latest.id.toString(),
      kind: 'REOPENED_FAULT',
      severity: t.events.length > 1 ? 'HIGH' : 'NORMAL',
      subject: { type: s.type, id: s.id, label: `${s.label} (#${t.number})` },
      roomId: s.roomId,
      value: t.events.length,
      usual: null,
      taskIds: [t.id],
      overduePlans: overdueFor(s.type === 'ASSET' ? s.id : null, s.roomId),
      since: iso(t.events.at(-1)?.at ?? now),
    });
  }

  out.push(...(await meterInsights(deps, zone, usualFrom, today)));
  out.push(...(await generatorInsights(deps, usualFrom, overdueByAsset)));

  return out.sort(
    (a, b) =>
      Number(b.overduePlans > 0) - Number(a.overduePlans > 0) ||
      Number(b.severity === 'HIGH') - Number(a.severity === 'HIGH') ||
      b.since.localeCompare(a.since),
  );
}

/** Meter use per occupied room night, interval by interval between readings. */
async function meterInsights(
  deps: MaintenanceDeps,
  zone: string,
  usualFrom: Date,
  today: string,
): Promise<Insight[]> {
  const db = deps.tenantDb;
  const readings = await db.meterReading.findMany({
    where: { at: { gte: new Date(usualFrom.getTime() - 7 * DAY) } },
    orderBy: { at: 'asc' },
    select: { id: true, meter: true, reading: true, at: true },
  });
  if (readings.length < METER_RUN + 2) return [];
  const firstDay = localDate(readings[0]?.at ?? usualFrom, zone);
  const stays = await db.stay.findMany({
    where: {
      status: { in: [...OCCUPIED] },
      isDayUse: false,
      nights: { some: { date: { gte: new Date(firstDay), lte: new Date(today) } } },
    },
    select: { nights: { select: { date: true } } },
  });
  const occupied = new Map<string, number>();
  for (const st of stays) {
    for (const n of st.nights) {
      const d = n.date.toISOString().slice(0, 10);
      occupied.set(d, (occupied.get(d) ?? 0) + 1);
    }
  }
  /** Room nights from the day of `a` up to (not including) the day of `b`. */
  const roomNights = (a: Date, b: Date) => {
    let n = 0;
    for (let d = localDate(a, zone); d < localDate(b, zone); d = addDays(d, 1)) {
      n += occupied.get(d) ?? 0;
    }
    return n;
  };

  const byMeter = new Map<string, typeof readings>();
  for (const r of readings) byMeter.set(r.meter, [...(byMeter.get(r.meter) ?? []), r]);
  const out: Insight[] = [];
  for (const [meter, list] of byMeter) {
    // Use per occupied room night, in hundredths.
    const intervals: { per: number; end: (typeof list)[number] }[] = [];
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1];
      const cur = list[i];
      if (!prev || !cur) continue;
      const nights = roomNights(prev.at, cur.at);
      const used = cur.reading - prev.reading;
      if (nights <= 0 || used < 0n) continue;
      intervals.push({ per: Number((used * 100n) / BigInt(nights)), end: cur });
    }
    const recent = intervals.slice(-METER_RUN);
    const earlier = intervals
      .slice(0, -METER_RUN)
      .filter((x) => x.end.at >= usualFrom)
      .map((x) => x.per);
    const usual = median(earlier);
    const last = recent.at(-1);
    if (recent.length < METER_RUN || earlier.length < 2 || usual === null || !last) continue;
    if (!recent.every((x) => above(x.per, usual))) continue;
    out.push({
      key: `METER_USE:METER:${meter}`,
      fingerprint: last.end.id,
      kind: 'METER_USE',
      severity: above(last.per, usual * 2) ? 'HIGH' : 'NORMAL',
      subject: { type: 'METER', id: null, label: meter },
      roomId: null,
      value: last.per,
      usual,
      taskIds: [],
      overduePlans: 0,
      since: iso(recent[0]?.end.at ?? last.end.at),
    });
  }
  return out;
}

/** Diesel burnt per run-hour between level checks. */
async function generatorInsights(
  deps: MaintenanceDeps,
  usualFrom: Date,
  overdueByAsset: Map<string, number>,
): Promise<Insight[]> {
  const generators = await deps.tenantDb.generator.findMany({
    select: {
      id: true,
      name: true,
      assetId: true,
      fuelMovements: {
        where: { at: { gte: new Date(usualFrom.getTime() - 7 * DAY) } },
        orderBy: { at: 'asc' },
        select: { id: true, kind: true, litresMilli: true, at: true },
      },
      runs: {
        where: {
          OR: [
            { stoppedAt: null },
            { stoppedAt: { gte: new Date(usualFrom.getTime() - 7 * DAY) } },
          ],
        },
        select: { startedAt: true, stoppedAt: true },
      },
    },
  });
  const now = deps.clock();
  const out: Insight[] = [];
  for (const g of generators) {
    const minutesIn = (a: Date, b: Date) =>
      g.runs.reduce((sum, r) => {
        const start = r.startedAt > a ? r.startedAt : a;
        const end = (r.stoppedAt ?? now) < b ? (r.stoppedAt ?? now) : b;
        return end > start ? sum + (end.getTime() - start.getTime()) / 60_000 : sum;
      }, 0);
    // Windows between consecutive level checks: litres (thousandths) burnt per run-hour.
    const windows: { perHour: number; end: { id: string; at: Date } }[] = [];
    let opening: { id: string; litresMilli: number; at: Date } | null = null;
    let received = 0;
    let issued = 0;
    for (const m of g.fuelMovements) {
      if (m.kind === 'RECEIVED') received += m.litresMilli;
      else if (m.kind === 'ISSUED') issued += m.litresMilli;
      else if (m.kind === 'LEVEL_CHECK') {
        if (opening) {
          const burnt = opening.litresMilli + received - issued - m.litresMilli;
          const minutes = minutesIn(opening.at, m.at);
          if (minutes >= 60 && burnt >= 0) {
            windows.push({ perHour: Math.round((burnt * 60) / minutes), end: m });
          }
        }
        opening = m;
        received = 0;
        issued = 0;
      }
    }
    const last = windows.at(-1);
    const usual = median(
      windows
        .slice(0, -1)
        .filter((w) => w.end.at >= usualFrom)
        .map((w) => w.perHour),
    );
    const compared = windows.slice(0, -1).filter((w) => w.end.at >= usualFrom).length;
    if (!last || usual === null || compared < 2 || !above(last.perHour, usual)) continue;
    out.push({
      key: `GENERATOR_FUEL:GENERATOR:${g.id}`,
      fingerprint: last.end.id,
      kind: 'GENERATOR_FUEL',
      severity: above(last.perHour, usual * 2) ? 'HIGH' : 'NORMAL',
      subject: { type: 'GENERATOR', id: g.id, label: g.name },
      roomId: null,
      value: last.perHour,
      usual,
      taskIds: [],
      overduePlans: overdueByAsset.get(g.assetId) ?? 0,
      since: iso(last.end.at),
    });
  }
  return out;
}

/** The insights to show now: those nobody dismissed with the same evidence. */
export async function listInsights(deps: MaintenanceDeps, tenant: TenantContext) {
  const all = await maintenanceInsights(deps, tenant);
  const dismissals = await deps.tenantDb.insightDismissal.findMany({
    where: { key: { in: all.map((i) => i.key) } },
    select: { key: true, fingerprint: true },
  });
  const hidden = new Set(dismissals.map((d) => `${d.key}|${d.fingerprint}`));
  const data = all.filter((i) => !hidden.has(`${i.key}|${i.fingerprint}`));
  return { data, dismissed: all.length - data.length };
}

export async function dismissInsight(
  deps: MaintenanceDeps,
  tenant: TenantContext,
  body: { key: string; fingerprint: string; reason: string },
) {
  const { data } = await listInsights(deps, tenant);
  const insight = data.find((i) => i.key === body.key && i.fingerprint === body.fingerprint);
  if (!insight) {
    throw new AppError('NOT_FOUND', 'That insight has changed or was already dismissed.');
  }
  await deps.tenantDb.$transaction(async (tx) => {
    const row = await tx.insightDismissal.create({
      data: {
        propertyId: tenant.propertyId,
        key: body.key,
        fingerprint: body.fingerprint,
        reason: body.reason,
        byUserId: tenant.userId,
        at: deps.clock(),
      },
    });
    await recordAudit(tx, {
      action: 'insight.dismissed',
      entityType: 'insight_dismissal',
      entityId: row.id,
      after: { kind: insight.kind, subject: insight.subject.label, reason: body.reason },
    });
  });
  return { dismissed: true as const };
}
