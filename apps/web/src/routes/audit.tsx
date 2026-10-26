import type { AuditEvent as AuditEventSchema } from '@hotel/shared';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, PencilLine } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { z } from 'zod';
import { useSession } from '../app/session.ts';
import { Alert } from '../components/ui/alert.tsx';
import { Button } from '../components/ui/button.tsx';
import { Input } from '../components/ui/input.tsx';
import { Label } from '../components/ui/label.tsx';
import { api } from '../lib/api.ts';
import { errorMessage } from '../lib/form.ts';

// S27 Audit log (PRD M1-11; T-014): who did what to which record, newest first, filtered
// by person, record, action and date. Rows open to the before/after values.

type AuditEvent = z.output<typeof AuditEventSchema>;

/** Action groups offered in the filter (the API matches `group` and `group.*`). */
const ACTION_GROUPS = ['auth', 'user', 'role', 'invitation', 'organisation', 'session', 'device'];
const ENTITY_TYPES = ['user', 'role', 'invitation', 'organisation', 'session'];

/** Milliseconds `timeZone` is ahead of UTC at instant `at`. */
function zoneOffset(at: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(new Date(at));
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second')) - at;
}

/** Midnight at the start of a YYYY-MM-DD day in the property's time zone, as an Instant. */
export function startOfDay(isoDate: string, timeZone: string, addDays = 0): string {
  const [y, m, d] = isoDate.split('-').map(Number) as [number, number, number];
  const wall = Date.UTC(y, m - 1, d + addDays);
  return new Date(wall - zoneOffset(wall, timeZone)).toISOString().replace('.000Z', 'Z');
}

interface Filters {
  actorUserId: string;
  entityType: string;
  entityId: string;
  action: string;
  fromDate: string;
  toDate: string;
}
const NO_FILTERS: Filters = {
  actorUserId: '',
  entityType: '',
  entityId: '',
  action: '',
  fromDate: '',
  toDate: '',
};

const selectClass = 'h-10 rounded-md border border-border bg-surface px-3 text-sm';

export function AuditLogPage() {
  const { t } = useTranslation();
  const session = useSession();
  const property = session.properties.find((p) => p.id === session.currentPropertyId);
  const timeZone = property?.timeZone ?? 'UTC';
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const set = (key: keyof Filters) => (value: string) => setFilters({ ...filters, [key]: value });

  // The people filter lists staff of this property when the user may see them.
  const canListPeople = session.permissions.includes('role.assign');
  const people = useQuery({
    queryKey: ['access', session.currentPropertyId ?? '', 'users'],
    queryFn: () => api.call('listUsers', { query: { limit: 200 } }),
    enabled: canListPeople,
  });

  const query = {
    ...(filters.actorUserId ? { actorUserId: filters.actorUserId } : {}),
    ...(filters.entityType ? { entityType: filters.entityType } : {}),
    ...(filters.entityId.trim() ? { entityId: filters.entityId.trim() } : {}),
    ...(filters.action ? { action: filters.action } : {}),
    ...(filters.fromDate ? { from: startOfDay(filters.fromDate, timeZone) } : {}),
    // "To" is inclusive on screen: up to the start of the next day.
    ...(filters.toDate ? { to: startOfDay(filters.toDate, timeZone, 1) } : {}),
  };
  const events = useInfiniteQuery({
    queryKey: ['audit', session.currentPropertyId ?? '', query],
    queryFn: ({ pageParam }) =>
      api.call('listAuditEvents', {
        query: { limit: 50, ...query, ...(pageParam ? { cursor: pageParam } : {}) },
      }),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = events.data?.pages.flatMap((p) => p.data) ?? [];

  return (
    <section>
      <h1 className="text-xl font-semibold">{t('audit.title')}</h1>
      <p className="mt-1 text-sm text-text-muted">{t('audit.intro')}</p>

      <form
        className="mt-4 grid gap-3 rounded-md border border-border bg-surface p-3 sm:grid-cols-3"
        aria-label={t('audit.filters')}
        onSubmit={(e) => e.preventDefault()}
      >
        {canListPeople && (
          <div className="flex flex-col gap-1">
            <Label htmlFor="audit-actor">{t('audit.person')}</Label>
            <select
              id="audit-actor"
              className={selectClass}
              value={filters.actorUserId}
              onChange={(e) => set('actorUserId')(e.target.value)}
            >
              <option value="">{t('audit.anyone')}</option>
              {people.data?.data.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="flex flex-col gap-1">
          <Label htmlFor="audit-action">{t('audit.action')}</Label>
          <select
            id="audit-action"
            className={selectClass}
            value={filters.action}
            onChange={(e) => set('action')(e.target.value)}
          >
            <option value="">{t('audit.anyAction')}</option>
            {ACTION_GROUPS.map((group) => (
              <option key={group} value={group}>
                {t(`audit.groups.${group}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="audit-entity-type">{t('audit.recordType')}</Label>
          <select
            id="audit-entity-type"
            className={selectClass}
            value={filters.entityType}
            onChange={(e) => set('entityType')(e.target.value)}
          >
            <option value="">{t('audit.anyRecord')}</option>
            {ENTITY_TYPES.map((type) => (
              <option key={type} value={type}>
                {t(`audit.entities.${type}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="audit-entity-id">{t('audit.recordId')}</Label>
          <Input
            id="audit-entity-id"
            value={filters.entityId}
            onChange={(e) => set('entityId')(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="audit-from">{t('audit.from')}</Label>
          <Input
            id="audit-from"
            type="date"
            value={filters.fromDate}
            onChange={(e) => set('fromDate')(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="audit-to">{t('audit.to')}</Label>
          <Input
            id="audit-to"
            type="date"
            value={filters.toDate}
            onChange={(e) => set('toDate')(e.target.value)}
          />
        </div>
        <div className="flex items-end">
          <Button type="button" variant="secondary" onClick={() => setFilters(NO_FILTERS)}>
            {t('audit.clear')}
          </Button>
        </div>
      </form>

      <div className="mt-4">
        {events.error ? (
          <Alert tone="critical">{errorMessage(events.error)}</Alert>
        ) : !events.data ? (
          <p className="text-sm text-text-muted">{t('shell.loading')}</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-text-muted">{t('audit.empty')}</p>
        ) : (
          <ul
            aria-label={t('audit.events')}
            className="divide-y divide-border rounded-md border border-border bg-surface"
          >
            {rows.map((event) => (
              <EventRow
                key={event.id}
                event={event}
                timeZone={timeZone}
                locale={property?.locale}
              />
            ))}
          </ul>
        )}
        {events.hasNextPage && (
          <Button
            className="mt-3"
            variant="secondary"
            disabled={events.isFetchingNextPage}
            onClick={() => void events.fetchNextPage()}
          >
            {t('audit.more')}
          </Button>
        )}
      </div>
    </section>
  );
}

function EventRow({
  event,
  timeZone,
  locale,
}: {
  event: AuditEvent;
  timeZone: string;
  locale: string | undefined;
}) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const when = new Intl.DateTimeFormat(locale ?? i18n.language, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone,
  }).format(new Date(event.occurredAt));
  const actor =
    event.actor?.name ?? (event.actorType === 'SUPPORT' ? t('audit.support') : t('audit.system'));
  const Icon = open ? ChevronDown : ChevronRight;
  return (
    <li className="p-3">
      <button
        type="button"
        aria-expanded={open}
        className="flex w-full items-start gap-2 text-left"
        onClick={() => setOpen(!open)}
      >
        <Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-text-muted" />
        <span className="min-w-0 flex-1">
          <span className="block font-medium">
            {t(`audit.actions.${event.action}`, { defaultValue: event.action })}
          </span>
          <span className="block text-sm text-text-muted">
            {actor} · {t(`audit.entities.${event.entityType}`, { defaultValue: event.entityType })}{' '}
            · {when}
            {event.propertyId === null ? ` · ${t('audit.organisationWide')}` : ''}
          </span>
        </span>
      </button>
      {open && <EventDetails event={event} />}
    </li>
  );
}

const show = (value: unknown) =>
  value === undefined ? '—' : typeof value === 'string' ? value : JSON.stringify(value);

function EventDetails({ event }: { event: AuditEvent }) {
  const { t } = useTranslation();
  const asRecord = (v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const before = asRecord(event.before);
  const after = asRecord(event.after);
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  return (
    <div className="mt-3 ml-6 text-sm">
      {keys.length > 0 ? (
        <table className="w-full table-fixed border-collapse text-left">
          <thead className="text-xs text-text-muted">
            <tr>
              <th className="w-1/4 py-1 pr-2 font-medium">{t('audit.field')}</th>
              <th className="py-1 pr-2 font-medium">{t('audit.before')}</th>
              <th className="py-1 font-medium">{t('audit.after')}</th>
            </tr>
          </thead>
          <tbody>
            {keys.map((key) => {
              const changed = show(before[key]) !== show(after[key]);
              return (
                <tr key={key} className="border-t border-border align-top">
                  <td className="py-1 pr-2 font-mono text-xs">
                    {key}
                    {changed && event.before !== null && (
                      <span className="ml-1 inline-flex items-center gap-0.5 text-brand-strong">
                        <PencilLine aria-hidden className="size-3" />
                        {t('audit.changed')}
                      </span>
                    )}
                  </td>
                  <td className="py-1 pr-2 font-mono text-xs break-words">{show(before[key])}</td>
                  <td className="py-1 font-mono text-xs break-words">{show(after[key])}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <p className="text-text-muted">{t('audit.noValues')}</p>
      )}
      <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 text-xs text-text-muted">
        <dt>{t('audit.record')}</dt>
        <dd className="font-mono break-all">{event.entityId}</dd>
        {event.reason && (
          <>
            <dt>{t('audit.reason')}</dt>
            <dd>{event.reason}</dd>
          </>
        )}
        {event.ip && (
          <>
            <dt>{t('audit.ip')}</dt>
            <dd className="font-mono">{event.ip}</dd>
          </>
        )}
        {event.userAgent && (
          <>
            <dt>{t('audit.device')}</dt>
            <dd className="break-words">{event.userAgent}</dd>
          </>
        )}
        {event.requestId && (
          <>
            <dt>{t('audit.requestId')}</dt>
            <dd className="font-mono break-all">{event.requestId}</dd>
          </>
        )}
      </dl>
    </div>
  );
}
