import {
  addDays,
  localDate,
  type CommissionCalculateBody,
  type CommissionCalculateResult,
  type CommissionItem,
  type CommissionSettleBody,
} from '@hotel/shared';
import type { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client.ts';
import { recordAudit } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import { allocateIn, type ArDeps } from './service.ts';

// Travel-agent commissions (PRD M4-22; T-127). A stay checked out from a booking made through a
// travel agent earns the agent's commission rate (company.commission_bps, kept on the
// commission as it was then) on the stay's room revenue net of tax: the room-group charges on
// its folio, less their discounts and reversals. Taxes, food and drink, and anything moved in
// from other folios do not count. Finance runs the calculation for a period; running it again
// adds stays that are new and brings due commissions up to date (a late reversal, say), but a
// commission paid or set off never changes. Settling marks them PAID (paid to the agent outside
// the system), or OFFSET: a credit for the total on the agent's city-ledger account, allocated
// to its oldest open invoices.

type TenantTx = Parameters<Parameters<ArDeps['tenantDb']['$transaction']>[0]>[0];
type Item = z.input<typeof CommissionItem>;

const day = (d: Date) => d.toISOString().slice(0, 10);
const dbDate = (date: string) => new Date(`${date}T00:00:00Z`);
const invalid = (path: string, message: string) =>
  new AppError('VALIDATION_ERROR', message, {
    issues: [{ path: `body.${path}`, code: 'custom', message }],
  });

const INCLUDE = {
  travelAgent: { select: { id: true, name: true } },
  stay: {
    select: {
      id: true,
      arrival: true,
      departure: true,
      guest: { select: { firstName: true, lastName: true } },
      reservation: { select: { confirmationNo: true } },
    },
  },
} satisfies Prisma.CommissionInclude;
type Row = Prisma.CommissionGetPayload<{ include: typeof INCLUDE }>;

function itemOf(c: Row): Item {
  return {
    id: c.id,
    agent: c.travelAgent,
    stay: {
      id: c.stay.id,
      confirmationNo: c.stay.reservation.confirmationNo,
      guestName: `${c.stay.guest.firstName} ${c.stay.guest.lastName}`,
      arrival: day(c.stay.arrival),
      departure: day(c.stay.departure),
    },
    checkedOutOn: day(c.checkedOutOn),
    baseMinor: c.baseMinor.toString(),
    rateBps: c.rateBps,
    amountMinor: c.amountMinor.toString(),
    status: c.status as Item['status'],
    settledOn: c.settledOn ? day(c.settledOn) : null,
    reference: c.reference,
  };
}

async function timeZoneOf(db: ArDeps['tenantDb'] | TenantTx, propertyId: string) {
  const p = await db.property.findUniqueOrThrow({ where: { id: propertyId } });
  return p.timeZone;
}

/** The agent a reservation was booked through: its travel agent, or a company that is one. */
function agentOf(r: {
  travelAgent: { id: string; kind: string; commissionBps: number | null } | null;
  company: { id: string; kind: string; commissionBps: number | null } | null;
}) {
  if (r.travelAgent) return r.travelAgent;
  if (r.company?.kind === 'TRAVEL_AGENT') return r.company;
  return null;
}

/** Room revenue net of tax on a folio: room charges, their discounts, and reversals of either. */
export async function roomRevenueOf(tx: TenantTx, folioId: string): Promise<bigint> {
  const lines = await tx.folioLine.findMany({
    where: { folioId },
    select: {
      id: true,
      kind: true,
      amountMinor: true,
      parentLineId: true,
      reversesLineId: true,
      revenueCode: { select: { group: true } },
    },
  });
  const counted = new Set(
    lines.filter((l) => l.kind === 'CHARGE' && l.revenueCode.group === 'ROOM').map((l) => l.id),
  );
  for (const l of lines) {
    if (l.kind === 'DISCOUNT' && l.parentLineId && counted.has(l.parentLineId)) counted.add(l.id);
  }
  for (const l of lines) {
    if (l.kind === 'REVERSAL' && l.reversesLineId && counted.has(l.reversesLineId)) {
      counted.add(l.id);
    }
  }
  return lines.filter((l) => counted.has(l.id)).reduce((s, l) => s + l.amountMinor, 0n);
}

const commissionOn = (base: bigint, rateBps: number) =>
  base <= 0n ? 0n : (base * BigInt(rateBps) + 5000n) / 10000n;

export async function list(
  deps: ArDeps,
  _tenant: TenantContext,
  query: { status?: Item['status']; agentId?: string },
) {
  const rows = await deps.tenantDb.commission.findMany({
    where: {
      ...(query.status ? { status: query.status } : {}),
      ...(query.agentId ? { travelAgentId: query.agentId } : {}),
    },
    include: INCLUDE,
    orderBy: [{ checkedOutOn: 'desc' }, { createdAt: 'desc' }],
  });
  const due = rows.filter((r) => r.status === 'DUE').reduce((s, r) => s + r.amountMinor, 0n);
  return { data: rows.map(itemOf), dueMinor: due.toString() };
}

export async function calculate(
  deps: ArDeps,
  tenant: TenantContext,
  body: z.output<typeof CommissionCalculateBody>,
): Promise<z.input<typeof CommissionCalculateResult>> {
  const now = deps.clock();
  const tz = await timeZoneOf(deps.tenantDb, tenant.propertyId);
  if (body.to > localDate(now, tz)) throw invalid('to', 'The period cannot end in the future');
  return deps.tenantDb.$transaction(async (tx) => {
    // A day either side, then by the hotel's own date: checkouts are instants, the period is days.
    const stays = await tx.stay.findMany({
      where: {
        status: 'CHECKED_OUT',
        folioId: { not: null },
        checkedOutAt: { gte: dbDate(addDays(body.from, -1)), lt: dbDate(addDays(body.to, 2)) },
      },
      select: {
        id: true,
        folioId: true,
        checkedOutAt: true,
        reservation: {
          select: {
            travelAgent: { select: { id: true, kind: true, commissionBps: true } },
            company: { select: { id: true, kind: true, commissionBps: true } },
          },
        },
        commission: true,
      },
      orderBy: { checkedOutAt: 'asc' },
    });
    let created = 0;
    let updated = 0;
    const touched: string[] = [];
    for (const s of stays) {
      if (!s.checkedOutAt || !s.folioId) continue;
      const on = localDate(s.checkedOutAt, tz);
      if (on < body.from || on > body.to) continue;
      const existing = s.commission;
      if (existing && existing.status !== 'DUE') continue;
      const agent = agentOf(s.reservation);
      const rateBps = existing?.rateBps ?? agent?.commissionBps ?? 0;
      if (!agent || rateBps <= 0) continue;
      const base = await roomRevenueOf(tx, s.folioId);
      const baseMinor = base > 0n ? base : 0n;
      const amountMinor = commissionOn(base, rateBps);
      if (!existing) {
        if (amountMinor === 0n) continue;
        const row = await tx.commission.create({
          data: {
            travelAgentId: agent.id,
            stayId: s.id,
            checkedOutOn: dbDate(on),
            baseMinor,
            rateBps,
            amountMinor,
            createdAt: now,
            updatedAt: now,
          } as unknown as Prisma.CommissionUncheckedCreateInput,
        });
        created += 1;
        touched.push(row.id);
        await recordAudit(tx, {
          action: 'ar.commission_calculated',
          entityType: 'commission',
          entityId: row.id,
          after: {
            stayId: s.id,
            agentId: agent.id,
            baseMinor: baseMinor.toString(),
            rateBps,
            amountMinor: amountMinor.toString(),
          },
        });
      } else if (existing.baseMinor !== baseMinor || existing.amountMinor !== amountMinor) {
        await tx.commission.update({
          where: { id: existing.id },
          data: { baseMinor, amountMinor, updatedAt: now },
        });
        updated += 1;
        touched.push(existing.id);
        await recordAudit(tx, {
          action: 'ar.commission_recalculated',
          entityType: 'commission',
          entityId: existing.id,
          before: {
            baseMinor: existing.baseMinor.toString(),
            amountMinor: existing.amountMinor.toString(),
          },
          after: { baseMinor: baseMinor.toString(), amountMinor: amountMinor.toString() },
        });
      }
    }
    const rows = await tx.commission.findMany({
      where: { id: { in: touched } },
      include: INCLUDE,
      orderBy: [{ checkedOutOn: 'desc' }, { createdAt: 'desc' }],
    });
    return { created, updated, data: rows.map(itemOf) };
  });
}

export async function settle(
  deps: ArDeps,
  tenant: TenantContext,
  body: z.output<typeof CommissionSettleBody>,
) {
  const now = deps.clock();
  const tz = await timeZoneOf(deps.tenantDb, tenant.propertyId);
  if (body.settledOn > localDate(now, tz)) {
    throw invalid('settledOn', 'The date cannot be in the future');
  }
  const ids = [...new Set(body.commissionIds)];
  return deps.tenantDb.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM commissions WHERE id = ANY(${ids}::uuid[]) FOR UPDATE`;
    const rows = await tx.commission.findMany({ where: { id: { in: ids } } });
    if (rows.length !== ids.length) throw new AppError('NOT_FOUND', 'Commission not found');
    if (rows.some((r) => r.status !== 'DUE')) {
      throw new AppError('STATE_TRANSITION_INVALID', 'Only due commissions can be settled', {
        settled: rows.filter((r) => r.status !== 'DUE').map((r) => r.id),
      });
    }
    const agents = new Set(rows.map((r) => r.travelAgentId));
    if (agents.size > 1) throw invalid('commissionIds', 'Settle one agent’s commissions at a time');
    const agentId = rows[0]?.travelAgentId ?? '';
    const total = rows.reduce((s, r) => s + r.amountMinor, 0n);
    let arPaymentId: string | null = null;
    if (body.as === 'OFFSET') {
      const account = await tx.arAccount.findFirst({ where: { companyId: agentId } });
      if (!account) {
        throw new AppError(
          'STATE_TRANSITION_INVALID',
          'The agent has no city-ledger account to set the commission off against',
        );
      }
      if (total <= 0n) throw invalid('commissionIds', 'There is nothing to set off');
      const payment = await tx.arPayment.create({
        data: {
          arAccountId: account.id,
          method: 'COMMISSION_OFFSET',
          amountMinor: total,
          reference: body.reference,
          receivedOn: dbDate(body.settledOn),
          note: `Commission on ${rows.length} ${rows.length === 1 ? 'stay' : 'stays'}`,
          createdById: tenant.userId,
          createdAt: now,
        } as unknown as Prisma.ArPaymentUncheckedCreateInput,
      });
      arPaymentId = payment.id;
      await recordAudit(tx, {
        action: 'ar.payment_recorded',
        entityType: 'ar_payment',
        entityId: payment.id,
        after: {
          accountId: account.id,
          method: 'COMMISSION_OFFSET',
          amountMinor: total.toString(),
          reference: body.reference,
        },
      });
      await allocateIn(tx, payment.id, undefined, now);
    }
    await tx.commission.updateMany({
      where: { id: { in: ids } },
      data: {
        status: body.as,
        settledOn: dbDate(body.settledOn),
        reference: body.reference,
        arPaymentId,
        settledById: tenant.userId,
        settledAt: now,
        updatedAt: now,
      },
    });
    await recordAudit(tx, {
      action: body.as === 'PAID' ? 'ar.commission_paid' : 'ar.commission_offset',
      entityType: 'company',
      entityId: agentId,
      after: {
        commissionIds: ids,
        amountMinor: total.toString(),
        settledOn: body.settledOn,
        reference: body.reference,
        arPaymentId,
      },
    });
    const after = await tx.commission.findMany({
      where: { id: { in: ids } },
      include: INCLUDE,
      orderBy: [{ checkedOutOn: 'desc' }, { createdAt: 'desc' }],
    });
    return { data: after.map(itemOf) };
  });
}
