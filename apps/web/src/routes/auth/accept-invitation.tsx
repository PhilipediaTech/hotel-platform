import { PASSWORD_MIN_LENGTH, Password } from '@hotel/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { z } from 'zod';
import { ME_QUERY_KEY } from '../../app/session.ts';
import { Alert } from '../../components/ui/alert.tsx';
import { Button, buttonVariants } from '../../components/ui/button.tsx';
import { api } from '../../lib/api.ts';
import { cn } from '../../lib/cn.ts';
import { apiFieldErrors, errorMessage, zodResolver } from '../../lib/form.ts';
import { AuthHeading, Field } from './layout.tsx';

const NewAccount = z.object({ name: z.string().trim().min(1).max(120), password: Password });

/** `/accept-invitation?token=` from an invitation (M1-04). */
export function AcceptInvitationPage() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const preview = useQuery({
    queryKey: ['invitation', token],
    queryFn: () => api.call('previewInvitation', { body: { token } }),
    enabled: token.length > 0,
    retry: false,
  });

  if (!token || preview.error) {
    return (
      <>
        <AuthHeading title={t('accept.invalidTitle')} />
        <Alert tone="critical">{token ? errorMessage(preview.error) : t('auth.linkInvalid')}</Alert>
      </>
    );
  }
  if (!preview.data) return <AuthHeading title={t('shell.loading')} />;

  const { organisationName, propertyName, roleName, email, phone, accountExists } = preview.data;
  return (
    <>
      <AuthHeading
        title={t('accept.title', { organisation: organisationName })}
        intro={t('accept.intro', {
          role: roleName,
          where: propertyName ?? t('access.allProperties'),
          contact: email ?? phone,
        })}
      />
      {accountExists ? <AcceptAsMember token={token} /> : <AcceptAsNew token={token} />}
    </>
  );
}

function Done() {
  const { t } = useTranslation();
  return (
    <>
      <Alert tone="success">{t('accept.done')}</Alert>
      <Link to="/" className={cn(buttonVariants(), 'mt-4 w-full')}>
        {t('accept.continue')}
      </Link>
    </>
  );
}

/** An existing account accepts while signed in to it. */
function AcceptAsMember({ token }: { token: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: ME_QUERY_KEY, queryFn: () => api.call('getMe'), retry: false });
  const accept = useMutation({
    mutationFn: () => api.call('acceptInvitation', { body: { token } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY }),
  });
  const next = encodeURIComponent(`/accept-invitation?token=${token}`);

  if (accept.isSuccess) return <Done />;
  if (!me.data) {
    return (
      <>
        <Alert tone="info">{t('accept.signInFirst')}</Alert>
        <Link to={`/sign-in?next=${next}`} className={cn(buttonVariants(), 'mt-4 w-full')}>
          {t('auth.signIn.title')}
        </Link>
      </>
    );
  }
  return (
    <>
      {accept.error && (
        <Alert tone="critical" className="mb-4">
          {errorMessage(accept.error)}
        </Alert>
      )}
      <Button className="w-full" disabled={accept.isPending} onClick={() => accept.mutate()}>
        {t('accept.acceptAs', { name: me.data.user.name })}
      </Button>
    </>
  );
}

/** New people choose their name and password. */
function AcceptAsNew({ token }: { token: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const form = useForm({ resolver: zodResolver(NewAccount) });
  const accept = useMutation({
    mutationFn: (body: z.output<typeof NewAccount>) =>
      api.call('acceptInvitation', { body: { token, ...body } }),
    onError: (error) => {
      for (const { field, message } of apiFieldErrors(error)) {
        if (field === 'name' || field === 'password') form.setError(field, { message });
      }
    },
  });

  if (accept.isSuccess) {
    return (
      <>
        <Alert tone="success">{t('accept.created')}</Alert>
        <Button className="mt-4 w-full" onClick={() => void navigate('/sign-in')}>
          {t('auth.signIn.title')}
        </Button>
      </>
    );
  }
  return (
    <form
      noValidate
      onSubmit={(event) => void form.handleSubmit((body) => accept.mutate(body))(event)}
    >
      <Field
        label={t('auth.fields.name')}
        autoComplete="name"
        error={form.formState.errors.name?.message}
        {...form.register('name')}
      />
      <Field
        label={t('auth.fields.newPassword')}
        type="password"
        autoComplete="new-password"
        hint={t('auth.fields.passwordHint', { min: PASSWORD_MIN_LENGTH })}
        error={form.formState.errors.password?.message}
        {...form.register('password')}
      />
      {accept.error && apiFieldErrors(accept.error).length === 0 && (
        <Alert tone="critical" className="mb-4">
          {errorMessage(accept.error)}
        </Alert>
      )}
      <Button type="submit" className="w-full" disabled={accept.isPending}>
        {t('accept.join')}
      </Button>
    </form>
  );
}
