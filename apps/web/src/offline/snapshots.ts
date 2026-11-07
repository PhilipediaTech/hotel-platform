import { useSyncExternalStore } from 'react';
import { offlineStore } from './store.ts';

// Saved copies of the lists front desk and housekeeping need when the connection drops
// (spec tab 2: today's arrivals, departures, in-house list and room board, refreshed every
// minute while online; PRD NFR "readable offline"; T-093). A list's query function is wrapped:
// online, it saves what it fetched; when the fetch fails for want of a network, it answers
// the saved copy and remembers its time, so the screen can say how old it is.

/** How often saved lists refresh while online (tab 2: every minute). */
export const SNAPSHOT_REFRESH_MS = 60_000;

const shownFromCopy = new Map<string, number>();
const listeners = new Set<() => void>();
const notify = () => {
  for (const l of listeners) l();
};

/** A failed fetch for want of a network (fetch rejects with a TypeError). */
export function isNetworkError(error: unknown): boolean {
  return error instanceof TypeError || (typeof navigator !== 'undefined' && !navigator.onLine);
}

/**
 * Wraps a list's query function. `key` names the list for this user and property, so one
 * person never sees another's saved copy on a shared device.
 */
export function withSnapshot<T>(key: string, fetchList: () => Promise<T>): () => Promise<T> {
  return async () => {
    try {
      const data = await fetchList();
      if (shownFromCopy.delete(key)) notify();
      const store = await offlineStore();
      void store.putSnapshot({ key, data, savedAt: Date.now() }).catch(() => undefined);
      return data;
    } catch (error) {
      if (!isNetworkError(error)) throw error;
      const saved = await (await offlineStore()).getSnapshot(key);
      if (!saved) throw error;
      shownFromCopy.set(key, saved.savedAt);
      notify();
      return saved.data as T;
    }
  };
}

/** When the list on screen is a saved copy: the time it was saved; otherwise null. */
export function useSavedCopyTime(key: string): number | null {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    () => shownFromCopy.get(key) ?? null,
    () => null,
  );
}

/** Sign-out forgets every saved list on this device. */
export async function clearSnapshots(): Promise<void> {
  shownFromCopy.clear();
  notify();
  await (await offlineStore()).clearSnapshots();
}
