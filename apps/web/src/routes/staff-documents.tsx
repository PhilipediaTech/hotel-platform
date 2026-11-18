import {
  STAFF_DOCUMENT_TYPES,
  type StaffDocumentRetention,
  type StaffDocumentType,
} from '@hotel/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSession } from '../app/session.ts';
import { Alert } from '../components/ui/alert.tsx';
import { Button } from '../components/ui/button.tsx';
import { Input } from '../components/ui/input.tsx';
import { Label } from '../components/ui/label.tsx';
import { api } from '../lib/api.ts';
import { uploadFile } from '../lib/files.ts';
import { errorMessage } from '../lib/form.ts';
import staffStrings from '../i18n/en/staff.json';
import { registerStrings } from '../i18n/index.ts';
import { useFormats } from './reservations.tsx';

registerStrings(staffStrings);

// S36 staff documents (PRD M7-09; T-140): contracts, guarantor forms, IDs and other papers on
// a staff record, for staff.docs only. A document opens through its own link (each look is
// audited by the API) and is deleted once its type's retention after the last day passes.

const selectClass = 'h-11 rounded-md border border-border bg-surface px-3 text-sm';

function useRoot() {
  const { currentPropertyId } = useSession();
  return ['staff-docs', currentPropertyId ?? ''];
}

export function StaffDocuments({ staffId }: { staffId: string }) {
  const { t } = useTranslation();
  const root = useRoot();
  const queryClient = useQueryClient();
  const f = useFormats();
  const [adding, setAdding] = useState(false);
  const list = useQuery({
    queryKey: [...root, staffId],
    queryFn: () => api.call('listStaffDocuments', { params: { staffId } }),
  });
  const open = useMutation({
    mutationFn: (documentId: string) =>
      api.call('getStaffDocumentLink', { params: { staffId, documentId } }),
    onSuccess: (link) => window.open(link.url, '_blank', 'noopener'),
  });
  const remove = useMutation({
    mutationFn: (documentId: string) =>
      api.call('removeStaffDocument', { params: { staffId, documentId } }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: root }),
  });
  const error = list.error ?? open.error ?? remove.error;
  return (
    <section aria-label={t('st.docs.title')}>
      <h3 className="font-semibold">{t('st.docs.title')}</h3>
      <p className="text-text-muted">{t('st.docs.restricted')}</p>
      {list.data && list.data.data.length === 0 && (
        <p className="text-text-muted">{t('st.docs.none')}</p>
      )}
      <ul className="mt-1 flex flex-col gap-1">
        {list.data?.data.map((d) => (
          <li key={d.id} className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{d.title}</span>
            <span className="text-text-muted">{t(`st.docs.types.${d.type}`)}</span>
            {d.keptUntil && (
              <span className="text-text-muted">
                {t('st.docs.keptUntil', { date: f.date(d.keptUntil) })}
              </span>
            )}
            {d.scan === 'CLEAN' ? (
              <Button
                size="sm"
                variant="secondary"
                disabled={open.isPending}
                onClick={() => open.mutate(d.id)}
              >
                {t('st.docs.open')}
              </Button>
            ) : (
              <span className="text-text-muted">{t(`st.docs.scan.${d.scan}`)}</span>
            )}
            <Button
              size="sm"
              variant="ghost"
              disabled={remove.isPending}
              onClick={() => remove.mutate(d.id)}
            >
              {t('st.docs.remove')}
            </Button>
          </li>
        ))}
      </ul>
      {error && <Alert tone="critical">{errorMessage(error)}</Alert>}
      {adding ? (
        <DocumentForm staffId={staffId} onDone={() => setAdding(false)} />
      ) : (
        <Button variant="secondary" className="mt-2 h-11" onClick={() => setAdding(true)}>
          {t('st.docs.add')}
        </Button>
      )}
    </section>
  );
}

function DocumentForm(props: { staffId: string; onDone: () => void }) {
  const { t } = useTranslation();
  const root = useRoot();
  const queryClient = useQueryClient();
  const [type, setType] = useState<StaffDocumentType>('CONTRACT');
  const [title, setTitle] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const save = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error(t('st.docs.chooseFile'));
      const fileId = await uploadFile('StaffDocument', file);
      return api.call('addStaffDocument', {
        params: { staffId: props.staffId },
        body: { type, title, fileId },
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: root });
      props.onDone();
    },
  });
  return (
    <form
      aria-label={t('st.docs.form')}
      className="mt-2 grid gap-3 rounded-md border border-border p-3 sm:grid-cols-3"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <div className="flex flex-col gap-1">
        <Label htmlFor="doc-type">{t('st.docs.type')}</Label>
        <select
          id="doc-type"
          className={selectClass}
          value={type}
          onChange={(e) => setType(e.target.value as StaffDocumentType)}
        >
          {STAFF_DOCUMENT_TYPES.map((x) => (
            <option key={x} value={x}>
              {t(`st.docs.types.${x}`)}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="doc-title">{t('st.docs.name')}</Label>
        <Input id="doc-title" required value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="doc-file">{t('st.docs.file')}</Label>
        <input
          id="doc-file"
          type="file"
          accept="application/pdf,image/jpeg,image/png,image/webp"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
      </div>
      {save.error && (
        <Alert tone="critical" className="sm:col-span-3">
          {errorMessage(save.error)}
        </Alert>
      )}
      <div className="flex gap-2 sm:col-span-3">
        <Button type="submit" disabled={save.isPending || !file}>
          {t('st.save')}
        </Button>
        <Button type="button" variant="ghost" onClick={props.onDone}>
          {t('st.cancel')}
        </Button>
      </div>
    </form>
  );
}

export function DocumentRetention() {
  const root = useRoot();
  const current = useQuery({
    queryKey: [...root, 'settings'],
    queryFn: () => api.call('getStaffDocumentSettings', {}),
  });
  if (!current.data) {
    return current.error ? <Alert tone="critical">{errorMessage(current.error)}</Alert> : null;
  }
  return (
    <RetentionForm key={JSON.stringify(current.data.retention)} initial={current.data.retention} />
  );
}

function RetentionForm({ initial }: { initial: StaffDocumentRetention }) {
  const { t } = useTranslation();
  const root = useRoot();
  const queryClient = useQueryClient();
  const [months, setMonths] = useState(initial);
  const save = useMutation({
    mutationFn: () => api.call('updateStaffDocumentSettings', { body: { retention: months } }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: root }),
  });
  return (
    <form
      aria-label={t('st.docs.retention')}
      className="mt-6 grid gap-3 rounded-md border border-border bg-surface p-4 text-sm"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <h2 className="font-semibold">{t('st.docs.retention')}</h2>
      <p className="text-text-muted">{t('st.docs.retentionHint')}</p>
      <div className="grid gap-3 sm:grid-cols-5">
        {STAFF_DOCUMENT_TYPES.map((x) => (
          <div key={x} className="flex flex-col gap-1">
            <Label htmlFor={`ret-${x}`}>{t(`st.docs.types.${x}`)}</Label>
            <Input
              id={`ret-${x}`}
              type="number"
              min={1}
              max={240}
              value={months[x]}
              onChange={(e) => setMonths({ ...months, [x]: Number(e.target.value) })}
            />
          </div>
        ))}
      </div>
      {save.error && <Alert tone="critical">{errorMessage(save.error)}</Alert>}
      {save.isSuccess && <Alert tone="success">{t('st.docs.saved')}</Alert>}
      <div>
        <Button type="submit" disabled={save.isPending}>
          {t('st.save')}
        </Button>
      </div>
    </form>
  );
}
