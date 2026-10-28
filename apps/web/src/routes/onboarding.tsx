import {
  MANUAL_PAY_METHODS,
  OrganisationPatchBody,
  Phone,
  PropertyAddressBody,
  SETUP_STEPS,
  TaxRegistrationBody,
  TimeOfDay,
  type PropertyDetail,
  type RouteInput,
  type updateProperty,
  type SetupStepId,
} from '@hotel/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Circle, Clock, Rocket } from 'lucide-react';
import { useState, type ComponentProps } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router';
import { z } from 'zod';
import { ME_QUERY_KEY, useSession } from '../app/session.ts';
import { Alert } from '../components/ui/alert.tsx';
import { Button } from '../components/ui/button.tsx';
import { Label } from '../components/ui/label.tsx';
import { api, ApiError } from '../lib/api.ts';
import { cn } from '../lib/cn.ts';
import { apiFieldErrors, errorMessage, zodResolver } from '../lib/form.ts';
import { Field } from './auth/layout.tsx';

// S02 setup wizard (PRD M1-02; T-030): the checklist an owner completes before the property
// takes bookings, then go-live. Each step saves on its own; the checklist comes from the API.

type Property = z.output<typeof PropertyDetail>;
type StepId = SetupStepId | 'go-live';
type PatchBody = NonNullable<RouteInput<typeof updateProperty>['body']>;

/** Empty text inputs mean "none". */
const orNull = <T extends z.ZodType>(schema: T) =>
  z.union([z.literal('').transform(() => null), schema]);

const DetailsForm = z.object({
  name: z.string().trim().min(1).max(120),
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]{2,6}$/, 'Two to six letters or digits, e.g. LAG'),
  address: PropertyAddressBody,
  phone: orNull(Phone),
  email: orNull(z.email()),
  taxRegistration: TaxRegistrationBody,
});

const RegionForm = z.object({
  timeZone: z.string().min(1),
  baseCurrency: z.string().length(3),
  locale: z.string().min(2),
  checkInTime: TimeOfDay,
  checkOutTime: TimeOfDay,
  nightAuditTime: TimeOfDay,
});

/** Currencies offered first; the property's own is always in the list. */
const CURRENCIES = ['NGN', 'GHS', 'KES', 'ZAR', 'USD', 'GBP', 'EUR'];

function propertyKey(propertyId: string | null) {
  return ['setup', propertyId ?? '', 'property'];
}

export function SetupWizardPage() {
  const { t } = useTranslation();
  const session = useSession();
  const [search, setSearch] = useSearchParams();
  const propertyId = session.currentPropertyId ?? '';
  const property = useQuery({
    queryKey: propertyKey(propertyId),
    queryFn: () => api.call('getProperty', { params: { propertyId } }),
    enabled: propertyId !== '',
  });

  if (property.error) return <Alert tone="critical">{errorMessage(property.error)}</Alert>;
  if (!property.data) return <p className="text-sm text-text-muted">{t('shell.loading')}</p>;

  const p = property.data;
  const steps = p.checklist.steps;
  const firstOpen = steps.find((s) => s.status === 'TODO')?.id ?? 'go-live';
  const wanted = search.get('step') as StepId | null;
  const current: StepId =
    wanted && (wanted === 'go-live' || steps.some((s) => s.id === wanted)) ? wanted : firstOpen;
  const required = steps.filter((s) => s.required && s.status !== 'LATER');
  const done = required.filter((s) => s.status === 'DONE').length;

  return (
    <section>
      <h1 className="text-xl font-semibold">{t('setup.title', { property: p.name })}</h1>
      <p className="mt-1 text-sm text-text-muted">
        {p.status === 'LIVE' ? t('setup.introLive') : t('setup.intro')}
      </p>
      <div className="mt-4 grid gap-6 md:grid-cols-[16rem_1fr]">
        <nav aria-label={t('setup.checklist')}>
          <p className="text-sm font-medium" id="setup-progress">
            {t('setup.progress', { done, total: required.length })}
          </p>
          <div
            role="progressbar"
            aria-labelledby="setup-progress"
            aria-valuemin={0}
            aria-valuemax={required.length}
            aria-valuenow={done}
            className="mt-2 h-2 overflow-hidden rounded-full bg-surface-muted"
          >
            <div
              className="h-full bg-brand"
              style={{ width: `${required.length ? (done / required.length) * 100 : 100}%` }}
            />
          </div>
          <ol className="mt-3 flex flex-col gap-1">
            {[...steps, { id: 'go-live' as const, status: null, required: true, ticket: null }].map(
              (s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    aria-current={s.id === current ? 'step' : undefined}
                    onClick={() => setSearch({ step: s.id })}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm',
                      s.id === current ? 'bg-brand-subtle font-medium' : 'hover:bg-surface-muted',
                    )}
                  >
                    <StepIcon status={s.status} />
                    <span className="flex-1">{t(`setup.steps.${s.id}`)}</span>
                    <span className="text-xs text-text-muted">
                      {s.status === 'LATER'
                        ? t('setup.later', { ticket: s.ticket })
                        : s.id !== 'go-live' && !s.required
                          ? t('setup.optional')
                          : s.status === 'DONE'
                            ? t('setup.done')
                            : null}
                    </span>
                  </button>
                </li>
              ),
            )}
          </ol>
        </nav>
        <section
          aria-labelledby="setup-step"
          className="min-w-0 rounded-md border border-border bg-surface p-4"
        >
          <h2 id="setup-step" className="mb-3 text-lg font-semibold">
            {t(`setup.steps.${current}`)}
          </h2>
          <StepPanel step={current} property={p} />
        </section>
      </div>
    </section>
  );
}

function StepIcon({ status }: { status: 'DONE' | 'TODO' | 'LATER' | null }) {
  const { t } = useTranslation();
  if (status === null) return <Rocket aria-hidden className="size-4 shrink-0 text-brand" />;
  const Icon = status === 'DONE' ? CheckCircle2 : status === 'LATER' ? Clock : Circle;
  return (
    <Icon
      aria-label={t(`setup.status.${status}`)}
      className={cn('size-4 shrink-0', status === 'DONE' ? 'text-success' : 'text-text-muted')}
    />
  );
}

function StepPanel({ step, property }: { step: StepId; property: Property }) {
  const { t } = useTranslation();
  const def = SETUP_STEPS.find((s) => s.id === step);
  if (def?.later) {
    return (
      <Alert tone="info">
        {t(`setup.laterText.${step}`, { defaultValue: '' })}{' '}
        {t('setup.laterNote', { ticket: def.later })}
      </Alert>
    );
  }
  switch (step) {
    case 'organisation':
      return <OrganisationStep />;
    case 'details':
      return <DetailsStep property={property} />;
    case 'region':
      return <RegionStep property={property} />;
    case 'payment-methods':
      return <PaymentMethodsStep property={property} />;
    case 'staff':
      return (
        <div className="text-sm">
          <p>{t('setup.staffText')}</p>
          <Link to="/settings/access" className="mt-3 inline-block text-brand underline">
            {t('setup.staffLink')}
          </Link>
        </div>
      );
    case 'go-live':
      return <GoLiveStep property={property} />;
    case 'tax':
    case 'room-types':
    case 'rooms':
    case 'rates':
      return null; // shown as "arrives with" above
  }
}

/** Saves a property change and refreshes the checklist and the shell (name, status). */
function useSaveProperty(form?: { setError: (name: never, error: { message: string }) => void }) {
  const queryClient = useQueryClient();
  const { currentPropertyId } = useSession();
  const propertyId = currentPropertyId ?? '';
  return useMutation({
    mutationFn: (body: PatchBody) => api.call('updateProperty', { params: { propertyId }, body }),
    onSuccess: (saved) => {
      queryClient.setQueryData(propertyKey(propertyId), saved);
      void queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY });
    },
    onError: (error) => {
      for (const { field, message } of apiFieldErrors(error)) {
        form?.setError(field as never, { message });
      }
    },
  });
}

function SaveRow({ pending, saved, error }: { pending: boolean; saved: boolean; error: unknown }) {
  const { t } = useTranslation();
  return (
    <>
      {error !== null && apiFieldErrors(error).length === 0 && (
        <Alert tone="critical" className="mb-3">
          {errorMessage(error)}
        </Alert>
      )}
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {t('setup.save')}
        </Button>
        {saved && (
          <span role="status" className="text-sm">
            {t('setup.saved')}
          </span>
        )}
      </div>
    </>
  );
}

function OrganisationStep() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { currentPropertyId } = useSession();
  const key = ['setup', currentPropertyId ?? '', 'organisation'];
  const organisation = useQuery({ queryKey: key, queryFn: () => api.call('getOrganisation') });
  const form = useForm({
    resolver: zodResolver(OrganisationPatchBody),
    values: organisation.data
      ? { name: organisation.data.name, legalName: organisation.data.legalName ?? '' }
      : undefined,
  });
  const save = useMutation({
    mutationFn: (body: z.output<typeof OrganisationPatchBody>) =>
      api.call('updateOrganisation', { body }),
    onSuccess: (saved) => {
      queryClient.setQueryData(key, saved);
      void queryClient.invalidateQueries({ queryKey: ['setup', currentPropertyId ?? ''] });
    },
  });
  if (organisation.error) return <Alert tone="critical">{errorMessage(organisation.error)}</Alert>;
  if (!organisation.data) return <p className="text-sm text-text-muted">{t('shell.loading')}</p>;
  const errors = form.formState.errors;
  return (
    <form
      noValidate
      onSubmit={(event) => void form.handleSubmit((body) => save.mutate(body))(event)}
    >
      <Field
        label={t('setup.fields.organisationName')}
        error={errors.name?.message}
        {...form.register('name')}
      />
      <Field
        label={t('setup.fields.legalName')}
        hint={t('setup.fields.legalNameHint')}
        error={errors.legalName?.message}
        {...form.register('legalName')}
      />
      <SaveRow pending={save.isPending} saved={save.isSuccess} error={save.error} />
    </form>
  );
}

function DetailsStep({ property: p }: { property: Property }) {
  const { t } = useTranslation();
  const form = useForm({
    resolver: zodResolver(DetailsForm),
    defaultValues: {
      name: p.name,
      code: p.code,
      address: {
        line1: p.address.line1 ?? '',
        line2: p.address.line2 ?? '',
        city: p.address.city ?? '',
        state: p.address.state ?? '',
        postalCode: p.address.postalCode ?? '',
        country: p.address.country,
      },
      phone: p.phone ?? '',
      email: p.email ?? '',
      taxRegistration: {
        tin: p.taxRegistration.tin ?? '',
        vatNumber: p.taxRegistration.vatNumber ?? '',
      },
    },
  });
  const save = useSaveProperty(form);
  const errors = form.formState.errors;
  return (
    <form
      noValidate
      onSubmit={(event) => void form.handleSubmit((body) => save.mutate(body))(event)}
    >
      <div className="grid gap-x-4 sm:grid-cols-[1fr_8rem]">
        <Field
          label={t('setup.fields.propertyName')}
          error={errors.name?.message}
          {...form.register('name')}
        />
        <Field
          label={t('setup.fields.code')}
          hint={t('setup.fields.codeHint')}
          error={errors.code?.message}
          {...form.register('code')}
        />
      </div>
      <Field
        label={t('setup.fields.line1')}
        autoComplete="address-line1"
        error={errors.address?.line1?.message}
        {...form.register('address.line1')}
      />
      <Field
        label={t('setup.fields.line2')}
        autoComplete="address-line2"
        error={errors.address?.line2?.message}
        {...form.register('address.line2')}
      />
      <div className="grid gap-x-4 sm:grid-cols-3">
        <Field
          label={t('setup.fields.city')}
          error={errors.address?.city?.message}
          {...form.register('address.city')}
        />
        <Field
          label={t('setup.fields.state')}
          error={errors.address?.state?.message}
          {...form.register('address.state')}
        />
        <Field
          label={t('setup.fields.postalCode')}
          error={errors.address?.postalCode?.message}
          {...form.register('address.postalCode')}
        />
      </div>
      <div className="grid gap-x-4 sm:grid-cols-2">
        <Field
          label={t('setup.fields.phone')}
          type="tel"
          hint={t('setup.fields.phoneHint')}
          error={errors.phone?.message}
          {...form.register('phone')}
        />
        <Field
          label={t('setup.fields.email')}
          type="email"
          error={errors.email?.message}
          {...form.register('email')}
        />
        <Field
          label={t('setup.fields.tin')}
          error={errors.taxRegistration?.tin?.message}
          {...form.register('taxRegistration.tin')}
        />
        <Field
          label={t('setup.fields.vatNumber')}
          error={errors.taxRegistration?.vatNumber?.message}
          {...form.register('taxRegistration.vatNumber')}
        />
      </div>
      <p className="mb-4 text-xs text-text-muted">{t('setup.fields.contactHint')}</p>
      <SaveRow pending={save.isPending} saved={save.isSuccess} error={save.error} />
    </form>
  );
}

function Select({
  label,
  hint,
  options,
  ...props
}: {
  label: string;
  hint?: string | undefined;
  options: readonly { value: string; label: string }[];
} & ComponentProps<'select'>) {
  const id = `setup-${String(props.name)}`;
  return (
    <div className="mb-4 flex flex-col gap-1">
      <Label htmlFor={id}>{label}</Label>
      <select
        id={id}
        className="h-10 rounded-md border border-border bg-surface px-3 text-sm disabled:opacity-60"
        {...props}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {hint && <p className="text-xs text-text-muted">{hint}</p>}
    </div>
  );
}

function RegionStep({ property: p }: { property: Property }) {
  const { t } = useTranslation();
  const form = useForm({
    resolver: zodResolver(RegionForm),
    defaultValues: {
      timeZone: p.timeZone,
      baseCurrency: p.baseCurrency,
      locale: p.locale,
      checkInTime: p.checkInTime,
      checkOutTime: p.checkOutTime,
      nightAuditTime: p.nightAuditTime,
    },
  });
  const save = useSaveProperty(form);
  const live = p.status !== 'SETUP';
  const zones = Intl.supportedValuesOf('timeZone');
  const currencies = [...new Set([p.baseCurrency, ...CURRENCIES])];
  const errors = form.formState.errors;
  const lockedHint = live ? t('setup.fields.lockedLive') : undefined;
  return (
    <form
      noValidate
      onSubmit={(event) =>
        void form.handleSubmit((body) =>
          // A live property keeps its zone and currency; don't send them at all.
          save.mutate(live ? { ...body, timeZone: undefined, baseCurrency: undefined } : body),
        )(event)
      }
    >
      <div className="grid gap-x-4 sm:grid-cols-3">
        <Select
          label={t('setup.fields.timeZone')}
          hint={lockedHint}
          disabled={live}
          options={zones.map((z) => ({ value: z, label: z.replaceAll('_', ' ') }))}
          {...form.register('timeZone')}
        />
        <Select
          label={t('setup.fields.currency')}
          hint={lockedHint}
          disabled={live}
          options={currencies.map((c) => ({ value: c, label: c }))}
          {...form.register('baseCurrency')}
        />
        <Field
          label={t('setup.fields.locale')}
          hint={t('setup.fields.localeHint')}
          error={errors.locale?.message}
          {...form.register('locale')}
        />
      </div>
      <div className="grid gap-x-4 sm:grid-cols-3">
        <Field
          label={t('setup.fields.checkInTime')}
          type="time"
          error={errors.checkInTime?.message}
          {...form.register('checkInTime')}
        />
        <Field
          label={t('setup.fields.checkOutTime')}
          type="time"
          error={errors.checkOutTime?.message}
          {...form.register('checkOutTime')}
        />
        <Field
          label={t('setup.fields.nightAuditTime')}
          type="time"
          hint={t('setup.fields.nightAuditHint')}
          error={errors.nightAuditTime?.message}
          {...form.register('nightAuditTime')}
        />
      </div>
      <SaveRow pending={save.isPending} saved={save.isSuccess} error={save.error} />
    </form>
  );
}

function PaymentMethodsStep({ property: p }: { property: Property }) {
  const { t } = useTranslation();
  const [chosen, setChosen] = useState<string[] | null>(null);
  const selected = chosen ?? p.paymentMethods;
  const save = useSaveProperty();
  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate(
          { paymentMethods: MANUAL_PAY_METHODS.filter((m) => selected.includes(m)) },
          { onSuccess: () => setChosen(null) },
        );
      }}
    >
      <fieldset className="mb-4">
        <legend className="mb-2 text-sm">{t('setup.paymentIntro')}</legend>
        <div className="flex flex-col gap-2">
          {MANUAL_PAY_METHODS.map((method) => (
            <label key={method} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={selected.includes(method)}
                onChange={(e) =>
                  setChosen(
                    e.target.checked ? [...selected, method] : selected.filter((m) => m !== method),
                  )
                }
              />
              {t(`setup.payMethods.${method}`)}
            </label>
          ))}
        </div>
        <p className="mt-2 text-xs text-text-muted">{t('setup.paymentOnline')}</p>
      </fieldset>
      <SaveRow
        pending={save.isPending}
        saved={save.isSuccess && chosen === null}
        error={save.error}
      />
    </form>
  );
}

function GoLiveStep({ property: p }: { property: Property }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [, setSearch] = useSearchParams();
  const goLive = useMutation({
    mutationFn: () => api.call('goLiveProperty', { params: { propertyId: p.id } }),
    onSuccess: (saved) => {
      queryClient.setQueryData(propertyKey(p.id), saved);
      void queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY });
    },
  });
  if (p.status === 'LIVE') return <Alert tone="success">{t('setup.isLive')}</Alert>;
  if (p.status !== 'SETUP') return <Alert tone="info">{t('setup.notInSetup')}</Alert>;

  const open = p.checklist.steps.filter((s) => s.required && s.status === 'TODO');
  const later = p.checklist.steps.filter((s) => s.status === 'LATER');
  const refused =
    goLive.error instanceof ApiError && goLive.error.code === 'STATE_TRANSITION_INVALID';
  return (
    <div className="text-sm">
      {open.length > 0 ? (
        <>
          <p>{t('setup.goLiveOpen')}</p>
          <ul className="mt-2 mb-4 list-inside list-disc">
            {open.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  className="text-brand underline"
                  onClick={() => setSearch({ step: s.id })}
                >
                  {t(`setup.steps.${s.id}`)}
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="mb-2">{t('setup.goLiveReady')}</p>
      )}
      {later.length > 0 && (
        <p className="mb-4 text-text-muted">
          {t('setup.goLiveLater', {
            steps: later.map((s) => t(`setup.steps.${s.id}`)).join(', '),
          })}
        </p>
      )}
      {goLive.error && (
        <Alert tone="critical" className="mb-3">
          {refused ? t('setup.goLiveRefused') : errorMessage(goLive.error)}
        </Alert>
      )}
      <Button disabled={!p.checklist.ready || goLive.isPending} onClick={() => goLive.mutate()}>
        <Rocket aria-hidden className="mr-2 size-4" />
        {t('setup.goLive')}
      </Button>
    </div>
  );
}
