import {
  MAX_OPEN_SERVICE_REQUESTS,
  type PublicServiceRequestBody,
  type PublicStay,
  type ServiceRequestKind,
} from '@hotel/shared';
import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import type { Prisma, TaskStatus } from '../../generated/prisma/client.ts';
import { recordAudit } from '../../core/audit.ts';
import { businessDate } from '../../core/business-day.ts';
import { AppError } from '../../core/errors.ts';
import { runAsTenant } from '../../core/tenancy.ts';
import { hashToken } from '../../core/tokens.ts';
import { LINK_DAYS, reviewSettingsOf, reviewToken } from '../reviews/service.ts';
import { dueFrom, insertTask, templateOfType } from '../tasks/service.ts';
import { guestTenant } from './after-payment.ts';
import { byToken, type BookingEngineDeps } from './service.ts';

// Requests and feedback from the guest's own link (PRD M11-06 "request services and rate my
// stay"; S45; T-159). A request becomes a guest-request task for the department that does it,
// so it reaches the staff the way every other request does (the task board, SLA, escalation);
// the guest follows its progress on the link. After check-out the link opens the review page
// of the stay (T-155), making it when the review request hasn't gone out yet.

type Out = z.input<typeof PublicStay>;

const DAY = 86_400_000;

/** Who does it: a department code, or the guest-request template's department. */
const DEPARTMENT: Record<ServiceRequestKind, string> = {
  HOUSEKEEPING: 'HK',
  AMENITIES: 'HK',
  MAINTENANCE: 'MNT',
  FOOD_DRINK: 'FO',
  TRANSPORT: 'FO',
  OTHER: 'FO',
};

/** The task's title for the staff. */
const TITLE: Record<ServiceRequestKind, string> = {
  HOUSEKEEPING: 'Cleaning or towels',
  AMENITIES: 'Toiletries or extras',
  MAINTENANCE: 'Something to fix',
  FOOD_DRINK: 'Food and drink',
  TRANSPORT: 'Transport',
  OTHER: 'Guest request',
};

/** What the guest sees of the task's progress. */
function progress(status: TaskStatus): Out['requests'][number]['status'] {
  if (status === 'REPORTED' || status === 'TRIAGED') return 'RECEIVED';
  if (status === 'RESOLVED' || status === 'VERIFIED' || status === 'CLOSED') return 'DONE';
  return 'ON_IT';
}

const DONE: TaskStatus[] = ['RESOLVED', 'VERIFIED', 'CLOSED'];

async function load(deps: BookingEngineDeps, token: string) {
  const { link, page } = await byToken(deps, token);
  const reservation = await deps.db.reservation.findUniqueOrThrow({
    where: { id: link.reservationId },
    include: {
      stays: { include: { guest: true, room: true }, orderBy: { arrival: 'asc' } },
    },
  });
  // The stay a request is about: the one in the house, else the first.
  const stay =
    reservation.stays.find((s) => s.status === 'CHECKED_IN') ?? reservation.stays[0] ?? null;
  if (!stay) throw new AppError('NOT_FOUND', 'This link is not valid');
  const today = await businessDate(deps.db, reservation.propertyId, deps.clock);
  return { page, reservation, stay, today };
}

type Loaded = Awaited<ReturnType<typeof load>>;

function closedReason({ reservation, stay, today }: Loaded): Out['closedReason'] {
  const s = reservation.status;
  if (s === 'CANCELLED') return 'CANCELLED';
  if (s === 'CHECKED_OUT' || s === 'NO_SHOW' || stay.status === 'CHECKED_OUT') return 'ENDED';
  if (s !== 'CONFIRMED' && s !== 'CHECKED_IN') return 'NOT_CONFIRMED';
  // The stay is over once its departure day has passed.
  if (stay.departure.toISOString().slice(0, 10) < today) return 'ENDED';
  return null;
}

/** Rating the stay: only after check-out, while the hotel asks for reviews. */
async function feedbackOf(deps: BookingEngineDeps, loaded: Loaded): Promise<Out['feedback']> {
  const { reservation, stay, page } = loaded;
  const review = await deps.db.guestReview.findFirst({
    where: { reservationId: reservation.id, guestId: stay.guestId },
    orderBy: { requestedAt: 'asc' },
  });
  const now = deps.clock();
  if (review) {
    return {
      state: review.submittedAt ? 'GIVEN' : review.expiresAt <= now ? 'EXPIRED' : 'OPEN',
      path: `/r/${reviewToken(deps.config.sessionSecret, review.id)}`,
    };
  }
  return mayStartReview(loaded, page.property.settings, now)
    ? { state: 'AVAILABLE', path: null }
    : null;
}

function mayStartReview(loaded: Loaded, settings: unknown, now: Date) {
  const { stay } = loaded;
  // The guest's own stay is over (a booking of several rooms may still have others in).
  if (stay.status !== 'CHECKED_OUT') return false;
  if (stay.guest.doNotRent || stay.guest.mergedIntoId) return false;
  if (!reviewSettingsOf(settings).enabled) return false;
  const left = stay.checkedOutAt ?? stay.departure;
  return now.getTime() - left.getTime() < LINK_DAYS * DAY;
}

async function stayOf(deps: BookingEngineDeps, loaded: Loaded): Promise<Out> {
  const rows = await deps.db.serviceRequest.findMany({
    where: { reservationId: loaded.reservation.id },
    include: { task: { select: { status: true } } },
    orderBy: { createdAt: 'desc' },
  });
  return {
    closedReason: closedReason(loaded),
    roomNumber: loaded.stay.status === 'CHECKED_IN' ? (loaded.stay.room?.number ?? null) : null,
    requests: rows.map((r) => ({
      id: r.id,
      kind: r.kind as ServiceRequestKind,
      note: r.note,
      status: progress(r.task.status),
      createdAt: r.createdAt.toISOString(),
    })),
    feedback: await feedbackOf(deps, loaded),
  };
}

export async function getPublicStay(deps: BookingEngineDeps, token: string): Promise<Out> {
  return stayOf(deps, await load(deps, token));
}

export async function createServiceRequest(
  deps: BookingEngineDeps,
  token: string,
  body: z.output<typeof PublicServiceRequestBody>,
): Promise<Out> {
  const loaded = await load(deps, token);
  const { page, reservation, stay } = loaded;
  // The same request again (the answer was lost): nothing new.
  const same = await deps.db.serviceRequest.findUnique({
    where: {
      propertyId_clientKey: { propertyId: reservation.propertyId, clientKey: body.requestKey },
    },
  });
  if (same) {
    if (same.reservationId !== reservation.id) {
      throw new AppError('IDEMPOTENCY_KEY_REUSED', 'This request key was used already');
    }
    return stayOf(deps, loaded);
  }
  const closed = closedReason(loaded);
  if (closed) {
    throw new AppError(
      'STATE_TRANSITION_INVALID',
      closed === 'ENDED'
        ? 'Your stay has ended; please call the hotel'
        : 'Requests open once the booking is confirmed',
      { reason: closed },
    );
  }
  const now = deps.clock();
  const tenant = guestTenant(page.property);
  await runAsTenant(tenant, () =>
    deps.tenantDb.$transaction(async (tx) => {
      // One at a time per booking, so the limit holds when two arrive together.
      const lock = `service-requests:${reservation.id}`;
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${lock}))::text AS locked`;
      const waiting = await tx.serviceRequest.count({
        where: { reservationId: reservation.id, task: { status: { notIn: DONE } } },
      });
      if (waiting >= MAX_OPEN_SERVICE_REQUESTS) {
        throw new AppError(
          'STATE_TRANSITION_INVALID',
          `You have ${MAX_OPEN_SERVICE_REQUESTS} requests waiting already; the hotel will get to them soon`,
          { reason: 'TOO_MANY_WAITING' },
        );
      }
      const template = await templateOfType(tx, reservation.propertyId, 'GUEST_REQUEST');
      const department =
        (await tx.department.findFirst({ where: { code: DEPARTMENT[body.kind] } }))?.id ??
        template?.departmentId ??
        (await tx.department.findFirst({ orderBy: { name: 'asc' } }))?.id;
      if (!department) {
        throw new AppError('STATE_TRANSITION_INVALID', 'Please call the hotel', {
          reason: 'NO_DEPARTMENT',
        });
      }
      const inHouse = stay.status === 'CHECKED_IN' && stay.room;
      const where = inHouse
        ? `room ${stay.room?.number}`
        : `${stay.guest.firstName} ${stay.guest.lastName}`.trim() +
          `, arriving ${stay.arrival.toISOString().slice(0, 10)}`;
      const task = await insertTask(tx, reservation.propertyId, {
        type: 'GUEST_REQUEST',
        templateId: template?.id ?? null,
        departmentId: department,
        title: `${TITLE[body.kind]}: ${where}`,
        description: body.note ? `From the guest’s link: ${body.note}` : 'From the guest’s link',
        priority: template?.priority ?? 'NORMAL',
        roomId: inHouse ? stay.roomId : null,
        stayId: stay.id,
        guestId: stay.guestId,
        dueAt: dueFrom(now, template?.slaMinutes),
        reportedById: null,
      });
      const id = randomUUID();
      await tx.serviceRequest.create({
        data: {
          id,
          reservationId: reservation.id,
          stayId: stay.id,
          kind: body.kind,
          note: body.note,
          taskId: task.id,
          clientKey: body.requestKey,
          createdAt: now,
        } as unknown as Prisma.ServiceRequestUncheckedCreateInput, // the tenant client sets the property
      });
      await recordAudit(tx, {
        organisationId: page.property.organisationId,
        propertyId: reservation.propertyId,
        actorType: 'SYSTEM',
        actorUserId: null,
        action: 'service_request.created',
        entityType: 'service_request',
        entityId: id,
        after: { kind: body.kind, taskNumber: task.number, stayId: stay.id },
      });
    }),
  );
  return stayOf(deps, loaded);
}

export async function startFeedback(
  deps: BookingEngineDeps,
  token: string,
): Promise<{ path: string }> {
  const loaded = await load(deps, token);
  const { page, reservation, stay } = loaded;
  const now = deps.clock();
  const existing = await feedbackOf(deps, loaded);
  if (existing?.path) return { path: existing.path };
  if (!existing || !mayStartReview(loaded, page.property.settings, now)) {
    throw new AppError('STATE_TRANSITION_INVALID', 'You can rate your stay after you check out', {
      reason: 'NOT_AVAILABLE',
    });
  }
  const id = randomUUID();
  const token2 = reviewToken(deps.config.sessionSecret, id);
  try {
    await deps.db.$transaction(async (tx) => {
      await tx.guestReview.create({
        data: {
          id,
          propertyId: reservation.propertyId,
          reservationId: reservation.id,
          stayId: stay.id,
          guestId: stay.guestId,
          tokenHash: hashToken(deps.config.sessionSecret, token2),
          channel: 'PORTAL',
          requestedAt: now,
          expiresAt: new Date(now.getTime() + LINK_DAYS * DAY),
        },
      });
      await recordAudit(tx, {
        organisationId: page.property.organisationId,
        propertyId: reservation.propertyId,
        actorType: 'SYSTEM',
        actorUserId: null,
        action: 'review.started_from_link',
        entityType: 'guest_review',
        entityId: id,
      });
    });
  } catch (err) {
    // Two taps at once, or the review request went out meanwhile: use the one that exists.
    const again = await feedbackOf(deps, loaded);
    if (again?.path) return { path: again.path };
    throw err;
  }
  return { path: `/r/${token2}` };
}
