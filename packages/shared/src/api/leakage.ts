import { z } from 'zod';
import { ALERT_OUTCOMES, LEAKAGE_RULE_CODES } from '../leakage.ts';
import { PRIORITIES } from '../tasks.ts';
import { defineRoute } from './contract.ts';
import { AmountMinor, Instant, IsoDate, page, PageQuery, Uuid } from './primitives.ts';

// Leakage Guard (PRD M6-07–M6-09, M6 rule 3; tab 4 row "Leakage"; S22; T-090). The rules raise
// alerts with evidence; an owner or GM reviews each one and adds outcomes (never edits them).

const Person = z.object({ id: Uuid, name: z.string() });

export const LeakageAlertItem = z
  .object({
    id: Uuid,
    /** The alert's code (VACANT_IN_HOUSE belongs to rule OCCUPIED_NO_FOLIO). */
    ruleCode: z.string(),
    rule: z.enum(LEAKAGE_RULE_CODES).nullable(),
    label: z.string(),
    businessDate: IsoDate,
    severity: z.enum(PRIORITIES),
    entityType: z.string(),
    entityId: z.string(),
    subject: Person.nullable(),
    evidence: z.record(z.string(), z.unknown()),
    status: z.enum(['OPEN', 'REVIEWED']),
    raisedAt: Instant,
    outcomes: z.number().int(),
    /** Sum of the recovered amounts of its outcomes. */
    recoveredMinor: AmountMinor,
  })
  .meta({ id: 'LeakageAlert' });

const AlertOutcomeItem = z.object({
  id: Uuid,
  outcome: z.enum(ALERT_OUTCOMES),
  recoveredMinor: AmountMinor.nullable(),
  linkedLine: z
    .object({
      id: Uuid,
      folioId: Uuid,
      folioNumber: z.string(),
      description: z.string(),
      amountMinor: AmountMinor,
      businessDate: IsoDate,
    })
    .nullable(),
  linkedPayment: z
    .object({
      id: Uuid,
      method: z.string(),
      amountMinor: AmountMinor,
      reference: z.string().nullable(),
      businessDate: IsoDate,
    })
    .nullable(),
  note: z.string(),
  by: Person,
  at: Instant,
});

export const LeakageAlertDetail = LeakageAlertItem.extend({
  /** Oldest first. */
  outcomeList: z.array(AlertOutcomeItem),
}).meta({ id: 'LeakageAlertDetail' });

export const listLeakageAlerts = defineRoute({
  operationId: 'listLeakageAlerts',
  method: 'get',
  path: '/leakage/alerts',
  summary: 'Leakage alerts, newest first',
  tags: ['Leakage'],
  propertyScoped: true,
  permission: 'leakage.review',
  query: PageQuery.extend({
    status: z.enum(['OPEN', 'REVIEWED']).optional(),
    rule: z.enum(LEAKAGE_RULE_CODES).optional(),
    from: IsoDate.optional(),
    to: IsoDate.optional(),
  }),
  response: page(LeakageAlertItem),
});

export const getLeakageAlert = defineRoute({
  operationId: 'getLeakageAlert',
  method: 'get',
  path: '/leakage/alerts/{alertId}',
  summary: 'A leakage alert with its evidence and outcomes',
  tags: ['Leakage'],
  propertyScoped: true,
  permission: 'leakage.review',
  params: z.object({ alertId: Uuid }),
  response: LeakageAlertDetail,
});

const Note = z.string().trim().min(1).max(2000);

export const AlertOutcomeBody = z
  .object({
    outcome: z.enum(ALERT_OUTCOMES),
    recoveredMinor: AmountMinor.nullable().default(null),
    linkedLineId: Uuid.nullable().default(null),
    linkedPaymentId: Uuid.nullable().default(null),
    note: Note,
  })
  .superRefine((b, ctx) => {
    const links = Number(b.linkedLineId !== null) + Number(b.linkedPaymentId !== null);
    if (b.outcome === 'RECOVERED') {
      if (b.recoveredMinor === null || BigInt(b.recoveredMinor) <= 0n) {
        ctx.addIssue({
          code: 'custom',
          path: ['recoveredMinor'],
          message: 'Enter the amount recovered',
        });
      }
      if (links !== 1) {
        ctx.addIssue({
          code: 'custom',
          path: ['linkedLineId'],
          message: 'Link the folio line or the payment that recovered it',
        });
      }
    } else if (b.recoveredMinor !== null || links > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['recoveredMinor'],
        message: 'Only a recovered outcome carries an amount',
      });
    }
  });

export const addLeakageAlertOutcome = defineRoute({
  operationId: 'addLeakageAlertOutcome',
  method: 'post',
  path: '/leakage/alerts/{alertId}/outcomes',
  summary: 'Record what the review found (M6-08)',
  description:
    'Outcomes are added, never edited (M6 rule 3). The first one marks the alert REVIEWED. A ' +
    'recovered amount links to the folio line or payment that recovered it.',
  tags: ['Leakage'],
  propertyScoped: true,
  permission: 'leakage.review',
  idempotent: true,
  status: 201,
  params: z.object({ alertId: Uuid }),
  body: AlertOutcomeBody,
  response: z.object({ alertId: Uuid, outcomeId: Uuid, status: z.enum(['OPEN', 'REVIEWED']) }),
});

const ParamValue = z.union([z.string(), z.number()]);

const LeakageRuleItem = z.object({
  code: z.enum(LEAKAGE_RULE_CODES),
  label: z.string(),
  trigger: z.string(),
  enabled: z.boolean(),
  canDisable: z.boolean(),
  /** Alerts reach the owner at once (WhatsApp, T-024) instead of waiting for the flash report. */
  notifyInstant: z.boolean(),
  params: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      kind: z.enum(['amount', 'count', 'hours']),
      value: ParamValue,
      default: ParamValue,
    }),
  ),
  open: z.number().int(),
  reviewed: z.number().int(),
  recoveredMinor: AmountMinor,
});

const LeakageRules = z.object({
  currency: z.string(),
  rules: z.array(LeakageRuleItem),
  totals: z.object({
    open: z.number().int(),
    reviewed: z.number().int(),
    recoveredMinor: AmountMinor,
  }),
});

export const listLeakageRules = defineRoute({
  operationId: 'listLeakageRules',
  method: 'get',
  path: '/leakage/rules',
  summary: 'The leakage rules, their settings and alert counts',
  tags: ['Leakage'],
  propertyScoped: true,
  permission: 'leakage.review',
  response: LeakageRules,
});

export const LeakageRulesBody = z.object({
  rules: z
    .array(
      z.object({
        code: z.enum(LEAKAGE_RULE_CODES),
        enabled: z.boolean().optional(),
        notifyInstant: z.boolean().optional(),
        params: z.record(z.string(), ParamValue).optional(),
      }),
    )
    .min(1)
    .max(LEAKAGE_RULE_CODES.length),
});

export const updateLeakageRules = defineRoute({
  operationId: 'updateLeakageRules',
  method: 'patch',
  path: '/leakage/rules',
  summary: 'Change rules: on or off, thresholds, instant notification',
  description: 'Changing `notifyInstant` also needs `leakage.notify` (M6-09).',
  tags: ['Leakage'],
  propertyScoped: true,
  permission: 'leakage.review',
  body: LeakageRulesBody,
  response: LeakageRules,
});

export const LEAKAGE_ROUTES = {
  listLeakageAlerts,
  getLeakageAlert,
  addLeakageAlertOutcome,
  listLeakageRules,
  updateLeakageRules,
} as const;
