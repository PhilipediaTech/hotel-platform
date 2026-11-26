import { GETTING_STARTED_STEPS, gettingStartedSteps, type GettingStartedStep } from '@hotel/shared';
import type { TenantContext } from '../../core/tenancy.ts';
import type { TenantDb } from '../../core/tenant-db.ts';

// Getting started (Versions V2 "enhanced onboarding"; T-172; Philip 2026-11-26): each person's
// first steps come from the permissions they hold here, and a step is done once the audit log
// shows they did it at this property (or group-wide). Nothing new is stored.

export interface GettingStartedDeps {
  tenantDb: TenantDb;
}

const STEP_ACTIONS = [...new Set(GETTING_STARTED_STEPS.flatMap((s) => [...s.actions]))];

/** Audit actions each user has done here, among those the steps look for. */
async function doneActions(db: TenantDb, propertyId: string, userIds: string[]) {
  const rows = await db.auditEvent.findMany({
    where: {
      actorUserId: { in: userIds },
      action: { in: STEP_ACTIONS },
      OR: [{ propertyId }, { propertyId: null }],
    },
    distinct: ['actorUserId', 'action'],
    select: { actorUserId: true, action: true },
  });
  const byUser = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!r.actorUserId) continue;
    const set = byUser.get(r.actorUserId) ?? new Set<string>();
    set.add(r.action);
    byUser.set(r.actorUserId, set);
  }
  return byUser;
}

const isDone = (step: GettingStartedStep, done: Set<string> | undefined) =>
  step.actions.some((a) => done?.has(a) ?? false);

export async function mySteps(deps: GettingStartedDeps, tenant: TenantContext) {
  const steps = gettingStartedSteps(tenant.permissions);
  const done = (await doneActions(deps.tenantDb, tenant.propertyId, [tenant.userId])).get(
    tenant.userId,
  );
  const out = steps.map((s) => ({ id: s.id, path: s.path, done: isDone(s, done) }));
  return { steps: out, done: out.filter((s) => s.done).length, total: out.length };
}

export async function teamSteps(deps: GettingStartedDeps, tenant: TenantContext) {
  const memberships = await deps.tenantDb.membership.findMany({
    where: {
      active: true,
      OR: [{ propertyId: tenant.propertyId }, { propertyId: null }],
      user: { status: 'ACTIVE' },
    },
    include: {
      user: { select: { id: true, name: true } },
      role: { select: { name: true, permissions: true } },
    },
  });
  const people = new Map<
    string,
    { user: { id: string; name: string }; roles: string[]; permissions: Set<string> }
  >();
  for (const m of memberships) {
    const p = people.get(m.userId) ?? { user: m.user, roles: [], permissions: new Set() };
    p.roles.push(m.role.name);
    for (const code of m.role.permissions) p.permissions.add(code);
    people.set(m.userId, p);
  }
  const done = await doneActions(deps.tenantDb, tenant.propertyId, [...people.keys()]);
  const data = [...people.values()]
    .map((p) => {
      const steps = gettingStartedSteps(p.permissions);
      const mine = done.get(p.user.id);
      const missing = steps.filter((s) => !isDone(s, mine)).map((s) => s.id);
      return {
        user: p.user,
        roles: [...new Set(p.roles)].sort(),
        done: steps.length - missing.length,
        total: steps.length,
        missing,
      };
    })
    // Those with the most still to do first, then by name.
    .sort(
      (a, b) => b.total - b.done - (a.total - a.done) || a.user.name.localeCompare(b.user.name),
    );
  return { data };
}
