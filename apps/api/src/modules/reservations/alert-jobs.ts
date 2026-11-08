import type { StayAlert, StayAlertKind } from '@hotel/shared';
import type { z } from 'zod';
import type { Clock } from '../../core/clock.ts';
import type { Db } from '../../core/db.ts';
import { defineJob } from '../../core/jobs.ts';
import { queueMessage } from '../notifications/delivery.ts';
import { dayLabel, recipientsWith } from '../owner/notify.ts';
import { money } from '../payments/documents.ts';
import { stayAlertsOf } from '../setup/service.ts';
import { stayAlertsFor } from './alerts.ts';

// Stay alerts by WhatsApp (PRD M14-01; T-055). Every five minutes, for each live property
// that chose some alert kinds, the alerts of those kinds go to the holders of
// frontdesk.alerts.notify with a phone. Each alert is queued once per person, stay and
// business date (queueMessage's `ref`), so later runs and a second worker send nothing more.

type Alert = z.input<typeof StayAlert>;

export const STAY_ALERT_LABELS: Record<StayAlertKind, string> = {
  LATE_CHECK_OUT: 'Late check-out',
  DUE_OUT_SOON: 'Due out soon',
  HOLD_EXPIRING: 'Hold expiring',
  DEPOSIT_MISSING: 'Deposit not received',
};

function timeLabel(at: string | null, timeZone: string): string {
  if (!at) return '';
  return new Intl.DateTimeFormat('en-GB', { timeStyle: 'short', timeZone }).format(new Date(at));
}

/** One sentence on the alert (the message's "detail"). */
export function stayAlertDetail(
  alert: Alert,
  property: { timeZone: string; baseCurrency: string },
): string {
  const who = `${alert.guestName} (${alert.confirmationNo})`;
  const where = alert.roomNumber ? `Room ${alert.roomNumber}, ${who}` : who;
  const at = timeLabel(alert.at, property.timeZone);
  switch (alert.kind) {
    case 'LATE_CHECK_OUT':
      return `${where}: check-out was due at ${at}.`;
    case 'DUE_OUT_SOON':
      return `${where} checks out at ${at}.`;
    case 'HOLD_EXPIRING':
      return `${who}: the tentative hold ends at ${at} and its rooms go back on sale.`;
    case 'DEPOSIT_MISSING':
      return `${who} arrives ${dayLabel(alert.arrival)} and the deposit of ${money(
        BigInt(alert.depositDueMinor),
        property.baseCurrency,
      )} has not come in.`;
  }
}

/** Queues the chosen alerts of every live property; answers how many alerts went to someone. */
export async function sendStayAlerts(db: Db, clock: Clock): Promise<number> {
  const properties = await db.property.findMany({ where: { status: 'LIVE' } });
  let sent = 0;
  for (const property of properties) {
    const kinds = new Set(stayAlertsOf(property).whatsapp);
    if (kinds.size === 0) continue;
    const { date, data } = await stayAlertsFor(db, property, clock);
    const chosen = data.filter((a) => kinds.has(a.kind) && !a.lateFeePosted);
    if (chosen.length === 0) continue;
    const recipients = await recipientsWith(db, {
      organisationId: property.organisationId,
      propertyId: property.id,
      permission: 'frontdesk.alerts.notify',
    });
    if (recipients.length === 0) continue;
    await db.$transaction(async (tx) => {
      for (const alert of chosen) {
        const vars = {
          property_name: property.name,
          alert: STAY_ALERT_LABELS[alert.kind],
          detail: stayAlertDetail(alert, property),
        };
        for (const r of recipients) {
          await queueMessage(tx, {
            organisationId: property.organisationId,
            propertyId: property.id,
            channel: 'WHATSAPP',
            templateCode: 'STAY_ALERT',
            recipient: r.phone,
            vars,
            ref: `stay_alert:${alert.kind}:${alert.stayId}:${date}`,
          });
        }
      }
    });
    sent += chosen.length;
  }
  return sent;
}

export const stayAlertJob = defineJob({
  name: 'stay-alerts',
  schedule: { cron: '*/5 * * * *' },
  async run(_data, { db, clock, logger }) {
    const alerts = await sendStayAlerts(db, clock);
    if (alerts > 0) logger.debug({ alerts }, 'Stay alerts sent or already queued');
  },
});
