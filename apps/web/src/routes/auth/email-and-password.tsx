import { Email, PASSWORD_MIN_LENGTH, Password } from '@hotel/shared';
import { useMutation } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router';
import { z } from 'zod';
import { Alert } from '../../components/ui/alert.tsx';
import { Button, buttonVariants } from '../../components/ui/button.tsx';
import { api } from '../../lib/api.ts';
import { cn } from '../../lib/cn.ts';
import { errorMessage, zodResolver } from '../../lib/form.ts';
import { AuthHeading, Field } from './layout.tsx';

const EmailForm = z.object({ email: Email });

function BackToSignIn() {
  const { t } = useTranslation();
  return (
    <p className="mt-4 text-sm">
      <Link to="/sign-in" className="text-brand underline">
        {t('auth.backToSignIn')}
      </Link>
    </p>
  );
}

/** `/verify-email?token=` from the sign-up email. */
export function VerifyEmailPage() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const verify = useMutation({ mutationFn: () => api.call('verifyEmail', { body: { token } }) });
  const started = useRef(false);

  useEffect(() => {
    // Once per page view: the token is single-use (StrictMode runs effects twice in dev).
    if (started.current || !token) return;
    started.current = true;
    verify.mutate();
  }, [token, verify]);

  if (verify.isSuccess) {
    return (
      <>
        <AuthHeading title={t('auth.verify.doneTitle')} />
        <Alert tone="success">{t('auth.verify.done')}</Alert>
        <Link to="/sign-in" className={cn(buttonVariants(), 'mt-4 w-full')}>
          {t('auth.signIn.title')}
        </Link>
      </>
    );
  }
  if (verify.isError || !token) {
    return (
      <>
        <AuthHeading title={t('auth.verify.failedTitle')} />
        <Alert tone="critical" className="mb-4">
          {token ? errorMessage(verify.error) : t('auth.linkInvalid')}
        </Alert>
        <ResendForm />
        <BackToSignIn />
      </>
    );
  }
  return <AuthHeading title={t('auth.verify.checking')} />;
}

function ResendForm() {
  const { t } = useTranslation();
  const form = useForm({ resolver: zodResolver(EmailForm) });
  const resend = useMutation({
    mutationFn: (email: string) => api.call('resendVerification', { body: { email } }),
  });
  if (resend.isSuccess) return <Alert tone="success">{t('auth.verify.resent')}</Alert>;
  return (
    <form
      noValidate
      onSubmit={(event) => void form.handleSubmit(({ email }) => resend.mutate(email))(event)}
    >
      <Field
        label={t('auth.fields.email')}
        type="email"
        autoComplete="email"
        error={form.formState.errors.email?.message}
        {...form.register('email')}
      />
      {resend.error && (
        <Alert tone="critical" className="mb-4">
          {errorMessage(resend.error)}
        </Alert>
      )}
      <Button type="submit" variant="secondary" className="w-full" disabled={resend.isPending}>
        {t('auth.verify.resend')}
      </Button>
    </form>
  );
}

/** "Forgot password": always the same answer, whether or not the email has an account. */
export function ForgotPasswordPage() {
  const { t } = useTranslation();
  const form = useForm({ resolver: zodResolver(EmailForm) });
  const request = useMutation({
    mutationFn: (email: string) => api.call('requestPasswordReset', { body: { email } }),
  });

  return (
    <>
      <AuthHeading title={t('auth.forgot.title')} intro={t('auth.forgot.intro')} />
      {request.isSuccess ? (
        <Alert tone="success">{t('auth.forgot.sent', { email: request.variables })}</Alert>
      ) : (
        <form
          noValidate
          onSubmit={(event) => void form.handleSubmit(({ email }) => request.mutate(email))(event)}
        >
          <Field
            label={t('auth.fields.email')}
            type="email"
            autoComplete="email"
            error={form.formState.errors.email?.message}
            {...form.register('email')}
          />
          {request.error && (
            <Alert tone="critical" className="mb-4">
              {errorMessage(request.error)}
            </Alert>
          )}
          <Button type="submit" className="w-full" disabled={request.isPending}>
            {t('auth.forgot.submit')}
          </Button>
        </form>
      )}
      <BackToSignIn />
    </>
  );
}

const ResetForm = z
  .object({ password: Password, confirm: z.string() })
  .refine((v) => v.password === v.confirm, { path: ['confirm'], message: 'mismatch' });

/** `/reset-password?token=` from the reset email. */
export function ResetPasswordPage() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const form = useForm({ resolver: zodResolver(ResetForm) });
  const reset = useMutation({
    mutationFn: (password: string) => api.call('resetPassword', { body: { token, password } }),
  });
  const confirmError = form.formState.errors.confirm?.message;

  if (reset.isSuccess) {
    return (
      <>
        <AuthHeading title={t('auth.reset.doneTitle')} />
        <Alert tone="success">{t('auth.reset.done')}</Alert>
        <BackToSignIn />
      </>
    );
  }
  return (
    <>
      <AuthHeading title={t('auth.reset.title')} />
      {!token && (
        <Alert tone="critical" className="mb-4">
          {t('auth.linkInvalid')}
        </Alert>
      )}
      <form
        noValidate
        onSubmit={(event) =>
          void form.handleSubmit(({ password }) => reset.mutate(password))(event)
        }
      >
        <Field
          label={t('auth.fields.newPassword')}
          type="password"
          autoComplete="new-password"
          hint={t('auth.fields.passwordHint', { min: PASSWORD_MIN_LENGTH })}
          error={form.formState.errors.password?.message}
          {...form.register('password')}
        />
        <Field
          label={t('auth.fields.confirmPassword')}
          type="password"
          autoComplete="new-password"
          error={confirmError === 'mismatch' ? t('auth.reset.mismatch') : confirmError}
          {...form.register('confirm')}
        />
        {reset.error && (
          <Alert tone="critical" className="mb-4">
            <p>{errorMessage(reset.error)}</p>
            <Link to="/forgot-password" className="mt-1 inline-block underline">
              {t('auth.reset.newLink')}
            </Link>
          </Alert>
        )}
        <Button type="submit" className="w-full" disabled={reset.isPending || !token}>
          {t('auth.reset.submit')}
        </Button>
      </form>
      <BackToSignIn />
    </>
  );
}
