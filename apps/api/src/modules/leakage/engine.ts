import {
  DEFAULT_SHIFT_TOLERANCE_MINOR,
  leakageRuleDef,
  leakageRuleOfAlert,
  type LeakageRuleCode,
  type Priority,
} from '@hotel/shared';
import type { Prisma } from '../../generated/prisma/client.ts';
import { recordEvent, type OutboxClient } from '../../core/outbox.ts';

// The Leakage Guard engine (PRD M6-07; T-090). Every alert, whichever module notices it, is
// raised here: the rule's settings decide whether it is raised at all, the dedupe key keeps it
// to one per subject, and the `leakage.alert_raised` event says whether the owner hears at once
// (instant, M6-09; delivery comes with T-024) or with the flash report.

/**
 * What the engine reads and writes: anything with these delegates (the tenant client, a
 * transaction of either client, or the plain client), as the outbox does.
 */
export interface LeakageClient extends OutboxClient {
  leakageRule: {
    findFirst(args: {
      where: { propertyId: string; code: string };
    }): PromiseLike<{ enabled: boolean; notifyInstant: boolean; params: unknown } | null>;
  };
  leakageAlert: {
    findFirst(args: {
      where: { propertyId: string; dedupeKey: string };
      select: { id: true };
    }): PromiseLike<{ id: string } | null>;
    create(args: { data: Prisma.LeakageAlertUncheckedCreateInput }): PromiseLike<{ id: string }>;
  };
  property: {
    findUniqueOrThrow(args: { where: { id: string } }): PromiseLike<{ settings: unknown }>;
  };
}

export interface RuleSettings {
  code: LeakageRuleCode;
  enabled: boolean;
  notifyInstant: boolean;
  /** Thresholds: stored values over the rule's defaults. */
  params: Record<string, string | number>;
}

const dbDate = (date: string) => new Date(`${date}T00:00:00Z`);

/** Valid stored value of a threshold, or undefined. */
export function paramValue(
  code: LeakageRuleCode,
  key: string,
  value: unknown,
): string | number | undefined {
  const def = leakageRuleDef(code)?.params.find((p) => p.key === key);
  if (!def) return undefined;
  if (def.kind === 'amount') {
    const text = typeof value === 'number' ? String(value) : value;
    return typeof text === 'string' && /^(0|[1-9]\d{0,17})$/.test(text) ? text : undefined;
  }
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= def.min &&
    value <= def.max
    ? value
    : undefined;
}

/** The property's settings of a rule (no row: the defaults). */
export async function ruleSettings(
  db: LeakageClient,
  propertyId: string,
  code: LeakageRuleCode,
): Promise<RuleSettings> {
  const def = leakageRuleDef(code);
  if (!def) throw new Error(`Unknown leakage rule ${code}`);
  const row = await db.leakageRule.findFirst({ where: { propertyId, code } });
  const stored = (row?.params ?? {}) as Record<string, unknown>;
  const params: Record<string, string | number> = {};
  for (const p of def.params) params[p.key] = paramValue(code, p.key, stored[p.key]) ?? p.default;
  // Before T-090 the shift tolerance was a property setting: it stays the default.
  if (
    code === 'SHIFT_VARIANCE' &&
    paramValue(code, 'toleranceMinor', stored['toleranceMinor']) === undefined
  ) {
    const property = await db.property.findUniqueOrThrow({ where: { id: propertyId } });
    const settings = (property.settings ?? {}) as Record<string, unknown>;
    params['toleranceMinor'] =
      paramValue(code, 'toleranceMinor', settings['shiftVarianceToleranceMinor']) ??
      DEFAULT_SHIFT_TOLERANCE_MINOR;
  }
  return {
    code,
    enabled: def.canDisable ? (row?.enabled ?? true) : true,
    notifyInstant: row?.notifyInstant ?? false,
    params,
  };
}

export const amountParam = (s: RuleSettings, key: string) => BigInt(String(s.params[key] ?? 0));
export const numberParam = (s: RuleSettings, key: string) => Number(s.params[key] ?? 0);

export interface AlertInput {
  propertyId: string;
  /** Needed with the plain client (outside a tenant context). */
  organisationId?: string;
  /** The alert's code; its rule is looked up from it. */
  ruleCode: string;
  businessDate: string;
  severity: Priority;
  entityType: string;
  entityId: string;
  subjectUserId?: string | null;
  evidence: Record<string, unknown>;
  dedupeKey: string;
  /** More fields for the event payload. */
  event?: Record<string, unknown>;
  /** Settings already read by the caller. */
  settings?: RuleSettings;
}

/**
 * Raises an alert once per dedupe key, if its rule is on. Answers the alert's ID, or null when
 * the rule is off or the alert was raised before. Alerts are never changed afterwards (M6 rule
 * 3; a trigger enforces it).
 */
export async function raiseAlert(db: LeakageClient, input: AlertInput): Promise<string | null> {
  const rule = leakageRuleOfAlert(input.ruleCode);
  if (!rule) throw new Error(`No leakage rule raises ${input.ruleCode}`);
  const settings =
    input.settings ?? (await ruleSettings(db, input.propertyId, rule.code as LeakageRuleCode));
  if (!settings.enabled) return null;
  const exists = await db.leakageAlert.findFirst({
    where: { propertyId: input.propertyId, dedupeKey: input.dedupeKey },
    select: { id: true },
  });
  if (exists) return null;
  const alert = await db.leakageAlert.create({
    data: {
      propertyId: input.propertyId,
      ruleCode: input.ruleCode,
      businessDate: dbDate(input.businessDate),
      severity: input.severity,
      entityType: input.entityType,
      entityId: input.entityId,
      subjectUserId: input.subjectUserId ?? null,
      evidence: input.evidence as Prisma.InputJsonValue,
      dedupeKey: input.dedupeKey,
    },
  });
  await recordEvent(db, {
    ...(input.organisationId ? { organisationId: input.organisationId } : {}),
    propertyId: input.propertyId,
    type: 'leakage.alert_raised',
    payload: {
      alertId: alert.id,
      ruleCode: input.ruleCode,
      rule: rule.code,
      severity: input.severity,
      notify: settings.notifyInstant ? 'INSTANT' : 'FLASH',
      ...input.event,
    },
  });
  return alert.id;
}
