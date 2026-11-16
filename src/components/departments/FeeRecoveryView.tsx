import { Download, IndianRupee, MessageCircle, Phone, Search, X } from 'lucide-react';
import React, { useMemo, useState } from 'react';
import { CENTRE_MAP } from '../../constants/centres';
import { buildTelHref, buildWhatsAppHref, clampFeeNumber, maskMobileNumber } from '../../lib/analyticsMath';
import { buildContextualSerialMap, exportToCsv } from '../../lib/csvUtils';
import { verifyOperationLocation } from '../../lib/securityClient';
import { upsertFeeRecoveryRecord } from '../../services/firestoreService';
import type {
  CentreId,
  EditRequest,
  FeeFollowUpStatus,
  FeeRecoveryRecord,
  RecoveryStatus,
  Student,
  UserAccount,
} from '../../types/domain';
import {
  AskEditPermissionModal,
  DepartmentPendingRequestsPanel,
  DepartmentRowActionButton,
} from '../DepartmentPermissionControls';

interface FeeRecoveryViewProps {
  students: Student[];
  feeRecords: FeeRecoveryRecord[];
  employees: UserAccount[];
  editRequests?: EditRequest[];
  currentUser: UserAccount;
  selectedCentreFilter: CentreId | 'all';
  globalSearch: string;
  onNotify: (title: string, description: string, variant: 'success' | 'error' | 'warning' | 'info') => void;
}

export const FeeRecoveryView: React.FC<FeeRecoveryViewProps> = ({
  students,
  feeRecords,
  employees,
  editRequests = [],
  currentUser,
  selectedCentreFilter,
  globalSearch,
  onNotify,
}) => {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [editingStudent, setEditingStudent] = useState<Student | null>(null);
  const [permissionStudent, setPermissionStudent] = useState<Student | null>(null);

  const [recoveryStatus, setRecoveryStatus] = useState<RecoveryStatus>('Pending');
  const [followUpStatus, setFollowUpStatus] = useState<FeeFollowUpStatus>('Scheduled');
  const [totalFee, setTotalFee] = useState('12000');
  const [paidAmount, setPaidAmount] = useState('0');
  const [tmaFee, setTmaFee] = useState('0');
  const [examFee, setExamFee] = useState('0');
  const [assignedEmployeeUid, setAssignedEmployeeUid] = useState('');
  const [followUpNotes, setFollowUpNotes] = useState('');
  const [lastContactDate, setLastContactDate] = useState('');
  const [nextFollowUpDate, setNextFollowUpDate] = useState('');
  const [saving, setSaving] = useState(false);

  const feeMap = useMemo(() => {
    const map = new Map<string, FeeRecoveryRecord>();
    feeRecords.forEach((r) => map.set(r.studentId, r));
    return map;
  }, [feeRecords]);

  const effectiveCentre =
    currentUser.role === 'super_admin' ? selectedCentreFilter : currentUser.centreId;

  const combinedSearch = (search || globalSearch).trim().toLowerCase();

  const displaySerialMap = useMemo(
    () => buildContextualSerialMap(students, effectiveCentre),
    [students, effectiveCentre],
  );

  const rows = useMemo(() => {
    return students
      .filter((s) => (effectiveCentre === 'all' ? true : s.centreId === effectiveCentre))
      .map((s) => {
        const rec = feeMap.get(s.studentId);
        const lockedForEmployee = currentUser.role === 'employee' && Boolean(rec?.employeeLocked);
        return {
          student: s,
          displaySerial: displaySerialMap.get(s.studentId) ?? s.serialNumber,
          record: rec,
          recoveryStatus: rec?.recoveryStatus || 'Pending',
          followUpStatus: rec?.followUpStatus || 'Scheduled',
          totalFee: rec?.totalFee ?? 12000,
          paidAmount: rec?.paidAmount ?? 0,
          pendingAmount: rec?.pendingAmount ?? 12000,
          tmaFee: rec?.tmaFee ?? s.tmaFee ?? 0,
          examFee: rec?.examFee ?? s.examFee ?? 0,
          assignedEmployeeName: rec?.assignedEmployeeName || s.assignedEmployeeName || 'Unassigned',
          lastContactDate: rec?.lastContactDate || '—',
          nextFollowUpDate: rec?.nextFollowUpDate || '—',
          followUpNotes: rec?.followUpNotes || '',
          lockedForEmployee,
        };
      })
      .filter((r) => (statusFilter === 'all' ? true : r.recoveryStatus === statusFilter))
      .filter((r) => {
        if (!combinedSearch) return true;
        return (
          r.student.studentName.toLowerCase().includes(combinedSearch) ||
          r.student.studentId.toLowerCase().includes(combinedSearch) ||
          r.student.mobileNumber.toLowerCase().includes(combinedSearch)
        );
      })
      .sort((a, b) => a.displaySerial - b.displaySerial);
  }, [students, feeMap, effectiveCentre, statusFilter, combinedSearch, displaySerialMap, currentUser.role]);

  const totals = useMemo(() => {
    const agg = rows.reduce(
      (acc, r) => {
        acc.total += r.totalFee;
        acc.paid += r.paidAmount;
        acc.pending += r.pendingAmount;
        if (r.recoveryStatus === 'Overdue' || r.recoveryStatus === 'Pending') acc.actionRequired += 1;
        return acc;
      },
      { total: 0, paid: 0, pending: 0, actionRequired: 0 },
    );
    return {
      ...agg,
      collectionRatePct: agg.total > 0 ? Math.round((agg.paid / agg.total) * 100) : 0,
    };
  }, [rows]);

  const openEditor = (student: Student) => {
    const existing = feeMap.get(student.studentId);
    if (currentUser.role === 'employee' && Boolean(existing?.employeeLocked)) {
      setPermissionStudent(student);
      return;
    }
    setEditingStudent(student);
    setRecoveryStatus(existing?.recoveryStatus || 'Pending');
    setFollowUpStatus(existing?.followUpStatus || 'Scheduled');
    setTotalFee(String(existing?.totalFee ?? 12000));
    setPaidAmount(String(existing?.paidAmount ?? 0));
    setTmaFee(String(existing?.tmaFee ?? student.tmaFee ?? 0));
    setExamFee(String(existing?.examFee ?? student.examFee ?? 0));
    setAssignedEmployeeUid(existing?.assignedEmployeeUid || student.assignedEmployeeUid || currentUser.uid);
    setFollowUpNotes(existing?.followUpNotes || '');
    setLastContactDate(existing?.lastContactDate || new Date().toISOString().slice(0, 10));
    setNextFollowUpDate(existing?.nextFollowUpDate || new Date().toISOString().slice(0, 10));
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingStudent) return;
    const existing = feeMap.get(editingStudent.studentId);
    if (currentUser.role === 'employee' && Boolean(existing?.employeeLocked)) {
      onNotify('Entry Locked', 'Fee Recovery entry is locked. Ask Centre Head permission first.', 'warning');
      setEditingStudent(null);
      return;
    }
    setSaving(true);
    try {
      const loc = await verifyOperationLocation(
        currentUser,
        `FEE_RECOVERY_UPDATE:${editingStudent.studentId}`,
        editingStudent.centreId,
      );
      if (!loc.allowed) {
        onNotify('Access Denied', loc.error || 'Physical presence required at assigned centre.', 'error');
        setSaving(false);
        return;
      }

      const tot = Math.max(0, Number(totalFee) || 0);
      const paid = Math.max(0, Number(paidAmount) || 0);
      const pending = Math.max(0, tot - paid);
      const cleanTmaFee = clampFeeNumber(tmaFee);
      const cleanExamFee = clampFeeNumber(examFee);
      const emp = employees.find((u) => u.uid === assignedEmployeeUid);

      await upsertFeeRecoveryRecord(
        {
          studentId: editingStudent.studentId,
          studentName: editingStudent.studentName,
          mobileNumber: editingStudent.mobileNumber,
          centreId: editingStudent.centreId,
          recoveryStatus,
          followUpStatus,
          totalFee: tot,
          paidAmount: paid,
          pendingAmount: pending,
          tmaFee: cleanTmaFee,
          examFee: cleanExamFee,
          assignedEmployeeUid,
          assignedEmployeeName: emp?.fullName || currentUser.fullName,
          followUpNotes: followUpNotes.trim(),
          lastContactDate,
          nextFollowUpDate,
        },
        currentUser,
        true,
      );

      onNotify('Fee Recovery Updated', `Updated fee recovery record for ${editingStudent.studentName}.`, 'success');
      setEditingStudent(null);
    } catch (err) {
      onNotify('Update Failed', err instanceof Error ? err.message : 'Unable to save fee record.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleExport = () => {
    exportToCsv(
      `fee-recovery-report-${effectiveCentre}.csv`,
      [
        'Student ID',
        'Student Name',
        'Mobile',
        'Centre',
        'Recovery Status',
        'Follow-Up Status',
        'Total Fee',
        'Paid',
        'Pending',
        'TMA Fee',
        'Exam Fee',
        'Last Contact',
        'Next Follow-Up',
        'Assigned To',
      ],
      rows.map((r) => [
        r.student.studentId,
        r.student.studentName,
        maskMobileNumber(r.student.mobileNumber),
        CENTRE_MAP[r.student.centreId].name,
        r.recoveryStatus,
        r.followUpStatus,
        r.totalFee,
        r.paidAmount,
        r.pendingAmount,
        r.tmaFee,
        r.examFee,
        r.lastContactDate,
        r.nextFollowUpDate,
        r.assignedEmployeeName,
      ]),
    );
    onNotify('Fee Report Exported', `Exported ${rows.length} fee recovery rows.`, 'success');
  };

  const deptEmployees = employees.filter(
    (e) =>
      e.status === 'Active' &&
      (!editingStudent || e.centreId === editingStudent.centreId) &&
      (e.department === 'fee_recovery' || e.role !== 'employee'),
  );

  return (
    <div className="space-y-5">
      {/* KPI Summary Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white rounded-xl border border-zinc-200 p-4">
          <p className="text-xs font-semibold text-zinc-700">Total Fee Billed</p>
          <p className="text-2xl font-bold text-black font-mono tabular-nums mt-1">
            ₹{totals.total.toLocaleString('en-IN')}
          </p>
        </div>
        <div className="bg-white rounded-xl border border-zinc-200 p-4">
          <p className="text-xs font-semibold text-zinc-700">Total Collected</p>
          <p className="text-2xl font-bold text-emerald-700 font-mono tabular-nums mt-1">
            ₹{totals.paid.toLocaleString('en-IN')}
          </p>
          <p className="text-[11px] font-mono font-semibold text-emerald-700 mt-0.5">
            {totals.collectionRatePct}% Collection Rate
          </p>
        </div>
        <div className="bg-white rounded-xl border border-zinc-200 p-4">
          <p className="text-xs font-semibold text-zinc-700">Pending Recovery</p>
          <p className="text-2xl font-bold text-red-700 font-mono tabular-nums mt-1">
            ₹{totals.pending.toLocaleString('en-IN')}
          </p>
        </div>
        <div className="bg-white rounded-xl border border-zinc-200 p-4">
          <p className="text-xs font-semibold text-zinc-700">Follow-Ups Due</p>
          <p className="text-2xl font-bold text-[#B45309] font-mono tabular-nums mt-1">
            {totals.actionRequired}
          </p>
        </div>
      </div>

      {/* Filter Toolbar */}
      <div className="bg-white rounded-xl border border-zinc-200 p-5 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="flex flex-1 flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[220px]">
            <Search className="w-4 h-4 text-zinc-600 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search student ID, name, or mobile..."
              className="w-full pl-9 pr-3.5 py-2 text-sm bg-white text-black placeholder:text-zinc-500 border border-zinc-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-black"
            />
          </div>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="px-3 py-2 text-sm border border-zinc-300 rounded-lg bg-white text-black focus:outline-none focus:ring-2 focus:ring-black"
          >
            <option value="all">All Recovery Statuses</option>
            <option value="Paid">Paid</option>
            <option value="Partial">Partial</option>
            <option value="Pending">Pending</option>
            <option value="Overdue">Overdue</option>
          </select>
        </div>
        <button
          type="button"
          onClick={handleExport}
          className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-black bg-white border border-zinc-300 rounded-lg hover:bg-zinc-100 whitespace-nowrap"
        >
          <Download className="w-3.5 h-3.5" />
          Export Recovery Report
        </button>
      </div>

      <DepartmentPendingRequestsPanel
        department="fee_recovery"
        editRequests={editRequests}
        currentUser={currentUser}
        effectiveCentre={effectiveCentre}
        onNotify={onNotify}
      />

      {/* Table */}
      <div className="bg-white rounded-xl border border-zinc-200 overflow-hidden">
        {rows.length === 0 ? (
          <div className="p-10 text-center text-xs text-zinc-700">
            <IndianRupee className="w-8 h-8 text-zinc-400 mx-auto mb-2" />
            No student fee recovery records match the current filter.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-zinc-200 bg-zinc-50 text-[11px] font-bold text-zinc-700 uppercase tracking-wider">
                  <th className="py-3 px-4">Student</th>
                  <th className="py-3 px-4">Contact</th>
                  <th className="py-3 px-4">Recovery Status</th>
                  <th className="py-3 px-4">Follow-Up</th>
                  <th className="py-3 px-4 text-right">Pending (INR)</th>
                  <th className="py-3 px-4 text-right">TMA Fee</th>
                  <th className="py-3 px-4 text-right">Exam Fee</th>
                  <th className="py-3 px-4">Next Follow-Up</th>
                  <th className="py-3 px-4">Assigned</th>
                  <th className="py-3 px-4 text-right">Update</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 text-xs">
                {rows.map((r) => (
                  <tr key={r.student.studentId} className="hover:bg-zinc-50">
                    <td className="py-3 px-4">
                      <p className="font-semibold text-slate-900">{r.student.studentName}</p>
                      <p className="text-[11px] font-mono text-slate-600">
                        S.No #{String(r.displaySerial || 1).padStart(4, '0')} · {CENTRE_MAP[r.student.centreId].code}
                      </p>
                    </td>
                    <td className="py-3 px-4 font-mono text-zinc-800 whitespace-nowrap">
                      <div className="inline-flex items-center gap-2">
                        <span>{maskMobileNumber(r.student.mobileNumber)}</span>
                        {buildTelHref(r.student.mobileNumber) ? (
                          <a
                            href={buildTelHref(r.student.mobileNumber)!}
                            onClick={(e) => e.stopPropagation()}
                            aria-label={`Call ${r.student.studentName}`}
                            title="Direct Call"
                            className="p-1 rounded-md bg-emerald-50 text-emerald-700 hover:bg-emerald-600 hover:text-white border border-emerald-200 transition-colors"
                          >
                            <Phone className="w-3.5 h-3.5" />
                          </a>
                        ) : null}
                        {buildWhatsAppHref(r.student.mobileNumber, r.student.studentName) ? (
                          <a
                            href={buildWhatsAppHref(r.student.mobileNumber, r.student.studentName)!}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            aria-label={`WhatsApp ${r.student.studentName}`}
                            title="Open WhatsApp Chat"
                            className="p-1 rounded-md bg-green-50 text-green-700 hover:bg-[#16A34A] hover:text-white border border-green-200 transition-colors"
                          >
                            <MessageCircle className="w-3.5 h-3.5" />
                          </a>
                        ) : null}
                      </div>
                    </td>
                    <td className="py-3 px-4">
                      <span
                        className={`font-semibold ${
                          r.recoveryStatus === 'Paid'
                            ? 'text-emerald-700'
                            : r.recoveryStatus === 'Partial'
                              ? 'text-[#B45309]'
                              : r.recoveryStatus === 'Overdue'
                                ? 'text-red-700'
                                : 'text-[#B45309]'
                        }`}
                      >
                        {r.recoveryStatus}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-zinc-800">{r.followUpStatus}</td>
                    <td className="py-3 px-4 text-right font-mono font-semibold text-black tabular-nums">
                      ₹{r.pendingAmount.toLocaleString('en-IN')}
                    </td>
                    <td className="py-3 px-4 text-right font-mono font-semibold text-amber-800 tabular-nums">
                      ₹{r.tmaFee.toLocaleString('en-IN')}
                    </td>
                    <td className="py-3 px-4 text-right font-mono font-semibold text-indigo-800 tabular-nums">
                      ₹{r.examFee.toLocaleString('en-IN')}
                    </td>
                    <td className="py-3 px-4 font-mono text-zinc-700">{r.nextFollowUpDate}</td>
                    <td className="py-3 px-4 text-zinc-800">{r.assignedEmployeeName}</td>
                    <td className="py-3 px-4 text-right">
                      <DepartmentRowActionButton
                        lockedForEmployee={r.lockedForEmployee}
                        hasPendingRequest={editRequests.some(
                          (req) =>
                            req.studentId === r.student.studentId &&
                            req.department === 'fee_recovery' &&
                            req.status === 'Pending',
                        )}
                        editLabel="Manage"
                        onEdit={() => openEditor(r.student)}
                        onAskPermission={() => setPermissionStudent(r.student)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Edit Modal */}
      {editingStudent && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#040E24]/75 backdrop-blur-md p-4">
          <div className="glass-light-card rounded-2xl border border-slate-200 shadow-2xl max-w-lg w-full p-6">
            <div className="flex items-start justify-between pb-3 border-b border-slate-200">
              <div>
                <h3 className="text-base font-bold text-slate-900">Fee Recovery Follow-Up</h3>
                <p className="text-xs text-slate-600 font-mono mt-0.5">
                  {editingStudent.studentName} · S.No #{String(displaySerialMap.get(editingStudent.studentId) ?? (editingStudent.serialNumber || 1)).padStart(4, '0')} · {CENTRE_MAP[editingStudent.centreId]?.code}
                </p>
              </div>
              <button type="button" onClick={() => setEditingStudent(null)} className="text-zinc-600 hover:text-black">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleSave} className="mt-4 space-y-3.5">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-black mb-1">Recovery Status</label>
                  <select
                    value={recoveryStatus}
                    onChange={(e) => setRecoveryStatus(e.target.value as RecoveryStatus)}
                    className="w-full px-3 py-2 text-sm bg-white text-black border border-zinc-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-black"
                  >
                    <option value="Paid">Paid</option>
                    <option value="Partial">Partial</option>
                    <option value="Pending">Pending</option>
                    <option value="Overdue">Overdue</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-black mb-1">Follow-Up Status</label>
                  <select
                    value={followUpStatus}
                    onChange={(e) => setFollowUpStatus(e.target.value as FeeFollowUpStatus)}
                    className="w-full px-3 py-2 text-sm bg-white text-black border border-zinc-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-black"
                  >
                    <option value="Scheduled">Scheduled</option>
                    <option value="Contacted">Contacted</option>
                    <option value="Promise to Pay">Promise to Pay</option>
                    <option value="Closed">Closed</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-black mb-1">Total Fee (INR)</label>
                  <input
                    type="number"
                    min={0}
                    value={totalFee}
                    onChange={(e) => setTotalFee(e.target.value)}
                    className="w-full px-3 py-2 text-sm font-mono bg-white text-black border border-zinc-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-black"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-black mb-1">Paid Amount (INR)</label>
                  <input
                    type="number"
                    min={0}
                    value={paidAmount}
                    onChange={(e) => setPaidAmount(e.target.value)}
                    className="w-full px-3 py-2 text-sm font-mono bg-white text-black border border-zinc-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-black"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-amber-900 mb-1">TMA Fee (INR)</label>
                  <input
                    type="number"
                    min={0}
                    value={tmaFee}
                    onChange={(e) => setTmaFee(e.target.value)}
                    className="w-full px-3 py-2 text-sm font-mono bg-white text-black border border-amber-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-black"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-indigo-900 mb-1">Exam Fee (INR)</label>
                  <input
                    type="number"
                    min={0}
                    value={examFee}
                    onChange={(e) => setExamFee(e.target.value)}
                    className="w-full px-3 py-2 text-sm font-mono bg-white text-black border border-indigo-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-black"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-black mb-1">Last Contact Date</label>
                  <input
                    type="date"
                    value={lastContactDate}
                    onChange={(e) => setLastContactDate(e.target.value)}
                    className="w-full px-3 py-2 text-sm font-mono bg-white text-black border border-zinc-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-black"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-black mb-1">Next Follow-Up Date</label>
                  <input
                    type="date"
                    value={nextFollowUpDate}
                    onChange={(e) => setNextFollowUpDate(e.target.value)}
                    className="w-full px-3 py-2 text-sm font-mono bg-white text-black border border-zinc-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-black"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-semibold text-black mb-1">Assigned Employee</label>
                <select
                  value={assignedEmployeeUid}
                  onChange={(e) => setAssignedEmployeeUid(e.target.value)}
                  className="w-full px-3 py-2 text-sm bg-white text-black border border-zinc-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-black"
                >
                  <option value={currentUser.uid}>{currentUser.fullName}</option>
                  {deptEmployees.map((emp) => (
                    <option key={emp.uid} value={emp.uid}>
                      {emp.fullName}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold text-black mb-1">Follow-Up Notes</label>
                <textarea
                  rows={3}
                  value={followUpNotes}
                  onChange={(e) => setFollowUpNotes(e.target.value)}
                  placeholder="Call summary, payment promise date, remarks..."
                  className="w-full px-3 py-2 text-sm bg-white text-black placeholder:text-zinc-500 border border-zinc-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-black"
                />
              </div>
              <div className="flex justify-end gap-2.5 pt-2">
                <button
                  type="button"
                  onClick={() => setEditingStudent(null)}
                  className="px-4 py-2 text-xs font-semibold text-black border border-zinc-300 hover:bg-zinc-100 rounded-lg"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="px-4 py-2 text-xs font-bold text-white btn-crimson-gloss rounded-lg disabled:opacity-50"
                >
                  {saving ? 'Verifying Location...' : 'Save Fee Record'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      <AskEditPermissionModal
        student={permissionStudent}
        department="fee_recovery"
        currentUser={currentUser}
        onClose={() => setPermissionStudent(null)}
        onNotify={onNotify}
      />
    </div>
  );
};
