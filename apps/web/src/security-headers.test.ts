import { describe, expect, it } from 'vitest';
import { contentSecurityPolicy, pagesHeadersFile, securityHeaders } from './security-headers.ts';

// Staff-app headers on Cloudflare Pages (T-005; docs/SECURITY.md V3).

describe('staff app security headers', () => {
  it('allows only the app, its API and file storage', () => {
    const csp = contentSecurityPolicy({ apiBaseUrl: 'https://api.example.com/api/v1' });
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self';");
    expect(csp).toContain(
      "connect-src 'self' https://api.example.com https://*.r2.cloudflarestorage.com",
    );
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toMatch(/unsafe-eval|script-src[^;]*unsafe-inline/);
  });

  it('uses the same origin when the API is relative or unset', () => {
    for (const apiBaseUrl of [undefined, '/api/v1']) {
      expect(contentSecurityPolicy({ apiBaseUrl })).toContain(
        "connect-src 'self' https://*.r2.cloudflarestorage.com",
      );
    }
  });

  it('forces HTTPS when hosted, but not on localhost preview', () => {
    expect(securityHeaders()['Strict-Transport-Security']).toMatch(/max-age=31536000/);
    expect(contentSecurityPolicy()).toContain('upgrade-insecure-requests');
    expect(securityHeaders({ local: true })['Strict-Transport-Security']).toBeUndefined();
    expect(contentSecurityPolicy({ local: true })).not.toContain('upgrade-insecure-requests');
  });

  it('writes the Pages _headers file for every path, never caching the service worker', () => {
    const file = pagesHeadersFile({ apiBaseUrl: 'https://api.example.com/api/v1' });
    expect(file.startsWith('/*\n  Content-Security-Policy: ')).toBe(true);
    expect(file).toContain('  X-Frame-Options: DENY');
    expect(file).toContain('/sw.js\n  Cache-Control: no-cache');
  });
});
