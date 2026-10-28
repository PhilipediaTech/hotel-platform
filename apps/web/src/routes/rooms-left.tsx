import { addDays, localDate, OverbookingBody, type InventoryDay } from '@hotel/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { z } from 'zod';
import { useSession } from '../app/session.ts';
import { Alert } from '../components/ui/alert.tsx';
import { Button } from '../components/ui/button.tsx';
import { api, ApiError } from '../lib/api.ts';
import { cn } from '../lib/cn.ts';
import { errorMessage } from '../lib/form.ts';
import { Field } from './auth/layout.tsx';
import { fieldErrorsOf, validated, type FieldErrors } from './settings/room-form.ts';

// Rooms left per room type and date (PRD M2 rule 1; T-040), on the S23 rates screen, with
// overbooking limits for users with rate.overbook (M2-09).

type Day = z.output<typeof InventoryDay>;
const WINDOW = 14;

export function RoomsLeft() {
  const { t } = useTranslation();
  const session = useSession();
  const property = session.properties.find((p) => p.id === session.currentPropertyId);
  const locale = property?.locale ?? 'en-NG';
  const today = localDate(new Date(), property?.timeZone ?? 'Africa/Lagos');
  const [from, setFrom] = useState(today);
  const [editing, setEditing] = useState(false);
  const to = addDays(from, WINDOW - 1);
  const key = ['rates', session.currentPropertyId ?? '', 'inventory', from];
  const inventory = useQuery({
    queryKey: key,
    queryFn: async () => (await api.call('getInventory', { query: { from, to } })).days,
  });
  const types = useQuery({
    queryKey: ['rooms', session.currentPropertyId ?? '', 'types'],
    queryFn: async () => (await api.call('listRoomTypes')).data,
  });
  const canOverbook = session.permissions.includes('rate.overbook');

  const error = inventory.error ?? types.error;
  if (error) return <Alert tone="critical">{errorMessage(error)}</Alert>;
  if (!inventory.data || !types.data) {
    return <p className="text-sm text-text-muted">{t('shell.loading')}</p>;
  }
  const dates = Array.from({ length: WINDOW }, (_, i) => addDays(from, i));
  const byType = new Map<string, Map<string, Day>>();
  for (const d of inventory.data) {
    const row = byType.get(d.roomTypeId) ?? new Map<string, Day>();
    row.set(d.date, d);
    byType.set(d.roomTypeId, row);
  }
  const heading = (date: string) =>
    new Intl.DateTimeFormat(locale, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      timeZone: 'UTC',
    }).format(new Date(`${date}T00:00:00Z`));

  return (
    <div className="mt-4">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Button
          size="icon"
          variant="ghost"
          aria-label={t('rates.earlier')}
          onClick={() => setFrom(addDays(from, -WINDOW))}
        >
          <ChevronLeft aria-hidden className="size-4" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          aria-label={t('rates.later')}
          onClick={() => setFrom(addDays(from, WINDOW))}
        >
          <ChevronRight aria-hidden className="size-4" />
        </Button>
        <p className="flex-1 text-sm text-text-muted">{t('roomsLeft.intro')}</p>
        {canOverbook && !editing && (
          <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
            {t('roomsLeft.overbook')}
          </Button>
        )}
      </div>
      {editing && (
        <OverbookingForm
          types={types.data.filter((rt) => rt.active)}
          today={today}
          onDone={() => setEditing(false)}
        />
      )}
      <div className="overflow-x-auto rounded-md border border-border bg-surface">
        <table aria-label={t('roomsLeft.grid')} className="text-sm">
          <thead>
            <tr className="border-b border-border">
              <th className="sticky left-0 bg-surface p-2 text-left font-medium">
                {t('rates.roomType')}
              </th>
              {dates.map((date) => (
                <th key={date} className="min-w-20 p-2 text-center text-xs font-medium">
                  {heading(date)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {types.data
              .filter((rt) => byType.has(rt.id))
              .map((rt) => {
                const row = byType.get(rt.id);
                return (
                  <tr key={rt.id} className="border-b border-border last:border-0">
                    <th scope="row" className="sticky left-0 bg-surface p-2 text-left font-medium">
                      {rt.name}
                    </th>
                    {dates.map((date) => {
                      const d = row?.get(date);
                      return (
                        <td
                          key={date}
                          className={cn(
                            'p-2 text-center align-top',
                            d && d.available <= 0 && 'bg-critical-subtle',
                          )}
                        >
                          {d ? (
                            <>
                              <span className="font-medium tabular-nums">{d.available}</span>
                              <span className="block text-[11px] leading-tight text-text-muted">
                                {t('roomsLeft.of', { capacity: d.capacity })}
                                {d.outOfOrder > 0 &&
                                  ` · ${t('roomsLeft.ooo', { n: d.outOfOrder })}`}
                                {d.overbookLimit > 0 &&
                                  ` · ${t('roomsLeft.plus', { n: d.overbookLimit })}`}
                              </span>
                            </>
                          ) : (
                            '–'
                          )}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function OverbookingForm({
  types,
  today,
  onDone,
}: {
  types: { id: string; name: string }[];
  today: string;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { currentPropertyId } = useSession();
  const [roomTypeIds, setRoomTypeIds] = useState(types.map((rt) => rt.id));
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(addDays(today, 90));
  const [limit, setLimit] = useState('1');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [result, setResult] = useState<number | null>(null);
  const save = useMutation({
    mutationFn: async () =>
      api.call('setOverbooking', {
        body: validated(OverbookingBody, { roomTypeIds, from, to, limit: Number(limit) }),
      }),
    onSuccess: (res) => {
      setResult(res.changedDays);
      void queryClient.invalidateQueries({
        queryKey: ['rates', currentPropertyId ?? '', 'inventory'],
      });
    },
    onError: (error) => setErrors(fieldErrorsOf(error)),
  });
  const conflictText =
    save.error instanceof ApiError && save.error.code === 'STATE_TRANSITION_INVALID'
      ? errorMessage(save.error)
      : null;

  return (
    <form
      noValidate
      aria-label={t('roomsLeft.overbook')}
      className="mb-3 max-w-3xl rounded-md border border-border bg-surface p-4"
      onSubmit={(e) => {
        e.preventDefault();
        setErrors({});
        setResult(null);
        save.mutate();
      }}
    >
      <p className="mb-3 text-sm text-text-muted">{t('roomsLeft.overbookIntro')}</p>
      <fieldset className="mb-4">
        <legend className="mb-1 text-sm font-medium">{t('rates.bulk.roomTypes')}</legend>
        <div className="flex flex-wrap gap-3">
          {types.map((rt) => (
            <label key={rt.id} className="flex items-center gap-1 text-sm">
              <input
                type="checkbox"
                checked={roomTypeIds.includes(rt.id)}
                onChange={() =>
                  setRoomTypeIds((ids) =>
                    ids.includes(rt.id) ? ids.filter((x) => x !== rt.id) : [...ids, rt.id],
                  )
                }
              />
              {rt.name}
            </label>
          ))}
        </div>
        {errors['roomTypeIds'] && <p className="text-sm text-critical">{errors['roomTypeIds']}</p>}
      </fieldset>
      <div className="grid gap-x-4 sm:grid-cols-3">
        <Field
          label={t('rates.bulk.from')}
          type="date"
          min={today}
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          error={errors['from']}
        />
        <Field
          label={t('rates.bulk.to')}
          type="date"
          min={from}
          value={to}
          onChange={(e) => setTo(e.target.value)}
          error={errors['to']}
        />
        <Field
          label={t('roomsLeft.limit')}
          hint={t('roomsLeft.limitHint')}
          inputMode="numeric"
          value={limit}
          onChange={(e) => setLimit(e.target.value)}
          error={errors['limit']}
        />
      </div>
      {conflictText && (
        <Alert tone="critical" className="mb-3">
          {conflictText}
        </Alert>
      )}
      {result !== null && (
        <p role="status" className="mb-3 text-sm">
          {t('rates.bulk.done', { count: result })}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" disabled={save.isPending}>
          {t('rates.save')}
        </Button>
        <Button variant="secondary" onClick={onDone}>
          {t('rates.cancel')}
        </Button>
      </div>
    </form>
  );
}
