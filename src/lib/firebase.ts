import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import {
  CACHE_SIZE_UNLIMITED,
  doc,
  enablePersistentCacheIndexAutoCreation,
  getDocFromServer,
  getFirestore,
  getPersistentCacheIndexManager,
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  type Firestore,
} from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';

const app = initializeApp(firebaseConfig);

// Enable multi-tab unlimited persistent IndexedDB local cache + automatic local query indexing
// so page reloads, tab switches, and filtered queries run locally at 0 Firestore server reads.
let dbInstance: Firestore;
try {
  dbInstance = initializeFirestore(
    app,
    {
      localCache: persistentLocalCache({
        cacheSizeBytes: CACHE_SIZE_UNLIMITED,
        tabManager: persistentMultipleTabManager(),
      }),
    },
    firebaseConfig.firestoreDatabaseId,
  );
} catch {
  dbInstance = getFirestore(app, firebaseConfig.firestoreDatabaseId);
}

// Automatically create & maintain local IndexedDB indexes for every filtered/ordered query
// (centreId, staffUid, createdAt, updatedAt) so cache-first reads are instant without full scans.
try {
  const indexManager = getPersistentCacheIndexManager(dbInstance);
  if (indexManager) {
    enablePersistentCacheIndexAutoCreation(indexManager);
  }
} catch {
  // Ignore if browser environment restricts IndexedDB index management
}

export const db: Firestore = dbInstance;
export const auth = getAuth(app);

export const CURRENT_FIREBASE_PROJECT_ID = firebaseConfig.projectId || 'unknown';
export const FIRESTORE_UPGRADE_URL = `https://console.firebase.google.com/project/${firebaseConfig.projectId}/firestore/databases/${firebaseConfig.firestoreDatabaseId}/data?openUpgradeDialog=true`;

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function isFirestoreQuotaError(error: unknown): boolean {
  const raw = error instanceof Error ? error.message : String(error || '');
  const lower = raw.toLowerCase();
  return (
    lower.includes('quota limit exceeded') ||
    lower.includes('quota exceeded') ||
    lower.includes('resource-exhausted') ||
    lower.includes('resource_exhausted') ||
    lower.includes('free daily read units')
  );
}

export function formatFirestoreUserError(error: unknown, fallback = 'Database request failed.'): string {
  if (isFirestoreQuotaError(error)) {
    return 'Firestore free daily read limit reached for today. Cached data remains accessible; full live sync resumes automatically after daily quota reset (or upgrade this Firebase project to Blaze plan).';
  }
  const raw = error instanceof Error ? error.message : String(error || '');
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw) as { error?: string };
    if (parsed && typeof parsed.error === 'string' && parsed.error.trim()) {
      if (isFirestoreQuotaError(parsed.error)) {
        return 'Firestore free daily read limit reached for today. Cached data remains accessible; full live sync resumes automatically after daily quota reset (or upgrade this Firebase project to Blaze plan).';
      }
      return parsed.error.trim();
    }
  } catch {
    // Not a serialized FirestoreErrorInfo JSON string
  }
  return raw;
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null,
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  if (isFirestoreQuotaError(error)) {
    console.warn('Firestore Quota Reached:', errInfo.path || 'firestore');
  } else {
    console.error('Firestore Error: ', JSON.stringify(errInfo));
  }
  throw new Error(JSON.stringify(errInfo));
}

const CONNECTION_CHECK_SESSION_KEY = 'vp_fs_conn_checked_v2';

export async function testFirestoreConnection(): Promise<void> {
  try {
    if (typeof window !== 'undefined') {
      if (window.sessionStorage?.getItem(CONNECTION_CHECK_SESSION_KEY)) {
        return;
      }
      // If local cache metadata already exists for this project, skip burning a startup server read
      for (let i = 0; i < window.localStorage.length; i += 1) {
        const key = window.localStorage.key(i);
        if (key && key.startsWith('vp_fscache_v2::')) {
          window.sessionStorage?.setItem(CONNECTION_CHECK_SESSION_KEY, '1');
          return;
        }
      }
    }
    await getDocFromServer(doc(db, 'test', 'connection'));
    if (typeof window !== 'undefined') {
      window.sessionStorage?.setItem(CONNECTION_CHECK_SESSION_KEY, '1');
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration.');
    }
  }
}
