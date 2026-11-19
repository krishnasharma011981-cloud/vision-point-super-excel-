import {
  Clock,
  Download,
  FileSpreadsheet,
  IndianRupee,
  MessageCircle,
  Phone,
  RotateCcw,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import React, { useMemo, useState } from 'react';
import { CENTRE_MAP } from '../../constants/centres';
import {
  buildTelHref,
  buildWhatsAppHref,
  clampFeeNumber,
  isFeeFullyPaid,
  maskMobileNumber,
  resolveStudentFeeSummary,
} from '../../lib/analyticsMath';
import { buildContextualSerialMap, exportToCsv } from '../../lib/csvUtils';
import { playDeleteWarningVoice } from '../../lib/deleteSecurity';
import { verifyOperationLocation } from '../../lib/securityClient';
import {
  buildLatestTaskByStudentMap,
  formatStoredFollowUpDateTime,
  mapCallStatusToFeeFollowUp,
} from '../../lib/workAssignment';
import {
  deleteFeeRecoveryRecordsBatch,
  resetAllFeeRecordsToZero,
  upsertFeeRecoveryRecord,
} from '../../services/firestoreService';
import type {
  CentreId,
  EditRequest,
  FeeFollowUpStatus,
  FeeRecoveryRecord,
  RecoveryStatus,
  Student,
  UserAccount,
  WorkAssignment,
  WorkAssignmentTask,
} from '../../types/domain';
import { BulkImportModal } from '../BulkImportModal';
import { DeleteProtectionModal } from '../DeleteProtectionModal';
import {
  AskEditPermissionModal,
  DepartmentPendingRequestsPanel,
  DepartmentRowActionButton,
} from '../DepartmentPermissionControls';
import {
  AdminWorkAssignmentsPanel,
  StaffWorkCallingWorkspace,
} from '../StaffWorkCallingWorkspace';
import { WorkAssignmentModal } from '../WorkAssignmentModal';

interface FeeRecoveryViewProps {
  students: Student[];
  feeRecords: FeeRecoveryRecord[];
  employees: UserAccount[];
  editRequests?: EditRequest[];
  workAssignments?: WorkAssignment[];
  workAssignmentTasks?: WorkAssignmentTask[];
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
  workAssignments = [],
  workAssignmentTasks = [],
  currentUser,
  selectedCentreFilter,
  globalSearch,
  onNotify,
}) => {
  const [search, setSearch] = useState('');
  const [assignModalOpen, setAssignModalOpen] = useState(false);
  const [assignPrefill, setAssignPrefill] = useState<{ staffUid?: string; fromSerial?: number }>({});
  const [statusFilter, setStatusFilter] = useState<'unpaid' | 'paid' | 'all'>('unpaid');
  const [editingStudent, setEditingStudent] = useState<Student | null>(null);
  const [permissionStudent, setPermissionStudent] = useState<Student | null>(null);
  const [showBulkImport, setShowBulkImport] = useState(false);

  const [recoveryStatus, setRecoveryStatus] = useState<RecoveryStatus>('Pending');
  const [followUpStatus, setFollowUpStatus] = useState<FeeFollowUpStatus>('Scheduled');
  const [totalFee, setTotalFee] = useState('0');
  const [paidAmount, setPaidAmount] = useState('0');
  const [tmaFee, setTmaFee] = useState('0');
  const [examFee, setExamFee] = useState('0');
  const [assignedEmployeeUid, setAssignedEmployeeUid] = useState('');
  const [followUpNotes, setFollowUpNotes] = useState('');
  const [lastContactDate, setLastContactDate] = useState('');
  const [nextFollowUpDate, setNextFollowUpDate] = useState('');
  const [saving, setSaving] = useState(false);

  const [resettingZero, setResettingZero] = useState(false);
  const [confirmResetZero, setConfirmResetZero] = useState(false);
  const [showDeleteAllFeesModal, setShowDeleteAllFeesModal] = useState(false);
  const [deletingAllFees, setDeletingAllFees] = useState(false);
  const [deleteFeesProgress, setDeleteFeesProgress] = useState<{ done: number; total: number } | null>(null);

  const feeMap = useMemo(() => {
    const map = new Map<string, FeeRecoveryRecord>();
    feeRecords.forEach((r) => map.set(r.studentId, r));
    return map;
  }, [feeRecords]);

  const effectiveCentre =
    currentUser.role === 'super_admin' ? selectedCentreFilter : currentUser.centreId;

  const canBatchSync = currentUser.role === 'super_admin' || currentUser.role === 'centre_head';
  const canDeleteAllFees = currentUser.role === 'super_admin';

  const scopedStudents = useMemo(
    () => (effectiveCentre === 'all' ? students : students.filter((s) => s.centreId === effectiveCentre)),
    [students, effectiveCentre],
  );

  const scopedFeeRecords = useMemo(
    () => (effectiveCentre === 'all' ? feeRecords : feeRecords.filter((f) => f.centreId === effectiveCentre)),
    [feeRecords, effectiveCentre],
  );

  const combinedSearch = (search || globalSearch).trim().toLowerCase();

  const displaySerialMap = useMemo(
    () => buildContextualSerialMap(students, effectiveCentre),
    [students, effectiveCentre],
  );

  const latestTaskMap = useMemo(
    () => buildLatestTaskByStudentMap(workAssignmentTasks, 'fee_recovery'),
    [workAssignmentTasks],
  );

  const allScopedRows = useMemo(() => {
    return scopedStudents.map((s) => {
      const rec = feeMap.get(s.studentId);
      const latestTask = latestTaskMap.get(s.studentId);
      const resolved = resolveStudentFeeSummary(s, rec);
      const fullyPaid = isFeeFullyPaid(resolved);
      const lockedForEmployee = currentUser.role === 'employee' && Boolean(rec?.employeeLocked);

      const taskNextFollowUp = latestTask
        ? formatStoredFollowUpDateTime(latestTask.followUpDate, latestTask.followUpTime)
        : '';
      const resolvedNextFollowUp = taskNextFollowUp || rec?.nextFollowUpDate || '—';
      const resolvedRemark = latestTask?.remark?.trim() || rec?.followUpNotes?.trim() || '';
      const resolvedFollowUpStatus = latestTask
        ? mapCallStatusToFeeFollowUp(latestTask.callStatus, resolved.followUpStatus)
        : resolved.followUpStatus;

      return {
        student: s,
        displaySerial: displaySerialMap.get(s.studentId) ?? s.serialNumber,
        record: rec,
        latestTask,
        recoveryStatus: resolved.recoveryStatus,
        followUpStatus: resolvedFollowUpStatus,
        fullyPaid,
        totalFee: resolved.totalFee,
        paidAmount: resolved.paidAmount,
        pendingAmount: resolved.pendingAmount,
        tmaFee: resolved.tmaFee,
        examFee: resolved.examFee,
        hasFeeData: resolved.hasFeeData,
        assignedEmployeeName: latestTask?.staffName || rec?.assignedEmployeeName || s.assignedEmployeeName || 'Unassigned',
        lastContactDate: latestTask?.lastCalledAt ? latestTask.lastCalledAt.slice(0, 10) : (rec?.lastContactDate || '—'),
        nextFollowUpDate: resolvedNextFollowUp,
        hasCallingSchedule: Boolean(taskNextFollowUp),
        followUpNotes: resolvedRemark,
        callStatusLabel: latestTask?.callStatus || '',
        lockedForEmployee,
      };
    });
  }, [scopedStudents, feeMap, latestTaskMap, displaySerialMap, currentUser.role]);

  const scopeCounts = useMemo(() => {
    let paid = 0;
    let unpaid = 0;
    let total = 0;
    let paidSum = 0;
    let pendingSum = 0;
    for (const r of allScopedRows) {
      total += r.totalFee;
      paidSum += r.paidAmount;
      pendingSum += r.pendingAmount;
      if (r.fullyPaid) paid += 1;
      else unpaid += 1;
    }
    return {
      all: allScopedRows.length,
      paid,
      unpaid,
      total,
      paidSum,
      pendingSum,
    };
  }, [allScopedRows]);

  const rows = useMemo(() => {
    return allScopedRows
      .filter((r) => {
        if (statusFilter === 'paid') return r.fullyPaid;
        if (statusFilter === 'unpaid') return !r.fullyPaid;
        return true;
      })
      .filter((r) => {
        if (!combinedSearch) return true;
        return (
          r.student.studentName.toLowerCase().includes(combinedSearch) ||
          r.student.studentId.toLowerCase().includes(combinedSearch) ||
          r.student.mobileNumber.toLowerCase().includes(combinedSearch) ||
          r.followUpNotes.toLowerCase().includes(combinedSearch)
        );
      })
      .sort((a, b) => {
        if (statusFilter === 'unpaid') {
          const aHasPend = a.pendingAmount > 0 ? 1 : 0;
          const bHasPend = b.pendingAmount > 0 ? 1 : 0;
          if (aHasPend !== bHasPend) return bHasPend - aHasPend;
        }
        return a.displaySerial - b.displaySerial;
      });
  }, [allScopedRows, statusFilter, combinedSearch]);

  const totals = useMemo(() => {
    const agg = rows.reduce(
      (acc, r) => {
        acc.total += r.totalFee;
        acc.paid += r.paidAmount;
        acc.pending += r.pendingAmount;
        acc.tmaFee += r.tmaFee;
        acc.examFee += r.examFee;
        if (r.fullyPaid) acc.paidCount += 1;
        else acc.unpaidCount += 1;
        return acc;
      },
      {
        total: 0,
        paid: 0,
        pending: 0,
        tmaFee: 0,
        examFee: 0,
        paidCount: 0,
        unpaidCount: 0,
      },
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
    const resolved = resolveStudentFeeSummary(student, existing);
    setEditingStudent(student);
    setRecoveryStatus(resolved.recoveryStatus);
    setFollowUpStatus(resolved.followUpStatus);
    setTotalFee(String(resolved.totalFee));
    setPaidAmount(String(resolved.paidAmount));
    setTmaFee(String(resolved.tmaFee));
    setExamFee(String(resolved.examFee));
    const latestTask = latestTaskMap.get(student.studentId);
    const taskFollowUp = latestTask
      ? formatStoredFollowUpDateTime(latestTask.followUpDate, latestTask.followUpTime)
      : '';
    setAssignedEmployeeUid(existing?.assignedEmployeeUid || student.assignedEmployeeUid || currentUser.uid);
    setFollowUpNotes(latestTask?.remark?.trim() || existing?.followUpNotes || '');
    setLastContactDate(
      latestTask?.lastCalledAt ? latestTask.lastCalledAt.slice(0, 10) : (existing?.lastContactDate || new Date().toISOString().slice(0, 10)),
    );
    setNextFollowUpDate(taskFollowUp || existing?.nextFollowUpDate || new Date().toISOString().slice(0, 10));
  };

  const handleAmountFieldChange = (nextTotalStr: string, nextPaidStr: string) => {
    setTotalFee(nextTotalStr);
    setPaidAmount(nextPaidStr);
    const tot = clampFeeNumber(nextTotalStr);
    const paid = clampFeeNumber(nextPaidStr);
    const pend = Math.max(0, tot - paid);
    if (tot > 0 && pend === 0) {
      setRecoveryStatus('Paid');
      setFollowUpStatus('Closed');
    } else if (paid > 0 && pend > 0) {
      setRecoveryStatus('Partial');
      setFollowUpStatus('Promise to Pay');
    } else if (recoveryStatus === 'Paid' || recoveryStatus === 'Partial') {
      setRecoveryStatus('Pending');
      setFollowUpStatus('Scheduled');
    }
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

      const paid = clampFeeNumber(paidAmount);
      const tot = Math.max(paid, clampFeeNumber(totalFee));
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

  const handleResetAllFeesToZero = async () => {
    if (!canBatchSync) return;
    setResettingZero(true);
    try {
      const targetCentre = effectiveCentre === 'all' ? currentUser.centreId : effectiveCentre;
      const loc = await verifyOperationLocation(currentUser, 'FEE_RESET_TO_ZERO', targetCentre);
      if (!loc.allowed) {
        onNotify('Access Denied', loc.error || 'Physical presence required at centre.', 'error');
        setResettingZero(false);
        return;
      }

      const res = await resetAllFeeRecordsToZero(scopedStudents, scopedFeeRecords, currentUser, {
        locationVerified: true,
      });

      setConfirmResetZero(false);
      onNotify(
        'All Fees Reset to ₹0',
        `Cleared ${res.resetCount + res.createdCount} student fee records to ₹0. Upload your Excel sheet via "Update Fees from Excel" to fill Paid & Unpaid fees.`,
        'success',
      );
    } catch (err) {
      onNotify('Fee Reset Failed', err instanceof Error ? err.message : 'Unable to reset fee records.', 'error');
    } finally {
      setResettingZero(false);
    }
  };

  const handleConfirmDeleteAllFees = async () => {
    if (!canDeleteAllFees) return;
    setDeletingAllFees(true);
    setDeleteFeesProgress({ done: 0, total: scopedFeeRecords.length });
    try {
      const targetCentre = effectiveCentre === 'all' ? currentUser.centreId : effectiveCentre;
      const loc = await verifyOperationLocation(currentUser, 'BULK_FEE_RECOVERY_DELETED', targetCentre);
      if (!loc.allowed) {
        onNotify('Access Denied', loc.error || 'Physical presence required at centre.', 'error');
        setDeletingAllFees(false);
        setDeleteFeesProgress(null);
        return;
      }

      const res = await deleteFeeRecoveryRecordsBatch(scopedFeeRecords, scopedStudents, currentUser, {
        onProgress: (done, total) => setDeleteFeesProgress({ done, total }),
        locationVerified: true,
      });

      setShowDeleteAllFeesModal(false);
      if (res.failedIds.length > 0) {
        onNotify(
          'Bulk Fee Delete Partially Complete',
          `Deleted ${res.deletedCount} fee recovery records (${res.failedIds.length} failed).`,
          'warning',
        );
      } else {
        onNotify(
          'All Fee Recovery Deleted',
          `Successfully deleted ${res.deletedCount} fee recovery records cleanly.`,
          'success',
        );
      }
    } catch (err) {
      onNotify(
        'Bulk Fee Delete Failed',
        err instanceof Error ? err.message : 'Unable to delete fee recovery records.',
        'error',
      );
    } finally {
      setDeletingAllFees(false);
      setDeleteFeesProgress(null);
    }
  };

  const handleExport = () => {
    exportToCsv(
      `fee-recovery-report-${effectiveCentre}-${statusFilter}.csv`,
      [
        'S.No',
        'Student ID',
        'Student Name',
        'Mobile',
        'Centre',
        'Fee Status',
        'Follow-Up Status',
        'Total Fee (INR)',
        'Paid / Jama (INR)',
        'Pending / Baki (INR)',
        'TMA Fee (INR)',
        'Exam Fee (INR)',
        'Last Contact',
        'Next Follow-Up',
        'Call Remark',
        'Assigned To',
      ],
      rows.map((r) => [
        r.displaySerial,
        r.student.studentId,
        r.student.studentName,
        maskMobileNumber(r.student.mobileNumber),
        CENTRE_MAP[r.student.centreId].name,
        r.fullyPaid ? 'Paid' : 'Unpaid',
        r.followUpStatus,
        r.totalFee,
        r.paidAmount,
        r.pendingAmount,
        r.tmaFee,
        r.examFee,
        r.lastContactDate,
        r.nextFollowUpDate,
        r.followUpNotes || '',
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

  const modalLivePending = Math.max(0, clampFeeNumber(totalFee) - clampFeeNumber(paidAmount));

  // Staff (employee) role sees ONLY their assigned Big Calling Box (not an Excel table)
  if (currentUser.role === 'employee') {
    return (
      <StaffWorkCallingWorkspace
        department="fee_recovery"
        currentUser={currentUser}
        assignments={workAssignments}
        tasks={workAssignmentTasks}
        onNotify={onNotify}
      />
    );
  }

  return (
    <div className="space-y-5">
      {/* Staff Calling Assignments Panel (Super Admin & Centre Head ONLY) */}
      {canBatchSync && (
        <AdminWorkAssignmentsPanel
          department="fee_recovery"
          currentUser={currentUser}
          effectiveCentre={effectiveCentre}
          assignments={workAssignments}
          tasks={workAssignmentTasks}
          onOpenAssignModal={(prefill) => {
            setAssignPrefill(prefill || {});
            setAssignModalOpen(true);
          }}
          onNotify={onNotify}
        />
      )}

      {/* KPI Summary Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white rounded-xl border border-zinc-200 p-4">
          <p className="text-xs font-semibold text-zinc-700">Total Fee Billed</p>
          <p className="text-2xl font-bold text-black font-mono tabular-nums mt-1">
            ₹{totals.total.toLocaleString('en-IN')}
          </p>
          <p className="text-[11px] font-mono text-zinc-600 mt-0.5">
            {rows.length} Showing · {scopeCounts.paid} Paid · {scopeCounts.unpaid} Unpaid
          </p>
        </div>
        <div className="bg-white rounded-xl border border-zinc-200 p-4">
          <p className="text-xs font-semibold text-zinc-700">Paid / Jama Collected</p>
          <p className="text-2xl font-bold text-emerald-700 font-mono tabular-nums mt-1">
            ₹{totals.paid.toLocaleString('en-IN')}
          </p>
          <p className="text-[11px] font-mono font-semibold text-emerald-700 mt-0.5">
            {totals.collectionRatePct}% Collection Rate
          </p>
        </div>
        <div className="bg-white rounded-xl border border-zinc-200 p-4">
          <p className="text-xs font-semibold text-zinc-700">Pending / Baki Recovery</p>
          <p className="text-2xl font-bold text-red-700 font-mono tabular-nums mt-1">
            ₹{totals.pending.toLocaleString('en-IN')}
          </p>
          <p className="text-[11px] font-mono text-zinc-600 mt-0.5">
            TMA ₹{totals.tmaFee.toLocaleString('en-IN')} · Exam ₹{totals.examFee.toLocaleString('en-IN')}
          </p>
        </div>
        <div className="bg-white rounded-xl border border-zinc-200 p-4 flex flex-col justify-between">
          <p className="text-xs font-semibold text-zinc-700">Auto-Detected Fee Status</p>
          <div className="grid grid-cols-2 gap-2 mt-1.5">
            <button
              type="button"
              onClick={() => setStatusFilter('unpaid')}
              className={`px-2.5 py-1.5 rounded-lg border text-left transition-colors ${
                statusFilter === 'unpaid'
                  ? 'bg-red-50 border-red-400 text-red-900 ring-1 ring-red-400'
                  : 'bg-zinc-50 border-zinc-200 text-zinc-700 hover:border-red-300'
              }`}
            >
              <span className="block text-[10px] font-bold uppercase">Unpaid</span>
              <span className="font-mono font-bold text-lg tabular-nums">{scopeCounts.unpaid}</span>
            </button>
            <button
              type="button"
              onClick={() => setStatusFilter('paid')}
              className={`px-2.5 py-1.5 rounded-lg border text-left transition-colors ${
                statusFilter === 'paid'
                  ? 'bg-emerald-50 border-emerald-400 text-emerald-900 ring-1 ring-emerald-400'
                  : 'bg-zinc-50 border-zinc-200 text-zinc-700 hover:border-emerald-300'
              }`}
            >
              <span className="block text-[10px] font-bold uppercase">Paid</span>
              <span className="font-mono font-bold text-lg tabular-nums">{scopeCounts.paid}</span>
            </button>
          </div>
        </div>
      </div>

      {/* Clean guidance banner when all fees are ₹0 waiting for real Excel upload */}
      {canBatchSync &&
        scopedStudents.length > 0 &&
        scopeCounts.total === 0 &&
        scopeCounts.paidSum === 0 &&
        scopeCounts.pendingSum === 0 &&
        scopeCounts.paid === 0 &&
        !combinedSearch && (
          <div className="bg-sky-50 border border-sky-300 rounded-xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex items-start gap-2.5">
              <FileSpreadsheet className="w-4 h-4 text-sky-800 shrink-0 mt-0.5" />
              <div className="text-xs text-sky-950 space-y-0.5">
                <p className="font-bold">All Fees Currently ₹0 — Ready for Real Excel Upload</p>
                <p>
                  Click <strong>Update Fees from Excel</strong> to upload your branch Excel sheet. Fully paid students will show in <strong>Paid</strong> and everyone with unpaid / baki fees will show in <strong>Unpaid</strong>.
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setShowBulkImport(true)}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-bold text-white btn-crimson-gloss rounded-lg shrink-0"
            >
              <FileSpreadsheet className="w-3.5 h-3.5" />
              Update Fees from Excel
            </button>
          </div>
        )}

      {/* Filter Toolbar */}
      <div className="bg-white rounded-xl border border-zinc-200 p-5 space-y-3">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
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
              onChange={(e) => setStatusFilter(e.target.value as 'unpaid' | 'paid' | 'all')}
              className="px-3 py-2 text-sm border border-zinc-300 rounded-lg bg-white text-black font-semibold focus:outline-none focus:ring-2 focus:ring-black"
            >
              <option value="unpaid">Unpaid ({scopeCounts.unpaid})</option>
              <option value="paid">Paid ({scopeCounts.paid})</option>
              <option value="all">All (Paid + Unpaid) ({scopeCounts.all})</option>
            </select>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {canBatchSync && (
              <button
                type="button"
                onClick={() => setShowBulkImport(true)}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-bold text-white btn-crimson-gloss rounded-lg whitespace-nowrap"
              >
                <FileSpreadsheet className="w-3.5 h-3.5" />
                Update Fees from Excel
              </button>
            )}
            {canBatchSync && !confirmResetZero && (
              <button
                type="button"
                disabled={resettingZero}
                onClick={() => setConfirmResetZero(true)}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-red-800 bg-red-50 border border-red-200 rounded-lg hover:bg-red-100 whitespace-nowrap disabled:opacity-50"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                Reset All Fees to ₹0
              </button>
            )}
            {canBatchSync && confirmResetZero && (
              <div className="inline-flex items-center gap-1.5 bg-red-50 border border-red-300 rounded-lg px-2.5 py-1.5">
                <span className="text-[11px] font-bold text-red-900">Set all fees to ₹0?</span>
                <button
                  type="button"
                  disabled={resettingZero}
                  onClick={() => void handleResetAllFeesToZero()}
                  className="px-2 py-0.5 text-[11px] font-bold text-white bg-red-700 hover:bg-red-800 rounded disabled:opacity-50"
                >
                  {resettingZero ? 'Resetting...' : 'Confirm'}
                </button>
                <button
                  type="button"
                  disabled={resettingZero}
                  onClick={() => setConfirmResetZero(false)}
                  className="px-2 py-0.5 text-[11px] font-semibold text-zinc-700 hover:bg-white rounded"
                >
                  Cancel
                </button>
              </div>
            )}
            {canDeleteAllFees && (
              <button
                type="button"
                disabled={
                  deletingAllFees ||
                  (scopedFeeRecords.length === 0 &&
                    !scopedStudents.some((s) => (s.tmaFee ?? 0) > 0 || (s.examFee ?? 0) > 0))
                }
                onClick={() => {
                  playDeleteWarningVoice();
                  setShowDeleteAllFeesModal(true);
                }}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-bold text-white bg-red-700 hover:bg-red-800 rounded-lg whitespace-nowrap disabled:opacity-45"
                title="Delete all fee recovery records in scope (Password Protected)"
              >
                <Trash2 className="w-3.5 h-3.5" />
                Delete All Fees ({scopedFeeRecords.length})
              </button>
            )}
            <button
              type="button"
              onClick={handleExport}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-black bg-white border border-zinc-300 rounded-lg hover:bg-zinc-100 whitespace-nowrap"
            >
              <Download className="w-3.5 h-3.5" />
              Export Recovery Report
            </button>
          </div>
        </div>
        {/* Quick Filter Tabs */}
        <div className="pt-2 border-t border-zinc-100 flex flex-wrap items-center gap-2 text-xs">
          <button
            type="button"
            onClick={() => setStatusFilter('unpaid')}
            className={`px-3 py-1 rounded-lg border font-bold transition-colors ${
              statusFilter === 'unpaid'
                ? 'bg-red-700 text-white border-red-700'
                : 'bg-red-50 text-red-800 border-red-200 hover:bg-red-100'
            }`}
          >
            Unpaid ({scopeCounts.unpaid})
          </button>
          <button
            type="button"
            onClick={() => setStatusFilter('paid')}
            className={`px-3 py-1 rounded-lg border font-bold transition-colors ${
              statusFilter === 'paid'
                ? 'bg-emerald-700 text-white border-emerald-700'
                : 'bg-emerald-50 text-emerald-800 border-emerald-200 hover:bg-emerald-100'
            }`}
          >
            Paid ({scopeCounts.paid})
          </button>
          <button
            type="button"
            onClick={() => setStatusFilter('all')}
            className={`px-3 py-1 rounded-lg border font-bold transition-colors ${
              statusFilter === 'all'
                ? 'bg-slate-900 text-white border-slate-900'
                : 'bg-zinc-100 text-zinc-800 border-zinc-300 hover:bg-zinc-200'
            }`}
          >
            All (Paid + Unpaid) ({scopeCounts.all})
          </button>
        </div>
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
          <div className="p-10 text-center text-xs text-zinc-700 space-y-3">
            <IndianRupee className="w-8 h-8 text-zinc-400 mx-auto" />
            {!combinedSearch && statusFilter === 'paid' ? (
              <div className="max-w-md mx-auto space-y-2">
                <p className="font-bold text-sm text-slate-900">0 Paid Students Found</p>
                <p className="text-zinc-600">
                  Upload your Excel via <strong>Update Fees from Excel</strong> or view Unpaid / All students.
                </p>
                <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => setStatusFilter('unpaid')}
                    className="px-3.5 py-1.5 text-xs font-bold text-white btn-crimson-gloss rounded-lg"
                  >
                    Show Unpaid ({scopeCounts.unpaid})
                  </button>
                  <button
                    type="button"
                    onClick={() => setStatusFilter('all')}
                    className="px-3.5 py-1.5 text-xs font-semibold text-black bg-white border border-zinc-300 rounded-lg hover:bg-zinc-100"
                  >
                    Show All ({scopeCounts.all})
                  </button>
                </div>
              </div>
            ) : !combinedSearch && statusFilter === 'unpaid' ? (
              <div className="max-w-md mx-auto space-y-2">
                <p className="font-bold text-sm text-emerald-800">All {scopeCounts.paid} Students Are Paid</p>
                <button
                  type="button"
                  onClick={() => setStatusFilter('all')}
                  className="px-3.5 py-1.5 text-xs font-semibold text-black bg-white border border-zinc-300 rounded-lg hover:bg-zinc-100"
                >
                  Show All ({scopeCounts.all})
                </button>
              </div>
            ) : (
              <p>No student fee recovery records match the current filter.</p>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-zinc-200 bg-zinc-50 text-[11px] font-bold text-zinc-700 uppercase tracking-wider">
                  <th className="py-3 px-4">Student</th>
                  <th className="py-3 px-4">Contact</th>
                  <th className="py-3 px-4">Status</th>
                  <th className="py-3 px-4">Follow-Up</th>
                  <th className="py-3 px-4 text-right">Total Fee</th>
                  <th className="py-3 px-4 text-right">Paid (Jama)</th>
                  <th className="py-3 px-4 text-right">Pending (Baki)</th>
                  <th className="py-3 px-4 text-right">TMA Fee</th>
                  <th className="py-3 px-4 text-right">Exam Fee</th>
                  <th className="py-3 px-4">Next Follow-Up</th>
                  <th className="py-3 px-4">Call Remark</th>
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
                          'fees aur baki recovery update',
                        ) ? (
                          <a
                            href={buildWhatsAppHref(
                              r.student.mobileNumber,
                              r.student.studentName,
                              'fees aur baki recovery update',
                            )!}
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
                    <td className="py-3 px-4 whitespace-nowrap">
                      <span
                        className={`font-semibold ${
                          r.fullyPaid
                            ? 'text-emerald-700'
                            : r.paidAmount > 0 && r.pendingAmount > 0
                              ? 'text-[#B45309]'
                              : 'text-red-700'
                        }`}
                      >
                        {r.fullyPaid
                          ? 'Paid'
                          : r.paidAmount > 0 && r.pendingAmount > 0
                            ? 'Unpaid (Half Paid)'
                            : 'Unpaid'}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-zinc-800 whitespace-nowrap">{r.followUpStatus}</td>
                    <td className="py-3 px-4 text-right font-mono font-semibold text-slate-900 tabular-nums whitespace-nowrap">
                      ₹{r.totalFee.toLocaleString('en-IN')}
                    </td>
                    <td className="py-3 px-4 text-right font-mono font-semibold text-emerald-700 tabular-nums whitespace-nowrap">
                      ₹{r.paidAmount.toLocaleString('en-IN')}
                    </td>
                    <td
                      className={`py-3 px-4 text-right font-mono font-bold tabular-nums whitespace-nowrap ${
                        r.pendingAmount > 0 ? 'text-red-700' : 'text-emerald-700'
                      }`}
                    >
                      ₹{r.pendingAmount.toLocaleString('en-IN')}
                    </td>
                    <td className="py-3 px-4 text-right font-mono font-semibold text-amber-800 tabular-nums whitespace-nowrap">
                      ₹{r.tmaFee.toLocaleString('en-IN')}
                    </td>
                    <td className="py-3 px-4 text-right font-mono font-semibold text-indigo-800 tabular-nums whitespace-nowrap">
                      ₹{r.examFee.toLocaleString('en-IN')}
                    </td>
                    <td className="py-3 px-4 font-mono whitespace-nowrap">
                      {r.hasCallingSchedule ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-amber-50 border border-amber-300 text-amber-900 font-bold text-[11px]">
                          <Clock className="w-3 h-3 text-amber-700 shrink-0" />
                          {r.nextFollowUpDate}
                        </span>
                      ) : (
                        <span className="text-zinc-700">{r.nextFollowUpDate}</span>
                      )}
                    </td>
                    <td className="py-3 px-4 min-w-[200px] max-w-[280px] whitespace-normal leading-snug">
                      {r.followUpNotes ? (
                        <div>
                          <p className="text-slate-900 font-medium break-words">{r.followUpNotes}</p>
                          {r.callStatusLabel && (
                            <p className="text-[10px] font-semibold text-zinc-500 mt-0.5">
                              {r.callStatusLabel}
                              {r.latestTask?.staffName ? ` · ${r.latestTask.staffName}` : ''}
                            </p>
                          )}
                        </div>
                      ) : (
                        <span className="text-zinc-400">—</span>
                      )}
                    </td>
                    <td className="py-3 px-4 text-zinc-800 whitespace-nowrap">{r.assignedEmployeeName}</td>
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
              <tfoot>
                <tr className="border-t-2 border-zinc-200 bg-zinc-50 text-xs font-bold">
                  <td colSpan={4} className="py-3 px-4 text-slate-900">
                    TOTAL ({rows.length} Students)
                  </td>
                  <td className="py-3 px-4 text-right font-mono text-slate-900 tabular-nums">
                    ₹{totals.total.toLocaleString('en-IN')}
                  </td>
                  <td className="py-3 px-4 text-right font-mono text-emerald-700 tabular-nums">
                    ₹{totals.paid.toLocaleString('en-IN')}
                  </td>
                  <td className="py-3 px-4 text-right font-mono text-red-700 tabular-nums">
                    ₹{totals.pending.toLocaleString('en-IN')}
                  </td>
                  <td className="py-3 px-4 text-right font-mono text-amber-800 tabular-nums">
                    ₹{totals.tmaFee.toLocaleString('en-IN')}
                  </td>
                  <td className="py-3 px-4 text-right font-mono text-indigo-800 tabular-nums">
                    ₹{totals.examFee.toLocaleString('en-IN')}
                  </td>
                  <td colSpan={4} className="py-3 px-4 text-right font-mono text-zinc-600">
                    {totals.collectionRatePct}% Collected
                  </td>
                </tr>
              </tfoot>
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
                    <option value="Pending">Unpaid</option>
                    <option value="Partial">Unpaid (Half Paid)</option>
                    <option value="Overdue">Unpaid (Overdue)</option>
                    <option value="Paid">Paid (Full Clear)</option>
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
                    onChange={(e) => handleAmountFieldChange(e.target.value, paidAmount)}
                    className="w-full px-3 py-2 text-sm font-mono bg-white text-black border border-zinc-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-black"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-emerald-900 mb-1">
                    Paid / Jama Amount (INR)
                  </label>
                  <input
                    type="number"
                    min={0}
                    value={paidAmount}
                    onChange={(e) => handleAmountFieldChange(totalFee, e.target.value)}
                    className="w-full px-3 py-2 text-sm font-mono bg-white text-black border border-emerald-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-black"
                  />
                </div>
                <div className="col-span-2 px-3 py-2 rounded-lg bg-slate-50 border border-slate-200 flex items-center justify-between text-xs">
                  <span className="font-semibold text-slate-700">Auto-Calculated Pending (Baki):</span>
                  <span
                    className={`font-mono font-bold ${modalLivePending > 0 ? 'text-red-700' : 'text-emerald-700'}`}
                  >
                    ₹{modalLivePending.toLocaleString('en-IN')}
                  </span>
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

      {showBulkImport && (
        <BulkImportModal
          open={showBulkImport}
          currentUser={currentUser}
          defaultCentreId={effectiveCentre === 'all' ? currentUser.centreId : effectiveCentre}
          isCentreLocked={effectiveCentre !== 'all'}
          existingStudents={students}
          mode="fee_sync"
          feeRecords={feeRecords}
          onClose={() => setShowBulkImport(false)}
          onSuccess={(msg) => {
            setShowBulkImport(false);
            onNotify('Excel Fees Synced', msg, 'success');
          }}
          onError={(title, desc) => onNotify(title, desc, 'error')}
        />
      )}

      <DeleteProtectionModal
        open={showDeleteAllFeesModal}
        title={`Delete All ${scopedFeeRecords.length} Fee Recovery Records?`}
        description={
          deleteFeesProgress
            ? `Deleting fee records: ${deleteFeesProgress.done} / ${deleteFeesProgress.total} completed... Please wait.`
            : `Kya aap ${scopedFeeRecords.length} fee recovery records${
                effectiveCentre !== 'all' ? ` (${CENTRE_MAP[effectiveCentre]?.name})` : ' (saare centres)'
              } aur TMA/Exam fees ko ek sath permanently delete karna chahte hain? Verify karne ke liye password daalein.`
        }
        confirmLabel={
          deleteFeesProgress
            ? `Deleting ${deleteFeesProgress.done}/${deleteFeesProgress.total}...`
            : `Yes, Delete ${scopedFeeRecords.length} Fee Records`
        }
        busy={deletingAllFees}
        onConfirm={handleConfirmDeleteAllFees}
        onCancel={() => {
          if (!deletingAllFees) setShowDeleteAllFeesModal(false);
        }}
      />

      {canBatchSync && (
        <WorkAssignmentModal
          open={assignModalOpen}
          department="fee_recovery"
          currentUser={currentUser}
          selectedCentreFilter={selectedCentreFilter}
          students={students}
          displaySerialMap={displaySerialMap}
          employees={employees}
          existingAssignments={workAssignments}
          existingTasks={workAssignmentTasks}
          initialStaffUid={assignPrefill.staffUid}
          initialFromSerial={assignPrefill.fromSerial}
          resolveStudentContext={(st) => {
            const rec = feeMap.get(st.studentId);
            const resolved = resolveStudentFeeSummary(st, rec);
            return {
              subject: st.subject || '',
              pendingFee: resolved.pendingAmount,
              totalFee: resolved.totalFee,
              isPendingWork: !isFeeFullyPaid(resolved),
            };
          }}
          onClose={() => setAssignModalOpen(false)}
          onNotify={onNotify}
        />
      )}
    </div>
  );
};
