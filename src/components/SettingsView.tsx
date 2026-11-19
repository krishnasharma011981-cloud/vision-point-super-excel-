import { sendPasswordResetEmail } from 'firebase/auth';
import {
  AlertCircle,
  CheckCircle2,
  Database,
  Download,
  FileJson,
  KeyRound,
  Loader2,
  ShieldAlert,
  ShieldCheck,
  Upload,
  User,
  UserPlus,
} from 'lucide-react';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { CENTRE_MAP, DEPARTMENT_LABELS, ROLE_LABELS } from '../constants/centres';
import { exportJsonBackup } from '../lib/csvUtils';
import {
  buildFullDatabaseBackupPayload,
  type BackupSummaryCounts,
  type FullDatabaseBackupPayload,
  parseBackupJson,
  type RestorableStaffProfile,
} from '../lib/databaseBackup';
import { auth } from '../lib/firebase';
import { provisionAuthUserOnServer } from '../lib/securityClient';
import {
  createStaffInvite,
  restoreFullDatabaseBackup,
  type RestoreDatabaseResult,
  type RestoreProgressState,
  saveUserAccountDoc,
  updateSystemSettings,
  updateUserAccount,
} from '../services/firestoreService';
import type {
  AdmissionRecord,
  Centre,
  ExcelSheetConfig,
  FeeRecoveryRecord,
  OnlineClassRecord,
  PracticalRecord,
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

  // Full Backup & Restore State (Super Admin only)
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [parsedBackup, setParsedBackup] = useState<FullDatabaseBackupPayload | null>(null);
  const [parsedSummary, setParsedSummary] = useState<BackupSummaryCounts | null>(null);
  const [parsedFileName, setParsedFileName] = useState<string>('');
  const [restorableStaff, setRestorableStaff] = useState<RestorableStaffProfile[]>([]);
  const [parseError, setParseError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [restoreProgress, setRestoreProgress] = useState<RestoreProgressState | null>(null);
  const [restoreResult, setRestoreResult] = useState<RestoreDatabaseResult | null>(null);
  const [staffPasswords, setStaffPasswords] = useState<Record<string, string>>({});
  const [provisioningEmail, setProvisioningEmail] = useState<string | null>(null);
  const [provisionedEmails, setProvisionedEmails] = useState<Record<string, boolean>>({});

  const existingUserEmails = useMemo(
    () => new Set(users.map((u) => u.email.trim().toLowerCase())),
    [users],
  );

  useEffect(() => {
    if (settings) {
      setGeofenceEnabled(settings.geofenceEnabled);
      setEmergencyOverrideActive(settings.emergencyOverrideActive);
      setSessionTimeoutMinutes(String(settings.sessionTimeoutMinutes));
      setMaxGpsAccuracyMeters(String(settings.maxGpsAccuracyMeters));
    }
  }, [settings]);

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

  const handleFullBackup = () => {
    const payload = buildFullDatabaseBackupPayload({
      exportedBy: currentUser.email,
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
      settings,
    });
    exportJsonBackup(`vision-point-full-backup-${new Date().toISOString().slice(0, 10)}.json`, payload);
    onNotify(
      'Full Backup Downloaded',
      `Saved ${students.length} students, ${feeRecords.length} fee records, ${workAssignments.length} work batches, and all branch configurations.`,
      'success',
    );
  };

  const handleBackupFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setParseError(null);
    setRestoreResult(null);
    setRestoreProgress(null);
    setParsedFileName(file.name);

    try {
      const text = await file.text();
      const result = parseBackupJson(text);
      if (!result.ok) {
        setParsedBackup(null);
        setParsedSummary(null);
        setRestorableStaff([]);
        setParseError(result.error);
        return;
      }
      setParsedBackup(result.backup);
      setParsedSummary(result.summary);
      setRestorableStaff(result.staffProfiles);
    } catch {
      setParseError('Unable to read the selected file. Please select a valid .json backup file.');
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleRunRestore = async () => {
    if (!parsedBackup) return;
    setRestoring(true);
    setRestoreResult(null);
    try {
      const result = await restoreFullDatabaseBackup(parsedBackup, currentUser, (prog) => {
        setRestoreProgress(prog);
      });
      setRestoreResult(result);
      onNotify(
        'Database Restored Successfully',
        `Restored ${result.totalRestored} records into this Firebase database (${result.restoredCounts.students || 0} students, ${result.restoredCounts.fee_recovery || 0} fee records).`,
        'success',
      );
    } catch (err) {
      onNotify(
        'Restore Failed',
        err instanceof Error ? err.message : 'Unable to restore backup into Firestore.',
        'error',
      );
    } finally {
      setRestoring(false);
    }
  };

  const handleProvisionRestoredStaff = async (staff: RestorableStaffProfile) => {
    const pwd = (staffPasswords[staff.email] || '').trim();
    if (pwd.length < 6) {
      onNotify('Password Required', 'Please enter at least a 6-character password for this staff account.', 'warning');
      return;
    }
    setProvisioningEmail(staff.email);
    try {
      const provisioned = await provisionAuthUserOnServer({
        email: staff.email,
        password: pwd,
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
      } else {
        await saveUserAccountDoc(
          {
            uid: provisioned.uid,
            fullName: staff.fullName,
            email: provisioned.email,
            mobileNumber: staff.mobileNumber,
            role: staff.role,
            centreId: staff.centreId,
            centreName: CENTRE_MAP[staff.centreId].name,
            department: staff.department,
            status: staff.status,
            joiningDate: staff.joiningDate,
            createdBy: currentUser.uid,
            updatedBy: currentUser.uid,
          },
          currentUser,
        );
      }

      setProvisionedEmails((prev) => ({ ...prev, [staff.email]: true }));
      onNotify(
        'Staff Login Recreated',
        `${staff.fullName} (${staff.email}) can now log in directly with Email & Password.`,
        'success',
      );
    } catch (err) {
      onNotify('Account Creation Failed', err instanceof Error ? err.message : 'Unable to recreate staff login.', 'error');
    } finally {
      setProvisioningEmail(null);
    }
  };

  const progressPct =
    restoreProgress && restoreProgress.total > 0
      ? Math.min(100, Math.round((restoreProgress.processed / restoreProgress.total) * 100))
      : 0;

  return (
    <div className="space-y-6 max-w-4xl">
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
        <>
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

          {/* Full Institutional Database Backup & 1-Click Restore */}
          <div className="bg-white rounded-xl border border-zinc-200 p-6 space-y-5">
            <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4 pb-4 border-b border-zinc-200">
              <div className="flex items-start gap-3">
                <Database className="w-5 h-5 text-black shrink-0 mt-0.5" />
                <div>
                  <h3 className="text-base font-bold text-black">Full Database Backup &amp; Restore</h3>
                  <p className="text-xs text-zinc-700 mt-0.5">
                    Export all 4 centres, students, fees, TMA, practical, online classes, admission, Excel columns/colors,
                    and staff work assignments as a single JSON snapshot — or restore an existing backup JSON directly into
                    this Firebase database.
                  </p>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={handleFullBackup}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-black bg-white border border-zinc-300 hover:bg-zinc-100 rounded-lg whitespace-nowrap"
                >
                  <Download className="w-3.5 h-3.5" />
                  Download Full Backup
                </button>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={restoring}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-bold text-white btn-crimson-gloss rounded-lg whitespace-nowrap disabled:opacity-50"
                >
                  <Upload className="w-3.5 h-3.5" />
                  Restore Backup JSON
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".json,application/json"
                  onChange={handleBackupFileSelected}
                  className="hidden"
                />
              </div>
            </div>

            {/* Live Database Snapshot Counts */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 text-xs">
              <div className="p-3 rounded-lg bg-zinc-50 border border-zinc-200">
                <p className="text-zinc-600 font-medium">Students</p>
                <p className="text-lg font-extrabold font-mono text-black mt-0.5">{students.length}</p>
              </div>
              <div className="p-3 rounded-lg bg-zinc-50 border border-zinc-200">
                <p className="text-zinc-600 font-medium">Fee Records</p>
                <p className="text-lg font-extrabold font-mono text-black mt-0.5">{feeRecords.length}</p>
              </div>
              <div className="p-3 rounded-lg bg-zinc-50 border border-zinc-200">
                <p className="text-zinc-600 font-medium">Work Batches</p>
                <p className="text-lg font-extrabold font-mono text-black mt-0.5">{workAssignments.length}</p>
              </div>
              <div className="p-3 rounded-lg bg-zinc-50 border border-zinc-200">
                <p className="text-zinc-600 font-medium">Staff Accounts</p>
                <p className="text-lg font-extrabold font-mono text-black mt-0.5">{users.length}</p>
              </div>
            </div>

            {parseError && (
              <div className="p-3.5 rounded-lg bg-red-50 border border-red-200 text-xs text-red-800 flex items-start gap-2">
                <AlertCircle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
                <span>{parseError}</span>
              </div>
            )}

            {/* Parsed Backup Preview & Restore Execution */}
            {parsedBackup && parsedSummary && (
              <div className="p-4 rounded-xl border border-zinc-300 bg-zinc-50 space-y-4">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div className="flex items-start gap-2.5 min-w-0">
                    <FileJson className="w-5 h-5 text-[#B91C1C] shrink-0 mt-0.5" />
                    <div className="min-w-0">
                      <p className="text-sm font-bold text-black truncate">{parsedFileName}</p>
                      <p className="text-xs text-zinc-700">
                        Ready to restore <strong className="text-black">{parsedSummary.totalDocuments}</strong> documents
                        {parsedBackup.exportedAt ? ` · Exported ${parsedBackup.exportedAt.slice(0, 10)}` : ''}
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={handleRunRestore}
                    disabled={restoring}
                    className="inline-flex items-center justify-center gap-1.5 px-4 py-2 text-xs font-bold text-white btn-crimson-gloss rounded-lg disabled:opacity-60 shrink-0"
                  >
                    {restoring ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
                    {restoring ? 'Restoring Data...' : 'Start Full Restore Now'}
                  </button>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-[11px]">
                  {[
                    ['Centres', parsedSummary.centres],
                    ['Students', parsedSummary.students],
                    ['Fees', parsedSummary.fee_recovery],
                    ['Practical', parsedSummary.practical_records],
                    ['TMA', parsedSummary.tma_records],
                    ['Online Classes', parsedSummary.online_class_records],
                    ['Admission', parsedSummary.admission_records],
                    ['Excel Configs', parsedSummary.excel_sheet_configs],
                    ['Work Batches', parsedSummary.work_assignments],
                    ['Calling Tasks', parsedSummary.work_assignment_tasks],
                  ].map(([label, count]) => (
                    <div key={String(label)} className="px-2.5 py-2 rounded-lg bg-white border border-zinc-200 flex items-center justify-between">
                      <span className="text-zinc-600 font-medium">{label}</span>
                      <span className="font-mono font-bold text-black">{count}</span>
                    </div>
                  ))}
                </div>

                {restoring && restoreProgress && (
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between text-xs font-semibold text-black">
                      <span>{restoreProgress.stage}</span>
                      <span className="font-mono">{progressPct}%</span>
                    </div>
                    <div className="w-full h-2 rounded-full bg-zinc-200 overflow-hidden">
                      <div
                        className="h-full bg-[#D71920] transition-all duration-300"
                        style={{ width: `${progressPct}%` }}
                      />
                    </div>
                  </div>
                )}

                {restoreResult && (
                  <div className="p-3.5 rounded-lg bg-emerald-50 border border-emerald-200 text-xs text-emerald-900 flex items-start gap-2.5">
                    <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                    <div>
                      <p className="font-bold">
                        Restore Complete: {restoreResult.totalRestored} records saved to Firebase!
                      </p>
                      <p className="mt-0.5 text-emerald-800">
                        Students: {restoreResult.restoredCounts.students || 0} · Fees:{' '}
                        {restoreResult.restoredCounts.fee_recovery || 0} · Practical:{' '}
                        {restoreResult.restoredCounts.practical_records || 0} · TMA:{' '}
                        {restoreResult.restoredCounts.tma_records || 0} · Work Batches:{' '}
                        {restoreResult.restoredCounts.work_assignments || 0}
                        {restoreResult.skippedCount > 0 ? ` · Skipped: ${restoreResult.skippedCount}` : ''}
                        {restoreResult.failedCount > 0 ? ` · Failed: ${restoreResult.failedCount}` : ''}
                      </p>
                    </div>
                  </div>
                )}

                {/* 1-Click Staff Login Recreation from Backup */}
                {restorableStaff.length > 0 && (
                  <div className="pt-3 border-t border-zinc-200 space-y-2.5">
                    <div className="flex items-center gap-2">
                      <UserPlus className="w-4 h-4 text-black" />
                      <p className="text-xs font-bold text-black">
                        Staff &amp; Centre Head Accounts Found in Backup ({restorableStaff.length})
                      </p>
                    </div>
                    <p className="text-[11px] text-zinc-700">
                      Firebase security does not export passwords between projects. Set a password below to recreate any
                      staff login directly on this new Firebase project:
                    </p>
                    <div className="space-y-2 max-h-60 overflow-y-auto pr-1">
                      {restorableStaff.map((staff) => {
                        const alreadyExists =
                          existingUserEmails.has(staff.email) || Boolean(provisionedEmails[staff.email]);
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
                              </p>
                            </div>
                            {alreadyExists ? (
                              <span className="inline-flex items-center gap-1 text-[11px] font-bold text-emerald-700 shrink-0">
                                <CheckCircle2 className="w-3.5 h-3.5" />
                                Active in Database
                              </span>
                            ) : (
                              <div className="flex items-center gap-2 shrink-0">
                                <input
                                  type="password"
                                  placeholder="New password (6+)"
                                  value={staffPasswords[staff.email] || ''}
                                  onChange={(e) =>
                                    setStaffPasswords((prev) => ({ ...prev, [staff.email]: e.target.value }))
                                  }
                                  className="w-36 px-2.5 py-1.5 text-xs bg-white text-black border border-zinc-300 rounded-md focus:outline-none focus:ring-1 focus:ring-black"
                                />
                                <button
                                  type="button"
                                  disabled={provisioningEmail === staff.email}
                                  onClick={() => void handleProvisionRestoredStaff(staff)}
                                  className="px-3 py-1.5 text-[11px] font-bold text-white bg-black hover:bg-zinc-800 rounded-md disabled:opacity-50 whitespace-nowrap"
                                >
                                  {provisioningEmail === staff.email ? 'Creating...' : 'Create Login'}
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
        </>
      )}
    </div>
  );
};
