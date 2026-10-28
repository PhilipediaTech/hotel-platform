// Property setup checklist (PRD M1-02; tab 5 S02; T-030): what an owner completes before a
// property goes live and takes bookings. The API works out each step's status from the
// property's data; go-live needs every required step done.
//
// Steps whose data arrives with a later ticket (`later`) show as "arrives with T-0NN" and do
// not block go-live until that ticket adds its check and removes `later`.

export const SETUP_STEP_IDS = [
  'organisation',
  'details',
  'region',
  'tax',
  'room-types',
  'rooms',
  'rates',
  'payment-methods',
  'staff',
] as const;

export type SetupStepId = (typeof SETUP_STEP_IDS)[number];

export interface SetupStepDef {
  id: SetupStepId;
  /** Go-live waits for it. */
  required: boolean;
  /** Backlog ticket that builds this step's data; until then it can't be checked. */
  later?: string;
}

export const SETUP_STEPS: readonly SetupStepDef[] = [
  { id: 'organisation', required: true },
  { id: 'details', required: true },
  { id: 'region', required: true },
  { id: 'tax', required: true },
  { id: 'room-types', required: true },
  { id: 'rooms', required: true },
  { id: 'rates', required: true },
  { id: 'payment-methods', required: true },
  { id: 'staff', required: false },
];

/**
 * Ways a guest can pay that a hotel switches on in setup and records by hand (tab 3
 * `PayMethod`). Online cards and virtual accounts arrive with the payment provider (T-070);
 * AR transfers with the city ledger (V1.1).
 */
export const MANUAL_PAY_METHODS = [
  'CASH',
  'BANK_TRANSFER',
  'POS_TERMINAL',
  'MOBILE_MONEY',
  'VOUCHER',
] as const;

export type ManualPayMethod = (typeof MANUAL_PAY_METHODS)[number];

/** Property fields that can't change once the property is live (money and dates use them). */
export const LOCKED_WHEN_LIVE = ['baseCurrency', 'timeZone'] as const;
