import type { OutletItem } from '@hotel/shared';
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
import posStrings from '../i18n/en/pos.json';
import { registerStrings } from '../i18n/index.ts';
import { useFormats } from './reservations.tsx';

registerStrings(posStrings);

// S33 Lite POS, setup (PRD M8-01; T-141): outlets, their menu sections, items with prices and
// revenue codes, and options. Entries are switched off, never deleted, so past orders keep them.

type Outlet = z.output<typeof OutletItem>;
type Item = Outlet['categories'][number]['items'][number];
type Code = { id: string; code: string; name: string; group: string };

const selectClass = 'h-11 rounded-md border border-border bg-surface px-3 text-sm';

function useRoot() {
  const { currentPropertyId } = useSession();
  return ['pos-setup', currentPropertyId ?? ''];
}

/** A mutation that refreshes the setup when it succeeds. */
function useChange<T>(fn: (v: T) => Promise<unknown>) {
  const root = useRoot();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: root }),
  });
}

export function PosSetupPage() {
  const { t } = useTranslation();
  const root = useRoot();
  const [adding, setAdding] = useState(false);
  const setup = useQuery({ queryKey: root, queryFn: () => api.call('listOutlets', {}) });
  const data = setup.data;
  return (
    <section className="max-w-5xl">
      <h1 className="text-xl font-semibold">{t('pos.setup.title')}</h1>
      {data && (
        <p className="mt-1 text-sm text-text-muted">
          {t('pos.setup.intro', { currency: data.currency })}
        </p>
      )}
      {setup.error && (
        <Alert tone="critical" className="mt-3">
          {errorMessage(setup.error)}
        </Alert>
      )}
      {adding ? (
        <OutletForm onDone={() => setAdding(false)} />
      ) : (
        <Button className="mt-3 h-11" onClick={() => setAdding(true)}>
          {t('pos.setup.addOutlet')}
        </Button>
      )}
      {data && data.data.length === 0 && (
        <p className="mt-3 text-sm text-text-muted">{t('pos.setup.none')}</p>
      )}
      <ul aria-label={t('pos.setup.outlets')} className="mt-3 flex flex-col gap-4">
        {data?.data.map((o) => (
          <OutletCard key={o.id} outlet={o} codes={data.revenueCodes} />
        ))}
      </ul>
    </section>
  );
}

function OutletForm({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const save = useChange(() => api.call('createOutlet', { body: { code, name } }));
  return (
    <form
      aria-label={t('pos.setup.outletForm')}
      className="mt-3 flex flex-wrap items-end gap-3 rounded-md border border-border bg-surface p-3"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate(undefined, { onSuccess: onDone });
      }}
    >
      <div className="flex flex-col gap-1">
        <Label htmlFor="outlet-code">{t('pos.setup.code')}</Label>
        <Input id="outlet-code" required value={code} onChange={(e) => setCode(e.target.value)} />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="outlet-name">{t('pos.setup.name')}</Label>
        <Input id="outlet-name" required value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <Button type="submit" className="h-11" disabled={save.isPending}>
        {t('pos.setup.save')}
      </Button>
      <Button type="button" variant="ghost" className="h-11" onClick={onDone}>
        {t('pos.setup.cancel')}
      </Button>
      {save.error && <Alert tone="critical">{errorMessage(save.error)}</Alert>}
    </form>
  );
}

function OutletCard({ outlet, codes }: { outlet: Outlet; codes: Code[] }) {
  const { t } = useTranslation();
  const [section, setSection] = useState('');
  const toggle = useChange(() =>
    api.call('updateOutlet', { params: { outletId: outlet.id }, body: { active: !outlet.active } }),
  );
  const addSection = useChange(() =>
    api.call('addMenuCategory', { params: { outletId: outlet.id }, body: { name: section } }),
  );
  const error = toggle.error ?? addSection.error;
  return (
    <li
      aria-label={outlet.name}
      className={cn(
        'rounded-md border border-border bg-surface p-4',
        !outlet.active && 'opacity-70',
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">
          {outlet.code} · {outlet.name}
          {!outlet.active && (
            <span className="ml-2 text-sm font-normal text-text-muted">{t('pos.setup.off')}</span>
          )}
        </h2>
        <Button variant="secondary" disabled={toggle.isPending} onClick={() => toggle.mutate()}>
          {outlet.active ? t('pos.setup.switchOff') : t('pos.setup.switchOn')}
        </Button>
      </div>
      {error && (
        <Alert tone="critical" className="mt-2">
          {errorMessage(error)}
        </Alert>
      )}
      {outlet.categories.map((c) => (
        <Section key={c.id} category={c} codes={codes} />
      ))}
      <form
        aria-label={t('pos.setup.categoryForm')}
        className="mt-3 flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          addSection.mutate(undefined, { onSuccess: () => setSection('') });
        }}
      >
        <div className="flex flex-col gap-1">
          <Label htmlFor={`cat-${outlet.id}`}>{t('pos.setup.categoryName')}</Label>
          <Input
            id={`cat-${outlet.id}`}
            required
            value={section}
            onChange={(e) => setSection(e.target.value)}
          />
        </div>
        <Button type="submit" variant="secondary" className="h-11" disabled={addSection.isPending}>
          {t('pos.setup.addCategory')}
        </Button>
      </form>
    </li>
  );
}

function Section({ category, codes }: { category: Outlet['categories'][number]; codes: Code[] }) {
  const { t } = useTranslation();
  const [adding, setAdding] = useState(false);
  const toggle = useChange(() =>
    api.call('updateMenuCategory', {
      params: { categoryId: category.id },
      body: { active: !category.active },
    }),
  );
  return (
    <section aria-label={category.name} className="mt-4 border-t border-border pt-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className={cn('font-medium', !category.active && 'text-text-muted')}>
          {category.name}
          {!category.active && ` (${t('pos.setup.off')})`}
        </h3>
        <div className="flex gap-2">
          {!adding && (
            <Button size="sm" variant="secondary" onClick={() => setAdding(true)}>
              {t('pos.setup.addItem')}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => toggle.mutate()}>
            {category.active ? t('pos.setup.switchOff') : t('pos.setup.switchOn')}
          </Button>
        </div>
      </div>
      {adding && (
        <ItemForm categoryId={category.id} codes={codes} onDone={() => setAdding(false)} />
      )}
      <ul className="mt-2 flex flex-col gap-2 text-sm">
        {category.items.map((i) => (
          <ItemLine key={i.id} item={i} />
        ))}
      </ul>
    </section>
  );
}

function ItemForm(props: { categoryId: string; codes: Code[]; onDone: () => void }) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [revenueCodeId, setRevenueCodeId] = useState(
    props.codes.find((c) => c.group === 'FNB')?.id ?? '',
  );
  const save = useChange(() =>
    api.call('addMenuItem', {
      params: { categoryId: props.categoryId },
      body: { name, priceMinor: toMinor(price) ?? '0', revenueCodeId },
    }),
  );
  return (
    <form
      aria-label={t('pos.setup.itemForm')}
      className="mt-2 flex flex-wrap items-end gap-2 rounded-md border border-border p-3"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate(undefined, { onSuccess: props.onDone });
      }}
    >
      <div className="flex flex-col gap-1">
        <Label htmlFor={`item-name-${props.categoryId}`}>{t('pos.setup.itemName')}</Label>
        <Input
          id={`item-name-${props.categoryId}`}
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor={`item-price-${props.categoryId}`}>{t('pos.setup.price')}</Label>
        <Input
          id={`item-price-${props.categoryId}`}
          inputMode="decimal"
          required
          className="w-32"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor={`item-code-${props.categoryId}`}>{t('pos.setup.revenueCode')}</Label>
        <select
          id={`item-code-${props.categoryId}`}
          className={selectClass}
          required
          value={revenueCodeId}
          onChange={(e) => setRevenueCodeId(e.target.value)}
        >
          <option value="">{t('pos.setup.choose')}</option>
          {props.codes.map((c) => (
            <option key={c.id} value={c.id}>
              {c.code} · {c.name}
            </option>
          ))}
        </select>
      </div>
      <Button type="submit" className="h-11" disabled={save.isPending}>
        {t('pos.setup.save')}
      </Button>
      <Button type="button" variant="ghost" className="h-11" onClick={props.onDone}>
        {t('pos.setup.cancel')}
      </Button>
      {save.error && <Alert tone="critical">{errorMessage(save.error)}</Alert>}
    </form>
  );
}

function ItemLine({ item }: { item: Item }) {
  const { t } = useTranslation();
  const f = useFormats();
  const [price, setPrice] = useState('');
  const [option, setOption] = useState('');
  const [optionPrice, setOptionPrice] = useState('');
  const reprice = useChange(() =>
    api.call('updateMenuItem', {
      params: { itemId: item.id },
      body: { priceMinor: toMinor(price) ?? '0' },
    }),
  );
  const toggle = useChange(() =>
    api.call('updateMenuItem', { params: { itemId: item.id }, body: { active: !item.active } }),
  );
  const addOption = useChange(() =>
    api.call('addMenuModifier', {
      params: { itemId: item.id },
      body: { name: option, priceMinor: optionPrice.trim() ? (toMinor(optionPrice) ?? '0') : '0' },
    }),
  );
  const error = reprice.error ?? toggle.error ?? addOption.error;
  return (
    <li className={cn('rounded-md border border-border p-2', !item.active && 'opacity-70')}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">
          {item.name} · {f.money(item.priceMinor)}
          <span className="ml-2 font-normal text-text-muted">{item.revenueCode.code}</span>
          {!item.active && ` (${t('pos.setup.off')})`}
        </span>
        <div className="flex flex-wrap items-end gap-2">
          <Input
            aria-label={t('pos.setup.newPrice')}
            inputMode="decimal"
            className="h-9 w-28"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
          />
          <Button
            size="sm"
            variant="secondary"
            disabled={!price || reprice.isPending}
            onClick={() => reprice.mutate(undefined, { onSuccess: () => setPrice('') })}
          >
            {t('pos.setup.changePrice')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => toggle.mutate()}>
            {item.active ? t('pos.setup.switchOff') : t('pos.setup.switchOn')}
          </Button>
        </div>
      </div>
      <p className="mt-1 text-text-muted">
        {t('pos.setup.options')}:{' '}
        {item.modifiers.length === 0
          ? '—'
          : item.modifiers
              .map(
                (m) =>
                  `${m.name} (${m.priceMinor === '0' ? t('pos.setup.free') : `+${f.money(m.priceMinor)}`})`,
              )
              .join(', ')}
      </p>
      <form
        className="mt-1 flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          addOption.mutate(undefined, {
            onSuccess: () => {
              setOption('');
              setOptionPrice('');
            },
          });
        }}
      >
        <Input
          aria-label={t('pos.setup.optionName')}
          placeholder={t('pos.setup.optionName')}
          className="h-9 w-40"
          required
          value={option}
          onChange={(e) => setOption(e.target.value)}
        />
        <Input
          aria-label={t('pos.setup.optionPrice')}
          placeholder={t('pos.setup.optionPrice')}
          inputMode="decimal"
          className="h-9 w-40"
          value={optionPrice}
          onChange={(e) => setOptionPrice(e.target.value)}
        />
        <Button type="submit" size="sm" variant="ghost" disabled={addOption.isPending}>
          {t('pos.setup.addOption')}
        </Button>
      </form>
      {error && <Alert tone="critical">{errorMessage(error)}</Alert>}
    </li>
  );
}
