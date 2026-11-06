import { randomUUID } from 'node:crypto';
import {
  LEAKAGE_ALERT_LABELS,
  LEAKAGE_RULES,
  leakageRuleDef,
  leakageRuleOfAlert,
  type AlertOutcomeBody,
  type LeakageAlertDetail,
  type LeakageAlertItem,
  type LeakageRuleCode,
  type LeakageRulesBody,
  type listLeakageRules,
} from '@hotel/shared';
import type { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client.ts';
import { recordAudit } from '../../core/audit.ts';
import type { Clock } from '../../core/clock.ts';
import type { Db } from '../../core/db.ts';
import { AppError } from '../../core/errors.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import type { TenantDb } from '../../core/tenant-db.ts';
import { paramValue, ruleSettings } from './engine.ts';

// Leakage review (PRD M6-08, M6-09, M6 rule 3; tab 4 row "Leakage"; S22; T-090). An owner or GM
// reads an alert's evidence and adds outcomes; an alert never changes except for being marked
// REVIEWED by its first outcome. The rules' settings are changed here too.

export interface LeakageDeps {
  db: Db;
  tenantDb: TenantDb;
  clock: Clock;
}

type Tx = Parameters<Parameters<TenantDb['$transaction']>[0]>[0];
type Rules = z.infer<(typeof listLeakageRules)['response']>;

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const day = (d: Date) => d.toISOString().slice(0, 10);
const dbDate = (date: string) => new Date(`${date}T00:00:00Z`);

const ALERT = {
  subjectUser: { select: { id: true, name: true } },
  outcomes: { select: { recoveredMinor: true } },
} satisfies Prisma.LeakageAlertInclude;

type AlertRow = Prisma.LeakageAlertGetPayload<{ include: typeof ALERT }>;

function alertItem(a: AlertRow): z.infer<typeof LeakageAlertItem> {
  const rule = leakageRuleOfAlert(a.ruleCode);
  return {
    id: a.id,
    ruleCode: a.ruleCode,
    rule: (rule?.code as LeakageRuleCode | undefined) ?? null,
    label: LEAKAGE_ALERT_LABELS[a.ruleCode] ?? a.ruleCode,
    businessDate: day(a.businessDate),
    severity: a.severity,
    entityType: a.entityType,
    entityId: a.entityId,
    subject: a.subjectUser ? { id: a.subjectUser.id, name: a.subjectUser.name } : null,
    evidence: (a.evidence ?? {}) as Record<string, unknown>,
    status: a.status === 'REVIEWED' ? 'REVIEWED' : 'OPEN',
    raisedAt: iso(a.raisedAt),
    outcomes: a.outcomes.length,
    recoveredMinor: a.outcomes.reduce((sum, o) => sum + (o.recoveredMinor ?? 0n), 0n).toString(),
  };
}

const encodeCursor = (offset: number) => Buffer.from(String(offset)).toString('base64url');
function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const n = Number(Buffer.from(cursor, 'base64url').toString());
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

export async function listAlerts(
  deps: LeakageDeps,
  _tenant: TenantContext,
  query: {
    limit: number;
    cursor?: string | undefined;
    status?: 'OPEN' | 'REVIEWED' | undefined;
    rule?: LeakageRuleCode | undefined;
    from?: string | undefined;
    to?: string | undefined;
  },
) {
  const offset = decodeCursor(query.cursor);
  const codes = query.rule ? [...(leakageRuleDef(query.rule)?.alertCodes ?? [])] : undefined;
  const rows = await deps.tenantDb.leakageAlert.findMany({
    where: {
      ...(query.status ? { status: query.status } : {}),
      ...(codes ? { ruleCode: { in: codes } } : {}),
      ...(query.from || query.to
        ? {
            businessDate: {
              ...(query.from ? { gte: dbDate(query.from) } : {}),
              ...(query.to ? { lte: dbDate(query.to) } : {}),
            },
          }
        : {}),
    },
    include: ALERT,
    orderBy: [{ raisedAt: 'desc' }, { id: 'desc' }],
    skip: offset,
    take: query.limit + 1,
  });
  return {
    data: rows.slice(0, query.limit).map(alertItem),
    nextCursor: rows.length > query.limit ? encodeCursor(offset + query.limit) : null,
  };
}

async function detailOf(
  db: Tx | TenantDb,
  alertId: string,
): Promise<z.infer<typeof LeakageAlertDetail>> {
  const a = await db.leakageAlert.findFirst({
    where: { id: alertId },
    include: {
      ...ALERT,
      outcomes: {
        include: {
          byUser: { select: { id: true, name: true } },
          linkedLine: { include: { folio: { select: { number: true } } } },
          linkedPayment: true,
        },
        orderBy: [{ at: 'asc' }, { id: 'asc' }],
      },
    },
  });
  if (!a) throw new AppError('NOT_FOUND', 'Alert not found');
  return {
    ...alertItem(a),
    outcomeList: a.outcomes.map((o) => ({
      id: o.id,
      outcome: o.outcome,
      recoveredMinor: o.recoveredMinor?.toString() ?? null,
      linkedLine: o.linkedLine
        ? {
            id: o.linkedLine.id,
            folioId: o.linkedLine.folioId,
            folioNumber: o.linkedLine.folio.number,
            description: o.linkedLine.description,
            amountMinor: o.linkedLine.amountMinor.toString(),
            businessDate: day(o.linkedLine.businessDate),
          }
        : null,
      linkedPayment: o.linkedPayment
        ? {
            id: o.linkedPayment.id,
            method: o.linkedPayment.method,
            amountMinor: o.linkedPayment.amountMinor.toString(),
            reference: o.linkedPayment.externalRef,
            businessDate: day(o.linkedPayment.businessDate),
          }
        : null,
      note: o.note,
      by: { id: o.byUser.id, name: o.byUser.name },
      at: iso(o.at),
    })),
  };
}

export function getAlert(deps: LeakageDeps, _tenant: TenantContext, alertId: string) {
  return detailOf(deps.tenantDb, alertId);
}

/**
 * Adds an outcome (M6-08). Outcomes are never edited (M6 rule 3, a trigger enforces it); the
 * first marks the alert REVIEWED. Whoever the alert is about cannot review it. A recovered
 * amount links to a charge or payment of the property, at most its amount, and each line or
 * payment recovers one alert's money once, so the recovered total counts it once.
 */
export async function addOutcome(
  deps: LeakageDeps,
  tenant: TenantContext,
  alertId: string,
  body: z.infer<typeof AlertOutcomeBody>,
) {
  return deps.tenantDb.$transaction(async (tx) => {
    const alert = await tx.leakageAlert.findFirst({ where: { id: alertId } });
    if (!alert) throw new AppError('NOT_FOUND', 'Alert not found');
    // One outcome at a time per alert.
    await tx.$queryRaw`SELECT id FROM leakage_alerts WHERE id = ${alert.id}::uuid FOR UPDATE`;
    if (alert.subjectUserId === tenant.userId) {
      throw new AppError('FORBIDDEN', 'Someone else reviews an alert about you');
    }
    const recovered = body.recoveredMinor === null ? null : BigInt(body.recoveredMinor);
    if (recovered !== null) await checkRecovery(tx, body, recovered);
    const outcomeId = randomUUID();
    // Outcomes have no property column (tab 3): written through their (scoped) alert.
    const updated = await tx.leakageAlert.update({
      where: { id: alert.id },
      data: {
        status: 'REVIEWED',
        outcomes: {
          create: {
            id: outcomeId,
            outcome: body.outcome,
            recoveredMinor: recovered,
            linkedLineId: body.linkedLineId,
            linkedPaymentId: body.linkedPaymentId,
            note: body.note,
            byUserId: tenant.userId,
            at: deps.clock(),
          },
        },
      },
      select: { status: true },
    });
    await recordAudit(tx, {
      action: 'leakage.outcome_added',
      entityType: 'leakage_alert',
      entityId: alert.id,
      before: { status: alert.status },
      after: {
        status: updated.status,
        outcome: body.outcome,
        recoveredMinor: recovered?.toString() ?? null,
        linkedLineId: body.linkedLineId,
        linkedPaymentId: body.linkedPaymentId,
      },
      reason: body.note,
    });
    return { alertId: alert.id, outcomeId, status: 'REVIEWED' as const };
  });
}

async function checkRecovery(
  tx: Tx,
  body: z.infer<typeof AlertOutcomeBody>,
  recovered: bigint,
): Promise<void> {
  if (body.linkedLineId) {
    const line = await tx.folioLine.findFirst({ where: { id: body.linkedLineId } });
    if (!line || line.kind !== 'CHARGE') {
      throw new AppError('VALIDATION_ERROR', 'Link a charge on one of this property’s folios', {
        fields: { linkedLineId: ['Not a charge of this property'] },
      });
    }
    if (recovered > line.amountMinor) {
      throw new AppError('VALIDATION_ERROR', 'More than the linked charge', {
        fields: { recoveredMinor: [`At most ${line.amountMinor.toString()}`] },
      });
    }
    const used = await tx.leakageAlert.findFirst({
      where: { outcomes: { some: { linkedLineId: line.id } } },
      select: { id: true },
    });
    if (used) {
      throw new AppError('VALIDATION_ERROR', 'This charge already recovered an alert’s money', {
        fields: { linkedLineId: ['Already linked'] },
        alertId: used.id,
      });
    }
  }
  if (body.linkedPaymentId) {
    const payment = await tx.payment.findFirst({ where: { id: body.linkedPaymentId } });
    if (!payment || payment.amountMinor <= 0n) {
      throw new AppError('VALIDATION_ERROR', 'Link a payment received at this property', {
        fields: { linkedPaymentId: ['Not a payment of this property'] },
      });
    }
    if (recovered > payment.baseAmountMinor) {
      throw new AppError('VALIDATION_ERROR', 'More than the linked payment', {
        fields: { recoveredMinor: [`At most ${payment.baseAmountMinor.toString()}`] },
      });
    }
    const used = await tx.leakageAlert.findFirst({
      where: { outcomes: { some: { linkedPaymentId: payment.id } } },
      select: { id: true },
    });
    if (used) {
      throw new AppError('VALIDATION_ERROR', 'This payment already recovered an alert’s money', {
        fields: { linkedPaymentId: ['Already linked'] },
        alertId: used.id,
      });
    }
  }
}

/** The rules with their settings and how many alerts each raised, reviewed and recovered. */
export async function listRules(deps: LeakageDeps, tenant: TenantContext): Promise<Rules> {
  return rulesOf(deps.tenantDb, tenant);
}

async function rulesOf(db: Tx | TenantDb, tenant: TenantContext): Promise<Rules> {
  const [property, counts, recoveredRows] = await Promise.all([
    db.property.findUniqueOrThrow({ where: { id: tenant.propertyId } }),
    db.leakageAlert.groupBy({ by: ['ruleCode', 'status'], _count: { _all: true } }),
    db.leakageAlert.findMany({
      where: { outcomes: { some: { outcome: 'RECOVERED' } } },
      select: { ruleCode: true, outcomes: { select: { recoveredMinor: true } } },
    }),
  ]);
  const rules: Rules['rules'] = [];
  for (const def of LEAKAGE_RULES) {
    const s = await ruleSettings(db, tenant.propertyId, def.code);
    const mine = (code: string) => (def.alertCodes as readonly string[]).includes(code);
    const count = (status: string) =>
      counts
        .filter((c) => mine(c.ruleCode) && c.status === status)
        .reduce((n, c) => n + c._count._all, 0);
    const recovered = recoveredRows
      .filter((r) => mine(r.ruleCode))
      .flatMap((r) => r.outcomes)
      .reduce((sum, o) => sum + (o.recoveredMinor ?? 0n), 0n);
    rules.push({
      code: def.code,
      label: def.label,
      trigger: def.trigger,
      enabled: s.enabled,
      canDisable: def.canDisable,
      notifyInstant: s.notifyInstant,
      params: def.params.map((p) => ({
        key: p.key,
        label: p.label,
        kind: p.kind,
        value: s.params[p.key] ?? p.default,
        default: p.default,
      })),
      open: count('OPEN'),
      reviewed: count('REVIEWED'),
      recoveredMinor: recovered.toString(),
    });
  }
  return {
    currency: property.baseCurrency,
    rules,
    totals: {
      open: rules.reduce((n, r) => n + r.open, 0),
      reviewed: rules.reduce((n, r) => n + r.reviewed, 0),
      recoveredMinor: rules.reduce((sum, r) => sum + BigInt(r.recoveredMinor), 0n).toString(),
    },
  };
}

/**
 * Changes rules: on or off (not the ones other modules rely on), thresholds, and whether
 * alerts reach the owner at once, which also needs `leakage.notify` (M6-09).
 */
export async function updateRules(
  deps: LeakageDeps,
  tenant: TenantContext,
  body: z.infer<typeof LeakageRulesBody>,
): Promise<Rules> {
  return deps.tenantDb.$transaction(async (tx) => {
    for (const change of body.rules) {
      const def = leakageRuleDef(change.code);
      if (!def) continue;
      const before = await ruleSettings(tx, tenant.propertyId, change.code);
      if (change.enabled === false && !def.canDisable) {
        throw new AppError('VALIDATION_ERROR', `${def.label} cannot be switched off`, {
          fields: { [`${change.code}.enabled`]: ['Other controls rely on these alerts'] },
        });
      }
      if (
        change.notifyInstant !== undefined &&
        change.notifyInstant !== before.notifyInstant &&
        !tenant.permissions.has('leakage.notify')
      ) {
        throw new AppError('FORBIDDEN', 'Choosing instant alerts needs leakage.notify');
      }
      const row = await tx.leakageRule.findFirst({ where: { code: change.code } });
      const params = { ...((row?.params ?? {}) as Record<string, unknown>) };
      for (const [key, value] of Object.entries(change.params ?? {})) {
        const valid = paramValue(change.code, key, value);
        if (valid === undefined) {
          throw new AppError('VALIDATION_ERROR', `Check the threshold of ${def.label}`, {
            fields: { [`${change.code}.${key}`]: ['Not a valid value'] },
          });
        }
        params[key] = valid;
      }
      const data = {
        ...(change.enabled !== undefined ? { enabled: change.enabled } : {}),
        ...(change.notifyInstant !== undefined ? { notifyInstant: change.notifyInstant } : {}),
        params: params as Prisma.InputJsonValue,
      };
      await tx.leakageRule.upsert({
        where: { propertyId_code: { propertyId: tenant.propertyId, code: change.code } },
        create: { code: change.code, ...data } as unknown as Prisma.LeakageRuleUncheckedCreateInput, // tenant IDs come from the client
        update: data,
      });
      const after = await ruleSettings(tx, tenant.propertyId, change.code);
      await recordAudit(tx, {
        action: 'leakage.rule_changed',
        entityType: 'leakage_rule',
        entityId: change.code,
        before,
        after,
      });
    }
    return rulesOf(tx, tenant);
  });
}
