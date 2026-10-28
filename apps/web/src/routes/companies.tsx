import { COMPANY_KINDS, CompanyBody, CompanyPatchBody, type CompanyItem } from '@hotel/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
import { fieldErrorsOf, serverErrors, validated, type FieldErrors } from './settings/room-form.ts';

// S13 Company profiles (PRD M3-16 basic; T-043): companies, travel agents and event clients
// with contacts and tax ID. Credit limits, terms and commission arrive with V1.1.

type Company = z.output<typeof CompanyItem>;
type Kind = (typeof COMPANY_KINDS)[number];
type Contact = { name: string; role: string; phone: string; email: string };

const companiesKey = (propertyId: string | null) => ['companies', propertyId ?? ''];
const orNull = (v: string) => (v.trim() === '' ? null : v.trim());

export function CompaniesPage() {
  const { t } = useTranslation();
  const { currentPropertyId, permissions } = useSession();
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<Kind | ''>('');
  const [adding, setAdding] = useState(false);
  const list = useQuery({
    queryKey: [...companiesKey(currentPropertyId), q, kind],
    queryFn: async () =>
      (
        await api.call('listCompanies', {
          query: { ...(q ? { q } : {}), ...(kind ? { kind } : {}) },
        })
      ).data,
  });
  const canEdit = permissions.includes('company.manage');

  return (
    <section className="max-w-4xl">
      <h1 className="text-xl font-semibold">{t('companies.title')}</h1>
      <form
        role="search"
        className="mt-4 flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setQ(text.trim());
        }}
      >
        <Input
          className="max-w-xs"
          aria-label={t('companies.search')}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <select
          aria-label={t('companies.kind')}
          className="h-10 rounded-md border border-border bg-surface px-3 text-sm"
          value={kind}
          onChange={(e) => setKind(e.target.value as Kind | '')}
        >
          <option value="">{t('companies.allKinds')}</option>
          {COMPANY_KINDS.map((k) => (
            <option key={k} value={k}>
              {t(`companies.kinds.${k}`)}
            </option>
          ))}
        </select>
        <Button type="submit">{t('guests.find')}</Button>
        {canEdit && !adding && (
          <Button variant="secondary" onClick={() => setAdding(true)}>
            {t('companies.add')}
          </Button>
        )}
      </form>
      {adding && <CompanyForm company={null} onDone={() => setAdding(false)} />}
      {list.error && <Alert tone="critical">{errorMessage(list.error)}</Alert>}
      {list.data && list.data.length === 0 && (
        <p className="mt-4 text-sm text-text-muted">{t('companies.none')}</p>
      )}
      {list.data && list.data.length > 0 && (
        <table aria-label={t('companies.title')} className="mt-4 w-full text-left text-sm">
          <thead className="border-b border-border text-text-muted">
            <tr>
              <th className="p-2 font-medium">{t('companies.name')}</th>
              <th className="p-2 font-medium">{t('companies.kind')}</th>
              <th className="p-2 font-medium">{t('companies.contact')}</th>
            </tr>
          </thead>
          <tbody>
            {list.data.map((c) => (
              <tr key={c.id} className="border-b border-border last:border-0">
                <td className="p-2">
                  <Link to={`/companies/${c.id}`} className="text-brand underline">
                    {c.name}
                  </Link>
                  {!c.active && (
                    <span className="ml-2 text-xs text-text-muted">{t('companies.inactive')}</span>
                  )}
                </td>
                <td className="p-2">{t(`companies.kinds.${c.kind}`)}</td>
                <td className="p-2">
                  {c.contacts[0] ? `${c.contacts[0].name} ${c.contacts[0].phone ?? ''}` : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

export function CompanyProfilePage() {
  const { t } = useTranslation();
  const { companyId = '' } = useParams();
  const { currentPropertyId, permissions } = useSession();
  const company = useQuery({
    queryKey: [...companiesKey(currentPropertyId), 'one', companyId],
    queryFn: () => api.call('getCompany', { params: { companyId } }),
  });
  if (company.error) return <Alert tone="critical">{errorMessage(company.error)}</Alert>;
  if (!company.data) return <p className="text-sm text-text-muted">{t('shell.loading')}</p>;
  return (
    <section className="max-w-3xl">
      <p className="text-sm">
        <Link to="/companies" className="text-brand underline">
          {t('companies.title')}
        </Link>
      </p>
      <h1 className="mt-1 text-xl font-semibold">{company.data.name}</h1>
      {permissions.includes('company.manage') ? (
        <CompanyForm
          key={JSON.stringify(company.data)}
          company={company.data}
          onDone={() => undefined}
        />
      ) : (
        <dl className="mt-3 text-sm">
          <dt className="text-text-muted">{t('companies.kind')}</dt>
          <dd>{t(`companies.kinds.${company.data.kind}`)}</dd>
          <dt className="mt-2 text-text-muted">{t('companies.taxId')}</dt>
          <dd>{company.data.taxId ?? '—'}</dd>
        </dl>
      )}
    </section>
  );
}

function CompanyForm({ company, onDone }: { company: Company | null; onDone: () => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { currentPropertyId } = useSession();
  const [kind, setKind] = useState<Kind>(company?.kind ?? 'COMPANY');
  const [name, setName] = useState(company?.name ?? '');
  const [taxId, setTaxId] = useState(company?.taxId ?? '');
  const [active, setActive] = useState(company?.active ?? true);
  const [contacts, setContacts] = useState<Contact[]>(
    (company?.contacts ?? []).map((c) => ({
      name: c.name,
      role: c.role ?? '',
      phone: c.phone ?? '',
      email: c.email ?? '',
    })),
  );
  const [errors, setErrors] = useState<FieldErrors>({});
  const payload = {
    kind,
    name,
    taxId: orNull(taxId),
    contacts: contacts.map((c) => ({
      name: c.name,
      role: orNull(c.role),
      phone: orNull(c.phone),
      email: orNull(c.email),
    })),
  };
  const save = useMutation({
    mutationFn: async () =>
      company
        ? api.call('updateCompany', {
            params: { companyId: company.id },
            body: validated(CompanyPatchBody, { ...payload, active }),
          })
        : api.call('createCompany', { body: validated(CompanyBody, payload) }),
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: companiesKey(currentPropertyId) });
      if (!company) void navigate(`/companies/${saved.id}`);
      onDone();
    },
    onError: (error) => setErrors(fieldErrorsOf(error)),
  });
  const update = (i: number, change: Partial<Contact>) =>
    setContacts((list) => list.map((c, j) => (j === i ? { ...c, ...change } : c)));
  const formError =
    save.error instanceof ApiError && Object.keys(serverErrors(save.error)).length === 0
      ? errorMessage(save.error)
      : null;

  return (
    <form
      noValidate
      aria-label={company ? t('companies.details') : t('companies.add')}
      className="mt-3 rounded-md border border-border bg-surface p-4"
      onSubmit={(e) => {
        e.preventDefault();
        setErrors({});
        save.mutate();
      }}
    >
      <div className="grid gap-x-4 sm:grid-cols-3">
        <div className="mb-4 flex flex-col gap-1">
          <Label htmlFor="company-kind">{t('companies.kind')}</Label>
          <select
            id="company-kind"
            className="h-10 rounded-md border border-border bg-surface px-3 text-sm"
            value={kind}
            onChange={(e) => setKind(e.target.value as Kind)}
          >
            {COMPANY_KINDS.map((k) => (
              <option key={k} value={k}>
                {t(`companies.kinds.${k}`)}
              </option>
            ))}
          </select>
        </div>
        <Field
          label={t('companies.name')}
          value={name}
          onChange={(e) => setName(e.target.value)}
          error={errors['name']}
        />
        <Field
          label={t('companies.taxId')}
          value={taxId}
          onChange={(e) => setTaxId(e.target.value)}
          error={errors['taxId']}
        />
      </div>
      <fieldset className="mb-4">
        <legend className="mb-1 text-sm font-medium">{t('companies.contacts')}</legend>
        {contacts.map((c, i) => (
          <div key={i} className="grid items-end gap-x-3 sm:grid-cols-[1fr_1fr_1fr_1fr_auto]">
            <Field
              label={t('companies.contactName')}
              value={c.name}
              onChange={(e) => update(i, { name: e.target.value })}
            />
            <Field
              label={t('companies.role')}
              value={c.role}
              onChange={(e) => update(i, { role: e.target.value })}
            />
            <Field
              label={t('guests.phone')}
              type="tel"
              value={c.phone}
              onChange={(e) => update(i, { phone: e.target.value })}
            />
            <Field
              label={t('guests.email')}
              type="email"
              value={c.email}
              onChange={(e) => update(i, { email: e.target.value })}
            />
            <Button
              className="mb-4"
              size="sm"
              variant="ghost"
              onClick={() => setContacts((list) => list.filter((_, j) => j !== i))}
            >
              {t('companies.remove')}
            </Button>
          </div>
        ))}
        {errors['contacts'] && <p className="text-sm text-critical">{errors['contacts']}</p>}
        <Button
          size="sm"
          variant="secondary"
          onClick={() =>
            setContacts((list) => [...list, { name: '', role: '', phone: '', email: '' }])
          }
        >
          {t('companies.addContact')}
        </Button>
      </fieldset>
      {company && (
        <label className="mb-4 flex items-center gap-2 text-sm">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          {t('companies.active')}
        </label>
      )}
      {formError && (
        <Alert tone="critical" className="mb-3">
          {formError}
        </Alert>
      )}
      <div className="flex items-center gap-2">
        <Button type="submit" disabled={save.isPending}>
          {t('guests.save')}
        </Button>
        {!company && (
          <Button variant="secondary" onClick={onDone}>
            {t('guests.cancel')}
          </Button>
        )}
        {company && save.isSuccess && (
          <span role="status" className="text-sm">
            {t('guests.saved')}
          </span>
        )}
      </div>
    </form>
  );
}
