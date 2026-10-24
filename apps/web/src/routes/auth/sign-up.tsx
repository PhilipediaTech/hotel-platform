import { PASSWORD_MIN_LENGTH, SIGN_UP_COUNTRIES, SignUpBody } from '@hotel/shared';
import { useMutation } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import type { z } from 'zod';
import { Link } from 'react-router';
import { Alert } from '../../components/ui/alert.tsx';
import { Button } from '../../components/ui/button.tsx';
import { Label } from '../../components/ui/label.tsx';
import { api } from '../../lib/api.ts';
import { apiFieldErrors, errorMessage, zodResolver } from '../../lib/form.ts';
import { AuthHeading, Field } from './layout.tsx';

type Body = z.output<typeof SignUpBody>;

/** S02 sign-up (M1-01): owner, organisation and first property in one step. */
export function SignUpPage() {
  const { t } = useTranslation();
  const form = useForm({
    resolver: zodResolver(SignUpBody),
    defaultValues: { country: 'NG' as const },
  });
  const submit = useMutation({
    mutationFn: (body: Body) => api.call('signUp', { body }),
    onError: (error) => {
      for (const { field, message } of apiFieldErrors(error)) {
        form.setError(field as keyof Body, { message });
      }
    },
  });
  const errors = form.formState.errors;

  if (submit.isSuccess) {
    return (
      <>
        <AuthHeading title={t('auth.signUp.checkEmailTitle')} />
        <Alert tone="success">
          {t('auth.signUp.checkEmail', { email: submit.variables.email })}
        </Alert>
        <p className="mt-4 text-sm">
          <Link to="/sign-in" className="text-brand underline">
            {t('auth.backToSignIn')}
          </Link>
        </p>
      </>
    );
  }

  return (
    <>
      <AuthHeading title={t('auth.signUp.title')} intro={t('auth.signUp.intro')} />
      <form
        noValidate
        onSubmit={(event) => void form.handleSubmit((body) => submit.mutate(body))(event)}
      >
        <Field
          label={t('auth.fields.name')}
          autoComplete="name"
          error={errors.name?.message}
          {...form.register('name')}
        />
        <Field
          label={t('auth.fields.email')}
          type="email"
          autoComplete="email"
          error={errors.email?.message}
          {...form.register('email')}
        />
        <Field
          label={t('auth.fields.newPassword')}
          type="password"
          autoComplete="new-password"
          hint={t('auth.fields.passwordHint', { min: PASSWORD_MIN_LENGTH })}
          error={errors.password?.message}
          {...form.register('password')}
        />
        <Field
          label={t('auth.fields.organisationName')}
          autoComplete="organization"
          error={errors.organisationName?.message}
          {...form.register('organisationName')}
        />
        <div className="mb-4 flex flex-col gap-1">
          <Label htmlFor="sign-up-country">{t('auth.fields.country')}</Label>
          <select
            id="sign-up-country"
            className="h-10 rounded-md border border-border bg-surface px-3 text-sm"
            {...form.register('country')}
          >
            {Object.entries(SIGN_UP_COUNTRIES).map(([code, c]) => (
              <option key={code} value={code}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <Field
          label={t('auth.fields.propertyName')}
          error={errors.propertyName?.message}
          {...form.register('propertyName')}
        />

        {submit.error && apiFieldErrors(submit.error).length === 0 && (
          <Alert tone="critical" className="mb-4">
            {errorMessage(submit.error)}
          </Alert>
        )}
        <Button type="submit" className="w-full" disabled={submit.isPending}>
          {t('auth.signUp.submit')}
        </Button>
      </form>
      <p className="mt-4 text-sm">
        {t('auth.signUp.haveAccount')}{' '}
        <Link to="/sign-in" className="text-brand underline">
          {t('auth.signIn.title')}
        </Link>
      </p>
    </>
  );
}
