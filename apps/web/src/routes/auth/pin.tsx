import { Pin, PinSwitchBody } from '@hotel/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { z } from 'zod';
import { safeNext } from '../../app/session-gate.tsx';
import { ME_QUERY_KEY } from '../../app/session.ts';
import { Alert } from '../../components/ui/alert.tsx';
import { Button } from '../../components/ui/button.tsx';
import { api } from '../../lib/api.ts';
import { apiFieldErrors, errorMessage, zodResolver } from '../../lib/form.ts';
import { AuthHeading, Field } from './layout.tsx';

/** The shared-device question every signed-out screen can ask. */
export function useSharedDevice() {
  return useQuery({
    queryKey: ['device'],
    queryFn: () => api.call('getDevice'),
    staleTime: 60_000,
  });
}

/** S01 `/pin`: switch user on a manager-opened shared device (M1-07). */
export function PinSwitchPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const queryClient = useQueryClient();
  const device = useSharedDevice();
  const form = useForm({ resolver: zodResolver(PinSwitchBody) });
  const submit = useMutation({
    mutationFn: (body: z.output<typeof PinSwitchBody>) => api.call('pinSwitch', { body }),
    onSuccess: (me) => {
      queryClient.setQueryData(ME_QUERY_KEY, me);
      void navigate(safeNext(params.get('next')), { replace: true });
    },
  });

  const passwordLink = (
    <p className="mt-4 text-sm">
      <Link to="/sign-in" className="text-brand underline">
        {t('auth.pin.usePassword')}
      </Link>
    </p>
  );

  if (device.data && !device.data.pinSwitchAvailable) {
    return (
      <>
        <AuthHeading title={t('auth.pin.title')} />
        <Alert tone="info">{t('auth.pin.notShared')}</Alert>
        {passwordLink}
      </>
    );
  }
  return (
    <>
      <AuthHeading
        title={t('auth.pin.title')}
        intro={
          device.data?.deviceLabel
            ? t('auth.pin.device', { label: device.data.deviceLabel })
            : undefined
        }
      />
      <form
        noValidate
        onSubmit={(event) => void form.handleSubmit((body) => submit.mutate(body))(event)}
      >
        <Field
          label={t('auth.fields.login')}
          autoComplete="username"
          error={form.formState.errors.login?.message}
          {...form.register('login')}
        />
        <Field
          label={t('auth.pin.pin')}
          type="password"
          inputMode="numeric"
          autoComplete="off"
          maxLength={6}
          error={form.formState.errors.pin?.message}
          {...form.register('pin')}
        />
        {submit.error && (
          <Alert tone="critical" className="mb-4">
            {errorMessage(submit.error)}
          </Alert>
        )}
        <Button type="submit" size="touch" className="w-full" disabled={submit.isPending}>
          {t('auth.pin.submit')}
        </Button>
      </form>
      {passwordLink}
    </>
  );
}

const SetPinForm = z
  .object({ pin: Pin, confirm: z.string(), password: z.string().min(1) })
  .refine((v) => v.pin === v.confirm, { path: ['confirm'], message: 'mismatch' });

/** `/account/pin`: set or change my PIN (needs my password). */
export function SetPinPage() {
  const { t } = useTranslation();
  const form = useForm({ resolver: zodResolver(SetPinForm) });
  const save = useMutation({
    mutationFn: ({ pin, password }: { pin: string; password: string }) =>
      api.call('setMyPin', { body: { pin, password } }),
    onError: (error) => {
      for (const { field, message } of apiFieldErrors(error)) {
        if (field === 'pin' || field === 'password') form.setError(field, { message });
      }
    },
    onSuccess: () => form.reset(),
  });
  const confirmError = form.formState.errors.confirm?.message;

  return (
    <section className="max-w-sm">
      <h1 className="text-xl font-semibold">{t('auth.setPin.title')}</h1>
      <p className="mb-4 mt-1 text-sm text-text-muted">{t('auth.setPin.intro')}</p>
      {save.isSuccess && (
        <Alert tone="success" className="mb-4">
          {t('auth.setPin.saved')}
        </Alert>
      )}
      <form noValidate onSubmit={(event) => void form.handleSubmit((v) => save.mutate(v))(event)}>
        <Field
          label={t('auth.pin.newPin')}
          type="password"
          inputMode="numeric"
          autoComplete="off"
          maxLength={6}
          error={form.formState.errors.pin?.message}
          {...form.register('pin')}
        />
        <Field
          label={t('auth.pin.repeatPin')}
          type="password"
          inputMode="numeric"
          autoComplete="off"
          maxLength={6}
          error={confirmError === 'mismatch' ? t('auth.pin.mismatch') : confirmError}
          {...form.register('confirm')}
        />
        <Field
          label={t('auth.fields.password')}
          type="password"
          autoComplete="current-password"
          error={form.formState.errors.password?.message}
          {...form.register('password')}
        />
        {save.error && apiFieldErrors(save.error).length === 0 && (
          <Alert tone="critical" className="mb-4">
            {errorMessage(save.error)}
          </Alert>
        )}
        <Button type="submit" disabled={save.isPending}>
          {t('auth.setPin.submit')}
        </Button>
      </form>
    </section>
  );
}
