import {
  getDoc,
  getDocFromCache,
  getDocs,
  getDocsFromCache,
  type DocumentData,
  type DocumentReference,
  type Query,
} from 'firebase/firestore';
import { isFirestoreQuotaError } from './firebase';

export const CACHE_TTL_MS = {
  /** Rarely changing config & directory docs: centres, settings, excel_sheet_configs, users */
  STATIC: 6 * 60 * 60 * 1000, // 6 hours
  /** Logged-in user profile restoration on page refresh */
  PROFILE: 30 * 60 * 1000, // 30 minutes
  /** Large institutional tables: students, fee_recovery, practical, tma, online, admission */
  BULK_DATA: 60 * 60 * 1000, // 60 minutes
  /** Operational collections: work_assignments, work_assignment_tasks, notifications, logs, reports */
  OPERATIONAL: 10 * 60 * 1000, // 10 minutes
} as const;

const STORAGE_PREFIX = 'vp_fscache_v2::';

interface MemoryEntry<T = unknown> {
  collectionName: string;
  data: T;
  fetchedAt: number;
}

interface StoredMeta {
  ts: number;
  count: number;
}

const memoryCache = new Map<string, MemoryEntry>();
const inFlightRequests = new Map<string, Promise<unknown>>();
const invalidationListeners = new Set<(collections: Set<string>) => void>();

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
      return { ts: parsed.ts, count: parsed.count };
    }
    return null;
  } catch {
    return null;
  }
}

function writeStoredMeta(cacheKey: string, count: number): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    const payload: StoredMeta = { ts: Date.now(), count };
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

export function invalidateCacheForCollections(collections: string[]): Set<string> {
  const expanded = new Set(expandMutatedCollections(collections));
  if (expanded.size === 0) return expanded;

  for (const [key, entry] of memoryCache.entries()) {
    if (expanded.has(entry.collectionName)) {
      memoryCache.delete(key);
    }
  }
  expanded.forEach((col) => removeStoredMetaForCollection(col));
  return expanded;
}

export function emitCollectionsMutated(collections: string[]): void {
  const expanded = invalidateCacheForCollections(collections);
  if (expanded.size === 0) return;
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
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    const toRemove: string[] = [];
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const k = window.localStorage.key(i);
      if (k && k.startsWith(STORAGE_PREFIX)) {
        toRemove.push(k);
      }
    }
    toRemove.forEach((k) => window.localStorage.removeItem(k));
  } catch {
    // Ignore storage errors
  }
}

/**
 * 3-Tier Cache-First Collection Fetcher:
 * 1. In-memory cache (0 ms, 0 Firestore reads across tab switches)
 * 2. Firestore IndexedDB cache via getDocsFromCache when fresh within TTL (0 server reads across F5 refreshes)
 * 3. Server getDocs ONLY on cache miss / TTL expiry / forceServer, with automatic stale-cache fallback on quota error
 */
export async function fetchCollectionCached<T>(
  collectionName: string,
  cacheKeySuffix: string,
  q: Query<DocumentData>,
  ttlMs: number,
  options?: { forceServer?: boolean; includeDocId?: boolean },
): Promise<T[]> {
  const forceServer = Boolean(options?.forceServer);
  const includeDocId = Boolean(options?.includeDocId);
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
    // Tier 2: IndexedDB persistent cache hit (0 server reads even after hard refresh)
    if (!forceServer) {
      const meta = readStoredMeta(fullKey);
      if (meta && isCacheEntryFresh(meta.ts, ttlMs)) {
        try {
          const cachedSnap = await getDocsFromCache(q);
          // Accept cached snapshot if it has docs OR the last server fetch confirmed 0 docs
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
          // Cache miss -> fall through to server
        }
      }
    }

    // Tier 3: Server fetch (only when cache is empty, stale, or user clicked Sync)
    try {
      const serverSnap = await getDocs(q);
      const items = mapSnap(serverSnap);
      const now = Date.now();
      memoryCache.set(fullKey, {
        collectionName,
        data: items,
        fetchedAt: now,
      });
      writeStoredMeta(fullKey, items.length);
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
              fetchedAt: Date.now() - ttlMs + 60_000, // Keep usable for 1 min before retrying
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
      writeStoredMeta(fullKey, data ? 1 : 0);
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
              fetchedAt: Date.now() - ttlMs + 60_000,
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
