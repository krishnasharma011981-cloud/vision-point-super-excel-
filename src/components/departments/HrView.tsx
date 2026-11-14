import {
  Briefcase,
  CalendarCheck,
  CheckCircle2,
  Clock,
  Download,
  Edit3,
  Search,
  UserCheck,
  Users,
  X,
} from 'lucide-react';
import React, { useMemo, useState } from 'react';
import { CENTRE_MAP, DEPARTMENT_LABELS, ROLE_LABELS } from '../../constants/centres';
import { exportToCsv } from '../../lib/csvUtils';
import { verifyOperationLocation } from '../../lib/securityClient';
import { upsertHrRecord } from '../../services/firestoreService';
import type {
  CentreId,
  HrAttendanceStatus,
  HrOnboardingStatus,
  HrPayrollStatus,
  HrRecord,
  UserAccount,
} from '../../types/domain';

interface HrViewProps {
  employees: UserAccount[];
  hrRecords: HrRecord[];
  currentUser: UserAccount;
  selectedCentreFilter: CentreId | 'all';
  globalSearch: string;
  onNotify: (title: string, description: string, variant: 'success' | 'error' | 'warning' | 'info') => void;
}

const HrSparkWave: React.FC<{ stroke: string; fillId: string; path: string }> = ({ stroke, fillId, path }) => (
  <svg viewBox="0 0 90 30" className="w-20 h-7 shrink-0 overflow-visible" aria-hidden="true">
    <defs>
      <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor={stroke} stopOpacity="0.28" />
        <stop offset="100%" stopColor={stroke} stopOpacity="0" />
      </linearGradient>
    </defs>
    <path d={`${path} L 90 30 L 0 30 Z`} fill={`url(#${fillId})`} />
    <path d={path} fill="none" stroke={stroke} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const HrView: React.FC<HrViewProps> = ({
  employees,
  hrRecords,
  currentUser,
  selectedCentreFilter,
  globalSearch,
  onNotify,
}) => {
  const currentMonth = new Date().toISOString().slice(0, 7);
  const [selectedMonth, setSelectedMonth] = useState(currentMonth);
  const [search, setSearch] = useState('');
  const [payrollFilter, setPayrollFilter] = useState('all');

  const [editingStaff, setEditingStaff] = useState<UserAccount | null>(null);
  const [attendanceStatus, setAttendanceStatus] = useState<HrAttendanceStatus>('Present');
  const [onboardingStatus, setOnboardingStatus] = useState<HrOnboardingStatus>('Verified');
  const [payrollStatus, setPayrollStatus] = useState<HrPayrollStatus>('Pending');
  const [leaveDaysCount, setLeaveDaysCount] = useState('0');
  const [remarks, setRemarks] = useState('');
  const [saving, setSaving] = useState(false);

  const effectiveCentre =
    currentUser.role === 'super_admin' ? selectedCentreFilter : currentUser.centreId;
  const combinedSearch = (search || globalSearch).trim().toLowerCase();

  const recMap = useMemo(() => {
    const map = new Map<string, HrRecord>();
    hrRecords
      .filter((r) => r.recordMonth === selectedMonth)
      .forEach((r) => map.set(r.staffUid, r));
    return map;
  }, [hrRecords, selectedMonth]);

  const rows = useMemo(() => {
    return employees
      .filter((u) => u.role !== 'super_admin')
      .filter((u) => (effectiveCentre === 'all' ? true : u.centreId === effectiveCentre))
      .map((u) => {
        const rec = recMap.get(u.uid);
        return {
          staff: u,
          attendanceStatus: rec?.attendanceStatus || 'Present',
          onboardingStatus: rec?.onboardingStatus || 'Verified',
          payrollStatus: rec?.payrollStatus || 'Pending',
          leaveDaysCount: rec?.leaveDaysCount ?? 0,
          remarks: rec?.remarks || '',
        };
      })
      .filter((r) => (payrollFilter === 'all' ? true : r.payrollStatus === payrollFilter))
      .filter((r) => {
        if (!combinedSearch) return true;
        return (
          r.staff.fullName.toLowerCase().includes(combinedSearch) ||
          r.staff.email.toLowerCase().includes(combinedSearch) ||
          r.staff.mobileNumber.toLowerCase().includes(combinedSearch)
        );
      });
  }, [employees, recMap, effectiveCentre, payrollFilter, combinedSearch]);

  const verifiedOnboardingCount = rows.filter(
    (r) => r.onboardingStatus === 'Verified' || r.onboardingStatus === 'Completed',
  ).length;
  const processedPayrollCount = rows.filter((r) => r.payrollStatus === 'Processed').length;
  const presentCount = rows.filter((r) => r.attendanceStatus === 'Present').length;

  const openEditor = (staff: UserAccount) => {
    const rec = recMap.get(staff.uid);
    setEditingStaff(staff);
    setAttendanceStatus(rec?.attendanceStatus || 'Present');
    setOnboardingStatus(rec?.onboardingStatus || 'Verified');
    setPayrollStatus(rec?.payrollStatus || 'Pending');
    setLeaveDaysCount(String(rec?.leaveDaysCount ?? 0));
    setRemarks(rec?.remarks || '');
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingStaff) return;
    setSaving(true);
    try {
      const loc = await verifyOperationLocation(
        currentUser,
        `HR_RECORD_UPDATE:${editingStaff.uid}`,
        editingStaff.centreId,
      );
      if (!loc.allowed) {
        onNotify('Access Denied', loc.error || 'Physical presence required at assigned centre.', 'error');
        setSaving(false);
        return;
      }

      const cleanMonth = selectedMonth.replace(/[^a-zA-Z0-9_-]/g, '_');
      const recordId = `hr_${editingStaff.uid}_${cleanMonth}`.slice(0, 128);

      await upsertHrRecord(
        {
          recordId,
          staffUid: editingStaff.uid,
          staffName: editingStaff.fullName,
          staffEmail: editingStaff.email,
          staffDepartment: editingStaff.department,
          centreId: editingStaff.centreId,
          recordMonth: selectedMonth,
          attendanceStatus,
          onboardingStatus,
          payrollStatus,
          leaveDaysCount: Math.min(31, Math.max(0, Number(leaveDaysCount) || 0)),
          remarks: remarks.trim(),
        },
        currentUser,
        true,
      );
      onNotify('HR Record Updated', `Saved HR profile for ${editingStaff.fullName} (${selectedMonth}).`, 'success');
      setEditingStaff(null);
    } catch (err) {
      onNotify('Update Failed', err instanceof Error ? err.message : 'Unable to save HR record.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleExport = () => {
    exportToCsv(
      `hr-staff-records-${effectiveCentre}-${selectedMonth}.csv`,
      [
        'Staff Name',
        'Email',
        'Role',
        'Centre',
        'Department',
        'Month',
        'Attendance',
        'Leave Days',
        'Onboarding',
        'Payroll Status',
        'Remarks',
      ],
      rows.map((r) => [
        r.staff.fullName,
        r.staff.email,
        ROLE_LABELS[r.staff.role],
        CENTRE_MAP[r.staff.centreId]?.name || r.staff.centreName,
        DEPARTMENT_LABELS[r.staff.department],
        selectedMonth,
        r.attendanceStatus,
        r.leaveDaysCount,
        r.onboardingStatus,
        r.payrollStatus,
        r.remarks,
      ]),
    );
    onNotify('HR Report Exported', `Downloaded ${rows.length} staff HR records.`, 'success');
  };

  return (
    <div className="space-y-5">
      {/* KPI Metrics matching interior dashboard sparkline style */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white rounded-2xl border border-rose-200/80 p-4 flex items-center justify-between gap-2 shadow-xs">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-11 h-11 rounded-xl bg-rose-50 border border-rose-100 flex items-center justify-center text-[#DC2626] shrink-0">
              <Users className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <p className="text-xs font-semibold text-slate-600 truncate">Tracked Branch Staff</p>
              <p className="text-2xl font-extrabold text-[#0F172A] font-mono tabular-nums leading-tight mt-0.5">
                {rows.length}
              </p>
            </div>
          </div>
          <HrSparkWave stroke="#EF4444" fillId="hrSpark1" path="M0 24 Q 18 12, 38 20 T 90 10" />
        </div>

        <div className="bg-white rounded-2xl border border-emerald-200/80 p-4 flex items-center justify-between gap-2 shadow-xs">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-11 h-11 rounded-xl bg-emerald-50 border border-emerald-100 flex items-center justify-center text-emerald-700 shrink-0">
              <CalendarCheck className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <p className="text-xs font-semibold text-slate-600 truncate">Present Today</p>
              <p className="text-2xl font-extrabold text-[#0F172A] font-mono tabular-nums leading-tight mt-0.5">
                {presentCount}
              </p>
            </div>
          </div>
          <HrSparkWave stroke="#10B981" fillId="hrSpark2" path="M0 22 Q 22 26, 46 14 T 90 8" />
        </div>

        <div className="bg-white rounded-2xl border border-amber-200/80 p-4 flex items-center justify-between gap-2 shadow-xs">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-11 h-11 rounded-xl bg-amber-50 border border-amber-100 flex items-center justify-center text-[#D97706] shrink-0">
              <UserCheck className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <p className="text-xs font-semibold text-slate-600 truncate">Onboarding Verified</p>
              <p className="text-2xl font-extrabold text-[#0F172A] font-mono tabular-nums leading-tight mt-0.5">
                {verifiedOnboardingCount}
              </p>
            </div>
          </div>
          <HrSparkWave stroke="#F59E0B" fillId="hrSpark3" path="M0 20 Q 24 6, 48 18 T 90 12" />
        </div>

        <div className="bg-white rounded-2xl border border-violet-200/80 p-4 flex items-center justify-between gap-2 shadow-xs">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-11 h-11 rounded-xl bg-violet-50 border border-violet-100 flex items-center justify-center text-violet-700 shrink-0">
              <Briefcase className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <p className="text-xs font-semibold text-slate-600 truncate">Payroll Processed ({selectedMonth})</p>
              <p className="text-2xl font-extrabold text-[#0F172A] font-mono tabular-nums leading-tight mt-0.5">
                {processedPayrollCount}
              </p>
            </div>
          </div>
          <HrSparkWave stroke="#7C3AED" fillId="hrSpark4" path="M0 24 Q 20 20, 44 10 T 90 14" />
        </div>
      </div>

      {/* Filters Toolbar */}
      <div className="bg-white rounded-2xl border border-slate-200 p-4 flex flex-col lg:flex-row lg:items-center justify-between gap-3 shadow-xs">
        <div className="flex flex-1 flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[220px]">
            <Search className="w-4 h-4 text-[#DC2626] absolute left-3.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search staff by name, email, or phone..."
              className="w-full pl-10 pr-3.5 py-2 text-sm bg-slate-50 text-[#0F172A] placeholder:text-slate-400 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-red-500/30 focus:border-red-500 focus:bg-white"
            />
          </div>
          <input
            type="month"
            value={selectedMonth}
            onChange={(e) => setSelectedMonth(e.target.value)}
            aria-label="HR Record Month"
            className="px-3.5 py-2 text-sm font-mono font-semibold border border-slate-200 rounded-xl bg-white text-[#0F172A] focus:outline-none focus:ring-2 focus:ring-red-500/30 focus:border-red-500"
          />
          <select
            value={payrollFilter}
            onChange={(e) => setPayrollFilter(e.target.value)}
            className="px-3.5 py-2 text-sm font-semibold border border-slate-200 rounded-xl bg-white text-[#0F172A] focus:outline-none focus:ring-2 focus:ring-red-500/30 focus:border-red-500"
          >
            <option value="all">All Payroll Statuses</option>
            <option value="Processed">Processed</option>
            <option value="Pending">Pending</option>
            <option value="On Hold">On Hold</option>
          </select>
        </div>

        <button
          type="button"
          onClick={handleExport}
          className="inline-flex items-center gap-2 px-4 py-2 text-xs font-bold text-white btn-crimson-gloss rounded-xl whitespace-nowrap shrink-0 transition-all"
        >
          <Download className="w-3.5 h-3.5" />
          Export HR Register
        </button>
      </div>

      {/* HR Staff Table */}
      <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden shadow-xs">
        {rows.length === 0 ? (
          <div className="p-10 text-center text-xs text-slate-600">
            <Briefcase className="w-8 h-8 text-slate-400 mx-auto mb-2" />
            No branch staff profiles match your filter criteria.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200 text-[11px] font-bold text-slate-600 uppercase tracking-wider">
                  <th className="py-3.5 px-4">Staff Member</th>
                  <th className="py-3.5 px-4">Centre</th>
                  <th className="py-3.5 px-4">Department</th>
                  <th className="py-3.5 px-4">Attendance</th>
                  <th className="py-3.5 px-4">Leave Days</th>
                  <th className="py-3.5 px-4">Onboarding</th>
                  <th className="py-3.5 px-4">Payroll</th>
                  <th className="py-3.5 px-4 text-right">Update HR</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-xs">
                {rows.map((r) => (
                  <tr key={r.staff.uid} className="hover:bg-rose-50/40 transition-colors">
                    <td className="py-3.5 px-4">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-full bg-gradient-to-br from-[#DC2626] to-[#991B1B] text-white font-bold text-xs flex items-center justify-center shrink-0 shadow-xs">
                          {r.staff.fullName.charAt(0).toUpperCase()}
                        </div>
                        <div>
                          <p className="font-bold text-[#0F172A] uppercase tracking-tight">{r.staff.fullName}</p>
                          <p className="text-[11px] text-slate-500">
                            {r.staff.email} · {ROLE_LABELS[r.staff.role]}
                          </p>
                        </div>
                      </div>
                    </td>
                    <td className="py-3.5 px-4 font-mono font-bold text-slate-700">
                      {CENTRE_MAP[r.staff.centreId]?.code || r.staff.centreName}
                    </td>
                    <td className="py-3.5 px-4 font-medium text-slate-800">{DEPARTMENT_LABELS[r.staff.department]}</td>
                    <td className="py-3.5 px-4">
                      <span
                        className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold ${
                          r.attendanceStatus === 'Present'
                            ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                            : r.attendanceStatus === 'Absent'
                              ? 'bg-red-50 text-red-700 border border-red-200'
                              : 'bg-amber-50 text-amber-800 border border-amber-200'
                        }`}
                      >
                        <span
                          className={`w-1.5 h-1.5 rounded-full ${
                            r.attendanceStatus === 'Present'
                              ? 'bg-emerald-600'
                              : r.attendanceStatus === 'Absent'
                                ? 'bg-red-600'
                                : 'bg-amber-600'
                          }`}
                        />
                        {r.attendanceStatus}
                      </span>
                    </td>
                    <td className="py-3.5 px-4 font-mono tabular-nums font-bold text-[#0F172A]">
                      {r.leaveDaysCount}
                    </td>
                    <td className="py-3.5 px-4">
                      <span
                        className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-semibold ${
                          r.onboardingStatus === 'Verified' || r.onboardingStatus === 'Completed'
                            ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                            : 'bg-amber-50 text-amber-800 border border-amber-200'
                        }`}
                      >
                        <CheckCircle2 className="w-3 h-3" />
                        {r.onboardingStatus}
                      </span>
                    </td>
                    <td className="py-3.5 px-4">
                      <span
                        className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-semibold ${
                          r.payrollStatus === 'Processed'
                            ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                            : r.payrollStatus === 'On Hold'
                              ? 'bg-red-50 text-red-700 border border-red-200'
                              : 'bg-amber-50 text-amber-800 border border-amber-200'
                        }`}
                      >
                        <Clock className="w-3 h-3" />
                        {r.payrollStatus}
                      </span>
                    </td>
                    <td className="py-3.5 px-4 text-right">
                      <button
                        type="button"
                        onClick={() => openEditor(r.staff)}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-rose-50 hover:text-[#B91C1C] border border-slate-200 rounded-lg transition-colors"
                      >
                        <Edit3 className="w-3.5 h-3.5" />
                        Manage
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* HR Edit Modal */}
      {editingStaff && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#090d1b]/75 backdrop-blur-md p-4">
          <div className="glass-light-card rounded-2xl border border-slate-200 shadow-2xl max-w-md w-full p-6">
            <div className="flex items-start justify-between pb-3 border-b border-slate-200">
              <div>
                <h3 className="text-base font-bold text-[#0F172A]">Update HR Compliance &amp; Payroll</h3>
                <p className="text-xs text-slate-600 mt-0.5">
                  {editingStaff.fullName} · {CENTRE_MAP[editingStaff.centreId]?.code} ({selectedMonth})
                </p>
              </div>
              <button
                type="button"
                onClick={() => setEditingStaff(null)}
                className="text-slate-500 hover:text-[#0F172A]"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSave} className="mt-4 space-y-3.5">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-[#0F172A] mb-1">Attendance Status</label>
                  <select
                    value={attendanceStatus}
                    onChange={(e) => setAttendanceStatus(e.target.value as HrAttendanceStatus)}
                    className="w-full px-3 py-2 text-sm bg-white text-[#0F172A] border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-red-500/30"
                  >
                    <option value="Present">Present</option>
                    <option value="Leave">Leave</option>
                    <option value="Half Day">Half Day</option>
                    <option value="Absent">Absent</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-[#0F172A] mb-1">Leave Days (Month)</label>
                  <input
                    type="number"
                    min={0}
                    max={31}
                    required
                    value={leaveDaysCount}
                    onChange={(e) => setLeaveDaysCount(e.target.value)}
                    className="w-full px-3 py-2 text-sm font-mono bg-white text-[#0F172A] border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-red-500/30"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-[#0F172A] mb-1">Onboarding Status</label>
                  <select
                    value={onboardingStatus}
                    onChange={(e) => setOnboardingStatus(e.target.value as HrOnboardingStatus)}
                    className="w-full px-3 py-2 text-sm bg-white text-[#0F172A] border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-red-500/30"
                  >
                    <option value="Verified">Verified</option>
                    <option value="Pending Documents">Pending Documents</option>
                    <option value="Completed">Completed</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-[#0F172A] mb-1">Payroll Status</label>
                  <select
                    value={payrollStatus}
                    onChange={(e) => setPayrollStatus(e.target.value as HrPayrollStatus)}
                    className="w-full px-3 py-2 text-sm bg-white text-[#0F172A] border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-red-500/30"
                  >
                    <option value="Processed">Processed</option>
                    <option value="Pending">Pending</option>
                    <option value="On Hold">On Hold</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-[#0F172A] mb-1">HR Remarks</label>
                <textarea
                  rows={3}
                  value={remarks}
                  onChange={(e) => setRemarks(e.target.value)}
                  placeholder="Shift timings, document notes, or salary clearance remarks..."
                  className="w-full px-3 py-2 text-sm bg-white text-[#0F172A] placeholder:text-slate-400 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-red-500/30"
                />
              </div>

              <div className="flex justify-end gap-2.5 pt-2">
                <button
                  type="button"
                  onClick={() => setEditingStaff(null)}
                  className="px-4 py-2 text-xs font-semibold text-[#0F172A] border border-slate-300 hover:bg-slate-100 rounded-lg"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="px-4 py-2 text-xs font-bold text-white btn-crimson-gloss rounded-lg disabled:opacity-50"
                >
                  {saving ? 'Verifying GPS & Saving...' : 'Save HR Record'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
