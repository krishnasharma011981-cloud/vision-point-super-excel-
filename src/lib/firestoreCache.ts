import {
  getDoc,
  getDocFromCache,
  getDocs,
  getDocsFromCache,
  query,
  Timestamp,
  where,
  type DocumentData,
  type DocumentReference,
  type DocumentSnapshot,
  type Query,
} from 'firebase/firestore';
import { CURRENT_FIREBASE_PROJECT_ID, isFirestoreQuotaError } from './firebase';

export const CACHE_TTL_MS = {
  /** Rarely changing config & directory docs: centres, settings, excel_sheet_configs, users */
  STATIC: 24 * 60 * 60 * 1000, // 24 hours
  /** Logged-in user profile restoration on page refresh */
  PROFILE: 4 * 60 * 60 * 1000, // 4 hours
  /** Large institutional tables: students, fee_recovery, practical, tma, online, admission (uses Delta Sync after TTL) */
  BULK_DATA: 12 * 60 * 60 * 1000, // 12 hours
  /** Operational collections: work_assignments, work_assignment_tasks, notifications, logs, reports */
  OPERATIONAL: 30 * 60 * 1000, // 30 minutes
} as const;

// Namespace cache metadata by Firebase projectId so switching Firebase projects starts with a clean baseline
const STORAGE_PREFIX = `vp_fscache_v2::${CURRENT_FIREBASE_PROJECT_ID}::`;

interface MemoryEntry<T = unknown> {
  collectionName: string;
  data: T;
  fetchedAt: number;
}

export interface StoredMeta {
  ts: number;
  count: number;
  lastFullSyncTs?: number;
}

const memoryCache = new Map<string, MemoryEntry>();
const inFlightRequests = new Map<string, Promise<unknown>>();
const invalidationListeners = new Set<(collections: Set<string>) => void>();
const deltaUnsupportedKeys = new Set<string>();

export function isCacheEntryFresh(
  fetchedAtMs: number | null | undefined,
  ttlMs: number,
  nowMs: number = Date.now(),
): boolean {
  if (!fetchedAtMs || !Number.isFinite(fetchedAtMs) || fetchedAtMs <= 0) return false;
  if (ttlMs <= 0) return false;
  return nowMs - fetchedAtMs < ttlMs;
}

/**
 * Determines whether an expired or synced collection can use ultra-low-read Incremental Delta Sync
 * (`where('updatedAt', '>', lastSync)`) instead of re-reading the entire collection from Firestore.
 */
export function shouldUseDeltaSync(
  meta: StoredMeta | null,
  deltaSyncField?: 'updatedAt' | 'createdAt',
  forceFullServer = false,
): boolean {
  if (forceFullServer || !deltaSyncField || !meta) return false;
  if (!Number.isFinite(meta.ts) || meta.ts <= 0) return false;
  if (!Number.isFinite(meta.count) || meta.count <= 0) return false;
  return true;
}

/**
 * Expands a mutated collection name into any tightly-coupled sibling collections
 * that are updated alongside it so cached views stay consistent after local writes.
 */
export function expandMutatedCollections(collections: string[]): string[] {
  const set = new Set<string>();
  for (const raw of collections) {
    const col = String(raw || '').trim();
    if (!col) continue;
    set.add(col);
    if (col === 'students') {
      set.add('fee_recovery');
      set.add('practical_records');
      set.add('tma_records');
      set.add('online_class_records');
      set.add('admission_records');
    } else if (col === 'work_assignments') {
      set.add('work_assignment_tasks');
    } else if (col === 'work_assignment_tasks') {
      set.add('work_assignments');
      set.add('fee_recovery');
      set.add('practical_records');
      set.add('tma_records');
    } else if (col === 'centres') {
      set.add('users');
    } else if (col === 'staff_invites') {
      set.add('users');
    } else if (col === 'edit_requests') {
      set.add('students');
      set.add('fee_recovery');
      set.add('practical_records');
      set.add('tma_records');
      set.add('online_class_records');
      set.add('admission_records');
    }
  }
  return Array.from(set);
}

function readStoredMeta(cacheKey: string): StoredMeta | null {
  if (typeof window === 'undefined' || !window.localStorage) return null;
  try {
    const raw = window.localStorage.getItem(`${STORAGE_PREFIX}${cacheKey}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredMeta>;
    if (typeof parsed.ts === 'number' && typeof parsed.count === 'number') {
      return {
        ts: parsed.ts,
        count: parsed.count,
        lastFullSyncTs: typeof parsed.lastFullSyncTs === 'number' ? parsed.lastFullSyncTs : parsed.ts,
      };
    }
    return null;
  } catch {
    return null;
  }
}

function writeStoredMeta(cacheKey: string, count: number, lastFullSyncTs?: number): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    const now = Date.now();
    const payload: StoredMeta = {
      ts: now,
      count,
      lastFullSyncTs: lastFullSyncTs ?? now,
    };
    window.localStorage.setItem(`${STORAGE_PREFIX}${cacheKey}`, JSON.stringify(payload));
  } catch {
    // Ignore storage quota errors in restricted browsing modes
  }
}

function removeStoredMetaForCollection(collectionName: string): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    const prefix = `${STORAGE_PREFIX}${collectionName}:`;
    const toRemove: string[] = [];
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const k = window.localStorage.key(i);
      if (k && k.startsWith(prefix)) {
        toRemove.push(k);
      }
    }
    toRemove.forEach((k) => window.localStorage.removeItem(k));
  } catch {
    // Ignore storage errors
  }
}

function isMissingIndexError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err || '');
  const lower = msg.toLowerCase();
  return (
    lower.includes('failed-precondition') ||
    lower.includes('requires an index') ||
    lower.includes('create it here')
  );
}

/**
 * Forces a fresh server fetch on next read (used ONLY by manual Sync button).
 * Keeps `storedMeta.ts` intact when `preserveDeltaBaseline` is true so large tables can run
 * incremental Delta Sync instead of re-reading every unchanged row!
 */
export function invalidateCacheForCollections(
  collections: string[],
  options?: { preserveDeltaBaseline?: boolean },
): Set<string> {
  const expanded = new Set(expandMutatedCollections(collections));
  if (expanded.size === 0) return expanded;

  for (const [key, entry] of memoryCache.entries()) {
    if (expanded.has(entry.collectionName)) {
      memoryCache.delete(key);
    }
  }

  if (options?.preserveDeltaBaseline && typeof window !== 'undefined' && window.localStorage) {
    // Mark stored meta as expired (ts - 48h) while preserving the sync timestamp for delta queries?
    // Wait: we store `ts` as the last sync time; instead of deleting it, only delete when NOT preserving delta.
    // For manual Sync on large tables, we remove memoryCache and let caller pass forceServer or expire ts cleanly.
    expanded.forEach((col) => {
      const prefix = `${STORAGE_PREFIX}${col}:`;
      for (let i = 0; i < window.localStorage.length; i += 1) {
        const k = window.localStorage.key(i);
        if (!k || !k.startsWith(prefix)) continue;
        try {
          const raw = window.localStorage.getItem(k);
          if (!raw) continue;
          const parsed = JSON.parse(raw) as StoredMeta;
          // Force Tier 2 TTL check to miss while keeping `lastFullSyncTs` / previous sync time in `lastFullSyncTs`
          window.localStorage.setItem(
            k,
            JSON.stringify({
              ...parsed,
              lastFullSyncTs: parsed.ts,
              ts: 1, // Expired so Tier 3 runs (Delta Sync uses lastFullSyncTs!)
            }),
          );
        } catch {
          window.localStorage.removeItem(k);
        }
      }
    });
  } else {
    expanded.forEach((col) => removeStoredMetaForCollection(col));
  }

  return expanded;
}

/**
 * ZERO-SERVER-READ Write-Through Local Cache Refresh!
 * Because Firestore's persistent IndexedDB cache ALREADY records every local write/update/delete
 * synchronously, clearing ONLY in-memory cache (while keeping IndexedDB metadata fresh) forces
 * React views to re-read directly from IndexedDB (`getDocsFromCache`) at 0 Firestore server reads!
 */
export function emitCollectionsMutated(
  collections: string[],
  options?: { forceServerRefresh?: boolean },
): void {
  const expanded = new Set(expandMutatedCollections(collections));
  if (expanded.size === 0) return;

  for (const [key, entry] of memoryCache.entries()) {
    if (expanded.has(entry.collectionName)) {
      memoryCache.delete(key);
    }
  }

  if (options?.forceServerRefresh) {
    expanded.forEach((col) => removeStoredMetaForCollection(col));
  } else if (typeof window !== 'undefined' && window.localStorage) {
    // Refresh local freshness timestamp for already-cached keys so Tier 2 IndexedDB cache serves
    // the freshly written docs instantly with 0 server reads.
    const now = Date.now();
    expanded.forEach((col) => {
      const prefix = `${STORAGE_PREFIX}${col}:`;
      for (let i = 0; i < window.localStorage.length; i += 1) {
        const k = window.localStorage.key(i);
        if (!k || !k.startsWith(prefix)) continue;
        try {
          const raw = window.localStorage.getItem(k);
          if (!raw) continue;
          const parsed = JSON.parse(raw) as StoredMeta;
          if (parsed && typeof parsed.count === 'number') {
            window.localStorage.setItem(
              k,
              JSON.stringify({
                ...parsed,
                ts: now,
                // Increment count if previously 0 so newly created first doc is read from IndexedDB!
                count: Math.max(1, parsed.count),
              }),
            );
          }
        } catch {
          // Ignore storage parse error
        }
      }
    });
  }

  invalidationListeners.forEach((listener) => {
    try {
      listener(expanded);
    } catch {
      // Never let one subscriber break others
    }
  });
}

export function subscribeCacheInvalidation(
  listener: (collections: Set<string>) => void,
): () => void {
  invalidationListeners.add(listener);
  return () => {
    invalidationListeners.delete(listener);
  };
}

export function clearAllFirestoreCache(): void {
  memoryCache.clear();
  inFlightRequests.clear();
  deltaUnsupportedKeys.clear();
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    const toRemove: string[] = [];
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const k = window.localStorage.key(i);
      if (k && k.startsWith('vp_fscache_v2::')) {
        toRemove.push(k);
      }
    }
    toRemove.forEach((k) => window.localStorage.removeItem(k));
  } catch {
    // Ignore storage errors
  }
}

/**
 * Cache-First Single Document Lookup for read-before-write checks inside firestoreService.
 * Reads from IndexedDB cache first (0 server reads) and only hits Firestore server on cache miss.
 */
export async function getDocCacheFirst(
  ref: DocumentReference<DocumentData>,
): Promise<DocumentSnapshot<DocumentData>> {
  try {
    const cached = await getDocFromCache(ref);
    if (cached.exists()) {
      return cached;
    }
  } catch {
    // Cache miss -> fall through to server
  }
  return getDoc(ref);
}

/**
 * 4-Tier Ultra-Low-Read Indexed Cache-First Collection Fetcher:
 * 1. In-memory cache (0 ms, 0 Firestore reads across tab switches)
 * 2. IndexedDB persistent cache via `getDocsFromCache` (indexed locally via PersistentCacheIndexManager — 0 server reads across F5 refreshes & local edits!)
 * 3. Incremental Delta Sync (`where('updatedAt', '>', lastSync)`) when TTL expires on already-cached collections (reads ONLY changed docs, typically 0–2 reads instead of 500–1,000!)
 * 4. Full Server `getDocs` ONLY on first-ever empty cache or unsupported composite index, with automatic stale-cache fallback on quota error
 */
export async function fetchCollectionCached<T>(
  collectionName: string,
  cacheKeySuffix: string,
  q: Query<DocumentData>,
  ttlMs: number,
  options?: {
    forceServer?: boolean;
    includeDocId?: boolean;
    deltaSyncField?: 'updatedAt' | 'createdAt';
  },
): Promise<T[]> {
  const forceServer = Boolean(options?.forceServer);
  const includeDocId = Boolean(options?.includeDocId);
  const deltaSyncField = options?.deltaSyncField;
  const fullKey = `${collectionName}:${cacheKeySuffix}`;

  const mapSnap = (snap: { docs: Array<{ id: string; data: () => DocumentData }> }): T[] =>
    snap.docs.map((d) => (includeDocId ? ({ id: d.id, ...d.data() } as T) : (d.data() as T)));

  // Tier 1: In-memory fresh hit (0 reads)
  if (!forceServer) {
    const mem = memoryCache.get(fullKey) as MemoryEntry<T[]> | undefined;
    if (mem && isCacheEntryFresh(mem.fetchedAt, ttlMs)) {
      return mem.data;
    }
  }

  // Deduplicate concurrent fetches for the exact same key
  const flightKey = forceServer ? `${fullKey}:force` : fullKey;
  const existingFlight = inFlightRequests.get(flightKey) as Promise<T[]> | undefined;
  if (existingFlight) {
    return existingFlight;
  }

  const task = (async (): Promise<T[]> => {
    const meta = readStoredMeta(fullKey);

    // Tier 2: IndexedDB persistent cache hit (0 server reads even after F5 refresh & local edits)
    if (!forceServer && meta && isCacheEntryFresh(meta.ts, ttlMs)) {
      try {
        const cachedSnap = await getDocsFromCache(q);
        if (cachedSnap.size > 0 || meta.count === 0) {
          const items = mapSnap(cachedSnap);
          memoryCache.set(fullKey, {
            collectionName,
            data: items,
            fetchedAt: meta.ts,
          });
          return items;
        }
      } catch {
        // Cache miss -> fall through to delta / server
      }
    }

    // Tier 3: Incremental Delta Sync (reads ONLY modified docs since last sync!)
    const deltaBaselineTs =
      meta && meta.ts > 1
        ? meta.ts
        : meta && meta.lastFullSyncTs && meta.lastFullSyncTs > 1
          ? meta.lastFullSyncTs
          : 0;
    const canDelta =
      !deltaUnsupportedKeys.has(fullKey) &&
      shouldUseDeltaSync(
        meta ? { ...meta, ts: deltaBaselineTs } : null,
        deltaSyncField,
        false,
      );

    if (canDelta && deltaSyncField && deltaBaselineTs > 0) {
      try {
        const existingLocal = await getDocsFromCache(q);
        if (existingLocal.size > 0) {
          const sinceTs = Timestamp.fromMillis(Math.max(0, deltaBaselineTs - 10_000));
          const deltaQ = query(q, where(deltaSyncField, '>', sinceTs));
          // Fetch ONLY newly changed docs from server; Firestore merges them into IndexedDB automatically!
          await getDocs(deltaQ);
          const mergedLocal = await getDocsFromCache(q);
          const items = mapSnap(mergedLocal);
          const now = Date.now();
          memoryCache.set(fullKey, {
            collectionName,
            data: items,
            fetchedAt: now,
          });
          writeStoredMeta(fullKey, items.length, meta?.lastFullSyncTs ?? now);
          return items;
        }
      } catch (deltaErr) {
        if (isMissingIndexError(deltaErr)) {
          deltaUnsupportedKeys.add(fullKey);
        } else if (isFirestoreQuotaError(deltaErr)) {
          // Serve stale IndexedDB cache cleanly on quota error
          try {
            const staleSnap = await getDocsFromCache(q);
            if (staleSnap.size > 0) {
              const items = mapSnap(staleSnap);
              memoryCache.set(fullKey, {
                collectionName,
                data: items,
                fetchedAt: Date.now() - ttlMs + 5 * 60_000,
              });
              return items;
            }
          } catch {
            // Fall through
          }
        }
        // Any other delta failure -> fall through to Tier 4 full server fetch
      }
    }

    // Tier 4: Full Server fetch (first-ever load or explicit full refresh)
    try {
      const serverSnap = await getDocs(q);
      const items = mapSnap(serverSnap);
      const now = Date.now();
      memoryCache.set(fullKey, {
        collectionName,
        data: items,
        fetchedAt: now,
      });
      writeStoredMeta(fullKey, items.length, now);
      return items;
    } catch (err) {
      // Quota / offline resilience: serve stale IndexedDB cache rather than failing the screen
      if (isFirestoreQuotaError(err)) {
        try {
          const staleSnap = await getDocsFromCache(q);
          if (staleSnap.size > 0) {
            const items = mapSnap(staleSnap);
            memoryCache.set(fullKey, {
              collectionName,
              data: items,
              fetchedAt: Date.now() - ttlMs + 5 * 60_000,
            });
            return items;
          }
        } catch {
          // Fall through and throw original error
        }
      }
      throw err;
    }
  })();

  inFlightRequests.set(flightKey, task);
  try {
    return await task;
  } finally {
    inFlightRequests.delete(flightKey);
  }
}

/**
 * 3-Tier Cache-First Single Document Fetcher:
 * Serves from memory -> IndexedDB persistent cache -> server (with stale-cache fallback on quota error).
 */
export async function fetchDocumentCached<T>(
  collectionName: string,
  cacheKeySuffix: string,
  ref: DocumentReference<DocumentData>,
  ttlMs: number,
  options?: { forceServer?: boolean },
): Promise<T | null> {
  const forceServer = Boolean(options?.forceServer);
  const fullKey = `${collectionName}:${cacheKeySuffix}`;

  // Tier 1: In-memory fresh hit
  if (!forceServer) {
    const mem = memoryCache.get(fullKey) as MemoryEntry<T | null> | undefined;
    if (mem && isCacheEntryFresh(mem.fetchedAt, ttlMs)) {
      return mem.data;
    }
  }

  const flightKey = forceServer ? `${fullKey}:force` : fullKey;
  const existingFlight = inFlightRequests.get(flightKey) as Promise<T | null> | undefined;
  if (existingFlight) {
    return existingFlight;
  }

  const task = (async (): Promise<T | null> => {
    // Tier 2: Persistent IndexedDB cache hit
    if (!forceServer) {
      const meta = readStoredMeta(fullKey);
      if (meta && isCacheEntryFresh(meta.ts, ttlMs)) {
        try {
          const cachedSnap = await getDocFromCache(ref);
          if (cachedSnap.exists()) {
            const data = cachedSnap.data() as T;
            memoryCache.set(fullKey, { collectionName, data, fetchedAt: meta.ts });
            return data;
          }
          if (meta.count === 0) {
            memoryCache.set(fullKey, { collectionName, data: null, fetchedAt: meta.ts });
            return null;
          }
        } catch {
          // Fall through to server
        }
      }
    }

    // Tier 3: Server fetch
    try {
      const snap = await getDoc(ref);
      const data = snap.exists() ? (snap.data() as T) : null;
      const now = Date.now();
      memoryCache.set(fullKey, { collectionName, data, fetchedAt: now });
      writeStoredMeta(fullKey, data ? 1 : 0, now);
      return data;
    } catch (err) {
      if (isFirestoreQuotaError(err)) {
        try {
          const staleSnap = await getDocFromCache(ref);
          if (staleSnap.exists()) {
            const data = staleSnap.data() as T;
            memoryCache.set(fullKey, {
              collectionName,
              data,
              fetchedAt: Date.now() - ttlMs + 5 * 60_000,
            });
            return data;
          }
        } catch {
          // Fall through
        }
      }
      throw err;
    }
  })();

  inFlightRequests.set(flightKey, task);
  try {
    return await task;
  } finally {
    inFlightRequests.delete(flightKey);
  }
}
