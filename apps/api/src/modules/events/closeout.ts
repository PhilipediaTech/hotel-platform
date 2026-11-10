import type {
  EVENT_CLOSE_BLOCKERS,
  EventBriefBody,
  EventBriefView,
  EventCloseOutView,
  EventInspectionBody,
} from '@hotel/shared';
import type { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client.ts';
import { recordAudit } from '../../core/audit.ts';
import { raisedBy } from '../../core/db.ts';
import { AppError } from '../../core/errors.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import type { TenantDb } from '../../core/tenant-db.ts';
import { folioBalances, postChargeLines } from '../folios/service.ts';
import { facts, folioInvoice, footer, header, render } from '../payments/documents.ts';
import { LIVE_CONTRACT } from './allocation.ts';
import { lockBooking, openEventFolio, REVENUE_CODE } from './sales.ts';
import { BOOKING_INCLUDE, bookingOf, type EventDeps } from './service.ts';

// Events and spaces, third part (PRD M9-07, M9-08, M9 rule "damage deposits are a liability,
// never revenue, until settled"; T-121). Closing out has two steps because money can move
// between them: the inspection posts the final charges, then whatever the bill shows is taken
// or refunded through the normal payment screens (a refund keeps its approval), and the event
// closes when the bill reaches zero.

type TenantTx = Parameters<Parameters<TenantDb['$transaction']>[0]>[0];
type Client = TenantDb | TenantTx;
type Blocker = (typeof EVENT_CLOSE_BLOCKERS)[number];
type Line = { kind: keyof typeof REVENUE_CODE; description: string; quantity: number };
type View = z.input<typeof EventCloseOutView>;

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const stateError = (message: string, details?: Record<string, unknown>) =>
  new AppError('STATE_TRANSITION_INVALID', message, details);
const notFound = () => new AppError('NOT_FOUND', 'Booking not found');

// ── The brief (M9-07) ───────────────────────────────────────────────────────────────────

async function briefView(db: Client, bookingId: string): Promise<z.input<typeof EventBriefView>> {
  const [departments, rows] = await Promise.all([
    db.department.findMany({ orderBy: { name: 'asc' } }),
    db.eventBrief.findMany({ where: { bookingId } }),
  ]);
  return {
    sections: departments.map((d) => {
      const row = rows.find((r) => r.departmentId === d.id);
      return {
        department: { id: d.id, code: d.code, name: d.name },
        instructions: row?.instructions ?? '',
        version: row?.version ?? 0,
        updatedAt: row ? iso(row.updatedAt) : null,
      };
    }),
  };
}

export async function getBrief(deps: EventDeps, bookingId: string) {
  const booking = await deps.tenantDb.eventBooking.findFirst({ where: { id: bookingId } });
  if (!booking) throw notFound();
  return briefView(deps.tenantDb, bookingId);
}

export async function saveBrief(
  deps: EventDeps,
  tenant: TenantContext,
  bookingId: string,
  body: z.output<typeof EventBriefBody>,
) {
  const now = deps.clock();
  return deps.tenantDb.$transaction(async (tx) => {
    const booking = await lockBooking(tx, bookingId);
    if (booking.status !== 'CONFIRMED') {
      throw stateError('A brief is written for a confirmed booking', { status: booking.status });
    }
    const known = await tx.department.findMany({
      where: { id: { in: body.sections.map((s) => s.departmentId) } },
    });
    const changed: string[] = [];
    for (const s of body.sections) {
      const department = known.find((d) => d.id === s.departmentId);
      if (!department) {
        throw new AppError('VALIDATION_ERROR', 'Choose a department of this property', {
          issues: [
            {
              path: 'body.sections',
              code: 'custom',
              message: 'Choose a department of this property',
            },
          ],
        });
      }
      const row = await tx.eventBrief.findFirst({
        where: { bookingId, departmentId: s.departmentId },
      });
      if (!s.instructions) {
        if (row) {
          await tx.eventBrief.delete({ where: { id: row.id } });
          changed.push(department.code);
        }
      } else if (!row) {
        await tx.eventBrief.create({
          data: {
            bookingId,
            departmentId: s.departmentId,
            instructions: s.instructions,
            updatedById: tenant.userId,
            updatedAt: now,
          } as unknown as Prisma.EventBriefUncheckedCreateInput,
        });
        changed.push(department.code);
      } else if (row.instructions !== s.instructions) {
        await tx.eventBrief.update({
          where: { id: row.id },
          data: {
            instructions: s.instructions,
            version: { increment: 1 },
            updatedById: tenant.userId,
            updatedAt: now,
          },
        });
        changed.push(department.code);
      }
    }
    if (changed.length > 0) {
      await recordAudit(tx, {
        action: 'event_brief.saved',
        entityType: 'event_booking',
        entityId: bookingId,
        after: { departments: changed },
      });
    }
    return briefView(tx, bookingId);
  });
}

export async function briefPdf(deps: EventDeps, bookingId: string, departmentId?: string) {
  const booking = await deps.tenantDb.eventBooking.findFirst({
    where: { id: bookingId },
    include: BOOKING_INCLUDE,
  });
  if (!booking) throw notFound();
  const property = await deps.tenantDb.property.findUniqueOrThrow({
    where: { id: booking.propertyId },
  });
  const { sections } = await briefView(deps.tenantDb, bookingId);
  const shown = sections.filter(
    (s) => s.instructions && (!departmentId || s.department.id === departmentId),
  );
  if (shown.length === 0) throw new AppError('NOT_FOUND', 'There is no brief to print');
  const when = (d: Date) =>
    new Intl.DateTimeFormat('en', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: property.timeZone,
    }).format(d);
  const content = await render((doc) => {
    header(doc, property, 'Banquet event order');
    facts(doc, [
      ['Event', booking.title],
      ['Space', booking.space.name],
      ['Layout', booking.layout?.name ?? '—'],
      ['Guests', String(booking.expectedGuests)],
      ['Starts', when(booking.startsAt)],
      ['Ends', when(booking.endsAt)],
      ['Setup from', when(booking.blockedFrom)],
      ['Clear by', when(booking.blockedUntil)],
    ]);
    for (const s of shown) {
      if (doc.y > 700) doc.addPage();
      doc.font('Helvetica-Bold').fontSize(11).text(s.department.name, 50);
      doc.font('Helvetica').fontSize(9).text(s.instructions, { width: 495 });
      doc.moveDown(1);
    }
    footer(doc, `Printed ${when(deps.clock())}`);
  });
  return { filename: `beo-${booking.id.slice(0, 8)}.pdf`, content };
}

// ── Close-out (M9-08) ───────────────────────────────────────────────────────────────────

/** The contract in force, with what it agreed. */
async function contractOf(db: Client, bookingId: string) {
  const live = await db.eventContract.findFirst({
    where: { bookingId, status: { in: [...LIVE_CONTRACT] } },
    include: { schedule: true, quoteVersion: true },
  });
  return live;
}

async function closeOutView(db: Client, clock: () => Date, bookingId: string): Promise<View> {
  const booking = await db.eventBooking.findFirst({ where: { id: bookingId } });
  if (!booking) throw notFound();
  const contract = await contractOf(db, bookingId);
  const folioId = booking.folioId ?? contract?.folioId;
  const folio = folioId ? await db.folio.findFirst({ where: { id: folioId } }) : null;
  const balance = folio ? ((await folioBalances(db, [folio.id])).get(folio.id) ?? 0n) : 0n;
  const held = (contract?.schedule ?? [])
    .filter((s) => s.kind === 'DAMAGE_DEPOSIT')
    .reduce((sum, s) => sum + s.paidMinor, 0n);
  const damage = booking.damageTotalMinor;
  const blockers: Blocker[] = [];
  if (booking.status !== 'CLOSED') {
    if (booking.blockedUntil > clock()) blockers.push('EVENT_NOT_OVER');
    if (!booking.inspectedAt) blockers.push('NOT_INSPECTED');
    else if (balance > 0n) blockers.push('BALANCE_DUE');
    else if (balance < 0n) blockers.push('CREDIT_TO_RETURN');
  }
  return {
    status: booking.status as View['status'],
    inspection: booking.inspectedAt
      ? {
          at: iso(booking.inspectedAt),
          notes: booking.inspectionNotes ?? '',
          damageDescription: booking.damageDescription,
          damageTotalMinor: damage.toString(),
        }
      : null,
    folio: folio
      ? {
          id: folio.id,
          number: folio.number,
          status: folio.status,
          balanceMinor: balance.toString(),
        }
      : null,
    damageDepositHeldMinor: held.toString(),
    damageDepositRetainedMinor: (damage < held ? damage : held).toString(),
    blockers,
    closedAt: booking.closedAt ? iso(booking.closedAt) : null,
  };
}

export const getCloseOut = (deps: EventDeps, bookingId: string) =>
  closeOutView(deps.tenantDb, deps.clock, bookingId);

export async function inspect(
  deps: EventDeps,
  tenant: TenantContext,
  bookingId: string,
  body: z.output<typeof EventInspectionBody>,
) {
  const now = deps.clock();
  try {
    return await deps.tenantDb.$transaction(async (tx) => {
      const booking = await lockBooking(tx, bookingId);
      if (booking.status !== 'CONFIRMED') {
        throw stateError('Only a confirmed booking is inspected', { status: booking.status });
      }
      if (booking.inspectedAt) throw stateError('This event has been inspected already');
      if (booking.endsAt > now) throw stateError('The event has not finished yet');

      // What was contracted; a booking confirmed on an override may have only a quote.
      const contract = await contractOf(tx, bookingId);
      const version =
        contract?.quoteVersion ??
        (
          await tx.eventQuote.findFirst({
            where: { bookingId },
            include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
          })
        )?.versions[0];
      const quoted = (version?.lines ?? []) as unknown as (Line & { unitMinor: string })[];
      const damage = BigInt(body.damageMinor);
      if (quoted.length === 0 && body.extras.length === 0 && damage === 0n) {
        throw stateError('There is nothing to invoice: add what was provided');
      }

      // The bill the money is on; a booking confirmed without a contract gets its own.
      const earlier = await tx.eventContract.findFirst({
        where: { bookingId, folio: { status: 'OPEN' } },
        orderBy: { issuedAt: 'desc' },
        select: { folioId: true },
      });
      const { baseCurrency } = await tx.property.findUniqueOrThrow({
        where: { id: booking.propertyId },
      });
      const folioId =
        earlier?.folioId ??
        (await openEventFolio(tx, booking.title, { id: booking.propertyId, baseCurrency }));
      const folio = await tx.folio.findFirst({
        where: { id: folioId },
        include: { windows: true },
      });
      const windowId = folio?.windows.find((w) => w.number === 1)?.id;
      if (folio?.status !== 'OPEN' || !windowId) throw stateError('The event’s bill is not open');

      const codes = await tx.revenueCode.findMany({
        where: { code: { in: Object.values(REVENUE_CODE) } },
      });
      const post = async (line: Line, unit: bigint) => {
        const code = codes.find((c) => c.code === REVENUE_CODE[line.kind]);
        if (!code) throw stateError(`Revenue code ${REVENUE_CODE[line.kind]} is missing`);
        return postChargeLines(
          { tx, tenant, approvalRequestId: null, now },
          {
            folio,
            windowId,
            code,
            description: line.description,
            quantity: line.quantity,
            unitAmountMinor: unit,
            note: null,
            sourceType: 'EVENT',
            sourceId: bookingId,
          },
        );
      };
      for (const l of quoted) await post(l, BigInt(l.unitMinor));
      for (const l of body.extras) await post(l, BigInt(l.unitMinor));
      let damageTotal = 0n;
      if (damage > 0n) {
        const ids = await post(
          { kind: 'EXTRA', description: `Damage: ${body.damageDescription}`, quantity: 1 },
          damage,
        );
        const sum = await tx.folioLine.aggregate({
          where: { id: { in: ids } },
          _sum: { amountMinor: true },
        });
        damageTotal = sum._sum.amountMinor ?? 0n;
      }
      await tx.eventBooking.update({
        where: { id: bookingId },
        data: {
          inspectedAt: now,
          inspectedById: tenant.userId,
          inspectionNotes: body.notes,
          damageDescription: body.damageDescription,
          damageTotalMinor: damageTotal,
          folioId,
          version: { increment: 1 },
        },
      });
      await recordAudit(tx, {
        action: 'event_booking.inspected',
        entityType: 'event_booking',
        entityId: bookingId,
        after: {
          folioId,
          quoteVersion: version?.version ?? null,
          extras: body.extras.length,
          damageTotalMinor: damageTotal.toString(),
        },
      });
      return closeOutView(tx, deps.clock, bookingId);
    });
  } catch (err) {
    if (raisedBy(err, 'BUSINESS_DAY_CLOSED')) {
      throw new AppError('BUSINESS_DAY_CLOSED', 'This business day is closed');
    }
    throw err;
  }
}

export async function invoicePdf(deps: EventDeps, bookingId: string) {
  const booking = await deps.tenantDb.eventBooking.findFirst({ where: { id: bookingId } });
  if (!booking) throw notFound();
  if (!booking.folioId) throw new AppError('NOT_FOUND', 'Inspect the event first');
  return folioInvoice(deps, booking.folioId);
}

export async function closeBooking(deps: EventDeps, bookingId: string) {
  const now = deps.clock();
  return deps.tenantDb.$transaction(async (tx) => {
    const booking = await lockBooking(tx, bookingId);
    if (booking.status !== 'CONFIRMED') {
      throw stateError('Only a confirmed booking is closed', { status: booking.status });
    }
    const view = await closeOutView(tx, deps.clock, bookingId);
    if (view.blockers.length > 0) {
      throw stateError('This event cannot be closed yet', { blockers: view.blockers });
    }
    if (booking.folioId) {
      await tx.folio.update({
        where: { id: booking.folioId },
        data: { status: 'SETTLED', version: { increment: 1 } },
      });
    }
    await tx.virtualAccount.updateMany({
      where: { ownerType: 'EVENT', ownerId: bookingId },
      data: { active: false },
    });
    await tx.eventBooking.update({
      where: { id: bookingId },
      data: { status: 'CLOSED', closedAt: now, version: { increment: 1 } },
    });
    await recordAudit(tx, {
      action: 'event_booking.closed',
      entityType: 'event_booking',
      entityId: bookingId,
      before: { status: 'CONFIRMED' },
      after: {
        status: 'CLOSED',
        damageDepositHeldMinor: view.damageDepositHeldMinor,
        damageDepositRetainedMinor: view.damageDepositRetainedMinor,
      },
    });
    const row = await tx.eventBooking.findUniqueOrThrow({
      where: { id: bookingId },
      include: BOOKING_INCLUDE,
    });
    return bookingOf(row);
  });
}
