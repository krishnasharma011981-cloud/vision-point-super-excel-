import { Download, Plus, Search, UserPlus, X } from 'lucide-react';
import React, { useMemo, useState } from 'react';
import { CENTRE_MAP } from '../../constants/centres';
import { buildContextualSerialMap, exportToCsv } from '../../lib/csvUtils';
import { verifyOperationLocation } from '../../lib/securityClient';
import { upsertAdmissionRecord } from '../../services/firestoreService';
import type {
  AdmissionFollowUpStatus,
  AdmissionRecord,
  AdmissionStatus,
  CentreId,
  EditRequest,
  Student,
  UserAccount,
} from '../../types/domain';
import {
  AskEditPermissionModal,
  DepartmentPendingRequestsPanel,
  DepartmentRowActionButton,
} from '../DepartmentPermissionControls';
import { StudentFormModal } from '../StudentFormModal';

interface AdmissionViewProps {
  students: Student[];
  admissionRecords: AdmissionRecord[];
  employees: UserAccount[];
  editRequests?: EditRequest[];
  currentUser: UserAccount;
  selectedCentreFilter: CentreId | 'all';
  globalSearch: string;
  onNotify: (title: string, description: string, variant: 'success' | 'error' | 'warning' | 'info') => void;
}

export const AdmissionView: React.FC<AdmissionViewProps> = ({
  students,
  admissionRecords,
  employees,
  editRequests = [],
  currentUser,
  selectedCentreFilter,
  globalSearch,
  onNotify,
}) => {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [showNewStudentModal, setShowNewStudentModal] = useState(false);
  const [editingStudent, setEditingStudent] = useState<Student | null>(null);
  const [permissionStudent, setPermissionStudent] = useState<Student | null>(null);

  const [admissionStatus, setAdmissionStatus] = useState<AdmissionStatus>('Confirmed');
  const [stream, setStream] = useState('NIOS Secondary / Senior Secondary');
  const [niosPurpose, setNiosPurpose] = useState('');
  const [academicBackground, setAcademicBackground] = useState('');
  const [followUpStatus, setFollowUpStatus] = useState<AdmissionFollowUpStatus>('Completed');
  const [assignedEmployeeUid, setAssignedEmployeeUid] = useState('');
  const [remarks, setRemarks] = useState('');
  const [saving, setSaving] = useState(false);

  const recMap = useMemo(() => {
    const map = new Map<string, AdmissionRecord>();
    admissionRecords.forEach((r) => map.set(r.studentId, r));
    return map;
  }, [admissionRecords]);

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
          currentUser.role === 'employee' && (Boolean(s.admissionLocked) || Boolean(rec?.employeeLocked));
        return {
          student: s,
          displaySerial: displaySerialMap.get(s.studentId) ?? s.serialNumber,
          admissionStatus: rec?.admissionStatus || 'Confirmed',
          stream: rec?.stream || s.subject || '—',
          niosPurpose: rec?.niosPurpose || s.whyNios,
          academicBackground: rec?.academicBackground || s.currentEducationStatus,
          followUpStatus: rec?.followUpStatus || 'Completed',
          assignedEmployeeName: rec?.assignedEmployeeName || s.assignedEmployeeName || 'Unassigned',
          remarks: rec?.remarks || s.additionalRemarks,
          lockedForEmployee,
        };
      })
      .filter((r) => (statusFilter === 'all' ? true : r.admissionStatus === statusFilter))
      .filter((r) => {
        if (!combinedSearch) return true;
        return (
          r.student.studentName.toLowerCase().includes(combinedSearch) ||
          r.student.studentId.toLowerCase().includes(combinedSearch)
        );
      })
      .sort((a, b) => a.displaySerial - b.displaySerial);
  }, [students, recMap, effectiveCentre, statusFilter, combinedSearch, displaySerialMap, currentUser.role]);

  const confirmedCount = rows.filter((r) => r.admissionStatus === 'Confirmed').length;
  const pendingFollowUpCount = rows.filter((r) => r.followUpStatus !== 'Completed').length;

  const openEditor = (student: Student) => {
    const rec = recMap.get(student.studentId);
    if (
      currentUser.role === 'employee' &&
      (Boolean(student.admissionLocked) || Boolean(rec?.employeeLocked))
    ) {
      setPermissionStudent(student);
      return;
    }
    setEditingStudent(student);
    setAdmissionStatus(rec?.admissionStatus || 'Confirmed');
    setStream(rec?.stream || student.subject.slice(0, 80));
    setNiosPurpose(rec?.niosPurpose || student.whyNios);
    setAcademicBackground(rec?.academicBackground || student.currentEducationStatus);
    setFollowUpStatus(rec?.followUpStatus || 'Completed');
    setAssignedEmployeeUid(rec?.assignedEmployeeUid || student.assignedEmployeeUid || currentUser.uid);
    setRemarks(rec?.remarks || student.additionalRemarks);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingStudent) return;
    const existingRec = recMap.get(editingStudent.studentId);
    if (
      currentUser.role === 'employee' &&
      (Boolean(editingStudent.admissionLocked) || Boolean(existingRec?.employeeLocked))
    ) {
      onNotify('Entry Locked', 'Admission entry is locked. Ask Centre Head permission first.', 'warning');
      setEditingStudent(null);
      return;
    }
    setSaving(true);
    try {
      const loc = await verifyOperationLocation(
        currentUser,
        `ADMISSION_UPDATE:${editingStudent.studentId}`,
        editingStudent.centreId,
      );
      if (!loc.allowed) {
        onNotify('Access Denied', loc.error || 'Physical presence required at assigned centre.', 'error');
        setSaving(false);
        return;
      }
      const emp = employees.find((u) => u.uid === assignedEmployeeUid);
      await upsertAdmissionRecord(
        {
          studentId: editingStudent.studentId,
          studentName: editingStudent.studentName,
          centreId: editingStudent.centreId,
          admissionStatus,
          stream: stream.trim() || 'NIOS General',
          niosPurpose: niosPurpose.trim(),
          academicBackground: academicBackground.trim(),
          followUpStatus,
          assignedEmployeeUid,
          assignedEmployeeName: emp?.fullName || currentUser.fullName,
          remarks: remarks.trim(),
          admissionDate: editingStudent.admissionDate,
        },
        currentUser,
        true,
      );
      onNotify('Admission Updated', `Updated admission profile for ${editingStudent.studentName}.`, 'success');
      setEditingStudent(null);
    } catch (err) {
      onNotify('Update Failed', err instanceof Error ? err.message : 'Unable to save admission record.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleExport = () => {
    exportToCsv(
      `admission-report-${effectiveCentre}.csv`,
      ['Student ID', 'Student Name', 'Centre', 'Admission Status', 'Stream', 'NIOS Purpose', 'Follow-Up', 'Admission Date', 'Assigned'],
      rows.map((r) => [
        r.student.studentId,
        r.student.studentName,
        CENTRE_MAP[r.student.centreId].name,
        r.admissionStatus,
        r.stream,
        r.niosPurpose,
        r.followUpStatus,
        r.student.admissionDate,
        r.assignedEmployeeName,
      ]),
    );
    onNotify('Admission Report Exported', `Exported ${rows.length} admission records.`, 'success');
  };

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-white rounded-xl border border-zinc-200 p-4">
          <p className="text-xs font-semibold text-zinc-700">Total Admissions</p>
          <p className="text-2xl font-bold text-black font-mono tabular-nums mt-1">{rows.length}</p>
        </div>
        <div className="bg-white rounded-xl border border-zinc-200 p-4">
          <p className="text-xs font-semibold text-zinc-700">Confirmed Admissions</p>
          <p className="text-2xl font-bold text-emerald-700 font-mono tabular-nums mt-1">{confirmedCount}</p>
        </div>
        <div className="bg-white rounded-xl border border-zinc-200 p-4">
          <p className="text-xs font-semibold text-zinc-700">Follow-Ups / Docs Pending</p>
          <p className="text-2xl font-bold text-[#B45309] font-mono tabular-nums mt-1">{pendingFollowUpCount}</p>
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
            <option value="all">All Admission Statuses</option>
            <option value="Confirmed">Confirmed</option>
            <option value="Provisional">Provisional</option>
            <option value="Pending Verification">Pending Verification</option>
            <option value="Cancelled">Cancelled</option>
          </select>
        </div>
        <div className="flex items-center gap-2.5">
          <button
            type="button"
            onClick={handleExport}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-black bg-white border border-zinc-300 rounded-lg hover:bg-zinc-100 whitespace-nowrap"
          >
            <Download className="w-3.5 h-3.5" />
            Export Report
          </button>
          <button
            type="button"
            onClick={() => setShowNewStudentModal(true)}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-bold text-white btn-crimson-gloss rounded-xl whitespace-nowrap"
          >
            <Plus className="w-3.5 h-3.5" />
            New Student Admission
          </button>
        </div>
      </div>

      <DepartmentPendingRequestsPanel
        department="admission"
        editRequests={editRequests}
        currentUser={currentUser}
        effectiveCentre={effectiveCentre}
        onNotify={onNotify}
      />

      <div className="bg-white rounded-xl border border-zinc-200 overflow-hidden">
        {rows.length === 0 ? (
          <div className="p-10 text-center text-xs text-zinc-700">
            <UserPlus className="w-8 h-8 text-zinc-400 mx-auto mb-2" />
            No admission records found. Click &ldquo;New Student Admission&rdquo; to register a student.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-zinc-200 bg-zinc-50 text-[11px] font-bold text-zinc-700 uppercase tracking-wider">
                  <th className="py-3 px-4">Student</th>
                  <th className="py-3 px-4">Status</th>
                  <th className="py-3 px-4">Follow-Up</th>
                  <th className="py-3 px-4">NIOS Admission Purpose</th>
                  <th className="py-3 px-4">Admission Date</th>
                  <th className="py-3 px-4">Assigned</th>
                  <th className="py-3 px-4 text-right">Manage</th>
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
                          r.admissionStatus === 'Confirmed'
                            ? 'text-emerald-700'
                            : r.admissionStatus === 'Cancelled'
                              ? 'text-red-700'
                              : 'text-[#B45309]'
                        }`}
                      >
                        {r.admissionStatus}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-zinc-800">{r.followUpStatus}</td>
                    <td className="py-3 px-4 text-zinc-700 max-w-[220px] truncate">{r.niosPurpose || '—'}</td>
                    <td className="py-3 px-4 font-mono text-zinc-700">{r.student.admissionDate}</td>
                    <td className="py-3 px-4 text-zinc-800">{r.assignedEmployeeName}</td>
                    <td className="py-3 px-4 text-right">
                      <DepartmentRowActionButton
                        lockedForEmployee={r.lockedForEmployee}
                        hasPendingRequest={editRequests.some(
                          (req) =>
                            req.studentId === r.student.studentId &&
                            req.department === 'admission' &&
                            req.status === 'Pending',
                        )}
                        editLabel="Details"
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

      <StudentFormModal
        open={showNewStudentModal}
        editingStudent={null}
        currentUser={currentUser}
        defaultCentreId={effectiveCentre === 'all' ? 'vp_lookerganj' : effectiveCentre}
        existingStudents={students}
        employees={employees}
        onClose={() => setShowNewStudentModal(false)}
        onSuccess={(msg) => onNotify('Admission Registered', msg, 'success')}
        onError={(title, desc) => onNotify(title, desc, 'error')}
      />

      {editingStudent && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#090d1b]/75 backdrop-blur-md p-4">
          <div className="glass-light-card rounded-2xl border border-slate-200 shadow-2xl max-w-lg w-full p-6">
            <div className="flex items-start justify-between pb-3 border-b border-slate-200">
              <div>
                <h3 className="text-base font-bold text-slate-900">Admission Workflow Details</h3>
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
                  <label className="block text-xs font-semibold text-black mb-1">Admission Status</label>
                  <select
                    value={admissionStatus}
                    onChange={(e) => setAdmissionStatus(e.target.value as AdmissionStatus)}
                    className="w-full px-3 py-2 text-sm bg-white text-black border border-zinc-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-black"
                  >
                    <option value="Confirmed">Confirmed</option>
                    <option value="Provisional">Provisional</option>
                    <option value="Pending Verification">Pending Verification</option>
                    <option value="Cancelled">Cancelled</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-black mb-1">Follow-Up Status</label>
                  <select
                    value={followUpStatus}
                    onChange={(e) => setFollowUpStatus(e.target.value as AdmissionFollowUpStatus)}
                    className="w-full px-3 py-2 text-sm bg-white text-black border border-zinc-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-black"
                  >
                    <option value="Completed">Completed</option>
                    <option value="Pending Follow-up">Pending Follow-up</option>
                    <option value="Document Due">Document Due</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-xs font-semibold text-black mb-1">Academic Stream</label>
                <input
                  type="text"
                  value={stream}
                  onChange={(e) => setStream(e.target.value)}
                  className="w-full px-3 py-2 text-sm bg-white text-black border border-zinc-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-black"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-black mb-1">NIOS Admission Purpose</label>
                <textarea
                  rows={2}
                  value={niosPurpose}
                  onChange={(e) => setNiosPurpose(e.target.value)}
                  className="w-full px-3 py-2 text-sm bg-white text-black border border-zinc-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-black"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-black mb-1">Academic Background</label>
                <textarea
                  rows={2}
                  value={academicBackground}
                  onChange={(e) => setAcademicBackground(e.target.value)}
                  className="w-full px-3 py-2 text-sm bg-white text-black border border-zinc-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-black"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-black mb-1">Remarks</label>
                <textarea
                  rows={2}
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
                  {saving ? 'Verifying Location...' : 'Save Admission Record'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      <AskEditPermissionModal
        student={permissionStudent}
        department="admission"
        currentUser={currentUser}
        onClose={() => setPermissionStudent(null)}
        onNotify={onNotify}
      />
    </div>
  );
};
