import { useSyncExternalStore } from 'react';
import { api, ApiError } from '../lib/api.ts';
import { isNetworkError } from './snapshots.ts';
import { offlineStore, type QueuedAction } from './store.ts';

// The offline queue (spec tab 2 "Offline": "queue only for whitelisted actions (notes, task
// updates, housekeeping status). Each queued action has a client UUID and idempotency key; on
// reconnect it replays in order and shows conflicts"; QA "network cut on front desk → note
// queued → reconnect → note synced"; T-093). Anything else, money above all, needs the
// connection and is refused offline by the API client.

/** The only operations that may wait for the connection. */
export const QUEUEABLE = new Set([
  'addTaskComment',
  'acknowledgeTask',
  'startTask',
  'holdTask',
  'resolveTask',
  'updateAssignment',
  'submitStatusReport',
  // Notes only (the queue refuses any other field).
  'updateReservation',
]);

export type Queueable =
  | 'addTaskComment'
  | 'acknowledgeTask'
  | 'startTask'
  | 'holdTask'
  | 'resolveTask'
  | 'updateAssignment'
  | 'submitStatusReport'
  | 'updateReservation';

type Input = QueuedAction['input'];

// ── What the shell shows ─────────────────────────────────────────────────────────────────

let snapshot: QueuedAction[] = [];
const listeners = new Set<() => void>();
async function refresh(): Promise<void> {
  snapshot = await (await offlineStore()).listActions();
  for (const l of listeners) l();
}

/** Actions waiting on this device (pending and conflicts), oldest first. */
export function useQueuedActions(): QueuedAction[] {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    () => snapshot,
    () => snapshot,
  );
}

// ── Sending ──────────────────────────────────────────────────────────────────────────────

export interface Who {
  userId: string;
  propertyId: string;
}

export type Sent<T> = { queued: false; result: T } | { queued: true };

function checkQueueable(operationId: string, input: Input): void {
  if (!QUEUEABLE.has(operationId)) throw new Error(`${operationId} cannot wait offline`);
  if (operationId === 'updateReservation') {
    const keys = Object.keys(input.body ?? {});
    if (keys.some((k) => k !== 'notes')) throw new Error('Only notes can wait offline');
  }
}

/**
 * Sends a whitelisted action now, or keeps it on this device when there is no network
 * (offline, or the request never reached the server). The same UUID is its idempotency key
 * now and on replay, so the server applies it once whatever happens.
 */
export async function sendOrQueue<T>(
  who: Who,
  operationId: Queueable,
  input: Input,
  options: { label: string; ifMatch?: string },
): Promise<Sent<T>> {
  checkQueueable(operationId, input);
  const id = crypto.randomUUID();
  if (typeof navigator === 'undefined' || navigator.onLine) {
    try {
      const result = await (api.call as (...a: unknown[]) => Promise<T>)(operationId, input, {
        idempotencyKey: id,
        ...(options.ifMatch ? { ifMatch: options.ifMatch } : {}),
      });
      return { queued: false, result };
    } catch (error) {
      if (!isNetworkError(error)) throw error;
    }
  }
  const store = await offlineStore();
  await store.addAction({
    id,
    userId: who.userId,
    propertyId: who.propertyId,
    operationId,
    input,
    ...(options.ifMatch ? { ifMatch: options.ifMatch } : {}),
    label: options.label,
    createdAt: Date.now(),
    status: 'pending',
  });
  await refresh();
  return { queued: true };
}

/** A note whose reservation changed meanwhile is still sent if the change was the note itself. */
async function alreadyApplied(action: QueuedAction): Promise<boolean> {
  if (action.operationId !== 'updateReservation') return false;
  const params = action.input.params as { reservationId: string };
  const current = await (api.call as (...a: unknown[]) => Promise<{ notes: string | null }>)(
    'getReservation',
    { params },
  );
  return current.notes === ((action.input.body as { notes: string | null }).notes ?? null);
}

let replaying: Promise<number> | null = null;

/**
 * Sends this person's waiting actions in the order they were made. A refusal (the room or
 * task changed meanwhile) becomes a conflict to show; a network failure stops the run for a
 * later try. Returns how many were sent. One run at a time.
 */
export function replay(who: Who): Promise<number> {
  replaying ??= (async () => {
    const store = await offlineStore();
    let sent = 0;
    try {
      const mine = (await store.listActions()).filter(
        (a) => a.userId === who.userId && a.status === 'pending',
      );
      for (const action of mine) {
        // Each action belongs to the property it was made in.
        try {
          await (api.call as (...a: unknown[]) => Promise<unknown>)(
            action.operationId,
            action.input,
            {
              idempotencyKey: action.id,
              propertyId: action.propertyId,
              ...(action.ifMatch ? { ifMatch: action.ifMatch } : {}),
            },
          );
          await store.deleteAction(action.id);
          sent += 1;
        } catch (error) {
          if (isNetworkError(error)) break;
          if (error instanceof ApiError && (error.status === 401 || error.status >= 500)) break;
          if (error instanceof ApiError && error.code === 'RATE_LIMITED') break;
          if (error instanceof ApiError && error.code === 'VERSION_CONFLICT') {
            if (await alreadyApplied(action).catch(() => false)) {
              await store.deleteAction(action.id);
              sent += 1;
              continue;
            }
          }
          await store.updateAction(action.id, {
            status: 'conflict',
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } finally {
      await refresh();
      replaying = null;
    }
    return sent;
  })();
  return replaying;
}

/** The person drops a conflict (or a waiting action) after reading it. */
export async function discard(id: string): Promise<void> {
  await (await offlineStore()).deleteAction(id);
  await refresh();
}

/** Loads what is waiting (on start). */
export function loadQueue(): Promise<void> {
  return refresh();
}
