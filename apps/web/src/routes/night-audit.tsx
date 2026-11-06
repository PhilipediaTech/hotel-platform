import { NIGHT_AUDIT_STEPS, type NightAuditItem } from '@hotel/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router';
import type { z } from 'zod';
import { ME_QUERY_KEY, useSession } from '../app/session.ts';
import { Alert } from '../components/ui/alert.tsx';
import { Button } from '../components/ui/button.tsx';
import { api } from '../lib/api.ts';
import { errorMessage } from '../lib/form.ts';
import { PdfError, usePdf } from '../lib/pdf.tsx';
import { useFormats } from './reservations.tsx';
import nightAuditStrings from '../i18n/en/night-audit.json';
import { registerStrings } from '../i18n/index.ts';

registerStrings(nightAuditStrings);

// S15 Night audit (PRD M4 rule 8; T-073): the ten steps of tonight's run with their status,
// the exceptions to resolve (with a link to where they are resolved), run and resume, and the
// closed day's reports to download once step 9 has kept them.

type Run = z.output<typeof NightAuditItem>;
type Step = Run['steps'][number];
type Exception = Step['exceptions'][number];

const STATUS_TONE: Record<Step['status'], string> = {
  PENDING: 'bg-surface-muted text-text-muted',
  DONE: 'bg-success-subtle text-success',
  SKIPPED: 'bg-surface-muted text-text-muted',
  BLOCKED: 'bg-critical-subtle text-critical',
  FAILED: 'bg-critical-subtle text-critical',
};

/** Where an exception is resolved. */
function fixLink(e: Exception): string | null {
  if (e.shiftId) return '/shift';
  if (e.type === 'DUE_OUT' && e.stayId) return `/stays/${e.stayId}/check-out`;
  if (e.reservationId) return `/reservations/${e.reservationId}`;
  if (e.folioId) return `/folios/${e.folioId}`;
  return null;
}

export function NightAuditPage() {
  const { t } = useTranslation();
  const f = useFormats();
  const queryClient = useQueryClient();
  const { currentPropertyId } = useSession();
  const [params] = useSearchParams();
  const exceptionsOnly = params.get('view') === 'exceptions';
  const day = useQuery({
    queryKey: ['night-audit', currentPropertyId ?? '', 'day'],
    queryFn: () => api.call('getBusinessDay', {}),
  });
  const runId = day.data?.nightAuditId ?? null;
  const run = useQuery({
    queryKey: ['night-audit', currentPropertyId ?? '', 'run', runId ?? ''],
    queryFn: () => api.call('getNightAudit', { params: { nightAuditId: runId ?? '' } }),
    enabled: runId !== null,
  });
  const done = (result: Run) => {
    queryClient.setQueryData(['night-audit', currentPropertyId ?? '', 'run', result.id], result);
    if (result.status === 'COMPLETED') {
      // The day moved on: the business date chip and the new day.
      void queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY });
    }
    void queryClient.invalidateQueries({ queryKey: ['night-audit'] });
  };
  const start = useMutation({
    mutationFn: (businessDate: string) => api.call('startNightAudit', { body: { businessDate } }),
    onSuccess: done,
  });
  const resume = useMutation({
    mutationFn: (id: string) => api.call('resumeNightAudit', { params: { nightAuditId: id } }),
    onSuccess: done,
  });
  // The run just finished closes its day: show it until the page is left.
  const shown: Run | undefined = resume.data ?? start.data ?? run.data;
  const error = day.error ?? run.error ?? start.error ?? resume.error;
  const steps = shown?.steps ?? [];
  const visible = exceptionsOnly ? steps.filter((s) => s.exceptions.length > 0) : steps;
  return (
    <section className="max-w-4xl">
      <h1 className="text-xl font-semibold">{t('nightAudit.title')}</h1>
      {day.data && (
        <p className="mt-1 text-sm text-text-muted">
          {t('nightAudit.businessDate', { date: f.date(day.data.date) })}
        </p>
      )}
      {error && (
        <Alert tone="critical" className="mt-3">
          {errorMessage(error)}
        </Alert>
      )}
      {day.data && !shown && (
        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-md border border-border bg-surface p-4">
          <p className="text-sm">{t('nightAudit.ready', { date: f.date(day.data.date) })}</p>
          <Button
            disabled={start.isPending}
            onClick={() => day.data && start.mutate(day.data.date)}
          >
            {start.isPending ? t('nightAudit.running') : t('nightAudit.run')}
          </Button>
        </div>
      )}
      {shown && (
        <>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            {shown.status === 'COMPLETED' ? (
              <Alert tone="success" className="w-full">
                {t('nightAudit.completed', { date: f.date(shown.businessDate) })}
              </Alert>
            ) : (
              <>
                {shown.error && (
                  <Alert tone="critical" className="w-full">
                    {shown.error}
                  </Alert>
                )}
                <Button disabled={resume.isPending} onClick={() => resume.mutate(shown.id)}>
                  {resume.isPending
                    ? t('nightAudit.running')
                    : t('nightAudit.resume', { step: shown.currentStep })}
                </Button>
              </>
            )}
          </div>
          {exceptionsOnly && visible.length === 0 && (
            <p className="mt-4 text-sm text-text-muted">{t('nightAudit.noExceptions')}</p>
          )}
          {shown.reports.length > 0 && <Reports run={shown} />}
          <ol className="mt-4 flex flex-col gap-2" aria-label={t('nightAudit.steps')}>
            {visible.map((s) => (
              <StepRow key={s.step} step={s} current={shown.currentStep === s.step} />
            ))}
          </ol>
        </>
      )}
    </section>
  );
}

function Reports({ run }: { run: Run }) {
  const { t } = useTranslation();
  const pdf = usePdf();
  return (
    <div className="mt-4 rounded-md border border-border bg-surface p-3">
      <h2 className="text-sm font-semibold">{t('nightAudit.reports')}</h2>
      <div className="mt-2 flex flex-wrap gap-2">
        {run.reports.map((report) => (
          <Button
            key={report}
            variant="secondary"
            size="sm"
            disabled={pdf.busy}
            onClick={() =>
              void pdf.open(
                () =>
                  api.download('getNightAuditReport', {
                    params: { nightAuditId: run.id, report },
                  }),
                `${report}-${run.businessDate}.pdf`,
              )
            }
          >
            {t(`nightAudit.report.${report}`)}
          </Button>
        ))}
      </div>
      <PdfError error={pdf.error} />
    </div>
  );
}

function StepRow({ step, current }: { step: Step; current: boolean }) {
  const { t } = useTranslation();
  const label = NIGHT_AUDIT_STEPS.find((s) => s.step === step.step)?.label ?? step.name;
  return (
    <li
      className={`rounded-md border bg-surface p-3 ${current ? 'border-brand' : 'border-border'}`}
      aria-current={current ? 'step' : undefined}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">
          {step.step}. {t(`nightAudit.step.${step.name}`, { defaultValue: label })}
        </span>
        <span className={`rounded px-2 py-0.5 text-xs font-medium ${STATUS_TONE[step.status]}`}>
          {t(`nightAudit.status.${step.status}`)}
        </span>
      </div>
      {step.exceptions.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1 text-sm">
          {step.exceptions.map((e, i) => {
            const to = fixLink(e);
            return (
              <li key={`${e.type}-${i}`} className="flex flex-wrap items-baseline gap-2">
                <span
                  className={`rounded px-1.5 text-xs ${e.blocking ? 'bg-critical-subtle text-critical' : 'bg-surface-muted text-text-muted'}`}
                >
                  {e.blocking ? t('nightAudit.mustResolve') : t('nightAudit.forReview')}
                </span>
                <span>{e.message}</span>
                {to && (
                  <Link to={to} className="text-brand underline">
                    {t('nightAudit.open')}
                  </Link>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );
}
