import {
  Check,
  CheckSquare,
  ClipboardList,
  Lock,
  RotateCcw,
  Search,
  Sparkles,
  Users,
  X,
} from 'lucide-react';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { CANONICAL_CENTRES, CENTRE_MAP } from '../constants/centres';
import {
  computeSelectedSerialBounds,
  extractStudentCallingNumber,
  extractStudentFatherName,
  formatLocalDateIso,
  getEligibleStaffForCentre,
  getNextAvailableStudentIds,
  getSelectableStudentIdsInRange,
  getStudentsAssignedTodayMap,
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
  WorkAssignmentTask,
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
  existingTasks: WorkAssignmentTask[];
  /** Optional pre-selected staff UID (e.g., when re-assigning to a specific staff member) */
  initialStaffUid?: string;
  /** Optional suggested starting serial number */
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

const RANGE_PRESETS: Array<{ label: string; from: number; to: number }> = [
  { label: '1–25', from: 1, to: 25 },
  { label: '26–50', from: 26, to: 50 },
  { label: '51–75', from: 51, to: 75 },
  { label: '76–100', from: 76, to: 100 },
];

export const WorkAssignmentModal: React.FC<WorkAssignmentModalProps> = ({
  open,
  department,
  currentUser,
  selectedCentreFilter,
  students,
  displaySerialMap,
  employees,
  existingAssignments,
  existingTasks,
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
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [rangeFrom, setRangeFrom] = useState<string>('1');
  const [rangeTo, setRangeTo] = useState<string>('25');
  const [onlyPending, setOnlyPending] = useState<boolean>(false);
  const [hideAssignedToday, setHideAssignedToday] = useState<boolean>(false);
  const [replaceExistingActive, setReplaceExistingActive] = useState<boolean>(true);
  const [note, setNote] = useState<string>('');
  const [selectionHint, setSelectionHint] = useState<string>('');
  const [submitting, setSubmitting] = useState<boolean>(false);

  const tableContainerRef = useRef<HTMLDivElement | null>(null);

  // Re-compute local calendar date whenever modal opens so midnight rollover auto-unlocks yesterday's batch
  const todayIso = useMemo(() => {
    void open;
    return formatLocalDateIso(new Date());
  }, [open]);

  const todayDisplayLabel = useMemo(() => {
    const parts = todayIso.split('-').map(Number);
    if (parts.length !== 3) return todayIso;
    const dt = new Date(parts[0], parts[1] - 1, parts[2]);
    return dt.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  }, [todayIso]);

  useEffect(() => {
    if (!open) return;
    const resolvedCentre: CentreId =
      currentUser.role === 'super_admin'
        ? selectedCentreFilter === 'all'
          ? currentUser.centreId
          : selectedCentreFilter
        : currentUser.centreId;
    setCentreId(resolvedCentre);

    const suggestedStart = Math.max(1, initialFromSerial || 1);
    setRangeFrom(String(suggestedStart));
    setRangeTo(String(suggestedStart + 24));
    // Start with 0 rows ticked so admin explicitly ticks rows manually or clicks 1–25 / Tick Range
    setSelectedIds(new Set());
    setSearchQuery('');
    setOnlyPending(false);
    setHideAssignedToday(false);
    setReplaceExistingActive(true);
    setNote('');
    setSelectionHint('');

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

  // Same-day assignment lock: students assigned today in this centre + department cannot be assigned again today
  const assignedTodayMap = useMemo(
    () => getStudentsAssignedTodayMap(existingAssignments, existingTasks, centreId, department, todayIso),
    [existingAssignments, existingTasks, centreId, department, todayIso],
  );

  // Automatically drop any selected IDs if they become locked today (e.g., via live Firestore update) or branch changes
  useEffect(() => {
    if (!open) return;
    setSelectedIds((prev) => {
      if (prev.size === 0) return prev;
      const validBranchIds = new Set(centreStudents.map((s) => s.studentId));
      let changed = false;
      const next = new Set<string>();
      prev.forEach((id) => {
        if (validBranchIds.has(id) && !assignedTodayMap.has(id)) {
          next.add(id);
        } else {
          changed = true;
        }
      });
      return changed ? next : prev;
    });
  }, [open, centreStudents, assignedTodayMap]);

  // Build complete sorted Excel rows for this branch
  const allBranchRows = useMemo(() => {
    return centreStudents
      .map((student) => {
        const displaySerial =
          effectiveSerialMap.get(student.studentId) ?? (Number(student.serialNumber) || 0);
        const ctx = resolveStudentContext(student);
        const fatherName = extractStudentFatherName(student);
        const callingNumber = extractStudentCallingNumber(student);
        const lockedToday = assignedTodayMap.get(student.studentId);
        return {
          student,
          displaySerial,
          ctx,
          fatherName,
          callingNumber,
          lockedToday,
        };
      })
      .sort((a, b) => a.displaySerial - b.displaySerial);
  }, [centreStudents, effectiveSerialMap, resolveStudentContext, assignedTodayMap]);

  // Apply table filters (Pending toggle, Hide Locked Today toggle, Live search)
  const visibleRows = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return allBranchRows.filter((row) => {
      if (onlyPending && !row.ctx.isPendingWork) return false;
      if (hideAssignedToday && row.lockedToday) return false;
      if (q) {
        const matches =
          String(row.displaySerial).includes(q) ||
          row.student.studentName.toLowerCase().includes(q) ||
          row.student.studentId.toLowerCase().includes(q) ||
          row.fatherName.toLowerCase().includes(q) ||
          row.callingNumber.toLowerCase().includes(q) ||
          row.ctx.subject.toLowerCase().includes(q) ||
          (row.lockedToday?.staffName.toLowerCase().includes(q) ?? false);
        if (!matches) return false;
      }
      return true;
    });
  }, [allBranchRows, onlyPending, hideAssignedToday, searchQuery]);

  const totalLockedToday = useMemo(
    () => allBranchRows.filter((r) => Boolean(r.lockedToday)).length,
    [allBranchRows],
  );
  const totalAvailableToday = allBranchRows.length - totalLockedToday;

  const visibleUnlockedRows = useMemo(
    () => visibleRows.filter((r) => !r.lockedToday),
    [visibleRows],
  );

  const allVisibleUnlockedSelected =
    visibleUnlockedRows.length > 0 &&
    visibleUnlockedRows.every((r) => selectedIds.has(r.student.studentId));

  const selectedRows = useMemo(
    () =>
      allBranchRows.filter(
        (r) => selectedIds.has(r.student.studentId) && !r.lockedToday,
      ),
    [allBranchRows, selectedIds],
  );

  const selectedBounds = useMemo(
    () => computeSelectedSerialBounds(selectedRows),
    [selectedRows],
  );

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
      ? 'Only Unpaid / Pending Fee'
      : department === 'practical'
        ? 'Only Pending Practical'
        : 'Only Pending TMA';

  const scrollToStudentRow = (studentId: string | undefined) => {
    if (!studentId || !tableContainerRef.current) return;
    requestAnimationFrame(() => {
      const el = tableContainerRef.current?.querySelector(
        `[data-wa-student-id="${CSS.escape(studentId)}"]`,
      );
      if (el instanceof HTMLElement) {
        el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    });
  };

  const toggleStudent = (studentId: string) => {
    if (assignedTodayMap.has(studentId)) return;
    setSelectionHint('');
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(studentId)) {
        next.delete(studentId);
      } else {
        next.add(studentId);
      }
      return next;
    });
  };

  const handleToggleAllVisible = () => {
    setSelectionHint('');
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allVisibleUnlockedSelected) {
        visibleUnlockedRows.forEach((r) => next.delete(r.student.studentId));
      } else {
        visibleUnlockedRows.forEach((r) => next.add(r.student.studentId));
      }
      return next;
    });
  };

  const handleQuickPreset = (from: number, to: number) => {
    setRangeFrom(String(from));
    setRangeTo(String(to));
    const predicate = onlyPending ? (st: Student) => resolveStudentContext(st).isPendingWork : undefined;
    const ids = getSelectableStudentIdsInRange(
      centreStudents,
      effectiveSerialMap,
      from,
      to,
      assignedTodayMap,
      predicate,
    );

    const lockedInRangeCount = allBranchRows.filter(
      (r) =>
        r.displaySerial >= from &&
        r.displaySerial <= to &&
        Boolean(r.lockedToday) &&
        (!onlyPending || r.ctx.isPendingWork),
    ).length;

    setSelectedIds(new Set(ids));
    if (ids.length === 0) {
      setSelectionHint(
        lockedInRangeCount > 0
          ? `S.No #${from}–#${to} ke sabhi ${lockedInRangeCount} students aaj already assign ho chuke hain (kal dubara unlock honge).`
          : `S.No #${from}–#${to} me koi available student nahi mila.`,
      );
    } else if (lockedInRangeCount > 0) {
      setSelectionHint(
        `S.No #${from}–#${to} se ${ids.length} students tick kiye gaye (${lockedInRangeCount} already assigned today — skipped).`,
      );
    } else {
      setSelectionHint(`S.No #${from}–#${to} se ${ids.length} students Excel sheet me tick ho gaye.`);
    }
    scrollToStudentRow(ids[0]);
  };

  const handleTickCustomRange = () => {
    const parsedFrom = Math.max(1, Math.floor(Number(rangeFrom) || 1));
    const parsedTo = Math.max(parsedFrom, Math.floor(Number(rangeTo) || parsedFrom));
    setRangeFrom(String(parsedFrom));
    setRangeTo(String(parsedTo));

    const predicate = onlyPending ? (st: Student) => resolveStudentContext(st).isPendingWork : undefined;
    const ids = getSelectableStudentIdsInRange(
      centreStudents,
      effectiveSerialMap,
      parsedFrom,
      parsedTo,
      assignedTodayMap,
      predicate,
    );

    const lockedInRangeCount = allBranchRows.filter(
      (r) =>
        r.displaySerial >= parsedFrom &&
        r.displaySerial <= parsedTo &&
        Boolean(r.lockedToday) &&
        (!onlyPending || r.ctx.isPendingWork),
    ).length;

    setSelectedIds((prev) => {
      const next = new Set(prev);
      ids.forEach((id) => next.add(id));
      return next;
    });

    if (ids.length === 0) {
      setSelectionHint(
        lockedInRangeCount > 0
          ? `S.No #${parsedFrom}–#${parsedTo} ke sabhi ${lockedInRangeCount} students aaj already assign hain.`
          : `S.No #${parsedFrom}–#${parsedTo} me koi available student nahi mila.`,
      );
    } else if (lockedInRangeCount > 0) {
      setSelectionHint(
        `S.No #${parsedFrom}–#${parsedTo} ke ${ids.length} available students tick kiye gaye (${lockedInRangeCount} locked today skipped).`,
      );
    } else {
      setSelectionHint(`S.No #${parsedFrom}–#${parsedTo} ke ${ids.length} students tick ho gaye.`);
    }
    scrollToStudentRow(ids[0]);
  };

  const handleTickNext25 = () => {
    const predicate = onlyPending ? (st: Student) => resolveStudentContext(st).isPendingWork : undefined;
    const ids = getNextAvailableStudentIds(
      centreStudents,
      effectiveSerialMap,
      25,
      assignedTodayMap,
      predicate,
    );
    setSelectedIds(new Set(ids));
    if (ids.length === 0) {
      setSelectionHint('Aaj ke liye sabhi eligible students already assign ho chuke hain. Kal auto-unlock ho jayenge.');
    } else {
      setSelectionHint(`Next ${ids.length} unlocked students automatically tick ho gaye.`);
      scrollToStudentRow(ids[0]);
    }
  };

  const handleClearSelection = () => {
    setSelectedIds(new Set());
    setSelectionHint('');
  };

  const handleBranchChange = (nextCentre: CentreId) => {
    setCentreId(nextCentre);
    setSelectedIds(new Set());
    setSelectionHint('');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedStaff) {
      onNotify('Select Staff Member', 'Please select an active staff member to assign calling work.', 'warning');
      return;
    }
    if (selectedRows.length === 0) {
      onNotify(
        'No Students Ticked',
        'Excel sheet me kam se kam 1 available student tick karein (ya 1–25 button click karein).',
        'warning',
      );
      return;
    }

    setSubmitting(true);
    try {
      const items: CreateWorkAssignmentTaskInput[] = selectedRows.map(({ student, displaySerial, ctx }) => ({
        student,
        displaySerial,
        subject: ctx.subject,
        pendingFee: ctx.pendingFee,
        totalFee: ctx.totalFee,
      }));

      const res = await createWorkAssignmentBatch({
        centreId,
        department,
        staff: selectedStaff,
        fromSerial: selectedBounds.fromSerial,
        toSerial: selectedBounds.toSerial,
        items,
        replaceExistingActive,
        existingAssignments,
        existingTasks,
        note,
        actor: currentUser,
      });

      onNotify(
        'Work Assigned Successfully',
        `${res.taskCount} ticked students (S.No #${selectedBounds.fromSerial}–#${selectedBounds.toSerial}) ${selectedStaff.fullName} ko assign ho gaye. Ye students aaj ke liye locked rahenge aur kal dubara assign ho sakenge.`,
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
      className="fixed inset-0 z-50 flex items-center justify-center bg-[#040E24]/75 backdrop-blur-sm p-3 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="work-assignment-modal-title"
    >
      <form
        onSubmit={handleSubmit}
        className="bg-white rounded-2xl border border-slate-200 shadow-2xl max-w-6xl w-full max-h-[94vh] flex flex-col overflow-hidden"
      >
        {/* Sticky Header */}
        <div className="px-5 py-4 border-b border-slate-200 flex items-start justify-between gap-4 bg-white shrink-0">
          <div className="flex items-start gap-3 min-w-0">
            <div className="w-10 h-10 rounded-xl bg-red-50 border border-red-200 text-red-700 flex items-center justify-center shrink-0">
              <ClipboardList className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h3 id="work-assignment-modal-title" className="text-base font-bold text-slate-950">
                  Assign {deptLabel} Work — Excel Selector
                </h3>
                <span className="px-2 py-0.5 text-[11px] font-mono font-bold text-slate-700 bg-slate-100 border border-slate-200 rounded">
                  Today: {todayDisplayLabel}
                </span>
              </div>
              <p className="text-xs text-slate-600 mt-0.5">
                Excel sheet me manually students tick karein ya <strong className="text-slate-800">1–25</strong> / custom range se tick karein. Jo student aaj assign ho gaya wo aaj kisi aur ko assign nahi hoga — kal automatically unlock ho jayega.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close Assign Work Modal"
            className="text-slate-500 hover:text-slate-900 p-1.5 rounded-lg hover:bg-slate-100 shrink-0"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Top Assignment Controls (Branch, Staff, Note) */}
        <div className="px-5 py-3.5 bg-slate-50/70 border-b border-slate-200 shrink-0 space-y-3">
          <div
            className={`grid grid-cols-1 gap-3 ${
              currentUser.role === 'super_admin' ? 'md:grid-cols-3' : 'md:grid-cols-2'
            }`}
          >
            {currentUser.role === 'super_admin' && (
              <div>
                <label htmlFor="wa-centre-select" className="block text-[11px] font-bold text-slate-700 uppercase tracking-wide mb-1">
                  Branch / Centre
                </label>
                <select
                  id="wa-centre-select"
                  value={centreId}
                  onChange={(e) => handleBranchChange(e.target.value as CentreId)}
                  className="w-full px-3 py-2 text-xs font-semibold bg-white text-slate-900 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-slate-900"
                >
                  {CANONICAL_CENTRES.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} ({c.code})
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div>
              <label htmlFor="wa-staff-select" className="block text-[11px] font-bold text-slate-700 uppercase tracking-wide mb-1">
                Assign To Staff Member
              </label>
              {eligibleStaff.length === 0 ? (
                <div className="px-3 py-2 rounded-lg bg-amber-50 border border-amber-300 text-xs text-amber-950 flex items-center gap-2">
                  <Users className="w-4 h-4 shrink-0 text-amber-700" />
                  <span className="truncate">
                    No active staff in <strong>{CENTRE_MAP[centreId].code}</strong>. Add in Staff &amp; Access.
                  </span>
                </div>
              ) : (
                <select
                  id="wa-staff-select"
                  value={staffUid}
                  onChange={(e) => setStaffUid(e.target.value)}
                  required
                  className="w-full px-3 py-2 text-xs font-semibold bg-white text-slate-900 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-slate-900"
                >
                  {eligibleStaff.map((emp) => (
                    <option key={emp.uid} value={emp.uid}>
                      {emp.fullName} — {emp.department.replace('_', ' ').toUpperCase()} ({emp.email})
                    </option>
                  ))}
                </select>
              )}
            </div>

            <div>
              <label htmlFor="wa-note" className="block text-[11px] font-bold text-slate-700 uppercase tracking-wide mb-1">
                Instruction / Note (Optional)
              </label>
              <input
                id="wa-note"
                type="text"
                maxLength={500}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="e.g., Aaj shaam 5 baje tak sabko call karke remark save karna"
                className="w-full px-3 py-2 text-xs bg-white text-slate-900 placeholder:text-slate-400 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-slate-900"
              />
            </div>
          </div>

          {/* Excel Selection Toolbar */}
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-2.5 pt-2 border-t border-slate-200/80">
            {/* Search inside Excel */}
            <div className="relative w-full lg:w-64 shrink-0">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search S.No, name, father, mobile..."
                className="w-full pl-8 pr-3 py-1.5 text-xs bg-white text-slate-900 placeholder:text-slate-400 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-slate-900"
              />
            </div>

            {/* Quick Tick Presets + Custom Range */}
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] font-bold text-slate-600 mr-0.5">Quick Tick:</span>
              {RANGE_PRESETS.map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  onClick={() => handleQuickPreset(preset.from, preset.to)}
                  className="px-2.5 py-1 text-[11px] font-mono font-bold text-slate-800 bg-white hover:bg-red-50 hover:text-red-700 hover:border-red-300 border border-slate-300 rounded-md transition-colors"
                >
                  {preset.label}
                </button>
              ))}
              <button
                type="button"
                onClick={handleTickNext25}
                className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-bold text-red-700 bg-red-50 hover:bg-red-100 border border-red-200 rounded-md transition-colors"
              >
                <Sparkles className="w-3 h-3" />
                Next 25 Available
              </button>

              <div className="hidden sm:block h-4 w-px bg-slate-300 mx-1" />

              {/* Custom S.No Range -> Tick */}
              <div className="inline-flex items-center gap-1 bg-white border border-slate-300 rounded-md px-1.5 py-0.5">
                <span className="text-[10px] font-bold text-slate-500 uppercase">S.No</span>
                <input
                  type="number"
                  min={1}
                  max={100000}
                  value={rangeFrom}
                  onChange={(e) => setRangeFrom(e.target.value)}
                  aria-label="From S.No"
                  className="w-12 px-1 py-0.5 text-xs font-mono font-bold text-slate-900 text-center bg-slate-50 border border-slate-200 rounded focus:outline-none focus:border-slate-900"
                />
                <span className="text-[10px] font-semibold text-slate-400">to</span>
                <input
                  type="number"
                  min={1}
                  max={100000}
                  value={rangeTo}
                  onChange={(e) => setRangeTo(e.target.value)}
                  aria-label="To S.No"
                  className="w-12 px-1 py-0.5 text-xs font-mono font-bold text-slate-900 text-center bg-slate-50 border border-slate-200 rounded focus:outline-none focus:border-slate-900"
                />
                <button
                  type="button"
                  onClick={handleTickCustomRange}
                  className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-bold text-white bg-slate-900 hover:bg-slate-800 rounded"
                >
                  <CheckSquare className="w-3 h-3" />
                  Tick
                </button>
              </div>

              {selectedIds.size > 0 && (
                <button
                  type="button"
                  onClick={handleClearSelection}
                  className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-semibold text-slate-600 hover:text-red-700 bg-white border border-slate-300 hover:border-red-300 rounded-md"
                >
                  <RotateCcw className="w-3 h-3" />
                  Clear
                </button>
              )}
            </div>
          </div>

          {/* Filter toggles & live status counters */}
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
              <label className="inline-flex items-center gap-1.5 text-slate-800 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={onlyPending}
                  onChange={(e) => setOnlyPending(e.target.checked)}
                  className="w-3.5 h-3.5 rounded border-slate-300 text-red-700 focus:ring-red-600"
                />
                <span className="font-medium">{pendingFilterLabel}</span>
              </label>

              <label className="inline-flex items-center gap-1.5 text-slate-800 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={hideAssignedToday}
                  onChange={(e) => setHideAssignedToday(e.target.checked)}
                  className="w-3.5 h-3.5 rounded border-slate-300 text-red-700 focus:ring-red-600"
                />
                <span className="font-medium">Hide Assigned Today ({totalLockedToday})</span>
              </label>

              <label className="inline-flex items-center gap-1.5 text-slate-800 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={replaceExistingActive}
                  onChange={(e) => setReplaceExistingActive(e.target.checked)}
                  className="w-3.5 h-3.5 rounded border-slate-300 text-red-700 focus:ring-red-600"
                />
                <span className="font-medium">
                  Replace staff&apos;s previous active batch
                  {activeExistingCountForStaff > 0 ? ` (${activeExistingCountForStaff})` : ''}
                </span>
              </label>
            </div>

            <div className="flex flex-wrap items-center gap-3 text-[11px] font-mono tabular-nums">
              <span className="font-bold text-emerald-700">
                Ticked: {selectedRows.length}
              </span>
              <span className="text-slate-300">|</span>
              <span className="font-semibold text-slate-700">
                Available Today: {totalAvailableToday}
              </span>
              <span className="text-slate-300">|</span>
              <span className="font-semibold text-amber-700">
                Locked Today: {totalLockedToday}
              </span>
            </div>
          </div>

          {selectionHint && (
            <div className="px-3 py-1.5 rounded-lg bg-red-50/80 border border-red-200 text-[11px] font-medium text-red-900">
              {selectionHint}
            </div>
          )}
        </div>

        {/* Scrollable Excel-Style Student Table */}
        <div
          ref={tableContainerRef}
          className="flex-1 min-h-[260px] overflow-auto bg-white"
        >
          <table className="w-full text-left border-collapse text-xs">
            <thead className="sticky top-0 z-10 bg-slate-100 border-b border-slate-300 text-[11px] font-bold uppercase tracking-wider text-slate-700">
              <tr>
                <th className="py-2.5 pl-4 pr-2 w-10 border-r border-slate-200 text-center">
                  <input
                    type="checkbox"
                    checked={allVisibleUnlockedSelected}
                    disabled={visibleUnlockedRows.length === 0}
                    onChange={handleToggleAllVisible}
                    aria-label="Select all visible available students"
                    title="Select / deselect all visible available students"
                    className="w-4 h-4 rounded border-slate-400 text-red-700 focus:ring-red-600 cursor-pointer disabled:opacity-40"
                  />
                </th>
                <th className="py-2.5 px-3 w-20 border-r border-slate-200 font-mono">S.No</th>
                <th className="py-2.5 px-3 min-w-[180px] border-r border-slate-200">Student Name</th>
                <th className="py-2.5 px-3 min-w-[160px] border-r border-slate-200">Father&apos;s Name</th>
                <th className="py-2.5 px-3 w-32 border-r border-slate-200">Contact</th>
                <th className="py-2.5 px-3 min-w-[140px] border-r border-slate-200">
                  {department === 'fee_recovery' ? 'Pending / Total Fee' : 'Subjects'}
                </th>
                <th className="py-2.5 px-3 min-w-[170px]">Today&apos;s Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {visibleRows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-12 text-center text-slate-500">
                    <p className="text-sm font-semibold text-slate-700">No students match the current filter.</p>
                    <p className="text-xs text-slate-500 mt-1">
                      Search clear karein ya &quot;Only Pending&quot; / &quot;Hide Assigned Today&quot; untick karke dekhein.
                    </p>
                  </td>
                </tr>
              ) : (
                visibleRows.map((row) => {
                  const isLocked = Boolean(row.lockedToday);
                  const isTicked = !isLocked && selectedIds.has(row.student.studentId);

                  return (
                    <tr
                      key={row.student.studentId}
                      data-wa-student-id={row.student.studentId}
                      onClick={() => {
                        if (!isLocked) toggleStudent(row.student.studentId);
                      }}
                      className={`transition-colors ${
                        isLocked
                          ? 'bg-slate-100/80 text-slate-400 cursor-not-allowed'
                          : isTicked
                            ? 'bg-emerald-50/85 hover:bg-emerald-50 text-slate-950 cursor-pointer'
                            : 'bg-white hover:bg-slate-50 text-slate-900 cursor-pointer'
                      }`}
                    >
                      <td
                        className="py-2 pl-4 pr-2 border-r border-slate-200/80 text-center"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <input
                          type="checkbox"
                          checked={isTicked}
                          disabled={isLocked}
                          onChange={() => toggleStudent(row.student.studentId)}
                          aria-label={`Select S.No ${row.displaySerial} ${row.student.studentName}`}
                          className="w-4 h-4 rounded border-slate-400 text-red-700 focus:ring-red-600 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                        />
                      </td>
                      <td className="py-2 px-3 border-r border-slate-200/80 font-mono font-bold tabular-nums whitespace-nowrap">
                        <span className={isTicked ? 'text-emerald-800' : isLocked ? 'text-slate-400' : 'text-slate-700'}>
                          #{row.displaySerial}
                        </span>
                      </td>
                      <td className="py-2 px-3 border-r border-slate-200/80">
                        <div className={`font-bold leading-snug ${isLocked ? 'text-slate-500 line-through decoration-slate-300' : 'text-slate-950'}`}>
                          {row.student.studentName}
                        </div>
                        <div className="text-[10px] font-mono text-slate-500">{row.student.studentId}</div>
                      </td>
                      <td className="py-2 px-3 border-r border-slate-200/80 text-slate-700">
                        {row.fatherName || <span className="text-slate-400">—</span>}
                      </td>
                      <td className="py-2 px-3 border-r border-slate-200/80 font-mono tabular-nums whitespace-nowrap">
                        {row.callingNumber || <span className="text-slate-400">Not Provided</span>}
                      </td>
                      <td className="py-2 px-3 border-r border-slate-200/80">
                        {department === 'fee_recovery' ? (
                          <div className="font-mono tabular-nums">
                            <span
                              className={`font-bold ${
                                row.ctx.pendingFee > 0
                                  ? isLocked
                                    ? 'text-slate-500'
                                    : 'text-red-700'
                                  : 'text-emerald-700'
                              }`}
                            >
                              ₹{row.ctx.pendingFee.toLocaleString('en-IN')}
                            </span>
                            {row.ctx.totalFee > 0 && (
                              <span className="text-[10px] text-slate-500 ml-1">
                                / ₹{row.ctx.totalFee.toLocaleString('en-IN')}
                              </span>
                            )}
                          </div>
                        ) : (
                          <span className="text-slate-700 line-clamp-1">
                            {row.ctx.subject || '—'}
                          </span>
                        )}
                      </td>
                      <td className="py-2 px-3 whitespace-nowrap">
                        {isLocked && row.lockedToday ? (
                          <span
                            title={`Already assigned today (${row.lockedToday.assignedDate}) to ${row.lockedToday.staffName}. Auto-unlocks tomorrow.`}
                            className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-amber-100 border border-amber-300 text-amber-900 text-[11px] font-bold"
                          >
                            <Lock className="w-3 h-3 shrink-0" />
                            Assigned Today → {row.lockedToday.staffName}
                          </span>
                        ) : isTicked ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-100 border border-emerald-300 text-emerald-800 text-[11px] font-bold">
                            <Check className="w-3 h-3 shrink-0" />
                            Ticked
                          </span>
                        ) : (
                          <span className="text-[11px] font-semibold text-slate-500">Available</span>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Sticky Footer */}
        <div className="px-5 py-3.5 border-t border-slate-200 bg-slate-50 flex flex-col sm:flex-row sm:items-center justify-between gap-3 shrink-0">
          <div className="text-xs text-slate-700 min-w-0">
            {selectedRows.length > 0 ? (
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <span className="font-bold text-emerald-800">
                  {selectedRows.length} Student{selectedRows.length === 1 ? '' : 's'} Selected
                </span>
                <span className="font-mono text-[11px] text-slate-600">
                  (S.No #{selectedBounds.fromSerial}–#{selectedBounds.toSerial})
                </span>
                {selectedStaff && (
                  <span className="text-slate-600">
                    → <strong className="text-slate-900">{selectedStaff.fullName}</strong>
                  </span>
                )}
              </div>
            ) : (
              <span className="text-slate-600">
                Excel table me rows tick karein ya upar <strong className="text-slate-900">1–25</strong> button click karein.
              </span>
            )}
          </div>

          <div className="flex items-center justify-end gap-2.5 shrink-0">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-100"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting || !selectedStaff || selectedRows.length === 0}
              className="px-5 py-2 text-xs font-bold text-white btn-crimson-gloss rounded-lg disabled:opacity-50"
            >
              {submitting
                ? 'Assigning Work...'
                : `Assign ${selectedRows.length} Selected Student${selectedRows.length === 1 ? '' : 's'}`}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
};
