import type { MfaVerifyBody } from '@hotel/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ComponentProps } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { Navigate, useNavigate, useSearchParams } from 'react-router';
import { z } from 'zod';
import { safeNext } from '../../app/session-gate.tsx';
import { ME_QUERY_KEY } from '../../app/session.ts';
import { Alert } from '../../components/ui/alert.tsx';
import { Button } from '../../components/ui/button.tsx';
import { QrCode } from '../../components/ui/qr-code.tsx';
import { api, ApiError } from '../../lib/api.ts';
import { apiFieldErrors, errorMessage, zodResolver } from '../../lib/form.ts';
import { AuthHeading, Field } from './layout.tsx';

/** `format` is replaced by a UI-language message in CodeField; server messages pass through. */
const CODE_FORMAT = 'format';
const CodeForm = z.object({ code: z.string().regex(/^\d{6}$/, CODE_FORMAT) });
const RecoveryForm = z.object({ recoveryCode: z.string().trim().min(8).max(20) });

/** S01 `/mfa`: enter a code at sign-in, or set MFA up when the role needs it (M1-06). */
export function MfaPage() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const me = useQuery({ queryKey: ME_QUERY_KEY, queryFn: () => api.call('getMe') });

  if (me.error instanceof ApiError && me.error.status === 401) {
    return <Navigate to="/sign-in" replace />;
  }
  if (me.error) return <Alert tone="critical">{errorMessage(me.error)}</Alert>;
  if (!me.data) return <AuthHeading title={t('shell.loading')} />;
  if (me.data.session.mfaPassed) return <Navigate to={next} replace />;
  return me.data.user.mfaEnabled ? <VerifyMfa next={next} /> : <EnrolMfa next={next} />;
}

function CodeField({
  error,
  ...props
}: { error?: string | undefined } & Omit<ComponentProps<typeof Field>, 'label' | 'error'>) {
  const { t } = useTranslation();
  return (
    <Field
      label={t('auth.mfa.code')}
      inputMode="numeric"
      autoComplete="one-time-code"
      maxLength={6}
      error={error === CODE_FORMAT ? t('auth.mfa.codeFormat') : error}
      {...props}
    />
  );
}

function VerifyMfa({ next }: { next: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [useRecovery, setUseRecovery] = useState(false);
  const codeForm = useForm({ resolver: zodResolver(CodeForm) });
  const recoveryForm = useForm({ resolver: zodResolver(RecoveryForm) });

  const verify = useMutation({
    mutationFn: (body: z.output<typeof MfaVerifyBody>) => api.call('verifyMfa', { body }),
    onSuccess: (me) => {
      queryClient.setQueryData(ME_QUERY_KEY, me);
      void navigate(next, { replace: true });
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 401)
        void navigate('/sign-in', { replace: true });
      for (const { field, message } of apiFieldErrors(error)) {
        if (field === 'code') codeForm.setError('code', { message });
        if (field === 'recoveryCode') recoveryForm.setError('recoveryCode', { message });
      }
    },
  });
  const formError = verify.error && apiFieldErrors(verify.error).length === 0 ? verify.error : null;

  return (
    <>
      <AuthHeading
        title={t('auth.mfa.title')}
        intro={useRecovery ? t('auth.mfa.recoveryIntro') : t('auth.mfa.intro')}
      />
      {useRecovery ? (
        <form
          noValidate
          onSubmit={(event) => void recoveryForm.handleSubmit((body) => verify.mutate(body))(event)}
        >
          <Field
            label={t('auth.mfa.recoveryCode')}
            autoComplete="off"
            error={recoveryForm.formState.errors.recoveryCode?.message}
            {...recoveryForm.register('recoveryCode')}
          />
          {formError && (
            <Alert tone="critical" className="mb-4">
              {errorMessage(formError)}
            </Alert>
          )}
          <Button type="submit" className="w-full" disabled={verify.isPending}>
            {t('auth.mfa.submit')}
          </Button>
        </form>
      ) : (
        <form
          noValidate
          onSubmit={(event) => void codeForm.handleSubmit((body) => verify.mutate(body))(event)}
        >
          <CodeField
            error={codeForm.formState.errors.code?.message}
            {...codeForm.register('code')}
          />
          {formError && (
            <Alert tone="critical" className="mb-4">
              {errorMessage(formError)}
            </Alert>
          )}
          <Button type="submit" className="w-full" disabled={verify.isPending}>
            {t('auth.mfa.submit')}
          </Button>
        </form>
      )}
      <Button variant="ghost" size="sm" className="mt-3" onClick={() => setUseRecovery((v) => !v)}>
        {useRecovery ? t('auth.mfa.useApp') : t('auth.mfa.useRecovery')}
      </Button>
    </>
  );
}

function EnrolMfa({ next }: { next: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const form = useForm({ resolver: zodResolver(CodeForm) });
  const enrol = useMutation({ mutationFn: () => api.call('enrolMfa') });
  const confirm = useMutation({
    mutationFn: (code: string) => api.call('confirmMfa', { body: { code } }),
    onError: (error) => {
      for (const { field, message } of apiFieldErrors(error)) {
        if (field === 'code') form.setError('code', { message });
      }
    },
  });

  if (confirm.data) {
    return (
      <>
        <AuthHeading title={t('auth.mfa.recoveryTitle')} intro={t('auth.mfa.recoveryShown')} />
        <ol className="mb-4 grid grid-cols-2 gap-2 rounded-md bg-surface-muted p-3 font-mono text-sm">
          {confirm.data.recoveryCodes.map((code) => (
            <li key={code}>{code}</li>
          ))}
        </ol>
        <Button
          className="w-full"
          onClick={() => {
            void queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY });
            void navigate(next, { replace: true });
          }}
        >
          {t('auth.mfa.savedCodes')}
        </Button>
      </>
    );
  }

  if (!enrol.data) {
    return (
      <>
        <AuthHeading title={t('auth.mfa.setUpTitle')} intro={t('auth.mfa.setUpIntro')} />
        {enrol.error && (
          <Alert tone="critical" className="mb-4">
            {errorMessage(enrol.error)}
          </Alert>
        )}
        <Button className="w-full" disabled={enrol.isPending} onClick={() => enrol.mutate()}>
          {t('auth.mfa.start')}
        </Button>
      </>
    );
  }

  const formError =
    confirm.error && apiFieldErrors(confirm.error).length === 0 ? confirm.error : null;
  return (
    <>
      <AuthHeading title={t('auth.mfa.setUpTitle')} intro={t('auth.mfa.scan')} />
      <div className="mb-3 flex justify-center">
        <QrCode value={enrol.data.otpauthUri} label={t('auth.mfa.qrLabel')} />
      </div>
      <p className="mb-4 text-center text-xs text-text-muted">
        {t('auth.mfa.manualKey')}{' '}
        <code className="break-all font-mono text-text">{enrol.data.secret}</code>
      </p>
      <form
        noValidate
        onSubmit={(event) => void form.handleSubmit(({ code }) => confirm.mutate(code))(event)}
      >
        <CodeField error={form.formState.errors.code?.message} {...form.register('code')} />
        {formError && (
          <Alert tone="critical" className="mb-4">
            {errorMessage(formError)}
          </Alert>
        )}
        <Button type="submit" className="w-full" disabled={confirm.isPending}>
          {t('auth.mfa.confirm')}
        </Button>
      </form>
    </>
  );
}
