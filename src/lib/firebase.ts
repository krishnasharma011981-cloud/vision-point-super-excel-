import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import {
  doc,
  getDocFromServer,
  getFirestore,
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  type Firestore,
} from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';

const app = initializeApp(firebaseConfig);

// Enable multi-tab persistent IndexedDB local cache so page reloads and tab switches
// serve unchanged documents locally instead of burning Firestore daily read quota.
let dbInstance: Firestore;
try {
  dbInstance = initializeFirestore(
    app,
    {
      localCache: persistentLocalCache({
        tabManager: persistentMultipleTabManager(),
      }),
    },
    firebaseConfig.firestoreDatabaseId,
  );
} catch {
  dbInstance = getFirestore(app, firebaseConfig.firestoreDatabaseId);
}

export const db: Firestore = dbInstance;
export const auth = getAuth(app);

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
  const raw =
    error instanceof Error
      ? `${(error as { code?: string }).code || ''} ${error.message}`
      : String(error || '');
  const lower = raw.toLowerCase();
  return (
    lower.includes('quota exceeded') ||
    lower.includes('quota limit exceeded') ||
    lower.includes('daily read quota') ||
    lower.includes('resource-exhausted') ||
    lower.includes('resource_exhausted') ||
    lower.includes('free daily read units')
  );
}

export function formatFirestoreUserError(error: unknown): string {
  if (isFirestoreQuotaError(error)) {
    return 'Firebase Free Daily Read Quota aaj ke liye poora ho gaya hai. Ye quota kal automatically reset ho jayega, ya aap Firebase Console se database upgrade kar sakte hain.';
  }
  const msg = error instanceof Error ? error.message : String(error || 'Database error');
  if (msg.startsWith('{') && msg.includes('"error"')) {
    try {
      const parsed = JSON.parse(msg) as { error?: string };
      if (parsed.error) {
        if (isFirestoreQuotaError(parsed.error)) {
          return 'Firebase Free Daily Read Quota aaj ke liye poora ho gaya hai. Ye quota kal automatically reset ho jayega, ya aap Firebase Console se database upgrade kar sakte hain.';
        }
        return parsed.error;
      }
    } catch {
      // fall through
    }
  }
  return msg;
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

const CONNECTION_CHECK_SESSION_KEY = 'vp_fs_conn_checked_v1';

export async function testFirestoreConnection(): Promise<void> {
  try {
    if (typeof window !== 'undefined' && window.sessionStorage?.getItem(CONNECTION_CHECK_SESSION_KEY)) {
      return;
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
