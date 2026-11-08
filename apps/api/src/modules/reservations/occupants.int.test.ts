import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { runAsTenant, type TenantContext } from '../../core/tenancy.ts';
import { createTenantDb } from '../../core/tenant-db.ts';
import { resetDb, testDb } from '../../../test/db.ts';
import { errorOf } from '../../../test/helpers.ts';
import { inHouse, TODAY } from '../../../test/in-house.ts';
import { postRoomNight } from '../nightaudit/room-charges.ts';

// Extra people on a stay (PRD M14-02, M14-03 and the M14 AC "adding a third adult to a room
// type with maximum 2 fails with OCCUPANCY_EXCEEDED" and "a plan with base occupancy 2 and an
// extra-adult charge of ₦5,000 posts ₦5,000 plus taxes each night for the third adult"; T-056).
// The charge is the desk's to set: the plan only suggests it (Philip, 2026-11-08: "the rate
// should not be fixed, make it flexible").

const db = testDb();
let now: Date;
const clock = () => new Date(now);

beforeEach(async () => {
  await resetDb(db);
  now = new Date('2026-11-10T09:00:00Z');
});

type Occupants = {
  adults: number;
  children: number;
  baseOccupancy: number;
  maxOccupancy: number;
  suggested: { ADULT: string; CHILD: string };
  stayVersion: number;
  data: {
    id: string;
    firstName: string;
    kind: string;
    nightlyChargeMinor: string;
    chargeNote: string | null;
    removedAt: string | null;
    version: number;
  }[];
};

/** Ada Obi (1 adult) in room 101, a Standard room for 2 at most and 2 included; BAR suggests
 * ₦5,000 per extra adult and ₦2,000 per extra child. */
async function hotel() {
  const h = await inHouse(db, clock);
  const bar = await db.ratePlan.findFirstOrThrow({ where: { propertyId: h.p1.id, code: 'BAR' } });
  await h.ok(
    h.gm
      .patch(`/rate-plans/${bar.id}`, { extraAdultMinor: '500000', extraChildMinor: '200000' })
      .set('If-Match', `"${bar.version}"`),
  );
  const list = (as = h.fd) => h.ok<Occupants>(as.get(`/stays/${h.stayId}/occupants`));
  const add = (body: object, as = h.fd) => as.send(`/stays/${h.stayId}/occupants`, body);
  const roomTypeId = (await db.stay.findUniqueOrThrow({ where: { id: h.stayId } })).roomTypeId;
  const roomy = () => db.roomType.update({ where: { id: roomTypeId }, data: { maxOccupancy: 4 } });
  /** Night audit step 4 for one night of Ada's stay. */
  const postNight = async (night: string) => {
    const tenant: TenantContext = {
      userId: h.fdId,
      organisationId: h.org.id,
      propertyId: h.p1.id,
      roles: [],
      permissions: new Set(),
    };
    const tenantDb = createTenantDb(db);
    return runAsTenant(tenant, () =>
      tenantDb.$transaction((tx) =>
        postRoomNight(
          { tx, tenant, approvalRequestId: null, now: clock() },
          { stayId: h.stayId, night, businessDate: night, clock },
        ),
      ),
    );
  };
  return { ...h, bar, list, add, roomy, postNight };
}

describe('extra people on a stay (M14-02, M14-03)', () => {
  it('counts the added person, refuses a third adult in a room for two, suggests the plan’s charge', async () => {
    const h = await hotel();
    expect(await h.list()).toMatchObject({
      adults: 1,
      children: 0,
      baseOccupancy: 2,
      maxOccupancy: 2,
      // A second guest is still within the 2 included: nothing suggested.
      suggested: { ADULT: '0', CHILD: '0' },
      data: [],
    });
    const before = (await db.stay.findUniqueOrThrow({ where: { id: h.stayId } })).version;
    const bola = await h.add({ firstName: 'Bola', lastName: 'Obi', kind: 'ADULT' });
    expect(bola.status, JSON.stringify(bola.body)).toBe(201);
    const after = bola.body as Occupants;
    expect(after).toMatchObject({
      adults: 2,
      // A third would be above the base: the plan's charges.
      suggested: { ADULT: '500000', CHILD: '200000' },
      stayVersion: before + 1,
      data: [{ firstName: 'Bola', kind: 'ADULT', nightlyChargeMinor: '0', chargeNote: null }],
    });

    // The AC: a third adult in a Standard room (maximum 2).
    const chi = await h.add({ firstName: 'Chi', lastName: 'Obi', kind: 'ADULT' });
    expect(chi.status).toBe(422);
    expect(errorOf(chi)).toMatchObject({
      code: 'OCCUPANCY_EXCEEDED',
      details: { maxOccupancy: 2, adults: 2, children: 0 },
    });
    const audit = await db.auditEvent.findMany({ where: { action: 'stay.occupant_added' } });
    expect(audit).toHaveLength(1);
  });

  it('the desk sets the charge: the suggestion by default, any amount with a reason', async () => {
    const h = await hotel();
    await h.roomy();
    await h.ok(h.add({ firstName: 'Bola', lastName: 'Obi', kind: 'ADULT' }));
    // Third adult: the suggestion when no amount is given.
    const chi = await h.ok<Occupants>(h.add({ firstName: 'Chi', lastName: 'Obi', kind: 'ADULT' }));
    expect(chi.data[0]).toMatchObject({ firstName: 'Chi', nightlyChargeMinor: '500000' });

    // Free for a small child, but only with a reason.
    const bare = await h.add({
      firstName: 'Dayo',
      lastName: 'Obi',
      kind: 'CHILD',
      nightlyChargeMinor: '0',
    });
    expect(bare.status).toBe(400);
    expect(errorOf(bare).details).toMatchObject({
      issues: [expect.objectContaining({ path: 'body.chargeNote' })],
    });
    const dayo = await h.ok<Occupants>(
      h.add({
        firstName: 'Dayo',
        lastName: 'Obi',
        kind: 'CHILD',
        nightlyChargeMinor: '0',
        chargeNote: 'Under five: free',
      }),
    );
    expect(dayo).toMatchObject({ adults: 3, children: 1 });
    expect(dayo.data[0]).toMatchObject({ nightlyChargeMinor: '0', chargeNote: 'Under five: free' });
    const added = await db.auditEvent.findFirstOrThrow({
      where: { action: 'stay.occupant_added', reason: 'Under five: free' },
    });
    expect(added.after).toMatchObject({ nightlyChargeMinor: '0', suggestedMinor: '200000' });

    // A negotiated amount for Chi from the next night, with its reason; the old version is refused.
    const chiRow = chi.data[0] as Occupants['data'][number];
    const path = `/stays/${h.stayId}/occupants/${chiRow.id}`;
    const changed = await h.ok<Occupants>(
      h.fd
        .patch(path, { nightlyChargeMinor: '350000', chargeNote: 'Agreed with the GM' })
        .set('If-Match', `"${chiRow.version}"`),
    );
    expect(changed.data.find((o) => o.id === chiRow.id)).toMatchObject({
      nightlyChargeMinor: '350000',
      chargeNote: 'Agreed with the GM',
    });
    const stale = await h.fd
      .patch(path, { nightlyChargeMinor: '500000' })
      .set('If-Match', `"${chiRow.version}"`);
    expect(stale.status).toBe(409);
    expect(errorOf(stale).code).toBe('VERSION_CONFLICT');
  });

  it('night audit posts each charge with the room night, once, under the room code and taxes', async () => {
    const h = await hotel();
    await h.roomy();
    await h.ok(h.add({ firstName: 'Bola', lastName: 'Obi', kind: 'ADULT' }));
    await h.ok(h.add({ firstName: 'Chi', lastName: 'Obi', kind: 'ADULT' })); // ₦5,000 suggested
    expect(await h.postNight(TODAY)).toEqual({ posted: true, amountMinor: 10_500_000n });
    // A rerun of the night posts nothing more.
    expect(await h.postNight(TODAY)).toEqual({ posted: false, amountMinor: 0n });

    const folio = await h.folio();
    const lines = folio.windows.flatMap((w) => w.lines);
    const extra = lines.filter((l) => l.description.startsWith('Extra adult'));
    expect(extra).toEqual([
      expect.objectContaining({
        kind: 'CHARGE',
        revenueCode: 'ROOM',
        description: `Extra adult: Chi Obi, night of ${TODAY}`,
        amountMinor: '500000',
      }),
    ]);
    // Same taxes as the room: tax lines hang off the extra line.
    const taxes = lines.filter((l) => l.parentLineId === extra[0]?.id);
    expect(taxes.length).toBeGreaterThan(0);
    const room = lines.find((l) => l.description.startsWith('Room 101'));
    expect(taxes.length).toBe(lines.filter((l) => l.parentLineId === room?.id).length);
  });

  it('removing a person frees the place and stops their charge; nights posted stay posted', async () => {
    const h = await hotel();
    await h.roomy();
    await h.ok(h.add({ firstName: 'Bola', lastName: 'Obi', kind: 'ADULT' }));
    const chi = await h.ok<Occupants>(h.add({ firstName: 'Chi', lastName: 'Obi', kind: 'ADULT' }));
    await h.postNight(TODAY);
    const row = chi.data[0] as Occupants['data'][number];
    const removed = await h.ok<Occupants>(
      h.fd
        .send(`/stays/${h.stayId}/occupants/${row.id}/remove`, {})
        .set('If-Match', `"${row.version}"`),
    );
    expect(removed.adults).toBe(2);
    expect(removed.data.find((o) => o.id === row.id)?.removedAt).toBe('2026-11-10T09:00:00Z');
    const again = await h.fd
      .send(`/stays/${h.stayId}/occupants/${row.id}/remove`, {})
      .set('If-Match', `"${row.version + 1}"`);
    expect(errorOf(again).code).toBe('STATE_TRANSITION_INVALID');

    expect(await h.postNight('2026-11-11')).toEqual({ posted: true, amountMinor: 10_000_000n });
    const lines = (await h.folio()).windows.flatMap((w) => w.lines);
    expect(
      lines.filter((l) => l.description.startsWith('Extra adult')).map((l) => l.businessDate),
    ).toEqual([TODAY]);
  });

  it('only on open stays, only with reservation.modify; the plan’s suggestions are optional', async () => {
    const h = await hotel();
    const hk = await h.person('hk-attendant', h.p1.id);
    const attendant = await h.as(hk.id);
    expect(
      (await h.add({ firstName: 'Bola', lastName: 'Obi', kind: 'ADULT' }, attendant)).status,
    ).toBe(403);

    await db.stay.update({
      where: { id: h.stayId },
      data: { status: 'CHECKED_OUT', checkedOutAt: now },
    });
    const late = await h.add({ firstName: 'Bola', lastName: 'Obi', kind: 'ADULT' });
    expect(late.status).toBe(409);
    expect(errorOf(late)).toMatchObject({
      code: 'STATE_TRANSITION_INVALID',
      details: { status: 'CHECKED_OUT' },
    });

    // A plan may leave the suggestions empty; negative ones are refused.
    const bar = await db.ratePlan.findUniqueOrThrow({ where: { id: h.bar.id } });
    const cleared = await h.ok<{ extraAdultMinor: string | null; version: number }>(
      h.gm
        .patch(`/rate-plans/${bar.id}`, { extraAdultMinor: null })
        .set('If-Match', `"${bar.version}"`),
    );
    expect(cleared.extraAdultMinor).toBeNull();
    const negative = await h.gm
      .patch(`/rate-plans/${bar.id}`, { extraChildMinor: '-100' })
      .set('If-Match', `"${cleared.version}"`);
    expect(negative.status).toBe(400);
  });

  it('another property’s stay answers 404', async () => {
    const h = await hotel();
    const res = await h.fd
      .post(`/stays/${randomUUID()}/occupants`, { firstName: 'X', lastName: 'Y', kind: 'ADULT' })
      .set('Idempotency-Key', randomUUID());
    expect(res.status).toBe(404);
  });
});
