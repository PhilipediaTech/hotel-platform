import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../test/db.ts';
import { errorOf } from '../../../test/helpers.ts';
import { hotelClient, makeHotel } from '../../../test/hotel.ts';
import { sessionCookie } from '../../../test/tenancy.ts';

// Migration imports (PRD M1-03 "guests, companies and opening balances"; Versions V2 "stronger
// migration"; T-168): the hotel's guest list, its corporate and agent accounts, and what each
// company owed at go-live, from the old system's spreadsheets.

const db = testDb();
let now: Date;
const clock = () => new Date(now);

beforeEach(async () => {
  await resetDb(db);
  now = new Date('2026-11-10T09:00:00Z');
});

type Job = {
  id: string;
  status: string;
  report: {
    total: number;
    errorCount: number;
    errors: { row: number | null; column: string | null; message: string }[];
    summary: Record<string, number>;
    applied: Record<string, number> | null;
  };
};

async function hotel() {
  const h = await makeHotel(db, now);
  const c = hotelClient(db, clock, h.p1.id);
  const as = async (userId: string) => c.as(await sessionCookie(db, userId, clock));
  const gm = await as(h.gm.id);
  const upload = async (body: string, by = h.gm.id) => {
    const bytes = Buffer.from(body);
    const id = crypto.randomUUID();
    const storageKey = `org/${h.org.id}/property/${h.p1.id}/${id}`;
    await db.fileObject.create({
      data: {
        id,
        organisationId: h.org.id,
        propertyId: h.p1.id,
        storageKey,
        contentType: 'text/csv',
        sizeBytes: bytes.length,
        scan: 'CLEAN',
        entityType: 'ImportJob',
        uploadedById: by,
      },
    });
    await c.files.put(storageKey, bytes, 'text/csv');
    return id;
  };
  const check = async (kind: string, lines: string[], as = gm) => {
    const res = await as.post('/imports', { kind, fileId: await upload(lines.join('\n')) });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as Job;
  };
  const apply = async (job: Job, as = gm) => {
    const res = await as.post(`/imports/${job.id}/apply`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body as Job;
  };
  return { ...h, as, gm, upload, check, apply };
}

const GUESTS = 'first_name,last_name,email,phone,nationality,notes,tags,marketing_consent,vip';
const COMPANIES =
  'name,kind,tax_id,contact_name,contact_phone,contact_email,invoice_email,credit_limit,payment_terms_days,commission_percent';
const BALANCES = 'company_name,reference,amount,issued_on,due_on';

describe('guests', () => {
  it('adds new guests, leaves ones already here, and reports bad rows', async () => {
    const h = await hotel();
    await db.guest.create({
      data: { organisationId: h.org.id, firstName: 'Ada', lastName: 'Obi', email: 'ada@x.test' },
    });
    const bad = await h.check('GUESTS', [
      GUESTS,
      'Ada,Obi,ADA@x.test,,NG,,,yes,',
      'Tunde,Bakare,,0803 123 4567,,Likes a quiet room,Repeat; Business,,yes',
      'Kemi,Ojo,kemi@x.test,08031234567,GH,,,,',
      ',Nameless,,,,,,,',
      'Bola,Ade,not-an-email,12,Nigeria,,,maybe,',
    ]);
    expect(bad.status).toBe('FAILED');
    expect(bad.report.errors).toEqual([
      { row: 4, column: 'phone', message: 'The same phone as row 3' },
      { row: 5, column: 'first_name', message: 'Required' },
      { row: 6, column: 'email', message: 'Not an email address' },
      expect.objectContaining({ row: 6, column: 'phone' }),
      expect.objectContaining({ row: 6, column: 'nationality' }),
      expect.objectContaining({ row: 6, column: 'marketing_consent' }),
    ]);
    expect(await db.guest.count()).toBe(1);

    const good = await h.check('GUESTS', [
      GUESTS,
      'Ada,Obi,ADA@x.test,,NG,,,yes,',
      'Tunde,Bakare,,0803 123 4567,,Likes a quiet room,Repeat; Business,yes,yes',
      'Kemi,Ojo,kemi@x.test,,GH,,,,',
    ]);
    expect(good.status).toBe('VALIDATED');
    expect(good.report.summary).toEqual({ guestsNew: 2, guestsExisting: 1 });
    const applied = await h.apply(good);
    expect(applied.report.applied).toEqual({ guestsWritten: 2 });
    const tunde = await db.guest.findFirstOrThrow({ where: { lastName: 'Bakare' } });
    expect(tunde).toMatchObject({
      phone: '+2348031234567',
      vip: true,
      marketingConsent: true,
      consentAt: now,
      preferences: { notes: 'Likes a quiet room', tags: ['Repeat', 'Business'] },
    });
    expect(await db.guest.count({ where: { email: 'ada@x.test' } })).toBe(1);
    const audit = await db.auditEvent.findFirstOrThrow({ where: { action: 'import.applied' } });
    expect(audit.after).toMatchObject({ kind: 'GUESTS', guestsWritten: 2 });
  });

  it('marks VIPs only for a role that may flag guests', async () => {
    const h = await hotel();
    const role = await db.role.create({
      data: { organisationId: h.org.id, name: 'Importer', permissions: ['import.run'] },
    });
    const clerk = await h.person('front-desk', h.p1.id);
    await db.membership.updateMany({ where: { userId: clerk.id }, data: { roleId: role.id } });
    const as = await h.as(clerk.id);
    const job = await h.check('GUESTS', [GUESTS, 'Tunde,Bakare,,,,,,,yes'], as);
    expect(job.report.errors).toEqual([
      { row: 2, column: 'vip', message: 'Your role can’t mark guests as VIP' },
    ]);
  });
});

describe('companies and opening balances', () => {
  it('adds companies, then what they owed, as open invoices on the city ledger', async () => {
    const h = await hotel();
    const companies = await h.check('COMPANIES', [
      COMPANIES,
      'Dangote Group,company,12345678-0001,Bola Ade,08031234567,bola@x.test,accounts@x.test,"2,000,000",45,',
      'Wakanow,travel agent,,Kemi Ojo,,kemi@x.test,,,,10%',
      'dangote  group,,,,,,,,,',
      'Nobody Ltd,charity,,,0803,,,,,',
    ]);
    expect(companies.report.errors).toEqual([
      { row: 4, column: 'name', message: 'The same company as row 2' },
      { row: 5, column: 'kind', message: 'Use company or travel agent' },
      expect.objectContaining({ row: 5, column: 'contact_phone' }),
    ]);
    const ok = await h.check('COMPANIES', [
      COMPANIES,
      'Dangote Group,company,12345678-0001,Bola Ade,08031234567,bola@x.test,accounts@x.test,"2,000,000",45,',
      'Wakanow,travel agent,,Kemi Ojo,,kemi@x.test,,,,10%',
    ]);
    expect(ok.report.summary).toEqual({ companiesNew: 2 });
    await h.apply(ok);
    const dangote = await db.company.findFirstOrThrow({ where: { name: 'Dangote Group' } });
    expect(dangote).toMatchObject({
      kind: 'COMPANY',
      taxId: '12345678-0001',
      creditLimitMinor: 200_000_000n,
      paymentTermsDays: 45,
      contacts: [{ name: 'Bola Ade', role: null, phone: '+2348031234567', email: 'bola@x.test' }],
      billingInstructions: { invoiceEmail: 'accounts@x.test', notes: null },
    });
    expect((await db.company.findFirstOrThrow({ where: { name: 'Wakanow' } })).commissionBps).toBe(
      1000,
    );
    // Once only.
    const again = await h.check('COMPANIES', [COMPANIES, 'Wakanow,travel agent,,,,,,,,']);
    expect(again.report.errors[0]?.message).toBe('Wakanow is already a company here');

    const balances = await h.check('BALANCES', [
      BALANCES,
      'Dangote Group,INV-2041,450000,2026-10-15,',
      'DANGOTE GROUP,INV-2077,"1,250,000.50",01/11/2026,2026-11-20',
      'Wakanow,TA-9,100000,,',
      'Unknown Ltd,X-1,5000,,',
      'Wakanow,TA-9,100000,,',
      'Wakanow,TA-10,100000,2026-12-01,',
    ]);
    expect(balances.report.errors).toEqual([
      { row: 5, column: 'company_name', message: 'No company or travel agent called Unknown Ltd' },
      { row: 6, column: 'reference', message: 'The same reference as row 4' },
      { row: 7, column: 'issued_on', message: 'An opening balance is from before today' },
    ]);
    const fine = await h.check('BALANCES', [
      BALANCES,
      'Dangote Group,INV-2041,450000,2026-10-15,',
      'DANGOTE GROUP,INV-2077,"1,250,000.50",01/11/2026,2026-11-20',
      'Wakanow,TA-9,100000,,',
    ]);
    expect(fine.report.summary).toEqual({
      invoicesNew: 3,
      companiesWithBalances: 2,
      accountsNew: 2,
    });
    const done = await h.apply(fine);
    expect(done.report.applied).toEqual({ invoicesWritten: 3, accountsOpened: 2 });
    const account = await db.arAccount.findFirstOrThrow({
      where: { companyId: dangote.id },
      include: { invoices: { orderBy: { number: 'asc' } } },
    });
    // The company's group limit and terms carry over to its account here.
    expect(account).toMatchObject({ creditLimitMinor: 200_000_000n, termsDays: 45 });
    expect(
      account.invoices.map((i) => [i.number, i.amountMinor, i.issuedOn, i.dueOn, i.folioId]),
    ).toEqual([
      ['OB-INV-2041', 45_000_000n, new Date('2026-10-15'), new Date('2026-11-29'), null],
      ['OB-INV-2077', 125_000_050n, new Date('2026-11-01'), new Date('2026-11-20'), null],
    ]);
    const wakanow = await db.arAccount.findFirstOrThrow({
      where: { company: { name: 'Wakanow' } },
      include: { invoices: true },
    });
    // No group limit: 0, so new charges to the account need approval; 30 days' terms.
    expect(wakanow).toMatchObject({ creditLimitMinor: 0n, termsDays: 30 });
    expect(wakanow.invoices[0]).toMatchObject({
      issuedOn: new Date('2026-11-10'),
      dueOn: new Date('2026-12-10'),
    });

    // The statement and ageing see them.
    const statement = await h.gm.get(
      `/ar-accounts/${account.id}/statement?from=2026-10-01&to=2026-11-30`,
    );
    expect(statement.status, JSON.stringify(statement.body)).toBe(200);
    expect(
      (statement.body as { lines: { reference: string; description: string }[] }).lines,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reference: 'OB-INV-2041',
          description: 'Brought forward from before go-live',
        }),
      ]),
    );

    // The same file again is refused: nothing counts twice.
    const twice = await h.check('BALANCES', [
      BALANCES,
      'Dangote Group,INV-2041,450000,2026-10-15,',
    ]);
    expect(twice.report.errors[0]?.message).toBe('INV-2041 was imported before');
  });

  it('needs the city ledger permission for opening balances', async () => {
    const h = await hotel();
    await db.company.create({
      data: { organisationId: h.org.id, kind: 'COMPANY', name: 'Dangote Group' },
    });
    const role = await db.role.create({
      data: { organisationId: h.org.id, name: 'Importer', permissions: ['import.run'] },
    });
    const clerk = await h.person('front-desk', h.p1.id);
    await db.membership.updateMany({ where: { userId: clerk.id }, data: { roleId: role.id } });
    const as = await h.as(clerk.id);
    const res = await as.post('/imports', {
      kind: 'BALANCES',
      fileId: await h.upload([BALANCES, 'Dangote Group,INV-1,1000,,'].join('\n'), clerk.id),
    });
    expect(res.status).toBe(403);
    expect(errorOf(res).details).toEqual({ permission: 'ar.manage' });
    expect(await db.arInvoice.count()).toBe(0);
  });
});
