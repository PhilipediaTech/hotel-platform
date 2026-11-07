import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ME_QUERY_KEY, type MeResponse } from '../app/session.ts';
import { Alert } from '../components/ui/alert.tsx';
import { Button } from '../components/ui/button.tsx';
import phoneStrings from '../i18n/en/phone.json';
import { registerStrings } from '../i18n/index.ts';
import { api } from '../lib/api.ts';
import { apiFieldErrors, errorMessage } from '../lib/form.ts';
import { Field } from './auth/layout.tsx';

registerStrings(phoneStrings);

// My phone (T-091b): the number approval codes, instant alerts and the flash report go to.
// The password and a code sent by WhatsApp to the new number confirm the change.

type Me = MeResponse;

function fieldError(error: unknown, field: string): string | undefined {
  return apiFieldErrors(error).find((e) => e.field === field)?.message;
}

export function AccountPhonePage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const me = queryClient.getQueryData<Me>(ME_QUERY_KEY);
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [challenge, setChallenge] = useState<{ value: string; phone: string } | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const ask = useMutation({
    mutationFn: () => api.call('requestPhoneChange', { body: { phone: phone.trim(), password } }),
    onSuccess: (r) => {
      setChallenge({ value: r.challenge, phone: phone.trim() });
      setPassword('');
      setCode('');
    },
  });
  const confirm = useMutation({
    mutationFn: () =>
      api.call('confirmPhoneChange', { body: { challenge: challenge?.value ?? '', code } }),
    onSuccess: async (r) => {
      setSaved(r.phone);
      setChallenge(null);
      setPhone('');
      await queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY });
    },
  });
  const current = saved ?? me?.user.phone ?? null;

  return (
    <section className="max-w-sm">
      <h1 className="text-xl font-semibold">{t('phone.title')}</h1>
      <p className="mb-2 mt-1 text-sm text-text-muted">{t('phone.intro')}</p>
      <p className="mb-4 text-sm font-medium">
        {current ? t('phone.current', { phone: current }) : t('phone.none')}
      </p>
      {saved && (
        <Alert tone="success" className="mb-4">
          {t('phone.saved', { phone: saved })}
        </Alert>
      )}
      {challenge ? (
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            confirm.mutate();
          }}
        >
          <Alert tone="info" className="mb-4">
            {t('phone.sent', { phone: challenge.phone })}
          </Alert>
          <Field
            label={t('phone.code')}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            error={fieldError(confirm.error, 'code')}
          />
          {confirm.error && apiFieldErrors(confirm.error).length === 0 && (
            <Alert tone="critical" className="mb-4">
              {errorMessage(confirm.error)}
            </Alert>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={confirm.isPending || code.length !== 6}>
              {t('phone.confirm')}
            </Button>
            <Button variant="secondary" onClick={() => setChallenge(null)}>
              {t('phone.another')}
            </Button>
          </div>
        </form>
      ) : (
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            setSaved(null);
            ask.mutate();
          }}
        >
          <Field
            label={t('phone.number')}
            hint={t('phone.numberHint')}
            type="tel"
            autoComplete="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            error={fieldError(ask.error, 'phone')}
          />
          <Field
            label={t('phone.password')}
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            error={fieldError(ask.error, 'password')}
          />
          {ask.error && apiFieldErrors(ask.error).length === 0 && (
            <Alert tone="critical" className="mb-4">
              {errorMessage(ask.error)}
            </Alert>
          )}
          <Button type="submit" disabled={ask.isPending || !phone.trim() || !password}>
            {t('phone.send')}
          </Button>
        </form>
      )}
    </section>
  );
}
