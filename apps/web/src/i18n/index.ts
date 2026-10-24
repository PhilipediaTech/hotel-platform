import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './en.json';

// English first (tab 2). Every user-facing string lives in a resource file (NFR: localisation).
export const resources = { en: { translation: en } } as const;

void i18n.use(initReactI18next).init({
  resources,
  lng: 'en',
  fallbackLng: 'en',
  interpolation: { escapeValue: false }, // React already escapes
  returnNull: false,
});

export default i18n;
