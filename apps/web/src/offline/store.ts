import type { Table } from 'dexie';

// Offline storage (spec tab 2 "Offline": Dexie on IndexedDB; T-093). Two tables: `kv` for
// saved copies of lists, `queue` for actions waiting for the connection. Dexie is loaded only
// when first needed, so it never weighs on the first load. Where IndexedDB is missing (tests,
// private windows that refuse it) an in-memory store stands in: the app still works online,
// it just keeps nothing across a reload.

export interface QueuedAction {
  /** Client UUID: also the idempotency key the server deduplicates on. */
  id: string;
  userId: string;
  propertyId: string;
  operationId: string;
  input: { params?: unknown; query?: unknown; body?: unknown };
  ifMatch?: string;
  /** What the person did, in their words (shown while it waits). */
  label: string;
  createdAt: number;
  status: 'pending' | 'conflict';
  /** Why the server refused it on replay. */
  error?: string;
}

export interface Snapshot {
  key: string;
  data: unknown;
  savedAt: number;
}

export interface OfflineStore {
  getSnapshot(key: string): Promise<Snapshot | undefined>;
  putSnapshot(snapshot: Snapshot): Promise<void>;
  clearSnapshots(): Promise<void>;
  addAction(action: QueuedAction): Promise<void>;
  updateAction(id: string, change: Partial<QueuedAction>): Promise<void>;
  deleteAction(id: string): Promise<void>;
  /** Oldest first. */
  listActions(): Promise<QueuedAction[]>;
}

export function memoryStore(): OfflineStore {
  const snapshots = new Map<string, Snapshot>();
  const actions = new Map<string, QueuedAction>();
  return {
    getSnapshot: (key) => Promise.resolve(snapshots.get(key)),
    putSnapshot: (s) => Promise.resolve(void snapshots.set(s.key, s)),
    clearSnapshots: () => Promise.resolve(snapshots.clear()),
    addAction: (a) => Promise.resolve(void actions.set(a.id, a)),
    updateAction: (id, change) => {
      const a = actions.get(id);
      if (a) actions.set(id, { ...a, ...change });
      return Promise.resolve();
    },
    deleteAction: (id) => Promise.resolve(void actions.delete(id)),
    listActions: () =>
      Promise.resolve([...actions.values()].sort((a, b) => a.createdAt - b.createdAt)),
  };
}

async function dexieStore(): Promise<OfflineStore> {
  const { Dexie } = await import('dexie');
  const db = new Dexie('hotel-offline') as InstanceType<typeof Dexie> & {
    kv: Table<Snapshot, string>;
    queue: Table<QueuedAction, string>;
  };
  db.version(1).stores({ kv: 'key', queue: 'id, createdAt' });
  return {
    getSnapshot: (key) => db.kv.get(key),
    putSnapshot: async (s) => void (await db.kv.put(s)),
    clearSnapshots: () => db.kv.clear(),
    addAction: async (a) => void (await db.queue.put(a)),
    updateAction: async (id, change) => void (await db.queue.update(id, change)),
    deleteAction: (id) => db.queue.delete(id),
    listActions: () => db.queue.orderBy('createdAt').toArray(),
  };
}

let store: Promise<OfflineStore> | null = null;

/** The device's offline store (IndexedDB when the browser has it). */
export function offlineStore(): Promise<OfflineStore> {
  store ??=
    typeof indexedDB === 'undefined'
      ? Promise.resolve(memoryStore())
      : dexieStore().catch(() => memoryStore());
  return store;
}

/** Tests start each case with an empty store. */
export function resetOfflineStore(next?: OfflineStore): void {
  store = next ? Promise.resolve(next) : null;
}
