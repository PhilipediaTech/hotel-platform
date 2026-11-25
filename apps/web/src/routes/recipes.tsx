import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSession } from '../app/session.ts';
import { Alert } from '../components/ui/alert.tsx';
import { Button } from '../components/ui/button.tsx';
import { Input } from '../components/ui/input.tsx';
import { Label } from '../components/ui/label.tsx';
import { api } from '../lib/api.ts';
import { errorMessage } from '../lib/form.ts';
import recipeStrings from '../i18n/en/recipes.json';
import { registerStrings } from '../i18n/index.ts';
import { useFormats } from './reservations.tsx';

registerStrings(recipeStrings);

// Recipes (PRD M8-07; T-157; with S33 Outlets and menus): what one of each menu item uses from
// stock, what that costs against its price, and where each outlet's sales take stock from.

const card = 'rounded-md border border-border bg-surface p-4';

type Book = Awaited<ReturnType<typeof getBook>>;
type Outlet = Book['outlets'][number];
type Item = Outlet['items'][number];
const getBook = () => api.call('getRecipeBook', {});

export function RecipesPage() {
  const { t } = useTranslation();
  const { currentPropertyId } = useSession();
  const key = ['recipes', currentPropertyId ?? ''];
  const book = useQuery({ queryKey: key, queryFn: getBook });
  const queryClient = useQueryClient();
  const saved = (b: Book) => queryClient.setQueryData(key, b);
  const data = book.data;
  return (
    <section className="max-w-4xl">
      <h1 className="text-xl font-semibold">{t('recipes.title')}</h1>
      <p className="mt-1 text-sm text-text-muted">{t('recipes.intro')}</p>
      {book.error && (
        <Alert tone="critical" className="mt-3">
          {errorMessage(book.error)}
        </Alert>
      )}
      {data && data.outlets.length === 0 && (
        <p className="mt-3 text-sm text-text-muted">{t('recipes.noOutlets')}</p>
      )}
      {data && data.stockItems.length === 0 && data.outlets.length > 0 && (
        <Alert tone="info" className="mt-3">
          {t('recipes.noStock')}
        </Alert>
      )}
      <div className="mt-4 flex flex-col gap-4">
        {data?.outlets.map((o) => (
          <OutletRecipes key={o.id} outlet={o} book={data} onSaved={saved} />
        ))}
      </div>
    </section>
  );
}

function OutletRecipes({
  outlet,
  book,
  onSaved,
}: {
  outlet: Outlet;
  book: Book;
  onSaved: (b: Book) => void;
}) {
  const { t } = useTranslation();
  const [location, setLocation] = useState<string | null>(null);
  const chosen = location ?? outlet.stockLocation?.id ?? '';
  const save = useMutation({
    mutationFn: () =>
      api.call('setOutletStockLocation', {
        params: { outletId: outlet.id },
        body: { stockLocationId: chosen || null },
      }),
    onSuccess: (b) => {
      setLocation(null);
      onSaved(b);
    },
  });
  return (
    <section aria-label={outlet.name} className={card}>
      <h2 className="font-semibold">{outlet.name}</h2>
      <form
        className="mt-2 flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <div className="flex flex-col gap-1">
          <Label htmlFor={`loc-${outlet.id}`}>{t('recipes.location')}</Label>
          <select
            id={`loc-${outlet.id}`}
            className="h-11 rounded-md border border-border bg-surface px-2 text-sm"
            value={chosen}
            onChange={(e) => setLocation(e.target.value)}
          >
            <option value="">{t('recipes.noLocation')}</option>
            {book.locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </div>
        <Button
          type="submit"
          variant="secondary"
          className="h-11"
          disabled={location === null || save.isPending}
        >
          {t('recipes.saveLocation')}
        </Button>
      </form>
      {!outlet.stockLocation && (
        <p className="mt-1 text-sm text-warning">{t('recipes.noLocationHint')}</p>
      )}
      {save.error && (
        <Alert tone="critical" className="mt-2">
          {errorMessage(save.error)}
        </Alert>
      )}
      <ul aria-label={t('recipes.items', { outlet: outlet.name })} className="mt-3 flex flex-col">
        {outlet.items.map((i) => (
          <ItemRecipe key={i.menuItemId} item={i} book={book} onSaved={onSaved} />
        ))}
      </ul>
    </section>
  );
}

function ItemRecipe({
  item,
  book,
  onSaved,
}: {
  item: Item;
  book: Book;
  onSaved: (b: Book) => void;
}) {
  const { t } = useTranslation();
  const f = useFormats();
  const [rows, setRows] = useState<{ stockItemId: string; quantity: string }[] | null>(null);
  const save = useMutation({
    mutationFn: () =>
      api.call('setRecipe', {
        params: { menuItemId: item.menuItemId },
        body: { lines: (rows ?? []).filter((r) => r.stockItemId && r.quantity.trim()) },
      }),
    onSuccess: (b) => {
      setRows(null);
      onSaved(b);
    },
  });
  const r = item.recipe;
  const unitOf = (id: string) => book.stockItems.find((s) => s.id === id)?.unit ?? '';
  return (
    <li className="border-t border-border py-3 first:border-t-0">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p>
          <span className="font-medium">{item.name}</span>{' '}
          <span className="text-sm text-text-muted">
            {item.category} · {f.money(item.priceMinor)}
          </span>
        </p>
        {rows === null && (
          <Button
            size="sm"
            variant="secondary"
            disabled={book.stockItems.length === 0}
            onClick={() =>
              setRows(
                r
                  ? r.lines.map((l) => ({ stockItemId: l.stockItemId, quantity: l.quantity }))
                  : [{ stockItemId: '', quantity: '' }],
              )
            }
          >
            {r ? t('recipes.edit') : t('recipes.add')}
          </Button>
        )}
      </div>
      {rows === null && r && (
        <p className="mt-1 text-sm">
          {r.lines.map((l) => `${l.quantity} ${l.unit} ${l.name}`).join(' · ')}
          <span className="block text-text-muted">
            {r.costBps !== null
              ? t('recipes.cost', {
                  cost: f.money(r.costMinor),
                  share: (r.costBps / 100).toFixed(1),
                })
              : t('recipes.costOnly', { cost: f.money(r.costMinor) })}
          </span>
        </p>
      )}
      {rows === null && !r && <p className="mt-1 text-sm text-text-muted">{t('recipes.none')}</p>}
      {rows !== null && (
        <form
          aria-label={t('recipes.form', { item: item.name })}
          className="mt-2 flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          {rows.map((row, i) => (
            <div key={i} className="flex flex-wrap items-end gap-2">
              <div className="flex flex-col gap-1">
                <Label htmlFor={`st-${item.menuItemId}-${i}`}>{t('recipes.stockItem')}</Label>
                <select
                  id={`st-${item.menuItemId}-${i}`}
                  className="h-11 rounded-md border border-border bg-surface px-2 text-sm"
                  value={row.stockItemId}
                  onChange={(e) =>
                    setRows(
                      rows.map((x, j) => (j === i ? { ...x, stockItemId: e.target.value } : x)),
                    )
                  }
                >
                  <option value="">{t('recipes.choose')}</option>
                  {book.stockItems.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} ({s.unit})
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor={`q-${item.menuItemId}-${i}`}>
                  {t('recipes.quantity', { unit: unitOf(row.stockItemId) })}
                </Label>
                <Input
                  id={`q-${item.menuItemId}-${i}`}
                  className="w-28"
                  inputMode="decimal"
                  value={row.quantity}
                  onChange={(e) =>
                    setRows(rows.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)))
                  }
                />
              </div>
              <Button
                type="button"
                variant="ghost"
                className="h-11"
                onClick={() => setRows(rows.filter((_, j) => j !== i))}
              >
                {t('recipes.remove')}
              </Button>
            </div>
          ))}
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => setRows([...rows, { stockItemId: '', quantity: '' }])}
            >
              {t('recipes.addLine')}
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {t('recipes.save')}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setRows(null)}>
              {t('recipes.cancel')}
            </Button>
          </div>
          {save.error && <Alert tone="critical">{errorMessage(save.error)}</Alert>}
        </form>
      )}
    </li>
  );
}
