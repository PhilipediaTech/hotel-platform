import type {
  CashierReport,
  OperationsReport,
  OpsFigures,
  DashboardReport,
  FlashReport,
  TaxReport,
  TrialBalanceReport,
} from '@hotel/shared';
import { useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { z } from 'zod';
import { useSession } from '../app/session.ts';
import { Alert } from '../components/ui/alert.tsx';
import { Button } from '../components/ui/button.tsx';
import { Input } from '../components/ui/input.tsx';
import { Label } from '../components/ui/label.tsx';
import reportStrings from '../i18n/en/reports.json';
import { registerStrings } from '../i18n/index.ts';
import { Pace } from './report-pace.tsx';
import { api } from '../lib/api.ts';
import { cn } from '../lib/cn.ts';
import { errorMessage } from '../lib/form.ts';
import { PdfError, usePdf } from '../lib/pdf.tsx';
import { useFormats } from './reservations.tsx';

registerStrings(reportStrings);

// S28 Reports (PRD M12-01–M12-03, M12-06; T-092). Each report the role holds, the closed
// day or period to show, the figures with their definitions (M12 rule), and CSV or PDF for
// holders of report.export.

type Tab = 'dashboard' | 'flash' | 'trial' | 'cashier' | 'tax' | 'operations' | 'pace';
const TABS: { id: Tab; permission: string }[] = [
  { id: 'dashboard', permission: 'report.dashboard' },
  { id: 'flash', permission: 'report.audit' },
  { id: 'trial', permission: 'report.audit' },
  { id: 'cashier', permission: 'report.audit' },
  { id: 'tax', permission: 'report.tax' },
  { id: 'operations', permission: 'report.ops' },
  // Pickup and pace (T-165).
  { id: 'pace', permission: 'report.dashboard' },
];
const OPERATION = {
  dashboard: 'getDashboardReport',
  flash: 'getFlashReport',
  trial: 'getTrialBalanceReport',
  cashier: 'getCashierReport',
  tax: 'getTaxReport',
  operations: 'getOperationsReport',
} as const;

const pct = (bps: number) => `${(bps / 100).toFixed(1)}%`;

function useKey(...parts: string[]) {
  const { currentPropertyId } = useSession();
  return ['reports', currentPropertyId ?? '', ...parts];
}

function Rows({ rows, label }: { rows: [string, ReactNode][]; label: string }) {
  return (
    <table className="w-full max-w-xl text-sm" aria-label={label}>
      <tbody>
        {rows.map(([k, v]) => (
          <tr key={k} className="border-b border-border">
            <th scope="row" className="py-1 pr-4 text-left font-normal text-text-muted">
              {k}
            </th>
            <td className="py-1 text-right font-medium">{v}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-4">
      <h3 className="mb-1 font-semibold">{title}</h3>
      {children}
    </section>
  );
}

function Definitions({ text }: { text: string }) {
  const { t } = useTranslation();
  return (
    <details className="mt-4 text-sm">
      <summary className="cursor-pointer text-text-muted">{t('reports.definitions')}</summary>
      <p className="mt-1 text-text-muted">{text}</p>
    </details>
  );
}

/** CSV is saved; PDF opens in a new tab (as other documents do). */
function ExportButtons({
  tab,
  query,
  withPdf = true,
}: {
  /** Reports with CSV and PDF (pickup and pace has none). */
  tab: keyof typeof OPERATION;
  query: Record<string, string>;
  withPdf?: boolean;
}) {
  const { t } = useTranslation();
  const session = useSession();
  const pdf = usePdf();
  const [error, setError] = useState<unknown>(null);
  if (!session.permissions.includes('report.export')) {
    return <p className="text-xs text-text-muted">{t('reports.noExport')}</p>;
  }
  const download = (format: 'csv' | 'pdf') =>
    api.download(OPERATION[tab], { query: { ...query, format } });
  const saveCsv = async () => {
    setError(null);
    try {
      const url = URL.createObjectURL(await download('csv'));
      const link = document.createElement('a');
      link.href = url;
      link.download = `${tab}.csv`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      setError(err);
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant="secondary" onClick={() => void saveCsv()}>
        {t('reports.csv')}
      </Button>
      {withPdf && (
        <Button
          size="sm"
          variant="secondary"
          disabled={pdf.busy}
          onClick={() => void pdf.open(() => download('pdf'), `${tab}.pdf`)}
        >
          {t('reports.pdf')}
        </Button>
      )}
      {error ? <Alert tone="critical">{errorMessage(error)}</Alert> : null}
      <PdfError error={pdf.error} />
    </div>
  );
}

function Dashboard() {
  const { t } = useTranslation();
  const f = useFormats();
  const q = useQuery({
    queryKey: useKey('dashboard'),
    queryFn: () => api.call('getDashboardReport', { query: {} }),
  });
  if (q.error) return <Alert tone="critical">{errorMessage(q.error)}</Alert>;
  const d: z.output<typeof DashboardReport> | undefined = q.data;
  if (!d) return null;
  const m = d.monthToDate;
  return (
    <div>
      <ExportButtons tab="dashboard" query={{}} />
      <div className="mt-2 grid gap-4 lg:grid-cols-2">
        <Section title={t('reports.today', { date: f.date(d.businessDate) })}>
          <Rows
            label={t('reports.today', { date: d.businessDate })}
            rows={[
              [t('reports.occupancy'), pct(d.today.occupancyBps)],
              [t('reports.roomsOccupied'), `${d.today.roomsOccupied} / ${d.today.roomsAvailable}`],
              [t('reports.revenue'), f.money(d.today.revenueMinor)],
              ...d.today.revenueByGroup.map((g): [string, string] => [
                `· ${g.group}`,
                f.money(g.amountMinor),
              ]),
            ]}
          />
        </Section>
        <Section title={t('reports.month')}>
          {m.through ? (
            <>
              <p className="mb-1 text-xs text-text-muted">
                {t('reports.monthThrough', {
                  from: f.date(m.from),
                  through: f.date(m.through),
                  days: m.days,
                })}
              </p>
              <Rows
                label={t('reports.month')}
                rows={[
                  [t('reports.occupancy'), pct(m.occupancyBps)],
                  [t('reports.roomsSold'), String(m.roomsSold)],
                  [t('reports.roomRevenue'), f.money(m.roomRevenueMinor)],
                  [t('reports.adr'), f.money(m.adrMinor)],
                  [t('reports.revpar'), f.money(m.revparMinor)],
                  ...m.paymentsByMethod.map((x): [string, string] => [
                    `· ${x.method} (${x.count})`,
                    f.money(x.amountMinor),
                  ]),
                ]}
              />
            </>
          ) : (
            <p className="text-sm text-text-muted">{t('reports.monthNone')}</p>
          )}
        </Section>
        <Section title={t('reports.balances')}>
          <Rows
            label={t('reports.balances')}
            rows={[
              [t('reports.guestLedger'), f.money(d.balances.guestLedgerMinor)],
              [t('reports.depositLedger'), f.money(d.balances.depositLedgerMinor)],
              [t('reports.openFolios'), String(d.balances.openFolios)],
            ]}
          />
        </Section>
        <Section title={t('reports.alerts')}>
          <Rows
            label={t('reports.alerts')}
            rows={[
              [t('reports.alerts'), String(d.alerts.open)],
              ...d.alerts.byRule.map((a): [string, string] => [`· ${a.rule}`, String(a.open)]),
            ]}
          />
        </Section>
      </div>
      <Definitions text={d.definitions} />
    </div>
  );
}

function ClosedDay({ tab }: { tab: 'flash' | 'trial' | 'cashier' }) {
  const { t } = useTranslation();
  const [input, setInput] = useState('');
  const [date, setDate] = useState('');
  const query = date ? { date } : {};
  const q = useQuery({
    queryKey: useKey(tab, date),
    queryFn: () => api.call(OPERATION[tab], { query }),
  });
  const data = q.data;
  return (
    <div>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setDate(input);
        }}
      >
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${tab}-date`}>{t('reports.date')}</Label>
          <Input
            id={`${tab}-date`}
            type="date"
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
        </div>
        <Button type="submit" variant="secondary">
          {t('reports.show')}
        </Button>
        {date && (
          <Button
            variant="ghost"
            onClick={() => {
              setInput('');
              setDate('');
            }}
          >
            {t('reports.lastClosed')}
          </Button>
        )}
      </form>
      {q.error && (
        <Alert tone="critical" className="mt-3">
          {errorMessage(q.error)}
        </Alert>
      )}
      {data && (
        <div className="mt-3">
          <ExportButtons tab={tab} query={{ date: data.businessDate }} />
          {tab === 'flash' && <FlashView r={data as z.output<typeof FlashReport>} />}
          {tab === 'trial' && <TrialView r={data as z.output<typeof TrialBalanceReport>} />}
          {tab === 'cashier' && <CashierView r={data as z.output<typeof CashierReport>} />}
          <Definitions text={data.definitions} />
        </div>
      )}
    </div>
  );
}

function FlashView({ r }: { r: z.output<typeof FlashReport> }) {
  const { t } = useTranslation();
  const f = useFormats();
  const pdf = usePdf();
  const other = (report: 'high-balance' | 'discrepancy') =>
    void pdf.open(
      () =>
        api.download('getNightAuditReport', { params: { nightAuditId: r.nightAuditId, report } }),
      `${report}-${r.businessDate}.pdf`,
    );
  return (
    <>
      <Section title={f.date(r.businessDate)}>
        <Rows
          label={t('reports.tabs.flash')}
          rows={[
            [t('reports.occupancy'), pct(r.occupancyBps)],
            [t('reports.roomsAvailable'), String(r.roomsAvailable)],
            [t('reports.outOfOrder'), String(r.outOfOrder)],
            [t('reports.roomsSold'), String(r.roomsSold)],
            [t('reports.roomRevenue'), f.money(r.roomRevenueMinor)],
            [t('reports.dayUse'), `${f.money(r.dayUseRevenueMinor)} (${r.dayUses})`],
            [t('reports.adr'), f.money(r.adrMinor)],
            [t('reports.revpar'), f.money(r.revparMinor)],
            [t('reports.arrivals'), String(r.arrivals)],
            [t('reports.departures'), String(r.departures)],
            [t('reports.noShows'), String(r.noShows)],
          ]}
        />
      </Section>
      <Section title={t('reports.byGroup')}>
        <Rows
          label={t('reports.byGroup')}
          rows={r.revenueByGroup.map((g): [string, string] => [g.group, f.money(g.amountMinor)])}
        />
      </Section>
      <Section title={t('reports.byMethod')}>
        <Rows
          label={t('reports.byMethod')}
          rows={r.paymentsByMethod.map((x): [string, string] => [
            `${x.method} (${x.count})`,
            f.money(x.amountMinor),
          ])}
        />
      </Section>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" variant="ghost" disabled={pdf.busy} onClick={() => other('high-balance')}>
          {t('reports.highBalance')}
        </Button>
        <Button size="sm" variant="ghost" disabled={pdf.busy} onClick={() => other('discrepancy')}>
          {t('reports.discrepancy')}
        </Button>
      </div>
      <PdfError error={pdf.error} />
    </>
  );
}

function TrialView({ r }: { r: z.output<typeof TrialBalanceReport> }) {
  const { t } = useTranslation();
  const f = useFormats();
  return (
    <Section title={f.date(r.businessDate)}>
      <Rows
        label={t('reports.tabs.trial')}
        rows={[
          [t('reports.trial.charges'), f.money(r.chargesMinor)],
          [t('reports.trial.payments'), f.money(r.paymentsMinor)],
          [t('reports.trial.ar'), f.money(r.arTransfersMinor)],
          [t('reports.trial.guestOpen'), f.money(r.guestLedgerOpeningMinor)],
          [t('reports.trial.guestClose'), f.money(r.guestLedgerClosingMinor)],
          [t('reports.trial.depositOpen'), f.money(r.depositLedgerOpeningMinor)],
          [t('reports.trial.depositClose'), f.money(r.depositLedgerClosingMinor)],
          [t('reports.trial.difference'), f.money(r.differenceMinor)],
        ]}
      />
      <Alert tone={r.balanced ? 'success' : 'critical'} className="mt-2 max-w-xl">
        {r.balanced ? t('reports.trial.balanced') : t('reports.trial.unbalanced')}
      </Alert>
    </Section>
  );
}

function CashierView({ r }: { r: z.output<typeof CashierReport> }) {
  const { t } = useTranslation();
  const f = useFormats();
  if (r.shifts.length === 0) {
    return <p className="mt-3 text-sm text-text-muted">{t('reports.cashier.none')}</p>;
  }
  return (
    <>
      {r.shifts.map((sh) => (
        <Section
          key={`${sh.cashier}-${sh.openedAt}`}
          title={`${sh.cashier} (${sh.status.toLowerCase()})`}
        >
          <Rows
            label={sh.cashier}
            rows={[
              ...sh.payments.map((p): [string, string] => [
                `${p.method} (${p.count})`,
                f.money(p.amountMinor),
              ]),
              ...sh.counts.map((c): [string, string] => [
                `${c.method}: ${t('reports.cashier.expected')} ${f.money(c.expectedMinor)}, ${t('reports.cashier.counted')} ${f.money(c.countedMinor)}`,
                `${t('reports.cashier.variance')} ${f.money(c.varianceMinor)}`,
              ]),
            ]}
          />
        </Section>
      ))}
    </>
  );
}

function monthStart(date: string) {
  return `${date.slice(0, 8)}01`;
}

function Tax() {
  const { t } = useTranslation();
  const session = useSession();
  const f = useFormats();
  const today = session.businessDate ?? new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState(monthStart(today));
  const [to, setTo] = useState(today);
  const [period, setPeriod] = useState({ from: monthStart(today), to: today });
  const q = useQuery({
    queryKey: useKey('tax', period.from, period.to),
    queryFn: () => api.call('getTaxReport', { query: period }),
  });
  const r: z.output<typeof TaxReport> | undefined = q.data;
  return (
    <div>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setPeriod({ from, to });
        }}
      >
        <div className="flex flex-col gap-1">
          <Label htmlFor="tax-from">{t('reports.from')}</Label>
          <Input id="tax-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="tax-to">{t('reports.to')}</Label>
          <Input id="tax-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <Button type="submit" variant="secondary">
          {t('reports.show')}
        </Button>
      </form>
      {q.error && (
        <Alert tone="critical" className="mt-3">
          {errorMessage(q.error)}
        </Alert>
      )}
      {r && (
        <div className="mt-3">
          <ExportButtons tab="tax" query={period} />
          <p className="mt-2 text-sm text-text-muted">
            {r.through
              ? t('reports.tax.through', { date: f.date(r.through) })
              : t('reports.tax.noneClosed')}
          </p>
          {r.through && r.authorities.length === 0 && (
            <p className="mt-2 text-sm text-text-muted">{t('reports.tax.empty')}</p>
          )}
          {r.authorities.map((a) => (
            <Section key={a.authority} title={a.authority}>
              <table className="w-full max-w-2xl text-sm" aria-label={a.authority}>
                <thead>
                  <tr className="border-b border-border text-left text-text-muted">
                    <th className="py-1 font-normal">{t('reports.tax.tax')}</th>
                    <th className="py-1 text-right font-normal">{t('reports.tax.rate')}</th>
                    <th className="py-1 text-right font-normal">{t('reports.tax.taxable')}</th>
                    <th className="py-1 text-right font-normal">{t('reports.amount')}</th>
                  </tr>
                </thead>
                <tbody>
                  {a.rules.map((rule) => (
                    <tr key={rule.taxRuleId} className="border-b border-border">
                      <td className="py-1">{rule.name}</td>
                      <td className="py-1 text-right">
                        {rule.ratesBps.map((b) => `${(b / 100).toFixed(2)}%`).join(' / ')}
                      </td>
                      <td className="py-1 text-right">{f.money(rule.taxableMinor)}</td>
                      <td className="py-1 text-right font-medium">{f.money(rule.taxMinor)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Section>
          ))}
          {r.authorities.length > 0 && (
            <p className="mt-3 font-semibold">
              {t('reports.tax.total')}: {f.money(r.totalTaxMinor)}
            </p>
          )}
          <Definitions text={r.definitions} />
        </div>
      )}
    </div>
  );
}

// ── Operations (PRD M6-12; M6 rule 5: no staff ranking; T-135) ──────────────────────────

function daysBefore(date: string, days: number) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

type OpsRow = {
  key: string;
  name: string;
  figures: z.output<typeof OpsFigures>;
  extra?: ReactNode;
};

function OpsTable({ label, rows }: { label: string; rows: OpsRow[] }) {
  const { t } = useTranslation();
  const time = (m: number | null) => {
    if (m === null) return t('reports.ops.none');
    if (m >= 120) return t('reports.ops.hours', { value: (m / 60).toFixed(1) });
    return t('reports.ops.minutes', { value: m });
  };
  const rate = (b: number | null) => (b === null ? t('reports.ops.none') : pct(b));
  const withPattern = rows.some((r) => r.extra !== undefined);
  const head = (key: string) => (
    <th key={key} className="py-1 pr-2 text-right font-normal">
      {t(`reports.ops.${key}`)}
    </th>
  );
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[56rem] text-sm" aria-label={label}>
        <thead>
          <tr className="border-b border-border text-left text-text-muted">
            <th className="py-1 pr-2 font-normal">{t('reports.ops.scope')}</th>
            {[
              'created',
              'severity',
              'open',
              'overdue',
              'ack',
              'resolve',
              'reopen',
              'sla',
              'hold',
            ].map(head)}
            {withPattern && head('pattern')}
          </tr>
        </thead>
        <tbody>
          {rows.map(({ key, name, figures: f, extra }) => (
            <tr key={key} className="border-b border-border">
              <th scope="row" className="py-1 pr-2 text-left font-medium">
                {name}
              </th>
              <td className="py-1 pr-2 text-right">{f.created}</td>
              <td className="py-1 pr-2 text-right">
                {[
                  f.bySeverity.LOW,
                  f.bySeverity.NORMAL,
                  f.bySeverity.HIGH,
                  f.bySeverity.CRITICAL,
                ].join(' / ')}
              </td>
              <td className="py-1 pr-2 text-right">{f.open}</td>
              <td className={cn('py-1 pr-2 text-right', f.overdue > 0 && 'text-critical')}>
                {f.overdue}
              </td>
              <td className="py-1 pr-2 text-right">
                {time(f.ackMedianMinutes)} / {time(f.ackP90Minutes)}
              </td>
              <td className="py-1 pr-2 text-right">
                {time(f.resolveMedianMinutes)} / {time(f.resolveP90Minutes)}
              </td>
              <td className="py-1 pr-2 text-right">{rate(f.reopenRateBps)}</td>
              <td className="py-1 pr-2 text-right">{rate(f.slaMetBps)}</td>
              <td className="py-1 pr-2 text-right">{time(f.holdMinutes)}</td>
              {withPattern && <td className="py-1 text-right">{extra}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Operations() {
  const { t } = useTranslation();
  const session = useSession();
  const today = session.businessDate ?? new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState(daysBefore(today, 29));
  const [to, setTo] = useState(today);
  const [period, setPeriod] = useState({ from: daysBefore(today, 29), to: today });
  const q = useQuery({
    queryKey: useKey('operations', period.from, period.to),
    queryFn: () => api.call('getOperationsReport', { query: period }),
  });
  const r: z.output<typeof OperationsReport> | undefined = q.data;
  return (
    <div>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setPeriod({ from, to });
        }}
      >
        <div className="flex flex-col gap-1">
          <Label htmlFor="ops-from">{t('reports.from')}</Label>
          <Input id="ops-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="ops-to">{t('reports.to')}</Label>
          <Input id="ops-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <Button type="submit" variant="secondary">
          {t('reports.show')}
        </Button>
      </form>
      {q.error && (
        <Alert tone="critical" className="mt-3">
          {errorMessage(q.error)}
        </Alert>
      )}
      {r && (
        <div className="mt-3">
          <ExportButtons tab="operations" query={period} withPdf={false} />
          {r.totals.created === 0 ? (
            <p className="mt-2 text-sm text-text-muted">{t('reports.ops.empty')}</p>
          ) : (
            <>
              <Section title={t('reports.ops.byDepartment')}>
                <OpsTable
                  label={t('reports.ops.byDepartment')}
                  rows={[
                    { key: 'all', name: t('reports.ops.all'), figures: r.totals },
                    ...r.departments.map((d) => ({
                      key: d.departmentId,
                      name: d.name,
                      figures: d.figures,
                    })),
                  ]}
                />
              </Section>
              <Section title={t('reports.ops.byPerson')}>
                <p className="mb-2 text-sm text-text-muted">{t('reports.ops.personNote')}</p>
                <OpsTable
                  label={t('reports.ops.byPerson')}
                  rows={r.people.map((p) => ({
                    key: p.userId,
                    name: p.name,
                    figures: p.figures,
                    extra: (
                      <>
                        {[
                          p.pattern.NIGHT,
                          p.pattern.MORNING,
                          p.pattern.AFTERNOON,
                          p.pattern.EVENING,
                        ].join(' / ')}{' '}
                        <span className="text-text-muted">
                          ({t('reports.ops.days', { count: p.pattern.daysActive })})
                        </span>
                      </>
                    ),
                  }))}
                />
                {r.unassigned > 0 && (
                  <p className="mt-2 text-sm text-text-muted">
                    {t('reports.ops.unassigned', { count: r.unassigned })}
                  </p>
                )}
              </Section>
            </>
          )}
          <Definitions text={r.definitions} />
        </div>
      )}
    </div>
  );
}

export function ReportsPage() {
  const { t } = useTranslation();
  const session = useSession();
  const tabs = TABS.filter((x) => session.permissions.includes(x.permission));
  const [tab, setTab] = useState<Tab | undefined>(tabs[0]?.id);
  const current = tabs.find((x) => x.id === tab)?.id ?? tabs[0]?.id;
  return (
    <section className="max-w-6xl">
      <h1 className="text-xl font-semibold">{t('reports.title')}</h1>
      {tabs.length === 0 && <p className="mt-3 text-sm">{t('reports.none')}</p>}
      <div role="tablist" aria-label={t('reports.title')} className="mt-3 flex flex-wrap gap-1">
        {tabs.map((x) => (
          <button
            key={x.id}
            type="button"
            role="tab"
            aria-selected={current === x.id}
            className={cn(
              'rounded-md border border-border px-3 py-2 text-sm',
              current === x.id ? 'border-brand bg-brand-subtle' : 'bg-surface',
            )}
            onClick={() => setTab(x.id)}
          >
            {t(`reports.tabs.${x.id}`)}
          </button>
        ))}
      </div>
      <div role="tabpanel" className="mt-4">
        {current === 'dashboard' && <Dashboard />}
        {(current === 'flash' || current === 'trial' || current === 'cashier') && (
          <ClosedDay key={current} tab={current} />
        )}
        {current === 'tax' && <Tax />}
        {current === 'operations' && <Operations />}
        {current === 'pace' && <Pace />}
      </div>
    </section>
  );
}

/** S05 Manager dashboard (PRD M12-01; T-092): the dashboard report as the manager's home. */
export function DashboardPage() {
  const { t } = useTranslation();
  return (
    <section className="max-w-6xl">
      <h1 className="text-xl font-semibold">{t('reports.tabs.dashboard')}</h1>
      <div className="mt-4">
        <Dashboard />
      </div>
    </section>
  );
}
