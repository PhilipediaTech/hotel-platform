import { addDays, INVOICE_DUE_DAYS, SUSPENSION_GRACE_DAYS } from '@hotel/shared';
import type { Logger } from 'pino';
import { recordAudit } from '../../core/audit.ts';
import type { AuthContext } from '../../core/auth.ts';
import type { Clock } from '../../core/clock.ts';
import type { Config } from '../../core/config.ts';
import type { Db } from '../../core/db.ts';
import type { EmailProvider } from '../../core/email.ts';
import { AppError } from '../../core/errors.ts';
import { defineJob } from '../../core/jobs.ts';
import {
  newPaymentReference,
  PaymentProviderError,
  type Charge,
  type PaymentProvider,
} from '../../core/payments.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import { OWNER_ROLE_NAME } from '../identity/role-templates.ts';
import { addCommission } from '../partners/service.ts';
import { money } from '../payments/documents.ts';
import { issueMonth } from './service.ts';

// Automated hotel billing and suspension (PRD M13-03 "automated with payment link from V1.2",
// M13-06 "suspend a tenant for non-payment after a grace period; data stays read-only and
// exportable", M13 rules; T-124). Each month the job invoices every paying group for the month
// before and emails its owners a payment link. An invoice not paid by its due date makes the
// group PAST_DUE; after the grace period platform staff may suspend it (they decide, as the
// story says), which makes it read-only until it pays. Paying, online or marked by staff,
// lifts PAST_DUE and SUSPENDED once nothing else is overdue.

type Tx = Parameters<Parameters<Db['$transaction']>[0]>[0];

export interface BillingDeps {
  db: Db;
  clock: Clock;
  provider: PaymentProvider;
  email: EmailProvider;
  config: Config;
  logger?: Logger;
}

const day = (d: Date) => d.toISOString().slice(0, 10);
const today = (clock: Clock) => day(clock());
const previousMonth = (date: string) => {
  const [y, m] = date.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
};

/** The group's owners, for billing mail. */
async function ownerEmails(db: Db | Tx, organisationId: string): Promise<string[]> {
  const rows = await db.membership.findMany({
    where: { organisationId, active: true, role: { isSystem: true, name: OWNER_ROLE_NAME } },
    include: { user: { select: { email: true, status: true } } },
  });
  return [
    ...new Set(
      rows.flatMap((m) => (m.user.email && m.user.status === 'ACTIVE' ? [m.user.email] : [])),
    ),
  ];
}

const billingUrl = (config: Config) => `${config.appOrigin}/settings/billing`;

/** Days the group's oldest unpaid invoice is past its due date (0 or less: not overdue). */
export async function overdueDays(db: Db | Tx, organisationId: string, on: string) {
  const oldest = await db.platformInvoice.findFirst({
    where: { organisationId, status: 'ISSUED', dueOn: { not: null } },
    orderBy: { dueOn: 'asc' },
  });
  if (!oldest?.dueOn) return null;
  return Math.round((Date.parse(`${on}T00:00:00Z`) - oldest.dueOn.getTime()) / 86_400_000);
}

// ── Paying ──────────────────────────────────────────────────────────────────────────────

async function checkoutFor(
  deps: BillingDeps,
  invoice: { id: string; totalMinor: bigint; currency: string; organisationId: string },
  email: string,
) {
  const reference = newPaymentReference();
  const session = await deps.provider
    .createCheckout({
      reference,
      amountMinor: invoice.totalMinor,
      currency: invoice.currency,
      email,
      callbackUrl: billingUrl(deps.config),
      metadata: { for: 'subscription', invoiceId: invoice.id },
    })
    .catch((err: unknown) => {
      if (err instanceof PaymentProviderError) {
        throw new AppError(
          'PAYMENT_PROVIDER_UNAVAILABLE',
          'The payment provider could not make a payment link; try again in a minute',
        );
      }
      throw err;
    });
  await deps.db.platformInvoiceCheckout.create({
    data: {
      invoiceId: invoice.id,
      provider: deps.provider.name,
      providerRef: reference,
      checkoutUrl: session.checkoutUrl,
      createdAt: deps.clock(),
    },
  });
  return session.checkoutUrl;
}

async function unpaidInvoice(db: Db, organisationId: string, invoiceId: string) {
  const invoice = await db.platformInvoice.findFirst({ where: { id: invoiceId, organisationId } });
  if (!invoice) throw new AppError('NOT_FOUND', 'Invoice not found');
  if (invoice.status !== 'ISSUED') {
    throw new AppError(
      'STATE_TRANSITION_INVALID',
      `This invoice is ${invoice.status.toLowerCase()}`,
    );
  }
  return invoice;
}

/** A fresh payment link for one of the owner's unpaid invoices. */
export async function payLink(deps: BillingDeps, tenant: TenantContext, invoiceId: string) {
  const invoice = await unpaidInvoice(deps.db, tenant.organisationId, invoiceId);
  const user = await deps.db.user.findUniqueOrThrow({ where: { id: tenant.userId } });
  const email = user.email ?? (await ownerEmails(deps.db, tenant.organisationId))[0];
  if (!email) {
    throw new AppError('STATE_TRANSITION_INVALID', 'Add an email address to pay online');
  }
  return { checkoutUrl: await checkoutFor(deps, invoice, email) };
}

/** Asks the provider about the invoice's links, for when a webhook is late or missing. */
export async function checkPayment(deps: BillingDeps, tenant: TenantContext, invoiceId: string) {
  const invoice = await deps.db.platformInvoice.findFirst({
    where: { id: invoiceId, organisationId: tenant.organisationId },
    include: { checkouts: { orderBy: { createdAt: 'desc' }, take: 10 } },
  });
  if (!invoice) throw new AppError('NOT_FOUND', 'Invoice not found');
  for (const c of invoice.checkouts) {
    if (invoice.status !== 'ISSUED') break;
    let charge: Charge;
    try {
      charge = await deps.provider.verify(c.providerRef);
    } catch {
      throw new AppError(
        'PAYMENT_PROVIDER_UNAVAILABLE',
        'The payment provider could not be asked; try again in a minute',
      );
    }
    if (charge.status === 'SUCCEEDED') {
      await settleCheckout(deps.db, deps.clock, c.providerRef, charge);
      break;
    }
  }
  const row = await deps.db.platformInvoice.findUniqueOrThrow({ where: { id: invoiceId } });
  return { status: row.status as 'ISSUED' | 'PAID' | 'VOID' };
}

/**
 * Records a succeeded charge on one of our invoice links (webhook or check). True when the
 * reference is one of ours, whether or not it changed anything (a replay changes nothing).
 */
export async function settleCheckout(
  db: Db,
  clock: Clock,
  reference: string,
  charge: { amountMinor: bigint; currency: string; paidAt: Date | null },
): Promise<boolean> {
  const checkout = await db.platformInvoiceCheckout.findUnique({
    where: { providerRef: reference },
    include: { invoice: true },
  });
  if (!checkout) return false;
  const invoice = checkout.invoice;
  if (charge.amountMinor !== invoice.totalMinor || charge.currency !== invoice.currency) {
    throw new Error(
      `Subscription payment ${reference} paid ${charge.currency} ${charge.amountMinor}, not ${invoice.currency} ${invoice.totalMinor}`,
    );
  }
  const now = clock();
  await db.$transaction(async (tx) => {
    const claimed = await tx.platformInvoice.updateMany({
      where: { id: invoice.id, status: 'ISSUED' },
      data: { status: 'PAID', paidAt: charge.paidAt ?? now, paidRef: reference },
    });
    if (claimed.count !== 1) return;
    await addCommission(tx, invoice, now);
    await recordAudit(tx, {
      organisationId: invoice.organisationId,
      propertyId: null,
      action: 'platform.invoice_paid',
      entityType: 'platform_invoice',
      entityId: invoice.id,
      actorType: 'SYSTEM',
      actorUserId: null,
      before: { status: 'ISSUED' },
      after: { status: 'PAID', reference },
    });
    await afterPaid(tx, invoice.organisationId, day(now), null);
  });
  return true;
}

/** Once nothing is overdue any more, a PAST_DUE or SUSPENDED group is ACTIVE again. */
export async function afterPaid(
  tx: Tx,
  organisationId: string,
  on: string,
  auth: AuthContext | null,
): Promise<void> {
  const s = await tx.subscription.findUnique({ where: { organisationId } });
  if (!s || (s.status !== 'PAST_DUE' && s.status !== 'SUSPENDED')) return;
  const late = await overdueDays(tx, organisationId, on);
  if (late !== null && late > 0) return;
  await tx.subscription.update({
    where: { organisationId },
    data: { status: 'ACTIVE', suspendedAt: null },
  });
  await recordAudit(tx, {
    organisationId,
    propertyId: null,
    action: 'platform.subscription_reactivated',
    entityType: 'subscription',
    entityId: organisationId,
    actorType: auth ? 'SUPPORT' : 'SYSTEM',
    actorUserId: auth?.user.id ?? null,
    before: { status: s.status },
    after: { status: 'ACTIVE' },
    reason: 'Paid',
  });
}

// ── Suspension (M13-06) ─────────────────────────────────────────────────────────────────

export async function suspend(
  deps: BillingDeps,
  auth: AuthContext,
  organisationId: string,
  reason: string,
) {
  const on = today(deps.clock);
  const result = await deps.db.$transaction(async (tx) => {
    const s = await tx.subscription.findUnique({ where: { organisationId } });
    if (!s) throw new AppError('NOT_FOUND', 'Hotel group not found');
    if (s.status === 'SUSPENDED') {
      throw new AppError('STATE_TRANSITION_INVALID', 'This hotel group is suspended already');
    }
    const late = await overdueDays(tx, organisationId, on);
    if (late === null || late < SUSPENSION_GRACE_DAYS) {
      throw new AppError(
        'STATE_TRANSITION_INVALID',
        `A group can be suspended once an invoice is ${SUSPENSION_GRACE_DAYS} days past due`,
        { overdueDays: late },
      );
    }
    await tx.subscription.update({
      where: { organisationId },
      data: { status: 'SUSPENDED', suspendedAt: deps.clock() },
    });
    await recordAudit(tx, {
      organisationId,
      propertyId: null,
      action: 'platform.subscription_suspended',
      entityType: 'subscription',
      entityId: organisationId,
      actorType: 'SUPPORT',
      actorUserId: auth.user.id,
      before: { status: s.status },
      after: { status: 'SUSPENDED', overdueDays: late },
      reason,
    });
    return ownerEmails(tx, organisationId);
  });
  for (const to of result) {
    await deps.email
      .send({
        to,
        subject: 'Your hotel account is suspended',
        text: [
          'Your hotel account has been suspended because an invoice is unpaid.',
          '',
          'You and your team can still sign in, see everything and export your data, but nothing can be changed until it is paid.',
          `Pay it here: ${billingUrl(deps.config)}`,
        ].join('\n'),
        tag: 'subscription-suspended',
      })
      .catch(() => undefined);
  }
  return { status: 'SUSPENDED' as const };
}

export async function reactivate(
  deps: BillingDeps,
  auth: AuthContext,
  organisationId: string,
  reason: string,
) {
  return deps.db.$transaction(async (tx) => {
    const s = await tx.subscription.findUnique({ where: { organisationId } });
    if (!s) throw new AppError('NOT_FOUND', 'Hotel group not found');
    if (s.status !== 'SUSPENDED' && s.status !== 'PAST_DUE') {
      throw new AppError('STATE_TRANSITION_INVALID', 'This hotel group is not suspended');
    }
    await tx.subscription.update({
      where: { organisationId },
      data: { status: 'ACTIVE', suspendedAt: null },
    });
    await recordAudit(tx, {
      organisationId,
      propertyId: null,
      action: 'platform.subscription_reactivated',
      entityType: 'subscription',
      entityId: organisationId,
      actorType: 'SUPPORT',
      actorUserId: auth.user.id,
      before: { status: s.status },
      after: { status: 'ACTIVE' },
      reason,
    });
    return { status: 'ACTIVE' as const };
  });
}

// ── The monthly run ─────────────────────────────────────────────────────────────────────

/**
 * Invoices last month for every paying group not yet invoiced for it (any invoice for the
 * month counts, voided ones too, so staff's corrections stand), emails the owners a payment
 * link, and marks groups with an invoice past its due date PAST_DUE. Safe to run every day.
 */
export async function runBilling(deps: BillingDeps): Promise<{ issued: number; pastDue: number }> {
  const on = today(deps.clock);
  const month = previousMonth(on);
  const periodEnd = new Date(`${month}-01T00:00:00Z`);
  periodEnd.setUTCMonth(periodEnd.getUTCMonth() + 1);
  const subs = await deps.db.subscription.findMany({
    where: { status: { in: ['ACTIVE', 'PAST_DUE'] } },
    include: { organisation: { select: { createdAt: true } } },
  });
  let issued = 0;
  for (const s of subs) {
    // A group that signed up after the month ended owes nothing for it.
    if (s.organisation.createdAt >= periodEnd) continue;
    const already = await deps.db.platformInvoice.count({
      where: { organisationId: s.organisationId, periodStart: new Date(`${month}-01T00:00:00Z`) },
    });
    if (already > 0) continue;
    let invoice;
    try {
      invoice = await issueMonth(deps.db, s.organisationId, month, deps.clock(), null);
    } catch (err) {
      if (err instanceof AppError) continue; // issued meanwhile
      throw err;
    }
    issued += 1;
    const owners = await ownerEmails(deps.db, s.organisationId);
    if (owners.length === 0) continue;
    let link = billingUrl(deps.config);
    try {
      const row = await deps.db.platformInvoice.findUniqueOrThrow({ where: { id: invoice.id } });
      link = await checkoutFor(deps, row, owners[0] as string);
    } catch (err) {
      // The invoice stands; the owner pays from the billing page instead.
      if (!(err instanceof AppError)) throw err;
    }
    for (const to of owners) {
      await deps.email
        .send({
          to,
          subject: `Invoice ${invoice.number} for ${month}`,
          text: [
            `Your invoice for ${month} is ready: ${money(BigInt(invoice.totalMinor), invoice.currency)} for ${invoice.activeRooms} active rooms.`,
            `It is due by ${invoice.dueOn ?? addDays(on, INVOICE_DUE_DAYS)}.`,
            '',
            `Pay online: ${link}`,
            `All your invoices: ${billingUrl(deps.config)}`,
          ].join('\n'),
          tag: 'subscription-invoice',
        })
        .catch(() => undefined);
    }
  }

  let pastDue = 0;
  const late = await deps.db.platformInvoice.findMany({
    where: { status: 'ISSUED', dueOn: { lt: new Date(`${on}T00:00:00Z`) } },
    select: { organisationId: true },
    distinct: ['organisationId'],
  });
  for (const { organisationId } of late) {
    const changed = await deps.db.$transaction(async (tx) => {
      const moved = await tx.subscription.updateMany({
        where: { organisationId, status: 'ACTIVE' },
        data: { status: 'PAST_DUE' },
      });
      if (moved.count !== 1) return [];
      await recordAudit(tx, {
        organisationId,
        propertyId: null,
        action: 'platform.subscription_past_due',
        entityType: 'subscription',
        entityId: organisationId,
        actorType: 'SYSTEM',
        actorUserId: null,
        before: { status: 'ACTIVE' },
        after: { status: 'PAST_DUE' },
      });
      return ownerEmails(tx, organisationId);
    });
    if (changed.length > 0) pastDue += 1;
    for (const to of changed) {
      await deps.email
        .send({
          to,
          subject: 'Your hotel invoice is overdue',
          text: [
            'An invoice for your hotel account is past its due date.',
            `If it is not paid within ${SUSPENSION_GRACE_DAYS} days of the due date, the account may be suspended: still readable and exportable, but nothing can be changed until it is paid.`,
            '',
            `Pay it here: ${billingUrl(deps.config)}`,
          ].join('\n'),
          tag: 'subscription-overdue',
        })
        .catch(() => undefined);
    }
  }
  return { issued, pastDue };
}

/** Daily: issue the month's invoices once it has ended, and mark late payers. */
export function platformBillingJob(deps: {
  payments: PaymentProvider;
  email: EmailProvider;
  config: Config;
}) {
  return defineJob({
    name: 'platform-billing',
    // 06:30 UTC = 07:30 in Lagos: invoices arrive at the start of the working day.
    schedule: { cron: '30 6 * * *' },
    async run(_data, { db, clock, logger }) {
      const result = await runBilling({ db, clock, logger, provider: deps.payments, ...deps });
      if (result.issued + result.pastDue > 0) logger.info(result, 'Platform billing run');
    },
  });
}
