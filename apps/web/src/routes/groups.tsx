import { addDays, localDate, type GroupBlockDetail, type GroupBlockItem } from '@hotel/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ComponentProps } from 'react';
import { useTranslation } from 'react-i18next';
import type { z } from 'zod';
import { useSession } from '../app/session.ts';
import { Alert } from '../components/ui/alert.tsx';
import { Button } from '../components/ui/button.tsx';
import { Input } from '../components/ui/input.tsx';
import { Label } from '../components/ui/label.tsx';
import strings from '../i18n/en/groups.json';
import { registerStrings } from '../i18n/index.ts';
import { api } from '../lib/api.ts';
import { errorMessage } from '../lib/form.ts';

registerStrings(strings);

// S09 Reservations, group blocks and allotments (PRD M3-17, M2-12; T-123): rooms held for a
// group or an agent, their pick-up night by night, the rooming list, and the release.

type Kind = 'GROUP' | 'ALLOTMENT';
type Block = z.output<typeof GroupBlockItem>;
type Detail = z.output<typeof GroupBlockDetail>;

const selectClass = 'h-11 rounded-md border border-border bg-surface px-3 text-sm';
const KEY = ['groups'];

function Field({
  id,
  label,
  ...props
}: { id: string; label: string } & ComponentProps<typeof Input>) {
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} {...props} />
    </div>
  );
}

function useToday() {
  const { properties, currentPropertyId } = useSession();
  const p = properties.find((x) => x.id === currentPropertyId);
  return p?.businessDate ?? localDate(new Date(), p?.timeZone ?? 'UTC');
}

// ── A new block ─────────────────────────────────────────────────────────────────────────

function NewBlock({ kind, onDone }: { kind: Kind; onDone: (id: string) => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const today = useToday();
  const types = useQuery({ queryKey: ['room-types'], queryFn: () => api.call('listRoomTypes') });
  const plans = useQuery({ queryKey: ['rate-plans'], queryFn: () => api.call('listRatePlans') });
  const companies = useQuery({
    queryKey: ['companies'],
    queryFn: () => api.call('listCompanies', { query: {} }),
  });
  const [f, setF] = useState({
    code: '',
    name: '',
    companyId: '',
    ratePlanId: '',
    arrival: addDays(today, 14),
    departure: addDays(today, 16),
    releaseDate: addDays(today, 7),
    releaseDays: '7',
  });
  const [counts, setCounts] = useState<Record<string, string>>({});
  const set = (key: keyof typeof f, value: string) => setF((x) => ({ ...x, [key]: value }));
  const activeTypes = types.data?.data.filter((x) => x.active) ?? [];
  const activePlans = plans.data?.data.filter((x) => x.active) ?? [];
  const create = useMutation({
    mutationFn: () => {
      const body = {
        code: f.code,
        name: f.name,
        companyId: f.companyId || null,
        ratePlanId: f.ratePlanId || activePlans[0]?.id || '',
        arrival: f.arrival,
        departure: f.departure,
        releaseDate: kind === 'GROUP' ? f.releaseDate : null,
        releaseDays: kind === 'ALLOTMENT' ? Number(f.releaseDays) : null,
        notes: null,
        rooms: activeTypes
          .filter((x) => Number(counts[x.id] ?? 0) > 0)
          .map((x) => ({ roomTypeId: x.id, count: Number(counts[x.id]) })),
      };
      return kind === 'GROUP'
        ? api.call('createGroupBlock', { body })
        : api.call('createAllotment', { body });
    },
    onSuccess: (made) => {
      void queryClient.invalidateQueries({ queryKey: KEY });
      onDone(made.id);
    },
  });
  return (
    <form
      aria-label={t(`groups.new.${kind}`)}
      className="grid gap-2 rounded-md border border-border bg-surface p-3 sm:grid-cols-3"
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate();
      }}
    >
      <Field
        id="gb-code"
        label={t('groups.code')}
        value={f.code}
        onChange={(e) => set('code', e.target.value)}
        required
      />
      <Field
        id="gb-name"
        label={t('groups.name')}
        value={f.name}
        onChange={(e) => set('name', e.target.value)}
        required
      />
      <div className="flex flex-col gap-1">
        <Label htmlFor="gb-company">{t('groups.company')}</Label>
        <select
          id="gb-company"
          className={selectClass}
          value={f.companyId}
          onChange={(e) => set('companyId', e.target.value)}
          required={kind === 'ALLOTMENT'}
        >
          <option value="">{t('groups.noCompany')}</option>
          {companies.data?.data
            .filter((c) => c.active)
            .map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
        </select>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="gb-plan">{t('groups.ratePlan')}</Label>
        <select
          id="gb-plan"
          className={selectClass}
          value={f.ratePlanId || activePlans[0]?.id || ''}
          onChange={(e) => set('ratePlanId', e.target.value)}
        >
          {activePlans.map((p) => (
            <option key={p.id} value={p.id}>
              {p.code} · {p.name}
            </option>
          ))}
        </select>
      </div>
      <Field
        id="gb-arrival"
        label={t('groups.arrival')}
        type="date"
        value={f.arrival}
        onChange={(e) => set('arrival', e.target.value)}
        required
      />
      <Field
        id="gb-departure"
        label={t('groups.departure')}
        type="date"
        value={f.departure}
        onChange={(e) => set('departure', e.target.value)}
        required
      />
      {kind === 'GROUP' ? (
        <Field
          id="gb-release"
          label={t('groups.releaseDate')}
          type="date"
          value={f.releaseDate}
          onChange={(e) => set('releaseDate', e.target.value)}
          required
        />
      ) : (
        <Field
          id="gb-days"
          label={t('groups.releaseDays')}
          type="number"
          min={0}
          value={f.releaseDays}
          onChange={(e) => set('releaseDays', e.target.value)}
          required
        />
      )}
      <h4 className="font-semibold sm:col-span-3">{t('groups.roomsEachNight')}</h4>
      {activeTypes.map((x) => (
        <Field
          key={x.id}
          id={`gb-count-${x.id}`}
          label={x.name}
          type="number"
          min={0}
          value={counts[x.id] ?? ''}
          onChange={(e) => setCounts((c) => ({ ...c, [x.id]: e.target.value }))}
        />
      ))}
      <div className="sm:col-span-3">
        <Button type="submit" disabled={create.isPending}>
          {t('groups.hold')}
        </Button>
      </div>
      {create.error && (
        <Alert tone="critical" className="sm:col-span-3">
          {errorMessage(create.error)}
        </Alert>
      )}
    </form>
  );
}

// ── One block ───────────────────────────────────────────────────────────────────────────

function RoomingForm({ kind, block }: { kind: Kind; block: Detail }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [text, setText] = useState('');
  const [roomTypeId, setRoomTypeId] = useState(block.roomTypes[0]?.id ?? '');
  const book = useMutation({
    mutationFn: () => {
      const rooms = text
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
          const [first = l, ...rest] = l.split(/\s+/);
          return { firstName: first, lastName: rest.join(' ') || first, roomTypeId };
        });
      const params = { blockId: block.id };
      return kind === 'GROUP'
        ? api.call('bookGroupBlockRoomingList', { params, body: { rooms } })
        : api.call('bookAllotmentRoomingList', { params, body: { rooms } });
    },
    onSuccess: (r) => {
      if (r.failed.length === 0) setText('');
      void queryClient.invalidateQueries({ queryKey: KEY });
    },
  });
  return (
    <form
      aria-label={t('groups.roomingForm')}
      className="mt-3 flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        book.mutate();
      }}
    >
      <Label htmlFor={`rl-${block.id}`}>{t('groups.roomingNames')}</Label>
      <textarea
        id={`rl-${block.id}`}
        className="min-h-24 rounded-md border border-border bg-surface p-2 text-sm"
        value={text}
        onChange={(e) => setText(e.target.value)}
        required
      />
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor={`rl-type-${block.id}`}>{t('groups.roomType')}</Label>
          <select
            id={`rl-type-${block.id}`}
            className={selectClass}
            value={roomTypeId}
            onChange={(e) => setRoomTypeId(e.target.value)}
          >
            {block.roomTypes.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
        </div>
        <Button type="submit" variant="secondary" disabled={book.isPending}>
          {t('groups.bookNames')}
        </Button>
      </div>
      {book.data && book.data.booked.length > 0 && (
        <Alert tone="success">{t('groups.bookedCount', { count: book.data.booked.length })}</Alert>
      )}
      {book.data?.failed.map((x) => (
        <Alert key={x.line} tone="critical">
          {t('groups.lineFailed', { line: x.line, message: x.message })}
        </Alert>
      ))}
      {book.error && <Alert tone="critical">{errorMessage(book.error)}</Alert>}
    </form>
  );
}

function BlockView({ kind, blockId }: { kind: Kind; blockId: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const q = useQuery({
    queryKey: [...KEY, kind, blockId],
    queryFn: () =>
      kind === 'GROUP'
        ? api.call('getGroupBlock', { params: { blockId } })
        : api.call('getAllotment', { params: { blockId } }),
  });
  const release = useMutation({
    mutationFn: (cancel: boolean) =>
      kind === 'GROUP'
        ? api.call('releaseGroupBlock', { params: { blockId }, body: { cancel } })
        : api.call('releaseAllotment', { params: { blockId }, body: { cancel } }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: KEY }),
  });
  if (q.error) return <Alert tone="critical">{errorMessage(q.error)}</Alert>;
  const b = q.data;
  if (!b) return null;
  const dates = [...new Set(b.nights.map((n) => n.date))];
  const name = new Map(b.roomTypes.map((x) => [x.id, x.name]));
  return (
    <section aria-label={b.name} className="mt-2 flex flex-col gap-3 border-t border-border pt-3">
      <p className="text-text-muted">
        {b.releaseDate
          ? t('groups.releasesOn', { date: b.releaseDate })
          : t('groups.releasesDays', { count: b.releaseDays ?? 0 })}
      </p>
      <div className="overflow-x-auto">
        <table className="text-sm">
          <thead>
            <tr>
              <th className="pr-3 text-left">{t('groups.roomType')}</th>
              {dates.map((d) => (
                <th key={d} className="px-2 text-right">
                  {d.slice(5)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {b.roomTypes.map((x) => (
              <tr key={x.id}>
                <td className="pr-3">{name.get(x.id)}</td>
                {dates.map((d) => {
                  const n = b.nights.find((y) => y.roomTypeId === x.id && y.date === d);
                  return (
                    <td key={d} className="px-2 text-right">
                      {n
                        ? t('groups.cell', {
                            picked: n.pickedUp,
                            rooms: n.rooms,
                            left: n.remaining,
                          })
                        : ''}
                      {n?.released ? ` ${t('groups.released')}` : ''}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-text-muted">{t('groups.cellKey')}</p>
      <h4 className="font-semibold">{t('groups.rooming')}</h4>
      {b.rooming.length === 0 && <p className="text-text-muted">{t('groups.noRooming')}</p>}
      <ul className="flex flex-col gap-1">
        {b.rooming.map((r) => (
          <li key={r.stayId} className="flex flex-wrap gap-3">
            <span>{r.guestName}</span>
            <span className="text-text-muted">{name.get(r.roomTypeId)}</span>
            <span className="text-text-muted">
              {r.arrival} – {r.departure}
            </span>
            <span className="text-text-muted">{r.confirmationNo}</span>
            {r.roomNumber && <span>{t('groups.room', { number: r.roomNumber })}</span>}
          </li>
        ))}
      </ul>
      {b.status === 'ACTIVE' && (
        <>
          <RoomingForm kind={kind} block={b} />
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="secondary"
              disabled={release.isPending}
              onClick={() => release.mutate(false)}
            >
              {t('groups.releaseNow')}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={release.isPending}
              onClick={() => release.mutate(true)}
            >
              {t('groups.cancelBlock')}
            </Button>
          </div>
        </>
      )}
      {release.error && <Alert tone="critical">{errorMessage(release.error)}</Alert>}
    </section>
  );
}

function BlockList({ kind }: { kind: Kind }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [status, setStatus] = useState<'ACTIVE' | 'RELEASED' | 'CANCELLED'>('ACTIVE');
  const q = useQuery({
    queryKey: [...KEY, kind, 'list', status],
    queryFn: () =>
      kind === 'GROUP'
        ? api.call('listGroupBlocks', { query: { status } })
        : api.call('listAllotments', { query: { status } }),
  });
  return (
    <section aria-label={t(`groups.tabs.${kind}`)}>
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label={t('groups.show')}
          className={selectClass}
          value={status}
          onChange={(e) => setStatus(e.target.value as typeof status)}
        >
          {(['ACTIVE', 'RELEASED', 'CANCELLED'] as const).map((s) => (
            <option key={s} value={s}>
              {t(`groups.status.${s}`)}
            </option>
          ))}
        </select>
        <Button className="ml-auto" onClick={() => setAdding((x) => !x)}>
          {adding ? t('groups.cancel') : t(`groups.add.${kind}`)}
        </Button>
      </div>
      {adding && (
        <div className="mt-3">
          <NewBlock
            kind={kind}
            onDone={(id) => {
              setAdding(false);
              setOpen(id);
            }}
          />
        </div>
      )}
      {q.error && <Alert tone="critical">{errorMessage(q.error)}</Alert>}
      {q.data?.data.length === 0 && (
        <p className="mt-3 text-sm text-text-muted">{t(`groups.none.${kind}`)}</p>
      )}
      <ul className="mt-3 flex flex-col gap-2">
        {q.data?.data.map((b: Block) => (
          <li key={b.id} className="rounded-md border border-border bg-surface p-3 text-sm">
            <div className="flex flex-wrap items-center gap-3">
              <span className="font-medium">{b.name}</span>
              <span className="text-text-muted">{b.code}</span>
              {b.company && <span>{b.company.name}</span>}
              <span className="text-text-muted">
                {b.arrival} – {b.departure}
              </span>
              <span>
                {b.roomTypes
                  .map((x) =>
                    t('groups.pickup', { name: x.name, picked: x.pickedUp, rooms: x.rooms }),
                  )
                  .join(' · ')}
              </span>
              <Button
                size="sm"
                variant="secondary"
                className="ml-auto"
                aria-expanded={open === b.id}
                onClick={() => setOpen((x) => (x === b.id ? null : b.id))}
              >
                {t('groups.open')}
              </Button>
            </div>
            {open === b.id && <BlockView kind={kind} blockId={b.id} />}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function GroupsPage() {
  const { t } = useTranslation();
  const { permissions } = useSession();
  const kinds = (['GROUP', 'ALLOTMENT'] as const).filter((k) =>
    permissions.includes(k === 'GROUP' ? 'group.manage' : 'allotment.manage'),
  );
  const [kind, setKind] = useState<Kind | undefined>(kinds[0]);
  const current = kind ?? kinds[0];
  if (!current) return null;
  return (
    <section className="max-w-5xl">
      <h1 className="text-xl font-semibold">{t('groups.title')}</h1>
      <div role="tablist" className="mt-3 flex gap-2">
        {kinds.map((k) => (
          <Button
            key={k}
            role="tab"
            aria-selected={current === k}
            size="sm"
            variant={current === k ? 'primary' : 'secondary'}
            onClick={() => setKind(k)}
          >
            {t(`groups.tabs.${k}`)}
          </Button>
        ))}
      </div>
      <div className="mt-4">
        <BlockList key={current} kind={current} />
      </div>
    </section>
  );
}
