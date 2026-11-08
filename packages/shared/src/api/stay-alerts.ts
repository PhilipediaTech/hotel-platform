import { z } from 'zod';
import { AmountMinor } from './primitives.ts';

// Stay alert kinds and settings (PRD M14-01; T-055), apart from the front desk routes so the
// property contract can carry the settings without importing them.

export const STAY_ALERT_KINDS = [
  /** Checked in and past the check-out time (or a day-use past its end). */
  'LATE_CHECK_OUT',
  /** Checked in and leaving within the property's warning time. */
  'DUE_OUT_SOON',
  /** A tentative hold that lets its rooms go within the warning time. */
  'HOLD_EXPIRING',
  /** Arriving on the next business date with the deposit not yet received. */
  'DEPOSIT_MISSING',
] as const;
export type StayAlertKind = (typeof STAY_ALERT_KINDS)[number];

export const StayAlertSettings = z
  .object({
    /** How long before the check-out time a departure shows as due out. */
    dueOutMinutes: z.number().int().min(15).max(240),
    /** How long before a tentative hold expires it shows. */
    holdWarningMinutes: z.number().int().min(15).max(720),
    /** The late check-out fee the desk can post in one tap; null when the hotel has none. */
    lateCheckOutFeeMinor: AmountMinor.nullable(),
    /** The kinds that also go by WhatsApp. */
    whatsapp: z
      .array(z.enum(STAY_ALERT_KINDS))
      .refine((k) => new Set(k).size === k.length, 'Each kind once'),
  })
  .meta({ id: 'StayAlertSettings' });

export const DEFAULT_STAY_ALERT_SETTINGS: z.output<typeof StayAlertSettings> = {
  dueOutMinutes: 60,
  holdWarningMinutes: 120,
  lateCheckOutFeeMinor: null,
  whatsapp: [],
};
