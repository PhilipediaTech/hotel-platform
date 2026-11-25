import { createHash } from 'node:crypto';
import type { Config } from './config.ts';

// E-invoicing (PRD M4-24; Strategy §7.6; T-160). Nigeria's Revenue Service takes invoices through
// accredited providers (the Merchant Buyer Solution); the provider answers with the invoice
// reference number (IRN) and the data for the QR code printed on the invoice. Every provider sits
// behind this adapter (ADR-013): `off` until one is chosen, `fake` locally and in tests. The
// document is provider-neutral; a real provider maps it to its own format.

/** One invoice as sent: what was sold, to whom, with its taxes. Amounts in minor units. */
export interface EinvoiceDocument {
  invoiceNumber: string;
  issueDate: string;
  currency: string;
  seller: { name: string; tin: string; vatNumber: string | null; address: string | null };
  buyer: { kind: 'COMPANY' | 'INDIVIDUAL'; name: string; tin: string | null };
  lines: {
    description: string;
    quantity: number;
    unitAmountMinor: string;
    /** The line before tax (negative for a discount or a voided charge). */
    netMinor: string;
  }[];
  taxes: { name: string; rateBps: number | null; amountMinor: string }[];
  totals: { netMinor: string; taxMinor: string; totalMinor: string };
}

export type EinvoiceResult =
  { outcome: 'ACCEPTED'; irn: string; qrData: string } | { outcome: 'REJECTED'; reasons: string[] };

/** The provider couldn't be reached or failed: try again later. */
export class EinvoiceUnavailableError extends Error {
  constructor(message = 'The e-invoicing provider is unavailable') {
    super(message);
    this.name = 'EinvoiceUnavailableError';
  }
}

export interface EinvoiceProvider {
  /** OFF: no provider; nothing can be sent. */
  readonly name: string;
  /** Sends one invoice. `key` is the same on every try of it, so a provider never files it twice. */
  submit(doc: EinvoiceDocument, key: string): Promise<EinvoiceResult>;
}

export function createOffEinvoiceProvider(): EinvoiceProvider {
  return {
    name: 'OFF',
    submit: () => Promise.reject(new EinvoiceUnavailableError('No e-invoicing provider is set up')),
  };
}

export interface FakeEinvoiceProvider extends EinvoiceProvider {
  /** What was sent, in order (each try). */
  readonly sent: { doc: EinvoiceDocument; key: string }[];
  /** The next submission is rejected with these reasons. */
  rejectNext(reasons: string[]): void;
  /** The next submissions (default 1) find the provider down. */
  failNext(times?: number): void;
}

/**
 * Accepts everything unless told otherwise. The IRN is the same for the same key, as a real
 * provider answers a repeated submission with the reference it gave the first time.
 */
export function createFakeEinvoiceProvider(): FakeEinvoiceProvider {
  const sent: { doc: EinvoiceDocument; key: string }[] = [];
  let reject: string[] | null = null;
  let failures = 0;
  return {
    name: 'FAKE',
    sent,
    rejectNext(reasons) {
      reject = reasons;
    },
    failNext(times = 1) {
      failures = times;
    },
    submit(doc, key) {
      sent.push({ doc, key });
      if (failures > 0) {
        failures -= 1;
        return Promise.reject(new EinvoiceUnavailableError());
      }
      if (reject) {
        const reasons = reject;
        reject = null;
        return Promise.resolve({ outcome: 'REJECTED', reasons });
      }
      const hash = createHash('sha256').update(key).digest('hex').slice(0, 8).toUpperCase();
      const irn = `${doc.invoiceNumber}-${hash}-${doc.issueDate.replaceAll('-', '')}`;
      return Promise.resolve({
        outcome: 'ACCEPTED',
        irn,
        qrData: `https://einvoice.test/verify?irn=${encodeURIComponent(irn)}`,
      });
    },
  };
}

export function createEinvoiceProvider(config: Pick<Config, 'einvoice'>): EinvoiceProvider {
  return config.einvoice.provider === 'fake'
    ? createFakeEinvoiceProvider()
    : createOffEinvoiceProvider();
}
