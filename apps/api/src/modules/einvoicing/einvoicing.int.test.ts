import type { Response } from 'superagent';
import { inflateSync } from 'node:zlib';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../test/db.ts';
import { errorOf } from '../../../test/helpers.ts';
import { inHouse } from '../../../test/in-house.ts';
import { createFakeEinvoiceProvider, type EinvoiceDocument } from '../../core/einvoice.ts';
import { sendQueued } from './service.ts';

// E-invoicing (PRD M4-24; Strategy §7.6; T-160). Ada Obi stays in room 101 with a room charge
// (taxed) on her own bill and a conference room on Dangote Group's; once the folio is settled,
// finance sends both invoices, the worker passes them to the (fake) provider, and the printed
// invoice carries the reference number.

const db = testDb();
let now: Date;
const clock = () => new Date(now);

beforeEach(async () => {
  await resetDb(db);
  now = new Date('2026-11-10T09:00:00Z');
});

type Item = {
  folioId: string;
  windowNumber: number;
  invoiceNumber: string;
  billTo: string;
  buyerTin: string | null;
  totalMinor: string;
  status: string;
  irn: string | null;
  reasons: string[];
  attempts: number;
  submittedBy: string | null;
};
type List = { data: Item[]; counts: Record<string, number> };
type Settings = { enabled: boolean; providerReady: boolean; sellerTin: string | null };

const binary = (res: Response, done: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => done(null, Buffer.concat(chunks)));
};

/** The text drawn on a PDF: its streams inflated, the hex strings of each TJ joined. */
function pdfText(pdf: Buffer): string {
  const raw = pdf.toString('latin1');
  let text = '';
  for (const m of raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    let body: string;
    try {
      body = inflateSync(Buffer.from(m[1] ?? '', 'latin1')).toString('latin1');
    } catch {
      continue;
    }
    for (const tj of body.matchAll(/\[(.*?)\] TJ/g)) {
      const hex = [...(tj[1] ?? '').matchAll(/<([0-9a-f]*)>/gi)].map((h) => h[1]).join('');
      text += `${Buffer.from(hex, 'hex').toString('latin1')}\n`;
    }
  }
  return text;
}

async function hotel() {
  const h = await inHouse(db, clock);
  await db.property.update({
    where: { id: h.p1.id },
    data: { taxRegistration: { tin: '12345678-0001', vatNumber: 'VAT-778' } },
  });
  await db.company.update({ where: { id: h.company.id }, data: { taxId: '87654321-0001' } });
  await db.folioWindow.create({
    data: { folioId: h.folioId, number: 2, payerType: 'COMPANY', companyId: h.company.id },
  });
  await h.ok(
    h.charge({ revenueCode: 'ROOM', description: 'Room 101', unitAmountMinor: '10000000' }),
  );
  await h.ok(
    h.charge({
      windowNumber: 2,
      revenueCode: 'ROOM',
      description: 'Conference room',
      unitAmountMinor: '5000000',
    }),
  );
  const finance = await h.as(h.finance.id);
  const provider = createFakeEinvoiceProvider();
  const settle = () => db.folio.update({ where: { id: h.folioId }, data: { status: 'SETTLED' } });
  const list = (status?: string) =>
    h.ok<List>(finance.get(`/einvoices${status ? `?status=${status}` : ''}`));
  const submit = (windowNumber = 1, as = finance) =>
    as.send(`/folios/${h.folioId}/windows/${windowNumber}/einvoice`, {});
  const send = () => sendQueued(db, clock, provider);
  const switchOn = () => h.ok<Settings>(h.gm.put('/einvoicing/settings', { enabled: true }));
  return { ...h, financeSession: finance, provider, settle, list, submit, send, switchOn };
}

describe('switching e-invoicing on (M4-24)', () => {
  it('needs the hotel’s TIN, and only those who manage taxes switch it', async () => {
    const h = await hotel();
    expect(await h.ok<Settings>(h.financeSession.get('/einvoicing/settings'))).toEqual({
      enabled: false,
      providerReady: true,
      sellerTin: '12345678-0001',
      enabledAt: null,
    });
    // The front desk neither switches it on nor sees it.
    expect((await h.fd.put('/einvoicing/settings', { enabled: true })).status).toBe(403);
    expect((await h.fd.get('/einvoicing/settings')).status).toBe(403);
    await db.property.update({ where: { id: h.p1.id }, data: { taxRegistration: {} } });
    const noTin = await h.gm.put('/einvoicing/settings', { enabled: true });
    expect(noTin.status).toBe(409);
    expect(errorOf(noTin).message).toBe('Add the hotel’s TIN to its tax registration first');
    await db.property.update({
      where: { id: h.p1.id },
      data: { taxRegistration: { tin: '12345678-0001' } },
    });
    expect(await h.switchOn()).toMatchObject({ enabled: true, enabledAt: '2026-11-10T09:00:00Z' });
    // Off: nothing can be sent.
    await h.ok(h.gm.put('/einvoicing/settings', { enabled: false }));
    await h.settle();
    const off = await h.submit();
    expect(off.status).toBe(409);
    expect(errorOf(off).message).toBe('E-invoicing is off for this property');
  });
});

describe('sending invoices (M4-24)', () => {
  it('lists settled invoices, queues them, and the worker keeps the reference', async () => {
    const h = await hotel();
    await h.switchOn();
    // Still open: nothing to send yet.
    expect((await h.list()).counts.NOT_SENT).toBe(0);
    const open = await h.submit();
    expect(open.status).toBe(409);
    expect(errorOf(open).message).toBe(
      'The folio is still open: send its invoice once it is settled',
    );

    await h.settle();
    const waiting = await h.list('NOT_SENT');
    expect(waiting.data.map((i) => [i.invoiceNumber.endsWith('-2'), i.billTo, i.buyerTin])).toEqual(
      [
        [false, 'Ada Obi', null],
        [true, 'Dangote Group', '87654321-0001'],
      ],
    );

    const queued = await h.ok<Item>(h.submit());
    expect(queued).toMatchObject({ status: 'QUEUED', attempts: 0, irn: null });
    expect(queued.submittedBy).toBeTruthy();
    const again = await h.submit();
    expect(again.status).toBe(409);
    expect(errorOf(again).message).toBe('This invoice is being sent');

    await h.ok(h.submit(2));
    expect(await h.send()).toBe(2);
    // What went: seller, buyer, the charges before tax, and the taxes apart.
    const company = h.provider.sent.find((s) => s.doc.buyer.kind === 'COMPANY')
      ?.doc as EinvoiceDocument;
    expect(company).toMatchObject({
      issueDate: '2026-11-10',
      currency: 'NGN',
      seller: { tin: '12345678-0001', vatNumber: 'VAT-778' },
      buyer: { kind: 'COMPANY', name: 'Dangote Group', tin: '87654321-0001' },
      lines: [{ description: 'Conference room', quantity: 1, netMinor: '5000000' }],
    });
    expect(company.taxes.length).toBeGreaterThan(0);
    expect(BigInt(company.totals.netMinor) + BigInt(company.totals.taxMinor)).toBe(
      BigInt(company.totals.totalMinor),
    );
    const totalTaxes = company.taxes.reduce((s, t) => s + BigInt(t.amountMinor), 0n);
    expect(totalTaxes.toString()).toBe(company.totals.taxMinor);

    const accepted = await h.list('ACCEPTED');
    expect(accepted.data).toHaveLength(2);
    const mine = accepted.data.find((i) => i.windowNumber === 1) as Item;
    expect(mine.irn).toMatch(/^.+-[0-9A-F]{8}-20261110$/);
    expect(accepted.counts).toMatchObject({ NOT_SENT: 0, ACCEPTED: 2, QUEUED: 0 });
    const done = await h.submit();
    expect(errorOf(done).message).toBe('The tax authority has this invoice already');
    const audit = await db.auditEvent.findMany({
      where: { action: { startsWith: 'einvoice.' } },
      orderBy: { id: 'asc' },
    });
    expect(audit.map((a) => a.action)).toEqual([
      'einvoice.settings_updated',
      'einvoice.submitted',
      'einvoice.submitted',
      'einvoice.accepted',
      'einvoice.accepted',
    ]);

    // The printed invoice carries the reference.
    const pdf = await h.financeSession
      .get(`/folios/${h.folioId}/invoice.pdf`)
      .buffer(true)
      .parse(binary);
    expect(pdf.status).toBe(200);
    const text = pdfText(pdf.body as Buffer);
    expect(text).toContain('E-invoice ref.');
    expect(text).toContain(mine.irn);
  });

  it('a rejection shows the reasons, and the invoice can be sent again', async () => {
    const h = await hotel();
    await h.switchOn();
    await h.settle();
    h.provider.rejectNext(['Buyer TIN not found']);
    await h.ok(h.submit(2));
    await h.send();
    const [rejected] = (await h.list('REJECTED')).data;
    expect(rejected).toMatchObject({ status: 'REJECTED', reasons: ['Buyer TIN not found'] });

    await db.company.update({ where: { id: h.company.id }, data: { taxId: '11112222-0001' } });
    now = new Date('2026-11-10T10:00:00Z');
    expect((await h.ok<Item>(h.submit(2))).status).toBe('QUEUED');
    await h.send();
    const [sent] = (await h.list('ACCEPTED')).data;
    expect(sent).toMatchObject({ buyerTin: '11112222-0001', reasons: [] });
    // A new key for the new sending, so the provider takes the corrected invoice.
    const [first, second] = h.provider.sent;
    expect(second?.key).not.toBe(first?.key);
    expect(second?.doc.buyer.tin).toBe('11112222-0001');
  });

  it('retries while the provider is down, then fails; the same key on every try', async () => {
    const h = await hotel();
    await h.switchOn();
    await h.settle();
    await h.ok(h.submit());
    h.provider.failNext(10);
    await h.send();
    let [row] = await db.einvoiceSubmission.findMany();
    expect(row).toMatchObject({ status: 'QUEUED', attempts: 1 });
    expect(row?.nextAttemptAt?.toISOString()).toBe('2026-11-10T09:01:00.000Z');
    // Not due yet: nothing goes.
    expect(await h.send()).toBe(0);
    for (let i = 0; i < 5; i += 1) {
      now = new Date(now.getTime() + 13 * 3_600_000);
      await h.send();
    }
    [row] = await db.einvoiceSubmission.findMany();
    expect(row).toMatchObject({ status: 'FAILED', attempts: 6, nextAttemptAt: null });
    expect(new Set(h.provider.sent.map((s) => s.key)).size).toBe(1);
    // Days later: signed in again; sent again once the provider is back.
    const finance = await h.as(h.finance.id);
    const counts = async () => (await h.ok<List>(finance.get('/einvoices'))).counts;
    expect((await counts()).FAILED).toBe(1);
    h.provider.failNext(0);
    await h.ok(h.submit(1, finance));
    await h.send();
    expect((await counts()).ACCEPTED).toBe(1);
  });

  it('refuses an invoice with no charges and a window the folio doesn’t have', async () => {
    const h = await hotel();
    await h.switchOn();
    await db.folioWindow.create({ data: { folioId: h.folioId, number: 3, payerType: 'GUEST' } });
    await h.settle();
    const empty = await h.submit(3);
    expect(errorOf(empty).message).toBe('This invoice has no charges');
    expect((await h.submit(5)).status).toBe(404);
    // The front desk can't send invoices.
    expect((await h.submit(1, h.fd)).status).toBe(403);
  });
});
