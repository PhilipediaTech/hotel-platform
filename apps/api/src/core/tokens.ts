import { createHmac, randomBytes } from 'node:crypto';

/** 256-bit random token for cookies and email links (base64url, 43 characters). */
export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * What the database stores instead of the token: HMAC-SHA256 with the server secret, so a
 * leaked table can't be replayed as cookies or links.
 */
export function hashToken(secret: string, token: string): string {
  return createHmac('sha256', secret).update(token).digest('hex');
}
