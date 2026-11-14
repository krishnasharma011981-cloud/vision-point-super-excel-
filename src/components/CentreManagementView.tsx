import {
  ArrowLeft,
  Briefcase,
  Building2,
  ClipboardCheck,
  Crosshair,
  Edit3,
  FlaskConical,
  IndianRupee,
  MapPin,
  MonitorPlay,
  Users,
  X,
} from 'lucide-react';
import React, { useMemo, useState } from 'react';
import { CANONICAL_CENTRES, DEPARTMENT_LABELS } from '../constants/centres';
import { formatDateTime } from '../lib/csvUtils';
import { updateCentreConfig } from '../services/firestoreService';
import type {
  ActivityLog,
  AdmissionRecord,
  Centre,
  CentreId,
  FeeRecoveryRecord,
  HrRecord,
  OnlineClassRecord,
  PracticalRecord,
  Student,
  TmaRecord,
  UserAccount,
} from '../types/domain';

interface CentreManagementViewProps {
  currentUser: UserAccount;
  centres: Centre[];
  users: UserAccount[];
  students: Student[];
  feeRecords: FeeRecoveryRecord[];
  practicalRecords: PracticalRecord[];
  tmaRecords: TmaRecord[];
  onlineClassRecords: OnlineClassRecord[];
  admissionRecords: AdmissionRecord[];
  hrRecords: HrRecord[];
  activityLogs: ActivityLog[];
  onNotify: (title: string, description: string, variant: 'success' | 'error' | 'warning' | 'info') => void;
}

export const CentreManagementView: React.FC<CentreManagementViewProps> = ({
  currentUser,
  centres,
  users,
  students,
  feeRecords,
  practicalRecords,
  tmaRecords,
  onlineClassRecords,
  admissionRecords,
  hrRecords,
  activityLogs,
  onNotify,
}) => {
  const [selectedCentreId, setSelectedCentreId] = useState<CentreId | null>(
    currentUser.role === 'super_admin' ? null : currentUser.centreId,
  );
  const [editingCentre, setEditingCentre] = useState<Centre | null>(null);
  const [latInput, setLatInput] = useState('');
  const [lngInput, setLngInput] = useState('');
  const [radiusInput, setRadiusInput] = useState('300');
  const [addressInput, setAddressInput] = useState('');
  const [saving, setSaving] = useState(false);

  const mergedCentres: Centre[] = useMemo(() => {
    return CANONICAL_CENTRES.map((canonical) => {
      const fromDb = centres.find((c) => c.id === canonical.id);
      return (
        fromDb || {
          ...canonical,
          createdAt: '',
          updatedAt: '',
          updatedBy: '',
        }
      );
    }).filter((c) => (currentUser.role === 'super_admin' ? true : c.id === currentUser.centreId));
  }, [centres, currentUser]);

  const activeCentre = selectedCentreId
    ? mergedCentres.find((c) => c.id === selectedCentreId) || mergedCentres[0]
    : null;

  const openGeoEditor = (centre: Centre) => {
    setEditingCentre(centre);
    setLatInput(String(centre.latitude));
    setLngInput(String(centre.longitude));
    setRadiusInput(String(centre.geofenceRadiusMeters));
    setAddressInput(centre.address);
  };

  const handleUseCurrentGps = () => {
    if (!navigator.geolocation) {
      onNotify('Geolocation Unavailable', 'Browser does not support geolocation.', 'error');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLatInput(pos.coords.latitude.toFixed(6));
        setLngInput(pos.coords.longitude.toFixed(6));
        onNotify('GPS Captured', 'Captured current device coordinates into geofence editor.', 'info');
      },
      () => {
        onNotify('GPS Permission Denied', 'Please enable browser location access to capture branch GPS.', 'error');
      },
      { enableHighAccuracy: true },
    );
  };

  const handleSaveGeo = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingCentre) return;
    setSaving(true);
    try {
      await updateCentreConfig(
        editingCentre.id,
        {
          latitude: Number(latInput),
          longitude: Number(lngInput),
          geofenceRadiusMeters: Math.max(20, Number(radiusInput) || 300),
          address: addressInput.trim(),
        },
        currentUser,
      );
      onNotify('Centre Geofence Updated', `Saved GPS boundary for ${editingCentre.name}.`, 'success');
      setEditingCentre(null);
    } catch (err) {
      onNotify('Update Failed', err instanceof Error ? err.message : 'Unable to update centre.', 'error');
    } finally {
      setSaving(false);
    }
  };

  if (activeCentre) {
    const cStudents = students
      .filter((s) => s.centreId === activeCentre.id)
      .slice()
      .sort((a, b) => Number(a.serialNumber || 0) - Number(b.serialNumber || 0));
    const cEmployees = users.filter((u) => u.centreId === activeCentre.id && u.role === 'employee');
    const cHead = users.find((u) => u.centreId === activeCentre.id && u.role === 'centre_head');
    const cFees = feeRecords.filter((f) => f.centreId === activeCentre.id);
    const cPractical = practicalRecords.filter((p) => p.centreId === activeCentre.id);
    const cTma = tmaRecords.filter((t) => t.centreId === activeCentre.id);
    const cOnline = onlineClassRecords.filter((o) => o.centreId === activeCentre.id);
    const cAdmissions = admissionRecords.filter((a) => a.centreId === activeCentre.id);
    const cHr = hrRecords.filter((h) => h.centreId === activeCentre.id);
    const cLogs = activityLogs.filter((l) => l.centreId === activeCentre.id).slice(0, 8);

    const feePaidTotal = cFees.reduce((acc, r) => acc + r.paidAmount, 0);
    const feePendingTotal = cFees.reduce((acc, r) => acc + r.pendingAmount, 0);
    const practicalDone = cStudents.filter((s) => s.practicalStatus === 'Completed').length;
    const tmaDone = cStudents.filter((s) => s.tmaStatus === 'Submitted').length;
    const regularClasses = cStudents.filter((s) => s.classAttendanceStatus === 'Regular').length;

    return (
      <div className="space-y-6">
        <div className="glass-light-card rounded-2xl border border-slate-200/80 p-6">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div>
              {currentUser.role === 'super_admin' && (
                <button
                  type="button"
                  onClick={() => setSelectedCentreId(null)}
                  className="inline-flex items-center gap-1.5 text-xs font-bold text-[#B91C1C] hover:text-[#0F172A] mb-2"
                >
                  <ArrowLeft className="w-3.5 h-3.5" />
                  Back to All 4 Centres
                </button>
              )}
              <h2 className="text-xl font-bold text-slate-900">{activeCentre.name}</h2>
              <p className="text-xs text-slate-700 mt-1">
                Branch Code: <span className="font-mono font-bold text-[#B91C1C]">{activeCentre.code}</span> ·{' '}
                {activeCentre.address} · Geofence Radius:{' '}
                <span className="font-mono font-bold text-[#0F172A]">{activeCentre.geofenceRadiusMeters}m</span>
              </p>
            </div>
            {currentUser.role === 'super_admin' && (
              <button
                type="button"
                onClick={() => openGeoEditor(activeCentre)}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-bold text-white btn-crimson-gloss rounded-xl whitespace-nowrap shadow-xs"
              >
                <Edit3 className="w-3.5 h-3.5" />
                Configure GPS Geofence
              </button>
            )}
          </div>

          <div className="mt-5 pt-5 border-t border-zinc-200 grid grid-cols-1 sm:grid-cols-3 gap-4 text-xs">
            <div className="p-3.5 rounded-lg bg-zinc-50 border border-zinc-200">
              <p className="text-zinc-700 font-medium">Assigned Centre Head</p>
              <p className="text-sm font-bold text-black mt-1">
                {cHead?.fullName || activeCentre.headName || 'Unassigned'}
              </p>
              <p className="text-[11px] text-zinc-600 mt-0.5">{cHead?.email || 'Assign in Employee Management'}</p>
            </div>
            <div className="p-3.5 rounded-lg bg-zinc-50 border border-zinc-200">
              <p className="text-zinc-700 font-medium">Total Students</p>
              <p className="text-2xl font-bold text-black font-mono tabular-nums mt-1">{cStudents.length}</p>
            </div>
            <div className="p-3.5 rounded-lg bg-zinc-50 border border-zinc-200">
              <p className="text-zinc-700 font-medium">Total Employees</p>
              <p className="text-2xl font-bold text-black font-mono tabular-nums mt-1">{cEmployees.length}</p>
            </div>
          </div>
        </div>

        {/* 6 Department Statistics Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-4">
          <div className="bg-white rounded-xl border border-zinc-200 p-4">
            <div className="flex items-center justify-between text-xs font-semibold text-zinc-700">
              <span>Fee Recovery</span>
              <IndianRupee className="w-4 h-4 text-emerald-700" />
            </div>
            <p className="text-lg font-bold text-emerald-700 font-mono mt-2">
              ₹{feePaidTotal.toLocaleString('en-IN')}
            </p>
            <p className="text-[11px] text-red-700 font-mono mt-0.5">
              Due: ₹{feePendingTotal.toLocaleString('en-IN')}
            </p>
          </div>

          <div className="bg-white rounded-xl border border-zinc-200 p-4">
            <div className="flex items-center justify-between text-xs font-semibold text-zinc-700">
              <span>Practical</span>
              <FlaskConical className="w-4 h-4 text-black" />
            </div>
            <p className="text-lg font-bold text-black font-mono mt-2">
              {practicalDone} / {cStudents.length}
            </p>
            <p className="text-[11px] text-zinc-600 mt-0.5">{cPractical.length} dept logs</p>
          </div>

          <div className="bg-white rounded-xl border border-zinc-200 p-4">
            <div className="flex items-center justify-between text-xs font-semibold text-zinc-700">
              <span>TMA</span>
              <ClipboardCheck className="w-4 h-4 text-black" />
            </div>
            <p className="text-lg font-bold text-black font-mono mt-2">
              {tmaDone} / {cStudents.length}
            </p>
            <p className="text-[11px] text-zinc-600 mt-0.5">{cTma.length} dept logs</p>
          </div>

          <div className="bg-white rounded-xl border border-zinc-200 p-4">
            <div className="flex items-center justify-between text-xs font-semibold text-zinc-700">
              <span>Online Classes</span>
              <MonitorPlay className="w-4 h-4 text-black" />
            </div>
            <p className="text-lg font-bold text-black font-mono mt-2">
              {regularClasses} / {cStudents.length}
            </p>
            <p className="text-[11px] text-zinc-600 mt-0.5">{cOnline.length} tracked</p>
          </div>

          <div className="bg-white rounded-xl border border-zinc-200 p-4">
            <div className="flex items-center justify-between text-xs font-semibold text-zinc-700">
              <span>Admission</span>
              <Users className="w-4 h-4 text-black" />
            </div>
            <p className="text-lg font-bold text-black font-mono mt-2">{cAdmissions.length || cStudents.length}</p>
            <p className="text-[11px] text-zinc-600 mt-0.5">Active enrollments</p>
          </div>

          <div className="bg-white rounded-xl border border-zinc-200 p-4">
            <div className="flex items-center justify-between text-xs font-semibold text-zinc-700">
              <span>HR Dept</span>
              <Briefcase className="w-4 h-4 text-[#B45309]" />
            </div>
            <p className="text-lg font-bold text-black font-mono mt-2">{cHr.length}</p>
            <p className="text-[11px] text-zinc-600 mt-0.5">Staff compliance logs</p>
          </div>
        </div>

        {/* Centre Students & Recent Activities */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
          <div className="lg:col-span-2 glass-light-card rounded-2xl border border-slate-200/80 overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
              <h3 className="text-sm font-bold text-slate-900">Branch Student Database ({cStudents.length})</h3>
            </div>
            {cStudents.length === 0 ? (
              <p className="p-6 text-xs text-slate-700">No students enrolled at this centre yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="bg-slate-50/90 border-b border-slate-200 text-[11px] font-bold text-slate-700 uppercase">
                      <th className="py-2.5 px-4">S.No</th>
                      <th className="py-2.5 px-4">Student Name</th>
                      <th className="py-2.5 px-4">Mobile</th>
                      <th className="py-2.5 px-4">TMA</th>
                      <th className="py-2.5 px-4">Practical</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
                    {cStudents.slice(0, 15).map((s, idx) => (
                      <tr key={s.studentId} className="hover:bg-sky-50/50">
                        <td className="py-2.5 px-4 font-mono font-bold text-slate-700 tabular-nums">
                          {String(idx + 1).padStart(4, '0')}
                        </td>
                        <td className="py-2.5 px-4 font-semibold text-slate-900">{s.studentName}</td>
                        <td className="py-2.5 px-4 font-mono text-slate-800">{s.mobileNumber}</td>
                        <td className="py-2.5 px-4 text-slate-800">{s.tmaStatus}</td>
                        <td className="py-2.5 px-4 text-slate-800">{s.practicalStatus}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="bg-white rounded-xl border border-zinc-200 p-5">
            <h3 className="text-sm font-bold text-black mb-3">Branch Staff &amp; Recent Activity</h3>
            <div className="space-y-2 mb-5">
              {cEmployees.length === 0 ? (
                <p className="text-xs text-zinc-700">No employees assigned yet.</p>
              ) : (
                cEmployees.map((emp) => (
                  <div key={emp.uid} className="flex items-center justify-between text-xs py-1.5 border-b border-zinc-200">
                    <span className="font-semibold text-black">{emp.fullName}</span>
                    <span className="text-zinc-700">{DEPARTMENT_LABELS[emp.department]}</span>
                  </div>
                ))
              )}
            </div>

            <h4 className="text-xs font-bold uppercase tracking-wider text-zinc-700 mb-2">Recent Activities</h4>
            <div className="space-y-2.5">
              {cLogs.length === 0 ? (
                <p className="text-xs text-zinc-700">No recent centre logs.</p>
              ) : (
                cLogs.map((l) => (
                  <div key={l.id || `${l.action}-${l.targetId}`} className="text-xs border-b border-zinc-200 pb-2">
                    <div className="flex justify-between gap-2">
                      <span className="font-semibold text-black">{l.action}</span>
                      <span className="font-mono text-[11px] text-zinc-600">{formatDateTime(l.createdAt)}</span>
                    </div>
                    <p className="text-[11px] text-zinc-700 mt-0.5">{l.details}</p>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        {/* GPS Geofence Edit Modal */}
        {editingCentre && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#040E24]/75 backdrop-blur-md p-4">
            <div className="glass-light-card rounded-2xl border border-slate-200 shadow-2xl max-w-md w-full p-6 text-slate-900">
              <div className="flex items-start justify-between pb-3 border-b border-zinc-200">
                <div>
                  <h3 className="text-base font-bold text-black">Configure Branch Geofence</h3>
                  <p className="text-xs text-zinc-700 mt-0.5">{editingCentre.name}</p>
                </div>
                <button type="button" onClick={() => setEditingCentre(null)} className="text-zinc-600 hover:text-black">
                  <X className="w-5 h-5" />
                </button>
              </div>
              <form onSubmit={handleSaveGeo} className="mt-4 space-y-3.5">
                <div>
                  <label className="block text-xs font-semibold text-black mb-1">Branch Address</label>
                  <input
                    type="text"
                    required
                    value={addressInput}
                    onChange={(e) => setAddressInput(e.target.value)}
                    className="w-full px-3 py-2 text-sm bg-white text-black border border-zinc-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-black"
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-semibold text-black mb-1">Latitude</label>
                    <input
                      type="number"
                      step="any"
                      required
                      value={latInput}
                      onChange={(e) => setLatInput(e.target.value)}
                      className="w-full px-3 py-2 text-sm font-mono bg-white text-black border border-zinc-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-black"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-black mb-1">Longitude</label>
                    <input
                      type="number"
                      step="any"
                      required
                      value={lngInput}
                      onChange={(e) => setLngInput(e.target.value)}
                      className="w-full px-3 py-2 text-sm font-mono bg-white text-black border border-zinc-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-black"
                    />
                  </div>
                </div>
                <button
                  type="button"
                  onClick={handleUseCurrentGps}
                  className="inline-flex items-center gap-1.5 text-xs font-bold text-[#B45309] hover:text-black"
                >
                  <Crosshair className="w-3.5 h-3.5" />
                  Use Current Device GPS Coordinates
                </button>
                <div>
                  <label className="block text-xs font-semibold text-black mb-1">
                    Authorized Geofence Radius (meters)
                  </label>
                  <input
                    type="number"
                    min={20}
                    max={10000}
                    required
                    value={radiusInput}
                    onChange={(e) => setRadiusInput(e.target.value)}
                    className="w-full px-3 py-2 text-sm font-mono bg-white text-black border border-zinc-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-black"
                  />
                </div>
                <div className="flex justify-end gap-2.5 pt-2">
                  <button
                    type="button"
                    onClick={() => setEditingCentre(null)}
                    className="px-4 py-2 text-xs font-semibold text-black bg-white hover:bg-zinc-100 border border-zinc-300 rounded-lg"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={saving}
                    className="px-4 py-2 text-xs font-bold text-white btn-crimson-gloss rounded-lg disabled:opacity-50"
                  >
                    {saving ? 'Saving...' : 'Save Geofence'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-xl border border-zinc-200 p-5">
        <h2 className="text-lg font-bold text-black">Centre Management</h2>
        <p className="text-xs text-zinc-700 mt-1">
          Select an educational branch to inspect complete department statistics, staff rosters, and student records.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        {mergedCentres.map((centre) => {
          const cStudents = students.filter((s) => s.centreId === centre.id);
          const cEmployees = users.filter((u) => u.centreId === centre.id && u.role === 'employee');
          const cHead = users.find((u) => u.centreId === centre.id && u.role === 'centre_head');
          const pendingTma = cStudents.filter((s) => s.tmaStatus !== 'Submitted').length;
          const pendingPrac = cStudents.filter((s) => s.practicalStatus !== 'Completed').length;

          return (
            <button
              key={centre.id}
              type="button"
              onClick={() => setSelectedCentreId(centre.id)}
              className="text-left bg-white rounded-2xl border border-zinc-200 hover:border-black hover:shadow-md transition-all p-6 flex flex-col justify-between gap-5"
            >
              <div>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-xs font-mono font-bold text-[#B45309]">
                      {centre.code} · {centre.city}
                    </p>
                    <h3 className="text-lg font-bold text-black mt-1">{centre.name}</h3>
                  </div>
                  <div className="p-2.5 rounded-xl bg-gradient-to-br from-[#EF4444] to-[#991B1B] border border-red-300/35 text-white shadow-xs">
                    <Building2 className="w-5 h-5" />
                  </div>
                </div>

                <p className="text-xs text-zinc-700 mt-2 flex items-center gap-1.5">
                  <MapPin className="w-3.5 h-3.5 text-zinc-600 shrink-0" />
                  <span className="truncate">{centre.address}</span>
                </p>
              </div>

              <div className="grid grid-cols-3 gap-3 pt-4 border-t border-zinc-200">
                <div>
                  <p className="text-[11px] text-zinc-700 font-medium">Students</p>
                  <p className="text-lg font-bold text-black font-mono tabular-nums">{cStudents.length}</p>
                </div>
                <div>
                  <p className="text-[11px] text-zinc-700 font-medium">Employees</p>
                  <p className="text-lg font-bold text-black font-mono tabular-nums">{cEmployees.length}</p>
                </div>
                <div>
                  <p className="text-[11px] text-zinc-700 font-medium">Pending Tasks</p>
                  <p className="text-lg font-bold text-[#B45309] font-mono tabular-nums">
                    {pendingTma + pendingPrac}
                  </p>
                </div>
              </div>

              <div className="flex items-center justify-between text-xs pt-3 border-t border-zinc-200 text-zinc-700">
                <span>
                  Centre Head: <strong className="text-black">{cHead?.fullName || centre.headName}</strong>
                </span>
                <span className="font-bold text-black">Open Centre →</span>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
};
