// CI dependency audit: fails on any high or critical advisory in the whole tree unless
// scripts/audit-waivers.json waives it. A waiver names one advisory (GHSA id), says why, and
// lapses on its `until` date, so it is looked at again. Runtime packages are audited
// separately in CI with no waivers at all (docs/SECURITY.md).
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const BLOCKING = new Set(['high', 'critical']);

/** @param {string} url */
const ghsaOf = (url) => /GHSA-[\w-]+$/.exec(url ?? '')?.[0] ?? url;

/**
 * @param {{ vulnerabilities?: Record<string, { via: unknown[] }> }} report `npm audit --json`
 * @param {{ id: string, until: string }[]} waivers
 * @param {string} today YYYY-MM-DD
 * @returns {{ blocking: string[], waived: string[], expired: string[] }}
 */
export function checkAudit(report, waivers, today) {
  /** @type {Map<string, string>} */
  const advisories = new Map();
  for (const vuln of Object.values(report.vulnerabilities ?? {})) {
    for (const via of vuln.via) {
      if (typeof via !== 'object' || via === null) continue;
      const v = /** @type {{ url: string, severity: string, name: string, title: string }} */ (via);
      if (!BLOCKING.has(v.severity)) continue;
      advisories.set(ghsaOf(v.url), `${v.severity} ${v.name}: ${v.title} (${v.url})`);
    }
  }
  /** @type {string[]} */
  const blocking = [];
  /** @type {string[]} */
  const waived = [];
  /** @type {string[]} */
  const expired = [];
  for (const [id, text] of advisories) {
    const waiver = waivers.find((w) => w.id === id);
    if (!waiver) blocking.push(text);
    else if (waiver.until < today) expired.push(`${text}; waiver lapsed ${waiver.until}`);
    else waived.push(`${text}; waived until ${waiver.until}`);
  }
  return { blocking, waived, expired };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  let out;
  try {
    // A fixed command string, no user input.
    out = execSync('npm audit --json', { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    // npm audit exits 1 when it finds anything; the JSON is still on stdout.
    out = /** @type {{ stdout?: string }} */ (error).stdout ?? '';
  }
  /** @type {unknown} */
  const waivers = JSON.parse(
    readFileSync(new URL('./audit-waivers.json', import.meta.url), 'utf8'),
  );
  /** @type {unknown} */
  const report = JSON.parse(out);
  const result = checkAudit(
    /** @type {{ vulnerabilities?: Record<string, { via: unknown[] }> }} */ (report),
    /** @type {{ id: string, until: string }[]} */ (waivers),
    new Date().toISOString().slice(0, 10),
  );
  for (const line of result.waived) console.log(`waived: ${line}`);
  for (const line of [...result.blocking, ...result.expired]) console.error(`blocking: ${line}`);
  if (result.blocking.length + result.expired.length > 0) process.exit(1);
  console.log('Dependency audit: no high or critical advisory without a waiver.');
}
