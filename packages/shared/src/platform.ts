// Platform (PRD M13; T-100): plans, modules that can be switched off per hotel group, and
// support sessions.

export const PLANS = ['ESSENTIALS', 'PROFESSIONAL', 'GROUP'] as const;
export type Plan = (typeof PLANS)[number];

export const SUBSCRIPTION_STATUSES = ['TRIAL', 'ACTIVE', 'PAST_DUE', 'SUSPENDED'] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const PLATFORM_INVOICE_STATUSES = ['ISSUED', 'PAID', 'VOID'] as const;

/**
 * Modules a platform admin can switch off for a hotel group (M13-05; tab 2 "a module can be
 * switched off per tenant by a feature flag; its routes return MODULE_DISABLED"). On unless a
 * flag says otherwise. The strategy tab's Professional plan adds these to Essentials.
 */
export const MODULES = [
  { code: 'leakage', label: 'Revenue Leakage Guard' },
  { code: 'owner', label: 'Owner Remote Control' },
] as const;
export type ModuleCode = (typeof MODULES)[number]['code'];

/** The permissions a module's screens need: off with the module, so its menu items go too. */
export const MODULE_PERMISSIONS: Record<ModuleCode, readonly string[]> = {
  leakage: ['leakage.review', 'leakage.notify'],
  owner: ['owner.read'],
};

/** Platform staff hold every platform code (T-100: PLATFORM_ADMIN_EMAILS, MFA on). */
export const PLATFORM_PERMISSION_CODES = [
  'platform.admin',
  'platform.support',
  'platform.billing',
  'platform.flags',
] as const;
export const MODULE_CODES = MODULES.map((m) => m.code) as [ModuleCode, ...ModuleCode[]];

/** A support session lasts at most an hour (M13-02 "time-limited"). */
export const SUPPORT_SESSION_MAX_MINUTES = 60;
export const SUPPORT_SESSION_DEFAULT_MINUTES = 30;
