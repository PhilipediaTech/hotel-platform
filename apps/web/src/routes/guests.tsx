import { GuestBody, GuestFlagsBody, GuestPatchBody, type GuestItem } from '@hotel/shared';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, Crown } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router';
import type { z } from 'zod';
import { useSession } from '../app/session.ts';
import { Alert } from '../components/ui/alert.tsx';
import { Button } from '../components/ui/button.tsx';
import { Input } from '../components/ui/input.tsx';
import { Label } from '../components/ui/label.tsx';
import { api, ApiError } from '../lib/api.ts';
import { errorMessage } from '../lib/form.ts';
import { Field } from './auth/layout.tsx';
import {
  fieldErrorsOf,
  labelsFrom,
  labelsText,
  serverErrors,
  validated,
  type FieldErrors,
} from './settings/room-form.ts';

// S13 Guest profiles (PRD M3-15, M3-18; T-043): search, add, edit, flag, merge duplicates.
// Stay history arrives with reservations (T-042).

type Guest = z.output<typeof GuestItem>;

const guestsKey = (propertyId: string | null) => ['guests', propertyId ?? ''];
/** Blank inputs mean "none". */
const orNull = (v: string) => (v.trim() === '' ? null : v.trim());

export function FlagBadges({ guest }: { guest: Guest }) {
  const { t } = useTranslation();
  if (!guest.flags) return null;
  return (
    <>
      {guest.flags.vip && (
        <span className="ml-2 inline-flex items-center gap-1 rounded bg-brand-subtle px-1.5 py-0.5 text-xs text-brand-strong">
          <Crown aria-hidden className="size-3" />
          {t('guests.vip')}
        </span>
      )}
      {guest.flags.doNotRent && (
        <span className="ml-2 inline-flex items-center gap-1 rounded bg-critical-subtle px-1.5 py-0.5 text-xs text-critical">
          <Ban aria-hidden className="size-3" />
          {t('guests.doNotRent')}
        </span>
      )}
    </>
  );
}

function useGuestSearch(q: string, limit = 25) {
  const { currentPropertyId } = useSession();
  return useInfiniteQuery({
    queryKey: [...guestsKey(currentPropertyId), 'search', q],
    queryFn: ({ pageParam }) =>
      api.call('listGuests', {
        query: { limit, ...(q ? { q } : {}), ...(pageParam ? { cursor: pageParam } : {}) },
      }),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

export function GuestsPage() {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);
  const search = useGuestSearch(q);
  const guests = search.data?.pages.flatMap((p) => p.data) ?? [];

  return (
    <section className="max-w-4xl">
      <h1 className="text-xl font-semibold">{t('guests.title')}</h1>
      <form
        role="search"
        className="mt-4 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setQ(text.trim());
        }}
      >
        <Input
          aria-label={t('guests.search')}
          placeholder={t('guests.searchHint')}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <Button type="submit">{t('guests.find')}</Button>
        {!adding && (
          <Button variant="secondary" onClick={() => setAdding(true)}>
            {t('guests.add')}
          </Button>
        )}
      </form>
      {adding && <NewGuestForm onDone={() => setAdding(false)} />}
      {search.error && (
        <Alert tone="critical" className="mt-3">
          {errorMessage(search.error)}
        </Alert>
      )}
      {search.data && guests.length === 0 && (
        <p className="mt-4 text-sm text-text-muted">{q ? t('guests.noMatch') : t('guests.none')}</p>
      )}
      {guests.length > 0 && (
        <table aria-label={t('guests.results')} className="mt-4 w-full text-left text-sm">
          <thead className="border-b border-border text-text-muted">
            <tr>
              <th className="p-2 font-medium">{t('guests.name')}</th>
              <th className="p-2 font-medium">{t('guests.phone')}</th>
              <th className="p-2 font-medium">{t('guests.email')}</th>
            </tr>
          </thead>
          <tbody>
            {guests.map((g) => (
              <tr key={g.id} className="border-b border-border last:border-0">
                <td className="p-2">
                  <Link to={`/guests/${g.id}`} className="text-brand underline">
                    {g.firstName} {g.lastName}
                  </Link>
                  <FlagBadges guest={g} />
                </td>
                <td className="p-2">{g.phone}</td>
                <td className="p-2">{g.email}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {search.hasNextPage && (
        <Button
          className="mt-3"
          variant="secondary"
          size="sm"
          onClick={() => void search.fetchNextPage()}
        >
          {t('guests.more')}
        </Button>
      )}
    </section>
  );
}

function NewGuestForm({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { currentPropertyId } = useSession();
  const [d, setD] = useState({ firstName: '', lastName: '', phone: '', email: '' });
  const [errors, setErrors] = useState<FieldErrors>({});
  const save = useMutation({
    mutationFn: async () =>
      api.call('createGuest', {
        body: validated(GuestBody, {
          firstName: d.firstName,
          lastName: d.lastName,
          phone: orNull(d.phone),
          email: orNull(d.email),
        }),
      }),
    onSuccess: (guest) => {
      void queryClient.invalidateQueries({ queryKey: guestsKey(currentPropertyId) });
      void navigate(`/guests/${guest.id}`);
    },
    onError: (error) => setErrors(fieldErrorsOf(error)),
  });
  const set = (k: keyof typeof d) => (e: { target: { value: string } }) =>
    setD((x) => ({ ...x, [k]: e.target.value }));
  return (
    <form
      noValidate
      aria-label={t('guests.add')}
      className="mt-3 rounded-md border border-border bg-surface p-4"
      onSubmit={(e) => {
        e.preventDefault();
        setErrors({});
        save.mutate();
      }}
    >
      <div className="grid gap-x-4 sm:grid-cols-2">
        <Field
          label={t('guests.firstName')}
          value={d.firstName}
          onChange={set('firstName')}
          error={errors['firstName']}
        />
        <Field
          label={t('guests.lastName')}
          value={d.lastName}
          onChange={set('lastName')}
          error={errors['lastName']}
        />
        <Field
          label={t('guests.phone')}
          type="tel"
          hint={t('guests.phoneHint')}
          value={d.phone}
          onChange={set('phone')}
          error={errors['phone']}
        />
        <Field
          label={t('guests.email')}
          type="email"
          value={d.email}
          onChange={set('email')}
          error={errors['email']}
        />
      </div>
      <FormError error={save.error} />
      <div className="flex gap-2">
        <Button type="submit" disabled={save.isPending}>
          {t('guests.save')}
        </Button>
        <Button variant="secondary" onClick={onDone}>
          {t('guests.cancel')}
        </Button>
      </div>
    </form>
  );
}

function FormError({ error }: { error: unknown }) {
  if (!(error instanceof ApiError) || Object.keys(serverErrors(error)).length > 0) return null;
  return (
    <Alert tone="critical" className="mb-3">
      {errorMessage(error)}
    </Alert>
  );
}

export function GuestProfilePage() {
  const { t } = useTranslation();
  const { guestId = '' } = useParams();
  const { currentPropertyId } = useSession();
  const guest = useQuery({
    queryKey: [...guestsKey(currentPropertyId), guestId],
    queryFn: () => api.call('getGuest', { params: { guestId } }),
  });
  if (guest.error) return <Alert tone="critical">{errorMessage(guest.error)}</Alert>;
  if (!guest.data) return <p className="text-sm text-text-muted">{t('shell.loading')}</p>;
  const g = guest.data;
  return (
    <section className="max-w-3xl">
      <p className="text-sm">
        <Link to="/guests" className="text-brand underline">
          {t('guests.title')}
        </Link>
      </p>
      <h1 className="mt-1 text-xl font-semibold">
        {g.firstName} {g.lastName}
        <FlagBadges guest={g} />
      </h1>
      {g.mergedIntoId ? (
        <Alert tone="info" className="mt-3">
          {t('guests.merged')}{' '}
          <Link to={`/guests/${g.mergedIntoId}`} className="underline">
            {t('guests.openKept')}
          </Link>
        </Alert>
      ) : (
        <>
          <GuestForm key={g.updatedAt} guest={g} />
          {g.flags && <FlagsForm key={`flags-${g.updatedAt}`} guest={g} />}
          <MergePanel guest={g} />
          <p className="mt-6 text-sm text-text-muted">{t('guests.staysLater')}</p>
        </>
      )}
    </section>
  );
}

function useSaved() {
  const queryClient = useQueryClient();
  const { currentPropertyId } = useSession();
  return (saved: Guest) => {
    queryClient.setQueryData([...guestsKey(currentPropertyId), saved.id], saved);
    void queryClient.invalidateQueries({ queryKey: [...guestsKey(currentPropertyId), 'search'] });
  };
}

function GuestForm({ guest }: { guest: Guest }) {
  const { t } = useTranslation();
  const saved = useSaved();
  const [d, setD] = useState({
    firstName: guest.firstName,
    lastName: guest.lastName,
    phone: guest.phone ?? '',
    email: guest.email ?? '',
    nationality: guest.nationality ?? '',
    notes: guest.preferences.notes ?? '',
    tags: labelsText(guest.preferences.tags),
    marketingConsent: guest.marketingConsent,
  });
  const [errors, setErrors] = useState<FieldErrors>({});
  const save = useMutation({
    mutationFn: async () =>
      api.call('updateGuest', {
        params: { guestId: guest.id },
        body: validated(GuestPatchBody, {
          firstName: d.firstName,
          lastName: d.lastName,
          phone: orNull(d.phone),
          email: orNull(d.email),
          nationality: orNull(d.nationality),
          preferences: { notes: orNull(d.notes), tags: labelsFrom(d.tags) },
          marketingConsent: d.marketingConsent,
        }),
      }),
    onSuccess: saved,
    onError: (error) => setErrors(fieldErrorsOf(error)),
  });
  const set = (k: keyof typeof d) => (e: { target: { value: string } }) =>
    setD((x) => ({ ...x, [k]: e.target.value }));
  return (
    <form
      noValidate
      aria-label={t('guests.details')}
      className="mt-4 rounded-md border border-border bg-surface p-4"
      onSubmit={(e) => {
        e.preventDefault();
        setErrors({});
        save.mutate();
      }}
    >
      <h2 className="mb-3 font-semibold">{t('guests.details')}</h2>
      <div className="grid gap-x-4 sm:grid-cols-2">
        <Field
          label={t('guests.firstName')}
          value={d.firstName}
          onChange={set('firstName')}
          error={errors['firstName']}
        />
        <Field
          label={t('guests.lastName')}
          value={d.lastName}
          onChange={set('lastName')}
          error={errors['lastName']}
        />
        <Field
          label={t('guests.phone')}
          type="tel"
          hint={t('guests.phoneHint')}
          value={d.phone}
          onChange={set('phone')}
          error={errors['phone']}
        />
        <Field
          label={t('guests.email')}
          type="email"
          value={d.email}
          onChange={set('email')}
          error={errors['email']}
        />
        <Field
          label={t('guests.nationality')}
          hint={t('guests.nationalityHint')}
          value={d.nationality}
          onChange={set('nationality')}
          error={errors['nationality']}
        />
        <Field
          label={t('guests.tags')}
          hint={t('guests.tagsHint')}
          value={d.tags}
          onChange={set('tags')}
          error={errors['preferences']}
        />
      </div>
      <div className="mb-4 flex flex-col gap-1">
        <Label htmlFor="guest-notes">{t('guests.notes')}</Label>
        <textarea
          id="guest-notes"
          rows={3}
          className="rounded-md border border-border bg-surface p-2 text-sm"
          value={d.notes}
          onChange={set('notes')}
        />
      </div>
      <label className="mb-4 flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={d.marketingConsent}
          onChange={(e) => setD((x) => ({ ...x, marketingConsent: e.target.checked }))}
        />
        {t('guests.consent')}
      </label>
      <FormError error={save.error} />
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={save.isPending}>
          {t('guests.save')}
        </Button>
        {save.isSuccess && (
          <span role="status" className="text-sm">
            {t('guests.saved')}
          </span>
        )}
      </div>
    </form>
  );
}

function FlagsForm({ guest }: { guest: Guest }) {
  const { t } = useTranslation();
  const saved = useSaved();
  const [vip, setVip] = useState(guest.flags?.vip ?? false);
  const [dnr, setDnr] = useState(guest.flags?.doNotRent ?? false);
  const [reason, setReason] = useState(guest.flags?.reason ?? '');
  const [errors, setErrors] = useState<FieldErrors>({});
  const save = useMutation({
    mutationFn: async () =>
      api.call('flagGuest', {
        params: { guestId: guest.id },
        body: validated(GuestFlagsBody, { vip, doNotRent: dnr, reason: orNull(reason) }),
      }),
    onSuccess: saved,
    onError: (error) => setErrors(fieldErrorsOf(error)),
  });
  return (
    <form
      noValidate
      aria-label={t('guests.flags')}
      className="mt-4 rounded-md border border-border bg-surface p-4"
      onSubmit={(e) => {
        e.preventDefault();
        setErrors({});
        save.mutate();
      }}
    >
      <h2 className="mb-1 font-semibold">{t('guests.flags')}</h2>
      <p className="mb-3 text-xs text-text-muted">{t('guests.flagsHint')}</p>
      <div className="mb-3 flex gap-6 text-sm">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={vip} onChange={(e) => setVip(e.target.checked)} />
          {t('guests.vip')}
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={dnr} onChange={(e) => setDnr(e.target.checked)} />
          {t('guests.doNotRent')}
        </label>
      </div>
      <Field
        label={t('guests.reason')}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        error={errors['reason']}
      />
      <FormError error={save.error} />
      <Button type="submit" disabled={save.isPending}>
        {t('guests.saveFlags')}
      </Button>
    </form>
  );
}

/** Find the duplicate, then merge: the older profile is kept (PRD M3 rule). */
function MergePanel({ guest }: { guest: Guest }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const saved = useSaved();
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [chosen, setChosen] = useState<Guest | null>(null);
  const search = useGuestSearch(q, 10);
  const matches = q
    ? (search.data?.pages.flatMap((p) => p.data) ?? []).filter((g) => g.id !== guest.id)
    : [];
  const merge = useMutation({
    mutationFn: (other: Guest) =>
      api.call('mergeGuests', { params: { guestId: guest.id }, body: { otherGuestId: other.id } }),
    onSuccess: (kept) => {
      saved(kept);
      setChosen(null);
      if (kept.id !== guest.id) void navigate(`/guests/${kept.id}`);
    },
  });
  return (
    <section
      aria-labelledby="merge"
      className="mt-4 rounded-md border border-border bg-surface p-4"
    >
      <h2 id="merge" className="mb-1 font-semibold">
        {t('guests.merge')}
      </h2>
      <p className="mb-3 text-xs text-text-muted">{t('guests.mergeHint')}</p>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setQ(text.trim());
        }}
      >
        <Input
          aria-label={t('guests.findDuplicate')}
          placeholder={t('guests.searchHint')}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <Button type="submit" variant="secondary">
          {t('guests.find')}
        </Button>
      </form>
      {matches.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1 text-sm">
          {matches.map((g) => (
            <li key={g.id} className="flex items-center gap-2">
              <span className="flex-1">
                {g.firstName} {g.lastName} · {g.phone ?? g.email ?? '—'}
              </span>
              <Button size="sm" variant="ghost" onClick={() => setChosen(g)}>
                {t('guests.pick')}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {chosen && (
        <Alert tone="info" className="mt-3">
          {t('guests.mergeConfirm', { name: `${chosen.firstName} ${chosen.lastName}` })}
          <div className="mt-2 flex gap-2">
            <Button size="sm" disabled={merge.isPending} onClick={() => merge.mutate(chosen)}>
              {t('guests.mergeNow')}
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setChosen(null)}>
              {t('guests.cancel')}
            </Button>
          </div>
        </Alert>
      )}
      {merge.error && (
        <Alert tone="critical" className="mt-3">
          {errorMessage(merge.error)}
        </Alert>
      )}
    </section>
  );
}
