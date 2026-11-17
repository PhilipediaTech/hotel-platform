import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../test/db.ts';
import { errorOf } from '../../../test/helpers.ts';
import { inHouse } from '../../../test/in-house.ts';

// Lost and found (PRD M5-13 "As a manager, I record lost-and-found items with custody and
// handover", lostfound.manage; T-133).

const db = testDb();
let now: Date;
const clock = () => new Date(now);

beforeEach(async () => {
  await resetDb(db);
  now = new Date('2026-11-10T09:00:00Z');
});

type Item = {
  id: string;
  number: number;
  status: string;
  valuable: boolean;
  room: { number: string } | null;
  owner: { guestName: string; checkedOutAt: string | null } | null;
  foundBy: { id: string };
  custodian: { id: string };
  storageLocation: string;
  keepUntil: string;
  canDispose: boolean;
  returnedToName: string | null;
  disposal: string | null;
  events: { kind: string; storageLocation: string | null; custodian: { id: string } | null }[];
};

/** Ada checked in to 101 (inHouse); an attendant and a supervisor; a technician without access. */
async function hotel() {
  const h = await inHouse(db, clock);
  const r101 = await db.room.findFirstOrThrow({ where: { number: '101', propertyId: h.p1.id } });
  const attendant = await h.person('hk-attendant', h.p1.id);
  const supervisor = await h.person('hk-supervisor', h.p1.id);
  const tech = await h.person('maintenance', h.p1.id);
  return {
    ...h,
    r101,
    attendantId: attendant.id,
    supervisorId: supervisor.id,
    techId: tech.id,
    attendant: await h.as(attendant.id),
    supervisor: await h.as(supervisor.id),
    tech: await h.as(tech.id),
  };
}

const PHONE = {
  description: 'Black iPhone 13 in a red case',
  category: 'Phone',
  valuable: true,
  storageLocation: 'Housekeeping office',
};

describe('lost and found (M5-13)', () => {
  it('logs an item against the room guest and follows its custody to the owner', async () => {
    const h = await hotel();
    now = new Date('2026-11-10T12:00:00Z');
    expect((await h.tech.get('/lost-found')).status).toBe(403);
    // Where it was found is needed.
    expect(errorOf(await h.attendant.send('/lost-found', PHONE)).code).toBe('VALIDATION_ERROR');

    // Found in 101 while Ada is in house: she is the likely owner; kept 180 days (valuable).
    const phone = await h.ok<Item>(
      h.attendant.send('/lost-found', { ...PHONE, roomId: h.r101.id }),
    );
    expect(phone).toMatchObject({
      number: 1,
      status: 'HELD',
      room: { number: '101' },
      owner: { guestName: 'Ada Obi', checkedOutAt: null },
      foundBy: { id: h.attendantId },
      custodian: { id: h.attendantId },
      keepUntil: '2027-05-09',
      canDispose: false,
    });

    // Handed to the supervisor in the safe; only people with lost-and-found access hold items.
    expect(
      errorOf(
        await h.attendant.send(`/lost-found/${phone.id}/custody`, {
          storageLocation: 'Safe',
          custodianId: h.techId,
        }),
      ).code,
    ).toBe('VALIDATION_ERROR');
    const moved = await h.ok<Item>(
      h.attendant.send(`/lost-found/${phone.id}/custody`, {
        storageLocation: 'Front office safe',
        custodianId: h.supervisorId,
        note: 'Valuable: into the safe',
      }),
    );
    expect(moved).toMatchObject({
      storageLocation: 'Front office safe',
      custodian: { id: h.supervisorId },
    });
    expect(moved.events.map((e) => [e.kind, e.storageLocation, e.custodian?.id])).toEqual([
      ['LOGGED', 'Housekeeping office', h.attendantId],
      ['CUSTODY', 'Front office safe', h.supervisorId],
    ]);

    // Returned to Ada, who showed her passport.
    expect(
      errorOf(await h.supervisor.send(`/lost-found/${phone.id}/return`, { toName: 'Ada Obi' }))
        .code,
    ).toBe('VALIDATION_ERROR');
    const back = await h.ok<Item>(
      h.supervisor.send(`/lost-found/${phone.id}/return`, {
        toName: 'Ada Obi',
        toPhone: '+2348000000000',
        idNote: 'Passport ending 4567',
      }),
    );
    expect(back).toMatchObject({ status: 'RETURNED', returnedToName: 'Ada Obi' });
    expect(back.events.at(-1)?.kind).toBe('RETURNED');
    for (const path of ['return', 'custody']) {
      const res = await h.supervisor.send(`/lost-found/${phone.id}/${path}`, {
        toName: 'X Y',
        idNote: 'None',
        storageLocation: 'Shelf',
        custodianId: h.supervisorId,
      });
      expect(errorOf(res).code).toBe('STATE_TRANSITION_INVALID');
    }
    expect(
      await db.auditEvent.count({ where: { entityType: 'lost_found_item', entityId: phone.id } }),
    ).toBe(3);

    // The trail cannot be rewritten.
    await expect(db.lostFoundEvent.deleteMany({ where: {} })).rejects.toThrow(/append-only/);
  });

  it('disposes of unclaimed items only after their keep-until date', async () => {
    const h = await hotel();
    const umbrella = await h.ok<Item>(
      h.supervisor.send('/lost-found', {
        description: 'Blue umbrella',
        category: 'Other',
        foundWhere: 'Pool deck',
        storageLocation: 'Housekeeping office',
      }),
    );
    expect(umbrella).toMatchObject({ number: 1, owner: null, keepUntil: '2027-02-08' });
    const dispose = (id: string, disposal: string) =>
      h.supervisor.send(`/lost-found/${id}/dispose`, {
        disposal,
        note: 'Given to the staff charity box',
      });
    expect(errorOf(await dispose(umbrella.id, 'DONATED')).code).toBe('STATE_TRANSITION_INVALID');

    // Kept long enough.
    const watch = await h.ok<Item>(
      h.supervisor.send('/lost-found', {
        description: 'Gold watch',
        category: 'Watch',
        valuable: true,
        foundWhere: 'Restaurant',
        storageLocation: 'Front office safe',
      }),
    );
    await db.lostFoundItem.updateMany({ data: { keepUntil: new Date('2026-11-01T00:00:00Z') } });
    const list = await h.ok<{ data: Item[]; custodians: { id: string }[] }>(
      h.supervisor.get('/lost-found'),
    );
    expect(list.data.map((i) => [i.number, i.canDispose])).toEqual([
      [2, true],
      [1, true],
    ]);
    const ids = list.custodians.map((c) => c.id);
    expect(ids).toEqual(expect.arrayContaining([h.attendantId, h.supervisorId]));
    expect(ids).not.toContain(h.techId);

    const gone = await h.ok<Item>(dispose(umbrella.id, 'DONATED'));
    expect(gone).toMatchObject({ status: 'DISPOSED', disposal: 'DONATED', canDispose: false });
    // A valuable is never discarded or donated.
    expect(errorOf(await dispose(watch.id, 'DISCARDED')).code).toBe('VALIDATION_ERROR');
    await h.ok(dispose(watch.id, 'POLICE'));

    // Held items by default; the others by status; search by number or words.
    expect((await h.ok<{ data: Item[] }>(h.supervisor.get('/lost-found'))).data).toEqual([]);
    const disposed = await h.ok<{ data: Item[] }>(h.supervisor.get('/lost-found?status=DISPOSED'));
    expect(disposed.data.map((i) => i.number)).toEqual([2, 1]);
    const byNumber = await h.ok<{ data: Item[] }>(
      h.supervisor.get('/lost-found?status=DISPOSED&q=LF-2'),
    );
    expect(byNumber.data.map((i) => i.number)).toEqual([2]);
    const byWord = await h.ok<{ data: Item[] }>(
      h.supervisor.get('/lost-found?status=DISPOSED&q=umbrella'),
    );
    expect(byWord.data.map((i) => i.number)).toEqual([1]);
  });
});
