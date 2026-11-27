import type { SignUpCountry } from './countries.ts';
import { SIGN_UP_COUNTRIES } from './countries.ts';
import type { ID_TYPES } from './registration.ts';

// Country packs (PRD M14-09; T-111): what changes when a hotel group trades outside Nigeria.
// A pack holds defaults only. The notices name the local law in plain words and need a local
// lawyer's review before a first sale in that country.
//
// Second country pack (Versions V2; T-174, Philip 2026-11-27): the United Kingdom, Kenya and
// Uganda carry suggested taxes, researched November 2026 and approved by Philip, which a hotel
// adds in one click from tax settings and then confirms as usual. Percentages only: fixed
// nightly charges (Uganda's Local Hotel Tax, Welsh levies) and city levies are named in
// taxNotes and posted by the hotel. Philip's tax adviser checks them before a first sale.

type IdType = (typeof ID_TYPES)[number];

/** The income codes every property starts with (tax/defaults.ts). */
export const SUGGESTED_TAX_INCOME_CODES = ['ROOM', 'FNB', 'MISC'] as const;

export interface SuggestedTax {
  /** The tax line's revenue code, e.g. "VAT". */
  code: string;
  name: string;
  authority: string;
  /** Basis points: 1600 = 16%. */
  rateBps: number;
  /** On the line's net, applied in this order. */
  sequence: number;
  /** Inside the price (the UK's VAT-inclusive prices) rather than added on top. */
  inclusive: boolean;
  /** The income codes that carry it. */
  appliesTo: readonly (typeof SUGGESTED_TAX_INCOME_CODES)[number][];
}

export interface CountryPack {
  name: string;
  currency: string;
  timeZone: string;
  locale: string;
  /** The ID documents offered at check-in. */
  idTypes: readonly IdType[];
  /** How guests pay online through the platform's provider, in the words staff see. */
  paymentMethods: readonly string[];
  idRetentionMonths: number;
  /** Languages the pack targets; the app's strings exist in English today. */
  languages: readonly string[];
  /** Shown to the desk when ID details are taken. */
  dataProtectionNotice: string;
  /** Taxes a hotel can add in one click; empty where the hotel enters its own. */
  suggestedTaxes: readonly SuggestedTax[];
  /** Local charges the suggestions leave out, in plain words. */
  taxNotes: string | null;
}

const ALL = SUGGESTED_TAX_INCOME_CODES;

export const COUNTRY_PACKS: Record<SignUpCountry, CountryPack> = {
  NG: {
    ...SIGN_UP_COUNTRIES.NG,
    idTypes: ['PASSPORT', 'NATIONAL_ID', 'DRIVERS_LICENCE', 'VOTERS_CARD', 'OTHER'],
    paymentMethods: ['Card', 'Bank transfer', 'USSD'],
    idRetentionMonths: 12,
    languages: ['en'],
    dataProtectionNotice:
      'ID details are held under the Nigeria Data Protection Act 2023, stored encrypted and deleted after the hotel’s retention period.',
    suggestedTaxes: [],
    taxNotes: null,
  },
  GH: {
    ...SIGN_UP_COUNTRIES.GH,
    idTypes: ['PASSPORT', 'NATIONAL_ID', 'DRIVERS_LICENCE', 'VOTERS_CARD', 'OTHER'],
    paymentMethods: ['Card', 'Mobile money'],
    idRetentionMonths: 12,
    languages: ['en'],
    dataProtectionNotice:
      'ID details are held under Ghana’s Data Protection Act 2012, stored encrypted and deleted after the hotel’s retention period.',
    suggestedTaxes: [],
    taxNotes: null,
  },
  KE: {
    ...SIGN_UP_COUNTRIES.KE,
    idTypes: ['PASSPORT', 'NATIONAL_ID', 'DRIVERS_LICENCE', 'OTHER'],
    paymentMethods: ['Card', 'M-Pesa'],
    idRetentionMonths: 12,
    languages: ['en', 'sw'],
    dataProtectionNotice:
      'ID details are held under Kenya’s Data Protection Act 2019, stored encrypted and deleted after the hotel’s retention period.',
    suggestedTaxes: [
      {
        code: 'VAT',
        name: 'VAT',
        authority: 'KRA',
        rateBps: 1600,
        sequence: 1,
        inclusive: false,
        appliesTo: ALL,
      },
      {
        code: 'TL',
        name: 'Tourism levy',
        authority: 'Tourism Fund',
        rateBps: 200,
        sequence: 2,
        inclusive: false,
        appliesTo: ['ROOM', 'FNB'],
      },
    ],
    taxNotes:
      'The 2% tourism levy (formerly the catering levy) is on room, food and drink sales and is paid to the Tourism Fund by the 10th of each month. A service charge, if your hotel adds one, is yours to set.',
  },
  ZA: {
    ...SIGN_UP_COUNTRIES.ZA,
    idTypes: ['PASSPORT', 'NATIONAL_ID', 'DRIVERS_LICENCE', 'OTHER'],
    paymentMethods: ['Card', 'EFT'],
    idRetentionMonths: 12,
    languages: ['en'],
    dataProtectionNotice:
      'ID details are held under South Africa’s POPIA, stored encrypted and deleted after the hotel’s retention period.',
    suggestedTaxes: [],
    taxNotes: null,
  },
  UG: {
    ...SIGN_UP_COUNTRIES.UG,
    idTypes: ['PASSPORT', 'NATIONAL_ID', 'DRIVERS_LICENCE', 'OTHER'],
    paymentMethods: ['Card', 'Mobile money'],
    idRetentionMonths: 12,
    languages: ['en'],
    dataProtectionNotice:
      'ID details are held under Uganda’s Data Protection and Privacy Act 2019, stored encrypted and deleted after the hotel’s retention period.',
    suggestedTaxes: [
      {
        code: 'VAT',
        name: 'VAT',
        authority: 'URA',
        rateBps: 1800,
        sequence: 1,
        inclusive: false,
        appliesTo: ALL,
      },
    ],
    taxNotes:
      'Local Hotel Tax is a fixed charge per room per night, paid by the guest and passed to KCCA or the municipal or town council each month: US$2 at four- and five-star hotels, otherwise UGX 2,000, 1,000 or 500 depending on the room price. It is not a percentage, so post it as a nightly charge.',
  },
  GB: {
    ...SIGN_UP_COUNTRIES.GB,
    idTypes: ['PASSPORT', 'NATIONAL_ID', 'DRIVERS_LICENCE', 'OTHER'],
    paymentMethods: ['Card', 'Bank transfer'],
    idRetentionMonths: 12,
    languages: ['en'],
    dataProtectionNotice:
      'ID details are held under the UK GDPR and the Data Protection Act 2018, stored encrypted and deleted after the hotel’s retention period.',
    suggestedTaxes: [
      {
        code: 'VAT',
        name: 'VAT',
        authority: 'HMRC',
        rateBps: 2000,
        sequence: 1,
        inclusive: true,
        appliesTo: ALL,
      },
    ],
    taxNotes:
      'Prices to guests include VAT. City levies are left out: Edinburgh charges 5% of the room price before VAT on the first five nights (from 24 July 2026), Glasgow 5% on every night (from 25 January 2027), and Welsh councils may add a nightly charge per guest from April 2027. Add the one for your city yourself.',
  },
};

export const COUNTRY_PACK_CODES = Object.keys(COUNTRY_PACKS) as [SignUpCountry, ...SignUpCountry[]];

/** A group's pack: the one platform staff gave it, or its sign-up country's. */
export function packFor(organisation: {
  country: string;
  countryPack?: string | null;
}): CountryPack | null {
  const code = organisation.countryPack ?? organisation.country;
  return COUNTRY_PACKS[code as SignUpCountry] ?? null;
}
