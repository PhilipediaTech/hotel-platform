import type { SignUpCountry } from './countries.ts';
import { SIGN_UP_COUNTRIES } from './countries.ts';
import type { ID_TYPES } from './registration.ts';

// Country packs (PRD M14-09; T-111): what changes when a hotel group trades outside Nigeria.
// A pack holds defaults only. Tax rates are deliberately absent for every country but the
// existing Nigerian examples: rates are the hotel's to enter (Philip's tax adviser confirms
// any rate we would ship). The notices name the local law in plain words and need a local
// lawyer's review before a first sale in that country.

type IdType = (typeof ID_TYPES)[number];

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
}

export const COUNTRY_PACKS: Record<SignUpCountry, CountryPack> = {
  NG: {
    ...SIGN_UP_COUNTRIES.NG,
    idTypes: ['PASSPORT', 'NATIONAL_ID', 'DRIVERS_LICENCE', 'VOTERS_CARD', 'OTHER'],
    paymentMethods: ['Card', 'Bank transfer', 'USSD'],
    idRetentionMonths: 12,
    languages: ['en'],
    dataProtectionNotice:
      'ID details are held under the Nigeria Data Protection Act 2023, stored encrypted and deleted after the hotel’s retention period.',
  },
  GH: {
    ...SIGN_UP_COUNTRIES.GH,
    idTypes: ['PASSPORT', 'NATIONAL_ID', 'DRIVERS_LICENCE', 'VOTERS_CARD', 'OTHER'],
    paymentMethods: ['Card', 'Mobile money'],
    idRetentionMonths: 12,
    languages: ['en'],
    dataProtectionNotice:
      'ID details are held under Ghana’s Data Protection Act 2012, stored encrypted and deleted after the hotel’s retention period.',
  },
  KE: {
    ...SIGN_UP_COUNTRIES.KE,
    idTypes: ['PASSPORT', 'NATIONAL_ID', 'DRIVERS_LICENCE', 'OTHER'],
    paymentMethods: ['Card', 'M-Pesa'],
    idRetentionMonths: 12,
    languages: ['en', 'sw'],
    dataProtectionNotice:
      'ID details are held under Kenya’s Data Protection Act 2019, stored encrypted and deleted after the hotel’s retention period.',
  },
  ZA: {
    ...SIGN_UP_COUNTRIES.ZA,
    idTypes: ['PASSPORT', 'NATIONAL_ID', 'DRIVERS_LICENCE', 'OTHER'],
    paymentMethods: ['Card', 'EFT'],
    idRetentionMonths: 12,
    languages: ['en'],
    dataProtectionNotice:
      'ID details are held under South Africa’s POPIA, stored encrypted and deleted after the hotel’s retention period.',
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
