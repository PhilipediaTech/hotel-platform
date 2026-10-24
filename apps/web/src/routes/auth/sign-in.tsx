import { SignInBody } from '@hotel/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm, useWatch } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import type { z } from 'zod';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { safeNext } from '../../app/session-gate.tsx';
import { ME_QUERY_KEY } from '../../app/session.ts';
import { Alert } from '../../components/ui/alert.tsx';
import { Button } from '../../components/ui/button.tsx';
import { api, ApiError } from '../../lib/api.ts';
import { errorMessage, zodResolver } from '../../lib/form.ts';
import { AuthHeading, Field } from './layout.tsx';

function isUnverified(error: unknown): boolean {
  return error instanceof ApiError && error.details?.['reason'] === 'EMAIL_NOT_VERIFIED';
}

/** S01 sign-in: email or phone and password (MFA and PIN arrive with T-011). */
export function SignInPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const queryClient = useQueryClient();
  const form = useForm({
    resolver: zodResolver(SignInBody),
    defaultValues: { sharedDevice: false },
  });

  const submit = useMutation({
    mutationFn: (body: z.output<typeof SignInBody>) => api.call('signIn', { body }),
    onSuccess: (me) => {
      queryClient.setQueryData(ME_QUERY_KEY, me);
      void navigate(safeNext(params.get('next')), { replace: true });
    },
  });

  const resend = useMutation({
    mutationFn: (email: string) => api.call('resendVerification', { body: { email } }),
  });
  const login = useWatch({ control: form.control, name: 'login' });

  return (
    <>
      <AuthHeading title={t('auth.signIn.title')} />
      <form
        noValidate
        onSubmit={(event) => void form.handleSubmit((body) => submit.mutate(body))(event)}
      >
        <Field
          label={t('auth.fields.login')}
          autoComplete="username"
          inputMode="email"
          error={form.formState.errors.login?.message}
          {...form.register('login')}
        />
        <Field
          label={t('auth.fields.password')}
          type="password"
          autoComplete="current-password"
          error={form.formState.errors.password?.message}
          {...form.register('password')}
        />
        <label className="mb-4 flex min-h-touch items-center gap-2 text-sm">
          <input type="checkbox" className="size-4" {...form.register('sharedDevice')} />
          {t('auth.signIn.sharedDevice')}
        </label>

        {submit.error && !isUnverified(submit.error) && (
          <Alert tone="critical" className="mb-4">
            {errorMessage(submit.error)}
          </Alert>
        )}
        {isUnverified(submit.error) && (
          <Alert tone="info" className="mb-4">
            <p>{errorMessage(submit.error)}</p>
            {resend.isSuccess ? (
              <p className="mt-1 font-medium">{t('auth.verify.resent')}</p>
            ) : (
              login?.includes('@') && (
                <Button
                  size="sm"
                  variant="secondary"
                  className="mt-2"
                  disabled={resend.isPending}
                  onClick={() => resend.mutate(login.trim())}
                >
                  {t('auth.verify.resend')}
                </Button>
              )
            )}
          </Alert>
        )}

        <Button type="submit" className="w-full" disabled={submit.isPending}>
          {t('auth.signIn.submit')}
        </Button>
      </form>
      <div className="mt-4 flex justify-between text-sm">
        <Link to="/forgot-password" className="text-brand underline">
          {t('auth.signIn.forgot')}
        </Link>
        <Link to="/sign-up" className="text-brand underline">
          {t('auth.signIn.createAccount')}
        </Link>
      </div>
    </>
  );
}
