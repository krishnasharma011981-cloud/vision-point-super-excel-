import { Download, MessageCircle, MonitorPlay, Phone, RotateCcw, Search, X } from 'lucide-react';
import React, { useMemo, useState } from 'react';
import { CENTRE_MAP } from '../../constants/centres';
import { buildTelHref, buildWhatsAppHref, maskMobileNumber } from '../../lib/analyticsMath';
import { buildContextualSerialMap, exportToCsv } from '../../lib/csvUtils';
import { verifyOperationLocation } from '../../lib/securityClient';
import { resetOnlineAttendanceToZeroBatch, upsertOnlineClassRecord } from '../../services/firestoreService';
import { ConfirmDialog } from '../ConfirmDialog';
import type {
  CentreId,
  ClassAttendanceStatus,
  EditRequest,
  OnlineClassRecord,
  ParticipationLevel,
  Student,
  UserAccount,
} from '../../types/domain';
import {
  AskEditPermissionModal,
  DepartmentPendingRequestsPanel,
  DepartmentRowActionButton,
} from '../DepartmentPermissionControls';

interface OnlineClassesViewProps {
  students: Student[];
  onlineClassRecords: OnlineClassRecord[];
  employees: UserAccount[];
  editRequests?: EditRequest[];
  currentUser: UserAccount;
  selectedCentreFilter: CentreId | 'all';
  globalSearch: string;
  onNotify: (title: string, description: string, variant: 'success' | 'error' | 'warning' | 'info') => void;
}

export const OnlineClassesView: React.FC<OnlineClassesViewProps> = ({
  students,
  onlineClassRecords,
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

  const [attendanceStatus, setAttendanceStatus] = useState<ClassAttendanceStatus>('Not Attending');
  const [participationLevel, setParticipationLevel] = useState<ParticipationLevel>('Inactive');
  const [attendancePercentage, setAttendancePercentage] = useState('0');
  const [lastAttendanceUpdate, setLastAttendanceUpdate] = useState('');
  const [assignedEmployeeUid, setAssignedEmployeeUid] = useState('');
  const [followUpNotes, setFollowUpNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [resetBusy, setResetBusy] = useState(false);

  const recMap = useMemo(() => {
    const map = new Map<string, OnlineClassRecord>();
    onlineClassRecords.forEach((r) => map.set(r.studentId, r));
    return map;
  }, [onlineClassRecords]);

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
          currentUser.role === 'employee' && (Boolean(s.onlineClassesLocked) || Boolean(rec?.employeeLocked));
        const resolvedStatus = rec?.attendanceStatus || s.classAttendanceStatus;
        return {
          student: s,
          displaySerial: displaySerialMap.get(s.studentId) ?? s.serialNumber,
          attendanceStatus: resolvedStatus,
          participationLevel:
            rec?.participationLevel ||
            (resolvedStatus === 'Regular'
              ? 'High'
              : resolvedStatus === 'Irregular'
                ? 'Moderate'
                : 'Inactive'),
          attendancePercentage:
            rec?.attendancePercentage ??
            (resolvedStatus === 'Regular' ? 90 : resolvedStatus === 'Irregular' ? 50 : 0),
          lastAttendanceUpdate: rec?.lastAttendanceUpdate || s.admissionDate,
          assignedEmployeeName: rec?.assignedEmployeeName || s.assignedEmployeeName || 'Unassigned',
          followUpNotes: rec?.followUpNotes || '',
          lockedForEmployee,
        };
      })
      .filter((r) => (statusFilter === 'all' ? true : r.attendanceStatus === statusFilter))
      .filter((r) => {
        if (!combinedSearch) return true;
        return (
          r.student.studentName.toLowerCase().includes(combinedSearch) ||
          r.student.studentId.toLowerCase().includes(combinedSearch) ||
          r.student.mobileNumber.toLowerCase().includes(combinedSearch)
        );
      })
      .sort((a, b) => a.displaySerial - b.displaySerial);
  }, [students, recMap, effectiveCentre, statusFilter, combinedSearch, displaySerialMap, currentUser.role]);

  const regularCount = rows.filter((r) => r.attendanceStatus === 'Regular').length;
  const avgAttendance =
    rows.length > 0 ? Math.round(rows.reduce((sum, r) => sum + r.attendancePercentage, 0) / rows.length) : 0;

  const openEditor = (student: Student) => {
    const rec = recMap.get(student.studentId);
    if (
      currentUser.role === 'employee' &&
      (Boolean(student.onlineClassesLocked) || Boolean(rec?.employeeLocked))
    ) {
      setPermissionStudent(student);
      return;
    }
    setEditingStudent(student);
    const resolvedStatus = rec?.attendanceStatus || student.classAttendanceStatus;
    setAttendanceStatus(resolvedStatus);
    setParticipationLevel(
      rec?.participationLevel ||
        (resolvedStatus === 'Regular'
          ? 'High'
          : resolvedStatus === 'Irregular'
            ? 'Moderate'
            : 'Inactive'),
    );
    setAttendancePercentage(
      String(
        rec?.attendancePercentage ??
          (resolvedStatus === 'Regular' ? 90 : resolvedStatus === 'Irregular' ? 50 : 0),
      ),
    );
    setLastAttendanceUpdate(rec?.lastAttendanceUpdate || new Date().toISOString().slice(0, 10));
    setAssignedEmployeeUid(rec?.assignedEmployeeUid || student.assignedEmployeeUid || currentUser.uid);
    setFollowUpNotes(rec?.followUpNotes || '');
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingStudent) return;
    const existingRec = recMap.get(editingStudent.studentId);
    if (
      currentUser.role === 'employee' &&
      (Boolean(editingStudent.onlineClassesLocked) || Boolean(existingRec?.employeeLocked))
    ) {
      onNotify('Entry Locked', 'Online Classes entry is locked. Ask Centre Head permission first.', 'warning');
      setEditingStudent(null);
      return;
    }
    setSaving(true);
    try {
      const loc = await verifyOperationLocation(
        currentUser,
        `ONLINE_CLASS_UPDATE:${editingStudent.studentId}`,
        editingStudent.centreId,
      );
      if (!loc.allowed) {
        onNotify('Access Denied', loc.error || 'Physical presence required at assigned centre.', 'error');
        setSaving(false);
        return;
      }

      const emp = employees.find((u) => u.uid === assignedEmployeeUid);
      await upsertOnlineClassRecord(
        {
          studentId: editingStudent.studentId,
          studentName: editingStudent.studentName,
          centreId: editingStudent.centreId,
          attendanceStatus,
          participationLevel,
          attendancePercentage: Math.min(100, Math.max(0, Number(attendancePercentage) || 0)),
          lastAttendanceUpdate,
          followUpNotes: followUpNotes.trim(),
          assignedEmployeeUid,
          assignedEmployeeName: emp?.fullName || currentUser.fullName,
        },
        currentUser,
        true,
      );
      onNotify('Attendance Updated', `Saved online class attendance for ${editingStudent.studentName}.`, 'success');
      setEditingStudent(null);
    } catch (err) {
      onNotify('Update Failed', err instanceof Error ? err.message : 'Unable to save attendance.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleExport = () => {
    exportToCsv(
      `online-classes-report-${effectiveCentre}.csv`,
      ['Student ID', 'Student Name', 'Mobile', 'Centre', 'Attendance Status', 'Participation', 'Attendance %', 'Last Update', 'Assigned', 'Notes'],
      rows.map((r) => [
        r.student.studentId,
        r.student.studentName,
        maskMobileNumber(r.student.mobileNumber),
        CENTRE_MAP[r.student.centreId].name,
        r.attendanceStatus,
        r.participationLevel,
        r.attendancePercentage,
        r.lastAttendanceUpdate,
        r.assignedEmployeeName,
        r.followUpNotes,
      ]),
    );
    onNotify('Attendance Report Exported', `Exported ${rows.length} online class records.`, 'success');
  };

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-white rounded-xl border border-zinc-200 p-4">
          <p className="text-xs font-semibold text-zinc-700">Enrolled Students</p>
          <p className="text-2xl font-bold text-black font-mono tabular-nums mt-1">{rows.length}</p>
        </div>
        <div className="bg-white rounded-xl border border-zinc-200 p-4">
          <p className="text-xs font-semibold text-zinc-700">Regular Attendees</p>
          <p className="text-2xl font-bold text-emerald-700 font-mono tabular-nums mt-1">{regularCount}</p>
        </div>
        <div className="bg-white rounded-xl border border-zinc-200 p-4">
          <p className="text-xs font-semibold text-zinc-700">Average Attendance Rate</p>
          <p className="text-2xl font-bold text-black font-mono tabular-nums mt-1">{avgAttendance}%</p>
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
              placeholder="Search student ID, name, or mobile..."
              className="w-full pl-9 pr-3.5 py-2 text-sm bg-white text-black placeholder:text-zinc-500 border border-zinc-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-black"
            />
          </div>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="px-3 py-2 text-sm border border-zinc-300 rounded-lg bg-white text-black focus:outline-none focus:ring-2 focus:ring-black"
          >
            <option value="all">All Attendance Statuses</option>
            <option value="Regular">Regular</option>
            <option value="Irregular">Irregular</option>
            <option value="Not Attending">Not Attending</option>
          </select>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {(currentUser.role === 'super_admin' || currentUser.role === 'centre_head') &&
            (regularCount > 0 || avgAttendance > 0 || rows.some((r) => r.attendanceStatus !== 'Not Attending')) && (
              <button
                type="button"
                onClick={() => setShowResetConfirm(true)}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-red-700 bg-red-50 border border-red-200 rounded-lg hover:bg-red-100 whitespace-nowrap"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                Reset All to 0%
              </button>
            )}
          <button
            type="button"
            onClick={handleExport}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-black bg-white border border-zinc-300 rounded-lg hover:bg-zinc-100 whitespace-nowrap"
          >
            <Download className="w-3.5 h-3.5" />
            Export Attendance Report
          </button>
        </div>
      </div>

      <DepartmentPendingRequestsPanel
        department="online_classes"
        editRequests={editRequests}
        currentUser={currentUser}
        effectiveCentre={effectiveCentre}
        onNotify={onNotify}
      />

      <div className="bg-white rounded-xl border border-zinc-200 overflow-hidden">
        {rows.length === 0 ? (
          <div className="p-10 text-center text-xs text-zinc-700">
            <MonitorPlay className="w-8 h-8 text-zinc-400 mx-auto mb-2" />
            No online class attendance records found.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-zinc-200 bg-zinc-50 text-[11px] font-bold text-zinc-700 uppercase tracking-wider">
                  <th className="py-3 px-4">Student</th>
                  <th className="py-3 px-4">Contact</th>
                  <th className="py-3 px-4">Attendance</th>
                  <th className="py-3 px-4">Participation</th>
                  <th className="py-3 px-4 text-right">Attendance %</th>
                  <th className="py-3 px-4">Last Update</th>
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
                        {buildWhatsAppHref(
                          r.student.mobileNumber,
                          r.student.studentName,
                          'Online Classes attendance follow-up',
                        ) ? (
                          <a
                            href={
                              buildWhatsAppHref(
                                r.student.mobileNumber,
                                r.student.studentName,
                                'Online Classes attendance follow-up',
                              )!
                            }
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
                          r.attendanceStatus === 'Regular'
                            ? 'text-emerald-700'
                            : r.attendanceStatus === 'Irregular'
                              ? 'text-[#B45309]'
                              : 'text-red-700'
                        }`}
                      >
                        {r.attendanceStatus}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-zinc-800">{r.participationLevel}</td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums font-semibold text-black">
                      {r.attendancePercentage}%
                    </td>
                    <td className="py-3 px-4 font-mono text-zinc-700">{r.lastAttendanceUpdate}</td>
                    <td className="py-3 px-4 text-zinc-800">{r.assignedEmployeeName}</td>
                    <td className="py-3 px-4 text-right">
                      <DepartmentRowActionButton
                        lockedForEmployee={r.lockedForEmployee}
                        hasPendingRequest={editRequests.some(
                          (req) =>
                            req.studentId === r.student.studentId &&
                            req.department === 'online_classes' &&
                            req.status === 'Pending',
                        )}
                        editLabel="Log"
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
                <h3 className="text-base font-bold text-slate-900">Log Online Class Attendance</h3>
                <p className="text-xs text-slate-600 font-mono mt-0.5">
                  {editingStudent.studentName} · S.No #{String(displaySerialMap.get(editingStudent.studentId) ?? (editingStudent.serialNumber || 1)).padStart(4, '0')} · {CENTRE_MAP[editingStudent.centreId]?.code}
                </p>
                <div className="mt-1.5 inline-flex items-center gap-2 text-xs font-mono text-slate-700">
                  <span>{maskMobileNumber(editingStudent.mobileNumber)}</span>
                  {buildTelHref(editingStudent.mobileNumber) ? (
                    <a
                      href={buildTelHref(editingStudent.mobileNumber)!}
                      aria-label={`Call ${editingStudent.studentName}`}
                      title="Direct Call"
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 hover:bg-emerald-600 hover:text-white border border-emerald-200 text-[11px] font-sans font-semibold transition-colors"
                    >
                      <Phone className="w-3 h-3" />
                      Call
                    </a>
                  ) : null}
                  {buildWhatsAppHref(
                    editingStudent.mobileNumber,
                    editingStudent.studentName,
                    'Online Classes attendance follow-up',
                  ) ? (
                    <a
                      href={
                        buildWhatsAppHref(
                          editingStudent.mobileNumber,
                          editingStudent.studentName,
                          'Online Classes attendance follow-up',
                        )!
                      }
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={`WhatsApp ${editingStudent.studentName}`}
                      title="Open WhatsApp Chat"
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-green-50 text-green-700 hover:bg-[#16A34A] hover:text-white border border-green-200 text-[11px] font-sans font-semibold transition-colors"
                    >
                      <MessageCircle className="w-3 h-3" />
                      WhatsApp
                    </a>
                  ) : null}
                </div>
              </div>
              <button type="button" onClick={() => setEditingStudent(null)} className="text-zinc-600 hover:text-black">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleSave} className="mt-4 space-y-3.5">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-black mb-1">Attendance Status</label>
                  <select
                    value={attendanceStatus}
                    onChange={(e) => {
                      const next = e.target.value as ClassAttendanceStatus;
                      setAttendanceStatus(next);
                      setParticipationLevel(
                        next === 'Regular' ? 'High' : next === 'Irregular' ? 'Moderate' : 'Inactive',
                      );
                      setAttendancePercentage(
                        next === 'Regular' ? '90' : next === 'Irregular' ? '50' : '0',
                      );
                    }}
                    className="w-full px-3 py-2 text-sm bg-white text-black border border-zinc-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-black"
                  >
                    <option value="Regular">Regular</option>
                    <option value="Irregular">Irregular</option>
                    <option value="Not Attending">Not Attending</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-black mb-1">Participation Level</label>
                  <select
                    value={participationLevel}
                    onChange={(e) => setParticipationLevel(e.target.value as ParticipationLevel)}
                    className="w-full px-3 py-2 text-sm bg-white text-black border border-zinc-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-black"
                  >
                    <option value="High">High</option>
                    <option value="Moderate">Moderate</option>
                    <option value="Low">Low</option>
                    <option value="Inactive">Inactive</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-black mb-1">Attendance %</label>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    value={attendancePercentage}
                    onChange={(e) => setAttendancePercentage(e.target.value)}
                    className="w-full px-3 py-2 text-sm font-mono bg-white text-black border border-zinc-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-black"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-black mb-1">Last Update Date</label>
                  <input
                    type="date"
                    value={lastAttendanceUpdate}
                    onChange={(e) => setLastAttendanceUpdate(e.target.value)}
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
                <label className="block text-xs font-semibold text-black mb-1">Follow-Up Notes</label>
                <textarea
                  rows={3}
                  value={followUpNotes}
                  onChange={(e) => setFollowUpNotes(e.target.value)}
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
                  {saving ? 'Verifying Location...' : 'Save Attendance'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      <AskEditPermissionModal
        student={permissionStudent}
        department="online_classes"
        currentUser={currentUser}
        onClose={() => setPermissionStudent(null)}
        onNotify={onNotify}
      />

      <ConfirmDialog
        open={showResetConfirm}
        title="Reset Online Attendance to 0%"
        description={`Reset all ${rows.length} visible student online attendance statuses to Not Attending (0%)? You can update individual students anytime later.`}
        confirmLabel="Reset to 0%"
        destructive
        busy={resetBusy}
        onCancel={() => setShowResetConfirm(false)}
        onConfirm={async () => {
          setResetBusy(true);
          try {
            const scopedStudentList = students.filter((s) =>
              effectiveCentre === 'all' ? true : s.centreId === effectiveCentre,
            );
            const scopedRecordList = onlineClassRecords.filter((r) =>
              effectiveCentre === 'all' ? true : r.centreId === effectiveCentre,
            );
            const res = await resetOnlineAttendanceToZeroBatch(
              scopedStudentList,
              scopedRecordList,
              currentUser,
              `Reset Online Attendance to 0% (${effectiveCentre})`,
            );
            onNotify(
              'Online Attendance Reset to 0%',
              `Updated ${res.studentsUpdated} student rows and ${res.recordsUpdated} class records to Not Attending (0%).`,
              'success',
            );
            setShowResetConfirm(false);
          } catch (err) {
            onNotify(
              'Reset Failed',
              err instanceof Error ? err.message : 'Unable to reset online attendance.',
              'error',
            );
          } finally {
            setResetBusy(false);
          }
        }}
      />
    </div>
  );
};
