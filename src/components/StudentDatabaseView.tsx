import {
  ArrowUpDown,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  Download,
  Edit3,
  Eye,
  FileSpreadsheet,
  Lock,
  Plus,
  Search,
  Send,
  Trash2,
  Unlock,
  Upload,
  Users,
  X,
  XCircle,
} from 'lucide-react';
import React, { useMemo, useState } from 'react';
import { CANONICAL_CENTRES, CENTRE_MAP, DEPARTMENT_LABELS } from '../constants/centres';
import { buildContextualSerialMap, exportToCsv, exportToExcel } from '../lib/csvUtils';
import { verifyOperationLocation } from '../lib/securityClient';
import {
  checkDuplicateStudent,
  createEditRequest,
  createStudentRecord,
  deleteStudentRecord,
  deleteStudentsBatch,
  getNextSerialNumber,
  isStudentDeptLockedForEmployee,
  reviewEditRequest,
  toggleStudentEmployeeLock,
  updateStudentRecord,
} from '../services/firestoreService';
import type {
  CentreId,
  ClassAttendanceStatus,
  DepartmentId,
  EditRequest,
  PracticalStatus,
  Student,
  TmaStatus,
  UserAccount,
} from '../types/domain';
import { BulkImportModal } from './BulkImportModal';
import { ConfirmDialog } from './ConfirmDialog';
import { StudentFormModal } from './StudentFormModal';
import { StudentProfileModal } from './StudentProfileModal';

interface StudentDatabaseViewProps {
  students: Student[];
  employees: UserAccount[];
  editRequests?: EditRequest[];
  currentUser: UserAccount;
  selectedCentreFilter: CentreId | 'all';
  globalSearch: string;
  loading: boolean;
  onNotify: (title: string, description: string, variant: 'success' | 'error' | 'warning' | 'info') => void;
}

type SortKey = 'serialNumber' | 'studentName' | 'tmaStatus' | 'practicalStatus' | 'classAttendanceStatus';

const EDITABLE_STUDENT_DEPTS = ['admission', 'tma', 'practical', 'online_classes'];

function toExcelColName(index: number): string {
  let n = index;
  let result = '';
  while (n >= 0) {
    result = String.fromCharCode((n % 26) + 65) + result;
    n = Math.floor(n / 26) - 1;
  }
  return result;
}

export function canUserEditStudentRow(student: Student, user: UserAccount): boolean {
  if (user.role === 'super_admin') {
    return true;
  }
  if (user.role === 'centre_head') {
    return student.centreId === user.centreId;
  }
  // Employee per-department rule: can edit ONLY their own department in their own centre, once until Centre Head unlocks
  if (user.role === 'employee') {
    if (student.centreId !== user.centreId) return false;
    if (!EDITABLE_STUDENT_DEPTS.includes(user.department)) return false;
    return !isStudentDeptLockedForEmployee(student, user.department);
  }
  return false;
}

export const StudentDatabaseView: React.FC<StudentDatabaseViewProps> = ({
  students,
  employees,
  editRequests = [],
  currentUser,
  selectedCentreFilter,
  globalSearch,
  loading,
  onNotify,
}) => {
  const [localSearch, setLocalSearch] = useState('');
  const [centreFilter, setCentreFilter] = useState<CentreId | 'all'>(selectedCentreFilter);
  const [tmaFilter, setTmaFilter] = useState('all');
  const [sortKey, setSortKey] = useState<SortKey>('serialNumber');
  const [sortAsc, setSortAsc] = useState(true);
  const [page, setPage] = useState(1);
  const [rowsPerPage, setRowsPerPage] = useState<number>(100);
  const [showExtraColumns, setShowExtraColumns] = useState<boolean>(true);

  const [selectedCell, setSelectedCell] = useState<{ coord: string; value: string }>({
    coord: 'A1',
    value: 'S.No — Database Security Master Sheet',
  });

  // Inline Excel quick-add row state
  const [showInlineRow, setShowInlineRow] = useState(false);
  const [inlineName, setInlineName] = useState('');
  const [inlineMobile, setInlineMobile] = useState('');
  const [inlineCentre, setInlineCentre] = useState<CentreId>(
    currentUser.role === 'super_admin' ? 'vp_lookerganj' : currentUser.centreId,
  );
  const [inlineTma, setInlineTma] = useState<TmaStatus>('Pending');
  const [inlinePractical, setInlinePractical] = useState<PracticalStatus>('Pending');
  const [inlineAttendance, setInlineAttendance] = useState<ClassAttendanceStatus>('Regular');
  const [inlineSaving, setInlineSaving] = useState(false);

  const [viewingStudent, setViewingStudent] = useState<Student | null>(null);
  const [editingStudent, setEditingStudent] = useState<Student | null>(null);
  const [showFormModal, setShowFormModal] = useState(false);
  const [showBulkImport, setShowBulkImport] = useState(false);
  const [deletingStudent, setDeletingStudent] = useState<Student | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [showDeleteAllConfirm, setShowDeleteAllConfirm] = useState(false);
  const [deleteAllBusy, setDeleteAllBusy] = useState(false);
  const [deleteProgress, setDeleteProgress] = useState<{ done: number; total: number } | null>(null);
  const [govBusyId, setGovBusyId] = useState<string | null>(null);

  // Inline editing state for existing rows (role-scoped Excel cell/row editing)
  const [inlineEditId, setInlineEditId] = useState<string | null>(null);
  const [inlineEditDraft, setInlineEditDraft] = useState<{
    studentName: string;
    mobileNumber: string;
    centreId: CentreId;
    tmaStatus: TmaStatus;
    practicalStatus: PracticalStatus;
    classAttendanceStatus: ClassAttendanceStatus;
    extraColumns: Record<string, string>;
  } | null>(null);
  const [inlineEditSaving, setInlineEditSaving] = useState(false);

  // Per-department Permission Request & Centre Head Review State
  const [permissionStudent, setPermissionStudent] = useState<Student | null>(null);
  const [permissionReason, setPermissionReason] = useState('');
  const [permissionError, setPermissionError] = useState<string | null>(null);
  const [permissionBusy, setPermissionBusy] = useState(false);
  const [reviewNotes, setReviewNotes] = useState<Record<string, string>>({});
  const [reviewBusyId, setReviewBusyId] = useState<string | null>(null);

  const effectiveCentre =
    currentUser.role === 'super_admin'
      ? selectedCentreFilter !== 'all'
        ? selectedCentreFilter
        : centreFilter
      : currentUser.centreId;

  const combinedSearch = (localSearch || globalSearch).trim().toLowerCase();

  const displaySerialMap = useMemo(
    () => buildContextualSerialMap(students, effectiveCentre),
    [students, effectiveCentre],
  );

  const filtered = useMemo(() => {
    return students
      .filter((s) => (effectiveCentre === 'all' ? true : s.centreId === effectiveCentre))
      .filter((s) => (tmaFilter === 'all' ? true : s.tmaStatus === tmaFilter))
      .filter((s) => {
        if (!combinedSearch) return true;
        const contextualSno = String(displaySerialMap.get(s.studentId) ?? s.serialNumber);
        const extraMatch = s.extraColumns
          ? Object.values(s.extraColumns).some((val) => String(val).toLowerCase().includes(combinedSearch))
          : false;
        return (
          s.studentName.toLowerCase().includes(combinedSearch) ||
          s.mobileNumber.toLowerCase().includes(combinedSearch) ||
          s.subject.toLowerCase().includes(combinedSearch) ||
          s.centreName.toLowerCase().includes(combinedSearch) ||
          contextualSno.includes(combinedSearch) ||
          String(s.serialNumber).includes(combinedSearch) ||
          extraMatch
        );
      })
      .sort((a, b) => {
        if (sortKey === 'serialNumber') {
          const valA = displaySerialMap.get(a.studentId) ?? Number(a.serialNumber || 0);
          const valB = displaySerialMap.get(b.studentId) ?? Number(b.serialNumber || 0);
          return sortAsc ? valA - valB : valB - valA;
        }
        const valA = a[sortKey];
        const valB = b[sortKey];
        if (typeof valA === 'number' && typeof valB === 'number') {
          return sortAsc ? valA - valB : valB - valA;
        }
        return sortAsc
          ? String(valA).localeCompare(String(valB))
          : String(valB).localeCompare(String(valA));
      });
  }, [students, effectiveCentre, tmaFilter, combinedSearch, sortKey, sortAsc, displaySerialMap]);

  const extraColumnKeys = useMemo(() => {
    const keys: string[] = [];
    const seen = new Set<string>();
    for (const s of filtered) {
      if (!s.extraColumns) continue;
      for (const k of Object.keys(s.extraColumns)) {
        if (!seen.has(k)) {
          seen.add(k);
          keys.push(k);
        }
      }
      if (keys.length >= 25) break;
    }
    return keys;
  }, [filtered]);

  const effectivePageSize = rowsPerPage >= 10000 ? Math.max(1, filtered.length) : rowsPerPage;
  const totalPages = Math.max(1, Math.ceil(filtered.length / effectivePageSize));
  const safePage = Math.min(page, totalPages);
  const paginated = filtered.slice((safePage - 1) * effectivePageSize, safePage * effectivePageSize);

  const canCreate =
    currentUser.role === 'super_admin' ||
    currentUser.role === 'centre_head' ||
    (currentUser.role === 'employee' && currentUser.department === 'admission');
  const canBulkImport = currentUser.role === 'super_admin' || currentUser.role === 'centre_head';
  const canDelete = currentUser.role === 'super_admin';
  const isCentreHead = currentUser.role === 'centre_head';
  const isSuperAdmin = currentUser.role === 'super_admin';
  const isEmployee = currentUser.role === 'employee';
  const canEmployeeRequestPermission =
    isEmployee && EDITABLE_STUDENT_DEPTS.includes(currentUser.department);

  const pendingRequests = useMemo(() => {
    return editRequests.filter(
      (r) =>
        r.status === 'Pending' &&
        (effectiveCentre === 'all' ? true : r.centreId === effectiveCentre),
    );
  }, [editRequests, effectiveCentre]);

  const nextSerialPreview = useMemo(() => {
    return displaySerialMap.size + 1;
  }, [displaySerialMap]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortAsc((p) => !p);
    else {
      setSortKey(key);
      setSortAsc(true);
    }
  };

  const handleOpenInlineRow = () => {
    const defaultC =
      currentUser.role === 'super_admin'
        ? effectiveCentre === 'all'
          ? 'vp_lookerganj'
          : effectiveCentre
        : currentUser.centreId;
    setInlineCentre(defaultC);
    setInlineName('');
    setInlineMobile('');
    setInlineTma('Pending');
    setInlinePractical('Pending');
    setInlineAttendance('Regular');
    setShowInlineRow(true);
    setSelectedCell({ coord: 'B_NEW', value: 'Entering new student row directly in Excel grid...' });
  };

  const handleSaveInlineRow = async () => {
    if (inlineName.trim().length < 2) {
      onNotify('Invalid Name', 'Please enter full student name (at least 2 characters).', 'error');
      return;
    }
    if (inlineMobile.trim().length < 7) {
      onNotify('Invalid Mobile No', 'Please enter a valid mobile number.', 'error');
      return;
    }

    setInlineSaving(true);
    try {
      const targetCentre = currentUser.role === 'super_admin' ? inlineCentre : currentUser.centreId;
      const serialNumber = await getNextSerialNumber(students);
      const code = CENTRE_MAP[targetCentre].code;
      const internalId = `${code}-${new Date().getFullYear()}-${String(serialNumber).padStart(4, '0')}-${Math.random()
        .toString(36)
        .slice(2, 5)
        .toUpperCase()}`;

      const dupMsg = await checkDuplicateStudent(internalId, inlineMobile.trim(), targetCentre);
      if (dupMsg) {
        onNotify('Duplicate Entry Blocked', dupMsg, 'error');
        setInlineSaving(false);
        return;
      }

      const locCheck = await verifyOperationLocation(currentUser, `EXCEL_ADD_ROW:${internalId}`, targetCentre);
      if (!locCheck.allowed) {
        onNotify(
          'Location Verification Failed',
          locCheck.error || 'Physical presence at assigned centre is required.',
          'error',
        );
        setInlineSaving(false);
        return;
      }

      await createStudentRecord(
        {
          serialNumber,
          studentId: internalId,
          studentName: inlineName.trim(),
          mobileNumber: inlineMobile.trim(),
          subject: 'Hindi, English, Mathematics, Science, Social Science',
          tcStatus: 'Not Received',
          bookStatus: 'Pending',
          classAttendanceStatus: inlineAttendance,
          whyNios: '',
          currentEducationStatus: '',
          futurePlanning: '',
          tmaStatus: inlineTma,
          practicalStatus: inlinePractical,
          examinationStatus: 'Not Completed',
          centreId: targetCentre,
          centreName: CENTRE_MAP[targetCentre].name,
          admissionDate: new Date().toISOString().slice(0, 10),
          assignedEmployeeUid: currentUser.uid,
          assignedEmployeeName: currentUser.fullName,
          additionalRemarks:
            currentUser.role === 'employee'
              ? `Entered & locked once by ${currentUser.fullName}`
              : 'Entered via Excel Grid',
        },
        currentUser,
        true,
        { createDepartmentSkeletons: currentUser.role !== 'employee' },
      );

      onNotify(
        currentUser.role === 'employee' ? 'Row Saved & Locked' : 'Student Added to Excel',
        currentUser.role === 'employee'
          ? `${inlineName.trim()} saved at Serial #${serialNumber}. Locked for employees — only Centre Head or authorized Super Admin can edit.`
          : `${inlineName.trim()} added at Serial #${serialNumber}.`,
        'success',
      );
      setShowInlineRow(false);
      setInlineName('');
      setInlineMobile('');
    } catch (err) {
      onNotify('Excel Save Error', err instanceof Error ? err.message : 'Unable to save row.', 'error');
    } finally {
      setInlineSaving(false);
    }
  };

  const handleStartInlineEdit = (s: Student) => {
    if (!canUserEditStudentRow(s, currentUser)) return;
    setInlineEditId(s.studentId);
    setInlineEditDraft({
      studentName: s.studentName,
      mobileNumber: s.mobileNumber,
      centreId: s.centreId,
      tmaStatus: s.tmaStatus,
      practicalStatus: s.practicalStatus,
      classAttendanceStatus: s.classAttendanceStatus,
      extraColumns: { ...(s.extraColumns || {}) },
    });
  };

  const handleSaveInlineEdit = async (student: Student) => {
    if (!inlineEditDraft) return;
    const cleanName = inlineEditDraft.studentName.trim();
    const cleanMobile = inlineEditDraft.mobileNumber.trim();
    if ((isSuperAdmin || isCentreHead || currentUser.department === 'admission') && cleanName.length < 2) {
      onNotify('Invalid Name', 'Student name must be at least 2 characters.', 'error');
      return;
    }
    if ((isSuperAdmin || isCentreHead || currentUser.department === 'admission') && cleanMobile.length < 7) {
      onNotify('Invalid Mobile No', 'Please enter a valid mobile number (min 7 digits).', 'error');
      return;
    }

    setInlineEditSaving(true);
    try {
      const targetCentre = isSuperAdmin ? inlineEditDraft.centreId : student.centreId;
      const loc = await verifyOperationLocation(currentUser, `EXCEL_INLINE_EDIT:${student.studentId}`, targetCentre);
      if (!loc.allowed) {
        onNotify('Location Verification Failed', loc.error || 'Physical presence required at centre.', 'error');
        setInlineEditSaving(false);
        return;
      }

      const updates: Partial<Student> = {};
      if (isSuperAdmin || isCentreHead) {
        updates.studentName = cleanName;
        updates.mobileNumber = cleanMobile;
        updates.tmaStatus = inlineEditDraft.tmaStatus;
        updates.practicalStatus = inlineEditDraft.practicalStatus;
        updates.classAttendanceStatus = inlineEditDraft.classAttendanceStatus;
        const cleanExtras: Record<string, string> = {};
        Object.entries(inlineEditDraft.extraColumns).forEach(([k, v]) => {
          const val = String(v ?? '').trim().slice(0, 300);
          if (val) cleanExtras[k.slice(0, 50)] = val;
        });
        if (Object.keys(cleanExtras).length > 0 || student.extraColumns) {
          updates.extraColumns = cleanExtras;
        }
        if (isSuperAdmin && inlineEditDraft.centreId !== student.centreId) {
          updates.centreId = inlineEditDraft.centreId;
          updates.centreName = CENTRE_MAP[inlineEditDraft.centreId].name;
        }
      } else if (isEmployee) {
        if (currentUser.department === 'tma') {
          updates.tmaStatus = inlineEditDraft.tmaStatus;
        } else if (currentUser.department === 'practical') {
          updates.practicalStatus = inlineEditDraft.practicalStatus;
        } else if (currentUser.department === 'online_classes') {
          updates.classAttendanceStatus = inlineEditDraft.classAttendanceStatus;
        } else if (currentUser.department === 'admission') {
          updates.studentName = cleanName;
          updates.mobileNumber = cleanMobile;
        }
      }

      await updateStudentRecord(student.studentId, updates, currentUser, targetCentre, true);
      onNotify(
        isEmployee ? 'Department Saved & Locked' : 'Excel Row Updated',
        isEmployee
          ? `${DEPARTMENT_LABELS[currentUser.department] || currentUser.department} updated for ${student.studentName}.`
          : `Updated ${cleanName} in live Excel sheet.`,
        'success',
      );
      setInlineEditId(null);
      setInlineEditDraft(null);
    } catch (err) {
      onNotify('Update Failed', err instanceof Error ? err.message : 'Unable to save inline changes.', 'error');
    } finally {
      setInlineEditSaving(false);
    }
  };

  const handleToggleEmployeeLock = async (student: Student) => {
    const nextLocked = !student.employeeLocked;
    setGovBusyId(student.studentId);
    try {
      await toggleStudentEmployeeLock(student, nextLocked, currentUser);
      onNotify(
        nextLocked ? 'Row Locked for Employees' : 'Row Unlocked by Centre Head',
        `${student.studentName} is now ${nextLocked ? 'locked from employee edits' : 'editable once by branch employee'}.`,
        'info',
      );
    } catch (err) {
      onNotify('Lock Update Failed', err instanceof Error ? err.message : 'Failed to update row lock.', 'error');
    } finally {
      setGovBusyId(null);
    }
  };

  const handleExportCsv = () => {
    exportToCsv(
      `vision-point-students-${effectiveCentre}.csv`,
      [
        'S.No',
        'Student Name',
        'Mobile No',
        'Centre',
        'TMA',
        'Practical',
        'Attendance (Live Classes)',
        'Subjects',
        'Admission Date',
        ...extraColumnKeys,
      ],
      filtered.map((s) => [
        displaySerialMap.get(s.studentId) ?? s.serialNumber,
        s.studentName,
        s.mobileNumber,
        s.centreName,
        s.tmaStatus,
        s.practicalStatus,
        s.classAttendanceStatus,
        s.subject,
        s.admissionDate,
        ...extraColumnKeys.map((k) => s.extraColumns?.[k] || ''),
      ]),
    );
    onNotify('Export Complete', `Exported ${filtered.length} student rows to CSV.`, 'success');
  };

  const handleExportExcel = () => {
    exportToExcel(
      `vision-point-students-${effectiveCentre}.xlsx`,
      'Student Database',
      [
        'S.No',
        'Student Name',
        'Mobile No',
        'Centre',
        'TMA',
        'Practical',
        'Attendance (Live Classes)',
        'Subjects',
        'Admission Date',
        ...extraColumnKeys,
      ],
      filtered.map((s) => [
        displaySerialMap.get(s.studentId) ?? s.serialNumber,
        s.studentName,
        s.mobileNumber,
        s.centreName,
        s.tmaStatus,
        s.practicalStatus,
        s.classAttendanceStatus,
        s.subject,
        s.admissionDate,
        ...extraColumnKeys.map((k) => s.extraColumns?.[k] || ''),
      ]),
    );
    onNotify('Excel Export Ready', `Exported ${filtered.length} student rows to .xlsx.`, 'success');
  };

  const handleConfirmDelete = async () => {
    if (!deletingStudent) return;
    setDeleteBusy(true);
    try {
      await deleteStudentRecord(
        deletingStudent.studentId,
        deletingStudent.studentName,
        deletingStudent.centreId,
        currentUser,
      );
      onNotify('Student Deleted', `Removed ${deletingStudent.studentName} (Serial #${deletingStudent.serialNumber}).`, 'info');
      setDeletingStudent(null);
    } catch (err) {
      onNotify('Delete Failed', err instanceof Error ? err.message : 'Unable to delete record.', 'error');
    } finally {
      setDeleteBusy(false);
    }
  };

  const handleConfirmDeleteAll = async () => {
    if (!canDelete || filtered.length === 0) return;
    setDeleteAllBusy(true);
    setDeleteProgress({ done: 0, total: filtered.length });
    try {
      const targetIds = new Set(filtered.map((s) => s.studentId));
      const matchingReqIds = editRequests
        .filter((r) => targetIds.has(r.studentId))
        .map((r) => r.requestId);

      const res = await deleteStudentsBatch(filtered, currentUser, {
        editRequestIds: matchingReqIds,
        onProgress: (done, total) => setDeleteProgress({ done, total }),
      });

      setShowDeleteAllConfirm(false);
      setInlineEditId(null);
      setInlineEditDraft(null);
      setPage(1);

      if (res.failedIds.length > 0) {
        onNotify(
          'Bulk Delete Partially Complete',
          `Deleted ${res.deletedCount} students (${res.failedIds.length} could not be deleted).`,
          'warning',
        );
      } else {
        onNotify(
          'All Student Data Deleted',
          `Successfully deleted ${res.deletedCount} student records and linked department records. Ab aap fresh Excel re-upload kar sakte hain.`,
          'success',
        );
      }
    } catch (err) {
      onNotify('Bulk Delete Failed', err instanceof Error ? err.message : 'Unable to clear student records.', 'error');
    } finally {
      setDeleteAllBusy(false);
      setDeleteProgress(null);
    }
  };

  const handleTransferCentre = async (student: Student, targetCentreId: CentreId) => {
    try {
      await updateStudentRecord(
        student.studentId,
        {
          centreId: targetCentreId,
          centreName: CENTRE_MAP[targetCentreId].name,
        },
        currentUser,
        targetCentreId,
        true,
      );
      onNotify('Student Transferred', `${student.studentName} moved to ${CENTRE_MAP[targetCentreId].name}.`, 'success');
    } catch (err) {
      onNotify('Transfer Failed', err instanceof Error ? err.message : 'Failed to transfer centre.', 'error');
    }
  };

  const handleSubmitPermissionRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!permissionStudent || !canEmployeeRequestPermission) return;
    const clean = permissionReason.trim();
    if (clean.length < 3) {
      setPermissionError('Please explain the mistake or reason (at least 3 characters).');
      return;
    }
    setPermissionBusy(true);
    setPermissionError(null);
    try {
      await createEditRequest(
        {
          student: permissionStudent,
          department: currentUser.department as DepartmentId,
          reason: clean,
        },
        currentUser,
      );
      onNotify(
        'Permission Request Sent',
        `Requested Centre Head approval to edit ${DEPARTMENT_LABELS[currentUser.department] || currentUser.department} for ${permissionStudent.studentName}.`,
        'success',
      );
      setPermissionStudent(null);
      setPermissionReason('');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unable to send permission request.';
      setPermissionError(msg);
      onNotify('Request Failed', msg, 'error');
    } finally {
      setPermissionBusy(false);
    }
  };

  const handleReviewRequest = async (req: EditRequest, decision: 'Approved' | 'Rejected') => {
    setReviewBusyId(req.requestId);
    try {
      await reviewEditRequest(req, decision, reviewNotes[req.requestId] || '', currentUser);
      onNotify(
        decision === 'Approved' ? 'Permission Approved' : 'Permission Rejected',
        decision === 'Approved'
          ? `Unlocked ${DEPARTMENT_LABELS[req.department] || req.department} for 1 correction edit on ${req.studentName}.`
          : `Rejected ${req.requesterName}'s edit request for ${req.studentName}.`,
        decision === 'Approved' ? 'success' : 'info',
      );
    } catch (err) {
      onNotify('Review Failed', err instanceof Error ? err.message : 'Unable to process request.', 'error');
    } finally {
      setReviewBusyId(null);
    }
  };

  return (
    <div className="space-y-4">
      {/* Obsidian-Crimson Translucent Glass Excel Ribbon & Action Header */}
      <div className="glass-dark-panel text-white rounded-2xl p-5">
        <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-2.5 text-[11px] font-mono uppercase tracking-wider text-rose-200">
              <FileSpreadsheet className="w-4 h-4 text-[#FBBF24]" />
              <span>VISION_POINT_STUDENTS.xlsx</span>
              <span className="text-rose-300/40">·</span>
              <span className="text-[#FBBF24] font-bold">{filtered.length} Records</span>
            </div>
            <h2 className="text-xl font-extrabold text-white mt-1">Student Database Excel Sheet</h2>
            <p className="text-xs text-slate-200/85 mt-0.5">
              Serial-ordered Excel ledger ·{' '}
              {currentUser.role === 'employee'
                ? `View all branch students · Edit ONLY ${DEPARTMENT_LABELS[currentUser.department] || currentUser.department} once (Ask Centre Head permission to correct mistakes).`
                : currentUser.role === 'centre_head'
                  ? `Centre Head Authority (${CENTRE_MAP[currentUser.centreId]?.name}): Import & edit your centre's students, and approve staff correction requests.`
                  : 'Super Admin Master Control: Full import & edit access across all 4 centres (Double-click any row cell to edit inline).'}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleExportCsv}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-white bg-white/10 hover:bg-white/20 border border-white/20 rounded-xl backdrop-blur-md whitespace-nowrap"
            >
              <Download className="w-3.5 h-3.5 text-[#FBBF24]" />
              CSV
            </button>
            <button
              type="button"
              onClick={handleExportExcel}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-white bg-white/10 hover:bg-white/20 border border-white/20 rounded-xl backdrop-blur-md whitespace-nowrap"
            >
              <FileSpreadsheet className="w-3.5 h-3.5 text-emerald-300" />
              Excel (.xlsx)
            </button>
            {canBulkImport && (
              <button
                type="button"
                onClick={() => setShowBulkImport(true)}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-white bg-white/10 hover:bg-white/20 border border-white/20 rounded-xl backdrop-blur-md whitespace-nowrap"
              >
                <Upload className="w-3.5 h-3.5 text-[#FBBF24]" />
                Import Excel / CSV
              </button>
            )}
            {canCreate && (
              <>
                <button
                  type="button"
                  onClick={handleOpenInlineRow}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-bold text-white btn-crimson-gloss rounded-xl whitespace-nowrap"
                >
                  <Plus className="w-3.5 h-3.5" />
                  Fill Row in Excel
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setEditingStudent(null);
                    setShowFormModal(true);
                  }}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-white/15 hover:bg-white/25 border border-white/25 rounded-xl whitespace-nowrap"
                >
                  Detailed Form
                </button>
              </>
            )}
            {canDelete && filtered.length > 0 && (
              <button
                type="button"
                onClick={() => setShowDeleteAllConfirm(true)}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-bold text-rose-100 bg-red-600/35 hover:bg-red-600/60 border border-red-400/50 rounded-xl whitespace-nowrap"
                title="Delete all currently shown student records so you can re-upload fresh Excel"
              >
                <Trash2 className="w-3.5 h-3.5 text-rose-200" />
                {filtered.length === students.length
                  ? `Delete All (${filtered.length})`
                  : `Delete Filtered (${filtered.length})`}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Pending Employee Edit Permission Requests (Centre Head / Super Admin) */}
      {(isCentreHead || currentUser.role === 'super_admin') && pendingRequests.length > 0 && (
        <div className="glass-light-card rounded-xl border border-amber-300 bg-amber-50/90 p-4 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Clock className="w-4 h-4 text-amber-800" />
              <h3 className="text-sm font-bold text-[#08152E]">
                Centre Head Edit Permission Requests ({pendingRequests.length})
              </h3>
            </div>
            <span className="text-[11px] font-mono text-amber-900">
              Approving unlocks only the requested department for 1 correction edit
            </span>
          </div>
          <div className="space-y-2.5">
            {pendingRequests.map((req) => {
              const busy = reviewBusyId === req.requestId;
              return (
                <div
                  key={req.requestId}
                  className="bg-white rounded-lg border border-amber-200 p-3 flex flex-col lg:flex-row lg:items-center justify-between gap-3"
                >
                  <div className="space-y-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span className="font-bold text-[#08152E]">{req.studentName}</span>
                      <span className="font-mono text-slate-600">#{req.serialNumber}</span>
                      <span className="px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide bg-sky-100 text-[#0B2454] rounded">
                        {DEPARTMENT_LABELS[req.department] || req.department}
                      </span>
                      <span className="text-slate-600">
                        by <strong className="text-[#08152E]">{req.requesterName}</strong> ({req.requesterEmail})
                      </span>
                    </div>
                    <p className="text-xs text-slate-700">
                      <span className="font-semibold text-[#08152E]">Reason:</span> &ldquo;{req.reason}&rdquo;
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 shrink-0">
                    <input
                      type="text"
                      value={reviewNotes[req.requestId] || ''}
                      onChange={(e) =>
                        setReviewNotes((prev) => ({ ...prev, [req.requestId]: e.target.value }))
                      }
                      placeholder="Optional note..."
                      className="px-2.5 py-1.5 text-xs bg-white text-[#08152E] border border-slate-300 rounded-lg w-44 focus:outline-none focus:ring-2 focus:ring-[#0F2F6B]"
                    />
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => handleReviewRequest(req, 'Approved')}
                      className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-bold text-white bg-emerald-700 hover:bg-emerald-800 rounded-lg disabled:opacity-50"
                    >
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      {busy ? 'Working...' : 'Approve (1 Edit)'}
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => handleReviewRequest(req, 'Rejected')}
                      className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-bold text-red-800 bg-red-50 hover:bg-red-100 border border-red-200 rounded-lg disabled:opacity-50"
                    >
                      <XCircle className="w-3.5 h-3.5" />
                      Reject
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Filter & Search Bar */}
      <div className="glass-light-card rounded-xl p-4 flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[240px]">
          <Search className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            value={localSearch}
            onChange={(e) => {
              setLocalSearch(e.target.value);
              setPage(1);
            }}
            placeholder="Search by Serial No, Student Name, Mobile No, Centre, or Subject..."
            className="w-full pl-9 pr-3.5 py-2 text-sm bg-white text-[#08152E] placeholder:text-slate-400 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#0F2F6B]"
          />
        </div>

        {currentUser.role === 'super_admin' && selectedCentreFilter === 'all' && (
          <select
            value={centreFilter}
            onChange={(e) => {
              setCentreFilter(e.target.value as CentreId | 'all');
              setPage(1);
            }}
            className="px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white text-[#08152E] font-medium focus:outline-none focus:ring-2 focus:ring-[#0F2F6B]"
          >
            <option value="all">All 4 Centres</option>
            {CANONICAL_CENTRES.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        )}

        <select
          value={tmaFilter}
          onChange={(e) => {
            setTmaFilter(e.target.value);
            setPage(1);
          }}
          className="px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white text-[#08152E] font-medium focus:outline-none focus:ring-2 focus:ring-[#0F2F6B]"
        >
          <option value="all">All TMA Statuses</option>
          <option value="Submitted">TMA Submitted</option>
          <option value="Pending">TMA Pending</option>
          <option value="Not Submitted">TMA Not Submitted</option>
        </select>

        <select
          value={rowsPerPage}
          onChange={(e) => {
            setRowsPerPage(Number(e.target.value));
            setPage(1);
          }}
          className="px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white text-[#08152E] font-medium focus:outline-none focus:ring-2 focus:ring-[#0F2F6B]"
          title="Rows shown in Excel grid"
        >
          <option value={25}>Show 25 Rows</option>
          <option value={50}>Show 50 Rows</option>
          <option value={100}>Show 100 Rows</option>
          <option value={999999}>Show All ({filtered.length})</option>
        </select>

        {extraColumnKeys.length > 0 && (
          <button
            type="button"
            onClick={() => setShowExtraColumns((v) => !v)}
            className={`inline-flex items-center gap-1.5 px-3 py-2 text-xs font-bold rounded-lg border whitespace-nowrap ${
              showExtraColumns
                ? 'bg-[#0F2F6B] text-white border-[#0F2F6B]'
                : 'bg-white text-[#08152E] border-slate-300 hover:bg-slate-100'
            }`}
          >
            <FileSpreadsheet className="w-3.5 h-3.5" />
            {showExtraColumns
              ? `All Excel Columns (${extraColumnKeys.length})`
              : `Show +${extraColumnKeys.length} Excel Columns`}
          </button>
        )}
      </div>

      {/* Authentic Excel Formula Bar + Spreadsheet Grid */}
      <div className="glass-light-card rounded-xl overflow-hidden border border-slate-300">
        {/* Excel Formula / Selection Bar */}
        <div className="flex items-center border-b border-slate-300 bg-slate-50 text-xs">
          <div className="w-20 px-3 py-2 font-mono font-bold text-[#B91C1C] border-r border-slate-300 text-center bg-white">
            {selectedCell.coord}
          </div>
          <div className="px-3 py-2 font-mono font-bold text-slate-500 border-r border-slate-300 select-none">
            fx
          </div>
          <div className="flex-1 px-3 py-2 font-mono text-[#0F172A] truncate bg-white">
            {selectedCell.value}
          </div>
        </div>

        {loading ? (
          <div className="p-8 space-y-3 bg-white">
            {[1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="h-9 bg-slate-100 rounded" />
            ))}
          </div>
        ) : paginated.length === 0 && !showInlineRow ? (
          <div className="p-12 text-center bg-white">
            <Users className="w-10 h-10 text-slate-400 mx-auto" />
            <h3 className="text-sm font-bold text-[#08152E] mt-3">No Student Rows in Sheet</h3>
            <p className="text-xs text-slate-600 mt-1 max-w-sm mx-auto">
              {combinedSearch
                ? 'No rows matched your current search criteria.'
                : 'Click "Fill Row in Excel" above to enter your first student record directly in the spreadsheet.'}
            </p>
            {canCreate && !combinedSearch && (
              <button
                type="button"
                onClick={handleOpenInlineRow}
                className="mt-4 inline-flex items-center gap-1.5 px-4 py-2 text-xs font-bold text-[#08152E] bg-[#F59E0B] rounded-lg hover:bg-amber-400"
              >
                <Plus className="w-3.5 h-3.5" />
                Fill First Student Row
              </button>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto bg-white">
            <table className="excel-sheet-table">
              <thead>
                {/* Column Letters Row */}
                <tr className="excel-col-letters">
                  <th className="w-16">A</th>
                  <th className="min-w-[190px]">B</th>
                  <th className="min-w-[125px]">C</th>
                  <th className="min-w-[180px]">D</th>
                  <th className="min-w-[120px]">E</th>
                  <th className="min-w-[120px]">F</th>
                  <th className="min-w-[165px]">G</th>
                  {showExtraColumns &&
                    extraColumnKeys.map((k, extraIdx) => (
                      <th key={k} className="min-w-[140px]">
                        {toExcelColName(7 + extraIdx)}
                      </th>
                    ))}
                  <th className="min-w-[175px]">
                    {toExcelColName(7 + (showExtraColumns ? extraColumnKeys.length : 0))}
                  </th>
                  <th className="min-w-[140px]">
                    {toExcelColName(8 + (showExtraColumns ? extraColumnKeys.length : 0))}
                  </th>
                </tr>

                {/* Excel Header Columns */}
                <tr className="excel-col-header text-left">
                  <th>
                    <button
                      type="button"
                      onClick={() => toggleSort('serialNumber')}
                      className="inline-flex items-center gap-1 hover:text-[#F59E0B]"
                    >
                      S.No <ArrowUpDown className="w-3 h-3" />
                    </button>
                  </th>
                  <th>
                    <button
                      type="button"
                      onClick={() => toggleSort('studentName')}
                      className="inline-flex items-center gap-1 hover:text-[#F59E0B]"
                    >
                      Student Name <ArrowUpDown className="w-3 h-3" />
                    </button>
                  </th>
                  <th>Mobile No</th>
                  <th>Centre</th>
                  <th>
                    <button
                      type="button"
                      onClick={() => toggleSort('tmaStatus')}
                      className="inline-flex items-center gap-1 hover:text-[#F59E0B]"
                    >
                      TMA <ArrowUpDown className="w-3 h-3" />
                    </button>
                  </th>
                  <th>
                    <button
                      type="button"
                      onClick={() => toggleSort('practicalStatus')}
                      className="inline-flex items-center gap-1 hover:text-[#F59E0B]"
                    >
                      Practical <ArrowUpDown className="w-3 h-3" />
                    </button>
                  </th>
                  <th>
                    <button
                      type="button"
                      onClick={() => toggleSort('classAttendanceStatus')}
                      className="inline-flex items-center gap-1 hover:text-[#F59E0B]"
                    >
                      Attendance Live Classes <ArrowUpDown className="w-3 h-3" />
                    </button>
                  </th>
                  {showExtraColumns &&
                    extraColumnKeys.map((k) => (
                      <th key={k} className="whitespace-nowrap">
                        {k}
                      </th>
                    ))}
                  <th>Lock &amp; Access</th>
                  <th className="text-center">Actions</th>
                </tr>
              </thead>

              <tbody>
                {/* Inline Quick-Add Excel Row */}
                {showInlineRow && (
                  <tr className="bg-amber-50/90">
                    <td className="px-2.5 py-2 text-center font-mono font-bold text-[#0B2454]">
                      {nextSerialPreview}
                    </td>
                    <td className="p-1.5">
                      <input
                        type="text"
                        value={inlineName}
                        onChange={(e) => setInlineName(e.target.value)}
                        placeholder="Enter Student Name*"
                        className="w-full px-2 py-1.5 text-xs bg-white border border-[#0F2F6B] rounded text-[#08152E] focus:outline-none"
                      />
                    </td>
                    <td className="p-1.5">
                      <input
                        type="tel"
                        value={inlineMobile}
                        onChange={(e) => setInlineMobile(e.target.value)}
                        placeholder="Mobile No*"
                        className="w-full px-2 py-1.5 text-xs font-mono bg-white border border-slate-300 rounded text-[#08152E] focus:outline-none focus:border-[#0F2F6B]"
                      />
                    </td>
                    <td className="p-1.5">
                      {currentUser.role === 'super_admin' ? (
                        <select
                          value={inlineCentre}
                          onChange={(e) => setInlineCentre(e.target.value as CentreId)}
                          className="w-full px-2 py-1.5 text-xs bg-white border border-slate-300 rounded text-[#08152E]"
                        >
                          {CANONICAL_CENTRES.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span className="px-2 py-1 text-xs font-semibold text-[#08152E] block truncate">
                          {CENTRE_MAP[currentUser.centreId]?.name}
                        </span>
                      )}
                    </td>
                    <td className="p-1.5">
                      <select
                        disabled={currentUser.role === 'employee'}
                        value={inlineTma}
                        onChange={(e) => setInlineTma(e.target.value as TmaStatus)}
                        className="w-full px-2 py-1.5 text-xs bg-white border border-slate-300 rounded text-[#08152E] disabled:bg-slate-100 disabled:text-slate-500"
                      >
                        <option value="Submitted">Submitted</option>
                        <option value="Pending">Pending</option>
                        <option value="Not Submitted">Not Submitted</option>
                      </select>
                    </td>
                    <td className="p-1.5">
                      <select
                        disabled={currentUser.role === 'employee'}
                        value={inlinePractical}
                        onChange={(e) => setInlinePractical(e.target.value as PracticalStatus)}
                        className="w-full px-2 py-1.5 text-xs bg-white border border-slate-300 rounded text-[#08152E] disabled:bg-slate-100 disabled:text-slate-500"
                      >
                        <option value="Completed">Completed</option>
                        <option value="Pending">Pending</option>
                        <option value="Not Completed">Not Completed</option>
                      </select>
                    </td>
                    <td className="p-1.5">
                      <select
                        disabled={currentUser.role === 'employee'}
                        value={inlineAttendance}
                        onChange={(e) => setInlineAttendance(e.target.value as ClassAttendanceStatus)}
                        className="w-full px-2 py-1.5 text-xs bg-white border border-slate-300 rounded text-[#08152E] disabled:bg-slate-100 disabled:text-slate-500"
                      >
                        <option value="Regular">Regular</option>
                        <option value="Irregular">Irregular</option>
                        <option value="Not Attending">Not Attending</option>
                      </select>
                    </td>
                    {showExtraColumns &&
                      extraColumnKeys.map((k) => (
                        <td key={k} className="px-2 py-2 text-[11px] text-slate-400 text-center">
                          —
                        </td>
                      ))}
                    <td className="px-2.5 py-2 text-[11px] font-semibold text-amber-800">
                      {currentUser.role === 'employee' ? 'Locks Admission on Save' : 'New Row'}
                    </td>
                    <td className="p-1.5 text-center">
                      <div className="inline-flex items-center gap-1">
                        <button
                          type="button"
                          disabled={inlineSaving}
                          onClick={handleSaveInlineRow}
                          className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-bold btn-crimson-gloss text-white rounded disabled:opacity-50"
                        >
                          <Check className="w-3.5 h-3.5" />
                          {inlineSaving ? 'Saving...' : 'Save'}
                        </button>
                        <button
                          type="button"
                          disabled={inlineSaving}
                          onClick={() => setShowInlineRow(false)}
                          className="p-1.5 text-slate-600 hover:text-[#08152E] rounded hover:bg-slate-200"
                          title="Cancel row"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                )}

                {paginated.map((s, idx) => {
                  const rowNum = (safePage - 1) * effectivePageSize + idx + 1;
                  const displaySerial = displaySerialMap.get(s.studentId) ?? s.serialNumber;
                  const canEditRow = canUserEditStudentRow(s, currentUser);
                  const isEditingThisRow = inlineEditId === s.studentId && inlineEditDraft !== null;
                  const canEditIdentityInline =
                    isSuperAdmin || isCentreHead || (isEmployee && currentUser.department === 'admission');
                  const canEditCentreInline = isSuperAdmin;
                  const canEditTmaInline =
                    isSuperAdmin || isCentreHead || (isEmployee && currentUser.department === 'tma');
                  const canEditPracticalInline =
                    isSuperAdmin || isCentreHead || (isEmployee && currentUser.department === 'practical');
                  const canEditAttendanceInline =
                    isSuperAdmin || isCentreHead || (isEmployee && currentUser.department === 'online_classes');

                  return (
                    <tr
                      key={s.studentId}
                      className={`excel-row transition-colors ${isEditingThisRow ? 'bg-amber-50/75' : ''}`}
                    >
                      {/* A: S.No */}
                      <td
                        onClick={() => setSelectedCell({ coord: `A${rowNum}`, value: String(displaySerial) })}
                        className="px-2.5 py-2 text-center font-mono font-bold text-[#0B2454] bg-[#F8FAFC] tabular-nums cursor-cell"
                      >
                        {displaySerial}
                      </td>

                      {/* B: Student Name */}
                      <td
                        onClick={() => setSelectedCell({ coord: `B${rowNum}`, value: `${s.studentName} (${s.subject})` })}
                        onDoubleClick={() => canEditRow && canEditIdentityInline && handleStartInlineEdit(s)}
                        className="px-3 py-2 font-semibold text-[#08152E] cursor-cell"
                        title={canEditRow && canEditIdentityInline ? 'Double-click to edit inline' : undefined}
                      >
                        {isEditingThisRow && canEditIdentityInline ? (
                          <input
                            type="text"
                            value={inlineEditDraft.studentName}
                            onChange={(e) =>
                              setInlineEditDraft((prev) => (prev ? { ...prev, studentName: e.target.value } : prev))
                            }
                            className="w-full px-2 py-1 text-xs bg-white border border-[#0F2F6B] rounded text-[#08152E] focus:outline-none"
                          />
                        ) : (
                          s.studentName
                        )}
                      </td>

                      {/* C: Mobile No */}
                      <td
                        onClick={() => setSelectedCell({ coord: `C${rowNum}`, value: s.mobileNumber })}
                        onDoubleClick={() => canEditRow && canEditIdentityInline && handleStartInlineEdit(s)}
                        className="px-3 py-2 font-mono text-[#08152E] tabular-nums cursor-cell"
                        title={canEditRow && canEditIdentityInline ? 'Double-click to edit inline' : undefined}
                      >
                        {isEditingThisRow && canEditIdentityInline ? (
                          <input
                            type="tel"
                            value={inlineEditDraft.mobileNumber}
                            onChange={(e) =>
                              setInlineEditDraft((prev) => (prev ? { ...prev, mobileNumber: e.target.value } : prev))
                            }
                            className="w-full px-2 py-1 text-xs font-mono bg-white border border-[#0F2F6B] rounded text-[#08152E] focus:outline-none"
                          />
                        ) : (
                          s.mobileNumber
                        )}
                      </td>

                      {/* D: Centre */}
                      <td
                        onClick={() => setSelectedCell({ coord: `D${rowNum}`, value: s.centreName })}
                        onDoubleClick={() => canEditRow && canEditCentreInline && handleStartInlineEdit(s)}
                        className="px-3 py-2 text-[#08152E] font-medium cursor-cell"
                      >
                        {isEditingThisRow && canEditCentreInline ? (
                          <select
                            value={inlineEditDraft.centreId}
                            onChange={(e) =>
                              setInlineEditDraft((prev) =>
                                prev ? { ...prev, centreId: e.target.value as CentreId } : prev,
                              )
                            }
                            className="w-full px-2 py-1 text-xs bg-white border border-[#0F2F6B] rounded text-[#08152E]"
                          >
                            {CANONICAL_CENTRES.map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.name}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <>
                            <span className="font-mono font-bold text-[#0B2454] mr-1.5">
                              {CENTRE_MAP[s.centreId]?.code}
                            </span>
                            <span className="text-slate-700">{s.centreName}</span>
                          </>
                        )}
                      </td>

                      {/* E: TMA */}
                      <td
                        onClick={() => setSelectedCell({ coord: `E${rowNum}`, value: s.tmaStatus })}
                        onDoubleClick={() => canEditRow && canEditTmaInline && handleStartInlineEdit(s)}
                        className={`px-3 py-2 font-bold cursor-cell ${
                          s.tmaStatus === 'Submitted'
                            ? 'bg-emerald-50/70 text-emerald-800'
                            : s.tmaStatus === 'Pending'
                              ? 'bg-amber-50/70 text-amber-800'
                              : 'bg-red-50/70 text-red-800'
                        }`}
                        title={canEditRow && canEditTmaInline ? 'Double-click to edit TMA' : undefined}
                      >
                        {isEditingThisRow && canEditTmaInline ? (
                          <select
                            value={inlineEditDraft.tmaStatus}
                            onChange={(e) =>
                              setInlineEditDraft((prev) =>
                                prev ? { ...prev, tmaStatus: e.target.value as TmaStatus } : prev,
                              )
                            }
                            className="w-full px-2 py-1 text-xs bg-white border border-[#0F2F6B] rounded text-[#08152E]"
                          >
                            <option value="Submitted">Submitted</option>
                            <option value="Pending">Pending</option>
                            <option value="Not Submitted">Not Submitted</option>
                          </select>
                        ) : (
                          s.tmaStatus
                        )}
                      </td>

                      {/* F: Practical */}
                      <td
                        onClick={() => setSelectedCell({ coord: `F${rowNum}`, value: s.practicalStatus })}
                        onDoubleClick={() => canEditRow && canEditPracticalInline && handleStartInlineEdit(s)}
                        className={`px-3 py-2 font-bold cursor-cell ${
                          s.practicalStatus === 'Completed'
                            ? 'bg-emerald-50/70 text-emerald-800'
                            : s.practicalStatus === 'Pending'
                              ? 'bg-amber-50/70 text-amber-800'
                              : 'bg-red-50/70 text-red-800'
                        }`}
                        title={canEditRow && canEditPracticalInline ? 'Double-click to edit Practical' : undefined}
                      >
                        {isEditingThisRow && canEditPracticalInline ? (
                          <select
                            value={inlineEditDraft.practicalStatus}
                            onChange={(e) =>
                              setInlineEditDraft((prev) =>
                                prev ? { ...prev, practicalStatus: e.target.value as PracticalStatus } : prev,
                              )
                            }
                            className="w-full px-2 py-1 text-xs bg-white border border-[#0F2F6B] rounded text-[#08152E]"
                          >
                            <option value="Completed">Completed</option>
                            <option value="Pending">Pending</option>
                            <option value="Not Completed">Not Completed</option>
                          </select>
                        ) : (
                          s.practicalStatus
                        )}
                      </td>

                      {/* G: Attendance Live Classes */}
                      <td
                        onClick={() => setSelectedCell({ coord: `G${rowNum}`, value: s.classAttendanceStatus })}
                        onDoubleClick={() => canEditRow && canEditAttendanceInline && handleStartInlineEdit(s)}
                        className={`px-3 py-2 font-semibold cursor-cell ${
                          s.classAttendanceStatus === 'Regular'
                            ? 'text-emerald-800'
                            : s.classAttendanceStatus === 'Irregular'
                              ? 'text-amber-800'
                              : 'text-red-800'
                        }`}
                        title={canEditRow && canEditAttendanceInline ? 'Double-click to edit Attendance' : undefined}
                      >
                        {isEditingThisRow && canEditAttendanceInline ? (
                          <select
                            value={inlineEditDraft.classAttendanceStatus}
                            onChange={(e) =>
                              setInlineEditDraft((prev) =>
                                prev
                                  ? { ...prev, classAttendanceStatus: e.target.value as ClassAttendanceStatus }
                                  : prev,
                              )
                            }
                            className="w-full px-2 py-1 text-xs bg-white border border-[#0F2F6B] rounded text-[#08152E]"
                          >
                            <option value="Regular">Regular</option>
                            <option value="Irregular">Irregular</option>
                            <option value="Not Attending">Not Attending</option>
                          </select>
                        ) : (
                          s.classAttendanceStatus
                        )}
                      </td>

                      {/* Dynamic Imported Extra Excel Columns */}
                      {showExtraColumns &&
                        extraColumnKeys.map((colKey) => {
                          const cellVal = s.extraColumns?.[colKey] || '';
                          const canEditExtra = isSuperAdmin || isCentreHead;
                          return (
                            <td
                              key={colKey}
                              onClick={() =>
                                setSelectedCell({ coord: `${colKey}#${rowNum}`, value: cellVal || '—' })
                              }
                              onDoubleClick={() => canEditRow && canEditExtra && handleStartInlineEdit(s)}
                              className="px-3 py-2 text-slate-800 cursor-cell whitespace-nowrap max-w-[220px] truncate"
                              title={cellVal || (canEditExtra ? 'Double-click to edit inline' : undefined)}
                            >
                              {isEditingThisRow && canEditExtra ? (
                                <input
                                  type="text"
                                  value={inlineEditDraft.extraColumns[colKey] ?? cellVal}
                                  onChange={(e) =>
                                    setInlineEditDraft((prev) =>
                                      prev
                                        ? {
                                            ...prev,
                                            extraColumns: {
                                              ...prev.extraColumns,
                                              [colKey]: e.target.value,
                                            },
                                          }
                                        : prev,
                                    )
                                  }
                                  className="w-full min-w-[110px] px-2 py-1 text-xs bg-white border border-[#0F2F6B] rounded text-[#08152E] focus:outline-none"
                                />
                              ) : (
                                cellVal || '—'
                              )}
                            </td>
                          );
                        })}

                      {/* H: Lock & Governance Access State */}
                      <td className="px-2.5 py-1.5">
                        <div className="flex flex-col gap-0.5 text-[11px]">
                          {isEmployee ? (
                            canEmployeeRequestPermission ? (
                              canEditRow ? (
                                <span className="inline-flex items-center gap-1 font-semibold text-emerald-700">
                                  <Unlock className="w-3 h-3" />
                                  {DEPARTMENT_LABELS[currentUser.department] || currentUser.department}: Editable Once
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-1 font-bold text-[#0B2454]">
                                  <Lock className="w-3 h-3 text-[#B45309]" />
                                  {DEPARTMENT_LABELS[currentUser.department] || currentUser.department}: Locked
                                </span>
                              )
                            ) : (
                              <span className="inline-flex items-center gap-1 font-semibold text-slate-600">
                                <Eye className="w-3 h-3" />
                                {currentUser.department === 'fee_recovery'
                                  ? 'Fee Dept: Edit in Fee Recovery'
                                  : 'Department: View Only'}
                              </span>
                            )
                          ) : (
                            <span className="inline-flex items-center gap-1 font-semibold text-[#0B2454] text-[10px] font-mono">
                              ADM:{s.admissionLocked ? '🔒' : '✓'} TMA:{s.tmaLocked ? '🔒' : '✓'} PRC:{s.practicalLocked ? '🔒' : '✓'} CLS:{s.onlineClassesLocked ? '🔒' : '✓'}
                            </span>
                          )}
                          <span className="text-[10px] font-mono text-emerald-700 font-semibold">
                            {isSuperAdmin
                              ? 'Super Admin: Full Edit'
                              : isCentreHead
                                ? 'Centre Head: Branch Edit'
                                : 'Super Admin & Centre Head'}
                          </span>
                        </div>
                      </td>

                      {/* I: Actions */}
                      <td className="px-2.5 py-1.5 text-center">
                        <div className="inline-flex items-center justify-center gap-1">
                          {isEditingThisRow ? (
                            <>
                              <button
                                type="button"
                                disabled={inlineEditSaving}
                                onClick={() => handleSaveInlineEdit(s)}
                                className="inline-flex items-center gap-1 px-2 py-1 text-[10px] font-bold text-white bg-emerald-700 hover:bg-emerald-800 rounded disabled:opacity-50"
                                title="Save Excel Row"
                              >
                                <Check className="w-3 h-3" />
                                {inlineEditSaving ? 'Saving' : 'Save'}
                              </button>
                              <button
                                type="button"
                                disabled={inlineEditSaving}
                                onClick={() => {
                                  setInlineEditId(null);
                                  setInlineEditDraft(null);
                                }}
                                className="p-1 text-slate-600 hover:text-[#08152E] hover:bg-slate-200 rounded"
                                title="Cancel inline edit"
                              >
                                <X className="w-3.5 h-3.5" />
                              </button>
                            </>
                          ) : (
                            <>
                              <button
                                type="button"
                                onClick={() => setViewingStudent(s)}
                                className="p-1.5 text-slate-700 hover:text-[#08152E] hover:bg-sky-100 rounded"
                                title="View Details"
                              >
                                <Eye className="w-3.5 h-3.5" />
                              </button>

                              {canEditRow ? (
                                <>
                                  <button
                                    type="button"
                                    onClick={() => handleStartInlineEdit(s)}
                                    className="px-1.5 py-1 text-[10px] font-bold text-[#0B2454] bg-sky-50 hover:bg-sky-100 border border-sky-200 rounded"
                                    title={
                                      isEmployee
                                        ? `Quick Edit ${DEPARTMENT_LABELS[currentUser.department] || currentUser.department} cell`
                                        : 'Quick Edit row right in Excel'
                                    }
                                  >
                                    Inline
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setEditingStudent(s);
                                      setShowFormModal(true);
                                    }}
                                    className="p-1.5 text-[#0B2454] hover:bg-sky-100 rounded"
                                    title={
                                      isEmployee
                                        ? `Edit ${DEPARTMENT_LABELS[currentUser.department] || currentUser.department} Form`
                                        : 'Edit Full Student Form'
                                    }
                                  >
                                    <Edit3 className="w-3.5 h-3.5" />
                                  </button>
                                </>
                              ) : canEmployeeRequestPermission ? (
                                editRequests.some(
                                  (req) =>
                                    req.studentId === s.studentId &&
                                    req.department === currentUser.department &&
                                    req.status === 'Pending',
                                ) ? (
                                  <span
                                    className="inline-flex items-center gap-1 px-2 py-1 text-[10px] font-bold bg-amber-100 text-amber-900 rounded whitespace-nowrap"
                                    title="Waiting for Centre Head approval"
                                  >
                                    <Clock className="w-3 h-3" />
                                    Pending
                                  </span>
                                ) : (
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setPermissionStudent(s);
                                      setPermissionReason('');
                                      setPermissionError(null);
                                    }}
                                    className="inline-flex items-center gap-1 px-2 py-1 text-[10px] font-bold text-[#B45309] bg-amber-50 hover:bg-amber-100 border border-amber-200 rounded whitespace-nowrap"
                                    title="Ask Centre Head permission to unlock 1 correction edit"
                                  >
                                    <Send className="w-3 h-3" />
                                    Ask Permission
                                  </button>
                                )
                              ) : (
                                <span
                                  className="p-1.5 text-slate-400 cursor-not-allowed"
                                  title={
                                    isEmployee
                                      ? currentUser.department === 'fee_recovery'
                                        ? 'Fee Recovery employees update fee records in the Fee Recovery section.'
                                        : 'HR employees have view-only access on Student Database.'
                                      : 'Read-only outside your centre.'
                                  }
                                >
                                  <Lock className="w-3.5 h-3.5" />
                                </span>
                              )}

                              {isCentreHead && (
                                <button
                                  type="button"
                                  disabled={govBusyId === s.studentId}
                                  onClick={() => handleToggleEmployeeLock(s)}
                                  className="p-1.5 text-slate-700 hover:text-[#0B2454] hover:bg-sky-100 rounded"
                                  title={
                                    s.employeeLocked
                                      ? 'Unlock Row for 1-Time Employee Correction'
                                      : 'Lock Row Against Employee Edits'
                                  }
                                >
                                  {s.employeeLocked ? (
                                    <Unlock className="w-3.5 h-3.5" />
                                  ) : (
                                    <Lock className="w-3.5 h-3.5" />
                                  )}
                                </button>
                              )}

                              {canDelete && (
                                <button
                                  type="button"
                                  onClick={() => setDeletingStudent(s)}
                                  className="p-1.5 text-slate-600 hover:text-red-700 hover:bg-red-50 rounded"
                                  title="Delete Student"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              )}
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Excel Sheet Tab Footer + Pagination */}
        <div className="px-4 py-2.5 border-t border-slate-300 bg-slate-50 flex flex-wrap items-center justify-between gap-3 text-xs text-slate-700">
          <div className="flex items-center gap-2">
            <span className="px-3 py-1 bg-white border border-slate-300 border-b-2 border-b-[#DC2626] rounded-t font-bold text-[#B91C1C]">
              Sheet1: Student Database
            </span>
            <span className="text-[11px] font-mono text-slate-600">
              {filtered.length} total rows
            </span>
          </div>

          {filtered.length > effectivePageSize && (
            <div className="flex items-center gap-2">
              <span>
                Page <strong className="font-mono text-[#08152E]">{safePage}</strong> of{' '}
                <strong className="font-mono text-[#08152E]">{totalPages}</strong>
              </span>
              <button
                type="button"
                disabled={safePage <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                className="inline-flex items-center gap-1 px-2.5 py-1 text-[#08152E] bg-white border border-slate-300 rounded hover:bg-slate-100 disabled:opacity-40"
              >
                <ChevronLeft className="w-3.5 h-3.5" /> Prev
              </button>
              <button
                type="button"
                disabled={safePage >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                className="inline-flex items-center gap-1 px-2.5 py-1 text-[#08152E] bg-white border border-slate-300 rounded hover:bg-slate-100 disabled:opacity-40"
              >
                Next <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Modals */}
      <StudentProfileModal
        student={viewingStudent}
        displaySerial={viewingStudent ? displaySerialMap.get(viewingStudent.studentId) : undefined}
        currentUser={currentUser}
        onClose={() => setViewingStudent(null)}
        onEdit={(s) => {
          setViewingStudent(null);
          setEditingStudent(s);
          setShowFormModal(true);
        }}
        onTransferCentre={currentUser.role === 'super_admin' ? handleTransferCentre : undefined}
      />

      <StudentFormModal
        open={showFormModal}
        editingStudent={editingStudent}
        currentUser={currentUser}
        defaultCentreId={effectiveCentre === 'all' ? 'vp_lookerganj' : effectiveCentre}
        existingStudents={students}
        employees={employees}
        onClose={() => setShowFormModal(false)}
        onSuccess={(msg) => onNotify('Student Excel Updated', msg, 'success')}
        onError={(title, desc) => onNotify(title, desc, 'error')}
      />

      <BulkImportModal
        open={showBulkImport}
        currentUser={currentUser}
        defaultCentreId={effectiveCentre === 'all' ? 'vp_lookerganj' : effectiveCentre}
        existingStudents={students}
        onClose={() => setShowBulkImport(false)}
        onSuccess={(msg) => {
          setLocalSearch('');
          setTmaFilter('all');
          setCentreFilter('all');
          setPage(1);
          setRowsPerPage(999999);
          setShowExtraColumns(true);
          onNotify('Excel Imported & Opened', msg, 'success');
        }}
        onError={(title, desc) => onNotify(title, desc, 'error')}
      />

      <ConfirmDialog
        open={Boolean(deletingStudent)}
        title="Confirm Student Deletion"
        description={`Are you sure you want to permanently delete ${deletingStudent?.studentName} (Serial #${deletingStudent?.serialNumber}) and all linked department records? This action is recorded in the audit log.`}
        confirmLabel="Delete Student"
        destructive
        busy={deleteBusy}
        onConfirm={handleConfirmDelete}
        onCancel={() => setDeletingStudent(null)}
      />

      <ConfirmDialog
        open={showDeleteAllConfirm}
        title={
          filtered.length === students.length
            ? `Delete All ${filtered.length} Student Records?`
            : `Delete ${filtered.length} Filtered Student Records?`
        }
        description={
          deleteProgress
            ? `Deleting records: ${deleteProgress.done} / ${deleteProgress.total} completed... Please wait.`
            : `Kya aap ${filtered.length} student records${
                effectiveCentre !== 'all' ? ` (${CENTRE_MAP[effectiveCentre]?.name})` : ' (saare centres)'
              } aur unke linked Fee, Practical, TMA, Online Class aur Admission records permanently delete karna chahte hain? Iske baad aap naya Excel sheet fresh re-upload kar sakte hain.`
        }
        confirmLabel={
          deleteProgress
            ? `Deleting ${deleteProgress.done}/${deleteProgress.total}...`
            : `Yes, Delete ${filtered.length} Records`
        }
        destructive
        busy={deleteAllBusy}
        onConfirm={handleConfirmDeleteAll}
        onCancel={() => {
          if (!deleteAllBusy) setShowDeleteAllConfirm(false);
        }}
      />

      {permissionStudent && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#090d1b]/75 backdrop-blur-sm p-4">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-2xl max-w-md w-full p-6 text-[#0F172A]">
            <div className="flex items-start justify-between pb-3 border-b border-slate-200">
              <div>
                <h3 className="text-base font-bold text-[#08152E]">Ask Centre Head Edit Permission</h3>
                <p className="text-xs text-slate-600 mt-0.5 font-mono">
                  {permissionStudent.studentName} (#{permissionStudent.serialNumber}) ·{' '}
                  {DEPARTMENT_LABELS[currentUser.department] || currentUser.department}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setPermissionStudent(null)}
                className="text-slate-500 hover:text-[#08152E] p-1"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleSubmitPermissionRequest} className="mt-4 space-y-4">
              {permissionError && (
                <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-900">
                  {permissionError}
                </div>
              )}
              <div>
                <label className="block text-xs font-semibold text-[#08152E] mb-1">
                  Reason for Correction (sent to your Centre Head)
                </label>
                <textarea
                  rows={3}
                  required
                  minLength={3}
                  maxLength={500}
                  value={permissionReason}
                  onChange={(e) => setPermissionReason(e.target.value)}
                  placeholder="Describe what mistake happened and why you need 1 correction edit..."
                  className="w-full px-3 py-2 text-sm bg-white text-[#08152E] placeholder:text-slate-400 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#0F2F6B]"
                />
              </div>
              <div className="flex justify-end gap-2.5 pt-2">
                <button
                  type="button"
                  disabled={permissionBusy}
                  onClick={() => setPermissionStudent(null)}
                  className="px-4 py-2 text-xs font-semibold text-[#08152E] bg-white border border-slate-300 rounded-lg hover:bg-slate-100"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={permissionBusy}
                  className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-bold text-white btn-crimson-gloss rounded-lg disabled:opacity-50"
                >
                  <Send className="w-3.5 h-3.5" />
                  {permissionBusy ? 'Sending...' : 'Send Permission Request'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
