import {
  IMPORT_COLUMNS,
  IMPORT_KINDS,
  templateCsv,
  type ImportJobItem,
  type ImportKind,
} from '@hotel/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, FileUp } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import type { z } from 'zod';
import { useSession } from '../../app/session.ts';
import { Alert } from '../../components/ui/alert.tsx';
import { Button } from '../../components/ui/button.tsx';
import { api, ApiError } from '../../lib/api.ts';
import { cn } from '../../lib/cn.ts';
import { errorMessage } from '../../lib/form.ts';
import { FileUploadError, uploadFile } from '../../lib/files.ts';

// S03 Imports (PRD M1-03; T-034): download a template, upload the filled file, read the check
// report, then apply it. Nothing is written until the user confirms.

type Job = z.output<typeof ImportJobItem>;

/** How long to wait for the scan of an uploaded file before giving up. */
const SCAN_TRIES = 40;
const SCAN_WAIT_MS = 3000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Check the uploaded file; while the scan runs the API says FILE_NOT_READY, so wait. */
async function checkWhenScanned(kind: ImportKind, fileId: string, wait = sleep): Promise<Job> {
  for (let i = 0; ; i++) {
    try {
      return await api.call('validateImport', { body: { kind, fileId } });
    } catch (err) {
      const pending =
        err instanceof ApiError &&
        err.code === 'FILE_NOT_READY' &&
        err.details?.['scan'] === 'PENDING';
      if (!pending || i >= SCAN_TRIES) throw err;
      await wait(SCAN_WAIT_MS);
    }
  }
}

function downloadTemplate(kind: ImportKind) {
  const blob = new Blob([templateCsv(kind)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${kind.toLowerCase()}-template.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export function ImportsPage({ wait = sleep }: { wait?: (ms: number) => Promise<unknown> }) {
  const { t } = useTranslation();
  const { currentPropertyId } = useSession();
  const queryClient = useQueryClient();
  const [search, setSearch] = useSearchParams();
  const [kind, setKind] = useState<ImportKind>('ROOMS');
  const jobId = search.get('job');
  const job = useQuery({
    queryKey: ['imports', currentPropertyId ?? '', jobId],
    queryFn: () => api.call('getImport', { params: { importId: jobId ?? '' } }),
    enabled: jobId !== null,
  });
  const [stage, setStage] = useState<'idle' | 'uploading' | 'checking'>('idle');
  const check = useMutation({
    mutationFn: async (file: File) => {
      setStage('uploading');
      const fileId = await uploadFile('ImportJob', file);
      setStage('checking');
      return checkWhenScanned(kind, fileId, wait);
    },
    onSuccess: (checked) => {
      queryClient.setQueryData(['imports', currentPropertyId ?? '', checked.id], checked);
      setSearch({ job: checked.id });
    },
    onSettled: () => setStage('idle'),
  });
  const apply = useMutation({
    mutationFn: (id: string) => api.call('applyImport', { params: { importId: id } }),
    onSuccess: (applied) => {
      queryClient.setQueryData(['imports', currentPropertyId ?? '', applied.id], applied);
      // Rooms, types and rates changed; so may the setup checklist.
      void queryClient.invalidateQueries({ queryKey: ['rooms', currentPropertyId ?? ''] });
      void queryClient.invalidateQueries({ queryKey: ['rates', currentPropertyId ?? ''] });
      void queryClient.invalidateQueries({ queryKey: ['setup', currentPropertyId ?? ''] });
    },
  });
  const current = jobId ? job.data : undefined;
  const uploadError =
    check.error instanceof FileUploadError && check.error.reason === 'UNSUPPORTED_TYPE'
      ? t('imports.fileType')
      : check.error
        ? errorMessage(check.error)
        : null;

  return (
    <section className="max-w-4xl">
      <h1 className="text-xl font-semibold">{t('imports.title')}</h1>
      <p className="mt-1 text-sm text-text-muted">{t('imports.intro')}</p>

      <fieldset className="mt-4">
        <legend className="mb-2 text-sm font-medium">{t('imports.what')}</legend>
        <div className="flex flex-wrap gap-4">
          {IMPORT_KINDS.map((k) => (
            <label key={k} className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="import-kind"
                checked={kind === k}
                onChange={() => setKind(k)}
              />
              {t(`imports.kinds.${k}`)}
            </label>
          ))}
        </div>
        <p className="mt-1 text-xs text-text-muted">{t('imports.later')}</p>
      </fieldset>

      <ol className="mt-4 flex flex-col gap-4">
        <li className="rounded-md border border-border bg-surface p-4">
          <h2 className="font-medium">{t('imports.step1')}</h2>
          <p className="mt-1 text-sm text-text-muted">{t(`imports.help.${kind}`)}</p>
          <ul className="mt-2 flex flex-wrap gap-2 text-xs">
            {IMPORT_COLUMNS[kind].map((c) => (
              <li
                key={c.name}
                className={cn(
                  'rounded bg-surface-muted px-2 py-0.5 font-mono',
                  c.required && 'font-semibold',
                )}
              >
                {c.name}
                {c.required ? ' *' : ''}
              </li>
            ))}
          </ul>
          <Button
            size="sm"
            variant="secondary"
            className="mt-3"
            onClick={() => downloadTemplate(kind)}
          >
            <Download aria-hidden className="mr-2 size-4" />
            {t('imports.template')}
          </Button>
        </li>
        <li className="rounded-md border border-border bg-surface p-4">
          <h2 className="font-medium">{t('imports.step2')}</h2>
          <label className="mt-2 inline-flex cursor-pointer items-center gap-2 rounded-md border border-dashed border-border px-4 py-3 text-sm">
            <FileUp aria-hidden className="size-4" />
            {stage === 'uploading'
              ? t('imports.uploading')
              : stage === 'checking'
                ? t('imports.checking')
                : t('imports.choose')}
            <input
              type="file"
              className="sr-only"
              accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              disabled={stage !== 'idle'}
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (file) check.mutate(file);
              }}
            />
          </label>
          {uploadError && (
            <Alert tone="critical" className="mt-2">
              {uploadError}
            </Alert>
          )}
        </li>
      </ol>

      {job.error && (
        <Alert tone="critical" className="mt-4">
          {errorMessage(job.error)}
        </Alert>
      )}
      {current && (
        <Report
          job={current}
          applying={apply.isPending}
          applyError={apply.error}
          onApply={() => apply.mutate(current.id)}
        />
      )}
    </section>
  );
}

function Report({
  job,
  applying,
  applyError,
  onApply,
}: {
  job: Job;
  applying: boolean;
  applyError: unknown;
  onApply: () => void;
}) {
  const { t } = useTranslation();
  const r = job.report;
  const summary = Object.entries(r.summary)
    .filter(([, n]) => n > 0)
    .map(([key, n]) => t(`imports.summary.${key}`, { count: n }));
  const columns = r.preview[0] ? Object.keys(r.preview[0]) : [];
  const changed =
    applyError instanceof ApiError
      ? (applyError.details?.['errors'] as Job['report']['errors'] | undefined)
      : undefined;

  return (
    <section
      aria-labelledby="import-report"
      className="mt-6 rounded-md border border-border bg-surface p-4"
    >
      <h2 id="import-report" className="font-semibold">
        {t('imports.report', { kind: t(`imports.kinds.${job.kind}`), rows: r.total })}
      </h2>
      {job.status === 'APPLIED' ? (
        <Alert tone="success" className="mt-2">
          {t('imports.applied')}{' '}
          {Object.entries(r.applied ?? {})
            .map(([key, n]) => t(`imports.summary.${key}`, { count: n }))
            .join(' · ')}
        </Alert>
      ) : job.status === 'FAILED' ? (
        <Alert tone="critical" className="mt-2">
          {t('imports.failed', { count: r.errorCount })}
        </Alert>
      ) : (
        <Alert tone="info" className="mt-2">
          {t('imports.ready')} {summary.join(' · ')}
        </Alert>
      )}

      {r.errors.length > 0 && (
        <>
          <table aria-label={t('imports.errors')} className="mt-3 w-full text-left text-sm">
            <thead className="border-b border-border text-text-muted">
              <tr>
                <th className="p-2 font-medium">{t('imports.row')}</th>
                <th className="p-2 font-medium">{t('imports.column')}</th>
                <th className="p-2 font-medium">{t('imports.problem')}</th>
              </tr>
            </thead>
            <tbody>
              {r.errors.map((e, i) => (
                <tr key={i} className="border-b border-border last:border-0">
                  <td className="p-2 tabular-nums">{e.row ?? '–'}</td>
                  <td className="p-2 font-mono text-xs">{e.column ?? '–'}</td>
                  <td className="p-2">{e.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {r.errorCount > r.errors.length && (
            <p className="mt-1 text-xs text-text-muted">
              {t('imports.moreErrors', { shown: r.errors.length, count: r.errorCount })}
            </p>
          )}
        </>
      )}

      {job.status === 'VALIDATED' && columns.length > 0 && (
        <div className="mt-3 overflow-x-auto">
          <table aria-label={t('imports.preview')} className="text-sm">
            <thead className="border-b border-border text-text-muted">
              <tr>
                {columns.map((c) => (
                  <th key={c} className="p-2 text-left font-medium">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {r.preview.map((row, i) => (
                <tr key={i} className="border-b border-border last:border-0">
                  {columns.map((c) => {
                    const v = row[c];
                    return (
                      <td key={c} className="p-2">
                        {Array.isArray(v)
                          ? v.join(', ')
                          : v === null || v === undefined
                            ? ''
                            : String(v)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          {r.total > r.preview.length && (
            <p className="mt-1 text-xs text-text-muted">
              {t('imports.previewMore', { shown: r.preview.length, count: r.total })}
            </p>
          )}
        </div>
      )}

      {applyError !== null && applyError !== undefined && (
        <Alert tone="critical" className="mt-3">
          {errorMessage(applyError)}
          {changed && (
            <ul className="mt-1 list-inside list-disc">
              {changed.map((e, i) => (
                <li key={i}>{t('imports.rowProblem', { row: e.row, message: e.message })}</li>
              ))}
            </ul>
          )}
        </Alert>
      )}
      {job.status === 'VALIDATED' && (
        <Button className="mt-3" disabled={applying} onClick={onApply}>
          {t('imports.apply', { count: r.total })}
        </Button>
      )}
    </section>
  );
}
