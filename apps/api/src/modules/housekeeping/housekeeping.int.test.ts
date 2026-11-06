import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../test/db.ts';
import { errorOf } from '../../../test/helpers.ts';
import { inHouse, TODAY } from '../../../test/in-house.ts';

// Housekeeping (PRD M5-01–M5-04, M5 rules 1–2 and the acceptance criteria "after night audit,
// the cleaning list contains every departure and stayover for the new business date" and "an
// attendant completing a room with inspection off sets it CLEAN and it becomes assignable
// immediately"; tab 4 row "Housekeeping"; T-080).

const db = testDb();
let now: Date;
const clock = () => new Date(now);

beforeEach(async () => {
  await resetDb(db);
  now = new Date('2026-11-10T09:00:00Z');
});

type Assignment = {
  id: string;
  roomNumber: string;
  kind: string;
  status: string;
  attendant: { id: string; name: string } | null;
  checklist: { item: string; done: boolean }[];
  hkStatus: string;
  startedAt: string | null;
  completedAt: string | null;
};
type Board = {
  businessDate: string;
  floors: string[];
  rooms: {
    number: string;
    floor: string | null;
    hkStatus: string;
    foStatus: string;
    dueOut: boolean;
    arrival: boolean;
    priority: string;
    assignment: Assignment | null;
  }[];
  attendants: { id: string; name: string }[];
};

/**
 * Ada in 101 (10–12 Nov); Bola in 102 leaving on the 11th; 103 vacant and clean; 104 given
 * to Chi, arriving on the 11th; a supervisor and two attendants.
 */
async function hotel() {
  const h = await inHouse(db, clock);
  const type = await db.roomType.findFirstOrThrow({ where: { propertyId: h.p1.id } });
  const bar = await db.ratePlan.findFirstOrThrow({ where: { propertyId: h.p1.id, code: 'BAR' } });
  const room: Record<string, string> = {
    '101': (await db.room.findFirstOrThrow({ where: { number: '101' } })).id,
  };
  for (const [n, floor] of [
    ['102', '1'],
    ['103', '1'],
    ['104', '2'],
  ] as const) {
    const r = await h.ok<{ id: string }>(
      h.gm.post('/rooms', { number: n, roomTypeId: type.id, floor }),
    );
    room[n] = r.id;
  }
  await db.room.updateMany({ data: { hkStatus: 'CLEAN' } });
  const book = async (first: string, arrival: string, departure: string) => {
    const quote = await h.ok<{ quoteId: string }>(
      h.fd.post('/quotes', {
        roomTypeId: type.id,
        ratePlanId: bar.id,
        arrival,
        departure,
        adults: 1,
      }),
    );
    const r = await h.ok<{ stays: { id: string; version: number }[] }>(
      h.fd.send('/reservations', {
        source: 'PHONE',
        booker: { firstName: first, lastName: 'Ade' },
        stays: [{ quoteId: quote.quoteId }],
      }),
    );
    return r.stays[0] as { id: string; version: number };
  };
  const registration = {
    nationality: 'NG',
    purpose: 'BUSINESS',
    idType: 'PASSPORT',
    idNumber: 'B1234567',
  };
  const bola = await book('Bola', TODAY, '2026-11-11');
  await h.ok(
    h.fd
      .send(`/stays/${bola.id}/check-in`, { roomId: room['102'], registration })
      .set('If-Match', `"${bola.version}"`),
  );
  const chi = await book('Chi', '2026-11-11', '2026-11-13');
  await h.ok(
    h.fd
      .send(`/stays/${chi.id}/assign-room`, { roomId: room['104'] })
      .set('If-Match', `"${chi.version}"`),
  );
  const supervisor = await h.as((await h.person('hk-supervisor', h.p1.id)).id);
  const kemiUser = await h.person('hk-attendant', h.p1.id);
  const tundeUser = await h.person('hk-attendant', h.p1.id);
  const auditor = await h.as((await h.person('night-auditor', h.p1.id)).id);
  return { ...h, room, chi, supervisor, kemiUser, tundeUser, auditor };
}

describe('housekeeping', () => {
  it('makes the new day’s list at night audit: every departure and stayover (M5 AC)', async () => {
    const h = await hotel();
    now = new Date('2026-11-10T21:00:00Z');
    const auditor = await h.as(
      (await db.membership.findFirstOrThrow({ where: { roleId: h.role('night-auditor') } })).userId,
    );
    const run = await h.ok<{
      status: string;
      steps: { step: number; result: Record<string, unknown> }[];
    }>(auditor.send('/night-audits', { businessDate: TODAY }));
    expect(run.status).toBe('COMPLETED');
    expect(run.steps.find((s) => s.step === 10)?.result).toMatchObject({ cleaningList: 4 });

    const list = await db.hkAssignment.findMany({
      where: { businessDate: new Date('2026-11-11T00:00:00Z') },
      include: { room: true },
      orderBy: { room: { number: 'asc' } },
    });
    // 101 stays on, 102 leaves, 104 is prepared for Chi; 103 (vacant, clean) gets a deep clean.
    expect(list.map((a) => [a.room.number, a.kind, a.status, a.attendantId])).toEqual([
      ['101', 'STAYOVER', 'PENDING', null],
      ['102', 'DEPARTURE', 'PENDING', null],
      ['103', 'DEEP_CLEAN', 'PENDING', null],
      ['104', 'ARRIVAL', 'PENDING', null],
    ]);
    expect(list[0]?.checklist).toContainEqual({ item: 'Make the beds', done: false });
  });

  it('shows the board by floor and assigns rooms in bulk to an attendant', async () => {
    const h = await hotel();
    const sup = await h.as(
      (await db.membership.findFirstOrThrow({ where: { roleId: h.role('hk-supervisor') } })).userId,
    );
    const board = await h.ok<Board>(sup.get('/housekeeping/board'));
    expect(board.businessDate).toBe(TODAY);
    expect(board.floors).toEqual(['1', '2']);
    expect(board.attendants.map((a) => a.id).sort()).toEqual(
      [h.kemiUser.id, h.tundeUser.id].sort(),
    );
    const byNumber = Object.fromEntries(board.rooms.map((r) => [r.number, r]));
    expect(byNumber['101']).toMatchObject({
      foStatus: 'OCCUPIED',
      dueOut: false,
      assignment: { kind: 'STAYOVER' },
    });
    expect(byNumber['102']).toMatchObject({
      foStatus: 'OCCUPIED',
      dueOut: false,
      assignment: { kind: 'STAYOVER' },
    });
    expect(byNumber['104']).toMatchObject({ foStatus: 'VACANT', arrival: false });
    // Looking again adds nothing.
    const count = await db.hkAssignment.count();
    await h.ok(sup.get('/housekeeping/board'));
    expect(await db.hkAssignment.count()).toBe(count);
    expect(
      (await h.ok<Board>(sup.get('/housekeeping/board?floor=2'))).rooms.map((r) => r.number),
    ).toEqual(['104']);

    const given = await h.ok<{ data: Assignment[] }>(
      sup.send('/housekeeping/assignments', {
        roomIds: [h.room['101'], h.room['102']],
        attendantId: h.kemiUser.id,
      }),
    );
    expect(given.data.map((a) => [a.roomNumber, a.attendant?.id])).toEqual([
      ['101', h.kemiUser.id],
      ['102', h.kemiUser.id],
    ]);
    // 103 and 104 (vacant, clean) are today's deep cleans; a room left dirty after the list
    // was made (105) joins it when given.
    expect([byNumber['103']?.assignment?.kind, byNumber['104']?.assignment?.kind]).toEqual([
      'DEEP_CLEAN',
      'DEEP_CLEAN',
    ]);
    const type = await db.roomType.findFirstOrThrow({ where: { propertyId: h.p1.id } });
    const late = await h.ok<{ id: string }>(
      h.gm.post('/rooms', { number: '105', roomTypeId: type.id, floor: '2' }),
    );
    const extra = await h.ok<{ data: Assignment[] }>(
      sup.send('/housekeeping/assignments', { roomIds: [late.id], attendantId: h.tundeUser.id }),
    );
    expect(extra.data[0]).toMatchObject({
      roomNumber: '105',
      kind: 'DEPARTURE',
      attendant: { id: h.tundeUser.id },
    });
    // Only staff who clean rooms here; never by an attendant.
    expect(
      (
        await sup.send('/housekeeping/assignments', {
          roomIds: [h.room['101']],
          attendantId: h.fdId,
        })
      ).status,
    ).toBe(400);
    const kemi = await h.as(h.kemiUser.id);
    expect(
      (
        await kemi.send('/housekeeping/assignments', {
          roomIds: [h.room['101']],
          attendantId: h.kemiUser.id,
        })
      ).status,
    ).toBe(403);
    expect((await kemi.get('/housekeeping/board')).status).toBe(403);
  });

  it('lets the attendant start, pause and complete a room; done is CLEAN and assignable (M5 AC)', async () => {
    const h = await hotel();
    const sup = await h.as(
      (await db.membership.findFirstOrThrow({ where: { roleId: h.role('hk-supervisor') } })).userId,
    );
    await db.room.update({ where: { id: h.room['103'] }, data: { hkStatus: 'DIRTY' } });
    await h.ok(
      sup.send('/housekeeping/assignments', {
        roomIds: [h.room['101'], h.room['103']],
        attendantId: h.kemiUser.id,
      }),
    );
    const kemi = await h.as(h.kemiUser.id);
    const tunde = await h.as(h.tundeUser.id);
    const mine = await h.ok<{ businessDate: string; data: Assignment[] }>(
      kemi.get('/housekeeping/my-assignments'),
    );
    expect(mine.data.map((a) => [a.roomNumber, a.kind, a.status])).toEqual([
      ['101', 'STAYOVER', 'PENDING'],
      ['103', 'DEPARTURE', 'PENDING'],
    ]);
    expect(
      (await h.ok<{ data: Assignment[] }>(tunde.get('/housekeeping/my-assignments'))).data,
    ).toEqual([]);
    const [stayover, departure] = mine.data as [Assignment, Assignment];
    const patch = (who: typeof kemi, a: Assignment, body: object) =>
      who.patch(`/housekeeping/assignments/${a.id}`, body);

    expect((await patch(tunde, departure, { action: 'START' })).status).toBe(403);
    expect(errorOf(await patch(kemi, departure, { action: 'COMPLETE' })).code).toBe(
      'STATE_TRANSITION_INVALID',
    );

    // Starting a room sets it CLEANING; starting another pauses the first.
    let a = await h.ok<Assignment>(patch(kemi, departure, { action: 'START' }));
    expect(a).toMatchObject({
      status: 'IN_PROGRESS',
      hkStatus: 'CLEANING',
    });
    expect(a.startedAt).not.toBeNull();
    await h.ok(patch(kemi, stayover, { action: 'START' }));
    expect((await db.hkAssignment.findUniqueOrThrow({ where: { id: departure.id } })).status).toBe(
      'PAUSED',
    );
    a = await h.ok<Assignment>(patch(kemi, departure, { action: 'START' }));
    expect(a.status).toBe('IN_PROGRESS');

    // Completing needs every item ticked; then the room is CLEAN.
    const notYet = await patch(kemi, departure, { action: 'COMPLETE' });
    expect(errorOf(notYet).code).toBe('VALIDATION_ERROR');
    a = await h.ok<Assignment>(
      patch(kemi, departure, {
        checklist: departure.checklist.map((c) => ({ ...c, done: true })),
        minibar: [{ item: 'Water', quantity: 2 }],
        notes: 'Stain on the curtain',
      }),
    );
    expect(a.checklist.every((c) => c.done)).toBe(true);
    a = await h.ok<Assignment>(patch(kemi, departure, { action: 'COMPLETE' }));
    expect(a).toMatchObject({ status: 'DONE', hkStatus: 'CLEAN' });
    expect(a.completedAt).not.toBeNull();
    const stored = await db.hkAssignment.findUniqueOrThrow({ where: { id: departure.id } });
    expect(stored.minibar).toEqual([{ item: 'Water', quantity: 2 }]);
    expect(stored.notes).toBe('Stain on the curtain');
    expect(errorOf(await patch(kemi, departure, { action: 'START' })).code).toBe(
      'STATE_TRANSITION_INVALID',
    );
    expect(
      errorOf(
        await sup.send('/housekeeping/assignments', {
          roomIds: [h.room['103']],
          attendantId: null,
        }),
      ).code,
    ).toBe('STATE_TRANSITION_INVALID');

    // Assignable at once: Chi's stay can be given room 103.
    const free = await h.ok<{ data: { id: string; problems: string[] }[] }>(
      h.fd.get(`/stays/${h.chi.id}/rooms`),
    );
    expect(free.data.find((r) => r.id === h.room['103'])?.problems).toEqual([]);
  });
});
