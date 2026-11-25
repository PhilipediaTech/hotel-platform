import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useSession } from '../app/session.ts';
import { Alert } from '../components/ui/alert.tsx';
import { Button } from '../components/ui/button.tsx';
import { api } from '../lib/api.ts';
import { sendOrQueue, useQueuedActions, type Queueable } from '../offline/queue.ts';
import { withSnapshot } from '../offline/snapshots.ts';
import type { QueuedAction } from '../offline/store.ts';
import { useOfflineKey, useOfflineWho } from '../offline/use-offline-key.ts';
import { useOnlineStatus } from '../offline/use-online-status.ts';
import posStrings from '../i18n/en/pos.json';
import { registerStrings } from '../i18n/index.ts';
import { useFormats } from './reservations.tsx';

registerStrings(posStrings);

// Offline order taking (PRD M8-08 "As a POS cashier, I keep taking orders during an outage;
// they sync when online"; spec tab 2 "Offline": a whitelisted queue, each action with a client
// UUID and idempotency key, replayed in order; payments disabled offline; T-158). The register
// keeps a saved copy of the menu and the open orders; an order opened offline carries its own
// ID, so the items added to it can name it; everything waits on the device and goes, in
// order, when the connection is back. Paying or charging to a room waits for the connection.

export type Menu = Awaited<ReturnType<typeof fetchMenu>>;
const fetchMenu = (outletId: string) => api.call('getOutletMenu', { query: { outletId } });

function useRoot() {
  const { currentPropertyId } = useSession();
  return ['pos', currentPropertyId ?? ''];
}

/** The outlet's menu, from a saved copy when there is no connection. */
export function useOutletMenu(outletId: string) {
  const root = useRoot();
  const savedAs = useOfflineKey(`pos-menu:${outletId}`);
  return useQuery({
    queryKey: [...root, 'menu', outletId],
    queryFn: withSnapshot(savedAs, () => fetchMenu(outletId)),
  });
}

/** Wraps a register query with its saved copy (T-158). */
export function useSaved<T>(name: string, fetch: () => Promise<T>): () => Promise<T> {
  return withSnapshot(useOfflineKey(name), fetch);
}

interface QueuedLine {
  actionId: string;
  menuItemId: string;
  modifierIds: string[];
  quantity: number;
}

export interface OfflineOrder {
  id: string;
  outletId: string;
  label: string;
  conflict: string | null;
}

type Body = Record<string, unknown>;
const body = (a: QueuedAction) => (a.input.body ?? {}) as Body;
const params = (a: QueuedAction) => (a.input.params ?? {}) as Body;

/** What waits on this device for the register: new orders, and items per order. */
export function useQueuedPos(outletId: string) {
  const who = useOfflineWho();
  const actions = useQueuedActions().filter((a) => a.userId === who.userId);
  const newOrders: OfflineOrder[] = actions
    .filter((a) => a.operationId === 'openPosOrder' && body(a).outletId === outletId)
    .map((a) => ({
      id: String(body(a).id),
      outletId,
      label: String(body(a).label),
      conflict: a.status === 'conflict' ? (a.error ?? '') : null,
    }));
  const linesFor = (orderId: string): QueuedLine[] =>
    actions
      .filter((a) => a.operationId === 'addPosOrderLine' && params(a).orderId === orderId)
      .map((a) => ({
        actionId: a.id,
        menuItemId: String(body(a).menuItemId),
        modifierIds: (body(a).modifierIds as string[] | undefined) ?? [],
        quantity: Number(body(a).quantity ?? 1),
      }));
  const kitchenSendsFor = (orderId: string) =>
    actions.filter(
      (a) => a.operationId === 'sendPosOrderToKitchen' && params(a).orderId === orderId,
    ).length;
  const conflicts = actions.filter(
    (a) =>
      a.status === 'conflict' &&
      ['openPosOrder', 'addPosOrderLine', 'sendPosOrderToKitchen'].includes(a.operationId),
  );
  return { newOrders, linesFor, kitchenSendsFor, conflicts };
}

/** A queued item as the cashier sees it: its name with options, and its price before tax. */
export function priceLine(menu: Menu | undefined, line: QueuedLine) {
  const item = menu?.categories.flatMap((c) => c.items).find((i) => i.id === line.menuItemId);
  if (!item) return { name: '…', amountMinor: null };
  const mods = item.modifiers
    .filter((m) => line.modifierIds.includes(m.id))
    .sort((a, b) => a.name.localeCompare(b.name));
  const unit = mods.reduce((s, m) => s + BigInt(m.priceMinor), BigInt(item.priceMinor));
  return {
    name: mods.length > 0 ? `${item.name} (${mods.map((m) => m.name).join(', ')})` : item.name,
    amountMinor: (unit * BigInt(line.quantity)).toString(),
  };
}

/** Sends a register action now, or keeps it on the device (T-158); refreshes the register. */
export function useRegisterSend() {
  const who = useOfflineWho();
  const queryClient = useQueryClient();
  const root = useRoot();
  return async <T,>(
    operationId: Queueable,
    input: { params?: unknown; body?: unknown },
    label: string,
  ) => {
    const offline = typeof navigator !== 'undefined' && !navigator.onLine;
    const withTime =
      offline && (operationId === 'openPosOrder' || operationId === 'addPosOrderLine')
        ? { ...input, body: { ...(input.body as Body), takenAt: new Date().toISOString() } }
        : input;
    const sent = await sendOrQueue<T>(who, operationId, withTime, { label });
    void queryClient.invalidateQueries({ queryKey: root });
    return sent;
  };
}

/** Shown on an order while there is no connection, or items still wait. */
export function OfflineNotice({ waiting }: { waiting: number }) {
  const { t } = useTranslation();
  const online = useOnlineStatus();
  if (online && waiting === 0) return null;
  return (
    <Alert tone="info" className="mt-2">
      {online ? t('pos.offline.sending', { count: waiting }) : t('pos.offline.notice')}
    </Alert>
  );
}

/** The items of an order still on this device. */
export function QueuedLines({ menu, lines }: { menu: Menu | undefined; lines: QueuedLine[] }) {
  const { t } = useTranslation();
  const f = useFormats();
  if (lines.length === 0) return null;
  return (
    <ul aria-label={t('pos.offline.waitingItems')} className="mt-1 flex flex-col gap-1 text-sm">
      {lines.map((l) => {
        const priced = priceLine(menu, l);
        return (
          <li key={l.actionId} className="flex justify-between gap-2 text-text-muted">
            <span>
              {t('pos.register.qty', { count: l.quantity })} {priced.name}
              <span className="block text-xs">{t('pos.offline.notSent')}</span>
            </span>
            <span>{priced.amountMinor !== null ? f.money(priced.amountMinor) : ''}</span>
          </li>
        );
      })}
    </ul>
  );
}

/** An order opened on this device and not sent yet: items can be added, paying waits. */
export function OfflineOrderPanel({
  order,
  menuPanel,
}: {
  order: OfflineOrder;
  menuPanel: React.ReactNode;
}) {
  const { t } = useTranslation();
  const f = useFormats();
  const menu = useOutletMenu(order.outletId);
  const { linesFor, kitchenSendsFor } = useQueuedPos(order.outletId);
  const lines = linesFor(order.id);
  const send = useRegisterSend();
  const estimate = lines.reduce(
    (s, l) => s + BigInt(priceLine(menu.data, l).amountMinor ?? '0'),
    0n,
  );
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
      <div>{menuPanel}</div>
      <aside
        aria-label={t('pos.offline.order', { label: order.label })}
        className="rounded-md border border-border bg-surface p-3"
      >
        <h2 className="font-semibold">{t('pos.offline.order', { label: order.label })}</h2>
        {order.conflict ? (
          <Alert tone="critical" className="mt-2">
            {t('pos.offline.refused', { reason: order.conflict })}
          </Alert>
        ) : (
          <OfflineNotice waiting={lines.length + 1} />
        )}
        {lines.length === 0 ? (
          <p className="mt-2 text-sm text-text-muted">{t('pos.register.empty')}</p>
        ) : (
          <QueuedLines menu={menu.data} lines={lines} />
        )}
        <p className="mt-3 border-t border-border pt-2 text-sm">
          {t('pos.offline.estimate', { amount: f.money(estimate.toString()) })}
        </p>
        {lines.length > 0 && kitchenSendsFor(order.id) === 0 && (
          <Button
            variant="secondary"
            className="mt-3 h-11 w-full"
            onClick={() =>
              void send(
                'sendPosOrderToKitchen',
                { params: { orderId: order.id } },
                t('pos.offline.kitchenLabel', { label: order.label }),
              )
            }
          >
            {t('pos.offline.sendKitchen')}
          </Button>
        )}
        <Button className="mt-2 h-11 w-full" disabled>
          {t('pos.register.pay')}
        </Button>
      </aside>
    </div>
  );
}
