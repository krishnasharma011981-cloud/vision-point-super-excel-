import { ClipboardList, Users, X } from 'lucide-react';
import React, { useEffect, useMemo, useState } from 'react';
import { CANONICAL_CENTRES, CENTRE_MAP } from '../constants/centres';
import {
  getEligibleStaffForCentre,
  selectStudentsForAssignmentRange,
  WORK_ASSIGNMENT_DEPARTMENT_LABELS,
} from '../lib/workAssignment';
import {
  createWorkAssignmentBatch,
  type CreateWorkAssignmentTaskInput,
} from '../services/firestoreService';
import type {
  CentreId,
  Student,
  UserAccount,
  WorkAssignment,
  WorkAssignmentDepartment,
} from '../types/domain';

interface WorkAssignmentModalProps {
  open: boolean;
  department: WorkAssignmentDepartment;
  currentUser: UserAccount;
  selectedCentreFilter: CentreId | 'all';
  students: Student[];
  displaySerialMap: Map<string, number>;
  employees: UserAccount[];
  existingAssignments: WorkAssignment[];
  /** Optional pre-selected staff UID (e.g., when re-assigning to a specific staff member) */
  initialStaffUid?: string;
  /** Optional suggested starting serial number (e.g., 51 after 1-50) */
  initialFromSerial?: number;
  /** Maps a student to extra context (fee/subject) and whether they count as "pending" for optional filtering */
  resolveStudentContext: (student: Student) => {
    subject: string;
    pendingFee: number;
    totalFee: number;
    isPendingWork: boolean;
  };
  onClose: () => void;
  onNotify: (title: string, description: string, variant: 'success' | 'error' | 'warning' | 'info') => void;
}

export const WorkAssignmentModal: React.FC<WorkAssignmentModalProps> = ({
  open,
  department,
  currentUser,
  selectedCentreFilter,
  students,
  displaySerialMap,
  employees,
  existingAssignments,
  initialStaffUid,
  initialFromSerial,
  resolveStudentContext,
  onClose,
  onNotify,
}) => {
  const defaultCentre: CentreId =
    currentUser.role === 'super_admin'
      ? selectedCentreFilter === 'all'
        ? currentUser.centreId
        : selectedCentreFilter
      : currentUser.centreId;

  const [centreId, setCentreId] = useState<CentreId>(defaultCentre);
  const [staffUid, setStaffUid] = useState<string>('');
  const [fromSerial, setFromSerial] = useState<string>('1');
  const [toSerial, setToSerial] = useState<string>('50');
  const [onlyPendingInRange, setOnlyPendingInRange] = useState<boolean>(false);
  const [replaceExistingActive, setReplaceExistingActive] = useState<boolean>(true);
  const [note, setNote] = useState<string>('');
  const [submitting, setSubmitting] = useState<boolean>(false);

  useEffect(() => {
    if (!open) return;
    const resolvedCentre: CentreId =
      currentUser.role === 'super_admin'
        ? selectedCentreFilter === 'all'
          ? currentUser.centreId
          : selectedCentreFilter
        : currentUser.centreId;
    setCentreId(resolvedCentre);

    const start = Math.max(1, initialFromSerial || 1);
    setFromSerial(String(start));
    setToSerial(String(start + 49));
    setOnlyPendingInRange(false);
    setReplaceExistingActive(true);
    setNote('');

    const staffList = getEligibleStaffForCentre(employees, resolvedCentre, department);
    if (initialStaffUid && staffList.some((s) => s.uid === initialStaffUid)) {
      setStaffUid(initialStaffUid);
    } else {
      setStaffUid(staffList[0]?.uid || '');
    }
  }, [open, currentUser, selectedCentreFilter, employees, department, initialStaffUid, initialFromSerial]);

  const eligibleStaff = useMemo(
    () => getEligibleStaffForCentre(employees, centreId, department),
    [employees, centreId, department],
  );

  useEffect(() => {
    if (!open) return;
    if (!eligibleStaff.some((s) => s.uid === staffUid)) {
      setStaffUid(eligibleStaff[0]?.uid || '');
    }
  }, [eligibleStaff, staffUid, open]);

  const centreStudents = useMemo(
    () => students.filter((s) => s.centreId === centreId),
    [students, centreId],
  );

  // Build centre-scoped 1..N serial map if Super Admin switched centre inside modal while global filter was 'all'
  const effectiveSerialMap = useMemo(() => {
    if (selectedCentreFilter === centreId || currentUser.role !== 'super_admin') {
      return displaySerialMap;
    }
    const sorted = [...centreStudents].sort((a, b) => (a.serialNumber || 0) - (b.serialNumber || 0));
    const map = new Map<string, number>();
    sorted.forEach((s, idx) => map.set(s.studentId, idx + 1));
    return map;
  }, [centreStudents, centreId, currentUser.role, displaySerialMap, selectedCentreFilter]);

  const parsedFrom = Math.max(1, Math.floor(Number(fromSerial) || 1));
  const parsedTo = Math.max(parsedFrom, Math.floor(Number(toSerial) || parsedFrom));

  const matchedStudents = useMemo(() => {
    return selectStudentsForAssignmentRange(
      centreStudents,
      effectiveSerialMap,
      parsedFrom,
      parsedTo,
      onlyPendingInRange ? (st) => resolveStudentContext(st).isPendingWork : undefined,
    );
  }, [centreStudents, effectiveSerialMap, parsedFrom, parsedTo, onlyPendingInRange, resolveStudentContext]);

  const selectedStaff = eligibleStaff.find((s) => s.uid === staffUid) || null;
  const activeExistingCountForStaff = useMemo(() => {
    if (!selectedStaff) return 0;
    return existingAssignments.filter(
      (a) =>
        a.staffUid === selectedStaff.uid &&
        a.department === department &&
        a.centreId === centreId &&
        a.status === 'Active',
    ).length;
  }, [existingAssignments, selectedStaff, department, centreId]);

  if (!open) return null;

  const deptLabel = WORK_ASSIGNMENT_DEPARTMENT_LABELS[department];
  const pendingFilterLabel =
    department === 'fee_recovery'
      ? 'Only Unpaid / Pending Fee students in range'
      : department === 'practical'
        ? 'Only Pending / Incomplete Practical students in range'
        : 'Only Pending / Not Submitted TMA students in range';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedStaff) {
      onNotify('Select Staff Member', 'Please select an active staff member to assign calling work.', 'warning');
      return;
    }
    if (matchedStudents.length === 0) {
      onNotify(
        'No Students in Range',
        `No students found between S.No #${parsedFrom} and #${parsedTo} in ${CENTRE_MAP[centreId].name}.`,
        'warning',
      );
      return;
    }

    setSubmitting(true);
    try {
      const items: CreateWorkAssignmentTaskInput[] = matchedStudents.map(({ student, displaySerial }) => {
        const ctx = resolveStudentContext(student);
        return {
          student,
          displaySerial,
          subject: ctx.subject,
          pendingFee: ctx.pendingFee,
          totalFee: ctx.totalFee,
        };
      });

      const res = await createWorkAssignmentBatch({
        centreId,
        department,
        staff: selectedStaff,
        fromSerial: parsedFrom,
        toSerial: parsedTo,
        items,
        replaceExistingActive,
        existingAssignments,
        note,
        actor: currentUser,
      });

      onNotify(
        'Work Assigned Successfully',
        `Assigned ${res.taskCount} students (S.No #${parsedFrom}–#${parsedTo}) to ${selectedStaff.fullName} for ${deptLabel}.`,
        'success',
      );
      onClose();
    } catch (err) {
      onNotify(
        'Assignment Failed',
        err instanceof Error ? err.message : 'Unable to assign work batch.',
        'error',
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[#040E24]/75 backdrop-blur-sm p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="work-assignment-modal-title"
    >
      <div className="bg-white rounded-2xl border border-slate-200 shadow-2xl max-w-xl w-full max-h-[92vh] overflow-y-auto p-6">
        <div className="flex items-start justify-between pb-4 border-b border-slate-200">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-xl bg-red-50 border border-red-200 text-red-700 flex items-center justify-center shrink-0">
              <ClipboardList className="w-5 h-5" />
            </div>
            <div>
              <h3 id="work-assignment-modal-title" className="text-base font-bold text-slate-950">
                Assign {deptLabel} Work
              </h3>
              <p className="text-xs text-slate-600 mt-0.5">
                Select staff member and student serial range (e.g., S.No 1 to 50). Staff will see only this assigned calling box.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close Assign Work Modal"
            className="text-slate-500 hover:text-slate-900 p-1 rounded-lg"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="mt-4 space-y-4">
          {/* Centre Selector for Super Admin */}
          {currentUser.role === 'super_admin' && (
            <div>
              <label htmlFor="wa-centre-select" className="block text-xs font-bold text-slate-800 mb-1">
                Branch / Centre
              </label>
              <select
                id="wa-centre-select"
                value={centreId}
                onChange={(e) => setCentreId(e.target.value as CentreId)}
                className="w-full px-3 py-2 text-sm bg-white text-slate-900 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-slate-900"
              >
                {CANONICAL_CENTRES.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.code})
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Staff Selector */}
          <div>
            <label htmlFor="wa-staff-select" className="block text-xs font-bold text-slate-800 mb-1">
              Assign To Staff Member
            </label>
            {eligibleStaff.length === 0 ? (
              <div className="p-3 rounded-lg bg-amber-50 border border-amber-300 text-xs text-amber-950 flex items-start gap-2">
                <Users className="w-4 h-4 shrink-0 mt-0.5 text-amber-700" />
                <span>
                  No active staff accounts found in <strong>{CENTRE_MAP[centreId].name}</strong>. Please create a staff account in <strong>Staff &amp; Access</strong> first.
                </span>
              </div>
            ) : (
              <select
                id="wa-staff-select"
                value={staffUid}
                onChange={(e) => setStaffUid(e.target.value)}
                required
                className="w-full px-3 py-2 text-sm bg-white text-slate-900 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-slate-900"
              >
                {eligibleStaff.map((emp) => (
                  <option key={emp.uid} value={emp.uid}>
                    {emp.fullName} — {emp.department.replace('_', ' ').toUpperCase()} ({emp.email})
                  </option>
                ))}
              </select>
            )}
          </div>

          {/* Serial Number Range */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-slate-800">
                Student Serial Range (Total in Branch: {centreStudents.length})
              </span>
              <div className="flex items-center gap-1.5">
                {[
                  { label: '1–50', from: 1, to: 50 },
                  { label: '51–100', from: 51, to: 100 },
                  { label: '101–150', from: 101, to: 150 },
                ].map((preset) => (
                  <button
                    key={preset.label}
                    type="button"
                    onClick={() => {
                      setFromSerial(String(preset.from));
                      setToSerial(String(preset.to));
                    }}
                    className="px-2 py-0.5 text-[11px] font-mono font-bold text-slate-700 bg-slate-100 hover:bg-slate-200 border border-slate-300 rounded"
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="wa-from-serial" className="block text-[11px] font-semibold text-slate-600 mb-1">
                  From S.No
                </label>
                <input
                  id="wa-from-serial"
                  type="number"
                  min={1}
                  max={100000}
                  value={fromSerial}
                  onChange={(e) => setFromSerial(e.target.value)}
                  required
                  className="w-full px-3 py-2 text-sm font-mono font-bold bg-white text-slate-950 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-slate-900"
                />
              </div>
              <div>
                <label htmlFor="wa-to-serial" className="block text-[11px] font-semibold text-slate-600 mb-1">
                  To S.No
                </label>
                <input
                  id="wa-to-serial"
                  type="number"
                  min={1}
                  max={100000}
                  value={toSerial}
                  onChange={(e) => setToSerial(e.target.value)}
                  required
                  className="w-full px-3 py-2 text-sm font-mono font-bold bg-white text-slate-950 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-slate-900"
                />
              </div>
            </div>
          </div>

          {/* Live Range Match Preview */}
          <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200 space-y-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className="font-semibold text-slate-700">Students Ready to Assign:</span>
              <span
                className={`font-mono font-extrabold text-sm tabular-nums ${
                  matchedStudents.length > 0 ? 'text-emerald-700' : 'text-red-700'
                }`}
              >
                {matchedStudents.length} Student{matchedStudents.length === 1 ? '' : 's'}
              </span>
            </div>
            {matchedStudents.length > 0 ? (
              <p className="text-[11px] text-slate-600 font-mono truncate">
                First: #{matchedStudents[0].displaySerial} {matchedStudents[0].student.studentName}
                {matchedStudents.length > 1
                  ? `  →  Last: #${matchedStudents[matchedStudents.length - 1].displaySerial} ${matchedStudents[matchedStudents.length - 1].student.studentName}`
                  : ''}
              </p>
            ) : (
              <p className="text-[11px] text-red-700">
                No students match S.No #{parsedFrom}–#{parsedTo}. Adjust the range or filter below.
              </p>
            )}
          </div>

          {/* Options */}
          <div className="space-y-2.5">
            <label className="flex items-center gap-2.5 text-xs text-slate-800 cursor-pointer">
              <input
                type="checkbox"
                checked={onlyPendingInRange}
                onChange={(e) => setOnlyPendingInRange(e.target.checked)}
                className="w-4 h-4 rounded border-slate-300 text-red-700 focus:ring-red-600"
              />
              <span className="font-medium">{pendingFilterLabel}</span>
            </label>

            <label className="flex items-start gap-2.5 text-xs text-slate-800 cursor-pointer">
              <input
                type="checkbox"
                checked={replaceExistingActive}
                onChange={(e) => setReplaceExistingActive(e.target.checked)}
                className="w-4 h-4 mt-0.5 rounded border-slate-300 text-red-700 focus:ring-red-600"
              />
              <span>
                <strong className="font-semibold text-slate-900">
                  Replace staff&apos;s previous active batch
                </strong>
                {activeExistingCountForStaff > 0 && (
                  <span className="block text-[11px] text-slate-600 mt-0.5">
                    {selectedStaff?.fullName} currently has {activeExistingCountForStaff} active batch(es). Checking this archives older batch(es) so they see only this new list all day.
                  </span>
                )}
              </span>
            </label>
          </div>

          {/* Note */}
          <div>
            <label htmlFor="wa-note" className="block text-xs font-bold text-slate-800 mb-1">
              Instruction / Note for Staff (Optional)
            </label>
            <input
              id="wa-note"
              type="text"
              maxLength={500}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g., Aaj shaam 5 baje tak sabko call karke follow-up time note kar lena"
              className="w-full px-3 py-2 text-sm bg-white text-slate-900 placeholder:text-slate-400 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-slate-900"
            />
          </div>

          <div className="pt-3 border-t border-slate-200 flex items-center justify-end gap-2.5">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting || !selectedStaff || matchedStudents.length === 0}
              className="px-5 py-2 text-xs font-bold text-white btn-crimson-gloss rounded-lg disabled:opacity-50"
            >
              {submitting
                ? 'Assigning Work...'
                : `Assign ${matchedStudents.length} Student${matchedStudents.length === 1 ? '' : 's'}`}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
