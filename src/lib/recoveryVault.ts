import type { BackupSummaryCounts, FullDatabaseBackupPayload } from './databaseBackup';

export interface SavedRecoveryVaultEntry {
  id: 'latest';
  savedAt: string;
  savedBy: string;
  sourceProjectId: string;
  summary: BackupSummaryCounts;
  backup: FullDatabaseBackupPayload;
}

const DB_NAME = 'shukra_institutional_recovery_vault_v1';
const DB_VERSION = 1;
const STORE_NAME = 'snapshots';
const LATEST_KEY = 'latest';

function openVaultDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof window === 'undefined' || typeof window.indexedDB === 'undefined') {
      reject(new Error('Browser IndexedDB is not available in this environment.'));
      return;
    }
    const request = window.indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Failed to open local Recovery Vault.'));
  });
}

export async function saveBackupToVault(params: {
  backup: FullDatabaseBackupPayload;
  summary: BackupSummaryCounts;
  savedBy: string;
  sourceProjectId: string;
}): Promise<SavedRecoveryVaultEntry> {
  const entry: SavedRecoveryVaultEntry = {
    id: LATEST_KEY,
    savedAt: new Date().toISOString(),
    savedBy: params.savedBy,
    sourceProjectId: params.sourceProjectId,
    summary: params.summary,
    backup: params.backup,
  };

  const db = await openVaultDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.put(entry);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error ?? new Error('Unable to write snapshot to Recovery Vault.'));
      tx.onerror = () => reject(tx.error ?? new Error('Recovery Vault transaction failed.'));
    });
    return entry;
  } finally {
    db.close();
  }
}

export async function loadBackupFromVault(): Promise<SavedRecoveryVaultEntry | null> {
  if (typeof window === 'undefined' || typeof window.indexedDB === 'undefined') {
    return null;
  }
  let db: IDBDatabase | null = null;
  try {
    db = await openVaultDb();
    const result = await new Promise<SavedRecoveryVaultEntry | null>((resolve, reject) => {
      const tx = db!.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(LATEST_KEY);
      req.onsuccess = () => {
        const val = req.result as SavedRecoveryVaultEntry | undefined;
        resolve(val && val.backup ? val : null);
      };
      req.onerror = () => reject(req.error ?? new Error('Failed to read local Recovery Vault.'));
    });
    return result;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

export async function clearBackupVault(): Promise<void> {
  if (typeof window === 'undefined' || typeof window.indexedDB === 'undefined') {
    return;
  }
  let db: IDBDatabase | null = null;
  try {
    db = await openVaultDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db!.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.delete(LATEST_KEY);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error ?? new Error('Failed to clear Recovery Vault.'));
    });
  } finally {
    db?.close();
  }
}
