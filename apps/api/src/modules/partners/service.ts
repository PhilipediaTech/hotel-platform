import type { PartnerDetail, PartnerHome, PartnerItem, PartnerPatch } from '@hotel/shared';
import { randomInt } from 'node:crypto';
import type { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client.ts';
import { recordAudit } from '../../core/audit.ts';
import type { AuthContext } from '../../core/auth.ts';
import type { Clock } from '../../core/clock.ts';
import type { Config } from '../../core/config.ts';
import type { Db } from '../../core/db.ts';
import type { EmailProvider } from '../../core/email.ts';
import { AppError } from '../../core/errors.ts';
import { decryptSecret, encryptSecret } from '../../core/mfa.ts';
import { appLink, issueLinkToken } from '../identity/service.ts';

// Referral partners (PRD M14-06–M14-08, M14 rules and AC; T-110). Commission is the platform's
// liability, paid outside the app: this keeps the ledger and shows it. A partner's own view
// carries hotel name, plan and status and nothing else about a hotel.

export interface PartnerDeps {
  db: Db;
  clock: Clock;
  config: Config;
  email: EmailProvider;
}

type Tx = Prisma.TransactionClient;
type Item = z.infer<typeof PartnerItem>;
type Detail = z.infer<typeof PartnerDetail>;
type Partner = Prisma.ReferralPartnerGetPayload<object>;

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const day = (d: Date) => d.toISOString().slice(0, 10);

// No 0/O or 1/I: codes get read out over the phone.
const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const newCode = () =>
  Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');

const signUpLink = (deps: Pick<PartnerDeps, 'config'>, code: string) =>
  `${deps.config.appOrigin}/sign-up?ref=${code}`;

function addMonths(from: Date, months: number): Date {
  const out = new Date(from);
  out.setUTCMonth(out.getUTCMonth() + months);
  return out;
}

// ── The ledger ──────────────────────────────────────────────────────────────────────────

/**
 * Adds a paid invoice's commission to the partner's ledger, inside the transaction that marks
 * it paid. One line per invoice, ever: however often payment is reported (M14 AC), the unique
 * index on invoice_id keeps the second one out. The term runs from the first paid invoice.
 */
export async function addCommission(
  tx: Tx,
  invoice: { id: string; organisationId: string; totalMinor: bigint; currency: string },
  now: Date,
): Promise<void> {
  const referral = await tx.partnerReferral.findUnique({
    where: { organisationId: invoice.organisationId },
    include: { partner: true },
  });
  if (!referral) return;
  const firstPaidAt = referral.firstPaidAt ?? now;
  if (!referral.firstPaidAt) {
    await tx.partnerReferral.update({
      where: { organisationId: invoice.organisationId },
      data: { firstPaidAt },
    });
  }
  if (now >= addMonths(firstPaidAt, referral.partner.durationMonths)) return;
  const { commissionBps } = referral.partner;
  const amountMinor = (invoice.totalMinor * BigInt(commissionBps)) / 10_000n;
  if (amountMinor <= 0n) return;
  await tx.partnerCommission.createMany({
    data: [
      {
        partnerId: referral.partnerId,
        organisationId: invoice.organisationId,
        invoiceId: invoice.id,
        commissionBps,
        amountMinor,
        currency: invoice.currency,
        earnedAt: now,
      },
    ],
    skipDuplicates: true,
  });
}

function totalsOf(lines: { amountMinor: bigint; currency: string; payoutId: string | null }[]) {
  const byCurrency = new Map<string, { earned: bigint; paid: bigint }>();
  for (const l of lines) {
    const t = byCurrency.get(l.currency) ?? { earned: 0n, paid: 0n };
    t.earned += l.amountMinor;
    if (l.payoutId) t.paid += l.amountMinor;
    byCurrency.set(l.currency, t);
  }
  return [...byCurrency.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, t]) => ({
      currency,
      earnedMinor: t.earned.toString(),
      paidMinor: t.paid.toString(),
      owedMinor: (t.earned - t.paid).toString(),
    }));
}

// ── Shapes ──────────────────────────────────────────────────────────────────────────────

const LINE_INCLUDE = {
  organisation: { select: { name: true } },
  invoice: { select: { periodStart: true } },
} satisfies Prisma.PartnerCommissionInclude;
type Line = Prisma.PartnerCommissionGetPayload<{ include: typeof LINE_INCLUDE }>;

const lineOf = (l: Line) => ({
  id: l.id,
  hotel: l.organisation.name,
  periodStart: day(l.invoice.periodStart),
  commissionBps: l.commissionBps,
  amountMinor: l.amountMinor.toString(),
  currency: l.currency,
  earnedAt: iso(l.earnedAt),
  paid: l.payoutId !== null,
});

const payoutOf = (p: Prisma.PartnerPayoutGetPayload<object>) => ({
  id: p.id,
  amountMinor: p.amountMinor.toString(),
  currency: p.currency,
  reference: p.reference,
  paidAt: iso(p.paidAt),
});

async function hotelsOf(db: Db, partnerId: string) {
  const referrals = await db.partnerReferral.findMany({
    where: { partnerId },
    include: { organisation: { select: { name: true, subscription: true } } },
    orderBy: { tiedAt: 'desc' },
  });
  type Hotel = Detail['hotelList'][number];
  return referrals.map((r) => ({
    organisationId: r.organisationId,
    name: r.organisation.name,
    plan: (r.organisation.subscription?.plan ?? null) as Hotel['plan'],
    status: (r.organisation.subscription?.status ?? null) as Hotel['status'],
  }));
}

function baseOf(deps: PartnerDeps, p: Partner) {
  return {
    id: p.id,
    name: p.name,
    country: p.country,
    contactName: p.contactName,
    email: p.email,
    phone: p.phone,
    commissionBps: p.commissionBps,
    durationMonths: p.durationMonths,
    code: p.code,
    signUpLink: signUpLink(deps, p.code),
    active: p.active,
    createdAt: iso(p.createdAt),
  };
}

export async function listPartners(deps: PartnerDeps): Promise<{ data: Item[] }> {
  const partners = await deps.db.referralPartner.findMany({
    orderBy: { name: 'asc' },
    include: {
      commissions: { select: { amountMinor: true, currency: true, payoutId: true } },
      _count: { select: { referrals: true } },
    },
  });
  return {
    data: partners.map((p) => ({
      ...baseOf(deps, p),
      hotels: p._count.referrals,
      totals: totalsOf(p.commissions),
    })),
  };
}

async function find(db: Db | Tx, partnerId: string): Promise<Partner> {
  const p = await db.referralPartner.findUnique({ where: { id: partnerId } });
  if (!p) throw new AppError('NOT_FOUND', 'Partner not found');
  return p;
}

const ledger = (db: Db, partnerId: string) =>
  Promise.all([
    hotelsOf(db, partnerId),
    db.partnerCommission.findMany({
      where: { partnerId },
      include: LINE_INCLUDE,
      orderBy: { earnedAt: 'desc' },
    }),
    db.partnerPayout.findMany({ where: { partnerId }, orderBy: { paidAt: 'desc' } }),
  ]);

export async function getPartner(deps: PartnerDeps, partnerId: string): Promise<Detail> {
  const p = await find(deps.db, partnerId);
  const [hotelList, lines, payouts] = await ledger(deps.db, p.id);
  return {
    ...baseOf(deps, p),
    payoutDetails: p.payoutDetailsEnc ? decryptSecret(deps.config.idKey, p.payoutDetailsEnc) : null,
    hotels: hotelList.length,
    hotelList,
    totals: totalsOf(lines),
    commissions: lines.map(lineOf),
    payouts: payouts.map(payoutOf),
  };
}

function change(
  tx: Tx,
  auth: AuthContext,
  partnerId: string,
  now: Date,
  input: { action: string; before?: object; after?: object },
) {
  return tx.partnerChange.create({
    data: { partnerId, actorUserId: auth.user.id, at: now, ...input },
  });
}

// ── Platform staff (M14-06, M14-08) ─────────────────────────────────────────────────────

const encrypted = (deps: PartnerDeps, details: string | null) =>
  details ? encryptSecret(deps.config.idKey, details) : null;

/** What a change log may show: the payout details themselves never go in it. */
function loggable(p: Partner) {
  return {
    name: p.name,
    commissionBps: p.commissionBps,
    durationMonths: p.durationMonths,
    active: p.active,
    hasPayoutDetails: p.payoutDetailsEnc !== null,
  };
}

export async function createPartner(
  deps: PartnerDeps,
  auth: AuthContext,
  body: {
    name: string;
    country: string;
    contactName: string | null;
    email: string;
    phone: string | null;
    payoutDetails: string | null;
    commissionBps: number;
    durationMonths: number;
  },
): Promise<Detail> {
  const now = deps.clock();
  if (await deps.db.referralPartner.findUnique({ where: { email: body.email } })) {
    throw new AppError('STATE_TRANSITION_INVALID', 'A partner with this email already exists');
  }
  let code = newCode();
  while (await deps.db.referralPartner.findUnique({ where: { code } })) code = newCode();
  const { partner, user, token } = await deps.db.$transaction(async (tx) => {
    const account =
      (await tx.user.findUnique({ where: { email: body.email } })) ??
      (await tx.user.create({
        data: {
          email: body.email,
          name: body.contactName ?? body.name,
          status: 'ACTIVE',
          emailVerifiedAt: now,
        },
      }));
    const created = await tx.referralPartner.create({
      data: {
        name: body.name,
        country: body.country,
        contactName: body.contactName,
        email: body.email,
        phone: body.phone,
        payoutDetailsEnc: encrypted(deps, body.payoutDetails),
        commissionBps: body.commissionBps,
        durationMonths: body.durationMonths,
        code,
        userId: account.id,
        createdAt: now,
      },
    });
    await change(tx, auth, created.id, now, {
      action: 'partner.created',
      after: loggable(created),
    });
    // An account that already has a password keeps it; a new one chooses one from the email.
    const link = account.passwordHash
      ? null
      : await issueLinkToken(tx, deps, account.id, 'PASSWORD_RESET');
    return { partner: created, user: account, token: link };
  });
  await deps.email.send({
    to: body.email,
    tag: 'partner-welcome',
    subject: 'Your referral partner account',
    text: [
      `Hello ${user.name},`,
      '',
      `Your partner code is ${partner.code}. Hotels that sign up with it are tied to you:`,
      signUpLink(deps, partner.code),
      '',
      token
        ? `Choose a password to see your hotels and earnings: ${appLink(deps, '/reset-password', token)}`
        : `Sign in with your existing account to see your hotels and earnings: ${appLink(deps, '/sign-in')}`,
    ].join('\n'),
  });
  return getPartner(deps, partner.id);
}

export async function updatePartner(
  deps: PartnerDeps,
  auth: AuthContext,
  partnerId: string,
  body: z.infer<typeof PartnerPatch>,
): Promise<Detail> {
  await deps.db.$transaction(async (tx) => {
    const before = await find(tx, partnerId);
    const { payoutDetails, name, contactName, phone, commissionBps, durationMonths, active } = body;
    const after = await tx.referralPartner.update({
      where: { id: partnerId },
      data: {
        ...(name === undefined ? {} : { name }),
        ...(contactName === undefined ? {} : { contactName }),
        ...(phone === undefined ? {} : { phone }),
        ...(commissionBps === undefined ? {} : { commissionBps }),
        ...(durationMonths === undefined ? {} : { durationMonths }),
        ...(active === undefined ? {} : { active }),
        ...(payoutDetails === undefined
          ? {}
          : { payoutDetailsEnc: encrypted(deps, payoutDetails) }),
      },
    });
    await change(tx, auth, partnerId, deps.clock(), {
      action: 'partner.updated',
      before: loggable(before),
      after: loggable(after),
    });
  });
  return getPartner(deps, partnerId);
}

export async function recordPayout(
  deps: PartnerDeps,
  auth: AuthContext,
  partnerId: string,
  body: { currency: string; reference: string },
): Promise<Detail> {
  const now = deps.clock();
  await find(deps.db, partnerId);
  await deps.db.$transaction(async (tx) => {
    // One payout at a time per partner, so an unpaid line can't go into two.
    await tx.$queryRaw`SELECT id FROM referral_partners WHERE id = ${partnerId}::uuid FOR UPDATE`;
    const owed = await tx.partnerCommission.findMany({
      where: { partnerId, currency: body.currency, payoutId: null },
      select: { id: true, amountMinor: true },
    });
    const amountMinor = owed.reduce((sum, l) => sum + l.amountMinor, 0n);
    if (amountMinor <= 0n) {
      throw new AppError('STATE_TRANSITION_INVALID', `Nothing is owed in ${body.currency}`);
    }
    const payout = await tx.partnerPayout.create({
      data: {
        partnerId,
        amountMinor,
        currency: body.currency,
        reference: body.reference,
        paidById: auth.user.id,
        paidAt: now,
      },
    });
    await tx.partnerCommission.updateMany({
      where: { id: { in: owed.map((l) => l.id) } },
      data: { payoutId: payout.id },
    });
    await change(tx, auth, partnerId, now, {
      action: 'partner.payout_recorded',
      after: {
        amountMinor: amountMinor.toString(),
        currency: body.currency,
        reference: body.reference,
      },
    });
  });
  return getPartner(deps, partnerId);
}

// ── The tie (M14-07) ────────────────────────────────────────────────────────────────────

export async function getTenantPartner(deps: PartnerDeps, organisationId: string) {
  const r = await deps.db.partnerReferral.findUnique({
    where: { organisationId },
    include: { partner: { select: { id: true, name: true } } },
  });
  return {
    partner: r?.partner ?? null,
    firstPaidAt: r?.firstPaidAt ? iso(r.firstPaidAt) : null,
  };
}

export async function setTenantPartner(
  deps: PartnerDeps,
  auth: AuthContext,
  organisationId: string,
  body: { partnerId: string | null; reason: string | null },
) {
  const now = deps.clock();
  const org = await deps.db.organisation.findUnique({ where: { id: organisationId } });
  if (!org) throw new AppError('NOT_FOUND', 'Hotel group not found');
  await deps.db.$transaction(async (tx) => {
    const before = await tx.partnerReferral.findUnique({ where: { organisationId } });
    if ((before?.partnerId ?? null) === body.partnerId) return;
    if (body.partnerId) await find(tx, body.partnerId);
    const paid = await tx.platformInvoice.count({ where: { organisationId, status: 'PAID' } });
    if (paid > 0 && !body.reason) {
      throw new AppError('VALIDATION_ERROR', 'Request validation failed.', {
        issues: [
          {
            path: 'body.reason',
            code: 'required',
            message: 'This group has paid an invoice: give a reason for changing its partner',
          },
        ],
      });
    }
    if (body.partnerId) {
      await tx.partnerReferral.upsert({
        where: { organisationId },
        create: { organisationId, partnerId: body.partnerId, source: 'ADMIN', tiedAt: now },
        update: { partnerId: body.partnerId, source: 'ADMIN', tiedAt: now },
      });
    } else {
      await tx.partnerReferral.delete({ where: { organisationId } });
    }
    await recordAudit(tx, {
      organisationId,
      propertyId: null,
      actorUserId: auth.user.id,
      actorType: 'SUPPORT',
      action: 'platform.partner_changed',
      entityType: 'partner_referral',
      entityId: organisationId,
      before: { partnerId: before?.partnerId ?? null },
      after: { partnerId: body.partnerId },
      ...(body.reason ? { reason: body.reason } : {}),
    });
  });
  return getTenantPartner(deps, organisationId);
}

/** The partner whose code a hotel signed up with; an unknown or retired code is refused. */
export async function partnerForCode(db: Db, code: string): Promise<{ id: string }> {
  const partner = await db.referralPartner.findUnique({ where: { code } });
  if (!partner?.active) {
    throw new AppError('VALIDATION_ERROR', 'Request validation failed.', {
      issues: [
        {
          path: 'body.referralCode',
          code: 'invalid',
          message: 'We don’t recognise this code. Check it, or leave it empty.',
        },
      ],
    });
  }
  return { id: partner.id };
}

// ── The partner's own view (M14-08) ─────────────────────────────────────────────────────

export async function partnerHome(
  deps: PartnerDeps,
  auth: AuthContext,
): Promise<z.infer<typeof PartnerHome>> {
  const p = await deps.db.referralPartner.findUnique({ where: { userId: auth.user.id } });
  if (!p) throw new AppError('FORBIDDEN', 'Referral partners only.');
  const [hotels, lines, payouts] = await ledger(deps.db, p.id);
  return {
    name: p.name,
    code: p.code,
    signUpLink: signUpLink(deps, p.code),
    active: p.active,
    commissionBps: p.commissionBps,
    durationMonths: p.durationMonths,
    hotels: hotels.map(({ name, plan, status }) => ({ name, plan, status })),
    totals: totalsOf(lines),
    commissions: lines.map(lineOf),
    payouts: payouts.map(payoutOf),
  };
}
