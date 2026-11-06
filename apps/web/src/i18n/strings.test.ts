import { describe, expect, it } from 'vitest';
import en from './en.json';

// Strings of screens that load when first opened live in en/<screen>.json, out of the first
// load. A module that uses one of those groups must register that file itself; otherwise the
// screen shows raw keys when it is opened before the screen that registers them.
const screenStrings = Object.fromEntries(
  Object.entries(
    import.meta.glob<Record<string, unknown>>('./en/*.json', { eager: true, import: 'default' }),
  ).map(([path, strings]) => [path.slice('./en/'.length), strings]),
);
const sources = Object.entries(
  import.meta.glob<string>(['../**/*.{ts,tsx}', '!../**/*.test.{ts,tsx}'], {
    eager: true,
    query: '?raw',
    import: 'default',
  }),
);

describe('translation files', () => {
  it('puts each group of strings in exactly one file', () => {
    expect(Object.keys(screenStrings).length).toBeGreaterThan(0);
    const seen = new Map<string, string>(Object.keys(en).map((ns) => [ns, 'en.json']));
    for (const [file, strings] of Object.entries(screenStrings)) {
      for (const ns of Object.keys(strings)) {
        expect(seen.get(ns), `${ns} is in ${file} and ${seen.get(ns) ?? ''}`).toBeUndefined();
        seen.set(ns, file);
      }
    }
  });

  it('has every module that uses a screen file register it', () => {
    expect(sources.length).toBeGreaterThan(50);
    const missing: string[] = [];
    for (const [path, code] of sources) {
      for (const [file, strings] of Object.entries(screenStrings)) {
        const used = Object.keys(strings).some((ns) =>
          new RegExp(`\\bt\\(\\s*['"\`]${ns}\\.`).test(code),
        );
        if (used && !code.includes(`i18n/en/${file}'`)) missing.push(`${path} uses ${file}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
