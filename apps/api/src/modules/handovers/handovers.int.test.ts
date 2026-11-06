import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../test/db.ts';
import { errorOf } from '../../../test/helpers.ts';
import { inHouse, TODAY } from '../../../test/in-house.ts';
import { DEPARTMENT_TEMPLATES } from '../identity/role-templates.ts';

// Shift handover notes (PRD M6-06 "as a supervisor, I write a shift handover (open tasks,
// approvals, cash position, VIPs); the incoming supervisor acknowledges"; tab 3 handover_notes;
// tab 4 row "Handovers"; T-083).

const db = testDb();
let now: Date;
const clock = () => new Date(now);

beforeEach(async () => {
  await resetDb(db);
  now = new Date('2026-11-10T14:00:00Z');
});

type Snapshot = {
  openTasks: {
    total: number;
    items: {
      number: number;
      title: string;
      status: string;
      overdue: boolean;
      room: string | null;
    }[];
  };
  approvals: { total: number; items: { action: string; label: string; requestedBy: string }[] };
  cash: {
    drawers: {
      cashier: string;
      status: string;
      cash: { currency: string; amountMinor: string }[];
    }[];
    totals: { currency: string; amountMinor: string }[];
  };
  vips: { total: number; items: { name: string; room: string | null; status: string }[] };
};
type Note = {
  id: string;
  businessDate: string;
  department: { code: string };
  writtenBy: { id: string };
  notes: string;
  snapshot: Snapshot;
  acknowledgedBy: { id: string } | null;
  acknowledgedAt: string | null;
  canAcknowledge: boolean;
};
type Draft = {
  businessDate: string;
  departments: { id: string; code: string }[];
  departmentId: string;
  snapshot: Snapshot;
};

/**
 * Ada Obi (VIP) checked in to 101; departments; two housekeeping supervisors in HK; the front
 * desk's drawer open with a ₦20,000 float and ₦5,000 cash taken; a refund waiting for approval;
 * two open HK tasks and one front-office task.
 */
async function hotel() {
  const h = await inHouse(db, clock);
  for (const p of [h.p1, h.p2]) {
    await db.department.createMany({
      data: DEPARTMENT_TEMPLATES.map((d) => ({ organisationId: h.org.id, propertyId: p.id, ...d })),
    });
  }
  const dept = async (code: string, propertyId = h.p1.id) =>
    db.department.findFirstOrThrow({ where: { propertyId, code } });
  const hk = await dept('HK');
  const fo = await dept('FO');
  const supervisor = async () => {
    const user = await h.person('hk-supervisor', h.p1.id);
    await db.membership.updateMany({ where: { userId: user.id }, data: { departmentId: hk.id } });
    return { id: user.id, client: await h.as(user.id) };
  };
  const outgoing = await supervisor();
  const incoming = await supervisor();

  const stay = await db.stay.findUniqueOrThrow({ where: { id: h.stayId } });
  await db.guest.update({ where: { id: stay.guestId }, data: { vip: true, flagReason: 'CEO' } });

  await db.property.update({
    where: { id: h.p1.id },
    data: { settings: { paymentMethods: ['CASH'] } },
  });
  await h.ok(h.fd.send('/shifts', { floatMinor: '2000000' }));
  await h.ok(h.fd.send('/payments', { folioId: h.folioId, method: 'CASH', amountMinor: '500000' }));
  await db.approvalRequest.create({
    data: {
      organisationId: h.org.id,
      propertyId: h.p1.id,
      action: 'payment.refund',
      payload: {},
      payloadHash: 'x',
      amountMinor: 100000n,
      reason: 'Overcharged',
      requestedById: h.fdId,
      expiresAt: new Date(now.getTime() + 3_600_000),
    },
  });

  const task = async (departmentId: string, title: string, dueAt?: string) =>
    h.ok<{ id: string; number: number }>(
      h.gm.send('/tasks', {
        type: 'GENERAL',
        departmentId,
        title,
        ...(dueAt ? { dueAt } : {}),
      }),
    );
  const late = await task(hk.id, 'Restock linen store', '2026-11-10T13:00:00Z');
  const soon = await task(hk.id, 'Deep clean 101', '2026-11-10T18:00:00Z');
  await task(fo.id, 'Call the taxi firm');
  return { ...h, hk, fo, dept, outgoing, incoming, late, soon };
}

describe('the handover draft', () => {
  it('shows the department’s open tasks, approvals waiting, cash and VIPs', async () => {
    const h = await hotel();
    const draft = await h.ok<Draft>(h.outgoing.client.get('/handovers/draft'));
    // The supervisor's own department by default.
    expect(draft.departmentId).toBe(h.hk.id);
    expect(draft.businessDate).toBe(TODAY);
    expect(draft.departments.map((d) => d.code)).toEqual(['FIN', 'FO', 'HK', 'MNT', 'MGT']);
    expect(draft.snapshot.openTasks).toMatchObject({
      total: 2,
      items: [
        { title: 'Restock linen store', status: 'REPORTED', overdue: true },
        { title: 'Deep clean 101', overdue: false },
      ],
    });
    expect(draft.snapshot.approvals).toMatchObject({
      total: 1,
      items: [{ action: 'payment.refund', label: 'Refund' }],
    });
    expect(draft.snapshot.cash.drawers).toMatchObject([
      { status: 'OPEN', cash: [{ currency: 'NGN', amountMinor: '2500000' }] },
    ]);
    expect(draft.snapshot.cash.totals).toEqual([{ currency: 'NGN', amountMinor: '2500000' }]);
    expect(draft.snapshot.vips).toEqual({
      total: 1,
      items: [
        {
          guestId: (await db.stay.findUniqueOrThrow({ where: { id: h.stayId } })).guestId,
          name: 'Ada Obi',
          room: '101',
          status: 'IN_HOUSE',
          arrival: TODAY,
          departure: '2026-11-12',
        },
      ],
    });

    const fo = await h.ok<Draft>(h.outgoing.client.get(`/handovers/draft?departmentId=${h.fo.id}`));
    expect(fo.snapshot.openTasks.items.map((t) => t.title)).toEqual(['Call the taxi firm']);
    // A department of the other property is not found.
    const other = await h.dept('HK', h.p2.id);
    const res = await h.outgoing.client.get(`/handovers/draft?departmentId=${other.id}`);
    expect(res.status).toBe(404);
  });

  it('lists VIPs arriving today as well as those in house', async () => {
    const h = await hotel();
    // Book a second guest for today, not checked in yet, and make them a VIP.
    const type = await db.roomType.findFirstOrThrow({ where: { propertyId: h.p1.id } });
    const bar = await db.ratePlan.findFirstOrThrow({ where: { propertyId: h.p1.id } });
    await h.ok(h.gm.post('/rooms', { number: '102', roomTypeId: type.id }));
    const quote = await h.ok<{ quoteId: string }>(
      h.fd.post('/quotes', {
        roomTypeId: type.id,
        ratePlanId: bar.id,
        arrival: TODAY,
        departure: '2026-11-11',
        adults: 1,
      }),
    );
    const booked = await h.ok<{ stays: { id: string }[] }>(
      h.fd.send('/reservations', {
        source: 'PHONE',
        booker: { firstName: 'Bola', lastName: 'Ade' },
        stays: [{ quoteId: quote.quoteId }],
      }),
    );
    const bola = await db.stay.findUniqueOrThrow({ where: { id: booked.stays[0]?.id ?? '' } });
    await db.guest.update({
      where: { id: bola.guestId },
      data: { vip: true, flagReason: 'Regular' },
    });
    const draft = await h.ok<Draft>(h.outgoing.client.get('/handovers/draft'));
    expect(draft.snapshot.vips.items.map((v) => [v.name, v.status, v.room])).toEqual([
      ['Ada Obi', 'IN_HOUSE', '101'],
      ['Bola Ade', 'ARRIVING', null],
    ]);
  });
});

describe('writing and acknowledging a handover (M6-06)', () => {
  it('keeps the notes with what was open then; later changes do not alter it', async () => {
    const h = await hotel();
    const res = await h.outgoing.client.send('/handovers', {
      departmentId: h.hk.id,
      notes: '  Linen delivery late; 101 asked for extra pillows.  ',
    });
    expect(res.status).toBe(201);
    const note = res.body as Note;
    expect(note).toMatchObject({
      businessDate: TODAY,
      department: { code: 'HK' },
      writtenBy: { id: h.outgoing.id },
      notes: 'Linen delivery late; 101 asked for extra pillows.',
      acknowledgedBy: null,
      acknowledgedAt: null,
      // The writer does not acknowledge their own handover.
      canAcknowledge: false,
    });
    expect(note.snapshot.openTasks.total).toBe(2);

    // The shift moves on: a task is done, another appears.
    await db.task.update({ where: { id: h.soon.id }, data: { status: 'VERIFIED' } });
    await h.ok(h.gm.send('/tasks', { type: 'GENERAL', departmentId: h.hk.id, title: 'New' }));
    const list = await h.ok<{ data: Note[] }>(h.incoming.client.get('/handovers'));
    expect(list.data).toHaveLength(1);
    expect(list.data[0]?.snapshot).toEqual(note.snapshot);
    expect(list.data[0]?.canAcknowledge).toBe(true);

    const events = await db.domainEvent.findMany({ where: { type: { startsWith: 'handover.' } } });
    expect(events.map((e) => e.type)).toEqual(['handover.written']);
  });

  it('refuses empty notes and departments of another property', async () => {
    const h = await hotel();
    const empty = await h.outgoing.client.send('/handovers', { departmentId: h.hk.id, notes: ' ' });
    expect(empty.status).toBe(400);
    const other = await h.dept('HK', h.p2.id);
    const res = await h.outgoing.client.send('/handovers', {
      departmentId: other.id,
      notes: 'All quiet',
    });
    expect(res.status).toBe(400);
    expect(errorOf(res).details).toMatchObject({ issues: [{ path: 'body.departmentId' }] });
    expect(await db.handoverNote.count()).toBe(0);
  });

  it('is acknowledged once, by someone other than its writer', async () => {
    const h = await hotel();
    const note = await h.ok<Note>(
      h.outgoing.client.send('/handovers', { departmentId: h.hk.id, notes: 'All quiet' }),
    );
    const own = await h.outgoing.client.post(`/handovers/${note.id}/acknowledge`);
    expect(own.status).toBe(403);

    const pending = await h.ok<{ data: Note[] }>(h.incoming.client.get('/handovers?pending=true'));
    expect(pending.data.map((n) => n.id)).toEqual([note.id]);

    now = new Date('2026-11-10T15:00:00Z');
    const acked = await h.ok<Note>(h.incoming.client.post(`/handovers/${note.id}/acknowledge`));
    expect(acked).toMatchObject({
      acknowledgedBy: { id: h.incoming.id },
      acknowledgedAt: '2026-11-10T15:00:00Z',
      canAcknowledge: false,
    });
    const again = await h.gm.post(`/handovers/${note.id}/acknowledge`);
    expect(again.status).toBe(409);
    expect(errorOf(again)).toMatchObject({ code: 'STATE_TRANSITION_INVALID' });

    expect((await h.ok<{ data: Note[] }>(h.gm.get('/handovers?pending=true'))).data).toEqual([]);
    const events = await db.domainEvent.findMany({
      where: { type: { startsWith: 'handover.' } },
      orderBy: { id: 'asc' },
    });
    expect(events.map((e) => e.type)).toEqual(['handover.written', 'handover.acknowledged']);
  });

  it('lets only one of two supervisors acknowledging at once succeed', async () => {
    const h = await hotel();
    const note = await h.ok<Note>(
      h.outgoing.client.send('/handovers', { departmentId: h.hk.id, notes: 'All quiet' }),
    );
    const results = await Promise.all([
      h.incoming.client.post(`/handovers/${note.id}/acknowledge`),
      h.gm.post(`/handovers/${note.id}/acknowledge`),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  });

  it('lists newest first, filtered by department, in pages', async () => {
    const h = await hotel();
    for (const [i, departmentId] of [h.hk.id, h.fo.id, h.hk.id].entries()) {
      now = new Date(now.getTime() + 60_000);
      await h.ok(h.gm.send('/handovers', { departmentId, notes: `Note ${i + 1}` }));
    }
    const first = await h.ok<{ data: Note[]; nextCursor: string | null }>(
      h.incoming.client.get('/handovers?limit=2'),
    );
    expect(first.data.map((n) => n.notes)).toEqual(['Note 3', 'Note 2']);
    const second = await h.ok<{ data: Note[]; nextCursor: string | null }>(
      h.incoming.client.get(`/handovers?limit=2&cursor=${first.nextCursor ?? ''}`),
    );
    expect(second).toMatchObject({ data: [{ notes: 'Note 1' }], nextCursor: null });
    const hk = await h.ok<{ data: Note[] }>(
      h.incoming.client.get(`/handovers?departmentId=${h.hk.id}`),
    );
    expect(hk.data.map((n) => n.notes)).toEqual(['Note 3', 'Note 1']);
  });

  it('needs handover.manage', async () => {
    const h = await hotel();
    const note = await h.ok<Note>(
      h.outgoing.client.send('/handovers', { departmentId: h.hk.id, notes: 'All quiet' }),
    );
    const attendant = await h.as((await h.person('hk-attendant', h.p1.id)).id);
    for (const who of [h.fd, attendant]) {
      expect((await who.get('/handovers')).status).toBe(403);
      expect((await who.get('/handovers/draft')).status).toBe(403);
      expect((await who.send('/handovers', { departmentId: h.hk.id, notes: 'x' })).status).toBe(
        403,
      );
      expect((await who.post(`/handovers/${note.id}/acknowledge`)).status).toBe(403);
    }
  });

  it('is never rewritten or deleted in the database', async () => {
    const h = await hotel();
    const note = await h.ok<Note>(
      h.outgoing.client.send('/handovers', { departmentId: h.hk.id, notes: 'All quiet' }),
    );
    await expect(
      db.handoverNote.update({ where: { id: note.id }, data: { content: { notes: 'Edited' } } }),
    ).rejects.toThrow();
    await expect(db.handoverNote.delete({ where: { id: note.id } })).rejects.toThrow();
    await h.ok(h.incoming.client.post(`/handovers/${note.id}/acknowledge`));
    await expect(
      db.handoverNote.update({ where: { id: note.id }, data: { acknowledgedById: h.outgoing.id } }),
    ).rejects.toThrow();
  });
});
