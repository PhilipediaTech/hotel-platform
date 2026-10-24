/**
 * Countries a new organisation can sign up from, with the defaults its first property gets
 * (time zone, base currency, locale). The owner can change them in the setup checklist (M1-02).
 * Extend this list as markets open.
 */
export const SIGN_UP_COUNTRIES = {
  NG: { name: 'Nigeria', timeZone: 'Africa/Lagos', currency: 'NGN', locale: 'en-NG' },
  GH: { name: 'Ghana', timeZone: 'Africa/Accra', currency: 'GHS', locale: 'en-GH' },
  KE: { name: 'Kenya', timeZone: 'Africa/Nairobi', currency: 'KES', locale: 'en-KE' },
  ZA: { name: 'South Africa', timeZone: 'Africa/Johannesburg', currency: 'ZAR', locale: 'en-ZA' },
} as const;

export type SignUpCountry = keyof typeof SIGN_UP_COUNTRIES;

export const SIGN_UP_COUNTRY_CODES = Object.keys(SIGN_UP_COUNTRIES) as [
  SignUpCountry,
  ...SignUpCountry[],
];
