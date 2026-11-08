// Leakage Guard core rules (PRD M6-07, "Leakage rules" table, V1 core rules ●; T-090). Each
// property can switch a rule off (unless another module relies on its alerts), change its
// thresholds, and choose whether its alerts reach the owner at once or wait for the flash
// report (M6-09). The settings live in `leakage_rules`; no row means these defaults.

/** How a threshold is entered and stored. */
export type LeakageParamKind = 'amount' | 'count' | 'hours';

export interface LeakageParamDef {
  key: string;
  label: string;
  kind: LeakageParamKind;
  /** Amounts in minor units as a string; counts and hours as numbers. */
  default: string | number;
  min: number;
  max: number;
}

export interface LeakageRuleDef {
  code: string;
  label: string;
  /** When it fires (the PRD's "Trigger"). */
  trigger: string;
  /** Alert codes the rule raises (a rule may raise more than one kind). */
  alertCodes: readonly string[];
  /**
   * False when another module's rule depends on the alerts (the shift sign-off of M4, the
   * housekeeping discrepancy task of M5 rule 6): thresholds and notifications still change.
   */
  canDisable: boolean;
  params: readonly LeakageParamDef[];
}

export const LEAKAGE_RULES = [
  {
    code: 'OCCUPIED_NO_FOLIO',
    label: 'Occupied without folio',
    trigger:
      'A housekeeping report shows a room in use with no guest checked in (or vacant with one)',
    alertCodes: ['OCCUPIED_NO_FOLIO', 'VACANT_IN_HOUSE'],
    canDisable: false,
    params: [],
  },
  {
    code: 'RATE_OVERRIDE',
    label: 'Rate override',
    trigger: 'A room night posted below its rate plan’s floor without an approval',
    alertCodes: ['RATE_OVERRIDE'],
    canDisable: true,
    params: [],
  },
  {
    code: 'REVERSAL_PATTERN',
    label: 'Void/reversal pattern',
    trigger: 'Charge reversals per user per shift in a business day',
    alertCodes: ['REVERSAL_PATTERN'],
    canDisable: true,
    params: [
      {
        key: 'maxCount',
        label: 'More than (reversals)',
        kind: 'count',
        default: 3,
        min: 0,
        max: 1000,
      },
      {
        key: 'maxAmountMinor',
        label: 'Or more than (amount)',
        kind: 'amount',
        default: '5000000',
        min: 0,
        max: Number.MAX_SAFE_INTEGER,
      },
    ],
  },
  {
    code: 'SHIFT_VARIANCE',
    label: 'Cash variance',
    trigger: 'A cashier shift closes with a count different from what was expected',
    alertCodes: ['SHIFT_VARIANCE'],
    canDisable: false,
    params: [
      {
        key: 'toleranceMinor',
        label: 'Tolerance per method',
        kind: 'amount',
        default: '50000',
        min: 0,
        max: Number.MAX_SAFE_INTEGER,
      },
    ],
  },
  {
    code: 'UNMATCHED_TRANSFER',
    label: 'Unmatched transfer',
    trigger:
      'A transfer waits unmatched in the queue, or a bank transfer typed in at the desk is not confirmed by the provider',
    alertCodes: ['UNMATCHED_TRANSFER'],
    canDisable: true,
    params: [
      { key: 'hours', label: 'After (hours)', kind: 'hours', default: 24, min: 1, max: 720 },
    ],
  },
  {
    // M14-05 (T-057): a visitor who stays the night is a guest nobody charged.
    code: 'VISITOR_OVERSTAY',
    label: 'Visitor past cut-off',
    trigger: 'A visitor is still signed in after the cut-off and no extra person was added',
    alertCodes: ['VISITOR_OVERSTAY'],
    canDisable: true,
    params: [
      {
        key: 'cutoffHour',
        label: 'Cut-off hour (18–23, 24-hour clock)',
        kind: 'hours',
        default: 23,
        min: 18,
        max: 23,
      },
    ],
  },
] as const satisfies readonly LeakageRuleDef[];

export type LeakageRuleCode = (typeof LEAKAGE_RULES)[number]['code'];

export const LEAKAGE_RULE_CODES = LEAKAGE_RULES.map((r) => r.code) as [
  LeakageRuleCode,
  ...LeakageRuleCode[],
];

export function leakageRuleDef(code: string): LeakageRuleDef | undefined {
  return LEAKAGE_RULES.find((r) => r.code === code);
}

/** The rule an alert code belongs to (VACANT_IN_HOUSE is part of OCCUPIED_NO_FOLIO). */
export function leakageRuleOfAlert(alertCode: string): LeakageRuleDef | undefined {
  return LEAKAGE_RULES.find((r) => (r.alertCodes as readonly string[]).includes(alertCode));
}

/** Labels of alert codes, for lists and the night audit step. */
export const LEAKAGE_ALERT_LABELS: Record<string, string> = {
  OCCUPIED_NO_FOLIO: 'Occupied without folio',
  VACANT_IN_HOUSE: 'Vacant with a guest in house',
  RATE_OVERRIDE: 'Rate below floor',
  REVERSAL_PATTERN: 'Reversal pattern',
  SHIFT_VARIANCE: 'Cash variance',
  UNMATCHED_TRANSFER: 'Unmatched transfer',
  VISITOR_OVERSTAY: 'Visitor past cut-off',
};

export const ALERT_OUTCOMES = ['EXPLAINED', 'RECOVERED', 'ACTION_TAKEN', 'FALSE_POSITIVE'] as const;
export type AlertOutcomeKind = (typeof ALERT_OUTCOMES)[number];
