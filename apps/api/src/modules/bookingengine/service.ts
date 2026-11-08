import {
  cancellationFee,
  PaymentIntentBody,
  ReservationBody,
  type BookingEngineSettingsBody,
  type BookingEngineSettingsItem,
  type FeeRule,
  type PromoBody,
  type PromoItem,
  type PublicAvailabilityQuery,
  type PublicBooking,
  type PublicBookingBody,
  type PublicBookingCreated,
  type PublicProperty,
} from '@hotel/shared';
import { createHmac, randomUUID } from 'node:crypto';
import type { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client.ts';
import { recordAudit } from '../../core/audit.ts';
import { businessDate } from '../../core/business-day.ts';
import type { Clock } from '../../core/clock.ts';
import type { Config } from '../../core/config.ts';
import { pgErrorInfo, type Db } from '../../core/db.ts';
import type { EmailProvider } from '../../core/email.ts';
import { AppError } from '../../core/errors.ts';
import type { FileStore } from '../../core/files.ts';
import type { PaymentProvider } from '../../core/payments.ts';
import { runAsTenant, type TenantContext } from '../../core/tenancy.ts';
import type { TenantDb } from '../../core/tenant-db.ts';
import { hashToken } from '../../core/tokens.ts';
import { createQuote, getAvailability } from '../availability/quotes.ts';
import { createPaymentIntent } from '../payments/intents.ts';
import { cancelReservation, createReservation, getReservation } from '../reservations/service.ts';
import { guestTenant, queueConfirmation } from './after-payment.ts';

// The booking engine (PRD M11-01–M11-03, M11 rules and AC; tab 4 "Public booking"; T-112). Every
// price and room count comes from the front desk's own services, run as the hotel with no
// user behind them. A guest's link is a secret worked out from the row's ID, so it can be
// sent again without being stored: the database keeps only its hash.

export interface BookingEngineDeps {
  db: Db;
  tenantDb: TenantDb;
  clock: Clock;
  config: Config;
  provider: PaymentProvider;
  email: EmailProvider;
  store: FileStore;
}

/** How long an unpaid online booking keeps its room. */
export const ONLINE_HOLD_MINUTES = 30;

type Settings = Prisma.BookingEngineSettingsGetPayload<object>;
type Promo = Prisma.PromoCodeGetPayload<object>;
type SettingsOut = z.input<typeof BookingEngineSettingsItem>;

const day = (d: Date) => d.toISOString().slice(0, 10);
const dbDate = (date: string | null) => (date ? new Date(`${date}T00:00:00Z`) : null);

const invalid = (path: string, message: string) =>
  new AppError('VALIDATION_ERROR', 'Request validation failed.', {
    issues: [{ path, code: 'custom', message }],
  });

const linkToken = (deps: Pick<BookingEngineDeps, 'config'>, linkId: string) =>
  createHmac('sha256', deps.config.sessionSecret)
    .update(`guest-link:${linkId}`)
    .digest('base64url');

// ── Settings (M11-03) ───────────────────────────────────────────────────────────────────

function settingsOf(deps: BookingEngineDeps, s: Settings | null): SettingsOut {
  const pageUrl = s ? `${deps.config.siteOrigin}/${s.slug}` : null;
  return {
    slug: s?.slug ?? null,
    enabled: s?.enabled ?? false,
    headline: s?.headline ?? null,
    description: s?.description ?? null,
    policies: s?.policies ?? null,
    photoFileIds: s?.photoFileIds ?? [],
    allowPayFull: s?.allowPayFull ?? true,
    allowDeposit: s?.allowDeposit ?? true,
    depositBps: s?.depositBps ?? 3000,
    allowPayAtHotel: s?.allowPayAtHotel ?? true,
    pageUrl,
    embedSnippet: pageUrl
      ? `<iframe src="${pageUrl}" title="Book a room" style="width:100%;height:800px;border:0"></iframe>`
      : null,
  };
}

export async function getSettings(deps: BookingEngineDeps) {
  return settingsOf(deps, await deps.tenantDb.bookingEngineSettings.findFirst({}));
}

export async function saveSettings(
  deps: BookingEngineDeps,
  tenant: TenantContext,
  body: z.output<typeof BookingEngineSettingsBody>,
) {
  if (body.enabled && !body.allowPayFull && !body.allowDeposit && !body.allowPayAtHotel) {
    throw invalid('body.allowPayFull', 'Leave at least one way to pay');
  }
  if (body.photoFileIds.length > 0) {
    const found = await deps.tenantDb.fileObject.count({
      where: { id: { in: body.photoFileIds }, entityType: 'BookingEngine' },
    });
    if (found !== new Set(body.photoFileIds).size) {
      throw invalid('body.photoFileIds', 'Upload the photos first');
    }
  }
  try {
    return await deps.tenantDb.$transaction(async (tx) => {
      const before = await tx.bookingEngineSettings.findFirst({});
      const row = before
        ? await tx.bookingEngineSettings.update({
            where: { propertyId: tenant.propertyId },
            data: body,
          })
        : await tx.bookingEngineSettings.create({
            data: body as Prisma.BookingEngineSettingsUncheckedCreateInput,
          });
      await recordAudit(tx, {
        action: 'bookingengine.settings_saved',
        entityType: 'booking_engine_settings',
        entityId: tenant.propertyId,
        after: { slug: body.slug, enabled: body.enabled },
      });
      return settingsOf(deps, row);
    });
  } catch (err) {
    if (pgErrorInfo(err)?.constraint?.includes('slug') || isUnique(err)) {
      throw invalid('body.slug', 'Another hotel already uses this address');
    }
    throw err;
  }
}

const isUnique = (err: unknown) => (err as { code?: string }).code === 'P2002';

function promoOf(p: Promo): z.input<typeof PromoItem> {
  return {
    id: p.id,
    code: p.code,
    discountBps: p.discountBps,
    validFrom: p.validFrom ? day(p.validFrom) : null,
    validTo: p.validTo ? day(p.validTo) : null,
    maxUses: p.maxUses,
    usedCount: p.usedCount,
    active: p.active,
  };
}

export async function listPromos(deps: BookingEngineDeps) {
  const rows = await deps.tenantDb.promoCode.findMany({ orderBy: { code: 'asc' } });
  return { data: rows.map(promoOf) };
}

export async function createPromo(deps: BookingEngineDeps, body: z.output<typeof PromoBody>) {
  try {
    return await deps.tenantDb.$transaction(async (tx) => {
      const row = await tx.promoCode.create({
        data: {
          ...body,
          validFrom: dbDate(body.validFrom),
          validTo: dbDate(body.validTo),
        } as Prisma.PromoCodeUncheckedCreateInput,
      });
      await recordAudit(tx, {
        action: 'bookingengine.promo_created',
        entityType: 'promo_code',
        entityId: row.id,
        after: { code: row.code, discountBps: row.discountBps },
      });
      return promoOf(row);
    });
  } catch (err) {
    if (isUnique(err)) throw invalid('body.code', 'This code already exists');
    throw err;
  }
}

export async function updatePromo(deps: BookingEngineDeps, id: string, active: boolean) {
  return deps.tenantDb.$transaction(async (tx) => {
    const found = await tx.promoCode.findFirst({ where: { id } });
    if (!found) throw new AppError('NOT_FOUND', 'Promo code not found');
    const row = await tx.promoCode.update({ where: { id }, data: { active } });
    await recordAudit(tx, {
      action: 'bookingengine.promo_changed',
      entityType: 'promo_code',
      entityId: id,
      before: { active: found.active },
      after: { active },
    });
    return promoOf(row);
  });
}

// ── The public page (M11-01) ────────────────────────────────────────────────────────────

/** A hotel's page, if it is switched on and the hotel is live. Anything else is not found. */
async function pageOf(db: Db, slug: string) {
  const s = await db.bookingEngineSettings.findUnique({
    where: { slug: slug.toLowerCase() },
    include: { property: true },
  });
  if (!s?.enabled || s.property.status !== 'LIVE') {
    throw new AppError('NOT_FOUND', 'This booking page is not available');
  }
  return s;
}
type Page = Awaited<ReturnType<typeof pageOf>>;

async function photoUrls(deps: BookingEngineDeps, propertyId: string, ids: string[]) {
  if (ids.length === 0) return [];
  const files = await deps.db.fileObject.findMany({
    where: { id: { in: ids }, propertyId, scan: 'CLEAN' },
  });
  const urls = new Map<string, string>();
  for (const f of files) {
    const signed = await deps.store.presignDownload({
      key: f.storageKey,
      contentType: f.contentType,
      expiresInSeconds: 3600,
    });
    urls.set(f.id, signed.url);
  }
  return ids.flatMap((id) => (urls.has(id) ? [urls.get(id) as string] : []));
}

export async function publicProperty(
  deps: BookingEngineDeps,
  slug: string,
): Promise<z.input<typeof PublicProperty>> {
  const s = await pageOf(deps.db, slug);
  const types = await deps.db.roomType.findMany({
    where: { propertyId: s.propertyId, active: true },
    orderBy: { sortOrder: 'asc' },
  });
  return {
    slug: s.slug,
    name: s.property.name,
    headline: s.headline,
    description: s.description,
    policies: s.policies,
    phone: s.property.phone,
    email: s.property.email,
    address: s.property.address as Record<string, unknown>,
    currency: s.property.baseCurrency,
    checkInTime: s.property.checkInTime,
    checkOutTime: s.property.checkOutTime,
    photoUrls: await photoUrls(deps, s.propertyId, s.photoFileIds),
    payment: {
      full: s.allowPayFull,
      deposit: s.allowDeposit,
      depositBps: s.depositBps,
      atHotel: s.allowPayAtHotel,
    },
    roomTypes: await Promise.all(
      types.map(async (t) => ({
        id: t.id,
        name: t.name,
        description: t.description,
        maxOccupancy: t.maxOccupancy,
        amenities: t.amenities,
        photoUrls: await photoUrls(deps, s.propertyId, t.photoFileIds),
      })),
    ),
  };
}

/** The code's row if it can be used for this arrival today; null otherwise. */
async function usablePromo(
  db: Db,
  page: Page,
  code: string | undefined,
  arrival: string,
): Promise<Promo | null> {
  if (!code) return null;
  const p = await db.promoCode.findUnique({
    where: { propertyId_code: { propertyId: page.propertyId, code } },
  });
  if (!p?.active) return null;
  if (p.maxUses !== null && p.usedCount >= p.maxUses) return null;
  if (p.validFrom && arrival < day(p.validFrom)) return null;
  if (p.validTo && arrival > day(p.validTo)) return null;
  return p;
}

/** Plans the page may sell: marked public, and not day-use or a company's own rate. */
async function publicPlanIds(db: Db, propertyId: string) {
  const plans = await db.ratePlan.findMany({
    where: {
      propertyId,
      isPublic: true,
      active: true,
      companyId: null,
      kind: { in: ['BAR', 'DERIVED', 'PACKAGE'] },
    },
    select: { id: true },
  });
  return new Set(plans.map((p) => p.id));
}

export async function publicAvailability(
  deps: BookingEngineDeps,
  query: z.output<typeof PublicAvailabilityQuery>,
) {
  const page = await pageOf(deps.db, query.slug);
  const tenant = guestTenant(page.property);
  const promo = await usablePromo(deps.db, page, query.promo, query.arrival);
  const allowed = await publicPlanIds(deps.db, page.propertyId);
  const result = await runAsTenant(tenant, () =>
    getAvailability(deps, tenant, query, promo?.discountBps ?? 0),
  );
  return {
    arrival: result.arrival,
    departure: result.departure,
    nights: result.nights,
    currency: result.currency,
    promoApplied: promo !== null,
    roomTypes: result.roomTypes.flatMap((t) => {
      const plans = t.plans.flatMap((p) =>
        p.sellable && p.totalMinor !== null && allowed.has(p.ratePlanId)
          ? [
              {
                ratePlanId: p.ratePlanId,
                name: p.name,
                mealPlan: p.mealPlan,
                totalMinor: p.totalMinor,
              },
            ]
          : [],
      );
      return plans.length > 0
        ? [
            {
              roomTypeId: t.roomTypeId,
              name: t.name,
              maxOccupancy: t.maxOccupancy,
              available: t.available,
              plans,
            },
          ]
        : [];
    }),
  };
}

// ── Booking (M11-01, M11-02) ────────────────────────────────────────────────────────────

function choiceAllowed(page: Page, choice: z.output<typeof PublicBookingBody>['payment']) {
  if (choice === 'FULL') return page.allowPayFull;
  if (choice === 'DEPOSIT') return page.allowDeposit && page.depositBps > 0;
  return page.allowPayAtHotel;
}

/** Same `bookingKey`, same booking: a double-click or a retry never books twice. */
async function alreadyBooked(deps: BookingEngineDeps, page: Page, key: string) {
  const link = await deps.db.guestLink.findUnique({
    where: { propertyId_clientKey: { propertyId: page.propertyId, clientKey: key } },
  });
  if (!link) return null;
  const reservation = await deps.db.reservation.findUniqueOrThrow({
    where: { id: link.reservationId },
    include: {
      stays: { include: { quote: true } },
      paymentIntents: { orderBy: { createdAt: 'desc' }, take: 1 },
    },
  });
  const [intent] = reservation.paymentIntents;
  return {
    token: linkToken(deps, link.id),
    confirmationNo: reservation.confirmationNo,
    status: reservation.status as 'TENTATIVE' | 'CONFIRMED',
    paymentUrl: intent?.status === 'CREATED' ? intent.checkoutUrl : null,
    amountDueNowMinor: (intent?.amountMinor ?? 0n).toString(),
    totalMinor: reservation.stays.reduce((s, x) => s + x.quote.totalMinor, 0n).toString(),
    currency: reservation.stays[0]?.quote.currency ?? page.property.baseCurrency,
  };
}

async function claimPromo(db: Db, id: string): Promise<boolean> {
  const n = await db.$executeRaw`
    UPDATE promo_codes SET used_count = used_count + 1
    WHERE id = ${id}::uuid AND (max_uses IS NULL OR used_count < max_uses)`;
  return n === 1;
}

async function sendLinkEmail(
  deps: BookingEngineDeps,
  page: Page,
  to: string,
  confirmationNo: string,
  token: string,
) {
  await deps.email.send({
    to,
    tag: 'booking-link',
    subject: `Your booking at ${page.property.name}: ${confirmationNo}`,
    text: [
      `Thank you for booking with ${page.property.name}. Your reference is ${confirmationNo}.`,
      '',
      'See your booking, or cancel it within the hotel’s policy, from this private link:',
      `${deps.config.siteOrigin}/${page.slug}/manage?token=${token}`,
      '',
      'Keep this link to yourself: anyone who has it can manage the booking.',
    ].join('\n'),
  });
}

export async function createPublicBooking(
  deps: BookingEngineDeps,
  body: z.output<typeof PublicBookingBody>,
): Promise<z.input<typeof PublicBookingCreated>> {
  const page = await pageOf(deps.db, body.slug);
  const repeat = await alreadyBooked(deps, page, body.bookingKey);
  if (repeat) return repeat;
  // The provider sends the guest here after paying: only ever back to our own site.
  if (body.returnUrl && new URL(body.returnUrl).origin !== deps.config.siteOrigin) {
    throw invalid('body.returnUrl', 'Return to the booking page');
  }
  if (!choiceAllowed(page, body.payment)) {
    throw invalid('body.payment', 'This hotel does not take that way of paying online');
  }
  if (!(await publicPlanIds(deps.db, page.propertyId)).has(body.ratePlanId)) {
    throw invalid('body.ratePlanId', 'Choose a plan shown on this page');
  }
  // M3 rule 8: a guest flagged do-not-rent needs a manager, so the page cannot take them.
  const flagged = await deps.db.guest.count({
    where: {
      organisationId: page.property.organisationId,
      doNotRent: true,
      OR: [{ phone: body.phone }, { email: body.email }],
    },
  });
  if (flagged > 0) {
    throw new AppError(
      'STATE_TRANSITION_INVALID',
      'We can’t complete this booking online. Please contact the hotel.',
    );
  }
  const promo = await usablePromo(deps.db, page, body.promo, body.arrival);
  if (body.promo && !promo) throw invalid('body.promo', 'This code can’t be used for these dates');
  if (promo && !(await claimPromo(deps.db, promo.id))) {
    throw invalid('body.promo', 'This code has been used up');
  }

  const tenant = guestTenant(page.property);
  const online = body.payment !== 'AT_HOTEL';
  try {
    return await runAsTenant(tenant, async () => {
      const quote = await createQuote(
        deps,
        tenant,
        {
          arrival: body.arrival,
          departure: body.departure,
          adults: body.adults,
          children: body.children,
          roomTypeId: body.roomTypeId,
          ratePlanId: body.ratePlanId,
        },
        promo?.discountBps ?? 0,
      );
      const now = deps.clock();
      const reservation = await createReservation(
        deps,
        tenant,
        ReservationBody.parse({
          source: 'DIRECT',
          guarantee: online ? 'DEPOSIT' : 'NONE',
          holdUntil: online
            ? new Date(now.getTime() + ONLINE_HOLD_MINUTES * 60_000).toISOString()
            : null,
          booker: {
            firstName: body.firstName,
            lastName: body.lastName,
            email: body.email,
            phone: body.phone,
          },
          stays: [
            {
              quoteId: quote.quoteId,
              adults: body.adults,
              children: body.children,
              guest: { sameAsBooker: true },
              roomId: null,
            },
          ],
          notes: promo ? `Booking page, promo ${promo.code}` : 'Booking page',
        }),
      );
      if (!('id' in reservation)) throw new Error('A booking-page booking needs no approval');
      const linkId = randomUUID();
      const token = linkToken(deps, linkId);
      await deps.db.guestLink.create({
        data: {
          id: linkId,
          organisationId: page.property.organisationId,
          propertyId: page.propertyId,
          reservationId: reservation.id,
          tokenHash: hashToken(deps.config.sessionSecret, token),
          clientKey: body.bookingKey,
          promoCodeId: promo?.id ?? null,
          createdAt: now,
        },
      });
      const full = await deps.db.reservation.findUniqueOrThrow({
        where: { id: reservation.id },
        include: {
          booker: true,
          property: true,
          stays: { include: { roomType: true, quote: true } },
        },
      });
      if (body.marketingConsent) {
        await deps.db.guest.update({
          where: { id: full.bookerGuestId },
          data: { marketingConsent: true, consentAt: now },
        });
      }
      const total = BigInt(quote.totalMinor);
      let paymentUrl: string | null = null;
      let dueNow = 0n;
      if (online) {
        dueNow = body.payment === 'FULL' ? total : (total * BigInt(page.depositBps)) / 10_000n;
        const intent = await createPaymentIntent(
          deps,
          tenant,
          PaymentIntentBody.parse({
            reservationId: reservation.id,
            amountMinor: dueNow.toString(),
            email: body.email,
          }),
          { callbackUrl: body.returnUrl ?? null },
        );
        paymentUrl = intent.checkoutUrl;
      } else {
        await queueConfirmation(deps.db, full);
      }
      await sendLinkEmail(deps, page, body.email, full.confirmationNo, token);
      return {
        token,
        confirmationNo: full.confirmationNo,
        status: online ? ('TENTATIVE' as const) : ('CONFIRMED' as const),
        paymentUrl,
        amountDueNowMinor: dueNow.toString(),
        totalMinor: total.toString(),
        currency: quote.currency,
      };
    });
  } catch (err) {
    if (promo) {
      await deps.db.promoCode.update({
        where: { id: promo.id },
        data: { usedCount: { decrement: 1 } },
      });
    }
    throw err;
  }
}

// ── A guest's link (M11-02) ─────────────────────────────────────────────────────────────

async function byToken(deps: BookingEngineDeps, token: string) {
  const link = await deps.db.guestLink.findUnique({
    where: { tokenHash: hashToken(deps.config.sessionSecret, token) },
  });
  if (!link) throw new AppError('NOT_FOUND', 'This link is not valid');
  const page = await deps.db.bookingEngineSettings.findUniqueOrThrow({
    where: { propertyId: link.propertyId },
    include: { property: true },
  });
  return { link, page };
}

async function view(
  deps: BookingEngineDeps,
  page: Page,
  reservationId: string,
): Promise<z.input<typeof PublicBooking>> {
  const r = await deps.db.reservation.findUniqueOrThrow({
    where: { id: reservationId },
    include: {
      booker: true,
      stays: {
        include: {
          roomType: true,
          nights: true,
          quote: true,
          ratePlan: { include: { cancellationPolicy: true } },
        },
      },
      depositEntries: true,
    },
  });
  const [stay] = r.stays;
  if (!stay) throw new AppError('NOT_FOUND', 'This link is not valid');
  const today = await businessDate(deps.db, r.propertyId, deps.clock);
  let feeMinor = 0n;
  if (r.status === 'CONFIRMED') {
    for (const s of r.stays) {
      feeMinor += cancellationFee(
        s.ratePlan.cancellationPolicy.rules as unknown as FeeRule[],
        s.nights.map((n) => n.amountMinor),
        today,
        day(s.arrival),
      ).feeMinor;
    }
  }
  return {
    confirmationNo: r.confirmationNo,
    status: r.status,
    hotel: {
      name: page.property.name,
      slug: page.slug,
      phone: page.property.phone,
      email: page.property.email,
    },
    guestName: `${r.booker.firstName} ${r.booker.lastName}`,
    arrival: day(stay.arrival),
    departure: day(stay.departure),
    roomType: stay.roomType.name,
    ratePlan: stay.ratePlan.name,
    adults: stay.adults,
    children: stay.children,
    totalMinor: r.stays.reduce((s, x) => s + x.quote.totalMinor, 0n).toString(),
    paidMinor: r.depositEntries.reduce((s, e) => s + e.amountMinor, 0n).toString(),
    currency: stay.quote.currency,
    cancellation: {
      allowed: r.status === 'CONFIRMED' || r.status === 'TENTATIVE',
      feeMinor: feeMinor.toString(),
    },
  };
}

export async function publicBooking(deps: BookingEngineDeps, token: string) {
  const { link, page } = await byToken(deps, token);
  return view(deps, page, link.reservationId);
}

export async function cancelPublicBooking(
  deps: BookingEngineDeps,
  token: string,
  acceptedFeeMinor: string,
) {
  const { link, page } = await byToken(deps, token);
  const before = await view(deps, page, link.reservationId);
  if (!before.cancellation.allowed) {
    throw new AppError('STATE_TRANSITION_INVALID', 'This booking can no longer be cancelled here', {
      status: before.status,
    });
  }
  if (BigInt(before.cancellation.feeMinor) > BigInt(acceptedFeeMinor)) {
    throw new AppError('STATE_TRANSITION_INVALID', 'The cancellation fee has changed', {
      reason: 'FEE_CHANGED',
      feeMinor: before.cancellation.feeMinor,
    });
  }
  const tenant = guestTenant(page.property);
  await runAsTenant(tenant, async () => {
    await getReservation(deps, link.reservationId);
    await cancelReservation(deps, tenant, link.reservationId, {
      reason: 'GUEST_REQUEST',
      note: 'Cancelled by the guest from their link',
    });
  });
  return view(deps, page, link.reservationId);
}
