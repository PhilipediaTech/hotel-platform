import type { EVENT_CONFIRM_MISSING } from '@hotel/shared';
import {
  calculateTaxes,
  eventCancellationTerms,
  localDate,
  type EventConfirmBody,
  type EventContractBody,
  type EventContractItem,
  type EventContractSignBody,
  type EventContractView,
  type EventQuoteBody,
  type EventQuoteLineItem,
  type EventQuoteView,
} from '@hotel/shared';
import { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client.ts';
import {
  performOrRequest,
  type ApprovalActionHandler,
  type ExecuteContext,
} from '../../core/approvals.ts';
import { recordAudit } from '../../core/audit.ts';
import { COUNTER, nextPropertyCounter } from '../../core/counters.ts';
import { AppError } from '../../core/errors.ts';
import type { EmailProvider } from '../../core/email.ts';
import { PaymentProviderError, type PaymentProvider } from '../../core/payments.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import type { TenantDb } from '../../core/tenant-db.ts';
import { taxesFor } from '../folios/service.ts';
import { facts, footer, header, money, render, table, totals } from '../payments/documents.ts';
import { bookingHasMoney, LIVE_CONTRACT } from './allocation.ts';
import { bookingOf, BOOKING_INCLUDE, type EventDeps } from './service.ts';

// Events and spaces, second part (PRD M9-04–M9-06; T-120): the versioned quote, the contract and
// its payment schedule on the event's own virtual account, and confirming the booking.

export interface EventSalesDeps extends EventDeps {
  provider: PaymentProvider;
  email: EmailProvider;
}

type TenantTx = Parameters<Parameters<TenantDb['$transaction']>[0]>[0];
type Line = z.input<typeof EventQuoteLineItem>;
type Missing = (typeof EVENT_CONFIRM_MISSING)[number];
type Contract = z.input<typeof EventContractItem>;

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const day = (d: Date) => d.toISOString().slice(0, 10);
const dbDate = (date: string) => new Date(`${date}T00:00:00Z`);

const invalid = (path: string, message: string) =>
  new AppError('VALIDATION_ERROR', message, {
    issues: [{ path: `body.${path}`, code: 'custom', message }],
  });
const stateError = (message: string, details?: Record<string, unknown>) =>
  new AppError('STATE_TRANSITION_INVALID', message, details);

/** Food is taxed as food; the rest as other charges (the tax rules on each code decide). */
export const REVENUE_CODE = {
  SPACE: 'MISC',
  PACKAGE: 'FNB',
  CATERING: 'FNB',
  EQUIPMENT: 'MISC',
  EXTRA: 'MISC',
} as const;

/** Package prices usually include the room, so they count towards the minimum hire. */
const COUNTS_TO_MINIMUM = new Set<string>(['SPACE', 'PACKAGE']);

/** On one due date: the deposit first, the damage deposit last. */
const KIND_ORDER: Record<string, number> = { DEPOSIT: 0, INSTALMENT: 1, DAMAGE_DEPOSIT: 2 };

export async function lockBooking(tx: TenantTx, bookingId: string) {
  await tx.$queryRaw`SELECT id FROM event_bookings WHERE id = ${bookingId}::uuid FOR UPDATE`;
  const booking = await tx.eventBooking.findFirst({
    where: { id: bookingId },
    include: { space: true },
  });
  if (!booking) throw new AppError('NOT_FOUND', 'Booking not found');
  return booking;
}

function requireLiveHold(b: { status: string; holdExpiresAt: Date | null }, now: Date) {
  if (b.status !== 'HOLD' || !b.holdExpiresAt || b.holdExpiresAt <= now) {
    throw stateError('This is no longer a live hold', { status: b.status });
  }
}

const liveContractOf = (tx: TenantTx, bookingId: string) =>
  tx.eventContract.findFirst({
    where: { bookingId, status: { in: [...LIVE_CONTRACT] } },
  });

/** A contract nothing depends on yet is replaced; a signed or paid one is not. */
async function supersedeIfFree(tx: TenantTx, bookingId: string, what: string) {
  const live = await liveContractOf(tx, bookingId);
  if (!live) return;
  if (live.status === 'SIGNED' || (await bookingHasMoney(tx as never, bookingId))) {
    throw stateError(`The contract is signed or paid on, so ${what}`);
  }
  await tx.eventContract.update({
    where: { id: live.id },
    data: { status: 'SUPERSEDED', version: { increment: 1 } },
  });
  await recordAudit(tx, {
    action: 'event_contract.superseded',
    entityType: 'event_contract',
    entityId: live.id,
    before: { status: live.status },
    after: { status: 'SUPERSEDED' },
  });
}

// ── Quotes (M9-04) ──────────────────────────────────────────────────────────────────────

const VERSIONS = { versions: { orderBy: { version: 'desc' } } } satisfies Prisma.EventQuoteInclude;

/** Rate rules that apply on an event's date: its day of the week and its season. */
function appliesOn(
  r: { dayType: string; seasonFrom: Date | null; seasonTo: Date | null },
  date: string,
) {
  const weekday = dbDate(date).getUTCDay();
  const weekend = weekday === 0 || weekday === 6;
  if (r.dayType === 'WEEKDAY' && weekend) return false;
  if (r.dayType === 'WEEKEND' && !weekend) return false;
  if (r.seasonFrom && r.seasonTo) return day(r.seasonFrom) <= date && date <= day(r.seasonTo);
  return true;
}

async function eventDate(tx: Pick<TenantDb, 'property'>, propertyId: string, startsAt: Date) {
  const property = await tx.property.findUniqueOrThrow({ where: { id: propertyId } });
  return { property, date: localDate(startsAt, property.timeZone) };
}

async function quoteView(
  db: TenantDb | TenantTx,
  bookingId: string,
): Promise<z.input<typeof EventQuoteView>> {
  const booking = await db.eventBooking.findFirst({
    where: { id: bookingId },
    include: { space: { include: { rateRules: { orderBy: { name: 'asc' } } } } },
  });
  if (!booking) throw new AppError('NOT_FOUND', 'Booking not found');
  const { date } = await eventDate(db, booking.propertyId, booking.startsAt);
  const quote = await db.eventQuote.findFirst({ where: { bookingId }, include: VERSIONS });
  return {
    currentVersion: quote?.currentVersion ?? 0,
    versions: (quote?.versions ?? []).map((v) => ({
      id: v.id,
      version: v.version,
      lines: v.lines as unknown as Line[],
      netMinor: v.netMinor.toString(),
      taxMinor: v.taxMinor.toString(),
      totalMinor: v.totalMinor.toString(),
      notes: v.notes,
      createdAt: iso(v.createdAt),
    })),
    rates: booking.space.rateRules
      .filter((r) => appliesOn(r, date))
      .map((r) => ({
        id: r.id,
        name: r.name,
        unit: r.unit,
        amountMinor: r.amountMinor.toString(),
      })),
    minimumHireMinor: booking.space.minimumHireMinor.toString(),
    expectedGuests: booking.expectedGuests,
  };
}

export const getQuotes = (deps: EventDeps, bookingId: string) =>
  quoteView(deps.tenantDb, bookingId);

export async function saveQuoteVersion(
  deps: EventDeps,
  tenant: TenantContext,
  bookingId: string,
  body: z.output<typeof EventQuoteBody>,
) {
  const now = deps.clock();
  return deps.tenantDb.$transaction(async (tx) => {
    const booking = await lockBooking(tx, bookingId);
    requireLiveHold(booking, now);
    await supersedeIfFree(tx, bookingId, 'the quote cannot change now');
    const { date } = await eventDate(tx, booking.propertyId, booking.startsAt);

    const codes = await tx.revenueCode.findMany({
      where: { code: { in: Object.values(REVENUE_CODE) } },
    });
    const taxed = async (kind: keyof typeof REVENUE_CODE, amount: bigint) => {
      const code = codes.find((c) => c.code === REVENUE_CODE[kind]);
      if (!code) throw invalid('lines', `Revenue code ${REVENUE_CODE[kind]} is missing`);
      const { versions } = await taxesFor(tx, code, date);
      return { code: code.code, result: calculateTaxes(amount, versions) };
    };
    const lines: Line[] = [];
    let netMinor = 0n;
    let totalMinor = 0n;
    const add = async (
      l: { kind: keyof typeof REVENUE_CODE; description: string; quantity: number; unit: bigint },
      minimumHire: boolean,
    ) => {
      const amount = l.unit * BigInt(l.quantity);
      const { code, result } = await taxed(l.kind, amount);
      netMinor += result.netMinor;
      totalMinor += result.totalMinor;
      lines.push({
        kind: l.kind,
        description: l.description,
        quantity: l.quantity,
        unitMinor: l.unit.toString(),
        amountMinor: amount.toString(),
        revenueCode: code,
        taxMinor: (result.totalMinor - result.netMinor).toString(),
        totalMinor: result.totalMinor.toString(),
        minimumHire,
      });
    };
    let towardsMinimum = 0n;
    for (const l of body.lines) {
      const unit = BigInt(l.unitMinor);
      await add({ ...l, unit }, false);
      if (COUNTS_TO_MINIMUM.has(l.kind)) towardsMinimum += unit * BigInt(l.quantity);
    }
    if (towardsMinimum < booking.space.minimumHireMinor) {
      await add(
        {
          kind: 'SPACE',
          description: `Minimum hire for ${booking.space.name}`,
          quantity: 1,
          unit: booking.space.minimumHireMinor - towardsMinimum,
        },
        true,
      );
    }

    const existing = await tx.eventQuote.findFirst({ where: { bookingId } });
    const quote =
      existing ??
      (await tx.eventQuote.create({
        data: { bookingId, createdAt: now } as unknown as Prisma.EventQuoteUncheckedCreateInput,
      }));
    const version = quote.currentVersion + 1;
    const row = await tx.eventQuoteVersion.create({
      data: {
        quoteId: quote.id,
        version,
        lines: lines as unknown as Prisma.InputJsonValue,
        netMinor,
        taxMinor: totalMinor - netMinor,
        totalMinor,
        notes: body.notes,
        createdById: tenant.userId,
        createdAt: now,
      } as unknown as Prisma.EventQuoteVersionUncheckedCreateInput,
    });
    await tx.eventQuote.update({ where: { id: quote.id }, data: { currentVersion: version } });
    await recordAudit(tx, {
      action: 'event_quote.versioned',
      entityType: 'event_quote_version',
      entityId: row.id,
      after: { bookingId, version, totalMinor: totalMinor.toString() },
    });
    return quoteView(tx, bookingId);
  });
}

// ── Contract and schedule (M9-05) ───────────────────────────────────────────────────────

const CONTRACT_INCLUDE = {
  quoteVersion: { select: { version: true, lines: true, netMinor: true, taxMinor: true } },
  folio: { select: { id: true, number: true } },
  schedule: { orderBy: { sequence: 'asc' } },
  deposits: { where: { kind: 'UNALLOCATED' } },
} satisfies Prisma.EventContractInclude;
type ContractRow = Prisma.EventContractGetPayload<{ include: typeof CONTRACT_INCLUDE }>;
type Account = { bankName: string; accountNumber: string; accountName: string };

function contractOf(c: ContractRow, account: Account | null, today: string): Contract {
  return {
    id: c.id,
    number: c.number,
    status: c.status as Contract['status'],
    quoteVersion: c.quoteVersion.version,
    clientName: c.clientName,
    clientEmail: c.clientEmail,
    clientPhone: c.clientPhone,
    terms: c.terms,
    totalMinor: c.totalMinor.toString(),
    damageDepositMinor: c.damageDepositMinor.toString(),
    issuedAt: iso(c.issuedAt),
    signedByName: c.signedByName,
    signedOn: c.signedOn ? day(c.signedOn) : null,
    folio: c.folio,
    account,
    schedule: c.schedule.map((s) => ({
      id: s.id,
      sequence: s.sequence,
      kind: s.kind as Contract['schedule'][number]['kind'],
      dueDate: day(s.dueDate),
      amountMinor: s.amountMinor.toString(),
      paidMinor: s.paidMinor.toString(),
      status:
        s.paidMinor >= s.amountMinor
          ? 'PAID'
          : s.paidMinor > 0n
            ? 'PART_PAID'
            : day(s.dueDate) < today
              ? 'OVERDUE'
              : 'DUE',
    })),
    overpaidMinor: c.deposits.reduce((sum, d) => sum + d.amountMinor, 0n).toString(),
  };
}

function missingFor(
  c: {
    status: string;
    schedule: { kind: string; amountMinor: bigint; paidMinor: bigint }[];
  } | null,
): Missing[] {
  if (!c) return ['NO_CONTRACT', 'DEPOSIT_NOT_PAID'];
  const missing: Missing[] = [];
  if (c.status !== 'SIGNED') missing.push('NOT_SIGNED');
  const deposit = c.schedule.find((s) => s.kind === 'DEPOSIT');
  if (!deposit || deposit.paidMinor < deposit.amountMinor) missing.push('DEPOSIT_NOT_PAID');
  return missing;
}

async function contractView(
  db: TenantDb | TenantTx,
  clock: () => Date,
  bookingId: string,
): Promise<z.input<typeof EventContractView>> {
  const booking = await db.eventBooking.findFirst({ where: { id: bookingId } });
  if (!booking) throw new AppError('NOT_FOUND', 'Booking not found');
  const row = await db.eventContract.findFirst({
    where: { bookingId, status: { in: [...LIVE_CONTRACT] } },
    include: CONTRACT_INCLUDE,
  });
  if (!row) return { contract: null, missing: missingFor(null) };
  const account = await db.virtualAccount.findFirst({
    where: { ownerType: 'EVENT', ownerId: bookingId, active: true },
    select: { bankName: true, accountNumber: true, accountName: true },
  });
  const property = await db.property.findUniqueOrThrow({ where: { id: booking.propertyId } });
  return {
    contract: contractOf(row, account, localDate(clock(), property.timeZone)),
    missing: missingFor(row),
  };
}

export const getContract = (deps: EventDeps, bookingId: string) =>
  contractView(deps.tenantDb, deps.clock, bookingId);

function checkedSchedule(
  body: z.output<typeof EventContractBody>,
  total: bigint,
  today: string,
  lastDay: string,
) {
  const deposits = body.schedule.filter((s) => s.kind === 'DEPOSIT');
  if (deposits.length !== 1) throw invalid('schedule', 'Add exactly one deposit');
  if (body.schedule.filter((s) => s.kind === 'DAMAGE_DEPOSIT').length > 1) {
    throw invalid('schedule', 'Add at most one damage deposit');
  }
  const owed = body.schedule
    .filter((s) => s.kind !== 'DAMAGE_DEPOSIT')
    .reduce((sum, s) => sum + BigInt(s.amountMinor), 0n);
  if (owed !== total) {
    throw invalid('schedule', 'The deposit and instalments must add up to the quote total');
  }
  for (const s of body.schedule) {
    if (s.dueDate < today) throw invalid('schedule', 'A payment cannot fall due in the past');
    if (s.dueDate > lastDay) throw invalid('schedule', 'Every payment falls due by the event');
  }
  const depositDue = deposits[0]?.dueDate ?? today;
  if (body.schedule.some((s) => s.kind === 'INSTALMENT' && s.dueDate < depositDue)) {
    throw invalid('schedule', 'The deposit falls due before the instalments');
  }
  return [...body.schedule].sort(
    (x, y) =>
      x.dueDate.localeCompare(y.dueDate) || (KIND_ORDER[x.kind] ?? 0) - (KIND_ORDER[y.kind] ?? 0),
  );
}

/** The current quote version, or an error saying the contract needs one first. */
async function currentVersion(tx: TenantDb | TenantTx, bookingId: string) {
  const quote = await tx.eventQuote.findFirst({
    where: { bookingId },
    include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
  });
  const version = quote?.versions[0];
  if (!version) throw stateError('Save a quote before issuing the contract');
  return version;
}

function contractEmail(
  property: { name: string; baseCurrency: string },
  title: string,
  body: z.output<typeof EventContractBody>,
  number: string,
  account: Account,
) {
  return [
    `Dear ${body.clientName},`,
    '',
    `Here is contract ${number} for ${title} at ${property.name}.`,
    '',
    'Payments due:',
    ...body.schedule.map(
      (s) =>
        `- ${s.dueDate}: ${money(BigInt(s.amountMinor), property.baseCurrency)} (${s.kind.replace('_', ' ').toLowerCase()})`,
    ),
    '',
    'Please pay by bank transfer to the account below, which is for this event alone:',
    `Bank: ${account.bankName}`,
    `Account number: ${account.accountNumber}`,
    `Account name: ${account.accountName}`,
    '',
    'Terms:',
    body.terms,
    '',
    eventCancellationTerms(),
  ].join('\n');
}

export async function issueContract(
  deps: EventSalesDeps,
  tenant: TenantContext,
  bookingId: string,
  body: z.output<typeof EventContractBody>,
) {
  const now = deps.clock();
  // Asked of the provider before the transaction, and only when there is something to issue.
  const before = await deps.tenantDb.eventBooking.findFirst({ where: { id: bookingId } });
  if (!before) throw new AppError('NOT_FOUND', 'Booking not found');
  requireLiveHold(before, now);
  await currentVersion(deps.tenantDb, bookingId);
  let account: Account | null = await deps.tenantDb.virtualAccount.findFirst({
    where: { ownerType: 'EVENT', ownerId: bookingId, active: true },
  });
  let issued: Account | null = null;
  if (!account) {
    const [firstName = body.clientName, ...rest] = body.clientName.split(' ');
    issued = await deps.provider
      .createVirtualAccount({
        email: body.clientEmail,
        firstName,
        lastName: rest.join(' ') || firstName,
        phone: body.clientPhone.replaceAll(' ', ''),
      })
      .catch((err: unknown) => {
        if (err instanceof PaymentProviderError) {
          throw new AppError(
            'PAYMENT_PROVIDER_UNAVAILABLE',
            'The payment provider could not issue an account; try again in a minute',
          );
        }
        throw err;
      });
    account = issued;
  }

  const created = await deps.tenantDb.$transaction(async (tx) => {
    const booking = await lockBooking(tx, bookingId);
    requireLiveHold(booking, now);
    await supersedeIfFree(tx, bookingId, 'it cannot be replaced');
    const version = await currentVersion(tx, bookingId);
    const { property, date } = await eventDate(tx, booking.propertyId, booking.startsAt);
    const schedule = checkedSchedule(
      body,
      version.totalMinor,
      localDate(now, property.timeZone),
      date,
    );
    const earlier = await tx.eventContract.findFirst({
      where: { bookingId },
      orderBy: { issuedAt: 'desc' },
      select: { folioId: true },
    });
    const folioId = earlier?.folioId ?? (await openEventFolio(tx, booking.title, property));
    if (issued) {
      const row = await tx.virtualAccount.create({
        data: {
          provider: deps.provider.name,
          ...issued,
          ownerType: 'EVENT',
          ownerId: bookingId,
        } as unknown as Prisma.VirtualAccountUncheckedCreateInput,
      });
      await recordAudit(tx, {
        action: 'payment.virtual_account_issued',
        entityType: 'virtual_account',
        entityId: row.id,
        after: { ownerType: 'EVENT', ownerId: bookingId, accountNumber: issued.accountNumber },
      });
    }
    const n = await nextPropertyCounter(tx, booking.propertyId, COUNTER.EVENT_CONTRACT);
    const contract = await tx.eventContract.create({
      data: {
        bookingId,
        quoteVersionId: version.id,
        folioId,
        number: `EC${String(n).padStart(5, '0')}`,
        clientName: body.clientName,
        clientEmail: body.clientEmail,
        clientPhone: body.clientPhone,
        terms: body.terms,
        totalMinor: version.totalMinor,
        damageDepositMinor: schedule
          .filter((s) => s.kind === 'DAMAGE_DEPOSIT')
          .reduce((sum, s) => sum + BigInt(s.amountMinor), 0n),
        issuedById: tenant.userId,
        issuedAt: now,
      } as unknown as Prisma.EventContractUncheckedCreateInput,
    });
    let sequence = 0;
    for (const s of schedule) {
      sequence += 1;
      await tx.eventPaymentSchedule.create({
        data: {
          contractId: contract.id,
          sequence,
          kind: s.kind,
          dueDate: dbDate(s.dueDate),
          amountMinor: BigInt(s.amountMinor),
        } as unknown as Prisma.EventPaymentScheduleUncheckedCreateInput,
      });
    }
    await recordAudit(tx, {
      action: 'event_contract.issued',
      entityType: 'event_contract',
      entityId: contract.id,
      after: {
        bookingId,
        number: contract.number,
        quoteVersion: version.version,
        totalMinor: version.totalMinor.toString(),
      },
    });
    return { number: contract.number, title: booking.title, property };
  });

  let emailed: boolean | undefined;
  if (body.send) {
    // Issued already: a mail that fails must not look like a failed issue, or be retried as one.
    emailed = await deps.email
      .send({
        to: body.clientEmail,
        subject: `Your contract with ${created.property.name}`,
        text: contractEmail(created.property, created.title, body, created.number, account),
        tag: 'event-contract',
      })
      .then(
        () => true,
        () => false,
      );
  }
  const view = await contractView(deps.tenantDb, deps.clock, bookingId);
  return emailed === undefined ? view : { ...view, emailed };
}

export async function openEventFolio(
  tx: TenantTx,
  title: string,
  property: { id: string; baseCurrency: string },
) {
  const n = await nextPropertyCounter(tx, property.id, COUNTER.FOLIO);
  const folio = await tx.folio.create({
    data: {
      number: `F${String(n).padStart(5, '0')}`,
      kind: 'EVENT',
      name: title,
      currency: property.baseCurrency,
      windows: { create: { number: 1, payerType: 'GUEST' } },
    } as unknown as Prisma.FolioUncheckedCreateInput,
  });
  await recordAudit(tx, {
    action: 'folio.opened',
    entityType: 'folio',
    entityId: folio.id,
    after: { number: folio.number, kind: 'EVENT', name: title },
  });
  return folio.id;
}

export async function signContract(
  deps: EventDeps,
  bookingId: string,
  body: z.output<typeof EventContractSignBody>,
) {
  const now = deps.clock();
  return deps.tenantDb.$transaction(async (tx) => {
    const booking = await lockBooking(tx, bookingId);
    const contract = await liveContractOf(tx, bookingId);
    if (contract?.status !== 'ISSUED')
      throw stateError('There is no contract waiting to be signed');
    const { property } = await eventDate(tx, booking.propertyId, booking.startsAt);
    if (body.signedOn > localDate(now, property.timeZone)) {
      throw invalid('signedOn', 'The signing date cannot be in the future');
    }
    await tx.eventContract.update({
      where: { id: contract.id },
      data: {
        status: 'SIGNED',
        signedByName: body.signedByName,
        signedOn: dbDate(body.signedOn),
        version: { increment: 1 },
      },
    });
    await recordAudit(tx, {
      action: 'event_contract.signed',
      entityType: 'event_contract',
      entityId: contract.id,
      before: { status: 'ISSUED' },
      after: { status: 'SIGNED', signedByName: body.signedByName, signedOn: body.signedOn },
    });
    return contractView(tx, deps.clock, bookingId);
  });
}

export async function contractPdf(deps: EventDeps, bookingId: string) {
  const booking = await deps.tenantDb.eventBooking.findFirst({
    where: { id: bookingId },
    include: BOOKING_INCLUDE,
  });
  if (!booking) throw new AppError('NOT_FOUND', 'Booking not found');
  const c = await deps.tenantDb.eventContract.findFirst({
    where: { bookingId, status: { in: [...LIVE_CONTRACT] } },
    include: CONTRACT_INCLUDE,
  });
  if (!c) throw new AppError('NOT_FOUND', 'This booking has no contract');
  const account = await deps.tenantDb.virtualAccount.findFirst({
    where: { ownerType: 'EVENT', ownerId: bookingId, active: true },
  });
  const property = await deps.tenantDb.property.findUniqueOrThrow({
    where: { id: booking.propertyId },
  });
  const cash = (minor: bigint | string) => money(BigInt(minor), property.baseCurrency);
  const when = (d: Date) =>
    new Intl.DateTimeFormat('en', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: property.timeZone,
    }).format(d);
  const lines = c.quoteVersion.lines as unknown as Line[];
  const content = await render((doc) => {
    header(doc, property, `Event contract ${c.number}`);
    facts(doc, [
      ['Client', c.clientName],
      ['Event', booking.title],
      ['Space', booking.space.name],
      ['Guests', String(booking.expectedGuests)],
      ['Starts', when(booking.startsAt)],
      ['Ends', when(booking.endsAt)],
    ]);
    table(
      doc,
      [
        { title: 'Item', width: 265 },
        { title: 'Qty', width: 40, align: 'right' },
        { title: 'Price', width: 95, align: 'right' },
        { title: 'Amount', width: 95, align: 'right' },
      ],
      lines.map((l) => [l.description, String(l.quantity), cash(l.unitMinor), cash(l.amountMinor)]),
    );
    totals(doc, [
      ['Subtotal', cash(c.quoteVersion.netMinor)],
      ['Taxes and service charge', cash(c.quoteVersion.taxMinor)],
      ['Total', cash(c.totalMinor)],
    ]);
    doc.moveDown(1);
    table(
      doc,
      [
        { title: 'Due', width: 150 },
        { title: 'Payment', width: 245 },
        { title: 'Amount', width: 100, align: 'right' },
      ],
      c.schedule.map((s) => [
        day(s.dueDate),
        s.kind === 'DAMAGE_DEPOSIT'
          ? 'Damage deposit (refundable)'
          : s.kind === 'DEPOSIT'
            ? 'Deposit'
            : 'Instalment',
        cash(s.amountMinor),
      ]),
    );
    if (account) {
      facts(doc, [
        ['Bank', account.bankName],
        ['Account number', account.accountNumber],
        ['Account name', account.accountName],
      ]);
    }
    doc.font('Helvetica-Bold').fontSize(10).text('Terms', 50);
    doc.font('Helvetica').fontSize(9).text(c.terms, { width: 495 });
    doc.moveDown(0.5).text(eventCancellationTerms(), { width: 495 });
    doc.moveDown(2);
    doc.text(
      c.signedByName
        ? `Signed by ${c.signedByName} on ${c.signedOn ? day(c.signedOn) : ''}`
        : 'Signed: ______________________________   Date: ______________',
    );
    footer(doc, `${c.number}, based on quote version ${c.quoteVersion.version}`);
  });
  return { filename: `${c.number}.pdf`, content };
}

// ── Confirming (M9-06) ──────────────────────────────────────────────────────────────────

const ConfirmPayload = z.object({ bookingId: z.string(), reason: z.string() });
type ConfirmPayload = z.infer<typeof ConfirmPayload>;

async function confirmIn(
  ctx: ExecuteContext & { now: Date },
  bookingId: string,
  override: { reason: string } | null,
): Promise<string> {
  const { tx, now } = ctx;
  const booking = await lockBooking(tx, bookingId);
  requireLiveHold(booking, now);
  const contract = await tx.eventContract.findFirst({
    where: { bookingId, status: { in: [...LIVE_CONTRACT] } },
    include: { schedule: true },
  });
  const missing = missingFor(contract);
  if (missing.length > 0 && !override) {
    throw stateError('This booking needs a signed contract and its deposit paid', { missing });
  }
  await tx.eventBooking.update({
    where: { id: bookingId },
    data: {
      status: 'CONFIRMED',
      holdExpiresAt: null,
      confirmedAt: now,
      confirmedByOverride: missing.length > 0,
      version: { increment: 1 },
    },
  });
  if (booking.enquiryId) {
    await tx.eventEnquiry.updateMany({
      where: { id: booking.enquiryId, status: 'OPEN' },
      data: { status: 'WON', updatedAt: now },
    });
  }
  await recordAudit(tx, {
    action: 'event_booking.confirmed',
    entityType: 'event_booking',
    entityId: bookingId,
    approvalRequestId: ctx.approvalRequestId ?? undefined,
    ...(missing.length > 0 && override ? { reason: override.reason } : {}),
    before: { status: 'HOLD' },
    after: { status: 'CONFIRMED', overridden: missing },
  });
  return bookingId;
}

export function eventConfirmHandler(deps: {
  clock: () => Date;
}): ApprovalActionHandler<ConfirmPayload> {
  return {
    action: 'event.confirm',
    payload: ConfirmPayload,
    measure: () => ({}),
    execute: (ctx, p) => confirmIn({ ...ctx, now: deps.clock() }, p.bookingId, p),
  };
}

export async function confirmBooking(
  deps: EventDeps,
  tenant: TenantContext,
  bookingId: string,
  body: z.output<typeof EventConfirmBody>,
) {
  // Checked first, so a manager is never asked to approve the impossible.
  const booking = await deps.tenantDb.eventBooking.findFirst({ where: { id: bookingId } });
  if (!booking) throw new AppError('NOT_FOUND', 'Booking not found');
  requireLiveHold(booking, deps.clock());
  const contract = await deps.tenantDb.eventContract.findFirst({
    where: { bookingId, status: { in: [...LIVE_CONTRACT] } },
    include: { schedule: true },
  });
  const rulesMet = missingFor(contract).length === 0;
  if (!body.override || rulesMet) {
    await deps.tenantDb.$transaction((tx) =>
      confirmIn({ tx, tenant, approvalRequestId: null, now: deps.clock() }, bookingId, null),
    );
  } else {
    const result = await performOrRequest(
      { db: deps.db, tenantDb: deps.tenantDb, clock: deps.clock, handlers: [] },
      tenant,
      eventConfirmHandler(deps),
      { bookingId, reason: body.reason },
      body.reason,
    );
    if (!('resultRef' in result)) return result;
  }
  const row = await deps.tenantDb.eventBooking.findUniqueOrThrow({
    where: { id: bookingId },
    include: BOOKING_INCLUDE,
  });
  return bookingOf(row);
}
