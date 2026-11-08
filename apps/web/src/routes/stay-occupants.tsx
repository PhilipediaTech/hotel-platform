import { OCCUPANT_KINDS, type OccupantKind, type StayOccupants } from '@hotel/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { z } from 'zod';
import { useSession } from '../app/session.ts';
import { Alert } from '../components/ui/alert.tsx';
import { Button } from '../components/ui/button.tsx';
import { Input } from '../components/ui/input.tsx';
import { Label } from '../components/ui/label.tsx';
import occupantStrings from '../i18n/en/occupants.json';
import { registerStrings } from '../i18n/index.ts';
import { api } from '../lib/api.ts';
import { errorMessage } from '../lib/form.ts';
import { useFormats } from './reservations.tsx';

// People added to a stay (PRD M14-02, M14-03; T-056), on the reservation page. The nightly
// charge is the desk's to set: the field starts at the plan's suggestion for the next adult
// or child and can be changed (0 = free) with a reason. Loaded with its strings when shown.

registerStrings(occupantStrings);

type View = z.output<typeof StayOccupants>;
type Person = View['data'][number];

const naira = (minor: string) => (Number(minor) / 100).toString();

/** "5,000" or "0" → minor units; null when not an amount. Unlike toMinor, 0 is allowed. */
function amountMinor(text: string): string | null {
  const clean = text.replace(/[,\s₦]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(clean)) return null;
  const [whole = '0', fraction = ''] = clean.split('.');
  return (BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'))).toString();
}

export function StayPeople({ stayId, onChanged }: { stayId: string; onChanged: () => void }) {
  const { t } = useTranslation();
  const { permissions } = useSession();
  const queryClient = useQueryClient();
  const key = ['stay-occupants', stayId];
  const view = useQuery({
    queryKey: key,
    queryFn: () => api.call('listOccupants', { params: { stayId } }),
  });
  const [adding, setAdding] = useState(false);
  const canChange = permissions.includes('reservation.modify');
  const changed = (next: View) => {
    queryClient.setQueryData(key, next);
    onChanged();
  };

  if (view.error) {
    return (
      <Alert tone="critical" className="mt-2">
        {errorMessage(view.error)}
      </Alert>
    );
  }
  const v = view.data;
  if (!v) return null;
  const guests = v.adults + v.children;
  const open = ['TENTATIVE', 'CONFIRMED', 'CHECKED_IN'].includes(v.status);

  return (
    <section aria-label={t('occupants.title')} className="mt-3 border-t border-border pt-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-medium">{t('occupants.title')}</h3>
        <span className="text-xs text-text-muted">
          {t('occupants.limits', { guests, max: v.maxOccupancy, base: v.baseOccupancy })}
        </span>
      </div>
      {v.data.length === 0 ? (
        <p className="text-text-muted">{t('occupants.none')}</p>
      ) : (
        <ul className="mt-1 flex flex-col gap-1">
          {v.data.map((p) => (
            <PersonRow
              key={p.id}
              stayId={stayId}
              person={p}
              canChange={canChange && open}
              onChanged={changed}
            />
          ))}
        </ul>
      )}
      {canChange &&
        open &&
        (guests >= v.maxOccupancy ? (
          <p className="mt-1 text-xs text-text-muted">
            {t('occupants.full', { max: v.maxOccupancy })}
          </p>
        ) : adding ? (
          <AddPerson
            stayId={stayId}
            view={v}
            onDone={(next) => {
              changed(next);
              setAdding(false);
            }}
            onCancel={() => setAdding(false)}
          />
        ) : (
          <Button size="sm" variant="secondary" className="mt-2" onClick={() => setAdding(true)}>
            {t('occupants.add')}
          </Button>
        ))}
    </section>
  );
}

function AddPerson({
  stayId,
  view,
  onDone,
  onCancel,
}: {
  stayId: string;
  view: View;
  onDone: (next: View) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const f = useFormats();
  const [kind, setKind] = useState<OccupantKind>('ADULT');
  const [firstName, setFirst] = useState('');
  const [lastName, setLast] = useState('');
  const [phone, setPhone] = useState('');
  const [charge, setCharge] = useState(naira(view.suggested.ADULT));
  const [touched, setTouched] = useState(false);
  const [note, setNote] = useState('');
  const [bad, setBad] = useState(false);
  const suggested = view.suggested[kind];
  const minor = amountMinor(charge);
  const differs = minor !== null && minor !== suggested;
  const add = useMutation({
    mutationFn: () =>
      api.call('addOccupant', {
        params: { stayId },
        body: {
          firstName,
          lastName,
          kind,
          phone: phone.trim() || null,
          ...(view.isDayUse ? {} : { nightlyChargeMinor: minor ?? '0' }),
          chargeNote: differs ? note.trim() || null : null,
        },
      }),
    onSuccess: onDone,
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!view.isDayUse && minor === null) {
      setBad(true);
      return;
    }
    setBad(false);
    add.mutate();
  };
  const name = `${firstName} ${lastName}`.trim() || t('occupants.kinds.' + kind);

  return (
    <form
      aria-label={t('occupants.add')}
      onSubmit={submit}
      className="mt-2 grid gap-2 rounded-md border border-border p-3 sm:grid-cols-2"
    >
      <div className="flex flex-col gap-1">
        <Label htmlFor={`oc-first-${stayId}`}>{t('occupants.firstName')}</Label>
        <Input
          id={`oc-first-${stayId}`}
          value={firstName}
          onChange={(e) => setFirst(e.target.value)}
          required
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor={`oc-last-${stayId}`}>{t('occupants.lastName')}</Label>
        <Input
          id={`oc-last-${stayId}`}
          value={lastName}
          onChange={(e) => setLast(e.target.value)}
          required
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor={`oc-kind-${stayId}`}>{t('occupants.kind')}</Label>
        <select
          id={`oc-kind-${stayId}`}
          className="h-10 rounded-md border border-border bg-surface px-2"
          value={kind}
          onChange={(e) => {
            const next = e.target.value as OccupantKind;
            setKind(next);
            // Follow the suggestion until the desk types its own amount.
            if (!touched) setCharge(naira(view.suggested[next]));
          }}
        >
          {OCCUPANT_KINDS.map((k) => (
            <option key={k} value={k}>
              {t(`occupants.kinds.${k}`)}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor={`oc-phone-${stayId}`}>{t('occupants.phone')}</Label>
        <Input
          id={`oc-phone-${stayId}`}
          type="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
        />
      </div>
      {view.isDayUse ? (
        <p className="text-xs text-text-muted sm:col-span-2">{t('occupants.dayUse')}</p>
      ) : (
        <>
          <div className="flex flex-col gap-1">
            <Label htmlFor={`oc-charge-${stayId}`}>{t('occupants.charge')}</Label>
            <Input
              id={`oc-charge-${stayId}`}
              inputMode="decimal"
              value={charge}
              aria-invalid={bad || undefined}
              aria-describedby={`oc-charge-hint-${stayId}`}
              onChange={(e) => {
                setTouched(true);
                setCharge(e.target.value);
              }}
            />
            <span id={`oc-charge-hint-${stayId}`} className="text-xs text-text-muted">
              {suggested === '0'
                ? t('occupants.chargeHint_none')
                : t('occupants.chargeHint_suggested', { amount: f.money(suggested) })}
            </span>
            {bad && <span className="text-xs text-critical">{t('occupants.badAmount')}</span>}
          </div>
          {differs && (
            <div className="flex flex-col gap-1">
              <Label htmlFor={`oc-note-${stayId}`}>{t('occupants.note')}</Label>
              <Input
                id={`oc-note-${stayId}`}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                required
              />
              <span className="text-xs text-text-muted">{t('occupants.noteHint')}</span>
            </div>
          )}
          <p className="text-xs text-text-muted sm:col-span-2">{t('occupants.fromNext')}</p>
        </>
      )}
      {add.error && (
        <Alert tone="critical" className="sm:col-span-2">
          {errorMessage(add.error)}
        </Alert>
      )}
      <div className="flex gap-2 sm:col-span-2">
        <Button type="submit" size="sm" disabled={add.isPending}>
          {t('occupants.save', { name })}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          {t('occupants.cancel')}
        </Button>
      </div>
    </form>
  );
}

function PersonRow({
  stayId,
  person,
  canChange,
  onChanged,
}: {
  stayId: string;
  person: Person;
  canChange: boolean;
  onChanged: (next: View) => void;
}) {
  const { t } = useTranslation();
  const f = useFormats();
  const name = `${person.firstName} ${person.lastName}`;
  const [editing, setEditing] = useState(false);
  const [charge, setCharge] = useState(naira(person.nightlyChargeMinor));
  const [note, setNote] = useState('');
  const [bad, setBad] = useState(false);
  const ifMatch = { ifMatch: `"${person.version}"` };
  const params = { stayId, occupantId: person.id };
  const change = useMutation({
    mutationFn: (minor: string) =>
      api.call(
        'changeOccupantCharge',
        { params, body: { nightlyChargeMinor: minor, chargeNote: note.trim() || null } },
        ifMatch,
      ),
    onSuccess: (next) => {
      setEditing(false);
      onChanged(next);
    },
  });
  const remove = useMutation({
    mutationFn: () => api.call('removeOccupant', { params, body: {} }, ifMatch),
    onSuccess: onChanged,
  });
  const removed = person.removedAt !== null;

  return (
    <li className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className={removed ? 'text-text-muted line-through' : undefined}>
          {name} · {t(`occupants.kinds.${person.kind}`)}
        </span>
        <span className="text-text-muted">
          {removed
            ? t('occupants.removed')
            : person.nightlyChargeMinor === '0'
              ? t('occupants.free')
              : t('occupants.perNight', { amount: f.money(person.nightlyChargeMinor) })}
          {person.chargeNote ? ` · ${person.chargeNote}` : ''}
        </span>
      </div>
      {canChange && !removed && !editing && (
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="ghost"
            aria-label={t('occupants.changeChargeNamed', { name })}
            onClick={() => setEditing(true)}
          >
            {t('occupants.changeCharge')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            aria-label={t('occupants.removeNamed', { name })}
            disabled={remove.isPending}
            onClick={() => remove.mutate()}
          >
            {t('occupants.remove')}
          </Button>
        </div>
      )}
      {editing && (
        <form
          aria-label={t('occupants.changeChargeNamed', { name })}
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const minor = amountMinor(charge);
            if (minor === null) {
              setBad(true);
              return;
            }
            setBad(false);
            change.mutate(minor);
          }}
        >
          <div className="flex flex-col gap-1">
            <Label htmlFor={`oc-new-${person.id}`}>{t('occupants.newCharge')}</Label>
            <Input
              id={`oc-new-${person.id}`}
              className="w-32"
              inputMode="decimal"
              value={charge}
              aria-invalid={bad || undefined}
              onChange={(e) => setCharge(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor={`oc-why-${person.id}`}>{t('occupants.note')}</Label>
            <Input
              id={`oc-why-${person.id}`}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
          <Button type="submit" size="sm" disabled={change.isPending}>
            {t('occupants.saveCharge')}
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>
            {t('occupants.cancel')}
          </Button>
          {bad && <span className="text-xs text-critical">{t('occupants.badAmount')}</span>}
        </form>
      )}
      {(change.error ?? remove.error) && (
        <span className="text-xs text-critical">{errorMessage(change.error ?? remove.error)}</span>
      )}
    </li>
  );
}
