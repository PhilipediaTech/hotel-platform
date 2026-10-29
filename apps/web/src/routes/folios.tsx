import {
  REVENUE_GROUPS,
  type ApprovalPending,
  type FolioItem,
  type FOLIO_STATUSES,
} from '@hotel/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';
import type { z } from 'zod';
import { useSession } from '../app/session.ts';
import { Alert } from '../components/ui/alert.tsx';
import { Button } from '../components/ui/button.tsx';
import { Input } from '../components/ui/input.tsx';
import { Label } from '../components/ui/label.tsx';
import { api } from '../lib/api.ts';
import { cn } from '../lib/cn.ts';
import { errorMessage } from '../lib/form.ts';
import { useFormats } from './reservations.tsx';

// S11 Folio (PRD M4-01–M4-05; T-060): windows as tabs, lines with their taxes, balance; post a
// charge, discount or reverse a line, add a window and route revenue to it. Payments,
// transfers and invoices arrive with T-062–T-065.

type Folio = z.output<typeof FolioItem>;
type Line = Folio['windows'][number]['lines'][number];
type FolioStatus = (typeof FOLIO_STATUSES)[number];

const selectClass = 'h-10 rounded-md border border-border bg-surface px-3 text-sm';
const folioKey = (pid: string | null, id: string) => ['folios', pid ?? '', id];

/** "1,500.50" → "150050" (minor units); null when it is not a positive amount. */
export function toMinor(text: string): string | null {
  const clean = text.replace(/[,\s₦]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(clean)) return null;
  const [whole = '0', fraction = ''] = clean.split('.');
  const minor = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  return minor > 0n ? minor.toString() : null;
}

const isPending = (r: unknown): r is z.output<typeof ApprovalPending> =>
  typeof r === 'object' && r !== null && 'approvalRequestId' in r;

// ── List ──────────────────────────────────────────────────────────────────────────────

export function FoliosPage() {
  const { t } = useTranslation();
  const f = useFormats();
  const { currentPropertyId } = useSession();
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<FolioStatus>('OPEN');
  const list = useQuery({
    queryKey: ['folios', currentPropertyId ?? '', 'list', status, q],
    queryFn: () => api.call('listFolios', { query: { status, ...(q ? { q } : {}) } }),
  });
  return (
    <section className="max-w-4xl">
      <h1 className="text-xl font-semibold">{t('folios.title')}</h1>
      <form
        className="mt-4 flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          setQ(text.trim());
        }}
      >
        <Field id="fo-find" label={t('folios.find')}>
          <Input
            id="fo-find"
            className="w-64"
            placeholder={t('folios.findHint')}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </Field>
        <Field id="fo-status" label={t('folios.status')}>
          <select
            id="fo-status"
            className={selectClass}
            value={status}
            onChange={(e) => setStatus(e.target.value as FolioStatus)}
          >
            {(['OPEN', 'SETTLED', 'TRANSFERRED', 'CLOSED'] as const).map((s) => (
              <option key={s} value={s}>
                {t(`folios.statuses.${s}`)}
              </option>
            ))}
          </select>
        </Field>
        <Button type="submit" variant="secondary">
          {t('guests.find')}
        </Button>
      </form>
      {list.error && (
        <Alert tone="critical" className="mt-3">
          {errorMessage(list.error)}
        </Alert>
      )}
      {list.data && list.data.data.length === 0 && (
        <p className="mt-4 text-sm text-text-muted">{t('folios.none')}</p>
      )}
      {list.data && list.data.data.length > 0 && (
        <table aria-label={t('folios.title')} className="mt-4 w-full text-left text-sm">
          <thead className="text-text-muted">
            <tr>
              <th className="py-2 pr-3 font-medium">{t('folios.number')}</th>
              <th className="py-2 pr-3 font-medium">{t('folios.name')}</th>
              <th className="py-2 pr-3 font-medium">{t('frontDesk.cols.room')}</th>
              <th className="py-2 text-right font-medium">{t('frontDesk.cols.balance')}</th>
            </tr>
          </thead>
          <tbody>
            {list.data.data.map((folio) => (
              <tr key={folio.id} className="border-t border-border">
                <td className="py-2 pr-3">
                  <Link to={`/folios/${folio.id}`} className="text-brand underline">
                    {folio.number}
                  </Link>
                </td>
                <td className="py-2 pr-3">{folio.name}</td>
                <td className="py-2 pr-3">{folio.roomNumber ?? '—'}</td>
                <td className="py-2 text-right tabular-nums">{f.money(folio.balanceMinor)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

// ── One folio ─────────────────────────────────────────────────────────────────────────

export function FolioPage() {
  const { t } = useTranslation();
  const f = useFormats();
  const { folioId = '' } = useParams();
  const { currentPropertyId, permissions } = useSession();
  const can = (p: string) => permissions.includes(p);
  const [windowNumber, setWindowNumber] = useState(1);
  const [message, setMessage] = useState<string | null>(null);
  const folio = useQuery({
    queryKey: folioKey(currentPropertyId, folioId),
    queryFn: () => api.call('getFolio', { params: { folioId } }),
  });
  if (folio.error) return <Alert tone="critical">{errorMessage(folio.error)}</Alert>;
  const data = folio.data;
  if (!data) return <p className="text-sm text-text-muted">{t('shell.loading')}</p>;
  const current = data.windows.find((w) => w.number === windowNumber) ?? data.windows[0];
  const open = data.status === 'OPEN';

  return (
    <section className="max-w-5xl">
      <p className="text-sm">
        <Link to="/folios" className="text-brand underline">
          {t('folios.title')}
        </Link>
      </p>
      <h1 className="mt-1 flex flex-wrap items-center gap-2 text-xl font-semibold">
        {t('folios.heading', { number: data.number, name: data.name })}
        <span className="rounded bg-surface-sunken px-1.5 text-xs font-normal text-text-muted">
          {t(`folios.statuses.${data.status}`)}
        </span>
      </h1>
      <dl className="mt-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
        {data.stay && (
          <>
            <dt className="text-text-muted">{t('frontDesk.cols.stay')}</dt>
            <dd>
              {data.stay.roomNumber
                ? `${t('reservations.room.is', { room: data.stay.roomNumber })} · `
                : ''}
              {f.date(data.stay.arrival)} → {f.date(data.stay.departure)}
            </dd>
          </>
        )}
        {data.reservationId && (
          <>
            <dt className="text-text-muted">{t('folios.reservation')}</dt>
            <dd>
              <Link to={`/reservations/${data.reservationId}`} className="text-brand underline">
                {data.confirmationNo}
              </Link>
            </dd>
          </>
        )}
        <dt className="text-text-muted">{t('folios.balance')}</dt>
        <dd className="font-semibold tabular-nums">{f.money(data.balanceMinor)}</dd>
      </dl>

      {message && (
        <Alert tone="success" className="mt-3">
          {message}
        </Alert>
      )}

      <div role="tablist" aria-label={t('folios.windows')} className="mt-5 flex flex-wrap gap-2">
        {data.windows.map((w) => (
          <Button
            key={w.number}
            role="tab"
            size="sm"
            aria-selected={w.number === current?.number}
            variant={w.number === current?.number ? 'primary' : 'secondary'}
            onClick={() => setWindowNumber(w.number)}
          >
            {t('folios.window', {
              n: w.number,
              payer: w.payerName,
              amount: f.money(w.balanceMinor),
            })}
          </Button>
        ))}
      </div>

      {current && (
        <Lines
          folio={data}
          lines={current.lines}
          onPending={() => setMessage(t('folios.sentForApproval'))}
          canEdit={open}
        />
      )}

      {open && can('folio.charge') && (
        <PostCharge folio={data} onPending={() => setMessage(t('folios.sentForApproval'))} />
      )}
      {open && can('folio.route') && <Routing folio={data} />}
    </section>
  );
}

function useRefresh(folioId: string) {
  const queryClient = useQueryClient();
  const { currentPropertyId } = useSession();
  return () => {
    void queryClient.invalidateQueries({ queryKey: folioKey(currentPropertyId, folioId) });
    void queryClient.invalidateQueries({ queryKey: ['front-desk'] });
  };
}

function Lines({
  folio,
  lines,
  canEdit,
  onPending,
}: {
  folio: Folio;
  lines: Line[];
  canEdit: boolean;
  onPending: () => void;
}) {
  const { t } = useTranslation();
  const f = useFormats();
  const { permissions } = useSession();
  const [acting, setActing] = useState<{ line: Line; kind: 'reverse' | 'discount' } | null>(null);
  if (lines.length === 0) {
    return <p className="mt-4 text-sm text-text-muted">{t('folios.noLines')}</p>;
  }
  return (
    <div className="mt-3 overflow-x-auto">
      <table aria-label={t('folios.lines')} className="w-full text-left text-sm">
        <thead className="text-text-muted">
          <tr>
            <th className="py-2 pr-3 font-medium">{t('folios.cols.date')}</th>
            <th className="py-2 pr-3 font-medium">{t('folios.cols.description')}</th>
            <th className="py-2 pr-3 font-medium">{t('folios.cols.code')}</th>
            <th className="py-2 pr-3 text-right font-medium">{t('folios.cols.amount')}</th>
            <th className="py-2 pr-3 font-medium">{t('folios.cols.by')}</th>
            <th className="py-2 font-medium">
              <span className="sr-only">{t('frontDesk.cols.action')}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line) => {
            const sub = line.kind === 'TAX' || (line.kind === 'REVERSAL' && line.parentLineId);
            const gone = line.reversedByLineId !== null;
            const actionable =
              canEdit && !gone && (line.kind === 'CHARGE' || line.kind === 'DISCOUNT');
            return (
              <tr key={line.id} className={cn('border-t border-border', sub && 'text-text-muted')}>
                <td className="py-1.5 pr-3">{f.date(line.businessDate)}</td>
                <td className={cn('py-1.5 pr-3', sub && 'pl-4', gone && 'line-through')}>
                  {line.description}
                  {line.quantity > 1 && ` × ${line.quantity}`}
                  {line.reason && line.kind !== 'CHARGE' && (
                    <span className="block text-xs text-text-muted">{line.reason}</span>
                  )}
                </td>
                <td className="py-1.5 pr-3">{line.revenueCode}</td>
                <td className={cn('py-1.5 pr-3 text-right tabular-nums', gone && 'line-through')}>
                  {f.money(line.amountMinor)}
                </td>
                <td className="py-1.5 pr-3 text-xs">{line.postedBy ?? ''}</td>
                <td className="py-1.5">
                  {actionable && (
                    <span className="flex gap-1">
                      {line.kind === 'CHARGE' && permissions.includes('folio.discount') && (
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={t('folios.discountNamed', { line: line.description })}
                          onClick={() => setActing({ line, kind: 'discount' })}
                        >
                          {t('folios.discount')}
                        </Button>
                      )}
                      {permissions.includes('folio.reverse') && (
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={t('folios.reverseNamed', { line: line.description })}
                          onClick={() => setActing({ line, kind: 'reverse' })}
                        >
                          {t('folios.reverse')}
                        </Button>
                      )}
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {acting?.kind === 'reverse' && (
        <ReverseForm
          folio={folio}
          line={acting.line}
          onDone={(pending) => {
            setActing(null);
            if (pending) onPending();
          }}
        />
      )}
      {acting?.kind === 'discount' && (
        <DiscountForm
          folio={folio}
          line={acting.line}
          onDone={(pending) => {
            setActing(null);
            if (pending) onPending();
          }}
        />
      )}
    </div>
  );
}

function ReverseForm(props: { folio: Folio; line: Line; onDone: (pending: boolean) => void }) {
  const { t } = useTranslation();
  const refresh = useRefresh(props.folio.id);
  const [reason, setReason] = useState('');
  const reverse = useMutation({
    mutationFn: () =>
      api.call('reverseLine', {
        params: { lineId: props.line.id },
        body: { reason: reason.trim() },
      }),
    onSuccess: (result) => {
      refresh();
      props.onDone(isPending(result));
    },
  });
  return (
    <form
      aria-label={t('folios.reverseNamed', { line: props.line.description })}
      className="mt-3 flex flex-wrap items-end gap-3 rounded-md border border-border p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (reason.trim()) reverse.mutate();
      }}
    >
      <Field id="fo-rev-reason" label={t('folios.reason')}>
        <Input
          id="fo-rev-reason"
          className="w-72"
          value={reason}
          maxLength={500}
          onChange={(e) => setReason(e.target.value)}
        />
      </Field>
      <Button type="submit" disabled={!reason.trim() || reverse.isPending}>
        {t('folios.reverseConfirm')}
      </Button>
      <Button variant="ghost" onClick={() => props.onDone(false)}>
        {t('guests.cancel')}
      </Button>
      {reverse.error && <Alert tone="critical">{errorMessage(reverse.error)}</Alert>}
    </form>
  );
}

function DiscountForm(props: { folio: Folio; line: Line; onDone: (pending: boolean) => void }) {
  const { t } = useTranslation();
  const refresh = useRefresh(props.folio.id);
  const [byPercent, setByPercent] = useState(true);
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  const amount = byPercent ? null : toMinor(value);
  const percent = byPercent ? Number(value) : NaN;
  const ready =
    reason.trim() !== '' && (byPercent ? percent > 0 && percent <= 100 : amount !== null);
  const discount = useMutation({
    mutationFn: () =>
      api.call('addDiscount', {
        params: { folioId: props.folio.id },
        body: {
          lineId: props.line.id,
          ...(byPercent ? { percent } : { amountMinor: amount ?? '0' }),
          reason: reason.trim(),
        },
      }),
    onSuccess: (result) => {
      refresh();
      props.onDone(isPending(result));
    },
  });
  return (
    <form
      aria-label={t('folios.discountNamed', { line: props.line.description })}
      className="mt-3 flex flex-wrap items-end gap-3 rounded-md border border-border p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) discount.mutate();
      }}
    >
      <Field id="fo-disc-kind" label={t('folios.discountBy')}>
        <select
          id="fo-disc-kind"
          className={selectClass}
          value={byPercent ? 'percent' : 'amount'}
          onChange={(e) => setByPercent(e.target.value === 'percent')}
        >
          <option value="percent">{t('folios.percent')}</option>
          <option value="amount">{t('folios.amount')}</option>
        </select>
      </Field>
      <Field id="fo-disc-value" label={byPercent ? t('folios.percent') : t('folios.amount')}>
        <Input
          id="fo-disc-value"
          className="w-32"
          inputMode="decimal"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      </Field>
      <Field id="fo-disc-reason" label={t('folios.reason')}>
        <Input
          id="fo-disc-reason"
          className="w-64"
          value={reason}
          maxLength={500}
          onChange={(e) => setReason(e.target.value)}
        />
      </Field>
      <Button type="submit" disabled={!ready || discount.isPending}>
        {t('folios.discountConfirm')}
      </Button>
      <Button variant="ghost" onClick={() => props.onDone(false)}>
        {t('guests.cancel')}
      </Button>
      <p className="w-full text-xs text-text-muted">{t('folios.discountHint')}</p>
      {discount.error && <Alert tone="critical">{errorMessage(discount.error)}</Alert>}
    </form>
  );
}

function PostCharge({ folio, onPending }: { folio: Folio; onPending: () => void }) {
  const { t } = useTranslation();
  const refresh = useRefresh(folio.id);
  const [code, setCode] = useState(folio.revenueCodes[0]?.code ?? '');
  const [description, setDescription] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [price, setPrice] = useState('');
  const [windowNumber, setWindowNumber] = useState('');
  const unit = toMinor(price);
  const ready = code !== '' && description.trim() !== '' && unit !== null && Number(quantity) >= 1;
  const post = useMutation({
    mutationFn: () =>
      api.call('postCharge', {
        params: { folioId: folio.id },
        body: {
          revenueCode: code,
          description: description.trim(),
          quantity: Number(quantity),
          unitAmountMinor: unit ?? '0',
          note: null,
          ...(windowNumber ? { windowNumber: Number(windowNumber) } : {}),
        },
      }),
    onSuccess: (result) => {
      if (isPending(result)) onPending();
      setDescription('');
      setPrice('');
      setQuantity('1');
      refresh();
    },
  });
  return (
    <form
      aria-label={t('folios.postCharge')}
      className="mt-6 grid items-end gap-3 rounded-md border border-border bg-surface p-4 sm:grid-cols-6"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) post.mutate();
      }}
    >
      <h2 className="font-semibold sm:col-span-6">{t('folios.postCharge')}</h2>
      <Field id="fo-code" label={t('folios.cols.code')}>
        <select
          id="fo-code"
          className={selectClass}
          value={code}
          onChange={(e) => setCode(e.target.value)}
        >
          {folio.revenueCodes.map((c) => (
            <option key={c.code} value={c.code}>
              {c.code} · {c.name}
            </option>
          ))}
        </select>
      </Field>
      <div className="sm:col-span-2">
        <Field id="fo-desc" label={t('folios.cols.description')}>
          <Input
            id="fo-desc"
            value={description}
            maxLength={200}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
      </div>
      <Field id="fo-qty" label={t('folios.quantity')}>
        <Input
          id="fo-qty"
          type="number"
          min={1}
          max={999}
          value={quantity}
          onChange={(e) => setQuantity(e.target.value)}
        />
      </Field>
      <Field id="fo-price" label={t('folios.unitPrice')}>
        <Input
          id="fo-price"
          inputMode="decimal"
          placeholder="1,500.00"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
        />
      </Field>
      <Field id="fo-window" label={t('folios.windowLabel')}>
        <select
          id="fo-window"
          className={selectClass}
          value={windowNumber}
          onChange={(e) => setWindowNumber(e.target.value)}
        >
          <option value="">{t('folios.byRouting')}</option>
          {folio.windows.map((w) => (
            <option key={w.number} value={String(w.number)}>
              {w.number} · {w.payerName}
            </option>
          ))}
        </select>
      </Field>
      <div className="flex items-center gap-3 sm:col-span-6">
        <Button type="submit" disabled={!ready || post.isPending}>
          {t('folios.post')}
        </Button>
        <span className="text-xs text-text-muted">{t('folios.taxHint')}</span>
      </div>
      {post.error && (
        <Alert tone="critical" className="sm:col-span-6">
          {errorMessage(post.error)}
        </Alert>
      )}
    </form>
  );
}

function Routing({ folio }: { folio: Folio }) {
  const { t } = useTranslation();
  const refresh = useRefresh(folio.id);
  const [group, setGroup] = useState('ROOM');
  const [windowNumber, setWindowNumber] = useState(String(folio.windows.at(-1)?.number ?? 1));
  const addWindow = useMutation({
    mutationFn: (payer: { payerType: 'GUEST' | 'COMPANY'; companyId?: string }) =>
      api.call('addWindow', { params: { folioId: folio.id }, body: payer }),
    onSuccess: refresh,
  });
  const addRule = useMutation({
    mutationFn: () =>
      api.call('addRoutingRule', {
        params: { folioId: folio.id },
        body: {
          revenueGroup: group as (typeof REVENUE_GROUPS)[number],
          windowNumber: Number(windowNumber),
        },
      }),
    onSuccess: refresh,
  });
  const error = addWindow.error ?? addRule.error;
  return (
    <section
      aria-label={t('folios.routing')}
      className="mt-6 rounded-md border border-border bg-surface p-4 text-sm"
    >
      <h2 className="font-semibold">{t('folios.routing')}</h2>
      <div className="mt-2 flex flex-wrap gap-2">
        {folio.company && (
          <Button
            size="sm"
            variant="secondary"
            disabled={addWindow.isPending}
            onClick={() =>
              addWindow.mutate({ payerType: 'COMPANY', companyId: folio.company?.id ?? '' })
            }
          >
            {t('folios.addCompanyWindow', { company: folio.company.name })}
          </Button>
        )}
        <Button
          size="sm"
          variant="secondary"
          disabled={addWindow.isPending}
          onClick={() => addWindow.mutate({ payerType: 'GUEST' })}
        >
          {t('folios.addGuestWindow')}
        </Button>
      </div>
      {folio.routingRules.length > 0 && (
        <ul aria-label={t('folios.rules')} className="mt-3 list-disc pl-5">
          {folio.routingRules.map((r) => (
            <li key={r.id}>
              {t('folios.rule', {
                what: r.revenueGroup ? t(`folios.groups.${r.revenueGroup}`) : r.revenueCode,
                n: r.windowNumber,
              })}
            </li>
          ))}
        </ul>
      )}
      <form
        className="mt-3 flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          addRule.mutate();
        }}
      >
        <Field id="fo-rule-group" label={t('folios.routeWhat')}>
          <select
            id="fo-rule-group"
            className={selectClass}
            value={group}
            onChange={(e) => setGroup(e.target.value)}
          >
            {REVENUE_GROUPS.filter((g) => g !== 'TAX' && g !== 'SERVICE_CHARGE').map((g) => (
              <option key={g} value={g}>
                {t(`folios.groups.${g}`)}
              </option>
            ))}
          </select>
        </Field>
        <Field id="fo-rule-window" label={t('folios.windowLabel')}>
          <select
            id="fo-rule-window"
            className={selectClass}
            value={windowNumber}
            onChange={(e) => setWindowNumber(e.target.value)}
          >
            {folio.windows.map((w) => (
              <option key={w.number} value={String(w.number)}>
                {w.number} · {w.payerName}
              </option>
            ))}
          </select>
        </Field>
        <Button type="submit" variant="secondary" disabled={addRule.isPending}>
          {t('folios.addRule')}
        </Button>
      </form>
      {error && (
        <Alert tone="critical" className="mt-2">
          {errorMessage(error)}
        </Alert>
      )}
    </section>
  );
}

function Field(props: { id: string; label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={props.id}>{props.label}</Label>
      {props.children}
    </div>
  );
}
