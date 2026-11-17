import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../test/db.ts';
import { errorOf } from '../../../test/helpers.ts';
import { inHouse } from '../../../test/in-house.ts';

// Operations report (PRD M6-12 "As a manager, I see operations metrics (acknowledge time,
// resolve time, overdue, reopen rate, SLA) with workload context", report.ops; tab 4 GET
// /reports/operations; M6 rule 5; T-135).

const db = testDb();
let now: Date;
const clock = () => new Date(now);

beforeEach(async () => {
  await resetDb(db);
  now = new Date('2026-11-10T17:00:00Z');
});

const at = (iso: string) => new Date(iso);

type Figures = {
  created: number;
  bySeverity: Record<string, number>;
  resolved: number;
  open: number;
  overdue: number;
  ackMedianMinutes: number | null;
  resolveMedianMinutes: number | null;
  reopenRateBps: number | null;
  slaMetBps: number | null;
  holdMinutes: number;
};
type Report = {
  from: string;
  to: string;
  totals: Figures;
  departments: { name: string; figures: Figures }[];
  people: {
    name: string;
    figures: Figures;
    pattern: Record<string, number>;
  }[];
  unassigned: number;
  definitions: string;
};

describe('operations report (M6-12)', () => {
  it('reports times, overdue, reopens and SLA by department and person, unranked', async () => {
    const h = await inHouse(db, clock);
    const manager = await h.person('dept-manager', h.p1.id);
    const tech = await h.person('maintenance', h.p1.id);
    await db.user.update({ where: { id: tech.id }, data: { name: 'Tunde Tech' } });
    const mnt = await db.department.create({
      data: { organisationId: h.org.id, propertyId: h.p1.id, code: 'MNT', name: 'Maintenance' },
    });
    const fo = await db.department.create({
      data: { organisationId: h.org.id, propertyId: h.p1.id, code: 'FO', name: 'Front office' },
    });
    let number = 0;
    const task = (data: {
      departmentId: string;
      assigneeId?: string;
      priority?: 'LOW' | 'NORMAL' | 'HIGH' | 'CRITICAL';
      status: 'ASSIGNED' | 'ON_HOLD' | 'RESOLVED' | 'VERIFIED' | 'REPORTED';
      createdAt: string;
      acknowledgedAt?: string;
      resolvedAt?: string;
      dueAt?: string;
      events: { from?: string; to: string; at: string; by?: string }[];
    }) =>
      db.task.create({
        data: {
          organisationId: h.org.id,
          propertyId: h.p1.id,
          number: (number += 1),
          type: 'FAULT',
          title: `Task ${number}`,
          departmentId: data.departmentId,
          assigneeId: data.assigneeId ?? null,
          priority: data.priority ?? 'NORMAL',
          status: data.status,
          createdAt: at(data.createdAt),
          acknowledgedAt: data.acknowledgedAt ? at(data.acknowledgedAt) : null,
          resolvedAt: data.resolvedAt ? at(data.resolvedAt) : null,
          dueAt: data.dueAt ? at(data.dueAt) : null,
          events: {
            create: data.events.map((e) => ({
              kind: 'STATUS',
              fromStatus: (e.from ?? null) as never,
              toStatus: e.to as never,
              at: at(e.at),
              byUserId: e.by ?? null,
            })),
          },
        },
      });
    // Tunde: one done in time (07:10 Lagos = morning), one reopened and on hold now.
    await task({
      departmentId: mnt.id,
      assigneeId: tech.id,
      priority: 'HIGH',
      status: 'VERIFIED',
      createdAt: '2026-11-10T06:00:00Z',
      acknowledgedAt: '2026-11-10T06:10:00Z',
      resolvedAt: '2026-11-10T07:00:00Z',
      dueAt: '2026-11-10T08:00:00Z',
      events: [
        { to: 'ASSIGNED', at: '2026-11-10T06:00:00Z' },
        { from: 'ASSIGNED', to: 'ACKNOWLEDGED', at: '2026-11-10T06:10:00Z', by: tech.id },
        { from: 'IN_PROGRESS', to: 'RESOLVED', at: '2026-11-10T07:00:00Z', by: tech.id },
        { from: 'RESOLVED', to: 'VERIFIED', at: '2026-11-10T07:30:00Z' },
      ],
    });
    await task({
      departmentId: mnt.id,
      assigneeId: tech.id,
      status: 'ON_HOLD',
      createdAt: '2026-11-10T08:00:00Z',
      acknowledgedAt: '2026-11-10T08:30:00Z',
      dueAt: '2026-11-10T12:00:00Z',
      events: [
        { to: 'ASSIGNED', at: '2026-11-10T08:00:00Z' },
        { from: 'ASSIGNED', to: 'ACKNOWLEDGED', at: '2026-11-10T08:30:00Z', by: tech.id },
        { from: 'IN_PROGRESS', to: 'RESOLVED', at: '2026-11-10T09:00:00Z', by: tech.id },
        { from: 'RESOLVED', to: 'ASSIGNED', at: '2026-11-10T10:00:00Z' },
        { from: 'IN_PROGRESS', to: 'ON_HOLD', at: '2026-11-10T16:00:00Z', by: tech.id },
      ],
    });
    // Front office: reported, given to no one.
    await task({
      departmentId: fo.id,
      priority: 'LOW',
      status: 'REPORTED',
      createdAt: '2026-11-10T09:00:00Z',
      events: [{ to: 'REPORTED', at: '2026-11-10T09:00:00Z' }],
    });
    // Before the period: not counted.
    await task({
      departmentId: fo.id,
      status: 'REPORTED',
      createdAt: '2026-10-01T09:00:00Z',
      events: [{ to: 'REPORTED', at: '2026-10-01T09:00:00Z' }],
    });

    expect((await h.fd.get('/reports/operations')).status).toBe(403);
    const asManager = await h.as(manager.id);
    expect(
      errorOf(await asManager.get('/reports/operations?from=2026-11-10&to=2026-11-01')).code,
    ).toBe('VALIDATION_ERROR');
    expect(
      errorOf(await asManager.get('/reports/operations?from=2026-01-01&to=2026-11-10')).code,
    ).toBe('VALIDATION_ERROR');

    const r = await h.ok<Report>(asManager.get('/reports/operations'));
    expect(r).toMatchObject({ from: '2026-10-12', to: '2026-11-10', unassigned: 1 });
    expect(r.totals).toMatchObject({
      created: 3,
      bySeverity: { LOW: 1, NORMAL: 1, HIGH: 1, CRITICAL: 0 },
      resolved: 1,
      open: 2,
      overdue: 1,
      ackMedianMinutes: 10,
      resolveMedianMinutes: 60,
      reopenRateBps: 5000,
      slaMetBps: 5000,
      holdMinutes: 60,
    });
    expect(r.departments.map((d) => [d.name, d.figures.created])).toEqual([
      ['Front office', 1],
      ['Maintenance', 2],
    ]);
    expect(r.people).toEqual([
      expect.objectContaining({
        name: 'Tunde Tech',
        figures: expect.objectContaining({ created: 2, holdMinutes: 60 }) as unknown,
        // 07:10, 08:00, 09:30, 10:00 Lagos are morning; 17:00 is afternoon.
        pattern: { NIGHT: 0, MORNING: 4, AFTERNOON: 1, EVENING: 0, daysActive: 1 },
      }),
    ]);
    expect(r.definitions).toContain('never ranked');

    // The file needs report.export as well (the manager has not).
    expect((await asManager.get('/reports/operations?format=csv')).status).toBe(403);
    const gm = await h.as(
      (await db.membership.findFirstOrThrow({ where: { roleId: h.role('gm') } })).userId,
    );
    const file = await gm.get('/reports/operations?from=2026-11-10&to=2026-11-10&format=csv');
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toContain('text/csv');
    expect(String(file.text)).toContain('Tunde Tech');
  });
});
