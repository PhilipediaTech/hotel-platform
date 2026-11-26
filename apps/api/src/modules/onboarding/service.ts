import {
  localDate,
  ONBOARDING_TARGET_WORKING_DAYS,
  workingDaysTaken,
  type ImportKind,
  type OnboardingRow,
  type TrainingSessionItem,
} from '@hotel/shared';
import type { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client.ts';
import { recordAudit } from '../../core/audit.ts';
import type { AuthContext } from '../../core/auth.ts';
import type { Clock } from '../../core/clock.ts';
import type { Db } from '../../core/db.ts';
import { AppError } from '../../core/errors.ts';
import type { TenantDb } from '../../core/tenant-db.ts';
import { checklistFor } from '../setup/service.ts';

// Onboarding tracker (Versions V2 "enhanced onboarding"; Strategy "go-live within 2 working
// days", "remote training sessions per role"; T-171; Philip's choices 2026-11-26). Platform
// staff see every property's way to go-live and book training per role across groups with the
// plain client, naming the organisation in every write; the hotel reads its sessions under Help.

export interface OnboardingDeps {
  db: Db;
  tenantDb: TenantDb;
  clock: Clock;
}

type Row = z.input<typeof OnboardingRow>;
type Session = z.input<typeof TrainingSessionItem>;
type BookBody = {
  roleId: string;
  propertyId: string | null;
  scheduledAt: string;
  note: string | null;
};

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
/** Properties shown at most (newest first after those in setup). */
const MAX_ROWS = 200;

const SESSION_INCLUDE = {
  role: { select: { id: true, name: true } },
  property: { select: { name: true } },
  trainer: { select: { id: true, name: true } },
} as const;
type SessionRow = Prisma.TrainingSessionGetPayload<{ include: typeof SESSION_INCLUDE }>;

const sessionOf = (s: SessionRow): Session => ({
  id: s.id,
  role: s.role,
  propertyName: s.property?.name ?? null,
  scheduledAt: iso(s.scheduledAt),
  heldAt: s.heldAt ? iso(s.heldAt) : null,
  cancelledAt: s.cancelledAt ? iso(s.cancelledAt) : null,
  trainer: s.trainer,
  note: s.note,
});

// ── The tracker ─────────────────────────────────────────────────────────────────────────

export async function listOnboarding(deps: OnboardingDeps) {
  const db = deps.db;
  const now = deps.clock();
  const properties = await db.property.findMany({
    where: { status: { not: 'ARCHIVED' } },
    include: {
      organisation: {
        select: { id: true, name: true, onboardingContact: { select: { id: true, name: true } } },
      },
    },
    orderBy: { createdAt: 'desc' },
    take: MAX_ROWS,
  });
  const ids = properties.map((p) => p.id);
  const orgIds = [...new Set(properties.map((p) => p.organisationId))];
  const [wentLive, imports, memberships, invitations, sessions] = await Promise.all([
    db.auditEvent.findMany({
      where: { action: 'property.went_live', entityId: { in: ids } },
      select: { entityId: true, occurredAt: true },
      orderBy: { occurredAt: 'asc' },
    }),
    db.importJob.groupBy({
      by: ['propertyId', 'kind'],
      where: { propertyId: { in: ids }, status: 'APPLIED' },
      _count: { _all: true },
    }),
    db.membership.findMany({
      where: { organisationId: { in: orgIds }, active: true },
      select: {
        organisationId: true,
        propertyId: true,
        userId: true,
        role: { select: { id: true, name: true } },
      },
    }),
    db.invitation.findMany({
      where: {
        organisationId: { in: orgIds },
        acceptedAt: null,
        revokedAt: null,
        expiresAt: { gt: now },
      },
      select: { organisationId: true, propertyId: true },
    }),
    db.trainingSession.findMany({
      where: { organisationId: { in: orgIds }, cancelledAt: null },
      include: SESSION_INCLUDE,
      orderBy: { scheduledAt: 'asc' },
    }),
  ]);
  const liveAt = new Map<string, Date>();
  for (const e of wentLive) if (!liveAt.has(e.entityId)) liveAt.set(e.entityId, e.occurredAt);

  const rows: Row[] = [];
  for (const p of properties) {
    const here = (x: { organisationId: string; propertyId: string | null }) =>
      x.organisationId === p.organisationId && (x.propertyId === null || x.propertyId === p.id);
    const checklist = await checklistFor(db, p, now);
    const required = checklist.steps.filter((s) => s.required);
    const wentLiveAt = liveAt.get(p.id) ?? null;
    const workingDays = workingDaysTaken(
      localDate(p.createdAt, p.timeZone),
      localDate(wentLiveAt ?? now, p.timeZone),
    );
    const staffHere = memberships.filter(here);
    const ownSessions = sessions.filter(
      (s) => s.organisationId === p.organisationId && (s.propertyId ?? p.id) === p.id,
    );
    const trained = new Set(ownSessions.filter((s) => s.heldAt).map((s) => s.roleId));
    const roles = new Map(staffHere.map((m) => [m.role.id, m.role]));
    const next = ownSessions.find((s) => !s.heldAt && s.scheduledAt > now);
    rows.push({
      organisation: { id: p.organisation.id, name: p.organisation.name },
      property: {
        id: p.id,
        name: p.name,
        code: p.code,
        status: p.status as Row['property']['status'],
      },
      contact: p.organisation.onboardingContact,
      createdAt: iso(p.createdAt),
      wentLiveAt: wentLiveAt ? iso(wentLiveAt) : null,
      workingDays,
      // A property still in setup is on target until it passes the target.
      onTarget: workingDays <= ONBOARDING_TARGET_WORKING_DAYS,
      checklist: {
        done: required.filter((s) => s.status !== 'TODO').length,
        required: required.length,
        todo: required.filter((s) => s.status === 'TODO').map((s) => s.id),
      },
      imports: Object.fromEntries(
        imports
          .filter((i) => i.propertyId === p.id)
          .map((i) => [i.kind as ImportKind, i._count._all]),
      ),
      staff: {
        members: new Set(staffHere.map((m) => m.userId)).size,
        invitations: invitations.filter(here).length,
      },
      training: {
        needed: [...roles.values()]
          .filter((r) => !trained.has(r.id))
          .sort((a, b) => a.name.localeCompare(b.name)),
        held: ownSessions.filter((s) => s.heldAt).length,
        next: next ? { scheduledAt: iso(next.scheduledAt), role: next.role.name } : null,
      },
    });
  }
  // In setup first; otherwise newest first, as read.
  const setupFirst = (r: Row) => (r.property.status === 'SETUP' ? 0 : 1);
  rows.sort((a, b) => setupFirst(a) - setupFirst(b));
  return { targetWorkingDays: ONBOARDING_TARGET_WORKING_DAYS, data: rows };
}

// ── Training sessions ───────────────────────────────────────────────────────────────────

async function organisation(db: Db | Prisma.TransactionClient, organisationId: string) {
  const org = await db.organisation.findUnique({ where: { id: organisationId } });
  if (!org) throw new AppError('NOT_FOUND', 'Hotel group not found');
  return org;
}

export async function listTenantTraining(deps: OnboardingDeps, organisationId: string) {
  await organisation(deps.db, organisationId);
  const [roles, properties, sessions] = await Promise.all([
    deps.db.role.findMany({
      where: { organisationId },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
    deps.db.property.findMany({
      where: { organisationId, status: { not: 'ARCHIVED' } },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
    deps.db.trainingSession.findMany({
      where: { organisationId },
      include: SESSION_INCLUDE,
      orderBy: { scheduledAt: 'desc' },
      take: 200,
    }),
  ]);
  return { roles, properties, data: sessions.map(sessionOf) };
}

function invalid(path: string, message: string) {
  return new AppError('VALIDATION_ERROR', message, {
    issues: [{ path, code: 'custom', message }],
  });
}

/** Audited in the hotel group's log, as the platform team's other changes are. */
function audit(
  tx: Prisma.TransactionClient,
  auth: AuthContext,
  s: { id: string; organisationId: string; propertyId: string | null },
  action: string,
  after: Record<string, unknown>,
) {
  return recordAudit(tx, {
    organisationId: s.organisationId,
    propertyId: s.propertyId,
    actorUserId: auth.user.id,
    actorType: 'SUPPORT',
    action,
    entityType: 'training_session',
    entityId: s.id,
    after,
  });
}

export async function bookSession(
  deps: OnboardingDeps,
  auth: AuthContext,
  organisationId: string,
  body: BookBody,
): Promise<Session> {
  return deps.db.$transaction(async (tx) => {
    await organisation(tx, organisationId);
    const role = await tx.role.findFirst({ where: { id: body.roleId, organisationId } });
    if (!role) throw invalid('body.roleId', 'Choose a role of this hotel group');
    if (body.propertyId) {
      const property = await tx.property.findFirst({
        where: { id: body.propertyId, organisationId, status: { not: 'ARCHIVED' } },
      });
      if (!property) throw invalid('body.propertyId', 'Choose a property of this hotel group');
    }
    const created = await tx.trainingSession.create({
      data: {
        organisationId,
        propertyId: body.propertyId,
        roleId: role.id,
        trainerId: auth.user.id,
        scheduledAt: new Date(body.scheduledAt),
        note: body.note,
        createdAt: deps.clock(),
      },
      include: SESSION_INCLUDE,
    });
    await audit(tx, auth, created, 'training.booked', {
      role: role.name,
      scheduledAt: body.scheduledAt,
    });
    return sessionOf(created);
  });
}

async function changeSession(
  deps: OnboardingDeps,
  auth: AuthContext,
  sessionId: string,
  to: 'held' | 'cancelled',
): Promise<Session> {
  return deps.db.$transaction(async (tx) => {
    const s = await tx.trainingSession.findUnique({ where: { id: sessionId } });
    if (!s) throw new AppError('NOT_FOUND', 'Training session not found');
    if (s.heldAt || s.cancelledAt) {
      throw new AppError(
        'STATE_TRANSITION_INVALID',
        s.heldAt ? 'This session already took place' : 'This session was cancelled',
        { held: s.heldAt !== null, cancelled: s.cancelledAt !== null },
      );
    }
    const now = deps.clock();
    const updated = await tx.trainingSession.update({
      where: { id: s.id },
      data: to === 'held' ? { heldAt: now } : { cancelledAt: now },
      include: SESSION_INCLUDE,
    });
    await audit(tx, auth, s, to === 'held' ? 'training.held' : 'training.cancelled', {
      role: updated.role.name,
    });
    return sessionOf(updated);
  });
}

export const markHeld = (deps: OnboardingDeps, auth: AuthContext, id: string) =>
  changeSession(deps, auth, id, 'held');
export const cancelSession = (deps: OnboardingDeps, auth: AuthContext, id: string) =>
  changeSession(deps, auth, id, 'cancelled');

// ── The hotel's view ────────────────────────────────────────────────────────────────────

export async function myTraining(deps: OnboardingDeps) {
  const sessions = await deps.tenantDb.trainingSession.findMany({
    where: { cancelledAt: null },
    include: SESSION_INCLUDE,
    orderBy: { scheduledAt: 'desc' },
    take: 100,
  });
  return { data: sessions.map(sessionOf) };
}
