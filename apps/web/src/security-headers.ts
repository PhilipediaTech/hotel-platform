// Security headers for the staff app as served by Cloudflare Pages (T-005; docs/SECURITY.md
// V3 "the staff app's own static-hosting headers"). Used at build time only: vite.config.ts
// writes them to dist/_headers (Pages' format) and applies them to `vite preview`, so the
// CSP is tried in a real browser before it ships. Not imported by the app.

export interface HeaderOptions {
  /** Where the API lives, from VITE_API_BASE_URL; same origin when unset. */
  apiBaseUrl?: string | undefined;
  /** `vite preview` on http://localhost: no HTTPS upgrade or HSTS, which would break it. */
  local?: boolean;
}

/** Object storage for signed upload and download links (R2 in production). */
export const FILE_STORAGE_SOURCES = ['https://*.r2.cloudflarestorage.com'];

function originOf(url: string | undefined): string | null {
  if (!url || url.startsWith('/')) return null;
  return new URL(url).origin;
}

export function contentSecurityPolicy({ apiBaseUrl, local }: HeaderOptions = {}): string {
  const api = originOf(apiBaseUrl);
  const connect = ["'self'", ...(api ? [api] : []), ...FILE_STORAGE_SOURCES];
  return [
    "default-src 'self'",
    "script-src 'self'",
    // A few components set style attributes; no inline <style> or scripts are needed.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: " + FILE_STORAGE_SOURCES.join(' '),
    "font-src 'self'",
    `connect-src ${connect.join(' ')}`,
    "worker-src 'self'",
    "manifest-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
    ...(local ? [] : ['upgrade-insecure-requests']),
  ].join('; ');
}

export function securityHeaders(options: HeaderOptions = {}): Record<string, string> {
  return {
    'Content-Security-Policy': contentSecurityPolicy(options),
    ...(options.local
      ? {}
      : { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' }),
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(self), microphone=(), geolocation=(), payment=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
  };
}

/** Cloudflare Pages `_headers`: every path gets the headers; the service worker is never cached. */
export function pagesHeadersFile(options: HeaderOptions = {}): string {
  const all = Object.entries(securityHeaders(options))
    .map(([name, value]) => `  ${name}: ${value}`)
    .join('\n');
  return [
    '/*',
    all,
    '',
    '/sw.js',
    '  Cache-Control: no-cache',
    '',
    '/assets/*',
    '  Cache-Control: public, max-age=31536000, immutable',
    '',
  ].join('\n');
}
