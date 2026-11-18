import {
  EMPLOYMENT_TYPES,
  STAFF_STATUSES,
  type EmploymentType,
  type StaffDetail,
  type StaffItem,
  type StaffStatus,
} from '@hotel/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import type { z } from 'zod';
import { useSession } from '../app/session.ts';
import { Alert } from '../components/ui/alert.tsx';
import { Button } from '../components/ui/button.tsx';
import { Input } from '../components/ui/input.tsx';
import { Label } from '../components/ui/label.tsx';
import { api } from '../lib/api.ts';
import { cn } from '../lib/cn.ts';
import { errorMessage } from '../lib/form.ts';
import { toMinor } from '../lib/money.ts';
import staffStrings from '../i18n/en/staff.json';
import { registerStrings } from '../i18n/index.ts';
import { useFormats } from './reservations.tsx';

registerStrings(staffStrings);

// S36 Staff and workforce (PRD M7-01, M7-10; T-136): the directory, each profile with its
// certifications, and the restricted emergency contact (shown on request; each look is
// audited by the API). Duties, rota, attendance, leave and timesheets come with later tickets.

type Item = z.output<typeof StaffItem>;
type Detail = z.output<typeof StaffDetail>;
type Person = { id: string; name: string; email: string | null; linked: boolean };
type Option = { id: string; name: string };

const selectClass = 'h-11 rounded-md border border-border bg-surface px-3 text-sm';
const STATE_TONE: Record<string, string> = {
  NO_EXPIRY: 'bg-surface-muted',
  VALID: 'bg-success-subtle text-success',
  EXPIRING: 'bg-warning-subtle text-warning',
  EXPIRED: 'bg-critical-subtle text-critical',
};

function useKey(...parts: string[]) {
  const { currentPropertyId } = useSession();
  return ['staff', currentPropertyId ?? '', ...parts];
}

export function StaffPage() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const status = (STAFF_STATUSES as readonly string[]).includes(params.get('status') ?? '')
    ? (params.get('status') as StaffStatus)
    : 'ACTIVE';
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const key = useKey('list');
  const list = useQuery({
    queryKey: [...key, status, q.trim()],
    queryFn: () =>
      api.call('listStaff', { query: { status, ...(q.trim() ? { q: q.trim() } : {}) } }),
  });
  const data = list.data;
  return (
    <section className="max-w-5xl">
      <h1 className="text-xl font-semibold">{t('st.title')}</h1>
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <div role="tablist" aria-label={t('st.statusTabs')} className="flex gap-2">
          {STAFF_STATUSES.map((s) => (
            <Button
              key={s}
              role="tab"
              aria-selected={status === s}
              variant={status === s ? 'primary' : 'secondary'}
              className="h-11"
              onClick={() => setParams(s === 'ACTIVE' ? {} : { status: s })}
            >
              {t(`st.statuses.${s}`)}
            </Button>
          ))}
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="st-q">{t('st.search')}</Label>
          <Input id="st-q" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {!adding && (
          <Button className="h-11" onClick={() => setAdding(true)}>
            {t('st.add')}
          </Button>
        )}
      </div>
      {adding && data && (
        <StaffForm
          staff={null}
          departments={data.departments}
          people={data.people}
          onDone={() => setAdding(false)}
        />
      )}
      {list.error && (
        <Alert tone="critical" className="mt-3">
          {errorMessage(list.error)}
        </Alert>
      )}
      {data && data.data.length === 0 && (
        <p className="mt-3 text-sm text-text-muted">{t('st.none')}</p>
      )}
      <ul aria-label={t('st.list')} className="mt-3 flex flex-col gap-2">
        {data?.data.map((s) => (
          <li key={s.id} className="rounded-md border border-border bg-surface p-3 text-sm">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <button
                type="button"
                className="text-left font-medium text-brand underline"
                aria-expanded={open === s.id}
                onClick={() => setOpen(open === s.id ? null : s.id)}
              >
                ST-{s.number} · {s.name}
              </button>
              {s.certsDue > 0 && (
                <span className="rounded bg-warning-subtle px-2 py-0.5 text-xs font-medium text-warning">
                  {t('st.certsDue', { count: s.certsDue })}
                </span>
              )}
            </div>
            <p className="mt-1 text-text-muted">
              {[
                s.jobTitle,
                s.department?.name,
                t(`st.types.${s.employmentType}`),
                s.user ? (s.user.email ?? '') : t('st.noLogin'),
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
            {open === s.id && data && (
              <StaffPanel item={s} departments={data.departments} people={data.people} />
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function StaffPanel(props: { item: Item; departments: Option[]; people: Person[] }) {
  const { t } = useTranslation();
  const f = useFormats();
  const queryClient = useQueryClient();
  const root = useKey();
  const [editing, setEditing] = useState(false);
  const [cert, setCert] = useState<Detail['certifications'][number] | 'new' | null>(null);
  const [leaving, setLeaving] = useState(false);
  const detail = useQuery({
    queryKey: useKey('detail', props.item.id),
    queryFn: () => api.call('getStaff', { params: { staffId: props.item.id } }),
  });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: root });
  const remove = useMutation({
    mutationFn: (certificationId: string) =>
      api.call('removeCertification', { params: { staffId: props.item.id, certificationId } }),
    onSuccess: refresh,
  });
  const rejoin = useMutation({
    mutationFn: () =>
      api.call('updateStaff', { params: { staffId: props.item.id }, body: { endDate: null } }),
    onSuccess: refresh,
  });
  const d = detail.data;
  return (
    <div className="mt-3 grid gap-3 border-t border-border pt-3">
      {detail.error && <Alert tone="critical">{errorMessage(detail.error)}</Alert>}
      {d && !editing && (
        <>
          <div className="grid gap-1">
            <p>
              {t('st.since', { date: f.date(d.startDate) })}
              {d.endDate && <> · {t('st.until', { date: f.date(d.endDate) })}</>}
              {d.manager && <> · {t('st.reportsTo', { name: d.manager.name })}</>}
            </p>
            <p>
              {d.payRateMinor
                ? t('st.pay', {
                    amount: f.money(d.payRateMinor),
                    per: t(`st.per.${d.employmentType}`),
                  })
                : t('st.payNone')}
            </p>
            {(d.phone ?? d.email) && (
              <p>{t('st.contact', { value: [d.phone, d.email].filter(Boolean).join(' · ') })}</p>
            )}
          </div>
          <Emergency staffId={d.id} recorded={d.hasEmergencyContact} />
          <section aria-label={t('st.certs')}>
            <h3 className="font-semibold">{t('st.certs')}</h3>
            {d.certifications.length === 0 && (
              <p className="text-text-muted">{t('st.certsNone')}</p>
            )}
            <ul className="mt-1 flex flex-col gap-1">
              {d.certifications.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{c.name}</span>
                  {c.reference && <span className="text-text-muted">{c.reference}</span>}
                  {c.expiresOn && (
                    <span className="text-text-muted">
                      {t('st.expires', { date: f.date(c.expiresOn) })}
                    </span>
                  )}
                  <span className={cn('rounded px-2 py-0.5 text-xs', STATE_TONE[c.state])}>
                    {t(`st.certStates.${c.state}`)}
                  </span>
                  <Button size="sm" variant="secondary" onClick={() => setCert(c)}>
                    {t('st.renew')}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={remove.isPending}
                    onClick={() => remove.mutate(c.id)}
                  >
                    {t('st.remove')}
                  </Button>
                </li>
              ))}
            </ul>
            {remove.error && <Alert tone="critical">{errorMessage(remove.error)}</Alert>}
            {cert === null && (
              <Button variant="secondary" className="mt-2 h-11" onClick={() => setCert('new')}>
                {t('st.addCert')}
              </Button>
            )}
            {cert !== null && (
              <CertForm
                staffId={d.id}
                cert={cert === 'new' ? null : cert}
                onDone={() => setCert(null)}
              />
            )}
          </section>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" className="h-11" onClick={() => setEditing(true)}>
              {t('st.edit')}
            </Button>
            {d.status === 'ACTIVE' ? (
              <Button variant="secondary" className="h-11" onClick={() => setLeaving(true)}>
                {t('st.leave')}
              </Button>
            ) : (
              <Button
                variant="secondary"
                className="h-11"
                disabled={rejoin.isPending}
                onClick={() => rejoin.mutate()}
              >
                {t('st.rejoin')}
              </Button>
            )}
          </div>
          {rejoin.error && <Alert tone="critical">{errorMessage(rejoin.error)}</Alert>}
          {leaving && <LeaveForm staffId={d.id} onDone={() => setLeaving(false)} />}
        </>
      )}
      {d && editing && (
        <StaffForm
          staff={d}
          departments={props.departments}
          people={props.people}
          onDone={() => setEditing(false)}
        />
      )}
    </div>
  );
}

function Emergency(props: { staffId: string; recorded: boolean }) {
  const { t } = useTranslation();
  const [show, setShow] = useState(false);
  const contact = useQuery({
    queryKey: useKey('emergency', props.staffId),
    queryFn: () => api.call('getEmergencyContact', { params: { staffId: props.staffId } }),
    enabled: show,
    staleTime: 0,
    gcTime: 0,
  });
  if (!props.recorded) return <p className="text-text-muted">{t('st.emergencyNone')}</p>;
  return (
    <div>
      {!show ? (
        <Button variant="secondary" className="h-11" onClick={() => setShow(true)}>
          {t('st.showEmergency')}
        </Button>
      ) : (
        <div aria-label={t('st.emergency')} role="group">
          <p className="font-medium">{t('st.emergency')}</p>
          {contact.data && (
            <p>
              {[contact.data.name, contact.data.relation, contact.data.phone]
                .filter(Boolean)
                .join(' · ')}
            </p>
          )}
          {contact.error && <Alert tone="critical">{errorMessage(contact.error)}</Alert>}
        </div>
      )}
      <p className="text-xs text-text-muted">{t('st.emergencyNote')}</p>
    </div>
  );
}

function LeaveForm(props: { staffId: string; onDone: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const root = useKey();
  const [endDate, setEndDate] = useState('');
  const save = useMutation({
    mutationFn: () =>
      api.call('updateStaff', { params: { staffId: props.staffId }, body: { endDate } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: root });
      props.onDone();
    },
  });
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <div className="flex flex-col gap-1">
        <Label htmlFor="st-left">{t('st.leftOn')}</Label>
        <Input
          id="st-left"
          type="date"
          required
          value={endDate}
          onChange={(e) => setEndDate(e.target.value)}
        />
      </div>
      <Button type="submit" className="h-11" disabled={save.isPending}>
        {t('st.save')}
      </Button>
      <Button type="button" variant="secondary" className="h-11" onClick={props.onDone}>
        {t('st.cancel')}
      </Button>
      {save.error && <Alert tone="critical">{errorMessage(save.error)}</Alert>}
    </form>
  );
}

function CertForm(props: {
  staffId: string;
  cert: Detail['certifications'][number] | null;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const root = useKey();
  const c = props.cert;
  const [name, setName] = useState(c?.name ?? '');
  const [issuer, setIssuer] = useState(c?.issuer ?? '');
  const [reference, setReference] = useState(c?.reference ?? '');
  const [issuedOn, setIssuedOn] = useState(c?.issuedOn ?? '');
  const [expiresOn, setExpiresOn] = useState(c?.expiresOn ?? '');
  const save = useMutation({
    mutationFn: () => {
      const body = {
        name,
        issuer,
        reference,
        issuedOn: issuedOn || null,
        expiresOn: expiresOn || null,
      };
      return c
        ? api.call('updateCertification', {
            params: { staffId: props.staffId, certificationId: c.id },
            body,
          })
        : api.call('addCertification', { params: { staffId: props.staffId }, body });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: root });
      props.onDone();
    },
  });
  const field = (
    id: string,
    label: string,
    value: string,
    set: (v: string) => void,
    type = 'text',
  ) => (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} type={type} value={value} onChange={(e) => set(e.target.value)} />
    </div>
  );
  return (
    <form
      aria-label={t('st.certForm')}
      className="mt-2 grid gap-2 rounded-md border border-border p-3 sm:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <div className="flex flex-col gap-1">
        <Label htmlFor="cert-name">{t('st.certName')}</Label>
        <Input id="cert-name" required value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      {field('cert-issuer', t('st.issuer'), issuer, setIssuer)}
      {field('cert-ref', t('st.reference'), reference, setReference)}
      {field('cert-issued', t('st.issuedOn'), issuedOn, setIssuedOn, 'date')}
      {field('cert-expires', t('st.expiresOn'), expiresOn, setExpiresOn, 'date')}
      {save.error && (
        <Alert tone="critical" className="sm:col-span-2">
          {errorMessage(save.error)}
        </Alert>
      )}
      <div className="flex gap-2 sm:col-span-2">
        <Button type="submit" className="h-11" disabled={save.isPending}>
          {t('st.save')}
        </Button>
        <Button type="button" variant="secondary" className="h-11" onClick={props.onDone}>
          {t('st.cancel')}
        </Button>
      </div>
    </form>
  );
}

function StaffForm(props: {
  staff: Detail | null;
  departments: Option[];
  people: Person[];
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const root = useKey();
  const s = props.staff;
  const [name, setName] = useState(s?.name ?? '');
  const [userId, setUserId] = useState(s?.user?.id ?? '');
  const [phone, setPhone] = useState(s?.phone ?? '');
  const [email, setEmail] = useState(s?.email ?? '');
  const [departmentId, setDepartmentId] = useState(s?.department?.id ?? '');
  const [jobTitle, setJobTitle] = useState(s?.jobTitle ?? '');
  const [managerId, setManagerId] = useState(s?.manager?.id ?? '');
  const [type, setType] = useState<EmploymentType>(s?.employmentType ?? 'MONTHLY_SALARY');
  const [startDate, setStartDate] = useState(s?.startDate ?? '');
  const [pay, setPay] = useState(s?.payRateMinor ? (Number(s.payRateMinor) / 100).toFixed(2) : '');
  const [eName, setEName] = useState('');
  const [ePhone, setEPhone] = useState('');
  const [eRelation, setERelation] = useState('');
  const save = useMutation({
    mutationFn: () => {
      const emergency =
        eName || ePhone || eRelation
          ? { name: eName, phone: ePhone || null, relation: eRelation }
          : undefined;
      const body = {
        name,
        userId: userId || null,
        phone: phone || null,
        email: email || null,
        departmentId: departmentId || null,
        jobTitle,
        managerId: managerId || null,
        employmentType: type,
        startDate,
        payRateMinor: pay.trim() ? toMinor(pay) : null,
        ...(emergency ? { emergency } : {}),
      };
      return s
        ? api.call('updateStaff', { params: { staffId: s.id }, body })
        : api.call('createStaff', { body });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: root });
      props.onDone();
    },
  });
  const logins = props.people.filter((p) => !p.linked || p.id === s?.user?.id);
  const text = (
    id: string,
    label: string,
    value: string,
    set: (v: string) => void,
    extra: object = {},
  ) => (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} value={value} onChange={(e) => set(e.target.value)} {...extra} />
    </div>
  );
  return (
    <form
      aria-label={t('st.form')}
      className="mt-3 grid gap-3 rounded-md border border-border bg-surface p-3 sm:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      {text('st-name', t('st.name'), name, setName, { required: true })}
      {text('st-job', t('st.jobTitle'), jobTitle, setJobTitle, { required: true })}
      <div className="flex flex-col gap-1">
        <Label htmlFor="st-dept">{t('st.department')}</Label>
        <select
          id="st-dept"
          className={selectClass}
          value={departmentId}
          onChange={(e) => setDepartmentId(e.target.value)}
        >
          <option value="">{t('st.noneOption')}</option>
          {props.departments.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="st-manager">{t('st.manager')}</Label>
        <select
          id="st-manager"
          className={selectClass}
          value={managerId}
          onChange={(e) => setManagerId(e.target.value)}
        >
          <option value="">{t('st.noneOption')}</option>
          {props.people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="st-type">{t('st.type')}</Label>
        <select
          id="st-type"
          className={selectClass}
          value={type}
          onChange={(e) => setType(e.target.value as EmploymentType)}
        >
          {EMPLOYMENT_TYPES.map((x) => (
            <option key={x} value={x}>
              {t(`st.types.${x}`)}
            </option>
          ))}
        </select>
      </div>
      {text('st-start', t('st.startDate'), startDate, setStartDate, {
        type: 'date',
        required: true,
      })}
      {text('st-pay', t('st.payRate'), pay, setPay, { inputMode: 'decimal' })}
      <div className="flex flex-col gap-1">
        <Label htmlFor="st-login">{t('st.login')}</Label>
        <select
          id="st-login"
          className={selectClass}
          value={userId}
          onChange={(e) => setUserId(e.target.value)}
        >
          <option value="">{t('st.noneOption')}</option>
          {logins.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {p.email ? ` (${p.email})` : ''}
            </option>
          ))}
        </select>
      </div>
      {text('st-phone', t('st.phone'), phone, setPhone, { type: 'tel' })}
      {text('st-email', t('st.email'), email, setEmail, { type: 'email' })}
      {text('st-ename', t('st.emergencyName'), eName, setEName)}
      {text('st-ephone', t('st.emergencyPhone'), ePhone, setEPhone, { type: 'tel' })}
      {text('st-erel', t('st.emergencyRelation'), eRelation, setERelation)}
      {save.error && (
        <Alert tone="critical" className="sm:col-span-2">
          {errorMessage(save.error)}
        </Alert>
      )}
      <div className="flex gap-2 sm:col-span-2">
        <Button type="submit" className="h-11" disabled={save.isPending}>
          {t('st.save')}
        </Button>
        <Button type="button" variant="secondary" className="h-11" onClick={props.onDone}>
          {t('st.cancel')}
        </Button>
      </div>
    </form>
  );
}
