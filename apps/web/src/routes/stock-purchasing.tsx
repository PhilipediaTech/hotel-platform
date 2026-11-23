import { formatQuantity, parseQuantity, type PurchaseOrderItem } from '@hotel/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
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
import stockStrings from '../i18n/en/stock.json';
import { registerStrings } from '../i18n/index.ts';
import { useFormats } from './reservations.tsx';

registerStrings(stockStrings);

// S42 Inventory and purchasing (PRD M10-03, M10-04; T-146): suppliers, purchase orders
// approved within the manager's limit or by an approver, and receiving goods against them.

type Order = z.output<typeof PurchaseOrderItem>;

const selectClass = 'h-11 rounded-md border border-border bg-surface px-3 text-sm';
const card = 'rounded-md border border-border bg-surface p-4';

const isPending = (r: unknown) => typeof r === 'object' && r !== null && 'approvalRequestId' in r;

function useRoot() {
  const { currentPropertyId } = useSession();
  return ['stock', currentPropertyId ?? ''];
}

function useChange<T, R = unknown>(fn: (v: T) => Promise<R>) {
  const root = useRoot();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: root }),
  });
}

function Failure({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <Alert tone="critical" className="mt-2">
      {errorMessage(error)}
    </Alert>
  );
}

function Field({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  );
}

const STATUS_TONE: Record<Order['status'], string> = {
  DRAFT: 'bg-surface-sunken text-text-muted',
  APPROVED: 'bg-brand-subtle text-brand-strong',
  PARTIAL: 'bg-warning-subtle text-warning',
  RECEIVED: 'bg-success-subtle text-success',
  CLOSED: 'bg-surface-sunken text-text-muted',
  CANCELLED: 'bg-surface-sunken text-text-muted',
};

const left = (l: Order['lines'][number]) =>
  (parseQuantity(l.quantity) ?? 0n) - (parseQuantity(l.received) ?? 0n);

// ---------------------------------------------------------------------------------------
// Purchase orders and suppliers (M10-03)

export function PurchaseOrdersTab() {
  const { t } = useTranslation();
  const root = useRoot();
  const [raising, setRaising] = useState(false);
  const orders = useQuery({
    queryKey: [...root, 'orders'],
    queryFn: () => api.call('listPurchaseOrders', { query: {} }),
  });
  const suppliers = useQuery({
    queryKey: [...root, 'suppliers'],
    queryFn: () => api.call('listSuppliers', {}),
  });
  return (
    <div className="flex flex-col gap-3">
      <Failure error={orders.error ?? suppliers.error} />
      {raising ? (
        <OrderForm onDone={() => setRaising(false)} />
      ) : (
        <Button className="h-11 self-start" onClick={() => setRaising(true)}>
          {t('stock.orders.new')}
        </Button>
      )}
      {orders.data && orders.data.data.length === 0 && (
        <p className="text-sm text-text-muted">{t('stock.orders.none')}</p>
      )}
      <ul aria-label={t('stock.tabs.orders')} className="flex flex-col gap-2">
        {orders.data?.data.map((o) => (
          <OrderCard key={o.id} order={o} />
        ))}
      </ul>
      <Suppliers />
    </div>
  );
}

function OrderForm({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation();
  const root = useRoot();
  const suppliers = useQuery({
    queryKey: [...root, 'suppliers'],
    queryFn: () => api.call('listSuppliers', {}),
  });
  const items = useQuery({
    queryKey: [...root, 'items'],
    queryFn: () => api.call('listStockItems', {}),
  });
  const [supplierId, setSupplierId] = useState('');
  const [expectedOn, setExpectedOn] = useState('');
  const [note, setNote] = useState('');
  const [lines, setLines] = useState([{ itemId: '', quantity: '', price: '' }]);
  const save = useChange(() =>
    api.call('createPurchaseOrder', {
      body: {
        supplierId,
        expectedOn: expectedOn || null,
        note,
        lines: lines
          .filter((l) => l.itemId)
          .map((l) => ({
            itemId: l.itemId,
            quantity: l.quantity.trim(),
            unitPriceMinor: Number(l.price) === 0 ? '0' : (toMinor(l.price) ?? l.price),
          })),
      },
    }),
  );
  const setLine = (i: number, patch: Partial<(typeof lines)[number]>) =>
    setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  return (
    <form
      aria-label={t('stock.orders.new')}
      className={cn(card, 'flex flex-col gap-2')}
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate(undefined, { onSuccess: onDone });
      }}
    >
      <div className="grid gap-2 md:grid-cols-3">
        <Field id="po-supplier" label={t('stock.orders.supplier')}>
          <select
            id="po-supplier"
            className={selectClass}
            value={supplierId}
            onChange={(e) => setSupplierId(e.target.value)}
          >
            <option value="">{t('stock.common.choose')}</option>
            {suppliers.data?.data
              .filter((s) => s.active)
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
          </select>
        </Field>
        <Field id="po-expected" label={t('stock.orders.expected')}>
          <Input
            id="po-expected"
            type="date"
            value={expectedOn}
            onChange={(e) => setExpectedOn(e.target.value)}
          />
        </Field>
        <Field id="po-note" label={t('stock.requisitions.note')}>
          <Input id="po-note" value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>
      {lines.map((l, i) => (
        <div key={i} className="flex flex-wrap items-end gap-2">
          <Field id={`po-item-${i}`} label={t('stock.common.item')}>
            <select
              id={`po-item-${i}`}
              className={selectClass}
              value={l.itemId}
              onChange={(e) => setLine(i, { itemId: e.target.value })}
            >
              <option value="">{t('stock.common.choose')}</option>
              {items.data?.items
                .filter((it) => it.active)
                .map((it) => (
                  <option key={it.id} value={it.id}>
                    {it.name} ({it.unit.code})
                  </option>
                ))}
            </select>
          </Field>
          <Field id={`po-qty-${i}`} label={t('stock.common.quantity')}>
            <Input
              id={`po-qty-${i}`}
              className="w-28"
              inputMode="decimal"
              value={l.quantity}
              onChange={(e) => setLine(i, { quantity: e.target.value })}
            />
          </Field>
          <Field id={`po-price-${i}`} label={t('stock.orders.unitPrice')}>
            <Input
              id={`po-price-${i}`}
              className="w-32"
              inputMode="decimal"
              value={l.price}
              onChange={(e) => setLine(i, { price: e.target.value })}
            />
          </Field>
          {lines.length > 1 && (
            <Button
              variant="ghost"
              className="h-11"
              onClick={() => setLines(lines.filter((_, j) => j !== i))}
            >
              {t('stock.requisitions.remove')}
            </Button>
          )}
        </div>
      ))}
      <Button
        variant="secondary"
        className="h-11 self-start"
        onClick={() => setLines([...lines, { itemId: '', quantity: '', price: '' }])}
      >
        {t('stock.requisitions.addLine')}
      </Button>
      <Failure error={save.error} />
      <div className="flex gap-2">
        <Button type="submit" className="h-11" disabled={save.isPending || !supplierId}>
          {t('stock.orders.saveDraft')}
        </Button>
        <Button variant="ghost" className="h-11" onClick={onDone}>
          {t('stock.common.cancel')}
        </Button>
      </div>
    </form>
  );
}

function OrderCard({ order: o }: { order: Order }) {
  const { t } = useTranslation();
  const f = useFormats();
  const [mode, setMode] = useState<'approve' | 'close' | null>(null);
  const [reason, setReason] = useState('');
  const [sent, setSent] = useState(false);
  const params = { orderId: o.id };
  const approve = useChange(() => api.call('approvePurchaseOrder', { params, body: { reason } }));
  const close = useChange(() => api.call('closePurchaseOrder', { params, body: { reason } }));
  const cancel = useChange(() => api.call('cancelPurchaseOrder', { params }));
  const waiting = o.status === 'APPROVED' || o.status === 'PARTIAL';
  return (
    <li className={card}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-medium">
            {t('stock.orders.title', { number: o.number, supplier: o.supplier.name })}
          </p>
          <p className="text-sm text-text-muted">
            {[
              t('stock.requisitions.raisedBy', {
                name: o.createdBy.name,
                when: f.when(o.createdAt),
              }),
              o.expectedOn && t('stock.orders.expectedOn', { date: f.date(o.expectedOn) }),
              o.approvedBy && t('stock.orders.approvedBy', { name: o.approvedBy.name }),
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </div>
        <div className="text-right">
          <span className={cn('rounded px-2 py-0.5 text-sm', STATUS_TONE[o.status])}>
            {t(`stock.orders.status.${o.status}`)}
          </span>
          <p className="mt-1 font-semibold">{f.money(o.totalMinor)}</p>
        </div>
      </div>
      <ul className="mt-2 text-sm">
        {o.lines.map((l) => (
          <li key={l.id}>
            {t('stock.orders.line', {
              item: l.item.name,
              quantity: l.quantity,
              unit: l.item.unit,
              price: f.money(l.unitPriceMinor),
              received: l.received,
            })}
          </li>
        ))}
      </ul>
      {o.closeReason && o.closedBy && (
        <p className="mt-1 text-sm text-text-muted">
          {t('stock.requisitions.closed', { name: o.closedBy.name, reason: o.closeReason })}
        </p>
      )}
      {sent && (
        <Alert tone="info" className="mt-2">
          {t('stock.orders.sentForApproval')}
        </Alert>
      )}
      <div className="mt-2 flex flex-wrap gap-2">
        {o.status === 'DRAFT' && (
          <Button variant="secondary" size="sm" onClick={() => setMode('approve')}>
            {t('stock.orders.approve')}
          </Button>
        )}
        {waiting && (
          <Button variant="secondary" size="sm" onClick={() => setMode('close')}>
            {t('stock.requisitions.close')}
          </Button>
        )}
        {(o.status === 'DRAFT' || o.status === 'APPROVED') && (
          <Button variant="ghost" size="sm" onClick={() => cancel.mutate(undefined)}>
            {t('stock.orders.cancel')}
          </Button>
        )}
      </div>
      <Failure error={cancel.error} />
      {mode && (
        <form
          aria-label={
            mode === 'approve'
              ? t('stock.orders.approveTitle', { number: o.number })
              : t('stock.orders.closeTitle', { number: o.number })
          }
          className="mt-3 flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const done = (r: unknown) => {
              setSent(isPending(r));
              setMode(null);
              setReason('');
            };
            if (mode === 'approve') approve.mutate(undefined, { onSuccess: done });
            else close.mutate(undefined, { onSuccess: done });
          }}
        >
          {mode === 'approve' && (
            <p className="text-sm text-text-muted">{t('stock.orders.approveHint')}</p>
          )}
          <Field id={`po-reason-${o.id}`} label={t('stock.common.reason')}>
            <Input
              id={`po-reason-${o.id}`}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </Field>
          <Failure error={mode === 'approve' ? approve.error : close.error} />
          <div className="flex gap-2">
            <Button
              type="submit"
              className="h-11"
              disabled={
                approve.isPending || close.isPending || (mode === 'close' && !reason.trim())
              }
            >
              {mode === 'approve'
                ? t('stock.orders.approve')
                : t('stock.requisitions.confirmClose')}
            </Button>
            <Button variant="ghost" className="h-11" onClick={() => setMode(null)}>
              {t('stock.common.cancel')}
            </Button>
          </div>
        </form>
      )}
    </li>
  );
}

function Suppliers() {
  const { t } = useTranslation();
  const root = useRoot();
  const list = useQuery({
    queryKey: [...root, 'suppliers'],
    queryFn: () => api.call('listSuppliers', {}),
  });
  const [name, setName] = useState('');
  const [contactName, setContactName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const add = useChange(() =>
    api.call('createSupplier', { body: { name, contactName, phone, email, note: null } }),
  );
  const toggle = useChange((s: { id: string; active: boolean }) =>
    api.call('updateSupplier', { params: { supplierId: s.id }, body: { active: !s.active } }),
  );
  return (
    <div className={card}>
      <h2 className="font-semibold">{t('stock.suppliers.title')}</h2>
      <ul aria-label={t('stock.suppliers.title')} className="mt-2 flex flex-col gap-1">
        {list.data?.data.map((s) => (
          <li key={s.id} className="flex items-center justify-between gap-2 text-sm">
            <span className={cn(!s.active && 'text-text-muted line-through')}>
              {[s.name, s.contactName, s.phone, s.email].filter(Boolean).join(' · ')}
            </span>
            <Button variant="ghost" size="sm" onClick={() => toggle.mutate(s)}>
              {s.active ? t('stock.common.switchOff') : t('stock.common.switchOn')}
            </Button>
          </li>
        ))}
      </ul>
      <form
        aria-label={t('stock.suppliers.add')}
        className="mt-2 flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate(undefined, {
            onSuccess: () => {
              setName('');
              setContactName('');
              setPhone('');
              setEmail('');
            },
          });
        }}
      >
        <Field id="sup-name" label={t('stock.common.name')}>
          <Input id="sup-name" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field id="sup-contact" label={t('stock.suppliers.contact')}>
          <Input
            id="sup-contact"
            value={contactName}
            onChange={(e) => setContactName(e.target.value)}
          />
        </Field>
        <Field id="sup-phone" label={t('stock.suppliers.phone')}>
          <Input id="sup-phone" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </Field>
        <Field id="sup-email" label={t('stock.suppliers.email')}>
          <Input id="sup-email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Button type="submit" className="h-11" disabled={add.isPending || !name.trim()}>
          {t('stock.suppliers.add')}
        </Button>
      </form>
      <Failure error={add.error ?? toggle.error} />
    </div>
  );
}

// ---------------------------------------------------------------------------------------
// Receiving (M10-04)

export function ReceivingTab() {
  const { t } = useTranslation();
  const f = useFormats();
  const root = useRoot();
  const list = useQuery({
    queryKey: [...root, 'receipts'],
    queryFn: () => api.call('listGoodsReceipts', {}),
  });
  const data = list.data;
  return (
    <div className="flex flex-col gap-3">
      <Failure error={list.error} />
      <h2 className="font-semibold">{t('stock.receiving.awaiting')}</h2>
      {data && data.awaiting.length === 0 && (
        <p className="text-sm text-text-muted">{t('stock.receiving.nothing')}</p>
      )}
      <ul aria-label={t('stock.receiving.awaiting')} className="flex flex-col gap-2">
        {data?.awaiting.map((o) => (
          <li key={o.id} className={card}>
            <p className="font-medium">
              {t('stock.orders.title', { number: o.number, supplier: o.supplier.name })}
            </p>
            <ReceiveForm order={o} locations={data.locations} />
          </li>
        ))}
      </ul>
      <h2 className="font-semibold">{t('stock.receiving.done')}</h2>
      <ul aria-label={t('stock.receiving.done')} className="flex flex-col gap-1">
        {data?.data.map((r) => (
          <li key={r.id} className="rounded border border-border bg-surface px-3 py-2 text-sm">
            <p className="font-medium">
              {t('stock.receiving.receipt', {
                number: r.number,
                order: r.order.number,
                supplier: r.order.supplier,
              })}
            </p>
            <p className="text-text-muted">
              {[
                f.when(r.receivedAt),
                r.location.name,
                t('stock.common.by', { name: r.receivedBy.name }),
                r.supplierRef,
                f.money(r.valueMinor),
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
            <p>{r.lines.map((l) => `${l.item.name} ${l.quantity} ${l.item.unit}`).join(', ')}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ReceiveForm({
  order: o,
  locations,
}: {
  order: Order;
  locations: { id: string; name: string; active: boolean }[];
}) {
  const { t } = useTranslation();
  const [locationId, setLocationId] = useState('');
  const [supplierRef, setSupplierRef] = useState('');
  const [qty, setQty] = useState<Record<string, string>>(() =>
    Object.fromEntries(o.lines.map((l) => [l.id, left(l) > 0n ? formatQuantity(left(l)) : ''])),
  );
  const save = useChange(() =>
    api.call('receiveGoods', {
      body: {
        purchaseOrderId: o.id,
        locationId,
        supplierRef,
        lines: Object.entries(qty)
          .filter(([, v]) => (parseQuantity(v) ?? 0n) > 0n)
          .map(([lineId, v]) => ({ lineId, quantity: v.trim() })),
      },
    }),
  );
  return (
    <form
      aria-label={t('stock.receiving.formTitle', { number: o.number })}
      className="mt-2 flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate(undefined);
      }}
    >
      <div className="grid gap-2 md:grid-cols-2">
        <Field id={`rcv-loc-${o.id}`} label={t('stock.receiving.into')}>
          <select
            id={`rcv-loc-${o.id}`}
            className={selectClass}
            value={locationId}
            onChange={(e) => setLocationId(e.target.value)}
          >
            <option value="">{t('stock.common.choose')}</option>
            {locations
              .filter((l) => l.active)
              .map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
          </select>
        </Field>
        <Field id={`rcv-ref-${o.id}`} label={t('stock.receiving.ref')}>
          <Input
            id={`rcv-ref-${o.id}`}
            value={supplierRef}
            onChange={(e) => setSupplierRef(e.target.value)}
          />
        </Field>
      </div>
      {o.lines
        .filter((l) => left(l) > 0n)
        .map((l) => (
          <Field
            key={l.id}
            id={`rcv-${l.id}`}
            label={t('stock.receiving.qty', {
              item: l.item.name,
              left: formatQuantity(left(l)),
              unit: l.item.unit,
            })}
          >
            <Input
              id={`rcv-${l.id}`}
              className="w-28"
              inputMode="decimal"
              value={qty[l.id] ?? ''}
              onChange={(e) => setQty({ ...qty, [l.id]: e.target.value })}
            />
          </Field>
        ))}
      <Failure error={save.error} />
      <Button type="submit" className="h-11 self-start" disabled={save.isPending || !locationId}>
        {t('stock.receiving.receive')}
      </Button>
    </form>
  );
}
