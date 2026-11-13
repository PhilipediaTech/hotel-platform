import { ASSET_STATUSES, type AssetDetail, type AssetItem, type AssetStatus } from '@hotel/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router';
import type { z } from 'zod';
import { useSession } from '../app/session.ts';
import { Alert } from '../components/ui/alert.tsx';
import { Button } from '../components/ui/button.tsx';
import { Input } from '../components/ui/input.tsx';
import { Label } from '../components/ui/label.tsx';
import { api } from '../lib/api.ts';
import { cn } from '../lib/cn.ts';
import { errorMessage } from '../lib/form.ts';
import maintenanceStrings from '../i18n/en/maintenance.json';
import { registerStrings } from '../i18n/index.ts';
import { PlansView } from './preventive.tsx';
import { useFormats } from './reservations.tsx';
import { amountToMinor, hoursAndMinutes } from './work-order.tsx';

registerStrings(maintenanceStrings);

// S34 Assets, work orders, PM (PRD M5-08, M5-09, M5-10; T-130, T-131). Jobs: the open
// maintenance tasks (each opens on the task page, where parts, time and cost are logged).
// Assets: the register with location, serial, warranty and vendor, and each asset's service
// history. Plans (pm.manage): the PM calendar and run-hours plans (preventive.tsx).

type Asset = z.output<typeof AssetItem>;
type Detail = z.output<typeof AssetDetail>;

const selectClass = 'h-11 rounded-md border border-border bg-surface px-3 text-sm';
const STATUS_TONE: Record<AssetStatus, string> = {
  IN_SERVICE: 'bg-success-subtle text-success',
  OUT_OF_SERVICE: 'bg-critical-subtle text-critical',
  RETIRED: 'bg-surface-muted text-text-muted',
};

function useKey(...parts: string[]) {
  const { currentPropertyId } = useSession();
  return ['maintenance', currentPropertyId ?? '', ...parts];
}

export function MaintenancePage() {
  const { t } = useTranslation();
  const { permissions } = useSession();
  const [params, setParams] = useSearchParams();
  const canPlan = permissions.includes('pm.manage');
  const views = canPlan ? (['jobs', 'assets', 'plans'] as const) : (['jobs', 'assets'] as const);
  type View = (typeof views)[number];
  const asked = params.get('view');
  const view: View = params.get('asset')
    ? 'assets'
    : (views as readonly string[]).includes(asked ?? '')
      ? (asked as View)
      : 'jobs';
  const show = (v: View) => setParams(v === 'jobs' ? {} : { view: v });
  return (
    <section className="max-w-6xl">
      <h1 className="text-xl font-semibold">{t('mnt.title')}</h1>
      <div role="tablist" aria-label={t('mnt.views')} className="mt-3 flex gap-2">
        {views.map((v) => (
          <Button
            key={v}
            role="tab"
            aria-selected={view === v}
            variant={view === v ? 'primary' : 'secondary'}
            className="h-11"
            onClick={() => show(v)}
          >
            {t(`mnt.view.${v}`)}
          </Button>
        ))}
      </div>
      {view === 'jobs' ? <Jobs /> : view === 'assets' ? <Assets /> : <PlansView />}
    </section>
  );
}

// ── Jobs ───────────────────────────────────────────────────────────────────────────────

function Jobs() {
  const { t } = useTranslation();
  const f = useFormats();
  const [mine, setMine] = useState(false);
  const options = useQuery({
    queryKey: useKey('form-options'),
    queryFn: () => api.call('getTaskFormOptions', {}),
  });
  const mnt = options.data?.departments.find((d) => d.code === 'MNT');
  const jobs = useQuery({
    queryKey: useKey('jobs', mnt?.id ?? '', String(mine)),
    queryFn: () =>
      api.call('listTasks', {
        query: {
          limit: 100,
          status: 'open',
          ...(mnt ? { departmentId: mnt.id } : {}),
          ...(mine ? { assignee: 'me' as const } : {}),
        },
      }),
    enabled: options.isSuccess,
  });
  const error = options.error ?? jobs.error;
  return (
    <div className="mt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-5"
            checked={mine}
            onChange={(e) => setMine(e.target.checked)}
          />
          {t('mnt.jobs.mine')}
        </label>
        <Link to="/tasks/new" className="text-sm text-brand underline">
          {t('mnt.jobs.new')}
        </Link>
      </div>
      {error && (
        <Alert tone="critical" className="mt-3">
          {errorMessage(error)}
        </Alert>
      )}
      {jobs.data && jobs.data.data.length === 0 && (
        <p className="mt-3 text-sm text-text-muted">{t('mnt.jobs.none')}</p>
      )}
      <ul aria-label={t('mnt.jobs.list')} className="mt-3 flex flex-col gap-2">
        {jobs.data?.data.map((j) => (
          <li key={j.id} className="rounded-md border border-border bg-surface p-3 text-sm">
            <Link to={`/tasks/${j.id}`} className="font-medium text-brand underline">
              #{j.number} {j.title}
            </Link>
            <p className="mt-1 text-text-muted">
              {[
                t(`mnt.jobs.status.${j.status}`, { defaultValue: j.status }),
                j.priority === 'HIGH' || j.priority === 'CRITICAL'
                  ? t(`mnt.jobs.priority.${j.priority}`)
                  : null,
                j.asset ? `${j.asset.tag} · ${j.asset.name}` : null,
                j.room ? t('mnt.room', { number: j.room.number }) : null,
                j.assignee?.name ?? t('mnt.jobs.unassigned'),
                j.dueAt ? t('mnt.jobs.due', { when: f.when(j.dueAt) }) : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
            {j.overdue && (
              <p className="text-xs font-medium text-critical">{t('mnt.jobs.overdue')}</p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── Assets ─────────────────────────────────────────────────────────────────────────────

function Assets() {
  const { t } = useTranslation();
  const { permissions } = useSession();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<AssetStatus | ''>('');
  const [adding, setAdding] = useState(false);
  const canManage = permissions.includes('asset.manage');
  const selected = params.get('asset');
  const key = useKey('assets');
  const list = useQuery({
    queryKey: [...key, q, status],
    queryFn: () =>
      api.call('listAssets', {
        query: { ...(q.trim() ? { q: q.trim() } : {}), ...(status ? { status } : {}) },
      }),
  });
  const open = (id: string | null) =>
    setParams(id ? { view: 'assets', asset: id } : { view: 'assets' });
  return (
    <div className="mt-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="asset-q">{t('mnt.assets.search')}</Label>
          <Input id="asset-q" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="asset-status">{t('mnt.assets.status')}</Label>
          <select
            id="asset-status"
            className={selectClass}
            value={status}
            onChange={(e) => setStatus(e.target.value as AssetStatus | '')}
          >
            <option value="">{t('mnt.assets.anyStatus')}</option>
            {ASSET_STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(`mnt.assets.statuses.${s}`)}
              </option>
            ))}
          </select>
        </div>
        {canManage && !adding && (
          <Button className="h-11" onClick={() => setAdding(true)}>
            {t('mnt.assets.add')}
          </Button>
        )}
      </div>
      {adding && list.data && (
        <AssetForm
          categories={list.data.categories}
          onDone={(id) => {
            setAdding(false);
            if (id) open(id);
          }}
        />
      )}
      {list.error && (
        <Alert tone="critical" className="mt-3">
          {errorMessage(list.error)}
        </Alert>
      )}
      {list.data && list.data.data.length === 0 && (
        <p className="mt-3 text-sm text-text-muted">{t('mnt.assets.none')}</p>
      )}
      <div className="mt-3 grid gap-4 lg:grid-cols-2">
        <ul aria-label={t('mnt.assets.list')} className="flex flex-col gap-2">
          {list.data?.data.map((a) => (
            <AssetRow key={a.id} asset={a} active={a.id === selected} onOpen={() => open(a.id)} />
          ))}
        </ul>
        {selected && list.data && (
          <AssetPanel
            assetId={selected}
            categories={list.data.categories}
            onClose={() => open(null)}
          />
        )}
      </div>
    </div>
  );
}

function AssetRow(props: { asset: Asset; active: boolean; onOpen: () => void }) {
  const { t } = useTranslation();
  const a = props.asset;
  return (
    <li
      className={cn(
        'rounded-md border bg-surface p-3 text-sm',
        props.active ? 'border-brand' : 'border-border',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <button
          type="button"
          className="text-left font-medium text-brand underline"
          onClick={props.onOpen}
        >
          {a.tag} · {a.name}
        </button>
        <span className={cn('rounded px-2 py-0.5 text-xs font-medium', STATUS_TONE[a.status])}>
          {t(`mnt.assets.statuses.${a.status}`)}
        </span>
      </div>
      <p className="mt-1 text-text-muted">
        {[
          a.category,
          a.room ? t('mnt.room', { number: a.room.number }) : a.location,
          a.underWarranty ? t('mnt.assets.inWarranty') : null,
          a.openJobs > 0 ? t('mnt.assets.openJobs', { count: a.openJobs }) : null,
        ]
          .filter(Boolean)
          .join(' · ')}
      </p>
    </li>
  );
}

function AssetPanel(props: { assetId: string; categories: string[]; onClose: () => void }) {
  const { t } = useTranslation();
  const f = useFormats();
  const { permissions } = useSession();
  const [editing, setEditing] = useState(false);
  const detail = useQuery({
    queryKey: useKey('asset', props.assetId),
    queryFn: () => api.call('getAsset', { params: { assetId: props.assetId } }),
  });
  if (detail.error) return <Alert tone="critical">{errorMessage(detail.error)}</Alert>;
  const d = detail.data;
  if (!d) return <p className="text-sm text-text-muted">{t('shell.loading')}</p>;
  const row = (label: string, value: string | null) =>
    value ? (
      <div className="flex flex-col">
        <dt className="text-xs text-text-muted">{label}</dt>
        <dd>{value}</dd>
      </div>
    ) : null;
  return (
    <section
      aria-label={t('mnt.assets.panel', { tag: d.tag })}
      className="rounded-md border border-border bg-surface p-4 text-sm"
    >
      <div className="flex items-start justify-between gap-2">
        <h2 className="text-base font-semibold">
          {d.tag} · {d.name}
        </h2>
        <Button variant="ghost" className="h-11" onClick={props.onClose}>
          {t('mnt.close')}
        </Button>
      </div>
      {editing ? (
        <AssetForm asset={d} categories={props.categories} onDone={() => setEditing(false)} />
      ) : (
        <>
          <dl className="mt-2 grid grid-cols-2 gap-2">
            {row(t('mnt.assets.category'), d.category)}
            {row(t('mnt.assets.status'), t(`mnt.assets.statuses.${d.status}`))}
            {row(
              t('mnt.assets.where'),
              d.room ? t('mnt.room', { number: d.room.number }) : d.location,
            )}
            {row(t('mnt.assets.serial'), d.serial)}
            {row(t('mnt.assets.vendor'), d.vendor)}
            {row(
              t('mnt.assets.warranty'),
              d.warrantyUntil
                ? t(d.underWarranty ? 'mnt.assets.warrantyUntil' : 'mnt.assets.warrantyEnded', {
                    date: f.date(d.warrantyUntil),
                  })
                : null,
            )}
            {row(t('mnt.assets.cost'), d.costMinor ? f.money(d.costMinor) : null)}
          </dl>
          {permissions.includes('asset.manage') && (
            <Button variant="secondary" className="mt-3 h-11" onClick={() => setEditing(true)}>
              {t('mnt.assets.edit')}
            </Button>
          )}
        </>
      )}
      <h3 className="mt-4 font-semibold">{t('mnt.assets.history')}</h3>
      <p className="text-text-muted">
        {t('mnt.assets.totals', {
          count: d.totals.jobs,
          time: hoursAndMinutes(t, d.totals.labourMinutes),
          cost: f.money(d.totals.costMinor),
        })}
      </p>
      {d.history.length === 0 ? (
        <p className="mt-1 text-text-muted">{t('mnt.assets.noHistory')}</p>
      ) : (
        <ul aria-label={t('mnt.assets.history')} className="mt-2 flex flex-col gap-1">
          {d.history.map((h) => (
            <li key={h.taskId}>
              <Link to={`/tasks/${h.taskId}`} className="text-brand underline">
                #{h.number} {h.title}
              </Link>{' '}
              <span className="text-text-muted">
                · {t(`mnt.jobs.status.${h.status}`, { defaultValue: h.status })} ·{' '}
                {f.date(h.createdAt.slice(0, 10))}
                {h.labourMinutes > 0 ? ` · ${hoursAndMinutes(t, h.labourMinutes)}` : ''}
                {h.costMinor !== '0' ? ` · ${f.money(h.costMinor)}` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Add an asset, or change one (asset.manage). */
function AssetForm(props: {
  asset?: Detail;
  categories: string[];
  onDone: (id: string | null) => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const a = props.asset;
  const listKey = useKey('assets');
  const detailKey = useKey('asset', a?.id ?? '');
  const rooms = useQuery({
    queryKey: useKey('form-options'),
    queryFn: () => api.call('getTaskFormOptions', {}),
  });
  const [form, setForm] = useState({
    tag: a?.tag ?? '',
    name: a?.name ?? '',
    category: a?.category ?? '',
    roomId: a?.room?.id ?? '',
    location: a?.location ?? '',
    serial: a?.serial ?? '',
    vendor: a?.vendor ?? '',
    warrantyUntil: a?.warrantyUntil ?? '',
    cost: a?.costMinor ? (Number(a.costMinor) / 100).toFixed(2) : '',
    status: a?.status ?? 'IN_SERVICE',
  });
  const [problem, setProblem] = useState<string | null>(null);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((s) => ({ ...s, [k]: e.target.value }));
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      a
        ? api.call('updateAsset', { params: { assetId: a.id }, body })
        : api.call('createAsset', { body: body as never }),
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: listKey });
      queryClient.setQueryData(keyFor(detailKey, saved.id), saved);
      props.onDone(saved.id);
    },
  });
  const submit = () => {
    const cost = form.cost.trim() === '' ? null : amountToMinor(form.cost);
    if (form.cost.trim() !== '' && cost === null) {
      setProblem(t('mnt.wo.badAmount'));
      return;
    }
    setProblem(null);
    save.mutate({
      tag: form.tag,
      name: form.name,
      category: form.category,
      roomId: form.roomId || null,
      location: form.location,
      serial: form.serial,
      vendor: form.vendor,
      warrantyUntil: form.warrantyUntil || null,
      costMinor: cost,
      status: form.status,
    });
  };
  const field = (k: keyof typeof form, label: string, extra: object = {}) => (
    <div className="flex flex-col gap-1">
      <Label htmlFor={`asset-${k}`}>{label}</Label>
      <Input id={`asset-${k}`} value={form[k]} onChange={set(k)} {...extra} />
    </div>
  );
  return (
    <form
      aria-label={a ? t('mnt.assets.editForm') : t('mnt.assets.addForm')}
      className="mt-3 grid gap-3 rounded-md border border-border bg-surface p-3 sm:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {field('tag', t('mnt.assets.tag'))}
      {field('name', t('mnt.assets.name'))}
      {field('category', t('mnt.assets.category'), { list: 'asset-categories' })}
      <datalist id="asset-categories">
        {props.categories.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>
      <div className="flex flex-col gap-1">
        <Label htmlFor="asset-roomId">{t('mnt.assets.room')}</Label>
        <select
          id="asset-roomId"
          className={selectClass}
          value={form.roomId}
          onChange={set('roomId')}
        >
          <option value="">{t('mnt.assets.noRoom')}</option>
          {rooms.data?.rooms.map((r) => (
            <option key={r.id} value={r.id}>
              {t('mnt.room', { number: r.number })}
            </option>
          ))}
        </select>
      </div>
      {field('location', t('mnt.assets.location'))}
      {field('serial', t('mnt.assets.serial'))}
      {field('vendor', t('mnt.assets.vendor'))}
      {field('warrantyUntil', t('mnt.assets.warrantyDate'), { type: 'date' })}
      {field('cost', t('mnt.assets.costField'), { inputMode: 'decimal' })}
      <div className="flex flex-col gap-1">
        <Label htmlFor="asset-status-field">{t('mnt.assets.status')}</Label>
        <select
          id="asset-status-field"
          className={selectClass}
          value={form.status}
          onChange={set('status')}
        >
          {ASSET_STATUSES.map((s) => (
            <option key={s} value={s}>
              {t(`mnt.assets.statuses.${s}`)}
            </option>
          ))}
        </select>
      </div>
      {problem && <Alert tone="critical">{problem}</Alert>}
      {save.error && (
        <Alert tone="critical" className="sm:col-span-2">
          {errorMessage(save.error)}
        </Alert>
      )}
      <div className="flex gap-2 sm:col-span-2">
        <Button type="submit" className="h-11" disabled={save.isPending}>
          {a ? t('mnt.assets.save') : t('mnt.assets.addSave')}
        </Button>
        <Button type="button" variant="ghost" className="h-11" onClick={() => props.onDone(null)}>
          {t('mnt.cancel')}
        </Button>
      </div>
    </form>
  );
}

/** The detail key of `id`, from the detail key shape of this screen. */
function keyFor(detailKey: string[], id: string) {
  return [...detailKey.slice(0, -1), id];
}
