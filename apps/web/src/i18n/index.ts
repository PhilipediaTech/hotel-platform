import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './en.json';

// English first (tab 2). Every user-facing string lives in a resource file (NFR: localisation).
// en.json holds the strings of the screens in the first load. A screen that loads when first
// opened keeps its own strings in en/<screen>.json and registers them with `registerStrings`
// when its module loads, so they stay out of the first load (NFR: 300 KB budget).
export const resources = { en: { translation: en } } as const;

void i18n.use(initReactI18next).init({
  resources,
  lng: 'en',
  fallbackLng: 'en',
  interpolation: { escapeValue: false }, // React already escapes
  returnNull: false,
});

/** Adds a lazily loaded screen's strings (en/<screen>.json) to the translation namespace. */
export function registerStrings(strings: Record<string, unknown>): void {
  i18n.addResourceBundle('en', 'translation', strings, true, false);
}

export default i18n;
