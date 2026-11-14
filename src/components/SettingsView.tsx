import { sendPasswordResetEmail } from 'firebase/auth';
import { Database, Download, KeyRound, ShieldAlert, ShieldCheck, User } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { DEPARTMENT_LABELS, ROLE_LABELS } from '../constants/centres';
import { exportJsonBackup } from '../lib/csvUtils';
import { auth } from '../lib/firebase';
import { updateSystemSettings, updateUserAccount } from '../services/firestoreService';
import type { Centre, Student, SystemSettings, UserAccount } from '../types/domain';

interface SettingsViewProps {
  currentUser: UserAccount;
  settings: SystemSettings | null;
  centres: Centre[];
  students: Student[];
  users: UserAccount[];
  onNotify: (title: string, description: string, variant: 'success' | 'error' | 'warning' | 'info') => void;
}

export const SettingsView: React.FC<SettingsViewProps> = ({
  currentUser,
  settings,
  centres,
  students,
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
    exportJsonBackup(`vision-point-backup-${new Date().toISOString().slice(0, 10)}.json`, {
      exportedAt: new Date().toISOString(),
      exportedBy: currentUser.email,
      centres,
      users,
      students,
      settings,
    });
    onNotify('Backup Created', `Exported complete JSON snapshot (${students.length} students, ${users.length} users).`, 'success');
  };

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

          {/* Data Backup & Governance */}
          <div className="bg-white rounded-xl border border-zinc-200 p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="flex items-start gap-3">
              <Database className="w-5 h-5 text-black shrink-0 mt-0.5" />
              <div>
                <h3 className="text-sm font-bold text-black">Institutional Data Backup</h3>
                <p className="text-xs text-zinc-700 mt-0.5">
                  Download a complete encrypted-transport JSON snapshot of all centres, staff accounts, student records, and system settings.
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={handleFullBackup}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-black bg-white border border-zinc-300 hover:bg-zinc-100 rounded-lg whitespace-nowrap shrink-0"
            >
              <Download className="w-3.5 h-3.5" />
              Download Backup JSON
            </button>
          </div>
        </>
      )}
    </div>
  );
};
