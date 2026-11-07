import type { Config } from './config.ts';

// Platform staff (PRD M13; T-100; Philip, 2026-11-14): the people listed in
// PLATFORM_ADMIN_EMAILS, and only while their MFA is on. Nothing inside the app can make
// someone platform staff, and hotel roles can never carry the platform.* permissions.

export function isPlatformAdmin(
  config: Pick<Config, 'platformAdminEmails'>,
  user: { email: string | null; mfaEnabled: boolean },
): boolean {
  return (
    user.mfaEnabled &&
    user.email !== null &&
    config.platformAdminEmails.includes(user.email.toLowerCase())
  );
}
