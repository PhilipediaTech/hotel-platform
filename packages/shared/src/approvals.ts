// Protected actions (PRD M1 business rule 2; T-022). An approval policy names one of these
// actions; the module that performs the action measures it (amount, percent or count) and
// asks the approvals engine whether the caller may go ahead or must request approval.
//
// Effective limit (spec issue 21, approved 2026-10-28): the caller's role limit on
// `limitCode` when one of their roles sets it; otherwise the policy threshold; a policy with
// no threshold means every instance needs approval.

export type ApprovalMeasure = 'amount' | 'percent' | 'count' | 'none';

export interface ApprovalActionDef {
  /** Policy key; a permission code where one exists. */
  code: string;
  label: string;
  /** What the action is measured by, for thresholds. */
  measure: ApprovalMeasure;
  /** Permission whose role limit applies (Role.limits); none = policy only. */
  limitCode?: string;
  /** Back-office actions wait 48 hours for a decision, front-desk ones 30 minutes (rule 3). */
  backOffice: boolean;
  /** Default policy threshold: basis points or minor units; undefined = always ask. */
  defaultThresholdBps?: number;
}

const a = (def: ApprovalActionDef) => def;

export const APPROVAL_ACTIONS = [
  a({
    code: 'folio.discount',
    label: 'Discount above the limit',
    measure: 'percent',
    limitCode: 'folio.discount',
    backOffice: false,
    defaultThresholdBps: 1500,
  }),
  a({
    code: 'rate.below_floor',
    label: 'Rate below the plan’s floor',
    measure: 'none',
    backOffice: false,
  }),
  a({
    code: 'payment.refund',
    label: 'Refund',
    measure: 'amount',
    limitCode: 'payment.refund',
    backOffice: true,
  }),
  a({ code: 'folio.write_off', label: 'Write-off', measure: 'amount', backOffice: true }),
  a({ code: 'room.comp', label: 'Complimentary room', measure: 'none', backOffice: false }),
  a({
    code: 'folio.reverse',
    label: 'Void of a posted charge',
    measure: 'amount',
    limitCode: 'folio.reverse',
    backOffice: false,
  }),
  a({
    code: 'folio.backdate',
    label: 'Back-dated posting',
    measure: 'count',
    limitCode: 'folio.backdate',
    backOffice: true,
  }),
  a({
    code: 'room.move',
    label: 'Room move after midnight',
    measure: 'count',
    limitCode: 'room.move',
    backOffice: false,
  }),
  a({
    code: 'folio.route',
    label: 'Folio transfer between guests',
    measure: 'amount',
    limitCode: 'folio.route',
    backOffice: false,
  }),
  // M3 rule 8: a do-not-rent guest is booked only with a manager's approval.
  a({
    code: 'reservation.do_not_rent',
    label: 'Booking a do-not-rent guest',
    measure: 'none',
    backOffice: false,
  }),
  // M3-07: a room that is not clean or inspected, or still occupied, given to a guest arriving
  // today.
  a({
    code: 'room.not_ready',
    label: 'Room not ready given to an arriving guest',
    measure: 'none',
    backOffice: false,
  }),
  a({
    code: 'ar.over_limit',
    label: 'City-ledger transfer over the credit limit',
    measure: 'amount',
    backOffice: true,
  }),
] as const satisfies readonly ApprovalActionDef[];

export type ApprovalActionCode = (typeof APPROVAL_ACTIONS)[number]['code'];

export const APPROVAL_ACTION_CODES = APPROVAL_ACTIONS.map((x) => x.code) as [
  ApprovalActionCode,
  ...ApprovalActionCode[],
];

export function approvalAction(code: string): ApprovalActionDef | undefined {
  return APPROVAL_ACTIONS.find((x) => x.code === code);
}

/** Rule 3: 30 minutes for front-desk actions, 48 hours for back-office ones. */
export const defaultExpiryMinutes = (def: Pick<ApprovalActionDef, 'backOffice'>) =>
  def.backOffice ? 48 * 60 : 30;
