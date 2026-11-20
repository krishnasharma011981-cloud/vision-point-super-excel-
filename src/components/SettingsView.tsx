import { sendPasswordResetEmail } from 'firebase/auth';
import {
  AlertCircle,
  CheckCircle2,
  Database,
  Download,
  FileJson,
  FileSpreadsheet,
  HardDrive,
  KeyRound,
  Loader2,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  Upload,
  User,
  UserPlus,
  Users,
} from 'lucide-react';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { DEPARTMENT_LABELS, ROLE_LABELS } from '../constants/centres';
import { exportJsonBackup } from '../lib/csvUtils';
import {
  computeBackupSummary,
  exportFullInstitutionalWorkbookXlsx,
  extractRestorableStaffProfiles,
  type BackupSummaryCounts,
  type FullDatabaseBackupPayload,
  parseBackupJson,
  type RestorableStaffProfile,
} from '../lib/databaseBackup';
import { auth, CURRENT_FIREBASE_PROJECT_ID } from '../lib/firebase';
import {
  clearBackupVault,
  loadBackupFromVault,
  saveBackupToVault,
  type SavedRecoveryVaultEntry,
} from '../lib/recoveryVault';
import { provisionAuthUserOnServer } from '../lib/securityClient';
import {
  collectCompleteSnapshotForBackup,
  createStaffInvite,
  finalizeRestoredStaffAuthUid,
  restoreFullDatabaseBackup,
  type RestoreDatabaseResult,
  type RestoreProgressState,
  updateSystemSettings,
  updateUserAccount,
} from '../services/firestoreService';
import type {
  AdmissionRecord,
  Centre,
  EditRequest,
  EmployeeReport,
  ExcelSheetConfig,
  FeeRecoveryRecord,
  OnlineClassRecord,
  PracticalRecord,
  StaffInvite,
  Student,
  SystemSettings,
  TmaRecord,
  UserAccount,
  WorkAssignment,
  WorkAssignmentTask,
} from '../types/domain';

interface SettingsViewProps {
  currentUser: UserAccount;
  settings: SystemSettings | null;
  centres: Centre[];
  students: Student[];
  feeRecords: FeeRecoveryRecord[];
  practicalRecords: PracticalRecord[];
  tmaRecords: TmaRecord[];
  onlineClassRecords: OnlineClassRecord[];
  admissionRecords: AdmissionRecord[];
  sheetConfigs: ExcelSheetConfig[];
  workAssignments: WorkAssignment[];
  workAssignmentTasks: WorkAssignmentTask[];
  users: UserAccount[];
  staffInvites: StaffInvite[];
  employeeReports: EmployeeReport[];
  editRequests: EditRequest[];
  onNotify: (title: string, description: string, variant: 'success' | 'error' | 'warning' | 'info') => void;
}

export const SettingsView: React.FC<SettingsViewProps> = ({
  currentUser,
  settings,
  centres,
  students,
  feeRecords,
  practicalRecords,
  tmaRecords,
  onlineClassRecords,
  admissionRecords,
  sheetConfigs,
  workAssignments,
  workAssignmentTasks,
  users,
  staffInvites,
  employeeReports,
  editRequests,
  onNotify,
}) => {
  const [fullName, setFullName] = useState(currentUser.fullName);
  const [mobileNumber, setMobileNumber] = useState(currentUser.mobileNumber);
  const [savingProfile, setSavingProfile] = useState(false);

  const [geofenceEnabled, setGeofenceEnabled] = useState(settings?.geofenceEnabled ?? true);
  const [emergencyOverrideActive, setEmergencyOverrideActive] = useState(settings?.emergencyOverrideActive ?? false);
  const [sessionTimeoutMinutes, setSessionTimeoutMinutes] = useState(String(settings?.sessionTimeoutMinutes ?? 60));
  const [maxGpsAccuracyMeters, setMaxGpsAccuracyMeters] = useState(String(settings?.maxGpsAccuracyMeters ?? 500));
  const [savingSecurity, setSavingSecurity] = useState(false);

  // Full Backup, Recovery Vault & 1-Click Restore State (Super Admin only)
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [vaultEntry, setVaultEntry] = useState<SavedRecoveryVaultEntry | null>(null);
  const [loadingVault, setLoadingVault] = useState(true);
  const [backingUp, setBackingUp] = useState(false);
  const [backupStage, setBackupStage] = useState<string>('');

  const [uploadedBackup, setUploadedBackup] = useState<FullDatabaseBackupPayload | null>(null);
  const [uploadedSummary, setUploadedSummary] = useState<BackupSummaryCounts | null>(null);
  const [uploadedFileName, setUploadedFileName] = useState<string>('');
  const [parseError, setParseError] = useState<string | null>(null);

  const [restoring, setRestoring] = useState(false);
  const [restoreProgress, setRestoreProgress] = useState<RestoreProgressState | null>(null);
  const [restoreResult, setRestoreResult] = useState<RestoreDatabaseResult | null>(null);

  const [bulkStaffPassword, setBulkStaffPassword] = useState('');
  const [bulkActivating, setBulkActivating] = useState(false);
  const [staffPasswords, setStaffPasswords] = useState<Record<string, string>>({});
  const [provisioningEmail, setProvisioningEmail] = useState<string | null>(null);
  const [provisionedEmails, setProvisionedEmails] = useState<Record<string, boolean>>({});

  // Load saved local Recovery Vault snapshot on mount (survives switching Firebase projects!)
  useEffect(() => {
    if (currentUser.role !== 'super_admin') {
      setLoadingVault(false);
      return;
    }
    let mounted = true;
    void loadBackupFromVault()
      .then((entry) => {
        if (mounted) {
          setVaultEntry(entry);
          setLoadingVault(false);
        }
      })
      .catch(() => {
        if (mounted) setLoadingVault(false);
      });
    return () => {
      mounted = false;
    };
  }, [currentUser.role]);

  useEffect(() => {
    if (settings) {
      setGeofenceEnabled(settings.geofenceEnabled);
      setEmergencyOverrideActive(settings.emergencyOverrideActive);
      setSessionTimeoutMinutes(String(settings.sessionTimeoutMinutes));
      setMaxGpsAccuracyMeters(String(settings.maxGpsAccuracyMeters));
    }
  }, [settings]);

  // Active recovery source: Uploaded JSON file takes priority if chosen; otherwise Browser Recovery Vault
  const activeRecoveryBackup = uploadedBackup ?? vaultEntry?.backup ?? null;
  const activeRecoverySummary = useMemo(() => {
    if (uploadedSummary) return uploadedSummary;
    if (vaultEntry) return computeBackupSummary(vaultEntry.backup);
    return null;
  }, [uploadedSummary, vaultEntry]);

  const restorableStaff = useMemo<RestorableStaffProfile[]>(() => {
    if (!activeRecoveryBackup) return [];
    return extractRestorableStaffProfiles(
      activeRecoveryBackup.users || [],
      activeRecoveryBackup.staff_invites || [],
    );
  }, [activeRecoveryBackup]);

  const isMigratingToNewProject =
    Boolean(vaultEntry?.sourceProjectId) &&
    vaultEntry?.sourceProjectId !== CURRENT_FIREBASE_PROJECT_ID;

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingProfile(true);
    try {
      await updateUserAccount(
        currentUser.uid,
        { fullName: fullName.trim(), mobileNumber: mobileNumber.trim() },
        currentUser,
        currentUser.centreId,
      );
      onNotify('Profile Updated', 'Your personal contact details have been saved.', 'success');
    } catch (err) {
      onNotify('Profile Update Failed', err instanceof Error ? err.message : 'Unable to save profile.', 'error');
    } finally {
      setSavingProfile(false);
    }
  };

  const handleSendPasswordReset = async () => {
    try {
      await sendPasswordResetEmail(auth, currentUser.email);
      onNotify('Password Reset Sent', `A password reset email has been dispatched to ${currentUser.email}.`, 'success');
    } catch (err) {
      onNotify('Reset Failed', err instanceof Error ? err.message : 'Could not send reset email.', 'error');
    }
  };

  const handleSaveSecurity = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingSecurity(true);
    try {
      await updateSystemSettings(
        {
          geofenceEnabled,
          emergencyOverrideActive,
          sessionTimeoutMinutes: Math.min(1440, Math.max(5, Number(sessionTimeoutMinutes) || 60)),
          maxGpsAccuracyMeters: Math.min(5000, Math.max(20, Number(maxGpsAccuracyMeters) || 500)),
        },
        currentUser,
      );
      onNotify('Security Policy Saved', 'Global security and geofence parameters updated.', 'success');
    } catch (err) {
      onNotify('Settings Error', err instanceof Error ? err.message : 'Unable to update settings.', 'error');
    } finally {
      setSavingSecurity(false);
    }
  };

  const collectCompleteSnapshot = async () => {
    return collectCompleteSnapshotForBackup({
      actor: currentUser,
      fallbackState: {
        centres,
        students,
        feeRecords,
        practicalRecords,
        tmaRecords,
        onlineClassRecords,
        admissionRecords,
        sheetConfigs,
        workAssignments,
        workAssignmentTasks,
        users,
        staffInvites,
        employeeReports,
        editRequests,
        settings,
      },
      onProgress: (stage) => setBackupStage(stage),
    });
  };

  /**
   * 1-Click Complete Save:
   * 1. Collects ALL 14 collections across all 4 centres (Employee Management + Students + Excel + Fees + All Depts + Calling Work + Reports)
   * 2. Saves into persistent Browser Recovery Vault (IndexedDB) so 1-Click Recover works instantly on the new Firebase
   * 3. Downloads complete 10-sheet Excel workbook (.xlsx)
   * 4. Downloads complete offline Recovery JSON (.json)
   */
  const handleSaveCompleteBackup = async (mode: 'all' | 'excel' | 'json' = 'all') => {
    setBackingUp(true);
    setBackupStage('Collecting Employee Management & all 4 centres data...');
    try {
      const { backup, summary, usedCacheFallback } = await collectCompleteSnapshot();
      const dateStr = new Date().toISOString().slice(0, 10);

      if (mode === 'all') {
        setBackupStage('Saving snapshot to local 1-Click Recovery Vault...');
        const saved = await saveBackupToVault({
          backup,
          summary,
          savedBy: currentUser.email,
          sourceProjectId: CURRENT_FIREBASE_PROJECT_ID,
        });
        setVaultEntry(saved);
        setUploadedBackup(null);
        setUploadedSummary(null);
        setUploadedFileName('');

        setBackupStage('Generating complete 10-sheet Excel (.xlsx) & Recovery JSON...');
        exportFullInstitutionalWorkbookXlsx(backup, `shukra-complete-data-excel-${dateStr}.xlsx`);
        exportJsonBackup(`shukra-complete-recovery-${dateStr}.json`, backup);

        onNotify(
          'Complete Backup Saved & Ready for 1-Click Recover',
          `Saved ${summary.users + summary.staff_invites} employees/invites, ${summary.students} students (with Excel columns), ${summary.fee_recovery} fee records, and ${summary.totalDocuments} total records to Browser Vault + Excel (.xlsx) + JSON.${usedCacheFallback ? ' (Used local cache fallback where Firestore quota was limited.)' : ''}`,
          'success',
        );
      } else if (mode === 'excel') {
        exportFullInstitutionalWorkbookXlsx(backup, `shukra-complete-data-excel-${dateStr}.xlsx`);
        onNotify(
          'Complete Excel Workbook Downloaded',
          `Exported 10 sheets (${summary.users + summary.staff_invites} employees, ${summary.students} students with all Excel columns, fees, departments, calling work).`,
          'success',
        );
      } else {
        exportJsonBackup(`shukra-complete-recovery-${dateStr}.json`, backup);
        onNotify(
          'Recovery JSON Downloaded',
          `Saved ${summary.totalDocuments} total records including Employee Management & Excel configs.`,
          'success',
        );
      }
    } catch (err) {
      onNotify(
        'Backup Failed',
        err instanceof Error ? err.message : 'Unable to create complete backup.',
        'error',
      );
    } finally {
      setBackingUp(false);
      setBackupStage('');
    }
  };

  const handleBackupFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setParseError(null);
    setRestoreResult(null);
    setRestoreProgress(null);
    setUploadedFileName(file.name);

    try {
      const text = await file.text();
      const result = parseBackupJson(text);
      if (!result.ok) {
        setUploadedBackup(null);
        setUploadedSummary(null);
        setParseError(result.error);
        return;
      }
      setUploadedBackup(result.backup);
      setUploadedSummary(result.summary);
      // Also persist into the local Recovery Vault so 1-Click Recover remains available
      try {
        const saved = await saveBackupToVault({
          backup: result.backup,
          summary: result.summary,
          savedBy: currentUser.email,
          sourceProjectId: 'uploaded-json-file',
        });
        setVaultEntry(saved);
      } catch {
        // Vault save is best-effort
      }
      onNotify(
        'Backup File Loaded',
        `${result.summary.totalDocuments} records ready (${result.summary.users + result.summary.staff_invites} employees, ${result.summary.students} students). Click "Recover All Data Now" to restore.`,
        'info',
      );
    } catch {
      setParseError('Unable to read the selected file. Please select a valid .json recovery file.');
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleRunRestore = async () => {
    if (!activeRecoveryBackup) return;
    setRestoring(true);
    setRestoreResult(null);
    try {
      const result = await restoreFullDatabaseBackup(activeRecoveryBackup, currentUser, (prog) => {
        setRestoreProgress(prog);
      });
      setRestoreResult(result);
      onNotify(
        'All Data Recovered Successfully!',
        `Restored ${result.totalRestored} records (${result.restoredCounts.users || 0} employees, ${result.restoredCounts.staff_invites || 0} invites, ${result.restoredCounts.students || 0} students, ${result.restoredCounts.fee_recovery || 0} fees, ${result.restoredCounts.excel_sheet_configs || 0} Excel configs).`,
        'success',
      );
    } catch (err) {
      onNotify(
        'Recovery Failed',
        err instanceof Error ? err.message : 'Unable to recover backup into Firebase.',
        'error',
      );
    } finally {
      setRestoring(false);
    }
  };

  const provisionSingleStaff = async (staff: RestorableStaffProfile, password: string): Promise<'auth' | 'invite'> => {
    const provisioned = await provisionAuthUserOnServer({
      email: staff.email,
      password,
      fullName: staff.fullName,
      role: staff.role,
      centreId: staff.centreId,
      department: staff.department,
    });

    if (provisioned.mode === 'invite_fallback') {
      await createStaffInvite(
        {
          fullName: staff.fullName,
          email: staff.email,
          mobileNumber: staff.mobileNumber,
          role: staff.role,
          centreId: staff.centreId,
          department: staff.department,
          joiningDate: staff.joiningDate,
        },
        currentUser,
      );
      return 'invite';
    }

    await finalizeRestoredStaffAuthUid({
      staff,
      newUid: provisioned.uid,
      actor: currentUser,
    });
    return 'auth';
  };

  const handleProvisionRestoredStaff = async (staff: RestorableStaffProfile) => {
    const pwd = (staffPasswords[staff.email] || bulkStaffPassword || '').trim();
    if (pwd.length < 6) {
      onNotify('Password Required', 'Please enter at least a 6-character password for this staff account.', 'warning');
      return;
    }
    setProvisioningEmail(staff.email);
    try {
      const mode = await provisionSingleStaff(staff, pwd);
      setProvisionedEmails((prev) => ({ ...prev, [staff.email]: true }));
      onNotify(
        mode === 'auth' ? 'Staff Login Activated' : 'Staff Invite Created',
        mode === 'auth'
          ? `${staff.fullName} (${staff.email}) can now log in directly on this Firebase project.`
          : `Pending invite saved for ${staff.fullName} (${staff.email}).`,
        'success',
      );
    } catch (err) {
      onNotify('Activation Failed', err instanceof Error ? err.message : 'Unable to activate staff login.', 'error');
    } finally {
      setProvisioningEmail(null);
    }
  };

  const handleBulkActivateAllStaff = async () => {
    const pwd = bulkStaffPassword.trim();
    if (pwd.length < 6) {
      onNotify(
        'Common Password Required',
        'Kam se kam 6 characters ka common password daalein (e.g. 123456), fir sabhi employees ke login 1 click me activate ho jayenge.',
        'warning',
      );
      return;
    }
    const pendingList = restorableStaff.filter((s) => !provisionedEmails[s.email]);
    if (pendingList.length === 0) {
      onNotify('All Staff Already Activated', 'Sabhi restored staff accounts pehle se activate ho chuke hain.', 'info');
      return;
    }

    setBulkActivating(true);
    let authCount = 0;
    let inviteCount = 0;
    let failCount = 0;

    for (const staff of pendingList) {
      setProvisioningEmail(staff.email);
      try {
        const mode = await provisionSingleStaff(staff, pwd);
        if (mode === 'auth') authCount += 1;
        else inviteCount += 1;
        setProvisionedEmails((prev) => ({ ...prev, [staff.email]: true }));
      } catch {
        failCount += 1;
      }
    }

    setProvisioningEmail(null);
    setBulkActivating(false);
    onNotify(
      'Bulk Staff Login Activation Complete',
      `Activated ${authCount} direct logins${inviteCount > 0 ? `, ${inviteCount} invites` : ''}${failCount > 0 ? `, ${failCount} skipped/failed` : ''}. Sabhi employees ab naye Firebase par login kar sakte hain.`,
      failCount > 0 && authCount === 0 ? 'warning' : 'success',
    );
  };

  const handleClearVault = async () => {
    await clearBackupVault();
    setVaultEntry(null);
    setUploadedBackup(null);
    setUploadedSummary(null);
    setUploadedFileName('');
    setRestoreResult(null);
    onNotify('Local Recovery Vault Cleared', 'Browser ke andar save kiya gaya snapshot hata diya gaya hai.', 'info');
  };

  const progressPct =
    restoreProgress && restoreProgress.total > 0
      ? Math.min(100, Math.round((restoreProgress.processed / restoreProgress.total) * 100))
      : 0;

  return (
    <div className="space-y-6 max-w-5xl">
      {/* Super Admin: Complete Backup & 1-Click Recovery Hub (Top Priority for Firebase Migration) */}
      {currentUser.role === 'super_admin' && (
        <div className="bg-white rounded-xl border-2 border-[#D71920]/30 p-6 space-y-5 shadow-sm">
          <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-4 pb-4 border-b border-zinc-200">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-xl bg-red-50 border border-red-200 flex items-center justify-center shrink-0">
                <Database className="w-5 h-5 text-[#D71920]" />
              </div>
              <div>
                <h2 className="text-base font-extrabold text-black">
                  Complete Backup &amp; 1-Click Recovery (Firebase Migration Ready)
                </h2>
                <p className="text-xs text-zinc-700 mt-0.5 leading-relaxed">
                  <strong>Step 1:</strong> Naya Firebase connect karne se pehle <strong>Save Complete Backup</strong> dabayein —
                  Employee Management (saare staff + invites), saare Students, saare Excel columns/colors, Fees, TMA, Practical,
                  Online Classes, Admission, Calling Work aur Reports ek saath <strong>Browser Vault + Excel (.xlsx) + Recovery JSON</strong> me save ho jayenge.{' '}
                  <strong>Step 2:</strong> Naya Firebase connect hone ke baad bas <strong>1-Click Recover All Data Now</strong> dabayein — sab kuch wapas aa jayega!
                </p>
              </div>
            </div>
          </div>

          {/* Step 1: Primary Save Actions */}
          <div className="flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              onClick={() => void handleSaveCompleteBackup('all')}
              disabled={backingUp || restoring}
              className="inline-flex items-center gap-2 px-4 py-2.5 text-xs font-extrabold text-white btn-crimson-gloss rounded-lg whitespace-nowrap disabled:opacity-50"
            >
              {backingUp ? <Loader2 className="w-4 h-4 animate-spin" /> : <HardDrive className="w-4 h-4" />}
              {backingUp ? backupStage || 'Saving Complete Backup...' : 'Save Complete Backup (Vault + Excel + JSON)'}
            </button>

            <button
              type="button"
              onClick={() => void handleSaveCompleteBackup('excel')}
              disabled={backingUp || restoring}
              className="inline-flex items-center gap-1.5 px-3.5 py-2.5 text-xs font-bold text-emerald-900 bg-emerald-50 border border-emerald-300 hover:bg-emerald-100 rounded-lg whitespace-nowrap disabled:opacity-50"
            >
              <FileSpreadsheet className="w-4 h-4 text-emerald-700" />
              Download Complete Excel (.xlsx)
            </button>

            <button
              type="button"
              onClick={() => void handleSaveCompleteBackup('json')}
              disabled={backingUp || restoring}
              className="inline-flex items-center gap-1.5 px-3.5 py-2.5 text-xs font-semibold text-black bg-white border border-zinc-300 hover:bg-zinc-100 rounded-lg whitespace-nowrap disabled:opacity-50"
            >
              <Download className="w-3.5 h-3.5" />
              Download Recovery JSON
            </button>

            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={backingUp || restoring}
              className="inline-flex items-center gap-1.5 px-3.5 py-2.5 text-xs font-semibold text-black bg-zinc-100 border border-zinc-300 hover:bg-zinc-200 rounded-lg whitespace-nowrap disabled:opacity-50"
            >
              <Upload className="w-3.5 h-3.5" />
              Upload Backup JSON File
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json,application/json"
              onChange={handleBackupFileSelected}
              className="hidden"
            />
          </div>

          {/* Current Live Database Snapshot Overview */}
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2.5 text-xs">
            <div className="p-3 rounded-lg bg-zinc-50 border border-zinc-200">
              <p className="text-zinc-600 font-medium">Employees &amp; Invites</p>
              <p className="text-lg font-extrabold font-mono text-black mt-0.5">
                {users.length + staffInvites.length}
              </p>
            </div>
            <div className="p-3 rounded-lg bg-zinc-50 border border-zinc-200">
              <p className="text-zinc-600 font-medium">Students (Excel)</p>
              <p className="text-lg font-extrabold font-mono text-black mt-0.5">{students.length}</p>
            </div>
            <div className="p-3 rounded-lg bg-zinc-50 border border-zinc-200">
              <p className="text-zinc-600 font-medium">Fee Records</p>
              <p className="text-lg font-extrabold font-mono text-black mt-0.5">{feeRecords.length}</p>
            </div>
            <div className="p-3 rounded-lg bg-zinc-50 border border-zinc-200">
              <p className="text-zinc-600 font-medium">Calling Work</p>
              <p className="text-lg font-extrabold font-mono text-black mt-0.5">{workAssignments.length}</p>
            </div>
            <div className="p-3 rounded-lg bg-zinc-50 border border-zinc-200">
              <p className="text-zinc-600 font-medium">Excel Configs</p>
              <p className="text-lg font-extrabold font-mono text-black mt-0.5">{sheetConfigs.length}</p>
            </div>
          </div>

          {parseError && (
            <div className="p-3.5 rounded-lg bg-red-50 border border-red-200 text-xs text-red-800 flex items-start gap-2">
              <AlertCircle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
              <span>{parseError}</span>
            </div>
          )}

          {/* Step 2: Saved Recovery Vault / Uploaded Backup — 1-Click Recover Panel */}
          {!loadingVault && activeRecoveryBackup && activeRecoverySummary && (
            <div className="p-5 rounded-xl border-2 border-emerald-400 bg-emerald-50/40 space-y-4">
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div className="flex items-start gap-3 min-w-0">
                  <div className="w-10 h-10 rounded-xl bg-emerald-100 border border-emerald-300 flex items-center justify-center shrink-0">
                    {uploadedFileName ? (
                      <FileJson className="w-5 h-5 text-emerald-800" />
                    ) : (
                      <HardDrive className="w-5 h-5 text-emerald-800" />
                    )}
                  </div>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-extrabold text-black">
                        {uploadedFileName
                          ? `Loaded Backup: ${uploadedFileName}`
                          : 'Saved Backup Ready in Browser Recovery Vault'}
                      </p>
                      {isMigratingToNewProject && !uploadedFileName && (
                        <span className="px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wider bg-[#D71920] text-white rounded">
                          New Firebase Detected — Ready to Recover!
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-zinc-700 mt-0.5">
                      Total <strong className="text-black">{activeRecoverySummary.totalDocuments}</strong> records saved
                      {' · '}
                      <strong className="text-black">
                        {activeRecoverySummary.users + activeRecoverySummary.staff_invites}
                      </strong>{' '}
                      Employee Management records &amp;{' '}
                      <strong className="text-black">{activeRecoverySummary.students}</strong> Students with Excel columns
                      {vaultEntry && !uploadedFileName
                        ? ` · Saved ${new Date(vaultEntry.savedAt).toLocaleString()}`
                        : activeRecoveryBackup.exportedAt
                          ? ` · Exported ${activeRecoveryBackup.exportedAt.slice(0, 10)}`
                          : ''}
                    </p>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => void handleRunRestore()}
                    disabled={restoring || backingUp}
                    className="inline-flex items-center justify-center gap-2 px-5 py-2.5 text-xs font-extrabold text-white bg-emerald-700 hover:bg-emerald-800 rounded-lg shadow-sm disabled:opacity-60 whitespace-nowrap"
                  >
                    {restoring ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <RotateCcw className="w-4 h-4" />
                    )}
                    {restoring ? 'Recovering Everything...' : '1-Click Recover All Data Now'}
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      exportFullInstitutionalWorkbookXlsx(
                        activeRecoveryBackup,
                        `shukra-vault-excel-${new Date().toISOString().slice(0, 10)}.xlsx`,
                      )
                    }
                    className="inline-flex items-center gap-1.5 px-3 py-2.5 text-xs font-semibold text-black bg-white border border-zinc-300 hover:bg-zinc-100 rounded-lg whitespace-nowrap"
                    title="Download saved backup as 10-sheet Excel workbook"
                  >
                    <FileSpreadsheet className="w-3.5 h-3.5 text-emerald-700" />
                    Excel
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleClearVault()}
                    disabled={restoring}
                    className="inline-flex items-center gap-1 px-2.5 py-2.5 text-xs font-semibold text-zinc-700 bg-white border border-zinc-300 hover:bg-red-50 hover:text-red-700 hover:border-red-300 rounded-lg"
                    title="Clear saved local backup vault"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              {/* Complete 12-Collection Breakdown inside Saved Snapshot */}
              <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-6 gap-2 text-[11px]">
                {[
                  ['Employees', activeRecoverySummary.users],
                  ['Staff Invites', activeRecoverySummary.staff_invites],
                  ['Students', activeRecoverySummary.students],
                  ['Excel Configs', activeRecoverySummary.excel_sheet_configs],
                  ['Fees', activeRecoverySummary.fee_recovery],
                  ['Practical', activeRecoverySummary.practical_records],
                  ['TMA', activeRecoverySummary.tma_records],
                  ['Online Classes', activeRecoverySummary.online_class_records],
                  ['Admission', activeRecoverySummary.admission_records],
                  ['Work Batches', activeRecoverySummary.work_assignments],
                  ['Calling Tasks', activeRecoverySummary.work_assignment_tasks],
                  ['Daily Reports', activeRecoverySummary.employee_reports],
                ].map(([label, count]) => (
                  <div
                    key={String(label)}
                    className="px-2.5 py-2 rounded-lg bg-white border border-emerald-200 flex items-center justify-between"
                  >
                    <span className="text-zinc-600 font-medium truncate">{label}</span>
                    <span className="font-mono font-bold text-black ml-1">{count}</span>
                  </div>
                ))}
              </div>

              {restoring && restoreProgress && (
                <div className="space-y-1.5 pt-1">
                  <div className="flex items-center justify-between text-xs font-semibold text-black">
                    <span>{restoreProgress.stage}</span>
                    <span className="font-mono">{progressPct}%</span>
                  </div>
                  <div className="w-full h-2.5 rounded-full bg-emerald-100 overflow-hidden">
                    <div
                      className="h-full bg-emerald-700 transition-all duration-300"
                      style={{ width: `${progressPct}%` }}
                    />
                  </div>
                </div>
              )}

              {restoreResult && (
                <div className="p-3.5 rounded-lg bg-emerald-100/80 border border-emerald-300 text-xs text-emerald-950 flex items-start gap-2.5">
                  <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0 mt-0.5" />
                  <div>
                    <p className="font-extrabold">
                      Recovery Complete: {restoreResult.totalRestored} records restored into Firebase!
                    </p>
                    <p className="mt-0.5 text-emerald-900 leading-relaxed">
                      Employees: {restoreResult.restoredCounts.users || 0} · Staff Invites:{' '}
                      {restoreResult.restoredCounts.staff_invites || 0} · Students:{' '}
                      {restoreResult.restoredCounts.students || 0} · Excel Configs:{' '}
                      {restoreResult.restoredCounts.excel_sheet_configs || 0} · Fees:{' '}
                      {restoreResult.restoredCounts.fee_recovery || 0} · Practical:{' '}
                      {restoreResult.restoredCounts.practical_records || 0} · TMA:{' '}
                      {restoreResult.restoredCounts.tma_records || 0} · Work Batches:{' '}
                      {restoreResult.restoredCounts.work_assignments || 0} · Reports:{' '}
                      {restoreResult.restoredCounts.employee_reports || 0}
                      {restoreResult.skippedCount > 0 ? ` · Skipped: ${restoreResult.skippedCount}` : ''}
                      {restoreResult.failedCount > 0 ? ` · Failed: ${restoreResult.failedCount}` : ''}
                    </p>
                  </div>
                </div>
              )}

              {/* Step 3: 1-Click Bulk Staff Login Activation for New Firebase Auth */}
              {restorableStaff.length > 0 && (
                <div className="pt-3 border-t border-emerald-200 space-y-3">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <Users className="w-4 h-4 text-black" />
                      <p className="text-xs font-extrabold text-black">
                        Employee Management Login Activation ({restorableStaff.length} Staff &amp; Centre Heads)
                      </p>
                    </div>
                  </div>
                  <p className="text-[11px] text-zinc-700 leading-relaxed">
                    <strong>1-Click Recover</strong> se sabhi employees ki list Employee Management me aa jati hai. Naye
                    Firebase me unke Email &amp; Password login chalu karne ke liye niche ek common password daalkar{' '}
                    <strong>Activate All Staff Logins (1-Click)</strong> dabayein (ya alag-alag password set karein):
                  </p>

                  {/* 1-Click Bulk Activate Bar */}
                  <div className="p-3 rounded-lg bg-white border border-zinc-300 flex flex-col sm:flex-row sm:items-center gap-2.5">
                    <input
                      type="text"
                      placeholder="Common password for all staff (min 6 chars, e.g. 123456)"
                      value={bulkStaffPassword}
                      onChange={(e) => setBulkStaffPassword(e.target.value)}
                      className="flex-1 px-3 py-2 text-xs bg-white text-black border border-zinc-300 rounded-md focus:outline-none focus:ring-2 focus:ring-black"
                    />
                    <button
                      type="button"
                      disabled={bulkActivating || restoring}
                      onClick={() => void handleBulkActivateAllStaff()}
                      className="inline-flex items-center justify-center gap-1.5 px-4 py-2 text-xs font-extrabold text-white btn-crimson-gloss rounded-md disabled:opacity-50 whitespace-nowrap"
                    >
                      {bulkActivating ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <UserPlus className="w-3.5 h-3.5" />
                      )}
                      {bulkActivating
                        ? 'Activating Staff Logins...'
                        : `Activate All ${restorableStaff.length} Staff Logins (1-Click)`}
                    </button>
                  </div>

                  {/* Individual Staff Activation List */}
                  <div className="space-y-1.5 max-h-64 overflow-y-auto pr-1">
                    {restorableStaff.map((staff) => {
                      const isActivatedNow = Boolean(provisionedEmails[staff.email]);
                      return (
                        <div
                          key={staff.email}
                          className="p-2.5 rounded-lg bg-white border border-zinc-200 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5"
                        >
                          <div className="min-w-0">
                            <p className="text-xs font-bold text-black truncate">
                              {staff.fullName}{' '}
                              <span className="font-normal text-zinc-600">({ROLE_LABELS[staff.role]})</span>
                            </p>
                            <p className="text-[11px] text-zinc-600 truncate">
                              {staff.email} · {staff.centreName}
                              {staff.role === 'employee' ? ` · ${DEPARTMENT_LABELS[staff.department]}` : ''}
                              {staff.mobileNumber ? ` · ${staff.mobileNumber}` : ''}
                            </p>
                          </div>
                          {isActivatedNow ? (
                            <span className="inline-flex items-center gap-1 text-[11px] font-bold text-emerald-700 shrink-0">
                              <CheckCircle2 className="w-3.5 h-3.5" />
                              Login Activated
                            </span>
                          ) : (
                            <div className="flex items-center gap-2 shrink-0">
                              <input
                                type="password"
                                placeholder="Custom password (6+)"
                                value={staffPasswords[staff.email] || ''}
                                onChange={(e) =>
                                  setStaffPasswords((prev) => ({ ...prev, [staff.email]: e.target.value }))
                                }
                                className="w-36 px-2.5 py-1.5 text-xs bg-white text-black border border-zinc-300 rounded-md focus:outline-none focus:ring-1 focus:ring-black"
                              />
                              <button
                                type="button"
                                disabled={provisioningEmail === staff.email || bulkActivating}
                                onClick={() => void handleProvisionRestoredStaff(staff)}
                                className="px-3 py-1.5 text-[11px] font-bold text-white bg-black hover:bg-zinc-800 rounded-md disabled:opacity-50 whitespace-nowrap"
                              >
                                {provisioningEmail === staff.email ? 'Activating...' : 'Activate Login'}
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Personal Profile Management */}
      <div className="bg-white rounded-xl border border-zinc-200 p-6">
        <div className="flex items-center gap-2.5 pb-4 border-b border-zinc-200">
          <User className="w-5 h-5 text-black" />
          <div>
            <h2 className="text-base font-bold text-black">User Profile &amp; Credentials</h2>
            <p className="text-xs text-zinc-700">
              {ROLE_LABELS[currentUser.role]} · {currentUser.centreName} · {DEPARTMENT_LABELS[currentUser.department]}
            </p>
          </div>
        </div>

        <form onSubmit={handleSaveProfile} className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-semibold text-black mb-1">Full Name</label>
            <input
              type="text"
              required
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              className="w-full px-3.5 py-2 text-sm bg-white text-black border border-zinc-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-black"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-black mb-1">Mobile Number</label>
            <input
              type="tel"
              value={mobileNumber}
              onChange={(e) => setMobileNumber(e.target.value)}
              className="w-full px-3.5 py-2 text-sm font-mono bg-white text-black border border-zinc-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-black"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-black mb-1">Registered Email</label>
            <input
              type="text"
              disabled
              value={currentUser.email}
              className="w-full px-3.5 py-2 text-sm bg-zinc-100 border border-zinc-300 rounded-lg text-zinc-800 font-medium"
            />
          </div>
          <div className="flex items-end gap-3">
            <button
              type="submit"
              disabled={savingProfile}
              className="px-4 py-2 text-xs font-bold text-white btn-crimson-gloss rounded-lg disabled:opacity-50"
            >
              {savingProfile ? 'Saving...' : 'Save Profile'}
            </button>
            <button
              type="button"
              onClick={handleSendPasswordReset}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-black bg-white border border-zinc-300 rounded-lg hover:bg-zinc-100"
            >
              <KeyRound className="w-3.5 h-3.5" />
              Reset Password
            </button>
          </div>
        </form>
      </div>

      {/* Super Admin Global Security Controls */}
      {currentUser.role === 'super_admin' && (
        <div className="bg-white rounded-xl border border-zinc-200 p-6">
          <div className="flex items-center gap-2.5 pb-4 border-b border-zinc-200">
            <ShieldCheck className="w-5 h-5 text-black" />
            <div>
              <h2 className="text-base font-bold text-black">Global Security &amp; Geofence Policy</h2>
              <p className="text-xs text-zinc-700">
                Super Admin controls for physical branch presence enforcement and emergency overrides.
              </p>
            </div>
          </div>

          <form onSubmit={handleSaveSecurity} className="mt-5 space-y-4">
            <label className="flex items-start gap-3 p-3.5 rounded-xl border border-zinc-200 cursor-pointer hover:bg-zinc-50">
              <input
                type="checkbox"
                checked={geofenceEnabled}
                onChange={(e) => setGeofenceEnabled(e.target.checked)}
                className="mt-0.5 rounded border-zinc-400 text-black focus:ring-black"
              />
              <div>
                <p className="text-sm font-semibold text-black">Enforce Branch Geofence Verification</p>
                <p className="text-xs text-zinc-700 mt-0.5">
                  Requires Centre Heads and Employees to verify physical GPS presence at their assigned centre before modifying records.
                </p>
              </div>
            </label>

            <label className="flex items-start gap-3 p-3.5 rounded-xl border border-amber-300 bg-amber-50/50 cursor-pointer">
              <input
                type="checkbox"
                checked={emergencyOverrideActive}
                onChange={(e) => setEmergencyOverrideActive(e.target.checked)}
                className="mt-0.5 rounded border-amber-500 text-black focus:ring-black"
              />
              <div>
                <p className="text-sm font-semibold text-black flex items-center gap-1.5">
                  <ShieldAlert className="w-4 h-4 text-[#B45309]" />
                  Emergency Global Security Override
                </p>
                <p className="text-xs text-zinc-800 mt-0.5">
                  Temporarily permits authorized Centre Heads and Employees to submit updates remotely during network/GPS outages. All overridden actions remain logged.
                </p>
              </div>
            </label>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2">
              <div>
                <label className="block text-xs font-semibold text-black mb-1">
                  Session Inactivity Timeout (minutes)
                </label>
                <input
                  type="number"
                  min={5}
                  max={1440}
                  value={sessionTimeoutMinutes}
                  onChange={(e) => setSessionTimeoutMinutes(e.target.value)}
                  className="w-full px-3 py-2 text-sm font-mono bg-white text-black border border-zinc-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-black"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-black mb-1">
                  Max Allowed GPS Accuracy Radius (meters)
                </label>
                <input
                  type="number"
                  min={20}
                  max={5000}
                  value={maxGpsAccuracyMeters}
                  onChange={(e) => setMaxGpsAccuracyMeters(e.target.value)}
                  className="w-full px-3 py-2 text-sm font-mono bg-white text-black border border-zinc-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-black"
                />
              </div>
            </div>

            <div className="pt-2">
              <button
                type="submit"
                disabled={savingSecurity}
                className="px-5 py-2 text-xs font-bold text-white btn-crimson-gloss rounded-lg disabled:opacity-50"
              >
                {savingSecurity ? 'Updating Security Policy...' : 'Save Security Settings'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
