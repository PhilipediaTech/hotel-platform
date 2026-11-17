import {
  DISPOSALS,
  LOST_STATUSES,
  VALUABLE_DISPOSALS,
  type LostItem,
  type LostStatus,
} from '@hotel/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import type { z } from 'zod';
import { useSession } from '../app/session.ts';
import { Alert } from '../components/ui/alert.tsx';
import { Button } from '../components/ui/button.tsx';
import { Input } from '../components/ui/input.tsx';
import { Label } from '../components/ui/label.tsx';
import { api } from '../lib/api.ts';
import { cn } from '../lib/cn.ts';
import { errorMessage } from '../lib/form.ts';
import lostFoundStrings from '../i18n/en/lost-found.json';
import { registerStrings } from '../i18n/index.ts';
import { useFormats } from './reservations.tsx';

registerStrings(lostFoundStrings);

// Lost and found (PRD M5-13; S17 "lost item"; T-133). Log a found item (a room links it to the
// guest who had the room), see who holds it and where, hand it to someone else, return it to
// its owner, or dispose of it once kept long enough.

type Item = z.output<typeof LostItem>;
type Person = { id: string; name: string };

const selectClass = 'h-11 rounded-md border border-border bg-surface px-3 text-sm';
const textareaClass = 'min-h-20 rounded-md border border-border bg-surface p-2 text-sm';

function useKey(...parts: string[]) {
  const { currentPropertyId } = useSession();
  return ['lost-found', currentPropertyId ?? '', ...parts];
}

export function LostFoundPage() {
  const { t } = useTranslation();
  const f = useFormats();
  const [params, setParams] = useSearchParams();
  const status = (LOST_STATUSES as readonly string[]).includes(params.get('status') ?? '')
    ? (params.get('status') as LostStatus)
    : 'HELD';
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const key = useKey('list');
  const list = useQuery({
    queryKey: [...key, status, q.trim()],
    queryFn: () =>
      api.call('listLostItems', { query: { status, ...(q.trim() ? { q: q.trim() } : {}) } }),
  });
  const data = list.data;
  return (
    <section className="max-w-5xl">
      <h1 className="text-xl font-semibold">{t('lf.title')}</h1>
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <div role="tablist" aria-label={t('lf.statusTabs')} className="flex gap-2">
          {LOST_STATUSES.map((s) => (
            <Button
              key={s}
              role="tab"
              aria-selected={status === s}
              variant={status === s ? 'primary' : 'secondary'}
              className="h-11"
              onClick={() => setParams(s === 'HELD' ? {} : { status: s })}
            >
              {t(`lf.statuses.${s}`)}
            </Button>
          ))}
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="lf-q">{t('lf.search')}</Label>
          <Input id="lf-q" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {!adding && (
          <Button className="h-11" onClick={() => setAdding(true)}>
            {t('lf.add')}
          </Button>
        )}
      </div>
      {adding && data && (
        <ItemForm
          categories={data.categories}
          custodians={data.custodians}
          rooms={data.rooms}
          onDone={() => setAdding(false)}
        />
      )}
      {list.error && (
        <Alert tone="critical" className="mt-3">
          {errorMessage(list.error)}
        </Alert>
      )}
      {data && data.data.length === 0 && (
        <p className="mt-3 text-sm text-text-muted">{t('lf.none')}</p>
      )}
      <ul aria-label={t('lf.list')} className="mt-3 flex flex-col gap-2">
        {data?.data.map((i) => (
          <li key={i.id} className="rounded-md border border-border bg-surface p-3 text-sm">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <button
                type="button"
                className="text-left font-medium text-brand underline"
                aria-expanded={open === i.id}
                onClick={() => setOpen(open === i.id ? null : i.id)}
              >
                LF-{i.number} · {i.description}
              </button>
              <span className="flex gap-1">
                {i.valuable && (
                  <span className="rounded bg-warning-subtle px-2 py-0.5 text-xs font-medium text-warning">
                    {t('lf.valuable')}
                  </span>
                )}
                {i.canDispose && (
                  <span className="rounded bg-surface-muted px-2 py-0.5 text-xs font-medium">
                    {t('lf.unclaimed')}
                  </span>
                )}
              </span>
            </div>
            <p className="mt-1 text-text-muted">
              {[
                i.category,
                i.room ? t('lf.room', { number: i.room.number }) : i.foundWhere,
                t('lf.found', { when: f.when(i.foundAt), name: i.foundBy.name }),
                i.status === 'HELD'
                  ? t('lf.heldBy', { name: i.custodian.name, place: i.storageLocation })
                  : i.status === 'RETURNED'
                    ? t('lf.returnedTo', { name: i.returnedToName ?? '' })
                    : t(`lf.disposals.${i.disposal ?? 'OTHER'}`),
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
            {i.owner && i.status === 'HELD' && (
              <p className="mt-1">
                {t('lf.owner', {
                  name: i.owner.guestName,
                  phone: i.owner.phone ?? t('lf.noPhone'),
                })}
              </p>
            )}
            {open === i.id && data && (
              <ItemPanel item={i} custodians={data.custodians} onClosed={() => setOpen(null)} />
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function ItemPanel(props: { item: Item; custodians: Person[]; onClosed: () => void }) {
  const { t } = useTranslation();
  const f = useFormats();
  const [action, setAction] = useState<'custody' | 'return' | 'dispose' | null>(null);
  const detail = useQuery({
    queryKey: useKey('item', props.item.id),
    queryFn: () => api.call('getLostItem', { params: { itemId: props.item.id } }),
  });
  const i = props.item;
  return (
    <div className="mt-3 grid gap-3 border-t border-border pt-3">
      <p>{t('lf.keepUntil', { date: f.date(i.keepUntil) })}</p>
      {detail.error && <Alert tone="critical">{errorMessage(detail.error)}</Alert>}
      {detail.data && (
        <>
          {detail.data.returnedIdNote && (
            <p>
              {t('lf.returnDetail', {
                name: detail.data.returnedToName ?? '',
                phone: detail.data.returnedToPhone ?? t('lf.noPhone'),
                id: detail.data.returnedIdNote,
              })}
            </p>
          )}
          <ol aria-label={t('lf.trail')} className="flex flex-col gap-1">
            {detail.data.events.map((e, n) => (
              <li key={n}>
                {f.when(e.at)} · {t(`lf.events.${e.kind}`)}
                {e.storageLocation ? ` · ${e.storageLocation}` : ''}
                {e.custodian ? ` · ${e.custodian.name}` : ''}
                {e.note ? ` · ${e.note}` : ''}
                <span className="text-text-muted"> · {e.by.name}</span>
              </li>
            ))}
          </ol>
        </>
      )}
      {i.status === 'HELD' && (
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" className="h-11" onClick={() => setAction('custody')}>
            {t('lf.handOver')}
          </Button>
          <Button className="h-11" onClick={() => setAction('return')}>
            {t('lf.giveBack')}
          </Button>
          {i.canDispose && (
            <Button variant="ghost" className="h-11" onClick={() => setAction('dispose')}>
              {t('lf.dispose')}
            </Button>
          )}
        </div>
      )}
      {action && (
        <ActionForm
          item={i}
          action={action}
          custodians={props.custodians}
          onDone={(closed) => {
            setAction(null);
            if (closed) props.onClosed();
          }}
        />
      )}
    </div>
  );
}

function ActionForm(props: {
  item: Item;
  action: 'custody' | 'return' | 'dispose';
  custodians: Person[];
  onDone: (closed: boolean) => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const root = useKey();
  const i = props.item;
  const disposals = i.valuable ? VALUABLE_DISPOSALS : DISPOSALS;
  const [form, setForm] = useState({
    storageLocation: '',
    custodianId: props.custodians[0]?.id ?? '',
    toName: i.owner?.guestName ?? '',
    toPhone: i.owner?.phone ?? '',
    idNote: '',
    disposal: disposals[0] ?? 'OTHER',
    note: '',
  });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((s) => ({ ...s, [k]: e.target.value }));
  const save = useMutation({
    mutationFn: () => {
      const params = { itemId: i.id };
      if (props.action === 'custody') {
        return api.call('moveLostItem', {
          params,
          body: {
            storageLocation: form.storageLocation,
            custodianId: form.custodianId,
            note: form.note,
          },
        });
      }
      if (props.action === 'return') {
        return api.call('returnLostItem', {
          params,
          body: {
            toName: form.toName,
            toPhone: form.toPhone,
            idNote: form.idNote,
            note: form.note,
          },
        });
      }
      return api.call('disposeLostItem', {
        params,
        body: { disposal: form.disposal, note: form.note },
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: root });
      props.onDone(props.action !== 'custody');
    },
  });
  const field = (k: keyof typeof form, label: string) => (
    <div className="flex flex-col gap-1">
      <Label htmlFor={`lf-${props.action}-${k}`}>{label}</Label>
      <Input id={`lf-${props.action}-${k}`} value={form[k]} onChange={set(k)} />
    </div>
  );
  return (
    <form
      aria-label={t(`lf.forms.${props.action}`)}
      className="grid gap-3 rounded-md border border-border p-3 sm:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      {props.action === 'custody' && (
        <>
          {field('storageLocation', t('lf.storage'))}
          <div className="flex flex-col gap-1">
            <Label htmlFor="lf-custody-custodianId">{t('lf.custodian')}</Label>
            <select
              id="lf-custody-custodianId"
              className={selectClass}
              value={form.custodianId}
              onChange={set('custodianId')}
            >
              {props.custodians.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
        </>
      )}
      {props.action === 'return' && (
        <>
          {field('toName', t('lf.toName'))}
          {field('toPhone', t('lf.toPhone'))}
          {field('idNote', t('lf.idNote'))}
        </>
      )}
      {props.action === 'dispose' && (
        <div className="flex flex-col gap-1">
          <Label htmlFor="lf-dispose-disposal">{t('lf.disposal')}</Label>
          <select
            id="lf-dispose-disposal"
            className={selectClass}
            value={form.disposal}
            onChange={set('disposal')}
          >
            {disposals.map((d) => (
              <option key={d} value={d}>
                {t(`lf.disposals.${d}`)}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="flex flex-col gap-1 sm:col-span-2">
        <Label htmlFor={`lf-${props.action}-note`}>
          {props.action === 'dispose' ? t('lf.disposeNote') : t('lf.note')}
        </Label>
        <textarea
          id={`lf-${props.action}-note`}
          className={textareaClass}
          value={form.note}
          onChange={set('note')}
        />
      </div>
      {save.error && (
        <Alert tone="critical" className="sm:col-span-2">
          {errorMessage(save.error)}
        </Alert>
      )}
      <div className="flex gap-2 sm:col-span-2">
        <Button type="submit" className="h-11" disabled={save.isPending}>
          {t(`lf.save.${props.action}`)}
        </Button>
        <Button type="button" variant="ghost" className="h-11" onClick={() => props.onDone(false)}>
          {t('lf.cancel')}
        </Button>
      </div>
    </form>
  );
}

/** Log a found item. */
function ItemForm(props: {
  categories: string[];
  custodians: Person[];
  rooms: { id: string; number: string }[];
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const root = useKey();
  const { userName } = useSession();
  const [form, setForm] = useState({
    description: '',
    category: '',
    valuable: false,
    roomId: '',
    foundWhere: '',
    storageLocation: '',
    custodianId: '',
    note: '',
  });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((s) => ({ ...s, [k]: e.target.value }));
  const save = useMutation({
    mutationFn: () =>
      api.call('createLostItem', {
        body: {
          description: form.description,
          category: form.category,
          valuable: form.valuable,
          roomId: form.roomId || null,
          foundWhere: form.foundWhere,
          storageLocation: form.storageLocation,
          custodianId: form.custodianId || null,
          note: form.note,
        },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: root });
      props.onDone();
    },
  });
  const field = (k: keyof typeof form, label: string, extra: object = {}) => (
    <div className="flex flex-col gap-1">
      <Label htmlFor={`lf-new-${k}`}>{label}</Label>
      <Input id={`lf-new-${k}`} value={String(form[k])} onChange={set(k)} {...extra} />
    </div>
  );
  return (
    <form
      aria-label={t('lf.forms.new')}
      className="mt-3 grid gap-3 rounded-md border border-border bg-surface p-3 sm:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      {field('description', t('lf.description'))}
      {field('category', t('lf.category'), { list: 'lf-categories' })}
      <datalist id="lf-categories">
        {props.categories.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>
      <div className="flex flex-col gap-1">
        <Label htmlFor="lf-new-roomId">{t('lf.roomField')}</Label>
        <select
          id="lf-new-roomId"
          className={selectClass}
          value={form.roomId}
          onChange={set('roomId')}
        >
          <option value="">{t('lf.noRoom')}</option>
          {props.rooms.map((r) => (
            <option key={r.id} value={r.id}>
              {t('lf.room', { number: r.number })}
            </option>
          ))}
        </select>
      </div>
      {field('foundWhere', t('lf.foundWhere'))}
      {field('storageLocation', t('lf.storage'))}
      <div className="flex flex-col gap-1">
        <Label htmlFor="lf-new-custodianId">{t('lf.custodian')}</Label>
        <select
          id="lf-new-custodianId"
          className={selectClass}
          value={form.custodianId}
          onChange={set('custodianId')}
        >
          <option value="">{t('lf.me', { name: userName })}</option>
          {props.custodians
            .filter((c) => c.name !== userName)
            .map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
        </select>
      </div>
      <label className="flex min-h-11 items-center gap-2 text-sm sm:col-span-2">
        <input
          type="checkbox"
          className="size-5"
          checked={form.valuable}
          onChange={(e) => setForm((s) => ({ ...s, valuable: e.target.checked }))}
        />
        {t('lf.valuableField')}
      </label>
      <div className="flex flex-col gap-1 sm:col-span-2">
        <Label htmlFor="lf-new-note">{t('lf.note')}</Label>
        <textarea
          id="lf-new-note"
          className={textareaClass}
          value={form.note}
          onChange={set('note')}
        />
      </div>
      {save.error && (
        <Alert tone="critical" className={cn('sm:col-span-2')}>
          {errorMessage(save.error)}
        </Alert>
      )}
      <div className="flex gap-2 sm:col-span-2">
        <Button type="submit" className="h-11" disabled={save.isPending}>
          {t('lf.save.new')}
        </Button>
        <Button type="button" variant="ghost" className="h-11" onClick={props.onDone}>
          {t('lf.cancel')}
        </Button>
      </div>
    </form>
  );
}
