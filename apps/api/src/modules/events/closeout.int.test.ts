import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { FAKE_WEBHOOK_KEY } from '../../core/payments.ts';
import { PAYSTACK_SIGNATURE_HEADER, signPaystack } from '../../core/paystack-events.ts';
import { resetDb, testDb } from '../../../test/db.ts';
import { errorOf } from '../../../test/helpers.ts';
import { inHouse } from '../../../test/in-house.ts';
import { createDefaultApprovalPolicies } from '../approvals/defaults.ts';
import { processWebhookEvents } from '../payments/webhooks.ts';

// Events and spaces, third part (PRD M9-07, M9-08; M9 rule "damage deposits are a liability,
// never revenue, until settled"; T-121).

const db = testDb();
let now: Date;
const clock = () => new Date(now);

beforeEach(async () => {
  await resetDb(db);
  now = new Date('2026-11-10T09:00:00Z');
});

type Section = { department: { id: string; name: string }; instructions: string; version: number };
type CloseOut = {
  status: string;
  blockers: string[];
  inspection: { damageTotalMinor: string } | null;
  folio: { id: string; balanceMinor: string; status: string } | null;
  damageDepositHeldMinor: string;
  damageDepositRetainedMinor: string;
};
type Contract = {
  contract: {
    account: { accountNumber: string };
    folio: { id: string };
    schedule: { kind: string; amountMinor: string }[];
    totalMinor: string;
  };
};

const HIRE = { kind: 'SPACE', description: 'Hall, full day', quantity: 1, unitMinor: '80000000' };
const AFTER_EVENT = new Date('2026-12-05T17:00:00Z');

async function hotel() {
  const h = await inHouse(db, clock);
  await createDefaultApprovalPolicies(db, h.org.id, h.p1.id);
  await db.department.createMany({
    data: ['FB', 'HK'].map((code) => ({
      organisationId: h.org.id,
      propertyId: h.p1.id,
      code,
      name: code,
    })),
    skipDuplicates: true,
  });
  const space = await h.ok<{ id: string; layouts: { id: string }[] }>(
    h.gm.post('/spaces', {
      code: 'HALL',
      name: 'Marina Hall',
      setupMinutes: 60,
      cleanupMinutes: 30,
      layouts: [{ name: 'Banquet', capacity: 120 }],
    }),
  );
  const booking = await h.ok<{ id: string }>(
    h.gm.send('/event-bookings', {
      spaceId: space.id,
      layoutId: space.layouts[0]?.id,
      title: 'Adaeze wedding',
      startsAt: '2026-12-05T10:00:00Z',
      endsAt: '2026-12-05T16:00:00Z',
      expectedGuests: 100,
      holdUntil: '2026-11-20T09:00:00Z',
    }),
  );
  const at = `/event-bookings/${booking.id}`;
  let hookId = 5000;
  const transfer = async (account: string, amountMinor: bigint) => {
    const id = hookId++;
    const body = JSON.stringify({
      event: 'charge.success',
      data: {
        id,
        status: 'success',
        reference: `T${id}`,
        amount: Number(amountMinor),
        currency: 'NGN',
        paid_at: '2026-11-10T09:10:00.000Z',
        channel: 'dedicated_nuban',
        authorization: { receiver_bank_account_number: account, sender_name: 'ADAEZE OBI' },
      },
    });
    await request(h.app)
      .post('/api/v1/webhooks/payments/fake')
      .set('Content-Type', 'application/json')
      .set(PAYSTACK_SIGNATURE_HEADER, signPaystack(body, FAKE_WEBHOOK_KEY))
      .send(body)
      .expect(200);
    await processWebhookEvents({ db, clock, provider: h.payments });
  };
  /** Quoted, contracted with a ₦100,000 damage deposit, paid in full and confirmed. */
  const paidAndConfirmed = async () => {
    const q = await h.ok<{ versions: { totalMinor: string }[] }>(
      h.gm.send(`${at}/quotes`, { lines: [HIRE] }),
    );
    const total = BigInt(q.versions[0]?.totalMinor ?? 0);
    const v = await h.ok<Contract>(
      h.gm.send(`${at}/contract`, {
        clientName: 'Adaeze Obi',
        clientEmail: 'adaeze@example.com',
        clientPhone: '+2348011111111',
        terms: 'Terms',
        schedule: [
          { kind: 'DEPOSIT', dueDate: '2026-11-12', amountMinor: total.toString() },
          { kind: 'DAMAGE_DEPOSIT', dueDate: '2026-11-13', amountMinor: '10000000' },
        ],
      }),
    );
    await h.ok(h.gm.post(`${at}/contract/sign`, { signedByName: 'A', signedOn: '2026-11-10' }));
    await transfer(v.contract.account.accountNumber, total + 10000000n);
    await h.ok(h.gm.send(`${at}/confirm`, {}));
    return { total, account: v.contract.account.accountNumber, folioId: v.contract.folio.id };
  };
  const manager = () => h.as(h.gmId);
  return {
    ...h,
    at,
    bookingId: booking.id,
    spaceId: space.id,
    transfer,
    paidAndConfirmed,
    manager,
  };
}

const overrideConfirm = async (h: Awaited<ReturnType<typeof hotel>>) =>
  h.ok(h.gm.send(`${h.at}/confirm`, { override: true, reason: 'Regular client' }));

describe('the brief for each department (M9-07)', () => {
  it('waits for a confirmed booking', async () => {
    const h = await hotel();
    const refused = await h.gm.put(`${h.at}/brief`, { sections: [] });
    expect(refused.status).toBe(409);
  });

  it('keeps one set of instructions per department, versioned when they change', async () => {
    const h = await hotel();
    await overrideConfirm(h);
    const first = await h.ok<{ sections: Section[] }>(h.gm.get(`${h.at}/brief`));
    expect(first.sections.length).toBeGreaterThan(1);
    const [a, b] = first.sections.map((s) => s.department.id);
    await h.ok(
      h.gm.put(`${h.at}/brief`, {
        sections: [
          { departmentId: a, instructions: 'Set 12 tables of 10' },
          { departmentId: b, instructions: 'Buffet for 100 at 13:00' },
        ],
      }),
    );
    const saved = await h.ok<{ sections: Section[] }>(
      h.gm.put(`${h.at}/brief`, {
        sections: [
          { departmentId: a, instructions: 'Set 13 tables of 10' },
          { departmentId: b, instructions: 'Buffet for 100 at 13:00' },
        ],
      }),
    );
    const of = (id?: string) => saved.sections.find((s) => s.department.id === id);
    expect(of(a)).toMatchObject({ instructions: 'Set 13 tables of 10', version: 2 });
    expect(of(b)?.version).toBe(1);
    const cleared = await h.ok<{ sections: Section[] }>(
      h.gm.put(`${h.at}/brief`, { sections: [{ departmentId: b, instructions: '' }] }),
    );
    expect(cleared.sections.find((s) => s.department.id === b)?.instructions).toBe('');
    expect(await db.eventBrief.count()).toBe(1);
  });

  it('prints the banquet event order, whole or for one department', async () => {
    const h = await hotel();
    await overrideConfirm(h);
    const { sections } = await h.ok<{ sections: Section[] }>(h.gm.get(`${h.at}/brief`));
    const [a, b] = sections.map((s) => s.department.id);
    expect((await h.gm.get(`${h.at}/brief.pdf`)).status).toBe(404);
    await h.ok(
      h.gm.put(`${h.at}/brief`, { sections: [{ departmentId: a, instructions: 'Tables' }] }),
    );
    const whole = await h.gm.get(`${h.at}/brief.pdf`);
    expect(whole.status).toBe(200);
    expect(whole.headers['content-type']).toContain('application/pdf');
    expect((await h.gm.get(`${h.at}/brief.pdf?departmentId=${a}`)).status).toBe(200);
    expect((await h.gm.get(`${h.at}/brief.pdf?departmentId=${b}`)).status).toBe(404);
  });

  it('refuses another property’s department, and needs event.brief', async () => {
    const h = await hotel();
    await overrideConfirm(h);
    const body = {
      sections: [{ departmentId: '11111111-0000-4000-8000-000000000001', instructions: 'X' }],
    };
    expect((await h.gm.put(`${h.at}/brief`, body)).status).toBe(400);
    expect((await h.fd.put(`${h.at}/brief`, body)).status).toBe(403);
  });
});

describe('inspection and final invoice (M9-08)', () => {
  it('waits until the event has finished', async () => {
    const h = await hotel();
    await overrideConfirm(h);
    const refused = await h.gm.send(`${h.at}/inspection`, { notes: 'Too early' });
    expect(refused.status).toBe(409);
  });

  it('posts the contracted quote, extras and damage to the event’s bill, once', async () => {
    const h = await hotel();
    const { folioId } = await h.paidAndConfirmed();
    now = AFTER_EVENT;
    const gm = await h.manager();
    await h.ok(
      gm.send(`${h.at}/inspection`, {
        notes: 'One table cracked',
        damageMinor: '2000000',
        damageDescription: 'Table cracked',
        extras: [{ kind: 'EXTRA', description: 'Overtime', quantity: 2, unitMinor: '500000' }],
      }),
    );
    const charges = await db.folioLine.findMany({ where: { folioId, kind: 'CHARGE' } });
    expect(charges.map((c) => c.description).sort()).toEqual([
      'Damage: Table cracked',
      'Hall, full day',
      'Overtime',
    ]);
    expect(charges.every((c) => c.sourceType === 'EVENT')).toBe(true);
    const again = await gm.send(`${h.at}/inspection`, { notes: 'Again' });
    expect(again.status).toBe(409);
    expect(await db.folioLine.count({ where: { folioId, kind: 'CHARGE' } })).toBe(3);
  });

  it('a booking confirmed on an override is invoiced from its quote on a bill of its own', async () => {
    const h = await hotel();
    await h.ok(h.gm.send(`${h.at}/quotes`, { lines: [HIRE] }));
    await overrideConfirm(h);
    now = AFTER_EVENT;
    const gm = await h.manager();
    const view = await h.ok<CloseOut>(gm.send(`${h.at}/inspection`, { notes: 'Fine' }));
    expect(BigInt(view.folio?.balanceMinor ?? 0)).toBeGreaterThan(0n);
    expect(view.blockers).toEqual(['BALANCE_DUE']);
    const folio = await db.folio.findUniqueOrThrow({ where: { id: view.folio?.id ?? '' } });
    expect(folio.kind).toBe('EVENT');
  });

  it('with nothing provided there is nothing to invoice', async () => {
    const h = await hotel();
    await overrideConfirm(h);
    now = AFTER_EVENT;
    const refused = await (await h.manager()).send(`${h.at}/inspection`, { notes: 'Nothing' });
    expect(refused.status).toBe(409);
  });

  it('damage needs a description; the invoice is a PDF; event.close is needed', async () => {
    const h = await hotel();
    await h.paidAndConfirmed();
    now = AFTER_EVENT;
    const gm = await h.manager();
    expect((await gm.send(`${h.at}/inspection`, { notes: 'X', damageMinor: '100' })).status).toBe(
      400,
    );
    const fd = await h.as(h.fdId);
    expect((await fd.send(`${h.at}/inspection`, { notes: 'X' })).status).toBe(403);
    expect((await gm.get(`${h.at}/invoice.pdf`)).status).toBe(404);
    await h.ok(gm.send(`${h.at}/inspection`, { notes: 'Fine' }));
    const pdf = await gm.get(`${h.at}/invoice.pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
  });
});

describe('settling the damage deposit and closing (M9-08, M9 rule)', () => {
  it('the deposit is no revenue until the inspection; only the damage then is', async () => {
    const h = await hotel();
    const { folioId } = await h.paidAndConfirmed();
    expect(await db.folioLine.count({ where: { folioId } })).toBe(0);
    now = AFTER_EVENT;
    const view = await h.ok<CloseOut>(
      (await h.manager()).send(`${h.at}/inspection`, {
        notes: 'Stain',
        damageMinor: '2000000',
        damageDescription: 'Carpet stain',
      }),
    );
    expect(view.damageDepositHeldMinor).toBe('10000000');
    expect(view.damageDepositRetainedMinor).toBe(view.inspection?.damageTotalMinor);
    expect(BigInt(view.inspection?.damageTotalMinor ?? 0)).toBeGreaterThanOrEqual(2000000n);
  });

  it('damage beyond the deposit retains only the deposit, and the client owes the rest', async () => {
    const h = await hotel();
    await h.paidAndConfirmed();
    now = AFTER_EVENT;
    const view = await h.ok<CloseOut>(
      (await h.manager()).send(`${h.at}/inspection`, {
        notes: 'Bad',
        damageMinor: '20000000',
        damageDescription: 'Stage broken',
      }),
    );
    expect(view.damageDepositRetainedMinor).toBe('10000000');
    expect(view.blockers).toEqual(['BALANCE_DUE']);
  });

  it('what is left of the deposit goes back through a refund, then the event closes', async () => {
    const h = await hotel();
    const { folioId, account } = await h.paidAndConfirmed();
    now = AFTER_EVENT;
    const gm = await h.manager();
    const view = await h.ok<CloseOut>(gm.send(`${h.at}/inspection`, { notes: 'Clean' }));
    expect(view.blockers).toEqual(['CREDIT_TO_RETURN']);
    const closing = await gm.send(`${h.at}/close`, {});
    expect(closing.status).toBe(409);
    expect(errorOf(closing).details?.['blockers']).toEqual(['CREDIT_TO_RETURN']);

    await h.ok(gm.send('/shifts', { floatMinor: '0' }));
    const payment = await db.payment.findFirstOrThrow({ where: { folioId } });
    await h.ok(
      gm.send(`/payments/${payment.id}/refund`, {
        amountMinor: (-BigInt(view.folio?.balanceMinor ?? 0)).toString(),
        method: 'BANK_TRANSFER',
        externalRef: 'REF-1',
        reason: 'Damage deposit returned',
      }),
    );
    const closed = await h.ok<{ status: string }>(gm.send(`${h.at}/close`, {}));
    expect(closed.status).toBe('CLOSED');
    expect((await db.folio.findUniqueOrThrow({ where: { id: folioId } })).status).toBe('SETTLED');
    expect(
      (await db.virtualAccount.findFirstOrThrow({ where: { ownerType: 'EVENT' } })).active,
    ).toBe(false);
    expect(await db.auditEvent.count({ where: { action: 'event_booking.closed' } })).toBe(1);

    // A closed event stays on the calendar, and what arrives late waits to be matched.
    const calendar = await h.ok<{ data: { status: string }[] }>(
      gm.get('/event-bookings?from=2026-12-05T00:00:00Z&to=2026-12-06T00:00:00Z'),
    );
    expect(calendar.data.map((b) => b.status)).toEqual(['CLOSED']);
    await h.transfer(account, 1000000n);
    expect(await db.unmatchedTransfer.count()).toBe(1);
    expect((await gm.send(`${h.at}/close`, {})).status).toBe(409);
  });

  it('money the client still owes can come in on the event account, then it closes', async () => {
    const h = await hotel();
    const { account } = await h.paidAndConfirmed();
    now = AFTER_EVENT;
    const gm = await h.manager();
    const view = await h.ok<CloseOut>(
      gm.send(`${h.at}/inspection`, {
        notes: 'Bad',
        damageMinor: '20000000',
        damageDescription: 'Stage broken',
      }),
    );
    await h.transfer(account, BigInt(view.folio?.balanceMinor ?? 0));
    const after = await h.ok<CloseOut>(gm.get(`${h.at}/close-out`));
    expect(after.blockers).toEqual([]);
    await h.ok(gm.send(`${h.at}/close`, {}));
  });

  it('cannot close before the inspection, or while the cleanup is still running', async () => {
    const h = await hotel();
    await h.paidAndConfirmed();
    now = new Date('2026-12-05T16:10:00Z');
    const gm = await h.manager();
    const early = await h.ok<CloseOut>(gm.get(`${h.at}/close-out`));
    expect(early.blockers).toEqual(['EVENT_NOT_OVER', 'NOT_INSPECTED']);
    expect((await gm.send(`${h.at}/close`, {})).status).toBe(409);
  });

  it('event money can be refunded only once the event has been inspected', async () => {
    const h = await hotel();
    const { folioId } = await h.paidAndConfirmed();
    await h.ok(h.gm.send('/shifts', { floatMinor: '0' }));
    const payment = await db.payment.findFirstOrThrow({ where: { folioId } });
    const refused = await h.gm.send(`/payments/${payment.id}/refund`, {
      amountMinor: '100',
      method: 'BANK_TRANSFER',
      externalRef: 'REF-2',
      reason: 'Early',
    });
    expect(refused.status).toBe(409);
    expect(errorOf(refused).details?.['reason']).toBe('EVENT_MONEY');
  });
});
