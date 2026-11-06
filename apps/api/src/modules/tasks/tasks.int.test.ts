import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../test/db.ts';
import { errorOf } from '../../../test/helpers.ts';
import { inHouse, TODAY } from '../../../test/in-house.ts';
import { DEPARTMENT_TEMPLATES } from '../identity/role-templates.ts';
import { escalateTasks } from './jobs.ts';

// Task engine (PRD M6-01–M6-05, M6 rule 1, the M6 AC "a task past SLA escalates once and only
// once per level", M5-07, M5 rule 3 and the M5 AC "a critical fault set to out-of-order removes
// the room from availability within the same request", M5 rule 6; tab 4 row "Tasks"; T-082).

const db = testDb();
let now: Date;
const clock = () => new Date(now);

beforeEach(async () => {
  await resetDb(db);
  now = new Date('2026-11-10T09:00:00Z');
});

type Person = { id: string; name: string } | null;
type Task = {
  id: string;
  number: number;
  type: string;
  template: { id: string; name: string } | null;
  title: string;
  description: string | null;
  department: { code: string };
  priority: string;
  status: string;
  room: { id: string; number: string } | null;
  stayId: string | null;
  guest: Person;
  reportedBy: Person;
  assignee: Person;
  dueAt: string | null;
  overdue: boolean;
  escalationLevel: number;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
  verifiedBy: Person;
  events: {
    kind: string;
    fromStatus: string | null;
    toStatus: string | null;
    note: string | null;
    fileIds: string[];
    by: Person;
  }[];
  actions: string[];
};
type Template = { id: string; type: string; name: string; department: { code: string } };

/** Ada checked in to 101 (inHouse); 102 vacant and clean; departments; a maintenance pair. */
async function hotel() {
  const h = await inHouse(db, clock);
  for (const p of [h.p1, h.p2]) {
    await db.department.createMany({
      data: DEPARTMENT_TEMPLATES.map((d) => ({ organisationId: h.org.id, propertyId: p.id, ...d })),
    });
  }
  const type = await db.roomType.findFirstOrThrow({ where: { propertyId: h.p1.id } });
  const r102 = await h.ok<{ id: string }>(
    h.gm.post('/rooms', { number: '102', roomTypeId: type.id }),
  );
  await db.room.update({ where: { id: r102.id }, data: { hkStatus: 'CLEAN' } });
  const r101 = await db.room.findFirstOrThrow({ where: { number: '101', propertyId: h.p1.id } });
  const room102 = await db.room.findUniqueOrThrow({ where: { id: r102.id } });
  const femi = await h.person('maintenance', h.p1.id);
  const gbenga = await h.person('maintenance', h.p1.id);
  const supervisor = await h.person('hk-supervisor', h.p1.id);
  const attendant = await h.person('hk-attendant', h.p1.id);
  const templates = async () =>
    (await h.ok<{ data: Template[] }>(h.fd.get('/task-templates'))).data;
  const template = async (type: string) => {
    const t = (await templates()).find((x) => x.type === type);
    if (!t) throw new Error(`No ${type} template`);
    return t;
  };
  return {
    ...h,
    type,
    r101,
    room102,
    femi: { user: femi, client: await h.as(femi.id) },
    gbenga: { user: gbenga, client: await h.as(gbenga.id) },
    supervisor: await h.as(supervisor.id),
    attendant: await h.as(attendant.id),
    templates,
    template,
  };
}

/** A fault for Femi, assigned by the GM. */
async function assignedFault(h: Awaited<ReturnType<typeof hotel>>) {
  const fault = await h.template('FAULT');
  const task = await h.ok<Task>(
    h.fd.send('/tasks', { templateId: fault.id, roomId: h.room102.id, description: 'Tap drips' }),
  );
  return h.ok<Task>(
    h.gm.send(`/tasks/${task.id}/assign`, { assigneeId: h.femi.user.id, priority: 'HIGH' }),
  );
}

describe('task templates (M6-01)', () => {
  it('starts every property with the default set, made once', async () => {
    const h = await hotel();
    const [a, b] = await Promise.all([h.templates(), h.templates()]);
    expect(a.map((t) => [t.type, t.department.code])).toEqual([
      ['CHECKLIST', 'HK'],
      ['FAULT', 'MNT'],
      ['COMPLAINT', 'FO'],
      ['GUEST_REQUEST', 'FO'],
      ['INCIDENT', 'MGT'],
      ['DISCREPANCY', 'FO'],
    ]);
    expect(b).toHaveLength(6);
    expect(await db.taskTemplate.count({ where: { propertyId: h.p1.id } })).toBe(6);
    // The other property gets its own when it first asks.
    expect(await db.taskTemplate.count({ where: { propertyId: h.p2.id } })).toBe(0);
  });

  it('lets managers add templates', async () => {
    const h = await hotel();
    const hk = await db.department.findFirstOrThrow({ where: { propertyId: h.p1.id, code: 'HK' } });
    const body = {
      type: 'GUEST_REQUEST',
      name: 'Extra towels',
      departmentId: hk.id,
      slaMinutes: 20,
    };
    expect((await h.fd.send('/task-templates', body)).status).toBe(403);
    const made = await h.ok<Template & { slaMinutes: number }>(h.gm.send('/task-templates', body));
    expect(made).toMatchObject({
      name: 'Extra towels',
      slaMinutes: 20,
      department: { code: 'HK' },
    });
    // A department of the other property is refused.
    const other = await db.department.findFirstOrThrow({ where: { propertyId: h.p2.id } });
    const res = await h.gm.send('/task-templates', { ...body, departmentId: other.id });
    expect(res.status).toBe(400);
  });
});

describe('creating tasks (M6-01, M6-02)', () => {
  it('takes two taps: a template and a room; the deadline is the template SLA', async () => {
    const h = await hotel();
    const request = await h.template('GUEST_REQUEST');
    const res = await h.fd.send('/tasks', { templateId: request.id, roomId: h.r101.id });
    expect(res.status).toBe(201);
    const task = res.body as Task;
    expect(task).toMatchObject({
      number: 1,
      type: 'GUEST_REQUEST',
      title: 'Guest request: room 101',
      department: { code: 'FO' },
      priority: 'NORMAL',
      status: 'REPORTED',
      room: { number: '101' },
      reportedBy: { id: h.fdId },
      assignee: null,
      dueAt: '2026-11-10T09:30:00Z',
      overdue: false,
      escalationLevel: 0,
    });
    expect(task.events).toMatchObject([{ kind: 'STATUS', toStatus: 'REPORTED' }]);
    // The front desk reports; it does not choose who does the work.
    const res2 = await h.fd.send('/tasks', {
      templateId: request.id,
      assigneeId: h.femi.user.id,
    });
    expect(res2.status).toBe(403);
    const second = await h.ok<Task>(h.fd.send('/tasks', { templateId: request.id }));
    expect(second.number).toBe(2);
  });

  it('lets a manager create, assign and set the deadline at once', async () => {
    const h = await hotel();
    const fault = await h.template('FAULT');
    const task = await h.ok<Task>(
      h.gm.send('/tasks', {
        templateId: fault.id,
        title: 'Generator room light',
        priority: 'HIGH',
        assigneeId: h.femi.user.id,
        dueAt: '2026-11-10T12:00:00Z',
      }),
    );
    expect(task).toMatchObject({
      title: 'Generator room light',
      status: 'ASSIGNED',
      priority: 'HIGH',
      assignee: { id: h.femi.user.id },
      dueAt: '2026-11-10T12:00:00Z',
    });
    // Only people who work tasks can be given one.
    const res = await h.gm.send('/tasks', { templateId: fault.id, assigneeId: h.fdId });
    expect(res.status).toBe(400);
  });

  it('refuses rooms and templates of another property', async () => {
    const h = await hotel();
    const otherType = await db.roomType.create({
      data: { organisationId: h.org.id, propertyId: h.p2.id, code: 'X', name: 'X' },
    });
    const otherRoom = await db.room.create({
      data: {
        organisationId: h.org.id,
        propertyId: h.p2.id,
        roomTypeId: otherType.id,
        number: '901',
        qrToken: 'p2-room-901-token',
      },
    });
    const request = await h.template('GUEST_REQUEST');
    const res = await h.fd.send('/tasks', { templateId: request.id, roomId: otherRoom.id });
    expect(res.status).toBe(400);
    expect(errorOf(res).message).toMatch(/room of this property/);
  });

  it('links photos of the Task kind and refuses others', async () => {
    const h = await hotel();
    const photo = (entityType: string, key: string) =>
      db.fileObject.create({
        data: {
          organisationId: h.org.id,
          propertyId: h.p1.id,
          storageKey: `org/${h.org.id}/property/${h.p1.id}/${key}`,
          contentType: 'image/jpeg',
          sizeBytes: 1000,
          scan: 'CLEAN',
          entityType,
          uploadedById: h.fdId,
        },
      });
    const ok = await photo('Task', 'task-1');
    const wrong = await photo('RoomType', 'type-1');
    const complaint = await h.template('COMPLAINT');
    const task = await h.ok<Task>(
      h.fd.send('/tasks', { templateId: complaint.id, fileIds: [ok.id] }),
    );
    expect(task.events[0]?.fileIds).toEqual([ok.id]);
    expect((await db.fileObject.findUniqueOrThrow({ where: { id: ok.id } })).entityId).toBe(
      task.id,
    );
    const res = await h.fd.send('/tasks', { templateId: complaint.id, fileIds: [wrong.id] });
    expect(res.status).toBe(400);
    // A photo already on one task can't be put on another.
    const again = await h.fd.send('/tasks', { templateId: complaint.id, fileIds: [ok.id] });
    expect(again.status).toBe(400);
  });
});

describe('task lifecycle (M6-02–M6-04, M6 rule 1)', () => {
  it('goes assigned → acknowledged → in progress ⇄ on hold → resolved → verified', async () => {
    const h = await hotel();
    const task = await assignedFault(h);
    expect(task).toMatchObject({ status: 'ASSIGNED', priority: 'HIGH' });
    const femi = h.femi.client;
    const step = (action: string, body?: object, as = femi) =>
      h.ok<Task>(as.send(`/tasks/${task.id}/${action}`, body));

    const mine = await h.ok<Task>(femi.get(`/tasks/${task.id}`));
    expect(mine.actions).toEqual(['acknowledge']);
    now = new Date('2026-11-10T09:05:00Z');
    expect(await step('acknowledge')).toMatchObject({
      status: 'ACKNOWLEDGED',
      acknowledgedAt: '2026-11-10T09:05:00Z',
    });
    expect((await step('start')).status).toBe('IN_PROGRESS');
    expect((await step('hold', { reason: 'Waiting for a washer' })).status).toBe('ON_HOLD');
    expect((await step('start')).status).toBe('IN_PROGRESS');
    now = new Date('2026-11-10T10:00:00Z');
    const resolved = await step('resolve', { note: 'Replaced the washer' });
    expect(resolved).toMatchObject({ status: 'RESOLVED', resolvedAt: '2026-11-10T10:00:00Z' });
    expect(resolved.actions).toEqual([]);
    expect((await h.ok<Task>(h.gm.get(`/tasks/${task.id}`))).actions).toEqual(['verify', 'reopen']);
    const verified = await step('verify', {}, h.gm);
    const gmId = (await db.membership.findFirstOrThrow({ where: { roleId: h.role('gm') } })).userId;
    expect(verified).toMatchObject({ status: 'VERIFIED', verifiedBy: { id: gmId } });

    expect(verified.events.map((e) => [e.kind, e.fromStatus, e.toStatus, e.note])).toEqual([
      ['STATUS', null, 'REPORTED', 'Tap drips'],
      ['ASSIGN', 'REPORTED', 'ASSIGNED', 'Priority HIGH'],
      ['STATUS', 'ASSIGNED', 'ACKNOWLEDGED', null],
      ['STATUS', 'ACKNOWLEDGED', 'IN_PROGRESS', null],
      ['STATUS', 'IN_PROGRESS', 'ON_HOLD', 'Waiting for a washer'],
      ['STATUS', 'ON_HOLD', 'IN_PROGRESS', null],
      ['STATUS', 'IN_PROGRESS', 'RESOLVED', 'Replaced the washer'],
      ['STATUS', 'RESOLVED', 'VERIFIED', null],
    ]);
    expect(
      await db.domainEvent.count({ where: { type: { startsWith: 'task.' } } }),
    ).toBeGreaterThanOrEqual(8);
  });

  it('reopens a resolved task to its assignee with the reason (M6-04)', async () => {
    const h = await hotel();
    const task = await assignedFault(h);
    for (const a of ['acknowledge', 'start'])
      await h.ok(h.femi.client.send(`/tasks/${task.id}/${a}`));
    await h.ok(h.femi.client.send(`/tasks/${task.id}/resolve`, { note: 'Tightened it' }));
    const res = await h.gm.send(`/tasks/${task.id}/reopen`, { reason: 'Still dripping' });
    const reopened = res.body as Task;
    expect(reopened).toMatchObject({
      status: 'ASSIGNED',
      assignee: { id: h.femi.user.id },
      acknowledgedAt: null,
      resolvedAt: null,
    });
    expect(reopened.events.at(-1)).toMatchObject({
      fromStatus: 'RESOLVED',
      toStatus: 'ASSIGNED',
      note: 'Still dripping',
    });
    // A reason is required.
    expect((await h.gm.send(`/tasks/${task.id}/reopen`, {})).status).toBe(400);
  });

  it('refuses moves the lifecycle does not have, and people it is not for', async () => {
    const h = await hotel();
    const task = await assignedFault(h);
    // Not resolved yet: nothing to verify.
    const verify = await h.gm.send(`/tasks/${task.id}/verify`, {});
    expect(verify.status).toBe(409);
    expect(errorOf(verify)).toMatchObject({
      code: 'STATE_TRANSITION_INVALID',
      message: 'This task is assigned; it cannot be verified.',
    });
    // Resolving skips acknowledge and start.
    const skip = await h.femi.client.send(`/tasks/${task.id}/resolve`, { note: 'Done it' });
    expect(skip.status).toBe(409);
    // Gbenga works tasks but this one is Femi's; he can't see it.
    const other = await h.gbenga.client.send(`/tasks/${task.id}/acknowledge`);
    expect(other.status).toBe(404);
    // A worker can't verify.
    const own = await h.femi.client.send(`/tasks/${task.id}/verify`, {});
    expect(own.status).toBe(403);
    // Two people acting at once: the second finds the task moved on.
    const [a, b] = await Promise.all([
      h.femi.client.send(`/tasks/${task.id}/acknowledge`),
      h.gm.send(`/tasks/${task.id}/acknowledge`),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
  });

  it('reassigns: a new assignee starts over, a new deadline restarts escalation', async () => {
    const h = await hotel();
    const task = await assignedFault(h);
    await h.ok(h.femi.client.send(`/tasks/${task.id}/acknowledge`));
    await db.task.update({ where: { id: task.id }, data: { escalationLevel: 1 } });
    const moved = await h.ok<Task>(
      h.gm.send(`/tasks/${task.id}/assign`, {
        assigneeId: h.gbenga.user.id,
        dueAt: '2026-11-10T15:00:00Z',
      }),
    );
    expect(moved).toMatchObject({
      status: 'ASSIGNED',
      assignee: { id: h.gbenga.user.id },
      acknowledgedAt: null,
      escalationLevel: 0,
      dueAt: '2026-11-10T15:00:00Z',
    });
    // Femi no longer sees it; Gbenga does.
    expect((await h.femi.client.get(`/tasks/${task.id}`)).status).toBe(404);
    expect((await h.gbenga.client.get(`/tasks/${task.id}`)).status).toBe(200);
    // Triage without an assignee.
    const triaged = await h.ok<Task>(h.gm.send(`/tasks/${task.id}/assign`, { assigneeId: null }));
    expect(triaged).toMatchObject({ status: 'TRIAGED', assignee: null });
  });

  it('takes comments and photos from anyone who can see the task', async () => {
    const h = await hotel();
    const task = await assignedFault(h);
    const commented = await h.femi.client.send(`/tasks/${task.id}/comments`, {
      note: 'Need a 15 mm washer',
    });
    expect(commented.status).toBe(201);
    expect((commented.body as Task).events.at(-1)).toMatchObject({
      kind: 'COMMENT',
      note: 'Need a 15 mm washer',
      by: { id: h.femi.user.id },
    });
    expect((await h.femi.client.send(`/tasks/${task.id}/comments`, {})).status).toBe(400);
    expect((await h.gbenga.client.send(`/tasks/${task.id}/comments`, { note: 'x' })).status).toBe(
      404,
    );
  });
});

describe('task queue (S18)', () => {
  it('shows managers everything and others what they reported or were given', async () => {
    const h = await hotel();
    const fault = await assignedFault(h); // #1, Femi's, reported by the front desk
    const request = await h.template('GUEST_REQUEST');
    await h.ok(h.gm.send('/tasks', { templateId: request.id })); // #2, the GM's
    const third = await h.ok<Task>(h.gm.send('/tasks', { templateId: request.id })); // #3
    await h.ok(h.gm.send(`/tasks/${third.id}/assign`, { assigneeId: h.femi.user.id }));
    for (const a of ['acknowledge', 'start'])
      await h.ok(h.femi.client.send(`/tasks/${third.id}/${a}`));
    await h.ok(h.femi.client.send(`/tasks/${third.id}/resolve`, { note: 'Brought towels' }));

    const numbers = async (as: typeof h.gm, query = '') =>
      (await h.ok<{ data: Task[] }>(as.get(`/tasks${query}`))).data.map((t) => t.number);
    expect(await numbers(h.gm)).toEqual([3, 2, 1]);
    expect(await numbers(h.gm, '?status=open')).toEqual([2, 1]);
    expect(await numbers(h.fd)).toEqual([1]);
    expect(await numbers(h.femi.client)).toEqual([3, 1]);
    expect(await numbers(h.femi.client, '?assignee=me&status=open')).toEqual([1]);
    expect(await numbers(h.gbenga.client)).toEqual([]);
    expect(await numbers(h.gm, `?type=FAULT&roomId=${h.room102.id}`)).toEqual([fault.number]);

    // Pages, newest first.
    const page = await h.ok<{ data: Task[]; nextCursor: string | null }>(
      h.gm.get('/tasks?limit=2'),
    );
    expect(page.data.map((t) => t.number)).toEqual([3, 2]);
    const rest = await h.ok<{ data: Task[]; nextCursor: string | null }>(
      h.gm.get(`/tasks?limit=2&cursor=${page.nextCursor ?? ''}`),
    );
    expect(rest).toMatchObject({ data: [{ number: 1 }], nextCursor: null });

    // Overdue: past the SLA and still open.
    now = new Date('2026-11-10T13:30:00Z');
    expect(await numbers(h.gm, '?overdue=true')).toEqual([2, 1]);
  });
});

describe('SLA escalation (M6-05)', () => {
  it('escalates a task past its deadline once and only once per level (M6 AC)', async () => {
    const h = await hotel();
    const task = await assignedFault(h); // fault SLA 240 min: due 13:00
    expect(task.dueAt).toBe('2026-11-10T13:00:00Z');
    const level = async () =>
      (await db.task.findUniqueOrThrow({ where: { id: task.id } })).escalationLevel;

    now = new Date('2026-11-10T12:59:00Z');
    expect(await escalateTasks(db, clock)).toBe(0);
    now = new Date('2026-11-10T13:00:00Z');
    const [a, b] = await Promise.all([escalateTasks(db, clock), escalateTasks(db, clock)]);
    expect(a + b).toBe(1);
    expect(await level()).toBe(1);
    expect(await escalateTasks(db, clock)).toBe(0);
    // One SLA window later: the general manager.
    now = new Date('2026-11-10T16:59:00Z');
    expect(await escalateTasks(db, clock)).toBe(0);
    now = new Date('2026-11-10T17:00:00Z');
    expect(await escalateTasks(db, clock)).toBe(1);
    // There is no level 3, however long it stays open.
    now = new Date('2026-11-12T09:00:00Z');
    expect(await escalateTasks(db, clock)).toBe(0);
    expect(await level()).toBe(2);

    // A fresh sign-in: the morning's session has long timed out.
    const gmId = (await db.membership.findFirstOrThrow({ where: { roleId: h.role('gm') } })).userId;
    const detail = await h.ok<Task>((await h.as(gmId)).get(`/tasks/${task.id}`));
    expect(detail).toMatchObject({ overdue: true, escalationLevel: 2 });
    expect(detail.events.filter((e) => e.kind === 'ESCALATE').map((e) => e.note)).toEqual([
      'Past its deadline: escalated to the department managers',
      'Still open: escalated to the general manager',
    ]);
    const events = await db.domainEvent.findMany({ where: { type: 'task.escalated' } });
    expect(events.map((e) => (e.payload as { level: number }).level)).toEqual([1, 2]);
    expect(events[0]).toMatchObject({ organisationId: h.org.id, propertyId: h.p1.id });
  });

  it('leaves resolved tasks and tasks without a deadline alone', async () => {
    const h = await hotel();
    const task = await assignedFault(h);
    for (const a of ['acknowledge', 'start'])
      await h.ok(h.femi.client.send(`/tasks/${task.id}/${a}`));
    await h.ok(h.femi.client.send(`/tasks/${task.id}/resolve`, { note: 'Fixed' }));
    const general = await h.ok<Task>(
      h.gm.send('/tasks', {
        type: 'GENERAL',
        departmentId: (
          await db.department.findFirstOrThrow({ where: { propertyId: h.p1.id, code: 'MGT' } })
        ).id,
        title: 'Plan the staff party',
      }),
    );
    expect(general.dueAt).toBeNull();
    now = new Date('2026-11-20T09:00:00Z');
    expect(await escalateTasks(db, clock)).toBe(0);
  });
});

describe('QR fault report (M5-07, S19)', () => {
  it('pre-fills the room from its sticker; another property’s sticker is unknown', async () => {
    const h = await hotel();
    const room = await h.ok<{ number: string; roomType: string; today: string }>(
      h.attendant.get(`/qr/${h.room102.qrToken}`),
    );
    expect(room).toMatchObject({ number: '102', roomType: h.type.name, today: TODAY });
    const otherType = await db.roomType.create({
      data: { organisationId: h.org.id, propertyId: h.p2.id, code: 'X', name: 'X' },
    });
    await db.room.create({
      data: {
        organisationId: h.org.id,
        propertyId: h.p2.id,
        roomTypeId: otherType.id,
        number: '901',
        qrToken: 'p2-room-901-token',
      },
    });
    expect((await h.attendant.get('/qr/p2-room-901-token')).status).toBe(404);
  });

  it('makes a fault task for maintenance with category and severity', async () => {
    const h = await hotel();
    const res = await h.attendant.send(`/qr/${h.room102.qrToken}/report`, {
      category: 'PLUMBING',
      severity: 'HIGH',
      description: 'Shower drain blocked',
    });
    expect(res.status).toBe(201);
    const { task, outOfOrder } = res.body as { task: Task; outOfOrder: unknown };
    expect(outOfOrder).toBeNull();
    expect(task).toMatchObject({
      type: 'FAULT',
      title: 'Plumbing fault: room 102',
      description: 'Shower drain blocked',
      department: { code: 'MNT' },
      priority: 'HIGH',
      status: 'REPORTED',
      room: { number: '102' },
      dueAt: '2026-11-10T13:00:00Z',
    });
    // Out of order is for critical faults only.
    const res2 = await h.attendant.send(`/qr/${h.room102.qrToken}/report`, {
      category: 'PLUMBING',
      severity: 'HIGH',
      outOfOrderUntil: '2026-11-11',
    });
    expect(res2.status).toBe(400);
    expect(await db.domainEvent.count({ where: { type: 'task.critical_fault' } })).toBe(0);
  });

  it('takes the room out of availability in the same request for a critical fault (M5 AC)', async () => {
    const h = await hotel();
    const free = async () => {
      const inv = await db.roomTypeInventory.findUnique({
        where: {
          propertyId_roomTypeId_date: {
            propertyId: h.p1.id,
            roomTypeId: h.type.id,
            date: new Date(`${TODAY}T00:00:00Z`),
          },
        },
      });
      return inv?.outOfOrder ?? 0;
    };
    expect(await free()).toBe(0);
    const res = await h.attendant.send(`/qr/${h.room102.qrToken}/report`, {
      category: 'ELECTRICAL',
      severity: 'CRITICAL',
      description: 'Sparks from the socket',
      outOfOrderUntil: '2026-11-12',
    });
    expect(res.status).toBe(201);
    const { task, outOfOrder } = res.body as { task: Task; outOfOrder: object };
    expect(outOfOrder).toEqual({ blocked: true, until: '2026-11-12', reason: null });
    expect(task.events.at(-1)?.note).toBe('Room 102 out of order until 2026-11-12');
    expect((await db.room.findUniqueOrThrow({ where: { id: h.room102.id } })).hkStatus).toBe(
      'OUT_OF_ORDER',
    );
    expect(await free()).toBe(1);
    expect(
      await db.roomBlock.findFirst({ where: { roomId: h.room102.id, kind: 'OUT_OF_ORDER' } }),
    ).toMatchObject({ reason: `Critical fault, task #${task.number}` });
    // The general manager is told (the message goes out with T-024).
    expect(await db.domainEvent.count({ where: { type: 'task.critical_fault' } })).toBe(1);
  });

  it('still reports a critical fault when a guest is in the room, and says why it stays on', async () => {
    const h = await hotel();
    const res = await h.attendant.send(`/qr/${h.r101.qrToken}/report`, {
      category: 'SAFETY',
      severity: 'CRITICAL',
      outOfOrderUntil: '2026-11-11',
    });
    expect(res.status).toBe(201);
    const { task, outOfOrder } = res.body as {
      task: Task;
      outOfOrder: { blocked: boolean; reason: string };
    };
    expect(outOfOrder.blocked).toBe(false);
    expect(outOfOrder.reason).toMatch(/given to a guest/);
    expect(task.priority).toBe('CRITICAL');
    expect((await db.room.findUniqueOrThrow({ where: { id: h.r101.id } })).hkStatus).not.toBe(
      'OUT_OF_ORDER',
    );
  });
});

describe('discrepancy tasks (M5 rule 6)', () => {
  it('gives the front desk one task per room and day the morning report disagrees', async () => {
    const h = await hotel();
    const report = (entries: object[]) =>
      h.ok<{ alertsRaised: number }>(h.attendant.send('/housekeeping/status-reports', { entries }));
    const first = await report([
      { roomId: h.r101.id, observed: 'VACANT' },
      { roomId: h.room102.id, observed: 'OCCUPIED' },
    ]);
    expect(first.alertsRaised).toBe(2);
    await report([{ roomId: h.room102.id, observed: 'SLEPT_OUT' }]);

    const tasks = await db.task.findMany({
      where: { type: 'DISCREPANCY' },
      include: { department: true, room: true },
      orderBy: { number: 'asc' },
    });
    expect(
      tasks.map((t) => [t.room?.number, t.department.code, t.priority, t.title, t.stayId]),
    ).toEqual([
      ['101', 'FO', 'HIGH', 'Room 101: reported vacant, front desk shows occupied', h.stayId],
      ['102', 'FO', 'HIGH', 'Room 102: reported occupied, front desk shows vacant', null],
    ]);
    expect(tasks[0]?.description).toBe('Checked in: Ada Obi. Check whether the guest has left.');
    // The front desk manager sees them in the queue.
    const list = await h.ok<{ data: Task[] }>(h.gm.get('/tasks?type=DISCREPANCY'));
    expect(list.data).toHaveLength(2);
  });
});
