import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { FAKE_WEBHOOK_KEY } from '../../core/payments.ts';
import { PAYSTACK_SIGNATURE_HEADER, signPaystack } from '../../core/paystack-events.ts';
import { resetDb, testDb } from '../../../test/db.ts';
import { errorOf } from '../../../test/helpers.ts';
import { inHouse } from '../../../test/in-house.ts';
import { createDefaultApprovalPolicies } from '../approvals/defaults.ts';
import { processWebhookEvents } from '../payments/webhooks.ts';
import { expireHolds } from './service.ts';

// Events and spaces, second part (PRD M9-04–M9-06; M9 rule "damage deposits are a liability,
// never revenue, until settled"; M9 AC "an instalment paid to the event virtual account
// allocates to the next due instalment"; T-120).

const db = testDb();
let now: Date;
const clock = () => new Date(now);

beforeEach(async () => {
  await resetDb(db);
  now = new Date('2026-11-10T09:00:00Z');
});

type Entry = {
  kind: string;
  dueDate: string;
  amountMinor: string;
  paidMinor: string;
  status: string;
};
type ContractView = {
  contract: {
    id: string;
    number: string;
    status: string;
    totalMinor: string;
    damageDepositMinor: string;
    folio: { id: string; number: string };
    account: { accountNumber: string } | null;
    schedule: Entry[];
    overpaidMinor: string;
  } | null;
  missing: string[];
  emailed?: boolean;
};
type QuoteView = {
  currentVersion: number;
  versions: {
    version: number;
    totalMinor: string;
    netMinor: string;
    taxMinor: string;
    lines: { kind: string; amountMinor: string; description: string; minimumHire: boolean }[];
  }[];
  rates: { name: string }[];
};

const SPACE = {
  code: 'HALL',
  name: 'Marina Hall',
  setupMinutes: 60,
  cleanupMinutes: 30,
  minimumHireMinor: '50000000',
  layouts: [{ name: 'Banquet', capacity: 120 }],
  rateRules: [
    { name: 'Weekend full day', unit: 'FULL_DAY', dayType: 'WEEKEND', amountMinor: '80000000' },
    { name: 'Weekday full day', unit: 'FULL_DAY', dayType: 'WEEKDAY', amountMinor: '60000000' },
    {
      name: 'Festive',
      unit: 'FULL_DAY',
      seasonFrom: '2026-12-15',
      seasonTo: '2027-01-05',
      amountMinor: '90000000',
    },
    { name: 'Projector', unit: 'EXTRA', amountMinor: '2500000' },
  ],
};

const HIRE = { kind: 'SPACE', description: 'Hall, full day', quantity: 1, unitMinor: '80000000' };
const CATERING = { kind: 'CATERING', description: 'Buffet', quantity: 100, unitMinor: '1000000' };

async function hotel() {
  const h = await inHouse(db, clock);
  await createDefaultApprovalPolicies(db, h.org.id, h.p1.id);
  const space = await h.ok<{ id: string; layouts: { id: string }[] }>(h.gm.post('/spaces', SPACE));
  const enquiry = await h.ok<{ id: string }>(
    h.gm.post('/event-enquiries', { contactName: 'Adaeze Obi', eventType: 'Wedding' }),
  );
  const booking = await h.ok<{ id: string }>(
    h.gm.send('/event-bookings', {
      enquiryId: enquiry.id,
      spaceId: space.id,
      layoutId: space.layouts[0]?.id,
      title: 'Adaeze wedding',
      // A Saturday.
      startsAt: '2026-12-05T10:00:00Z',
      endsAt: '2026-12-05T16:00:00Z',
      expectedGuests: 100,
      holdUntil: '2026-11-20T09:00:00Z',
    }),
  );
  const at = `/event-bookings/${booking.id}`;
  const quote = (lines: object[] = [HIRE], as = h.gm) => as.send(`${at}/quotes`, { lines });
  const issueBody = (total: bigint, over: object = {}) => ({
    clientName: 'Adaeze Obi',
    clientEmail: 'adaeze@example.com',
    clientPhone: '+2348011111111',
    terms: 'Cancellation forfeits the deposit.',
    schedule: [
      { kind: 'DEPOSIT', dueDate: '2026-11-12', amountMinor: (total / 2n).toString() },
      { kind: 'INSTALMENT', dueDate: '2026-11-28', amountMinor: (total - total / 2n).toString() },
      { kind: 'DAMAGE_DEPOSIT', dueDate: '2026-12-01', amountMinor: '10000000' },
    ],
    ...over,
  });
  const quoted = async () => {
    const q = await h.ok<QuoteView>(quote());
    return BigInt(q.versions[0]?.totalMinor ?? '0');
  };
  const issue = async (over: object = {}) => {
    const total = await quoted();
    return h.ok<ContractView>(h.gm.send(`${at}/contract`, issueBody(total, over)));
  };
  const contract = () => h.ok<ContractView>(h.gm.get(`${at}/contract`));
  const sign = () =>
    h.ok(h.gm.post(`${at}/contract/sign`, { signedByName: 'Adaeze Obi', signedOn: '2026-11-10' }));
  let hookId = 1000;
  const transfer = async (account: string, amountMinor: bigint, id = hookId++) => {
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
  return {
    ...h,
    at,
    bookingId: booking.id,
    enquiryId: enquiry.id,
    quote,
    quoted,
    issueBody,
    issue,
    contract,
    sign,
    transfer,
  };
}

const accountOf = (v: ContractView) => v.contract?.account?.accountNumber ?? '';
const amounts = (v: ContractView) => v.contract?.schedule.map((s) => s.paidMinor);

describe('quotes (M9-04)', () => {
  it('builds packages, catering per head, equipment and extras, and keeps every version', async () => {
    const h = await hotel();
    await h.ok(
      h.quote([
        { kind: 'PACKAGE', description: 'Wedding package', quantity: 1, unitMinor: '60000000' },
        CATERING,
        { kind: 'EQUIPMENT', description: 'Projector', quantity: 2, unitMinor: '2500000' },
        { kind: 'EXTRA', description: 'Red carpet', quantity: 1, unitMinor: '1500000' },
      ]),
    );
    const v2 = await h.ok<QuoteView>(h.quote([HIRE]));
    expect(v2.currentVersion).toBe(2);
    expect(v2.versions.map((v) => v.version)).toEqual([2, 1]);
    const first = v2.versions[1];
    expect(first?.lines.map((l) => l.amountMinor)).toEqual([
      '60000000',
      '100000000',
      '5000000',
      '1500000',
    ]);
    expect(BigInt(first?.netMinor ?? 0) + BigInt(first?.taxMinor ?? 0)).toBe(
      BigInt(first?.totalMinor ?? -1),
    );
  });

  it('offers the prices that apply on the day of the event', async () => {
    const h = await hotel();
    const q = await h.ok<QuoteView>(h.gm.get(`${h.at}/quotes`));
    expect(q.rates.map((r) => r.name).sort()).toEqual(['Projector', 'Weekend full day']);
  });

  it('tops the hire up to the minimum, counting packages towards it', async () => {
    const h = await hotel();
    const short = await h.ok<QuoteView>(
      h.quote([{ kind: 'SPACE', description: 'Hall', quantity: 1, unitMinor: '30000000' }]),
    );
    expect(short.versions[0]?.lines.at(-1)).toMatchObject({
      kind: 'SPACE',
      minimumHire: true,
      amountMinor: '20000000',
      description: 'Minimum hire for Marina Hall',
    });
    const packaged = await h.ok<QuoteView>(
      h.quote([{ kind: 'PACKAGE', description: 'All in', quantity: 1, unitMinor: '60000000' }]),
    );
    expect(packaged.versions[0]?.lines.some((l) => l.minimumHire)).toBe(false);
  });

  it('a new version withdraws a contract nobody has acted on, and is refused after that', async () => {
    const h = await hotel();
    await h.issue();
    await h.ok(h.quote());
    expect((await h.contract()).contract).toBeNull();
    expect(await db.eventContract.count({ where: { status: 'SUPERSEDED' } })).toBe(1);

    await h.issue();
    await h.sign();
    const refused = await h.quote();
    expect(refused.status).toBe(409);
    expect(errorOf(refused).code).toBe('STATE_TRANSITION_INVALID');
  });

  it('needs event.quote', async () => {
    const h = await hotel();
    expect((await h.quote([HIRE], h.fd)).status).toBe(403);
  });
});

describe('contract and payment schedule (M9-05)', () => {
  it('issues on a dedicated virtual account and the event’s own folio, and emails the client', async () => {
    const h = await hotel();
    const v = await h.issue({ send: true });
    expect(v.emailed).toBe(true);
    expect(v.contract).toMatchObject({ number: 'EC00001', status: 'ISSUED' });
    expect(v.contract?.damageDepositMinor).toBe('10000000');
    expect(v.contract?.schedule.map((s) => s.kind)).toEqual([
      'DEPOSIT',
      'INSTALMENT',
      'DAMAGE_DEPOSIT',
    ]);
    const account = await db.virtualAccount.findFirstOrThrow({ where: { ownerType: 'EVENT' } });
    expect(account).toMatchObject({ ownerId: h.bookingId, accountNumber: accountOf(v) });
    const folio = await db.folio.findUniqueOrThrow({ where: { id: v.contract?.folio.id ?? '' } });
    expect(folio.kind).toBe('EVENT');
    expect(h.email.sent.at(-1)).toMatchObject({ to: 'adaeze@example.com', tag: 'event-contract' });
    expect(h.email.sent.at(-1)?.text).toContain(accountOf(v));
  });

  it('issuing again replaces an untouched contract and keeps its account and folio', async () => {
    const h = await hotel();
    const a = await h.issue();
    const total = BigInt(a.contract?.totalMinor ?? 0);
    const b = await h.ok<ContractView>(h.gm.send(`${h.at}/contract`, h.issueBody(total)));
    expect(b.contract?.id).not.toBe(a.contract?.id);
    expect(accountOf(b)).toBe(accountOf(a));
    expect(b.contract?.folio.id).toBe(a.contract?.folio.id);
    expect(await db.virtualAccount.count({ where: { ownerType: 'EVENT' } })).toBe(1);
  });

  it('checks the schedule against the quote and the event date', async () => {
    const h = await hotel();
    const total = await h.quoted();
    const message = async (over: object) =>
      errorOf(await h.gm.send(`${h.at}/contract`, h.issueBody(total, over))).message;
    const half = (total / 2n).toString();
    const rest = (total - total / 2n).toString();
    expect(
      await message({
        schedule: [{ kind: 'DEPOSIT', dueDate: '2026-11-12', amountMinor: half }],
      }),
    ).toContain('add up');
    expect(
      await message({
        schedule: [
          { kind: 'DEPOSIT', dueDate: '2026-11-12', amountMinor: half },
          { kind: 'DEPOSIT', dueDate: '2026-11-13', amountMinor: rest },
        ],
      }),
    ).toContain('exactly one deposit');
    expect(
      await message({
        schedule: [
          { kind: 'DEPOSIT', dueDate: '2026-11-12', amountMinor: half },
          { kind: 'INSTALMENT', dueDate: '2026-12-06', amountMinor: rest },
        ],
      }),
    ).toContain('by the event');
    expect(
      await message({
        schedule: [
          { kind: 'DEPOSIT', dueDate: '2026-11-09', amountMinor: half },
          { kind: 'INSTALMENT', dueDate: '2026-11-28', amountMinor: rest },
        ],
      }),
    ).toContain('in the past');
    expect(
      await message({
        schedule: [
          { kind: 'DEPOSIT', dueDate: '2026-11-20', amountMinor: half },
          { kind: 'INSTALMENT', dueDate: '2026-11-12', amountMinor: rest },
        ],
      }),
    ).toContain('before the instalments');
  });

  it('cannot be issued without a quote, and gives a PDF once issued', async () => {
    const h = await hotel();
    const refused = await h.gm.send(`${h.at}/contract`, h.issueBody(100n));
    expect(refused.status).toBe(409);
    await h.ok(h.gm.get(`${h.at}/contract`));
    expect((await h.gm.get(`${h.at}/contract.pdf`)).status).toBe(404);
    await h.issue();
    const pdf = await h.gm.get(`${h.at}/contract.pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
  });

  it('needs event.contract to issue', async () => {
    const h = await hotel();
    const total = await h.quoted();
    expect((await h.fd.send(`${h.at}/contract`, h.issueBody(total))).status).toBe(403);
  });
});

describe('money on the event account (M9 AC)', () => {
  it('an instalment paid to the event virtual account allocates to the next due instalment', async () => {
    const h = await hotel();
    const v = await h.issue();
    const [deposit, instalment] = (v.contract?.schedule ?? []).map((s) => BigInt(s.amountMinor));
    // The deposit first; then the next one due.
    await h.transfer(accountOf(v), deposit ?? 0n);
    expect(amounts(await h.contract())).toEqual([String(deposit), '0', '0']);
    await h.transfer(accountOf(v), 1000000n);
    const after = await h.contract();
    expect(amounts(after)).toEqual([String(deposit), '1000000', '0']);
    expect(after.contract?.schedule.map((s) => s.status)).toEqual(['PAID', 'PART_PAID', 'DUE']);
    const payments = await db.payment.findMany({ where: { folioId: v.contract?.folio.id ?? '' } });
    expect(payments).toHaveLength(2);
    expect(payments[0]?.method).toBe('VIRTUAL_ACCOUNT');
    expect(instalment).toBeGreaterThan(1000000n);
  });

  it('spills over to later instalments, and holds what is beyond the whole schedule', async () => {
    const h = await hotel();
    const v = await h.issue();
    const all = (v.contract?.schedule ?? []).reduce((s, e) => s + BigInt(e.amountMinor), 0n);
    await h.transfer(accountOf(v), all + 500n);
    const after = await h.contract();
    expect(after.contract?.schedule.every((s) => s.status === 'PAID')).toBe(true);
    expect(after.contract?.overpaidMinor).toBe('500');
    const rows = await db.eventDeposit.findMany({ orderBy: { amountMinor: 'asc' } });
    expect(rows.map((r) => r.kind).sort()).toEqual([
      'DAMAGE_DEPOSIT',
      'DEPOSIT',
      'INSTALMENT',
      'UNALLOCATED',
    ]);
  });

  it('replaying the webhook allocates once', async () => {
    const h = await hotel();
    const v = await h.issue();
    await h.transfer(accountOf(v), 1000000n, 7);
    await h.transfer(accountOf(v), 1000000n, 7);
    expect(amounts(await h.contract())).toEqual(['1000000', '0', '0']);
    expect(await db.eventDeposit.count()).toBe(1);
  });

  it('is never revenue: it is a credit on the folio, with no charge lines', async () => {
    const h = await hotel();
    const v = await h.issue();
    await h.transfer(accountOf(v), 10000000n);
    const folioId = v.contract?.folio.id ?? '';
    expect(await db.folioLine.count({ where: { folioId } })).toBe(0);
    expect(await db.payment.count({ where: { folioId } })).toBe(1);
  });

  it('cash taken at the desk on the event’s folio follows the same order', async () => {
    const h = await hotel();
    const v = await h.issue();
    await db.property.update({
      where: { id: h.p1.id },
      data: { settings: { paymentMethods: ['CASH'] } },
    });
    await h.ok(h.gm.send('/shifts', { floatMinor: '0' }));
    await h.ok(
      h.gm.send('/payments', {
        folioId: v.contract?.folio.id,
        method: 'CASH',
        amountMinor: '1000000',
      }),
    );
    expect(amounts(await h.contract())).toEqual(['1000000', '0', '0']);
  });

  it('money on a hold keeps the space until the event, and stops it being given back', async () => {
    const h = await hotel();
    const v = await h.issue();
    await h.transfer(accountOf(v), 1000000n);
    const row = await db.eventBooking.findUniqueOrThrow({ where: { id: h.bookingId } });
    expect(row.holdExpiresAt?.toISOString()).toBe('2026-12-05T10:00:00.000Z');
    now = new Date('2026-11-21T09:00:00Z');
    expect(await expireHolds(db, clock)).toBe(0);
    const gm = await h.as(h.gmId);
    const refused = await gm.post(`${h.at}/release`, {});
    expect(refused.status).toBe(409);
    const lost = await gm.put(`/event-enquiries/${h.enquiryId}`, {
      contactName: 'Adaeze Obi',
      eventType: 'Wedding',
      status: 'LOST',
      lostReason: 'Changed venue',
    });
    expect(lost.status).toBe(409);
  });

  it('a refund of event money is refused until close-out', async () => {
    const h = await hotel();
    const v = await h.issue();
    await h.transfer(accountOf(v), 1000000n);
    const payment = await db.payment.findFirstOrThrow({
      where: { folioId: v.contract?.folio.id ?? '' },
    });
    const refused = await h.gm.send(`/payments/${payment.id}/refund`, {
      amountMinor: '1000000',
      reason: 'Client asked',
    });
    expect(refused.status).toBe(409);
    expect(errorOf(refused).details?.['reason']).toBe('EVENT_MONEY');
  });

  it('a released hold voids its unpaid contract; a late transfer waits to be matched', async () => {
    const h = await hotel();
    const v = await h.issue();
    await h.ok(h.gm.post(`${h.at}/release`, {}));
    expect(await db.eventContract.count({ where: { status: 'VOID' } })).toBe(1);
    const folio = await db.folio.findUniqueOrThrow({ where: { id: v.contract?.folio.id ?? '' } });
    expect(folio.status).toBe('CLOSED');
    await h.transfer(accountOf(v), 1000000n);
    expect(await db.unmatchedTransfer.count()).toBe(1);
    expect(await db.eventDeposit.count()).toBe(0);
  });

  it('a hold running out voids its unpaid contract too', async () => {
    const h = await hotel();
    await h.issue();
    now = new Date('2026-11-21T09:00:00Z');
    expect(await expireHolds(db, clock)).toBe(1);
    expect(await db.eventContract.count({ where: { status: 'VOID' } })).toBe(1);
  });
});

describe('confirming (M9-06)', () => {
  async function coordinator(h: Awaited<ReturnType<typeof hotel>>) {
    return h.as((await h.person('event-coordinator', h.p1.id)).id);
  }

  it('is refused until the contract is signed and the deposit paid, and says what is missing', async () => {
    const h = await hotel();
    const none = await h.gm.send(`${h.at}/confirm`, {});
    expect(none.status).toBe(409);
    expect(errorOf(none).details?.['missing']).toEqual(['NO_CONTRACT', 'DEPOSIT_NOT_PAID']);
    const v = await h.issue();
    expect(v.missing).toEqual(['NOT_SIGNED', 'DEPOSIT_NOT_PAID']);
    await h.sign();
    const unpaid = await h.gm.send(`${h.at}/confirm`, {});
    expect(errorOf(unpaid).details?.['missing']).toEqual(['DEPOSIT_NOT_PAID']);
  });

  it('confirms when the rules are met, and the enquiry is won', async () => {
    const h = await hotel();
    const v = await h.issue();
    await h.sign();
    await h.transfer(accountOf(v), BigInt(v.contract?.schedule[0]?.amountMinor ?? 0));
    expect((await h.contract()).missing).toEqual([]);
    const done = await h.ok<{
      status: string;
      holdExpiresAt: string | null;
      confirmedByOverride: boolean;
    }>(h.gm.send(`${h.at}/confirm`, {}));
    expect(done).toMatchObject({
      status: 'CONFIRMED',
      holdExpiresAt: null,
      confirmedByOverride: false,
    });
    const enquiry = await db.eventEnquiry.findUniqueOrThrow({ where: { id: h.enquiryId } });
    expect(enquiry.status).toBe('WON');
    expect((await h.gm.send(`${h.at}/confirm`, {})).status).toBe(409);
  });

  it('a part-paid deposit does not meet the rule', async () => {
    const h = await hotel();
    const v = await h.issue();
    await h.sign();
    await h.transfer(accountOf(v), BigInt(v.contract?.schedule[0]?.amountMinor ?? 0) - 1n);
    expect((await h.contract()).missing).toEqual(['DEPOSIT_NOT_PAID']);
  });

  it('an override asks a manager, and confirms once approved', async () => {
    const h = await hotel();
    const c = await coordinator(h);
    const asked = await c.send(`${h.at}/confirm`, { override: true, reason: 'Government client' });
    expect(asked.status).toBe(202);
    const { approvalRequestId } = asked.body as { approvalRequestId: string };
    expect((await db.eventBooking.findUniqueOrThrow({ where: { id: h.bookingId } })).status).toBe(
      'HOLD',
    );
    await h.gm.post(`/approvals/${approvalRequestId}/approve`, {}).expect(200);
    const row = await db.eventBooking.findUniqueOrThrow({ where: { id: h.bookingId } });
    expect(row).toMatchObject({ status: 'CONFIRMED', confirmedByOverride: true });
    const audit = await db.auditEvent.findFirstOrThrow({
      where: { action: 'event_booking.confirmed' },
    });
    expect(audit).toMatchObject({ approvalRequestId, reason: 'Government client' });
  });

  it('an override needs a reason; a manager’s own goes straight through', async () => {
    const h = await hotel();
    expect((await h.gm.send(`${h.at}/confirm`, { override: true })).status).toBe(400);
    const done = await h.ok<{ status: string; confirmedByOverride: boolean }>(
      h.gm.send(`${h.at}/confirm`, { override: true, reason: 'Long-standing client' }),
    );
    expect(done).toMatchObject({ status: 'CONFIRMED', confirmedByOverride: true });
  });

  it('a hold that has run out cannot be confirmed', async () => {
    const h = await hotel();
    now = new Date('2026-11-21T09:00:00Z');
    const gm = await h.as(h.gmId);
    const refused = await gm.send(`${h.at}/confirm`, { override: true, reason: 'Too late' });
    expect(refused.status).toBe(409);
  });

  it('needs event.confirm', async () => {
    const h = await hotel();
    expect((await h.fd.send(`${h.at}/confirm`, {})).status).toBe(403);
  });
});
