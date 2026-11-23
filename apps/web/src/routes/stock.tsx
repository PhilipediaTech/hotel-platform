import {
  formatQuantity,
  parseQuantity,
  type RequisitionItem,
  type StockItemRow,
  type StocktakeSummary,
} from '@hotel/shared';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
import { PurchaseOrdersTab, ReceivingTab } from './stock-purchasing.tsx';

registerStrings(stockStrings);

// S42 Inventory (PRD M10-01, M10-02, M10-05; T-145): items with stock on hand, par levels and
// reorder points; adjustments and moves; requisitions issued by the store; blind stocktakes
// whose variances post as adjustments; the movement ledger. Purchase orders and receiving
// join this screen with T-146.

type Item = z.output<typeof StockItemRow>;
type Requisition = z.output<typeof RequisitionItem>;
type Named = { id: string; code: string; name: string; active: boolean };

const selectClass = 'h-11 rounded-md border border-border bg-surface px-3 text-sm';
const card = 'rounded-md border border-border bg-surface p-4';

type Tab = 'items' | 'requisitions' | 'orders' | 'receiving' | 'stocktakes' | 'movements';

function useRoot() {
  const { currentPropertyId } = useSession();
  return ['stock', currentPropertyId ?? ''];
}

/** A mutation that refreshes everything on the screen when it succeeds. */
function useChange<T, R = unknown>(fn: (v: T) => Promise<R>) {
  const root = useRoot();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: root }),
  });
}

/** "1.5" stays "1.5"; anything that isn't a quantity becomes null. */
const quantityOrNull = (text: string) => {
  const q = parseQuantity(text);
  return q === null ? null : formatQuantity(q);
};

function useSetup() {
  const root = useRoot();
  return useQuery({ queryKey: [...root, 'items'], queryFn: () => api.call('listStockItems', {}) });
}

export function StockPage() {
  const { t } = useTranslation();
  const { permissions } = useSession();
  const canManage = permissions.includes('stock.manage');
  const canRequest = permissions.includes('stock.requisition');
  const canCount = permissions.includes('stock.count');
  const canOrder = permissions.includes('po.manage');
  const canReceive = permissions.includes('stock.receive');
  const tabs: Tab[] = [
    ...(canRequest ? (['items', 'requisitions'] as const) : []),
    ...(canOrder ? (['orders'] as const) : []),
    ...(canReceive ? (['receiving'] as const) : []),
    ...(canCount ? (['stocktakes'] as const) : []),
    ...(canManage ? (['movements'] as const) : []),
  ];
  const [tab, setTab] = useState<Tab>(tabs[0] ?? 'items');
  return (
    <section className="max-w-5xl">
      <h1 className="text-xl font-semibold">{t('stock.title')}</h1>
      <p className="mt-1 text-sm text-text-muted">{t('stock.intro')}</p>
      <div role="tablist" className="mt-3 flex flex-wrap gap-2">
        {tabs.map((id) => (
          <Button
            key={id}
            role="tab"
            aria-selected={tab === id}
            variant={tab === id ? 'primary' : 'ghost'}
            className="h-11"
            onClick={() => setTab(id)}
          >
            {t(`stock.tabs.${id}`)}
          </Button>
        ))}
      </div>
      <div className="mt-4">
        {tab === 'items' && canRequest && <ItemsTab canManage={canManage} />}
        {tab === 'requisitions' && canRequest && <RequisitionsTab canManage={canManage} />}
        {tab === 'orders' && canOrder && <PurchaseOrdersTab />}
        {tab === 'receiving' && canReceive && <ReceivingTab />}
        {tab === 'stocktakes' && canCount && <StocktakesTab canManage={canManage} />}
        {tab === 'movements' && canManage && <MovementsTab />}
      </div>
    </section>
  );
}

function Failure({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <Alert tone="critical" className="mt-2">
      {errorMessage(error)}
    </Alert>
  );
}

// ---------------------------------------------------------------------------------------
// Items

function ItemsTab({ canManage }: { canManage: boolean }) {
  const { t } = useTranslation();
  const f = useFormats();
  const setup = useSetup();
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<{ id: string; mode: 'adjust' | 'move' | 'edit' } | null>(null);
  const data = setup.data;
  const locationName = (id: string) => data?.locations.find((l) => l.id === id)?.name ?? '';
  return (
    <div className="flex flex-col gap-3">
      <Failure error={setup.error} />
      {canManage &&
        (adding ? (
          <ItemForm onDone={() => setAdding(false)} />
        ) : (
          <Button className="h-11 self-start" onClick={() => setAdding(true)}>
            {t('stock.items.add')}
          </Button>
        ))}
      {data && data.items.length === 0 && (
        <p className="text-sm text-text-muted">{t('stock.items.none')}</p>
      )}
      <ul aria-label={t('stock.tabs.items')} className="flex flex-col gap-2">
        {data?.items.map((i) => (
          <li key={i.id} className={cn(card, !i.active && 'opacity-60')}>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <p className="font-medium">
                  {i.name} <span className="text-sm text-text-muted">({i.code})</span>
                  {!i.active && (
                    <span className="ml-2 text-sm text-text-muted">{t('stock.common.off')}</span>
                  )}
                </p>
                <p className="text-sm text-text-muted">
                  {[
                    i.category,
                    i.par !== null || i.reorderPoint !== null
                      ? t('stock.items.levels', {
                          par: i.par ?? '–',
                          reorder: i.reorderPoint ?? '–',
                        })
                      : t('stock.items.noLevels'),
                    f.money(i.unitCostMinor),
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
                <p className="text-sm text-text-muted">
                  {i.byLocation
                    .map((b) =>
                      t('stock.items.byLocation', {
                        location: locationName(b.locationId),
                        qty: b.onHand,
                      }),
                    )
                    .join(' · ')}
                </p>
              </div>
              <div className="text-right">
                <p className="text-lg font-semibold">
                  {i.onHand} {i.unit.code}
                </p>
                {i.needsReorder && (
                  <span className="rounded bg-critical-subtle px-2 py-0.5 text-sm text-critical">
                    {t('stock.items.reorderNow')}
                  </span>
                )}
                {i.toPar && (
                  <p className="text-sm text-text-muted">
                    {t('stock.items.toPar', { qty: `${i.toPar} ${i.unit.code}` })}
                  </p>
                )}
              </div>
            </div>
            {canManage && (
              <div className="mt-2 flex flex-wrap gap-2">
                {(['adjust', 'move', 'edit'] as const).map((mode) => (
                  <Button
                    key={mode}
                    variant="secondary"
                    size="sm"
                    aria-label={`${t(`stock.items.${mode}`)}: ${i.name}`}
                    onClick={() =>
                      setOpen(open?.id === i.id && open.mode === mode ? null : { id: i.id, mode })
                    }
                  >
                    {t(`stock.items.${mode}`)}
                  </Button>
                ))}
              </div>
            )}
            {open?.id === i.id && data && (
              <div className="mt-3">
                {open.mode === 'adjust' && (
                  <AdjustForm item={i} locations={data.locations} onDone={() => setOpen(null)} />
                )}
                {open.mode === 'move' && (
                  <MoveForm item={i} locations={data.locations} onDone={() => setOpen(null)} />
                )}
                {open.mode === 'edit' && <ItemForm item={i} onDone={() => setOpen(null)} />}
              </div>
            )}
          </li>
        ))}
      </ul>
      {canManage && data && (
        <div className="grid gap-3 md:grid-cols-2">
          <NamedList kind="units" rows={data.units} />
          <NamedList kind="locations" rows={data.locations} />
        </div>
      )}
    </div>
  );
}

function ItemForm({ item, onDone }: { item?: Item; onDone: () => void }) {
  const { t } = useTranslation();
  const setup = useSetup();
  const [code, setCode] = useState(item?.code ?? '');
  const [name, setName] = useState(item?.name ?? '');
  const [category, setCategory] = useState(item?.category ?? '');
  const [unitId, setUnitId] = useState(item?.unit.id ?? '');
  const [par, setPar] = useState(item?.par ?? '');
  const [reorder, setReorder] = useState(item?.reorderPoint ?? '');
  const [cost, setCost] = useState(item ? (Number(item.unitCostMinor) / 100).toFixed(2) : '');
  const level = (v: string) => (v.trim() === '' ? null : (quantityOrNull(v) ?? v));
  const fields = () => ({
    name,
    category,
    unitId,
    par: level(par),
    reorderPoint: level(reorder),
    unitCostMinor: cost.trim() === '' || Number(cost) === 0 ? '0' : (toMinor(cost) ?? cost),
  });
  const save = useChange(() =>
    item
      ? api.call('updateStockItem', { params: { itemId: item.id }, body: fields() })
      : api.call('createStockItem', { body: { code, ...fields() } }),
  );
  const active = setup.data?.units.filter((u) => u.active || u.id === unitId) ?? [];
  return (
    <form
      aria-label={t('stock.items.form')}
      className={cn(card, 'flex flex-col gap-2')}
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate(undefined, { onSuccess: onDone });
      }}
    >
      <div className="grid gap-2 md:grid-cols-3">
        {!item && (
          <Field id="item-code" label={t('stock.common.code')}>
            <Input id="item-code" value={code} onChange={(e) => setCode(e.target.value)} />
          </Field>
        )}
        <Field id="item-name" label={t('stock.common.name')}>
          <Input id="item-name" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field id="item-category" label={t('stock.items.category')}>
          <Input
            id="item-category"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
          />
        </Field>
        <Field id="item-unit" label={t('stock.common.unit')}>
          <select
            id="item-unit"
            className={selectClass}
            value={unitId}
            onChange={(e) => setUnitId(e.target.value)}
          >
            <option value="">{t('stock.common.choose')}</option>
            {active.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name} ({u.code})
              </option>
            ))}
          </select>
        </Field>
        <Field id="item-par" label={t('stock.items.par')}>
          <Input
            id="item-par"
            inputMode="decimal"
            value={par}
            onChange={(e) => setPar(e.target.value)}
          />
        </Field>
        <Field id="item-reorder" label={t('stock.items.reorder')}>
          <Input
            id="item-reorder"
            inputMode="decimal"
            value={reorder}
            onChange={(e) => setReorder(e.target.value)}
          />
        </Field>
        <Field id="item-cost" label={t('stock.items.cost')}>
          <Input
            id="item-cost"
            inputMode="decimal"
            value={cost}
            onChange={(e) => setCost(e.target.value)}
          />
        </Field>
      </div>
      <Failure error={save.error} />
      <div className="flex gap-2">
        <Button type="submit" className="h-11" disabled={save.isPending}>
          {t('stock.common.save')}
        </Button>
        <Button variant="ghost" className="h-11" onClick={onDone}>
          {t('stock.common.cancel')}
        </Button>
        {item && (
          <Button
            variant="secondary"
            className="h-11"
            onClick={() =>
              void api
                .call('updateStockItem', {
                  params: { itemId: item.id },
                  body: { active: !item.active },
                })
                .then(() => setup.refetch())
                .then(onDone)
            }
          >
            {item.active ? t('stock.common.switchOff') : t('stock.common.switchOn')}
          </Button>
        )}
      </div>
    </form>
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

function LocationSelect({
  id,
  label,
  locations,
  value,
  onChange,
}: {
  id: string;
  label: string;
  locations: Named[];
  value: string;
  onChange: (v: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <Field id={id} label={label}>
      <select
        id={id}
        className={selectClass}
        value={value}
        onChange={(e) => onChange(e.target.value)}
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
  );
}

function AdjustForm({
  item,
  locations,
  onDone,
}: {
  item: Item;
  locations: Named[];
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [locationId, setLocationId] = useState('');
  const [quantity, setQuantity] = useState('');
  const [reason, setReason] = useState('');
  const save = useChange(() =>
    api.call('adjustStock', {
      body: { itemId: item.id, locationId, quantity: quantity.trim(), reason },
    }),
  );
  return (
    <form
      aria-label={t('stock.items.adjustTitle', { item: item.name })}
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate(undefined, { onSuccess: onDone });
      }}
    >
      <p className="text-sm text-text-muted">{t('stock.items.adjustHint')}</p>
      <div className="grid gap-2 md:grid-cols-3">
        <LocationSelect
          id={`adj-loc-${item.id}`}
          label={t('stock.common.location')}
          locations={locations}
          value={locationId}
          onChange={setLocationId}
        />
        <Field
          id={`adj-qty-${item.id}`}
          label={`${t('stock.common.quantity')} (${item.unit.code})`}
        >
          <Input
            id={`adj-qty-${item.id}`}
            inputMode="decimal"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
          />
        </Field>
        <Field id={`adj-reason-${item.id}`} label={t('stock.common.reason')}>
          <Input
            id={`adj-reason-${item.id}`}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </Field>
      </div>
      <Failure error={save.error} />
      <Button
        type="submit"
        className="h-11 self-start"
        disabled={save.isPending || !reason.trim() || !locationId}
      >
        {t('stock.items.adjust')}
      </Button>
    </form>
  );
}

function MoveForm({
  item,
  locations,
  onDone,
}: {
  item: Item;
  locations: Named[];
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [quantity, setQuantity] = useState('');
  const save = useChange(() =>
    api.call('transferStock', {
      body: { itemId: item.id, fromLocationId: from, toLocationId: to, quantity: quantity.trim() },
    }),
  );
  return (
    <form
      aria-label={t('stock.items.moveTitle', { item: item.name })}
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate(undefined, { onSuccess: onDone });
      }}
    >
      <div className="grid gap-2 md:grid-cols-3">
        <LocationSelect
          id={`mv-from-${item.id}`}
          label={t('stock.items.from')}
          locations={locations}
          value={from}
          onChange={setFrom}
        />
        <LocationSelect
          id={`mv-to-${item.id}`}
          label={t('stock.items.to')}
          locations={locations}
          value={to}
          onChange={setTo}
        />
        <Field id={`mv-qty-${item.id}`} label={`${t('stock.common.quantity')} (${item.unit.code})`}>
          <Input
            id={`mv-qty-${item.id}`}
            inputMode="decimal"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
          />
        </Field>
      </div>
      <Failure error={save.error} />
      <Button type="submit" className="h-11 self-start" disabled={save.isPending || !from || !to}>
        {t('stock.items.move')}
      </Button>
    </form>
  );
}

function NamedList({ kind, rows }: { kind: 'units' | 'locations'; rows: Named[] }) {
  const { t } = useTranslation();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const add = useChange(() =>
    kind === 'units'
      ? api.call('createStockUnit', { body: { code, name } })
      : api.call('createStockLocation', { body: { code, name } }),
  );
  const toggle = useChange((row: Named) =>
    kind === 'units'
      ? api.call('updateStockUnit', { params: { unitId: row.id }, body: { active: !row.active } })
      : api.call('updateStockLocation', {
          params: { locationId: row.id },
          body: { active: !row.active },
        }),
  );
  const title = t(`stock.items.${kind}`);
  return (
    <div className={card}>
      <h2 className="font-semibold">{title}</h2>
      <ul aria-label={title} className="mt-2 flex flex-col gap-1">
        {rows.map((r) => (
          <li key={r.id} className="flex items-center justify-between gap-2 text-sm">
            <span className={cn(!r.active && 'text-text-muted line-through')}>
              {r.name} ({r.code})
            </span>
            <Button variant="ghost" size="sm" onClick={() => toggle.mutate(r)}>
              {r.active ? t('stock.common.switchOff') : t('stock.common.switchOn')}
            </Button>
          </li>
        ))}
      </ul>
      <form
        aria-label={kind === 'units' ? t('stock.items.addUnit') : t('stock.items.addLocation')}
        className="mt-2 flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate(undefined, {
            onSuccess: () => {
              setCode('');
              setName('');
            },
          });
        }}
      >
        <Field id={`${kind}-code`} label={t('stock.common.code')}>
          <Input
            id={`${kind}-code`}
            className="w-28"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
        </Field>
        <Field id={`${kind}-name`} label={t('stock.common.name')}>
          <Input id={`${kind}-name`} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Button type="submit" className="h-11" disabled={add.isPending}>
          {kind === 'units' ? t('stock.items.addUnit') : t('stock.items.addLocation')}
        </Button>
      </form>
      <Failure error={add.error ?? toggle.error} />
    </div>
  );
}

// ---------------------------------------------------------------------------------------
// Requisitions

function RequisitionsTab({ canManage }: { canManage: boolean }) {
  const { t } = useTranslation();
  const root = useRoot();
  const [raising, setRaising] = useState(false);
  const list = useQuery({
    queryKey: [...root, 'requisitions'],
    queryFn: () => api.call('listRequisitions', { query: {} }),
  });
  return (
    <div className="flex flex-col gap-3">
      <Failure error={list.error} />
      {raising ? (
        <RequisitionForm
          departments={list.data?.departments ?? []}
          onDone={() => setRaising(false)}
        />
      ) : (
        <Button className="h-11 self-start" onClick={() => setRaising(true)}>
          {t('stock.requisitions.new')}
        </Button>
      )}
      {list.data && list.data.data.length === 0 && (
        <p className="text-sm text-text-muted">{t('stock.requisitions.none')}</p>
      )}
      <ul aria-label={t('stock.tabs.requisitions')} className="flex flex-col gap-2">
        {list.data?.data.map((r) => (
          <RequisitionCard key={r.id} requisition={r} canManage={canManage} />
        ))}
      </ul>
    </div>
  );
}

function RequisitionForm({
  departments,
  onDone,
}: {
  departments: { id: string; code: string; name: string }[];
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const setup = useSetup();
  const [departmentId, setDepartmentId] = useState('');
  const [note, setNote] = useState('');
  const [lines, setLines] = useState([{ itemId: '', quantity: '' }]);
  const save = useChange(() =>
    api.call('createRequisition', {
      body: {
        departmentId,
        note,
        lines: lines
          .filter((l) => l.itemId)
          .map((l) => ({ itemId: l.itemId, quantity: l.quantity.trim() })),
      },
    }),
  );
  const items = setup.data?.items.filter((i) => i.active) ?? [];
  const setLine = (i: number, patch: Partial<(typeof lines)[number]>) =>
    setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  return (
    <form
      aria-label={t('stock.requisitions.new')}
      className={cn(card, 'flex flex-col gap-2')}
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate(undefined, { onSuccess: onDone });
      }}
    >
      <div className="grid gap-2 md:grid-cols-2">
        <Field id="req-dept" label={t('stock.requisitions.department')}>
          <select
            id="req-dept"
            className={selectClass}
            value={departmentId}
            onChange={(e) => setDepartmentId(e.target.value)}
          >
            <option value="">{t('stock.common.choose')}</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </Field>
        <Field id="req-note" label={t('stock.requisitions.note')}>
          <Input id="req-note" value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>
      {lines.map((l, i) => (
        <div key={i} className="flex flex-wrap items-end gap-2">
          <Field id={`req-item-${i}`} label={t('stock.common.item')}>
            <select
              id={`req-item-${i}`}
              className={selectClass}
              value={l.itemId}
              onChange={(e) => setLine(i, { itemId: e.target.value })}
            >
              <option value="">{t('stock.common.choose')}</option>
              {items.map((it) => (
                <option key={it.id} value={it.id}>
                  {it.name} ({it.unit.code})
                </option>
              ))}
            </select>
          </Field>
          <Field id={`req-qty-${i}`} label={t('stock.common.quantity')}>
            <Input
              id={`req-qty-${i}`}
              className="w-28"
              inputMode="decimal"
              value={l.quantity}
              onChange={(e) => setLine(i, { quantity: e.target.value })}
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
        onClick={() => setLines([...lines, { itemId: '', quantity: '' }])}
      >
        {t('stock.requisitions.addLine')}
      </Button>
      <Failure error={save.error} />
      <div className="flex gap-2">
        <Button type="submit" className="h-11" disabled={save.isPending || !departmentId}>
          {t('stock.requisitions.submit')}
        </Button>
        <Button variant="ghost" className="h-11" onClick={onDone}>
          {t('stock.common.cancel')}
        </Button>
      </div>
    </form>
  );
}

const STATUS_TONE: Record<Requisition['status'], string> = {
  SUBMITTED: 'bg-warning-subtle text-warning',
  PARTIAL: 'bg-brand-subtle text-brand-strong',
  ISSUED: 'bg-success-subtle text-success',
  CLOSED: 'bg-surface-sunken text-text-muted',
  CANCELLED: 'bg-surface-sunken text-text-muted',
};

function RequisitionCard({
  requisition: r,
  canManage,
}: {
  requisition: Requisition;
  canManage: boolean;
}) {
  const { t } = useTranslation();
  const f = useFormats();
  const [mode, setMode] = useState<'issue' | 'close' | null>(null);
  const open = r.status === 'SUBMITTED' || r.status === 'PARTIAL';
  const mine = r.mine;
  const withdraw = useChange(() =>
    api.call('cancelRequisition', { params: { requisitionId: r.id } }),
  );
  return (
    <li className={card}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-medium">
            {t('stock.requisitions.title', { number: r.number, department: r.department.name })}
          </p>
          <p className="text-sm text-text-muted">
            {t('stock.requisitions.raisedBy', {
              name: r.requestedBy.name,
              when: f.when(r.createdAt),
            })}
          </p>
          {r.note && <p className="text-sm">{r.note}</p>}
        </div>
        <span className={cn('rounded px-2 py-0.5 text-sm', STATUS_TONE[r.status])}>
          {t(`stock.requisitions.status.${r.status}`)}
        </span>
      </div>
      <ul className="mt-2 text-sm">
        {r.lines.map((l) => (
          <li key={l.id}>
            {t('stock.requisitions.line', {
              item: l.item.name,
              issued: l.issued,
              quantity: l.quantity,
              unit: l.item.unit,
            })}
          </li>
        ))}
      </ul>
      {r.closeReason && r.closedBy && (
        <p className="mt-1 text-sm text-text-muted">
          {t('stock.requisitions.closed', { name: r.closedBy.name, reason: r.closeReason })}
        </p>
      )}
      {open && (
        <div className="mt-2 flex flex-wrap gap-2">
          {canManage && !mine && (
            <Button variant="secondary" size="sm" onClick={() => setMode('issue')}>
              {t('stock.requisitions.issue')}
            </Button>
          )}
          {canManage && (
            <Button variant="secondary" size="sm" onClick={() => setMode('close')}>
              {t('stock.requisitions.close')}
            </Button>
          )}
          {mine && r.status === 'SUBMITTED' && (
            <Button variant="ghost" size="sm" onClick={() => withdraw.mutate(undefined)}>
              {t('stock.requisitions.withdraw')}
            </Button>
          )}
        </div>
      )}
      {open && canManage && mine && (
        <p className="mt-1 text-sm text-text-muted">{t('stock.requisitions.ownIssue')}</p>
      )}
      <Failure error={withdraw.error} />
      {mode === 'issue' && <IssueForm requisition={r} onDone={() => setMode(null)} />}
      {mode === 'close' && <CloseForm requisition={r} onDone={() => setMode(null)} />}
    </li>
  );
}

function IssueForm({ requisition: r, onDone }: { requisition: Requisition; onDone: () => void }) {
  const { t } = useTranslation();
  const setup = useSetup();
  const [locationId, setLocationId] = useState('');
  const [qty, setQty] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      r.lines.map((l) => {
        const left = (parseQuantity(l.quantity) ?? 0n) - (parseQuantity(l.issued) ?? 0n);
        return [l.id, left > 0n ? formatQuantity(left) : ''];
      }),
    ),
  );
  const save = useChange(() =>
    api.call('issueRequisition', {
      params: { requisitionId: r.id },
      body: {
        locationId,
        lines: Object.entries(qty)
          .filter(([, v]) => v.trim() !== '' && (parseQuantity(v) ?? 0n) > 0n)
          .map(([lineId, v]) => ({ lineId, quantity: v.trim() })),
      },
    }),
  );
  return (
    <form
      aria-label={t('stock.requisitions.issueTitle', { number: r.number })}
      className="mt-3 flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate(undefined, { onSuccess: onDone });
      }}
    >
      <LocationSelect
        id={`issue-loc-${r.id}`}
        label={t('stock.requisitions.issueFrom')}
        locations={setup.data?.locations ?? []}
        value={locationId}
        onChange={setLocationId}
      />
      {r.lines.map((l) => (
        <Field
          key={l.id}
          id={`issue-${l.id}`}
          label={`${t('stock.requisitions.issueQty', { item: l.item.name })} (${l.item.unit})`}
        >
          <Input
            id={`issue-${l.id}`}
            className="w-28"
            inputMode="decimal"
            value={qty[l.id] ?? ''}
            onChange={(e) => setQty({ ...qty, [l.id]: e.target.value })}
          />
        </Field>
      ))}
      <Failure error={save.error} />
      <div className="flex gap-2">
        <Button type="submit" className="h-11" disabled={save.isPending || !locationId}>
          {t('stock.requisitions.confirmIssue')}
        </Button>
        <Button variant="ghost" className="h-11" onClick={onDone}>
          {t('stock.common.cancel')}
        </Button>
      </div>
    </form>
  );
}

function CloseForm({ requisition: r, onDone }: { requisition: Requisition; onDone: () => void }) {
  const { t } = useTranslation();
  const [reason, setReason] = useState('');
  const save = useChange(() =>
    api.call('closeRequisition', { params: { requisitionId: r.id }, body: { reason } }),
  );
  return (
    <form
      aria-label={t('stock.requisitions.closeTitle', { number: r.number })}
      className="mt-3 flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate(undefined, { onSuccess: onDone });
      }}
    >
      <Field id={`close-${r.id}`} label={t('stock.common.reason')}>
        <Input id={`close-${r.id}`} value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
      <Button type="submit" className="h-11" disabled={save.isPending || !reason.trim()}>
        {t('stock.requisitions.confirmClose')}
      </Button>
      <Button variant="ghost" className="h-11" onClick={onDone}>
        {t('stock.common.cancel')}
      </Button>
      <Failure error={save.error} />
    </form>
  );
}

// ---------------------------------------------------------------------------------------
// Stocktakes

function StocktakesTab({ canManage }: { canManage: boolean }) {
  const { t } = useTranslation();
  const f = useFormats();
  const root = useRoot();
  const setup = useSetup();
  const [locationId, setLocationId] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const list = useQuery({
    queryKey: [...root, 'stocktakes'],
    queryFn: () => api.call('listStocktakes', {}),
  });
  const start = useChange(() => api.call('startStocktake', { body: { locationId } }));
  return (
    <div className="flex flex-col gap-3">
      <Failure error={list.error} />
      <form
        aria-label={t('stock.stocktakes.start')}
        className={cn(card, 'flex flex-wrap items-end gap-2')}
        onSubmit={(e) => {
          e.preventDefault();
          start.mutate(undefined, { onSuccess: (s) => setOpenId(s.id) });
        }}
      >
        <LocationSelect
          id="stocktake-location"
          label={t('stock.common.location')}
          locations={setup.data?.locations ?? []}
          value={locationId}
          onChange={setLocationId}
        />
        <Button type="submit" className="h-11" disabled={start.isPending || !locationId}>
          {t('stock.stocktakes.startNow')}
        </Button>
        <Failure error={start.error} />
      </form>
      {list.data && list.data.data.length === 0 && (
        <p className="text-sm text-text-muted">{t('stock.stocktakes.none')}</p>
      )}
      <ul aria-label={t('stock.tabs.stocktakes')} className="flex flex-col gap-2">
        {list.data?.data.map((s) => (
          <li key={s.id} className={card}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="font-medium">
                  {t('stock.stocktakes.title', { number: s.number, location: s.location.name })}
                </p>
                <p className="text-sm text-text-muted">
                  {t(`stock.stocktakes.status.${s.status}`)} · {f.when(s.startedAt)} ·{' '}
                  {t('stock.stocktakes.progress', { counted: s.counted, total: s.lineCount })}
                  {s.varianceMinor !== null &&
                    ` · ${t('stock.stocktakes.total', { value: f.money(s.varianceMinor) })}`}
                </p>
              </div>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setOpenId(openId === s.id ? null : s.id)}
              >
                {t('stock.stocktakes.open')}
              </Button>
            </div>
            {openId === s.id && <StocktakeView summary={s} canManage={canManage} />}
          </li>
        ))}
      </ul>
    </div>
  );
}

function StocktakeView({
  summary,
  canManage,
}: {
  summary: z.output<typeof StocktakeSummary>;
  canManage: boolean;
}) {
  const { t } = useTranslation();
  const f = useFormats();
  const root = useRoot();
  const detail = useQuery({
    queryKey: [...root, 'stocktake', summary.id, summary.status, summary.counted],
    queryFn: () => api.call('getStocktake', { params: { stocktakeId: summary.id } }),
  });
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [reason, setReason] = useState('');
  const params = { stocktakeId: summary.id };
  const saveCounts = useChange(() =>
    api.call('recordStocktakeCounts', {
      params,
      body: {
        counts: Object.entries(counts).map(([itemId, v]) => ({
          itemId,
          counted: v.trim() === '' ? null : v.trim(),
        })),
      },
    }),
  );
  const post = useChange(() => api.call('postStocktake', { params, body: { reason } }));
  const abandon = useChange(() => api.call('cancelStocktake', { params }));
  const s = detail.data;
  if (!s) return <Failure error={detail.error} />;
  if (s.status !== 'COUNTING') {
    return (
      <table className="mt-3 w-full text-sm">
        <thead>
          <tr className="text-left text-text-muted">
            <th className="py-1">{t('stock.common.item')}</th>
            <th>{t('stock.stocktakes.counted')}</th>
            <th>{t('stock.stocktakes.expected')}</th>
            <th>{t('stock.stocktakes.variance')}</th>
            <th>{t('stock.stocktakes.value')}</th>
          </tr>
        </thead>
        <tbody>
          {s.lines.map((l) => (
            <tr key={l.item.id} className="border-t border-border">
              <td className="py-1">{l.item.name}</td>
              <td>{l.counted ?? t('stock.stocktakes.notCounted')}</td>
              <td>{l.expected ?? '–'}</td>
              <td className={cn(l.variance?.startsWith('-') && 'text-critical')}>
                {l.variance ?? '–'}
              </td>
              <td>{l.varianceMinor === null ? '–' : f.money(l.varianceMinor)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  return (
    <div className="mt-3 flex flex-col gap-2">
      <p className="text-sm text-text-muted">{t('stock.stocktakes.blind')}</p>
      <form
        aria-label={t('stock.stocktakes.saveCounts')}
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          saveCounts.mutate(undefined, { onSuccess: () => setCounts({}) });
        }}
      >
        {s.lines.map((l) => (
          <Field
            key={l.item.id}
            id={`count-${l.item.id}`}
            label={`${l.item.name} (${l.item.unit})`}
          >
            <Input
              id={`count-${l.item.id}`}
              className="w-32"
              inputMode="decimal"
              value={counts[l.item.id] ?? l.counted ?? ''}
              onChange={(e) => setCounts({ ...counts, [l.item.id]: e.target.value })}
            />
          </Field>
        ))}
        <Failure error={saveCounts.error} />
        <Button
          type="submit"
          className="h-11 self-start"
          disabled={saveCounts.isPending || Object.keys(counts).length === 0}
        >
          {t('stock.stocktakes.saveCounts')}
        </Button>
      </form>
      {canManage && (
        <form
          aria-label={t('stock.stocktakes.post')}
          className="flex flex-col gap-2 border-t border-border pt-2"
          onSubmit={(e) => {
            e.preventDefault();
            post.mutate(undefined);
          }}
        >
          <p className="text-sm text-text-muted">{t('stock.stocktakes.postHint')}</p>
          <Field id={`post-${s.id}`} label={t('stock.stocktakes.postReason')}>
            <Input id={`post-${s.id}`} value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
          <Failure error={post.error} />
          <div className="flex gap-2">
            <Button
              type="submit"
              className="h-11"
              disabled={post.isPending || Object.keys(counts).length > 0}
            >
              {t('stock.stocktakes.post')}
            </Button>
            <Button variant="ghost" className="h-11" onClick={() => abandon.mutate(undefined)}>
              {t('stock.stocktakes.abandon')}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------
// Movements

function MovementsTab() {
  const { t } = useTranslation();
  const f = useFormats();
  const root = useRoot();
  const ledger = useInfiniteQuery({
    queryKey: [...root, 'movements'],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api.call('listStockMovements', {
        query: { limit: 50, ...(pageParam ? { cursor: pageParam } : {}) },
      }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = ledger.data?.pages.flatMap((p) => p.data) ?? [];
  return (
    <div className="flex flex-col gap-2">
      <Failure error={ledger.error} />
      {ledger.data && rows.length === 0 && (
        <p className="text-sm text-text-muted">{t('stock.movements.none')}</p>
      )}
      <ul aria-label={t('stock.tabs.movements')} className="flex flex-col gap-1">
        {rows.map((m) => (
          <li key={m.id} className="rounded border border-border bg-surface px-3 py-2 text-sm">
            <div className="flex flex-wrap justify-between gap-2">
              <span>
                <span className="font-medium">{t(`stock.movements.kind.${m.kind}`)}</span> ·{' '}
                {m.item.name} · {m.location.name}
              </span>
              <span className={cn('font-medium', m.quantity.startsWith('-') && 'text-critical')}>
                {m.quantity.startsWith('-') ? m.quantity : `+${m.quantity}`} {m.item.unit}
              </span>
            </div>
            <p className="text-text-muted">
              {[
                f.when(m.at),
                t('stock.common.by', { name: m.by.name }),
                m.requisitionNumber !== null &&
                  t('stock.movements.requisition', { number: m.requisitionNumber }),
                m.receiptNumber !== null &&
                  t('stock.movements.receipt', { number: m.receiptNumber }),
                m.requestedBy &&
                  m.approvedBy &&
                  t('stock.movements.issuedTo', {
                    requester: m.requestedBy.name,
                    approver: m.approvedBy.name,
                  }),
                m.reason,
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
          </li>
        ))}
      </ul>
      {ledger.hasNextPage && (
        <Button
          variant="secondary"
          className="h-11 self-start"
          onClick={() => void ledger.fetchNextPage()}
        >
          {t('stock.movements.more')}
        </Button>
      )}
    </div>
  );
}
