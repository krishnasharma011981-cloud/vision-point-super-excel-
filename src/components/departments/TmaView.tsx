import { ClipboardCheck, Download, Search, X } from 'lucide-react';
import React, { useMemo, useState } from 'react';
import { CENTRE_MAP } from '../../constants/centres';
import { buildContextualSerialMap, exportToCsv } from '../../lib/csvUtils';
import { verifyOperationLocation } from '../../lib/securityClient';
import { upsertTmaRecord } from '../../services/firestoreService';
import type { CentreId, EditRequest, Student, TmaRecord, TmaStatus, UserAccount } from '../../types/domain';
import {
  AskEditPermissionModal,
  DepartmentPendingRequestsPanel,
  DepartmentRowActionButton,
} from '../DepartmentPermissionControls';

interface TmaViewProps {
  students: Student[];
  tmaRecords: TmaRecord[];
  employees: UserAccount[];
  editRequests?: EditRequest[];
  currentUser: UserAccount;
  selectedCentreFilter: CentreId | 'all';
  globalSearch: string;
  onNotify: (title: string, description: string, variant: 'success' | 'error' | 'warning' | 'info') => void;
}

export const TmaView: React.FC<TmaViewProps> = ({
  students,
  tmaRecords,
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

  const [tmaStatus, setTmaStatus] = useState<TmaStatus>('Pending');
  const [subjectsSubmittedCount, setSubjectsSubmittedCount] = useState('0');
  const [totalSubjectsCount, setTotalSubjectsCount] = useState('5');
  const [submissionDate, setSubmissionDate] = useState('');
  const [assignedEmployeeUid, setAssignedEmployeeUid] = useState('');
  const [remarks, setRemarks] = useState('');
  const [saving, setSaving] = useState(false);

  const recMap = useMemo(() => {
    const map = new Map<string, TmaRecord>();
    tmaRecords.forEach((r) => map.set(r.studentId, r));
    return map;
  }, [tmaRecords]);

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
        const rec = recMap.get(s.studentId);
        const lockedForEmployee =
          currentUser.role === 'employee' && (Boolean(s.tmaLocked) || Boolean(rec?.employeeLocked));
        return {
          student: s,
          displaySerial: displaySerialMap.get(s.studentId) ?? s.serialNumber,
          tmaStatus: rec?.tmaStatus || s.tmaStatus,
          subjectsSubmittedCount: rec?.subjectsSubmittedCount ?? (s.tmaStatus === 'Submitted' ? 5 : 0),
          totalSubjectsCount: rec?.totalSubjectsCount ?? 5,
          submissionDate: rec?.submissionDate || '—',
          assignedEmployeeName: rec?.assignedEmployeeName || s.assignedEmployeeName || 'Unassigned',
          remarks: rec?.remarks || '',
          lockedForEmployee,
        };
      })
      .filter((r) => (statusFilter === 'all' ? true : r.tmaStatus === statusFilter))
      .filter((r) => {
        if (!combinedSearch) return true;
        return (
          r.student.studentName.toLowerCase().includes(combinedSearch) ||
          r.student.studentId.toLowerCase().includes(combinedSearch)
        );
      })
      .sort((a, b) => a.displaySerial - b.displaySerial);
  }, [students, recMap, effectiveCentre, statusFilter, combinedSearch, displaySerialMap, currentUser.role]);

  const submittedCount = rows.filter((r) => r.tmaStatus === 'Submitted').length;
  const pendingCount = rows.filter((r) => r.tmaStatus !== 'Submitted').length;

  const openEditor = (student: Student) => {
    const rec = recMap.get(student.studentId);
    if (currentUser.role === 'employee' && (Boolean(student.tmaLocked) || Boolean(rec?.employeeLocked))) {
      setPermissionStudent(student);
      return;
    }
    setEditingStudent(student);
    setTmaStatus(rec?.tmaStatus || student.tmaStatus);
    setSubjectsSubmittedCount(String(rec?.subjectsSubmittedCount ?? (student.tmaStatus === 'Submitted' ? 5 : 0)));
    setTotalSubjectsCount(String(rec?.totalSubjectsCount ?? 5));
    setSubmissionDate(rec?.submissionDate || new Date().toISOString().slice(0, 10));
    setAssignedEmployeeUid(rec?.assignedEmployeeUid || student.assignedEmployeeUid || currentUser.uid);
    setRemarks(rec?.remarks || '');
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingStudent) return;
    const existingRec = recMap.get(editingStudent.studentId);
    if (
      currentUser.role === 'employee' &&
      (Boolean(editingStudent.tmaLocked) || Boolean(existingRec?.employeeLocked))
    ) {
      onNotify('Entry Locked', 'TMA entry is locked. Ask Centre Head permission first.', 'warning');
      setEditingStudent(null);
      return;
    }
    setSaving(true);
    try {
      const loc = await verifyOperationLocation(
        currentUser,
        `TMA_UPDATE:${editingStudent.studentId}`,
        editingStudent.centreId,
      );
      if (!loc.allowed) {
        onNotify('Access Denied', loc.error || 'Physical presence required at assigned centre.', 'error');
        setSaving(false);
        return;
      }

      const emp = employees.find((u) => u.uid === assignedEmployeeUid);
      const totalSub = Math.min(20, Math.max(1, Number(totalSubjectsCount) || 5));
      const subCount = Math.min(totalSub, Math.max(0, Number(subjectsSubmittedCount) || 0));

      await upsertTmaRecord(
        {
          studentId: editingStudent.studentId,
          studentName: editingStudent.studentName,
          centreId: editingStudent.centreId,
          tmaStatus,
          subjectsSubmittedCount: subCount,
          totalSubjectsCount: totalSub,
          submissionDate,
          assignedEmployeeUid,
          assignedEmployeeName: emp?.fullName || currentUser.fullName,
          remarks: remarks.trim(),
        },
        currentUser,
        true,
      );
      onNotify('TMA Updated', `Saved TMA submission tracking for ${editingStudent.studentName}.`, 'success');
      setEditingStudent(null);
    } catch (err) {
      onNotify('Update Failed', err instanceof Error ? err.message : 'Unable to save TMA record.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleExport = () => {
    exportToCsv(
      `tma-report-${effectiveCentre}.csv`,
      ['Student ID', 'Student Name', 'Centre', 'TMA Status', 'Subjects Submitted', 'Total Subjects', 'Submission Date', 'Assigned', 'Remarks'],
      rows.map((r) => [
        r.student.studentId,
        r.student.studentName,
        CENTRE_MAP[r.student.centreId].name,
        r.tmaStatus,
        r.subjectsSubmittedCount,
        r.totalSubjectsCount,
        r.submissionDate,
        r.assignedEmployeeName,
        r.remarks,
      ]),
    );
    onNotify('TMA Report Exported', `Exported ${rows.length} TMA records.`, 'success');
  };

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-white rounded-xl border border-zinc-200 p-4">
          <p className="text-xs font-semibold text-zinc-700">Total Students</p>
          <p className="text-2xl font-bold text-black font-mono tabular-nums mt-1">{rows.length}</p>
        </div>
        <div className="bg-white rounded-xl border border-zinc-200 p-4">
          <p className="text-xs font-semibold text-zinc-700">TMA Submitted</p>
          <p className="text-2xl font-bold text-emerald-700 font-mono tabular-nums mt-1">{submittedCount}</p>
        </div>
        <div className="bg-white rounded-xl border border-zinc-200 p-4">
          <p className="text-xs font-semibold text-zinc-700">Pending / Not Submitted</p>
          <p className="text-2xl font-bold text-red-700 font-mono tabular-nums mt-1">{pendingCount}</p>
        </div>
      </div>

      <div className="bg-white rounded-xl border border-zinc-200 p-5 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="flex flex-1 flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[220px]">
            <Search className="w-4 h-4 text-zinc-600 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search student ID or name..."
              className="w-full pl-9 pr-3.5 py-2 text-sm bg-white text-black placeholder:text-zinc-500 border border-zinc-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-black"
            />
          </div>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="px-3 py-2 text-sm border border-zinc-300 rounded-lg bg-white text-black focus:outline-none focus:ring-2 focus:ring-black"
          >
            <option value="all">All TMA Statuses</option>
            <option value="Submitted">Submitted</option>
            <option value="Pending">Pending</option>
            <option value="Not Submitted">Not Submitted</option>
          </select>
        </div>
        <button
          type="button"
          onClick={handleExport}
          className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-black bg-white border border-zinc-300 rounded-lg hover:bg-zinc-100 whitespace-nowrap"
        >
          <Download className="w-3.5 h-3.5" />
          Export TMA Report
        </button>
      </div>

      <DepartmentPendingRequestsPanel
        department="tma"
        editRequests={editRequests}
        currentUser={currentUser}
        effectiveCentre={effectiveCentre}
        onNotify={onNotify}
      />

      <div className="bg-white rounded-xl border border-zinc-200 overflow-hidden">
        {rows.length === 0 ? (
          <div className="p-10 text-center text-xs text-zinc-700">
            <ClipboardCheck className="w-8 h-8 text-zinc-400 mx-auto mb-2" />
            No TMA records found.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-zinc-200 bg-zinc-50 text-[11px] font-bold text-zinc-700 uppercase tracking-wider">
                  <th className="py-3 px-4">Student</th>
                  <th className="py-3 px-4">TMA Status</th>
                  <th className="py-3 px-4 text-right">Files Submitted</th>
                  <th className="py-3 px-4">Submission Date</th>
                  <th className="py-3 px-4">Assigned</th>
                  <th className="py-3 px-4">Remarks</th>
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
                    <td className="py-3 px-4">
                      <span
                        className={`font-semibold ${
                          r.tmaStatus === 'Submitted'
                            ? 'text-emerald-700'
                            : r.tmaStatus === 'Pending'
                              ? 'text-[#B45309]'
                              : 'text-red-700'
                        }`}
                      >
                        {r.tmaStatus}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums font-semibold text-black">
                      {r.subjectsSubmittedCount} / {r.totalSubjectsCount}
                    </td>
                    <td className="py-3 px-4 font-mono text-zinc-700">{r.submissionDate}</td>
                    <td className="py-3 px-4 text-zinc-800">{r.assignedEmployeeName}</td>
                    <td className="py-3 px-4 text-zinc-700 max-w-[180px] truncate">{r.remarks || '—'}</td>
                    <td className="py-3 px-4 text-right">
                      <DepartmentRowActionButton
                        lockedForEmployee={r.lockedForEmployee}
                        hasPendingRequest={editRequests.some(
                          (req) =>
                            req.studentId === r.student.studentId &&
                            req.department === 'tma' &&
                            req.status === 'Pending',
                        )}
                        editLabel="Update"
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

      {editingStudent && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#040E24]/75 backdrop-blur-md p-4">
          <div className="glass-light-card rounded-2xl border border-slate-200 shadow-2xl max-w-lg w-full p-6">
            <div className="flex items-start justify-between pb-3 border-b border-slate-200">
              <div>
                <h3 className="text-base font-bold text-slate-900">Update TMA Submission</h3>
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
                  <label className="block text-xs font-semibold text-black mb-1">TMA Status</label>
                  <select
                    value={tmaStatus}
                    onChange={(e) => setTmaStatus(e.target.value as TmaStatus)}
                    className="w-full px-3 py-2 text-sm bg-white text-black border border-zinc-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-black"
                  >
                    <option value="Submitted">Submitted</option>
                    <option value="Pending">Pending</option>
                    <option value="Not Submitted">Not Submitted</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-black mb-1">Submission Date</label>
                  <input
                    type="date"
                    value={submissionDate}
                    onChange={(e) => setSubmissionDate(e.target.value)}
                    className="w-full px-3 py-2 text-sm font-mono bg-white text-black border border-zinc-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-black"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-black mb-1">Submitted Files</label>
                  <input
                    type="number"
                    min={0}
                    max={20}
                    value={subjectsSubmittedCount}
                    onChange={(e) => setSubjectsSubmittedCount(e.target.value)}
                    className="w-full px-3 py-2 text-sm font-mono bg-white text-black border border-zinc-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-black"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-black mb-1">Total Subjects</label>
                  <input
                    type="number"
                    min={1}
                    max={20}
                    value={totalSubjectsCount}
                    onChange={(e) => setTotalSubjectsCount(e.target.value)}
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
                  {employees
                    .filter((e) => e.status === 'Active' && e.centreId === editingStudent.centreId)
                    .map((emp) => (
                      <option key={emp.uid} value={emp.uid}>
                        {emp.fullName}
                      </option>
                    ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold text-black mb-1">Remarks</label>
                <textarea
                  rows={3}
                  value={remarks}
                  onChange={(e) => setRemarks(e.target.value)}
                  className="w-full px-3 py-2 text-sm bg-white text-black border border-zinc-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-black"
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
                  {saving ? 'Verifying Location...' : 'Save TMA Record'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      <AskEditPermissionModal
        student={permissionStudent}
        department="tma"
        currentUser={currentUser}
        onClose={() => setPermissionStudent(null)}
        onNotify={onNotify}
      />
    </div>
  );
};
