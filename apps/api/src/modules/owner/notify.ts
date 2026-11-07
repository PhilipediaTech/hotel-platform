import { LEAKAGE_ALERT_LABELS } from '@hotel/shared';
import type { Logger } from 'pino';
import type { Db } from '../../core/db.ts';
import type { EventHandler } from '../../core/outbox.ts';
import type { AuditReports } from '../nightaudit/reports.ts';
import { queueMessage } from '../notifications/delivery.ts';
import { money } from '../payments/documents.ts';

// Messages to the owner (PRD M6-09, M4-15; M6 AC "an alert configured as instant reaches the
// owner's WhatsApp within 2 minutes"; T-091). Two outbox handlers queue WhatsApp messages
// through T-024's sender: an instant leakage alert as it is raised, and the flash report when
// night audit closes the day. Who receives them follows the permission codes: leakage.notify
// ("receive leakage notifications") and report.flash ("receive the flash report").

export interface NotifyDeps {
  db: Db;
  logger: Logger;
}

/**
 * Active members holding `permission` at the property (or organisation-wide) who have a
 * phone, without `exclude` (the person an alert is about).
 */
export async function recipientsWith(
  db: Db,
  args: {
    organisationId: string;
    propertyId: string;
    permission: string;
    exclude?: string | null;
  },
): Promise<{ userId: string; phone: string }[]> {
  const members = await db.membership.findMany({
    where: {
      organisationId: args.organisationId,
      active: true,
      role: { permissions: { has: args.permission } },
      OR: [{ propertyId: args.propertyId }, { propertyId: null }],
      user: {
        status: 'ACTIVE',
        phone: { not: null },
        ...(args.exclude ? { id: { not: args.exclude } } : {}),
      },
    },
    select: { user: { select: { id: true, phone: true } } },
  });
  const byUser = new Map<string, string>();
  for (const m of members) if (m.user.phone) byUser.set(m.user.id, m.user.phone);
  return [...byUser].map(([userId, phone]) => ({ userId, phone }));
}

const str = (x: unknown) => (typeof x === 'string' || typeof x === 'number' ? String(x) : '');
const minor = (x: unknown) => (typeof x === 'string' && /^-?\d+$/.test(x) ? BigInt(x) : 0n);

/** "10 Nov 2026" for a business date. */
export function dayLabel(date: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${date}T00:00:00Z`));
}

function whenLabel(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone,
  }).format(at);
}

/** One sentence on what the alert found, from its evidence (the message's "detail"). */
export function alertDetail(
  alert: { ruleCode: string; evidence: unknown },
  subject: string | null,
  currency: string,
): string {
  const e = (alert.evidence ?? {}) as Record<string, unknown>;
  const who = subject ?? 'someone';
  switch (alert.ruleCode) {
    case 'REVERSAL_PATTERN':
      return `${str(e['reversals'])} reversals totalling ${money(minor(e['totalMinor']), currency)} by ${who}.`;
    case 'RATE_OVERRIDE':
      return `Room ${str(e['room']) || '?'}, night of ${str(e['night'])}: ${money(minor(e['amountMinor']), currency)} against a floor of ${money(minor(e['floorMinor']), currency)}.`;
    case 'SHIFT_VARIANCE': {
      const lines = Array.isArray(e['lines']) ? (e['lines'] as Record<string, unknown>[]) : [];
      const worst = lines.reduce<Record<string, unknown> | null>((a, l) => {
        const v = minor(l['varianceMinor']);
        const abs = (n: bigint) => (n < 0n ? -n : n);
        return !a || abs(v) > abs(minor(a['varianceMinor'])) ? l : a;
      }, null);
      return worst
        ? `${who}'s ${str(worst['method']).toLowerCase().replaceAll('_', ' ')} count is off by ${money(minor(worst['varianceMinor']), str(worst['currency']) || currency)}.`
        : `${who}'s shift closed outside the tolerance.`;
    }
    case 'OCCUPIED_NO_FOLIO':
    case 'VACANT_IN_HOUSE':
      return `Room ${str(e['roomNumber']) || '?'}: housekeeping saw ${str(e['observed']).toLowerCase().replaceAll('_', ' ')}, the front office shows ${str(e['frontOffice']).toLowerCase()}.`;
    case 'UNMATCHED_TRANSFER':
      return `A transfer of ${money(minor(e['amountMinor']), str(e['currency']) || currency)}${
        str(e['reference']) ? ` (reference ${str(e['reference'])})` : ''
      } is not matched to a confirmed payment.`;
    default:
      return 'See the evidence in the app.';
  }
}

/** M6-09: an alert set to instant goes out as it is raised. */
export function instantAlertHandler(deps: NotifyDeps): EventHandler {
  return {
    name: 'leakage-instant',
    events: ['leakage.alert_raised'],
    async handle(event) {
      const id = event.payload['alertId'];
      if (event.payload['notify'] !== 'INSTANT' || typeof id !== 'string') return;
      const alert = await deps.db.leakageAlert.findUnique({
        where: { id },
        include: {
          subjectUser: { select: { name: true } },
          property: { select: { name: true, timeZone: true, baseCurrency: true } },
        },
      });
      if (!alert) return;
      const recipients = await recipientsWith(deps.db, {
        organisationId: event.organisationId,
        propertyId: alert.propertyId,
        permission: 'leakage.notify',
        exclude: alert.subjectUserId,
      });
      const vars = {
        property_name: alert.property.name,
        rule: LEAKAGE_ALERT_LABELS[alert.ruleCode] ?? alert.ruleCode,
        detail: alertDetail(alert, alert.subjectUser?.name ?? null, alert.property.baseCurrency),
        raised_at: whenLabel(alert.raisedAt, alert.property.timeZone),
      };
      await deps.db.$transaction(async (tx) => {
        for (const r of recipients) {
          await queueMessage(tx, {
            organisationId: event.organisationId,
            propertyId: alert.propertyId,
            channel: 'WHATSAPP',
            templateCode: 'LEAKAGE_ALERT',
            recipient: r.phone,
            vars,
            ref: `leakage_alert:${alert.id}`,
          });
        }
      });
      if (recipients.length === 0) {
        deps.logger.warn({ alertId: alert.id }, 'Instant leakage alert: nobody with a phone');
      }
    },
  };
}

const percent = (bps: number) => `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 1)}%`;

/** M4-15: the flash report when night audit closes the day. */
export function flashReportHandler(deps: NotifyDeps): EventHandler {
  return {
    name: 'flash-report',
    events: ['business_day.closed'],
    async handle(event) {
      const date = event.payload['businessDate'];
      const propertyId = event.propertyId;
      if (typeof date !== 'string' || !propertyId) return;
      const run = await deps.db.nightAuditRun.findUnique({
        where: {
          propertyId_businessDate: { propertyId, businessDate: new Date(`${date}T00:00:00Z`) },
        },
        include: { property: { select: { name: true, baseCurrency: true } } },
      });
      const flash = (run?.summary as { reports?: AuditReports } | null | undefined)?.reports?.flash;
      // A day closed without a night audit (the automatic rollover) has no flash report.
      if (!run || !flash) return;
      const currency = run.property.baseCurrency;
      const openAlerts = await deps.db.leakageAlert.count({
        where: { propertyId, status: 'OPEN' },
      });
      const payments = flash.paymentsByMethod.reduce((a, p) => a + BigInt(p.amountMinor), 0n);
      const vars = {
        property_name: run.property.name,
        business_date: dayLabel(date),
        occupancy: percent(flash.occupancyBps),
        rooms_sold: String(flash.roomsSold),
        room_revenue: money(BigInt(flash.roomRevenueMinor), currency),
        adr: money(BigInt(flash.adrMinor), currency),
        revpar: money(BigInt(flash.revparMinor), currency),
        payments: money(payments, currency),
        open_alerts: String(openAlerts),
      };
      const recipients = await recipientsWith(deps.db, {
        organisationId: event.organisationId,
        propertyId,
        permission: 'report.flash',
      });
      await deps.db.$transaction(async (tx) => {
        for (const r of recipients) {
          await queueMessage(tx, {
            organisationId: event.organisationId,
            propertyId,
            channel: 'WHATSAPP',
            templateCode: 'FLASH_REPORT',
            recipient: r.phone,
            vars,
            ref: `flash_report:${propertyId}:${date}`,
          });
        }
      });
    },
  };
}
