import type { OutletShiftItem, PosOrderItem, POS_PAY_METHODS, ShiftItem } from '@hotel/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { z } from 'zod';
import { useSession } from '../app/session.ts';
import { Alert } from '../components/ui/alert.tsx';
import { Button } from '../components/ui/button.tsx';
import { Input } from '../components/ui/input.tsx';
import { Label } from '../components/ui/label.tsx';
import { SignaturePad } from '../components/ui/signature-pad.tsx';
import { api } from '../lib/api.ts';
import { cn } from '../lib/cn.ts';
import { uploadFile } from '../lib/files.ts';
import { errorMessage } from '../lib/form.ts';
import { toMinor } from '../lib/money.ts';
import posStrings from '../i18n/en/pos.json';
import { registerStrings } from '../i18n/index.ts';
import { useOnlineStatus } from '../offline/use-online-status.ts';
import {
  OfflineNotice,
  OfflineOrderPanel,
  QueuedLines,
  useOutletMenu,
  useQueuedPos,
  useRegisterSend,
  useSaved,
} from './pos-offline.tsx';
import { useFormats } from './reservations.tsx';

registerStrings(posStrings);

// S33 Lite POS, the register (PRD M8-02, M8-03, M8-05; T-142). The cashier opens a shift at
// an outlet with a counted float, opens tabs or tables, adds items from the menu, and settles
// by cash, transfer or POS terminal (split if needed) or charges a checked-in room with the
// guest's signature drawn on screen. The shift closes with a blind count per method.
// Items are voided or discounted with a reason (M8-04; T-143); above the cashier's limit a
// manager approves first, and the order changes once they do.
// Offline (M8-08; T-158, pos-offline.tsx): orders, items and kitchen sends wait on the device
// and go when the connection is back; paying waits for it.

type Shift = z.output<typeof OutletShiftItem>;
type Order = z.output<typeof PosOrderItem>;
type Line = Order['lines'][number];

const isPending = (r: unknown) => typeof r === 'object' && r !== null && 'approvalRequestId' in r;
type Method = (typeof POS_PAY_METHODS)[number];
type Closed = z.output<typeof ShiftItem>;

const selectClass = 'h-11 rounded-md border border-border bg-surface px-3 text-sm';

function useRoot() {
  const { currentPropertyId } = useSession();
  return ['pos', currentPropertyId ?? ''];
}

/** A mutation that refreshes the register when it succeeds. */
function useChange<T, R>(fn: (v: T) => Promise<R>, onDone?: (r: R) => void) {
  const root = useRoot();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (r) => {
      onDone?.(r);
      void queryClient.invalidateQueries({ queryKey: root });
    },
  });
}

export function PosPage() {
  const { t } = useTranslation();
  const f = useFormats();
  const root = useRoot();
  const reg = useQuery({
    queryKey: [...root, 'register'],
    queryFn: useSaved('pos-register', () => api.call('getPosRegister', {})),
  });
  const [chosen, setChosen] = useState<string | null>(null);
  const [view, setView] = useState<'orders' | 'close'>('orders');
  const [another, setAnother] = useState(false);
  const data = reg.data;
  const open = (data?.shifts ?? []).filter((s) => s.status === 'OPEN');
  const shift = open.find((s) => s.id === chosen) ?? open[0];
  return (
    <section className="max-w-6xl">
      <h1 className="text-xl font-semibold">{t('pos.register.title')}</h1>
      {reg.error && (
        <Alert tone="critical" className="mt-3">
          {errorMessage(reg.error)}
        </Alert>
      )}
      {(data?.shifts ?? [])
        .filter((s) => s.status === 'CLOSING')
        .map((s) => (
          <Alert key={s.id} tone="info" className="mt-3">
            {t('pos.register.waiting', { outlet: s.outlet })}
          </Alert>
        ))}
      {data && open.length === 0 && (
        <>
          <p className="mt-2 text-sm text-text-muted">{t('pos.register.noShift')}</p>
          <OpenShiftForm outlets={data.outlets} />
        </>
      )}
      {data && shift && (
        <>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {open.map((s) => (
              <Button
                key={s.id}
                variant={s.id === shift.id ? 'primary' : 'secondary'}
                className="h-11"
                onClick={() => setChosen(s.id)}
              >
                {t('pos.register.shiftAt', { outlet: s.outlet })}
              </Button>
            ))}
            <span className="text-sm text-text-muted">
              {t('pos.register.since', { time: f.time(shift.openedAt) })}
            </span>
            <span className="grow" />
            <Button
              variant={view === 'orders' ? 'primary' : 'ghost'}
              className="h-11"
              onClick={() => setView('orders')}
            >
              {t('pos.register.orders')}
            </Button>
            <Button
              variant={view === 'close' ? 'primary' : 'ghost'}
              className="h-11"
              onClick={() => setView('close')}
            >
              {t('pos.register.close')}
            </Button>
          </div>
          {view === 'orders' ? (
            <Register key={shift.outletId} shift={shift} methods={data.methods} />
          ) : (
            <CloseShift
              key={shift.id}
              shift={shift}
              methods={data.methods}
              currency={data.currency}
            />
          )}
          {another ? (
            <OpenShiftForm
              outlets={data.outlets.filter((o) => !open.some((s) => s.outletId === o.id))}
              onDone={() => setAnother(false)}
            />
          ) : (
            <Button variant="ghost" className="mt-4 h-11" onClick={() => setAnother(true)}>
              {t('pos.register.another')}
            </Button>
          )}
        </>
      )}
    </section>
  );
}

function OpenShiftForm({
  outlets,
  onDone,
}: {
  outlets: { id: string; name: string }[];
  onDone?: () => void;
}) {
  const { t } = useTranslation();
  const [outletId, setOutletId] = useState('');
  const [float, setFloat] = useState('');
  const save = useChange(
    () =>
      api.call('openOutletShift', { body: { outletId, floatMinor: toMinor(float || '0') ?? '0' } }),
    onDone,
  );
  return (
    <form
      aria-label={t('pos.register.openShift')}
      className="mt-3 flex flex-wrap items-end gap-3 rounded-md border border-border bg-surface p-3"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate(undefined);
      }}
    >
      <div className="flex flex-col gap-1">
        <Label htmlFor="pos-outlet">{t('pos.register.outlet')}</Label>
        <select
          id="pos-outlet"
          required
          className={selectClass}
          value={outletId}
          onChange={(e) => setOutletId(e.target.value)}
        >
          <option value="">{t('pos.register.choose')}</option>
          {outlets.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="pos-float">{t('pos.register.float')}</Label>
        <Input
          id="pos-float"
          inputMode="decimal"
          value={float}
          onChange={(e) => setFloat(e.target.value)}
        />
      </div>
      <Button type="submit" className="h-11" disabled={save.isPending}>
        {t('pos.register.open')}
      </Button>
      {save.error && <Alert tone="critical">{errorMessage(save.error)}</Alert>}
    </form>
  );
}

// ── Orders ──────────────────────────────────────────────────────────────────────────────

function Register({ shift, methods }: { shift: Shift; methods: Method[] }) {
  const { t } = useTranslation();
  const root = useRoot();
  const [orderId, setOrderId] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const orders = useQuery({
    queryKey: [...root, 'orders', shift.outletId],
    queryFn: useSaved(`pos-orders:${shift.outletId}`, () =>
      api.call('listPosOrders', { query: { outletId: shift.outletId } }),
    ),
  });
  const send = useRegisterSend();
  // The order's ID is chosen here, so items added offline can name it (T-158).
  const start = useMutation({
    mutationFn: async () => {
      const id = crypto.randomUUID();
      await send(
        'openPosOrder',
        { body: { outletId: shift.outletId, label, id } },
        t('pos.offline.openLabel', { label }),
      );
      return id;
    },
    onSuccess: (id) => {
      setOrderId(id);
      setLabel('');
    },
  });
  const queued = useQueuedPos(shift.outletId);
  const list = orders.data?.data ?? [];
  const onDevice = queued.newOrders.filter((o) => !list.some((x) => x.id === o.id));
  const offlineOrder = onDevice.find((o) => o.id === orderId);
  return (
    <div className="mt-4 grid gap-4 md:grid-cols-[16rem_1fr]">
      <div>
        <h2 className="font-semibold">{t('pos.register.openOrders')}</h2>
        <form
          aria-label={t('pos.register.newOrder')}
          className="mt-2 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            start.mutate(undefined);
          }}
        >
          <Input
            aria-label={t('pos.register.label')}
            placeholder={t('pos.register.label')}
            required
            maxLength={40}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
          <Button type="submit" className="h-11" disabled={start.isPending}>
            {t('pos.register.start')}
          </Button>
        </form>
        {start.error && (
          <Alert tone="critical" className="mt-2">
            {errorMessage(start.error)}
          </Alert>
        )}
        {list.length === 0 && onDevice.length === 0 && (
          <p className="mt-2 text-sm text-text-muted">{t('pos.register.noOrders')}</p>
        )}
        <ul aria-label={t('pos.register.openOrders')} className="mt-2 flex flex-col gap-2">
          {list.map((o) => (
            <li key={o.id}>
              <Button
                variant={o.id === orderId ? 'primary' : 'secondary'}
                className="h-11 w-full justify-between"
                onClick={() => setOrderId(o.id)}
              >
                <span>{o.label}</span>
                <span className="text-xs">{o.number}</span>
              </Button>
            </li>
          ))}
          {onDevice.map((o) => (
            <li key={o.id}>
              <Button
                variant={o.id === orderId ? 'primary' : 'secondary'}
                className="h-11 w-full justify-between"
                onClick={() => setOrderId(o.id)}
              >
                <span>{o.label}</span>
                <span className="text-xs">
                  {o.conflict ? t('pos.offline.refusedShort') : t('pos.offline.notSent')}
                </span>
              </Button>
            </li>
          ))}
        </ul>
      </div>
      {offlineOrder ? (
        <OfflineOrderPanel
          key={offlineOrder.id}
          order={offlineOrder}
          menuPanel={<Menu outletId={shift.outletId} orderId={offlineOrder.id} />}
        />
      ) : orderId ? (
        <OrderPanel
          key={orderId}
          orderId={orderId}
          shift={shift}
          methods={methods}
          onClosed={() => setOrderId(null)}
        />
      ) : (
        <p className="text-sm text-text-muted">{t('pos.register.pick')}</p>
      )}
    </div>
  );
}

function OrderPanel({
  orderId,
  shift,
  methods,
  onClosed,
}: {
  orderId: string;
  shift: Shift;
  methods: Method[];
  onClosed: () => void;
}) {
  const { t } = useTranslation();
  const f = useFormats();
  const root = useRoot();
  const { permissions } = useSession();
  const canAdjust = permissions.includes('pos.void');
  const [mode, setMode] = useState<'menu' | 'pay' | 'room' | 'adjust'>('menu');
  const [adjusting, setAdjusting] = useState<Line | null>(null);
  const [pending, setPending] = useState(false);
  const order = useQuery({
    queryKey: [...root, 'order', orderId],
    queryFn: useSaved(`pos-order:${orderId}`, () =>
      api.call('getPosOrder', { params: { orderId } }),
    ),
  });
  const online = useOnlineStatus();
  const queued = useQueuedPos(shift.outletId);
  const waitingLines = queued.linesFor(orderId);
  const menu = useOutletMenu(shift.outletId);
  const send = useRegisterSend();
  const drop = useChange(() => api.call('cancelPosOrder', { params: { orderId } }), onClosed);
  const toKitchen = useMutation({
    mutationFn: (label: string) =>
      send(
        'sendPosOrderToKitchen',
        { params: { orderId } },
        t('pos.offline.kitchenLabel', { label }),
      ),
  });
  const o = order.data;
  if (!o) return null;
  if (o.status !== 'OPEN') return <Settled order={o} onDone={onClosed} />;
  const active = o.lines.filter((l) => !l.voided);
  // Paying, room charges and changes need the connection; items may wait (T-158).
  const live = online && waitingLines.length === 0;
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
      <div>
        {pending && (
          <Alert tone="info" className="mb-3">
            {t('pos.register.sentForApproval')}
          </Alert>
        )}
        {mode === 'menu' && <Menu outletId={shift.outletId} orderId={orderId} />}
        {mode === 'pay' && (
          <PaymentForm order={o} methods={methods} onCancel={() => setMode('menu')} />
        )}
        {mode === 'room' && <RoomCharge order={o} onCancel={() => setMode('menu')} />}
        {mode === 'adjust' && adjusting && (
          <AdjustForm
            key={adjusting.id}
            orderId={orderId}
            line={adjusting}
            onDone={(wasPending) => {
              setPending(wasPending);
              setAdjusting(null);
              setMode('menu');
            }}
          />
        )}
      </div>
      <aside
        aria-label={t('pos.register.order', { number: o.number, label: o.label })}
        className="rounded-md border border-border bg-surface p-3"
      >
        <h2 className="font-semibold">
          {t('pos.register.order', { number: o.number, label: o.label })}
        </h2>
        {o.lines.length === 0 ? (
          <p className="mt-2 text-sm text-text-muted">{t('pos.register.empty')}</p>
        ) : (
          <ul className="mt-2 flex flex-col gap-1 text-sm">
            {o.lines.map((l) => (
              <li key={l.id} className="flex justify-between gap-2">
                <span className={cn(l.voided && 'text-text-muted')}>
                  <span className={cn(l.voided && 'line-through')}>
                    {t('pos.register.qty', { count: l.quantity })} {l.name}
                  </span>
                  {l.note && <span className="block text-xs text-text-muted">{l.note}</span>}
                  {l.kitchen && !l.voided && (
                    <span className="block text-xs text-text-muted">
                      {l.kitchen.sentAt
                        ? t('pos.register.sentKitchen', { station: l.kitchen.station })
                        : t('pos.register.forKitchen', { station: l.kitchen.station })}
                    </span>
                  )}
                  {l.voided && (
                    <span className="block text-xs">
                      {t('pos.register.voidedLine', { by: l.voided.by, reason: l.voided.reason })}
                    </span>
                  )}
                  {l.discount && (
                    <span className="block text-xs text-text-muted">
                      {t('pos.register.discountLine', { reason: l.discount.reason })} −
                      {f.money(l.discount.amountMinor)}
                    </span>
                  )}
                  {canAdjust && live && !l.voided && (
                    <button
                      type="button"
                      className="block text-xs text-accent underline"
                      aria-label={t('pos.register.adjust', { item: l.name })}
                      onClick={() => {
                        setPending(false);
                        setAdjusting(l);
                        setMode('adjust');
                      }}
                    >
                      {t('pos.register.voidIt')} / {t('pos.register.discount')}
                    </button>
                  )}
                </span>
                <span className={cn(l.voided && 'text-text-muted line-through')}>
                  {f.money(l.amountMinor)}
                </span>
              </li>
            ))}
          </ul>
        )}
        <QueuedLines menu={menu.data} lines={waitingLines} />
        <OfflineNotice waiting={waitingLines.length} />
        <dl className="mt-3 grid grid-cols-2 gap-1 border-t border-border pt-2 text-sm">
          {o.discountMinor !== '0' && (
            <>
              <dt>{t('pos.register.discount')}</dt>
              <dd className="text-right">−{f.money(o.discountMinor)}</dd>
            </>
          )}
          <dt>{t('pos.register.subtotal')}</dt>
          <dd className="text-right">{f.money(o.subtotalMinor)}</dd>
          <dt>{t('pos.register.tax')}</dt>
          <dd className="text-right">{f.money(o.taxMinor)}</dd>
          <dt className="font-semibold">{t('pos.register.total')}</dt>
          <dd className="text-right font-semibold">{f.money(o.totalMinor)}</dd>
        </dl>
        <div className="mt-3 flex flex-col gap-2">
          {(o.unsentKitchenLines > 0 || (waitingLines.length > 0 && !online)) &&
            queued.kitchenSendsFor(orderId) === 0 && (
              <Button
                variant="secondary"
                className="h-11"
                disabled={toKitchen.isPending}
                onClick={() => toKitchen.mutate(o.label)}
              >
                {o.unsentKitchenLines > 0
                  ? t('pos.register.sendKitchen', { count: o.unsentKitchenLines })
                  : t('pos.offline.sendKitchen')}
              </Button>
            )}
          <Button
            className="h-11"
            disabled={!live || active.length === 0 || methods.length === 0}
            onClick={() => setMode('pay')}
          >
            {t('pos.register.pay')}
          </Button>
          <Button
            variant="secondary"
            className="h-11"
            disabled={!live || active.length === 0}
            onClick={() => setMode('room')}
          >
            {t('pos.register.room')}
          </Button>
          {active.length === 0 && live && (
            <Button variant="ghost" className="h-11" onClick={() => drop.mutate(undefined)}>
              {t('pos.register.drop')}
            </Button>
          )}
        </div>
        {(drop.error ?? toKitchen.error) && (
          <Alert tone="critical" className="mt-2">
            {errorMessage(drop.error ?? toKitchen.error)}
          </Alert>
        )}
      </aside>
    </div>
  );
}

/** M8-04: void an item or give a discount, with a reason; above the limit it waits (202). */
function AdjustForm({
  orderId,
  line,
  onDone,
}: {
  orderId: string;
  line: Line;
  onDone: (pending: boolean) => void;
}) {
  const { t } = useTranslation();
  const [kind, setKind] = useState<'void' | 'discount'>('void');
  const [byPercent, setByPercent] = useState(true);
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  const amount = byPercent ? null : toMinor(value);
  const percent = byPercent ? Number(value) : NaN;
  const ready =
    reason.trim() !== '' &&
    (kind === 'void' || (byPercent ? percent > 0 && percent <= 100 : amount !== null));
  const params = { orderId, lineId: line.id };
  const change = useChange(
    () =>
      kind === 'void'
        ? api.call('voidPosOrderLine', { params, body: { reason: reason.trim() } })
        : api.call('discountPosOrderLine', {
            params,
            body: {
              ...(byPercent ? { percent } : { amountMinor: amount ?? '0' }),
              reason: reason.trim(),
            },
          }),
    (r) => onDone(isPending(r)),
  );
  return (
    <form
      aria-label={t('pos.register.adjustTitle', { item: line.name })}
      className="flex flex-col gap-3 rounded-md border border-border bg-surface p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) change.mutate(undefined);
      }}
    >
      <h2 className="font-semibold">{t('pos.register.adjustTitle', { item: line.name })}</h2>
      <fieldset className="flex flex-wrap gap-4 text-sm">
        {(['void', 'discount'] as const).map((k) => (
          <label key={k} className="flex items-center gap-2">
            <input
              type="radio"
              name="adjust-kind"
              checked={kind === k}
              onChange={() => setKind(k)}
            />
            {k === 'void' ? t('pos.register.voidIt') : t('pos.register.discountIt')}
          </label>
        ))}
      </fieldset>
      {kind === 'discount' && (
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <Label htmlFor="adjust-by">{t('pos.register.discountBy')}</Label>
            <select
              id="adjust-by"
              className={selectClass}
              value={byPercent ? 'percent' : 'amount'}
              onChange={(e) => setByPercent(e.target.value === 'percent')}
            >
              <option value="percent">{t('pos.register.percent')}</option>
              <option value="amount">{t('pos.register.adjustAmount')}</option>
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="adjust-value">
              {byPercent ? t('pos.register.percent') : t('pos.register.adjustAmount')}
            </Label>
            <Input
              id="adjust-value"
              className="w-32"
              inputMode="decimal"
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          </div>
        </div>
      )}
      <div className="flex flex-col gap-1">
        <Label htmlFor="adjust-reason">{t('pos.register.adjustReason')}</Label>
        <Input
          id="adjust-reason"
          value={reason}
          maxLength={500}
          onChange={(e) => setReason(e.target.value)}
        />
      </div>
      <p className="text-xs text-text-muted">{t('pos.register.adjustHint')}</p>
      <div className="flex gap-2">
        <Button type="submit" className="h-11" disabled={!ready || change.isPending}>
          {kind === 'void' ? t('pos.register.confirmVoid') : t('pos.register.confirmDiscount')}
        </Button>
        <Button variant="ghost" className="h-11" onClick={() => onDone(false)}>
          {t('pos.register.cancel')}
        </Button>
      </div>
      {change.error && <Alert tone="critical">{errorMessage(change.error)}</Alert>}
    </form>
  );
}

function Menu({ outletId, orderId }: { outletId: string; orderId: string }) {
  const { t } = useTranslation();
  const f = useFormats();
  const [picking, setPicking] = useState<string | null>(null);
  const [mods, setMods] = useState<string[]>([]);
  const menu = useOutletMenu(outletId);
  const send = useRegisterSend();
  const nameOf = (id: string) =>
    menu.data?.categories.flatMap((c) => c.items).find((i) => i.id === id)?.name ?? '';
  const add = useMutation({
    mutationFn: (v: { menuItemId: string; modifierIds: string[] }) =>
      send(
        'addPosOrderLine',
        { params: { orderId }, body: v },
        t('pos.offline.addLabel', { item: nameOf(v.menuItemId) }),
      ),
    onSuccess: () => {
      setPicking(null);
      setMods([]);
    },
  });
  const items = (menu.data?.categories ?? []).flatMap((c) => c.items);
  const item = items.find((i) => i.id === picking);
  return (
    <div>
      <h2 className="font-semibold">{t('pos.register.menu')}</h2>
      {add.error && (
        <Alert tone="critical" className="mt-2">
          {errorMessage(add.error)}
        </Alert>
      )}
      {item && (
        <fieldset className="mt-2 rounded-md border border-border bg-surface p-3">
          <legend className="text-sm font-medium">
            {t('pos.register.options', { item: item.name })}
          </legend>
          <div className="flex flex-wrap gap-3">
            {item.modifiers.map((m) => (
              <label key={m.id} className="flex min-h-11 items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="size-5"
                  checked={mods.includes(m.id)}
                  onChange={(e) =>
                    setMods(e.target.checked ? [...mods, m.id] : mods.filter((x) => x !== m.id))
                  }
                />
                {m.name}
                {m.priceMinor !== '0' && ` +${f.money(m.priceMinor)}`}
              </label>
            ))}
          </div>
          <div className="mt-2 flex gap-2">
            <Button
              className="h-11"
              disabled={add.isPending}
              onClick={() => add.mutate({ menuItemId: item.id, modifierIds: mods })}
            >
              {t('pos.register.add')}
            </Button>
            <Button variant="ghost" className="h-11" onClick={() => setPicking(null)}>
              {t('pos.register.cancel')}
            </Button>
          </div>
        </fieldset>
      )}
      {(menu.data?.categories ?? []).map((c) => (
        <section key={c.id} aria-label={c.name} className="mt-3">
          <h3 className="text-sm font-medium text-text-muted">{c.name}</h3>
          <div className="mt-1 grid grid-cols-2 gap-2 sm:grid-cols-3">
            {c.items.map((i) => (
              <Button
                key={i.id}
                variant="secondary"
                className="h-16 flex-col items-start justify-center"
                disabled={add.isPending}
                onClick={() => {
                  if (i.modifiers.length > 0) {
                    setPicking(i.id);
                    setMods([]);
                  } else {
                    add.mutate({ menuItemId: i.id, modifierIds: [] });
                  }
                }}
              >
                <span>{i.name}</span>
                <span className="text-xs text-text-muted">{f.money(i.priceMinor)}</span>
              </Button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

type Row = { method: Method; amount: string; ref: string };

function PaymentForm({
  order,
  methods,
  onCancel,
}: {
  order: Order;
  methods: Method[];
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const f = useFormats();
  const first = methods[0] ?? 'CASH';
  const [rows, setRows] = useState<Row[]>([
    { method: first, amount: (Number(order.totalMinor) / 100).toFixed(2), ref: '' },
  ]);
  const settle = useChange(() =>
    api.call('settlePosOrder', {
      params: { orderId: order.id },
      body: {
        payments: rows.map((r) => ({
          method: r.method,
          amountMinor: toMinor(r.amount) ?? '0',
          externalRef: r.method === 'CASH' ? null : r.ref.trim() || null,
        })),
      },
    }),
  );
  const paid = rows.reduce((s, r) => s + BigInt(toMinor(r.amount) ?? '0'), 0n);
  const left = BigInt(order.totalMinor) - paid;
  const set = (i: number, patch: Partial<Row>) =>
    setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <form
      aria-label={t('pos.register.payments')}
      className="flex flex-col gap-3 rounded-md border border-border bg-surface p-3"
      onSubmit={(e) => {
        e.preventDefault();
        settle.mutate(undefined);
      }}
    >
      <h2 className="font-semibold">{t('pos.register.payments')}</h2>
      {rows.map((r, i) => (
        <div key={i} className="flex flex-wrap items-end gap-2">
          <div className="flex flex-col gap-1">
            <Label htmlFor={`pay-method-${i}`}>{t('pos.register.method')}</Label>
            <select
              id={`pay-method-${i}`}
              className={selectClass}
              value={r.method}
              onChange={(e) => set(i, { method: e.target.value as Method })}
            >
              {methods.map((m) => (
                <option key={m} value={m}>
                  {t(`pos.register.methods.${m}`)}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor={`pay-amount-${i}`}>{t('pos.register.amount')}</Label>
            <Input
              id={`pay-amount-${i}`}
              inputMode="decimal"
              required
              value={r.amount}
              onChange={(e) => set(i, { amount: e.target.value })}
            />
          </div>
          {r.method !== 'CASH' && (
            <div className="flex flex-col gap-1">
              <Label htmlFor={`pay-ref-${i}`}>{t('pos.register.ref')}</Label>
              <Input
                id={`pay-ref-${i}`}
                required
                value={r.ref}
                onChange={(e) => set(i, { ref: e.target.value })}
              />
            </div>
          )}
          {rows.length > 1 && (
            <Button
              variant="ghost"
              className="h-11"
              onClick={() => setRows(rows.filter((_, j) => j !== i))}
            >
              {t('pos.register.remove')}
            </Button>
          )}
        </div>
      ))}
      <p className={cn('text-sm', left !== 0n && 'text-critical')}>
        {left >= 0n
          ? t('pos.register.left', { amount: f.money(left.toString()) })
          : t('pos.register.over', { amount: f.money((-left).toString()) })}
      </p>
      <div className="flex flex-wrap gap-2">
        {rows.length < 3 && (
          <Button
            variant="secondary"
            className="h-11"
            onClick={() =>
              setRows([
                ...rows,
                {
                  method: methods.find((m) => m !== rows.at(-1)?.method) ?? first,
                  amount: left > 0n ? (Number(left) / 100).toFixed(2) : '',
                  ref: '',
                },
              ])
            }
          >
            {t('pos.register.split')}
          </Button>
        )}
        <Button type="submit" className="h-11" disabled={settle.isPending || left !== 0n}>
          {t('pos.register.settle')}
        </Button>
        <Button variant="ghost" className="h-11" onClick={onCancel}>
          {t('pos.register.cancel')}
        </Button>
      </div>
      {settle.error && <Alert tone="critical">{errorMessage(settle.error)}</Alert>}
    </form>
  );
}

function RoomCharge({ order, onCancel }: { order: Order; onCancel: () => void }) {
  const { t } = useTranslation();
  const f = useFormats();
  const root = useRoot();
  const pad = useRef<HTMLCanvasElement | null>(null);
  const [signed, setSigned] = useState(false);
  const [stayId, setStayId] = useState('');
  const rooms = useQuery({
    queryKey: [...root, 'rooms'],
    queryFn: () => api.call('listPosRooms', {}),
  });
  const charge = useChange(async () => {
    const blob = await new Promise<Blob | null>((resolve) => pad.current?.toBlob(resolve));
    if (!blob) throw new Error(t('pos.register.signFirst'));
    const signatureFileId = await uploadFile(
      'PosOrder',
      new File([blob], 'signature.png', { type: 'image/png' }),
    );
    return api.call('chargePosOrderToRoom', {
      params: { orderId: order.id },
      body: { stayId, signatureFileId },
    });
  });
  return (
    <form
      aria-label={t('pos.register.roomTitle')}
      className="flex flex-col gap-3 rounded-md border border-border bg-surface p-3"
      onSubmit={(e) => {
        e.preventDefault();
        charge.mutate(undefined);
      }}
    >
      <h2 className="font-semibold">{t('pos.register.roomTitle')}</h2>
      <div className="flex flex-col gap-1">
        <Label htmlFor="pos-room">{t('pos.register.roomPick')}</Label>
        <select
          id="pos-room"
          required
          className={selectClass}
          value={stayId}
          onChange={(e) => setStayId(e.target.value)}
        >
          <option value="">{t('pos.register.choose')}</option>
          {(rooms.data?.data ?? []).map((r) => (
            <option key={r.stayId} value={r.stayId}>
              {r.roomNumber} · {r.guest}
            </option>
          ))}
        </select>
      </div>
      <fieldset>
        <legend className="text-sm font-medium">{t('pos.register.sign')}</legend>
        <SignaturePad
          canvas={pad}
          onSigned={setSigned}
          label={t('pos.register.pad')}
          clearLabel={t('pos.register.clear')}
        />
      </fieldset>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" className="h-11" disabled={!signed || !stayId || charge.isPending}>
          {t('pos.register.charge', { amount: f.money(order.totalMinor) })}
        </Button>
        <Button variant="ghost" className="h-11" onClick={onCancel}>
          {t('pos.register.cancel')}
        </Button>
      </div>
      {charge.error && <Alert tone="critical">{errorMessage(charge.error)}</Alert>}
    </form>
  );
}

function Settled({ order, onDone }: { order: Order; onDone: () => void }) {
  const { t } = useTranslation();
  const f = useFormats();
  return (
    <div role="status" className="rounded-md border border-border bg-surface p-3">
      <h2 className="font-semibold">
        {t('pos.register.order', { number: order.number, label: order.label })}
      </h2>
      <p className="mt-1">
        {order.status === 'ROOM_CHARGED'
          ? t('pos.register.charged', { room: order.room?.roomNumber ?? '' })
          : t('pos.register.paid')}{' '}
        · {f.money(order.totalMinor)}
      </p>
      <ul className="mt-1 text-sm text-text-muted">
        {order.payments.map((p, i) => (
          <li key={i}>
            {t(`pos.register.methods.${p.method}`)} {f.money(p.amountMinor)}
            {p.externalRef && ` (${p.externalRef})`}
          </li>
        ))}
      </ul>
      <Button className="mt-3 h-11" onClick={onDone}>
        {t('pos.register.newOrder')}
      </Button>
    </div>
  );
}

// ── Shift close (M8-05) ─────────────────────────────────────────────────────────────────

function CloseShift({
  shift,
  methods,
  currency,
}: {
  shift: Shift;
  methods: Method[];
  currency: string;
}) {
  const { t } = useTranslation();
  const counted = (['CASH', ...methods.filter((m) => m !== 'CASH')] as Method[]).filter(
    (m, i, all) => all.indexOf(m) === i,
  );
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const [result, setResult] = useState<Closed | null>(null);
  const close = useChange(
    () =>
      api.call('closeOutletShift', {
        params: { shiftId: shift.id },
        body: {
          counts: counted.map((m) => ({
            method: m,
            currency,
            countedMinor: toMinor(counts[m] || '0') ?? '0',
          })),
          varianceNote: note.trim() || null,
        },
      }),
    setResult,
  );
  if (result) return <CloseResult result={result} />;
  return (
    <form
      aria-label={t('pos.register.counts')}
      className="mt-4 flex max-w-xl flex-col gap-3 rounded-md border border-border bg-surface p-3"
      onSubmit={(e) => {
        e.preventDefault();
        close.mutate(undefined);
      }}
    >
      <h2 className="font-semibold">{t('pos.register.counts')}</h2>
      <p className="text-sm text-text-muted">{t('pos.register.countsIntro')}</p>
      {shift.roomCharges > 0 && (
        <p className="text-sm">{t('pos.register.roomCharges', { count: shift.roomCharges })}</p>
      )}
      {shift.openOrders > 0 && (
        <Alert tone="info">{t('pos.register.openLeft', { count: shift.openOrders })}</Alert>
      )}
      {counted.map((m) => (
        <div key={m} className="flex flex-col gap-1">
          <Label htmlFor={`count-${m}`}>
            {t('pos.register.counted', { method: t(`pos.register.methods.${m}`) })}
          </Label>
          <Input
            id={`count-${m}`}
            inputMode="decimal"
            value={counts[m] ?? ''}
            onChange={(e) => setCounts({ ...counts, [m]: e.target.value })}
          />
        </div>
      ))}
      <div className="flex flex-col gap-1">
        <Label htmlFor="close-note">{t('pos.register.note')}</Label>
        <Input id="close-note" value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      <Button type="submit" className="h-11" disabled={close.isPending}>
        {t('pos.register.closeNow')}
      </Button>
      {close.error && <Alert tone="critical">{errorMessage(close.error)}</Alert>}
    </form>
  );
}

function CloseResult({ result }: { result: Closed }) {
  const { t } = useTranslation();
  const f = useFormats();
  const [reason, setReason] = useState(result.varianceNote ?? '');
  const explain = useChange(() =>
    api.call('addOutletVarianceNote', { params: { shiftId: result.id }, body: { note: reason } }),
  );
  return (
    <div role="status" className="mt-4 max-w-xl rounded-md border border-border bg-surface p-3">
      <h2 className="font-semibold">
        {result.requiresSignOff ? t('pos.register.resultWaiting') : t('pos.register.result')}
      </h2>
      <table className="mt-2 w-full text-sm">
        <thead>
          <tr className="text-left text-text-muted">
            <th>{t('pos.register.method')}</th>
            <th className="text-right">{t('pos.register.expected')}</th>
            <th className="text-right">{t('pos.register.countedCol')}</th>
            <th className="text-right">{t('pos.register.variance')}</th>
          </tr>
        </thead>
        <tbody>
          {result.lines.map((l) => (
            <tr key={`${l.method} ${l.currency}`}>
              <td>{t(`pos.register.methods.${l.method}`, { defaultValue: l.method })}</td>
              <td className="text-right">{f.money(l.expectedMinor)}</td>
              <td className="text-right">{f.money(l.countedMinor ?? '0')}</td>
              <td className="text-right">{f.money(l.varianceMinor ?? '0')}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {result.requiresSignOff && (
        <form
          className="mt-3 flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            explain.mutate(undefined);
          }}
        >
          <div className="flex grow flex-col gap-1">
            <Label htmlFor="variance-reason">{t('pos.register.reason')}</Label>
            <Input
              id="variance-reason"
              required
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          <Button type="submit" className="h-11" disabled={explain.isPending}>
            {t('pos.register.saveReason')}
          </Button>
          {explain.error && <Alert tone="critical">{errorMessage(explain.error)}</Alert>}
        </form>
      )}
    </div>
  );
}
