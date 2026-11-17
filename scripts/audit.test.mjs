import { describe, expect, it } from 'vitest';
import { checkAudit } from './audit.mjs';

/** @param {string} id @param {string} severity @param {string} [name] */
const advisory = (id, severity, name = 'pkg') => ({
  url: `https://github.com/advisories/${id}`,
  severity,
  name,
  title: 'something',
});

const report = {
  vulnerabilities: {
    picomatch: { via: [advisory('GHSA-aaaa-bbbb-cccc', 'high', 'picomatch')] },
    vite: { via: ['picomatch'] },
    glob: { via: [advisory('GHSA-dddd-eeee-ffff', 'moderate', 'glob')] },
  },
};

describe('checkAudit', () => {
  it('blocks a high advisory with no waiver', () => {
    const result = checkAudit(report, [], '2026-11-17');
    expect(result.blocking).toHaveLength(1);
    expect(result.blocking[0]).toContain('picomatch');
  });

  it('lets a waived advisory through until its date', () => {
    const waivers = [{ id: 'GHSA-aaaa-bbbb-cccc', until: '2027-01-31' }];
    expect(checkAudit(report, waivers, '2027-01-31')).toMatchObject({ blocking: [], expired: [] });
    expect(checkAudit(report, waivers, '2027-01-31').waived).toHaveLength(1);
  });

  it('blocks again once the waiver lapses', () => {
    const waivers = [{ id: 'GHSA-aaaa-bbbb-cccc', until: '2027-01-31' }];
    expect(checkAudit(report, waivers, '2027-02-01').expired).toHaveLength(1);
  });

  it('ignores moderate and low advisories, as npm audit --audit-level=high does', () => {
    const only = { vulnerabilities: { glob: report.vulnerabilities.glob } };
    expect(checkAudit(only, [], '2026-11-17')).toEqual({ blocking: [], waived: [], expired: [] });
  });

  it('a waiver for one advisory does not cover another', () => {
    const two = {
      vulnerabilities: {
        ...report.vulnerabilities,
        other: { via: [advisory('GHSA-zzzz-yyyy-xxxx', 'critical')] },
      },
    };
    const waivers = [{ id: 'GHSA-aaaa-bbbb-cccc', until: '2027-01-31' }];
    expect(checkAudit(two, waivers, '2026-11-17').blocking).toHaveLength(1);
  });
});
