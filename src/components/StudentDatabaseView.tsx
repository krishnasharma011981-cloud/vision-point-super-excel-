import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  Columns3,
  Download,
  Edit3,
  Eye,
  FileSpreadsheet,
  GripVertical,
  IndianRupee,
  Maximize2,
  MessageCircle,
  Minimize2,
  Pencil,
  Phone,
  Plus,
  RotateCcw,
  Search,
  Send,
  Shuffle,
  Trash2,
  Upload,
  Users,
  X,
  XCircle,
} from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CANONICAL_CENTRES, CENTRE_MAP, DEPARTMENT_LABELS } from '../constants/centres';
import {
  buildTelHref,
  buildWhatsAppHref,
  clampFeeNumber,
  maskMobileNumber,
  resolveStudentFeeSummary,
} from '../lib/analyticsMath';
import {
  buildContextualSerialMap,
  canonicalCommonHeaderToken,
  computeAddExtraColumnDefaultUpdates,
  computeAutoExcelColumnWidth,
  computeDeleteMultipleExtraColumnsStudentUpdates,
  computeInsertRowSerialPlan,
  computeRenameExtraColumnStudentUpdates,
  computeShuffledStudentOrderUpdates,
  computeStudentReorderUpdates,
  exportToCsv,
  exportToExcel,
  extractJaunpurHeadingAndBlankColumns,
  getReadableTextColor,
  getStudentExtraColumnValue,
  mergeExtraColumnsWithConfig,
  pruneStoredCommonBranchHeaders,
} from '../lib/csvUtils';
import { playDeleteWarningVoice } from '../lib/deleteSecurity';
import { verifyOperationLocation } from '../lib/securityClient';
import {
  batchUpdateStudentExtraColumns,
  checkDuplicateStudent,
  createEditRequest,
  createStudentRecord,
  deleteStudentRecord,
  deleteStudentsBatch,
  isStudentDeptLockedForEmployee,
  reviewEditRequest,
  saveExcelSheetConfig,
  updateStudentRecord,
  updateStudentsSerialOrderBatch,
  upsertFeeRecoveryRecord,
} from '../services/firestoreService';
import type {
  CentreId,
  ClassAttendanceStatus,
  DepartmentId,
  EditRequest,
  ExcelSheetConfig,
  FeeRecoveryRecord,
  PracticalStatus,
  RecoveryStatus,
  Student,
  TmaStatus,
  UserAccount,
} from '../types/domain';
import { BulkImportModal } from './BulkImportModal';
import { ConfirmDialog } from './ConfirmDialog';
import { DeleteProtectionModal } from './DeleteProtectionModal';
import { StudentFormModal } from './StudentFormModal';
import { StudentProfileModal } from './StudentProfileModal';

interface StudentDatabaseViewProps {
  students: Student[];
  feeRecords?: FeeRecoveryRecord[];
  employees: UserAccount[];
  editRequests?: EditRequest[];
  sheetConfigs?: ExcelSheetConfig[];
  currentUser: UserAccount;
  selectedCentreFilter: CentreId | 'all';
  globalSearch: string;
  loading: boolean;
  onNotify: (title: string, description: string, variant: 'success' | 'error' | 'warning' | 'info') => void;
}

type SortKey = 'serialNumber' | 'studentName' | 'tmaStatus' | 'practicalStatus' | 'classAttendanceStatus';

type InlineEditFocusField =
  | 'studentName'
  | 'mobileNumber'
  | 'tmaStatus'
  | 'practicalStatus'
  | 'classAttendanceStatus'
  | 'totalFee'
  | 'paidAmount'
  | 'tmaFee'
  | 'examFee'
  | `extra:${string}`;

const EDITABLE_STUDENT_DEPTS = ['admission', 'tma', 'practical', 'online_classes'];

const EXCEL_COL_WIDTHS_STORAGE_KEY = 'vp_excel_col_widths_v1';

const DEFAULT_FIT_COL_WIDTHS: Record<string, number> = {
  serialNumber: 42,
  studentName: 164,
  mobile: 138,
  tma: 80,
  practical: 84,
  classes: 80,
  totalFee: 72,
  paidAmount: 72,
  pendingAmount: 72,
  tmaFee: 64,
  examFee: 66,
  feeStatus: 60,
  actions: 116,
};

const DEFAULT_WIDE_COL_WIDTHS: Record<string, number> = {
  serialNumber: 54,
  studentName: 220,
  mobile: 175,
  tma: 108,
  practical: 112,
  classes: 130,
  totalFee: 96,
  paidAmount: 96,
  pendingAmount: 96,
  tmaFee: 86,
  examFee: 86,
  feeStatus: 86,
  actions: 140,
};

interface CoreExcelColumnMeta {
  key: string;
  fitLabel: string;
  wideLabel: string;
  exportLabel: string;
  isFee?: boolean;
  sortKey?: SortKey;
  align?: 'left' | 'right' | 'center';
}

const CORE_EXCEL_COLUMNS: CoreExcelColumnMeta[] = [
  { key: 'serialNumber', fitLabel: 'S.No', wideLabel: 'S.No', exportLabel: 'S.No', sortKey: 'serialNumber', align: 'left' },
  { key: 'studentName', fitLabel: 'Student Name', wideLabel: 'Student Name', exportLabel: 'Student Name', sortKey: 'studentName', align: 'left' },
  { key: 'mobile', fitLabel: 'Mobile · Call/WA', wideLabel: 'Mobile No (Call / WhatsApp)', exportLabel: 'Mobile No', align: 'left' },
  { key: 'tma', fitLabel: 'TMA', wideLabel: 'TMA', exportLabel: 'TMA', sortKey: 'tmaStatus', align: 'left' },
  { key: 'practical', fitLabel: 'Practical', wideLabel: 'Practical', exportLabel: 'Practical', sortKey: 'practicalStatus', align: 'left' },
  { key: 'classes', fitLabel: 'Classes', wideLabel: 'Attendance Live Classes', exportLabel: 'Attendance (Live Classes)', sortKey: 'classAttendanceStatus', align: 'left' },
  { key: 'totalFee', fitLabel: 'Total ₹', wideLabel: 'Total Fee (₹)', exportLabel: 'Total Fee', isFee: true, align: 'right' },
  { key: 'paidAmount', fitLabel: 'Paid ₹', wideLabel: 'Paid Jama (₹)', exportLabel: 'Paid (Jama)', isFee: true, align: 'right' },
  { key: 'pendingAmount', fitLabel: 'Baki ₹', wideLabel: 'Pending Baki (₹)', exportLabel: 'Pending (Baki)', isFee: true, align: 'right' },
  { key: 'tmaFee', fitLabel: 'TMA ₹', wideLabel: 'TMA Fee (₹)', exportLabel: 'TMA Fee', isFee: true, align: 'right' },
  { key: 'examFee', fitLabel: 'Exam ₹', wideLabel: 'Exam Fee (₹)', exportLabel: 'Exam Fee', isFee: true, align: 'right' },
  { key: 'feeStatus', fitLabel: 'Fee', wideLabel: 'Fee Status', exportLabel: 'Fee Status', isFee: true, align: 'center' },
  { key: 'actions', fitLabel: 'Actions', wideLabel: 'Actions', exportLabel: 'Actions', align: 'center' },
];

const CORE_COLUMN_META_MAP: Record<string, CoreExcelColumnMeta> = Object.fromEntries(
  CORE_EXCEL_COLUMNS.map((c) => [c.key, c]),
);

function toExcelColName(index: number): string {
  let n = index;
  let result = '';
  while (n >= 0) {
    result = String.fromCharCode((n % 26) + 65) + result;
    n = Math.floor(n / 26) - 1;
  }
  return result;
}

function getExcelCellStyle(
  student: Student,
  fieldKey: string,
  isEditingRow: boolean,
): React.CSSProperties | undefined {
  if (isEditingRow) return undefined;
  const bg = student.cellColors?.[fieldKey] || student.rowColor;
  if (!bg) return undefined;
  return {
    backgroundColor: bg,
    color: getReadableTextColor(bg),
  };
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
  feeRecords = [],
  employees,
  editRequests = [],
  sheetConfigs = [],
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
  const [rowsPerPage, setRowsPerPage] = useState<number>(999999);
  const [fitScreenMode, setFitScreenMode] = useState<boolean>(true);
  const [fullScreenSheet, setFullScreenSheet] = useState<boolean>(false);

  const [selectedCell, setSelectedCell] = useState<{ coord: string; value: string }>({
    coord: 'A1',
    value: 'S.No — Database Security Master Sheet',
  });
  const [selectedStudentId, setSelectedStudentId] = useState<string | null>(null);

  // Inline Excel quick-add row state (supports top, exact middle index, or bottom insert)
  const [inlineInsertIndex, setInlineInsertIndex] = useState<number | null>(null);
  const showInlineRow = inlineInsertIndex !== null;
  const [inlineName, setInlineName] = useState('');
  const [inlineMobile, setInlineMobile] = useState('');
  const [inlineCentre, setInlineCentre] = useState<CentreId>(
    currentUser.role === 'super_admin' ? 'vp_lookerganj' : currentUser.centreId,
  );
  const [inlineTma, setInlineTma] = useState<TmaStatus>('Pending');
  const [inlinePractical, setInlinePractical] = useState<PracticalStatus>('Pending');
  const [inlineAttendance, setInlineAttendance] = useState<ClassAttendanceStatus>('Not Attending');
  const [inlineTotalFee, setInlineTotalFee] = useState('0');
  const [inlinePaidAmount, setInlinePaidAmount] = useState('0');
  const [inlineTmaFee, setInlineTmaFee] = useState('0');
  const [inlineExamFee, setInlineExamFee] = useState('0');
  const [inlineExtraColumns, setInlineExtraColumns] = useState<Record<string, string>>({});
  const [inlineSaving, setInlineSaving] = useState(false);

  // Excel row drag/move/shuffle state
  const [reorderMode, setReorderMode] = useState(false);
  const [reorderingBusy, setReorderingBusy] = useState(false);
  const [optimisticSerialMap, setOptimisticSerialMap] = useState<Record<string, number> | null>(null);
  const [draggedStudentId, setDraggedStudentId] = useState<string | null>(null);
  const [dragArmStudentId, setDragArmStudentId] = useState<string | null>(null);
  const [dragOverState, setDragOverState] = useState<{ studentId: string; position: 'above' | 'below' } | null>(null);
  const [moveTargetInput, setMoveTargetInput] = useState('');
  const [showShuffleConfirm, setShowShuffleConfirm] = useState(false);

  // Excel Columns & Headings management state
  const [editingHeaderKey, setEditingHeaderKey] = useState<string | null>(null);
  const [editingHeaderValue, setEditingHeaderValue] = useState('');
  const [columnBusy, setColumnBusy] = useState(false);
  const [showAddColumnModal, setShowAddColumnModal] = useState(false);
  const [newColName, setNewColName] = useState('');
  const [newColDefaultValue, setNewColDefaultValue] = useState('');
  const [addColToAllCentres, setAddColToAllCentres] = useState<boolean>(true);
  const [showColumnManagerModal, setShowColumnManagerModal] = useState(false);
  const [managerDraftLabels, setManagerDraftLabels] = useState<Record<string, string>>({});
  const [selectedManagerCols, setSelectedManagerCols] = useState<Set<string>>(new Set());
  const [deletingColumnTargets, setDeletingColumnTargets] = useState<Array<{
    colKey: string;
    label: string;
    isExtra: boolean;
    extraName?: string;
    affectedCount: number;
  }> | null>(null);

  useEffect(() => {
    setOptimisticSerialMap(null);
  }, [students]);

  const [viewingStudent, setViewingStudent] = useState<Student | null>(null);
  const [editingStudent, setEditingStudent] = useState<Student | null>(null);
  const [showFormModal, setShowFormModal] = useState(false);
  const [showBulkImport, setShowBulkImport] = useState(false);
  const [deletingStudent, setDeletingStudent] = useState<Student | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [showDeleteAllConfirm, setShowDeleteAllConfirm] = useState(false);
  const [deleteAllBusy, setDeleteAllBusy] = useState(false);
  const [deleteProgress, setDeleteProgress] = useState<{ done: number; total: number } | null>(null);

  // Inline editing state for existing rows (role-scoped Excel cell/row editing)
  const [inlineEditId, setInlineEditId] = useState<string | null>(null);
  const [inlineFocusField, setInlineFocusField] = useState<InlineEditFocusField | null>(null);
  const [inlineEditDraft, setInlineEditDraft] = useState<{
    studentName: string;
    mobileNumber: string;
    centreId: CentreId;
    tmaStatus: TmaStatus;
    practicalStatus: PracticalStatus;
    classAttendanceStatus: ClassAttendanceStatus;
    totalFee: string;
    paidAmount: string;
    tmaFee: string;
    examFee: string;
    extraColumns: Record<string, string>;
  } | null>(null);
  const [inlineEditSaving, setInlineEditSaving] = useState(false);

  // Resizable Excel column widths ("chota / bada" via drag handle or double-click border)
  const [customColWidths, setCustomColWidths] = useState<Record<string, number>>(() => {
    try {
      const saved = window.localStorage.getItem(EXCEL_COL_WIDTHS_STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed && typeof parsed === 'object') {
          const valid: Record<string, number> = {};
          for (const [k, v] of Object.entries(parsed)) {
            if (typeof v === 'number' && Number.isFinite(v) && v >= 38 && v <= 520) {
              valid[k] = Math.round(v);
            }
          }
          return valid;
        }
      }
    } catch {
      // ignore storage errors
    }
    return {};
  });

  useEffect(() => {
    try {
      if (Object.keys(customColWidths).length === 0) {
        window.localStorage.removeItem(EXCEL_COL_WIDTHS_STORAGE_KEY);
      } else {
        window.localStorage.setItem(EXCEL_COL_WIDTHS_STORAGE_KEY, JSON.stringify(customColWidths));
      }
    } catch {
      // ignore storage errors
    }
  }, [customColWidths]);

  const resizeDragRef = useRef<{
    colKey: string;
    startX: number;
    startWidth: number;
  } | null>(null);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      const active = resizeDragRef.current;
      if (!active) return;
      const minW = active.colKey === 'actions' ? 96 : 40;
      const nextWidth = Math.max(minW, Math.min(520, Math.round(active.startWidth + (e.clientX - active.startX))));
      setCustomColWidths((prev) => ({ ...prev, [active.colKey]: nextWidth }));
    };
    const handleMouseUp = () => {
      if (resizeDragRef.current) {
        resizeDragRef.current = null;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
    };
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

  // Per-department Permission Request & Centre Head Review State
  const [permissionStudent, setPermissionStudent] = useState<Student | null>(null);
  const [permissionReason, setPermissionReason] = useState('');
  const [permissionError, setPermissionError] = useState<string | null>(null);
  const [permissionBusy, setPermissionBusy] = useState(false);
  const [reviewNotes, setReviewNotes] = useState<Record<string, string>>({});
  const [reviewBusyId, setReviewBusyId] = useState<string | null>(null);

  useEffect(() => {
    if (!fullScreenSheet) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        e.key === 'Escape' &&
        !showFormModal &&
        !showBulkImport &&
        !viewingStudent &&
        !deletingStudent &&
        !showDeleteAllConfirm &&
        !permissionStudent
      ) {
        setFullScreenSheet(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    fullScreenSheet,
    showFormModal,
    showBulkImport,
    viewingStudent,
    deletingStudent,
    showDeleteAllConfirm,
    permissionStudent,
  ]);

  const effectiveCentre =
    currentUser.role === 'super_admin'
      ? selectedCentreFilter !== 'all'
        ? selectedCentreFilter
        : centreFilter
      : currentUser.centreId;

  const combinedSearch = (localSearch || globalSearch).trim().toLowerCase();

  const effectiveStudents = useMemo(() => {
    if (!optimisticSerialMap) return students;
    return students.map((s) =>
      optimisticSerialMap[s.studentId] !== undefined
        ? { ...s, serialNumber: optimisticSerialMap[s.studentId] }
        : s,
    );
  }, [students, optimisticSerialMap]);

  const displaySerialMap = useMemo(
    () => buildContextualSerialMap(effectiveStudents, effectiveCentre),
    [effectiveStudents, effectiveCentre],
  );

  const filtered = useMemo(() => {
    return effectiveStudents
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
  }, [effectiveStudents, effectiveCentre, tmaFilter, combinedSearch, sortKey, sortAsc, displaySerialMap]);

  const baseExtractedExtraHeaders = useMemo(
    () => extractJaunpurHeadingAndBlankColumns(students, sheetConfigs),
    [students, sheetConfigs],
  );

  const globalSheetConfig = useMemo(
    () => sheetConfigs.find((c) => c.configId === 'global'),
    [sheetConfigs],
  );

  const jaunpurSheetConfig = useMemo(
    () => sheetConfigs.find((c) => c.configId === 'xis_jaunpur'),
    [sheetConfigs],
  );

  const centreSheetConfig = useMemo(
    () =>
      effectiveCentre !== 'all'
        ? sheetConfigs.find((c) => c.configId === effectiveCentre)
        : undefined,
    [sheetConfigs, effectiveCentre],
  );

  const activeSheetConfig = useMemo(() => {
    const mergedLabels: Record<string, string> = {
      ...(globalSheetConfig?.headerLabels || {}),
      ...(centreSheetConfig?.headerLabels || {}),
    };
    const deletedRaw = [
      ...(globalSheetConfig?.deletedExtraColumns || []),
      ...(centreSheetConfig?.deletedExtraColumns || []),
    ];
    const deletedSet = new Set<string>(deletedRaw);
    const deletedLowerSet = new Set<string>(
      deletedRaw.map((k) => String(k || '').trim().toLowerCase()).filter(Boolean),
    );
    const deletedTokenSet = new Set<string>(
      deletedRaw.map((k) => canonicalCommonHeaderToken(k)).filter(Boolean),
    );
    const customCols: string[] = [];
    const customSeen = new Set<string>();
    const addCustom = (raw: string) => {
      const clean = String(raw || '').trim();
      if (!clean) return;
      const lower = clean.toLowerCase();
      const tok = canonicalCommonHeaderToken(clean);
      if (deletedLowerSet.has(lower) || (tok && deletedTokenSet.has(tok))) return;
      if (!customSeen.has(lower)) {
        customSeen.add(lower);
        customCols.push(clean);
      }
    };
    (centreSheetConfig?.customColumns || []).forEach(addCustom);
    (globalSheetConfig?.customColumns || []).forEach(addCustom);
    (jaunpurSheetConfig?.customColumns || []).forEach(addCustom);

    const hiddenCoreColumns = centreSheetConfig
      ? centreSheetConfig.hiddenCoreColumns || []
      : globalSheetConfig?.hiddenCoreColumns || [];

    return {
      headerLabels: mergedLabels,
      customColumns: customCols,
      hiddenCoreColumns,
      deletedExtraColumns: Array.from(deletedSet),
    };
  }, [globalSheetConfig, jaunpurSheetConfig, centreSheetConfig]);

  const hiddenCoreSet = useMemo(
    () => new Set(activeSheetConfig.hiddenCoreColumns),
    [activeSheetConfig.hiddenCoreColumns],
  );

  const extraColumnKeys = useMemo(
    () => mergeExtraColumnsWithConfig(baseExtractedExtraHeaders, activeSheetConfig),
    [baseExtractedExtraHeaders, activeSheetConfig],
  );

  const getHeaderLabel = useCallback(
    (colKey: string, mode: 'display' | 'export' = 'display'): string => {
      const override = activeSheetConfig.headerLabels?.[colKey]?.trim();
      if (override) return override;
      if (colKey.startsWith('extra:')) {
        return colKey.slice(6);
      }
      const meta = CORE_COLUMN_META_MAP[colKey];
      if (!meta) return colKey;
      if (mode === 'export') return meta.exportLabel;
      return fitScreenMode ? meta.fitLabel : meta.wideLabel;
    },
    [activeSheetConfig.headerLabels, fitScreenMode],
  );

  const getColWidth = useCallback(
    (colKey: string): number => {
      if (customColWidths[colKey] !== undefined) return customColWidths[colKey];
      const label = getHeaderLabel(colKey);
      if (colKey.startsWith('extra:')) {
        return computeAutoExcelColumnWidth(label, colKey, fitScreenMode);
      }
      const baseDefault = fitScreenMode
        ? DEFAULT_FIT_COL_WIDTHS[colKey] ?? 96
        : DEFAULT_WIDE_COL_WIDTHS[colKey] ?? 135;
      if (activeSheetConfig.headerLabels?.[colKey]?.trim()) {
        return Math.max(baseDefault, computeAutoExcelColumnWidth(label, colKey, fitScreenMode));
      }
      return baseDefault;
    },
    [customColWidths, fitScreenMode, getHeaderLabel, activeSheetConfig.headerLabels],
  );

  const handleStartColResize = (e: React.MouseEvent, colKey: string) => {
    e.preventDefault();
    e.stopPropagation();
    resizeDragRef.current = {
      colKey,
      startX: e.clientX,
      startWidth: getColWidth(colKey),
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  const handleToggleColAutoSize = (e: React.MouseEvent, colKey: string) => {
    e.preventDefault();
    e.stopPropagation();
    const base =
      colKey.startsWith('extra:')
        ? computeAutoExcelColumnWidth(getHeaderLabel(colKey), colKey, fitScreenMode)
        : (fitScreenMode ? DEFAULT_FIT_COL_WIDTHS[colKey] : DEFAULT_WIDE_COL_WIDTHS[colKey]) ?? 100;
    const current = getColWidth(colKey);
    const expanded = colKey === 'studentName' ? 260 : Math.min(420, Math.round(base * 1.45));
    const compact = colKey === 'actions' ? 110 : Math.max(42, Math.round(base * 0.85));
    const nextWidth = Math.abs(current - expanded) < 12 ? compact : current > base + 6 ? base : expanded;
    setCustomColWidths((prev) => ({ ...prev, [colKey]: nextWidth }));
  };

  const showFeeColumns =
    currentUser.role !== 'employee' || currentUser.department === 'fee_recovery';

  const isCoreColVisible = useCallback(
    (colKey: string): boolean => {
      const meta = CORE_COLUMN_META_MAP[colKey];
      if (!meta) return true;
      if (meta.isFee && !showFeeColumns) return false;
      return !hiddenCoreSet.has(colKey);
    },
    [hiddenCoreSet, showFeeColumns],
  );

  const feeByStudentMap = useMemo(() => {
    const map = new Map<string, FeeRecoveryRecord>();
    feeRecords.forEach((f) => map.set(f.studentId, f));
    return map;
  }, [feeRecords]);

  const studentFeeSummaryMap = useMemo(() => {
    const map = new Map<
      string,
      {
        totalFee: number;
        paidAmount: number;
        pendingAmount: number;
        tmaFee: number;
        examFee: number;
        recoveryStatus: RecoveryStatus;
        hasFeeData: boolean;
        hasTmaFee: boolean;
        hasExamFee: boolean;
      }
    >();
    for (const s of filtered) {
      const rec = feeByStudentMap.get(s.studentId);
      const summary = resolveStudentFeeSummary(s, rec);
      map.set(s.studentId, {
        totalFee: summary.totalFee,
        paidAmount: summary.paidAmount,
        pendingAmount: summary.pendingAmount,
        tmaFee: summary.tmaFee,
        examFee: summary.examFee,
        recoveryStatus: summary.recoveryStatus,
        hasFeeData: summary.hasFeeData,
        hasTmaFee: summary.hasTmaFee,
        hasExamFee: summary.hasExamFee,
      });
    }
    return map;
  }, [filtered, feeByStudentMap]);

  const sheetFeeTotals = useMemo(() => {
    let totalFee = 0;
    let totalPaid = 0;
    let totalPending = 0;
    let totalTmaFee = 0;
    let totalExamFee = 0;
    let paidStudents = 0;
    let partialStudents = 0;
    let pendingStudents = 0;
    for (const s of filtered) {
      const f = studentFeeSummaryMap.get(s.studentId);
      if (!f || !f.hasFeeData) continue;
      totalFee += f.totalFee;
      totalPaid += f.paidAmount;
      totalPending += f.pendingAmount;
      totalTmaFee += f.tmaFee;
      totalExamFee += f.examFee;
      if (f.recoveryStatus === 'Paid') paidStudents++;
      else if (f.recoveryStatus === 'Partial') partialStudents++;
      else pendingStudents++;
    }
    const collectionRatePct = totalFee > 0 ? Math.round((totalPaid / totalFee) * 100) : 0;
    return {
      totalFee,
      totalPaid,
      totalPending,
      totalTmaFee,
      totalExamFee,
      paidStudents,
      partialStudents,
      pendingStudents,
      collectionRatePct,
    };
  }, [filtered, studentFeeSummaryMap]);

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
  const canReorderRows = isSuperAdmin || isCentreHead;
  const canManageColumns = isSuperAdmin || isCentreHead;
  const isSerialSortedAsc = sortKey === 'serialNumber' && sortAsc;
  const isReorderReady = canReorderRows && !combinedSearch && tmaFilter === 'all' && filtered.length >= 2;
  const canEmployeeRequestPermission =
    isEmployee && EDITABLE_STUDENT_DEPTS.includes(currentUser.department);

  const targetConfigId =
    currentUser.role === 'centre_head'
      ? currentUser.centreId
      : effectiveCentre !== 'all'
        ? effectiveCentre
        : 'global';

  const saveScopeLabel =
    targetConfigId === 'global'
      ? 'All Centres (Master Global Sheet)'
      : `${CENTRE_MAP[targetConfigId as CentreId]?.name || targetConfigId}`;

  const columnMutationStudents = useMemo(
    () =>
      isSuperAdmin && effectiveCentre === 'all'
        ? students
        : students.filter(
            (s) => s.centreId === (isSuperAdmin ? effectiveCentre : currentUser.centreId),
          ),
    [students, isSuperAdmin, effectiveCentre, currentUser.centreId],
  );

  const selectedFilteredIndex = useMemo(
    () => (selectedStudentId ? filtered.findIndex((s) => s.studentId === selectedStudentId) : -1),
    [filtered, selectedStudentId],
  );
  const selectedStudent = selectedFilteredIndex >= 0 ? filtered[selectedFilteredIndex] : null;

  const pendingRequests = useMemo(() => {
    return editRequests.filter(
      (r) =>
        r.status === 'Pending' &&
        (effectiveCentre === 'all' ? true : r.centreId === effectiveCentre),
    );
  }, [editRequests, effectiveCentre]);

  const nextSerialPreview = useMemo(() => {
    if (inlineInsertIndex !== null && inlineInsertIndex < filtered.length) {
      return inlineInsertIndex + 1;
    }
    return displaySerialMap.size + 1;
  }, [displaySerialMap, inlineInsertIndex, filtered.length]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortAsc((p) => !p);
    else {
      setSortKey(key);
      setSortAsc(true);
    }
  };

  const handleSelectRowCell = (student: Student, coord: string, value: string, rowNum: number) => {
    setSelectedCell({ coord, value });
    setSelectedStudentId(student.studentId);
    setMoveTargetInput(String(rowNum));
  };

  const handleOpenInlineRowAt = (insertIdx: number, anchorCentre?: CentreId) => {
    let targetIdx = Math.max(0, Math.min(insertIdx, filtered.length));
    if (!canReorderRows && targetIdx < filtered.length) {
      targetIdx = filtered.length;
    }
    if (targetIdx < filtered.length && (combinedSearch || tmaFilter !== 'all')) {
      onNotify(
        'Middle Insert Requires Full Order',
        'Search ya TMA filter clear karein taki row exact middle position par insert ho sake (abhi row end me add hogi).',
        'warning',
      );
      targetIdx = filtered.length;
    }
    if (targetIdx < filtered.length && (!isSerialSortedAsc)) {
      setSortKey('serialNumber');
      setSortAsc(true);
    }

    const defaultC =
      currentUser.role === 'super_admin'
        ? anchorCentre || (effectiveCentre === 'all' ? 'vp_lookerganj' : effectiveCentre)
        : currentUser.centreId;

    setInlineCentre(defaultC);
    setInlineName('');
    setInlineMobile('');
    setInlineTma('Pending');
    setInlinePractical('Pending');
    setInlineAttendance('Not Attending');
    setInlineTotalFee('0');
    setInlinePaidAmount('0');
    setInlineTmaFee('0');
    setInlineExamFee('0');
    setInlineExtraColumns({});
    setInlineInsertIndex(targetIdx);

    const posLabel =
      targetIdx >= filtered.length
        ? `End (Row #${filtered.length + 1})`
        : `Middle (Row #${targetIdx + 1})`;
    setSelectedCell({
      coord: `NEW#${targetIdx + 1}`,
      value: `Adding new Excel row at ${posLabel} — Enter to Save · Esc to Cancel`,
    });
  };

  const handleOpenInlineRow = () => {
    handleOpenInlineRowAt(filtered.length);
  };

  const applyReorderUpdates = async (
    updates: Array<{ studentId: string; serialNumber: number }>,
    actionReason: string,
    successTitle: string,
    successDesc: string,
  ) => {
    if (updates.length === 0) return;
    const optimisticNext: Record<string, number> = { ...(optimisticSerialMap || {}) };
    for (const u of updates) {
      optimisticNext[u.studentId] = u.serialNumber;
    }
    setOptimisticSerialMap(optimisticNext);
    setReorderingBusy(true);
    try {
      await updateStudentsSerialOrderBatch(updates, currentUser, actionReason);
      onNotify(successTitle, successDesc, 'success');
    } catch (err) {
      setOptimisticSerialMap(null);
      onNotify('Reorder Failed', err instanceof Error ? err.message : 'Unable to save new row order.', 'error');
    } finally {
      setReorderingBusy(false);
    }
  };

  const handleMoveFilteredRow = async (fromIdx: number, toIdx: number, reasonLabel?: string) => {
    if (!canReorderRows) return;
    if (combinedSearch || tmaFilter !== 'all') {
      onNotify(
        'Clear Filter to Reorder',
        'Rows ko bich me move ya shuffle karne ke liye pehle Search / TMA filter clear karein.',
        'warning',
      );
      return;
    }
    if (!isSerialSortedAsc) {
      setSortKey('serialNumber');
      setSortAsc(true);
      onNotify('Switched to S.No Order', 'Sheet S.No order me switch ho gayi hai — ab row move karein.', 'info');
      return;
    }
    const clampedTo = Math.max(0, Math.min(toIdx, filtered.length - 1));
    if (fromIdx < 0 || fromIdx >= filtered.length || fromIdx === clampedTo) return;
    const movedStudent = filtered[fromIdx];
    const updates = computeStudentReorderUpdates(filtered, fromIdx, clampedTo);
    if (updates.length === 0) return;

    setMoveTargetInput(String(clampedTo + 1));
    await applyReorderUpdates(
      updates,
      reasonLabel || `Moved ${movedStudent.studentName} from #${fromIdx + 1} to #${clampedTo + 1}`,
      'Excel Row Moved',
      `${movedStudent.studentName} ab Row #${clampedTo + 1} par shift ho gaya (${updates.length} rows synced).`,
    );
  };

  const handleJumpSelectedToPosition = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!selectedStudent || selectedFilteredIndex < 0) return;
    const targetNum = parseInt(moveTargetInput.trim(), 10);
    if (!Number.isFinite(targetNum) || targetNum < 1 || targetNum > filtered.length) {
      onNotify('Invalid Row Number', `Row # 1 se ${filtered.length} ke bich enter karein.`, 'warning');
      return;
    }
    await handleMoveFilteredRow(
      selectedFilteredIndex,
      targetNum - 1,
      `Jumped ${selectedStudent.studentName} to Row #${targetNum}`,
    );
  };

  const handleConfirmShuffleAll = async () => {
    if (!canReorderRows || !isReorderReady) {
      setShowShuffleConfirm(false);
      return;
    }
    if (!isSerialSortedAsc) {
      setSortKey('serialNumber');
      setSortAsc(true);
    }
    const updates = computeShuffledStudentOrderUpdates(filtered);
    setShowShuffleConfirm(false);
    if (updates.length === 0) return;
    await applyReorderUpdates(
      updates,
      `Shuffled ${filtered.length} Excel student rows`,
      'Excel Rows Shuffled',
      `${filtered.length} rows ka order successfully shuffle aur save ho gaya.`,
    );
  };

  const handleSaveInlineRow = async (keepAddingNext = false) => {
    if (inlineName.trim().length < 2) {
      onNotify('Invalid Name', 'Please enter full student name (at least 2 characters).', 'error');
      return;
    }
    const effectiveInlineMobile =
      inlineMobile.trim().length >= 7
        ? inlineMobile.trim()
        : !isCoreColVisible('mobile')
          ? 'Not Provided'
          : '';
    if (effectiveInlineMobile.length < 7) {
      onNotify('Invalid Mobile No', 'Please enter a valid mobile number.', 'error');
      return;
    }

    const insertIdx = inlineInsertIndex ?? filtered.length;
    setInlineSaving(true);
    try {
      const targetCentre = currentUser.role === 'super_admin' ? inlineCentre : currentUser.centreId;
      const { newSerialNumber, shiftUpdates } = computeInsertRowSerialPlan(
        canReorderRows && !combinedSearch && tmaFilter === 'all' ? filtered : effectiveStudents,
        canReorderRows && !combinedSearch && tmaFilter === 'all' ? insertIdx : effectiveStudents.length,
        effectiveStudents,
      );

      const code = CENTRE_MAP[targetCentre].code;
      const internalId = `${code}-${new Date().getFullYear()}-${String(newSerialNumber).padStart(4, '0')}-${Math.random()
        .toString(36)
        .slice(2, 5)
        .toUpperCase()}`;

      const dupMsg = await checkDuplicateStudent(
        internalId,
        effectiveInlineMobile === 'Not Provided' ? '' : effectiveInlineMobile,
        targetCentre,
      );
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

      if (shiftUpdates.length > 0 && canReorderRows) {
        const nextOptimistic: Record<string, number> = { ...(optimisticSerialMap || {}) };
        for (const u of shiftUpdates) {
          nextOptimistic[u.studentId] = u.serialNumber;
        }
        setOptimisticSerialMap(nextOptimistic);
        await updateStudentsSerialOrderBatch(
          shiftUpdates,
          currentUser,
          `Shifted ${shiftUpdates.length} rows for middle insert at #${insertIdx + 1}`,
        );
      }

      const parsedTmaFee = clampFeeNumber(inlineTmaFee);
      const parsedExamFee = clampFeeNumber(inlineExamFee);
      const parsedPaid = clampFeeNumber(inlinePaidAmount);
      const parsedTotal = Math.max(parsedPaid, clampFeeNumber(inlineTotalFee || 0));
      const cleanExtras: Record<string, string> = {};
      for (const [k, v] of Object.entries(inlineExtraColumns)) {
        const val = String(v ?? '').trim().slice(0, 300);
        if (val) cleanExtras[k.slice(0, 50)] = val;
      }

      await createStudentRecord(
        {
          serialNumber: newSerialNumber,
          studentId: internalId,
          studentName: inlineName.trim(),
          mobileNumber: effectiveInlineMobile,
          subject: '',
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
              : insertIdx < filtered.length
                ? `Inserted in Excel Row #${insertIdx + 1}`
                : 'Entered via Excel Grid',
          tmaFee: parsedTmaFee,
          examFee: parsedExamFee,
          ...(Object.keys(cleanExtras).length > 0 ? { extraColumns: cleanExtras } : {}),
        },
        currentUser,
        true,
        {
          totalFee: parsedTotal,
          paidAmount: parsedPaid,
          tmaFee: parsedTmaFee,
          examFee: parsedExamFee,
          createDepartmentSkeletons: currentUser.role !== 'employee',
        },
      );

      onNotify(
        currentUser.role === 'employee'
          ? 'Row Saved & Locked'
          : insertIdx < filtered.length
            ? `Row Inserted at #${insertIdx + 1}`
            : 'Student Added to Excel',
        currentUser.role === 'employee'
          ? `${inlineName.trim()} saved at Serial #${newSerialNumber}. Locked for employees — only Centre Head or authorized Super Admin can edit.`
          : insertIdx < filtered.length
            ? `${inlineName.trim()} exact Row #${insertIdx + 1} par add ho gaya (${shiftUpdates.length} rows shift hue).`
            : `${inlineName.trim()} added at Row #${filtered.length + 1}.`,
        'success',
      );

      setInlineName('');
      setInlineMobile('');
      setInlineTotalFee('0');
      setInlinePaidAmount('0');
      setInlineTmaFee('0');
      setInlineExamFee('0');
      setInlineExtraColumns({});
      if (keepAddingNext) {
        setInlineInsertIndex(Math.min(insertIdx + 1, filtered.length + 1));
      } else {
        setInlineInsertIndex(null);
      }
    } catch (err) {
      onNotify('Excel Save Error', err instanceof Error ? err.message : 'Unable to save row.', 'error');
    } finally {
      setInlineSaving(false);
    }
  };

  const attachInlineFocusRef = useCallback(
    (field: InlineEditFocusField) => (el: HTMLInputElement | HTMLSelectElement | null) => {
      if (!el || inlineFocusField !== field) return;
      requestAnimationFrame(() => {
        el.focus();
        if (el instanceof HTMLInputElement) {
          el.select();
        }
      });
      setInlineFocusField(null);
    },
    [inlineFocusField],
  );

  const handleStartInlineEdit = (s: Student, focusField?: InlineEditFocusField) => {
    if (!canUserEditStudentRow(s, currentUser)) return;
    const fee = studentFeeSummaryMap.get(s.studentId) ?? resolveStudentFeeSummary(s, feeByStudentMap.get(s.studentId));
    setInlineEditId(s.studentId);
    setInlineFocusField(focusField ?? 'studentName');
    setInlineEditDraft({
      studentName: s.studentName,
      mobileNumber: '',
      centreId: s.centreId,
      tmaStatus: s.tmaStatus,
      practicalStatus: s.practicalStatus,
      classAttendanceStatus: s.classAttendanceStatus,
      totalFee: String(fee.hasFeeData ? fee.totalFee : 0),
      paidAmount: String(fee.hasFeeData ? fee.paidAmount : 0),
      tmaFee: String(fee.tmaFee ?? 0),
      examFee: String(fee.examFee ?? 0),
      extraColumns: (() => {
        const mapped: Record<string, string> = { ...(s.extraColumns || {}) };
        for (const ek of extraColumnKeys) {
          if (mapped[ek] === undefined || !String(mapped[ek]).trim()) {
            const resolved = getStudentExtraColumnValue(s.extraColumns, ek);
            if (resolved) mapped[ek] = resolved;
          }
        }
        return mapped;
      })(),
    });
    setSelectedCell({
      coord: `EDIT:${s.studentName.slice(0, 18)}`,
      value: 'Inline editing active — Press Enter to Save or Esc to Cancel',
    });
  };

  const handleCancelInlineEdit = () => {
    setInlineEditId(null);
    setInlineEditDraft(null);
    setInlineFocusField(null);
  };

  const handleSaveInlineEdit = async (student: Student) => {
    if (!inlineEditDraft) return;
    const cleanName = inlineEditDraft.studentName.trim();
    const typedMobile = inlineEditDraft.mobileNumber.trim();
    const effectiveMobile = typedMobile === '' ? student.mobileNumber : typedMobile;
    if ((isSuperAdmin || isCentreHead || currentUser.department === 'admission') && cleanName.length < 2) {
      onNotify('Invalid Name', 'Student name must be at least 2 characters.', 'error');
      return;
    }
    if (
      (isSuperAdmin || isCentreHead || currentUser.department === 'admission') &&
      typedMobile !== '' &&
      typedMobile.length < 7
    ) {
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

      const nextTmaFee = clampFeeNumber(inlineEditDraft.tmaFee);
      const nextExamFee = clampFeeNumber(inlineEditDraft.examFee);
      const nextPaid = clampFeeNumber(inlineEditDraft.paidAmount);
      const nextTotal = Math.max(nextPaid, clampFeeNumber(inlineEditDraft.totalFee));
      const nextPending = Math.max(0, nextTotal - nextPaid);

      const updates: Partial<Student> = {};
      if (isSuperAdmin || isCentreHead) {
        updates.studentName = cleanName;
        if (typedMobile !== '') {
          updates.mobileNumber = effectiveMobile;
        }
        updates.tmaStatus = inlineEditDraft.tmaStatus;
        updates.practicalStatus = inlineEditDraft.practicalStatus;
        updates.classAttendanceStatus = inlineEditDraft.classAttendanceStatus;
        updates.tmaFee = nextTmaFee;
        updates.examFee = nextExamFee;
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
          if (typedMobile !== '') {
            updates.mobileNumber = effectiveMobile;
          }
          updates.tmaFee = nextTmaFee;
          updates.examFee = nextExamFee;
        }
      }

      await updateStudentRecord(student.studentId, updates, currentUser, targetCentre, true);

      if (isSuperAdmin || isCentreHead) {
        const existingFeeRec = feeByStudentMap.get(student.studentId);
        const recoveryStatus: RecoveryStatus =
          nextTotal > 0 && nextPending === 0 ? 'Paid' : nextPaid > 0 && nextPending > 0 ? 'Partial' : 'Pending';
        const todayIso = new Date().toISOString().slice(0, 10);
        await upsertFeeRecoveryRecord(
          {
            studentId: student.studentId,
            studentName: cleanName,
            mobileNumber: effectiveMobile,
            centreId: targetCentre,
            recoveryStatus,
            followUpStatus:
              recoveryStatus === 'Paid'
                ? 'Closed'
                : existingFeeRec?.followUpStatus || (recoveryStatus === 'Partial' ? 'Promise to Pay' : 'Scheduled'),
            totalFee: nextTotal,
            paidAmount: nextPaid,
            pendingAmount: nextPending,
            tmaFee: nextTmaFee,
            examFee: nextExamFee,
            assignedEmployeeUid: existingFeeRec?.assignedEmployeeUid || student.assignedEmployeeUid || currentUser.uid,
            assignedEmployeeName:
              existingFeeRec?.assignedEmployeeName || student.assignedEmployeeName || currentUser.fullName,
            followUpNotes: existingFeeRec?.followUpNotes || 'Updated directly in Student Excel sheet.',
            lastContactDate: existingFeeRec?.lastContactDate || todayIso,
            nextFollowUpDate: existingFeeRec?.nextFollowUpDate || todayIso,
          },
          currentUser,
          true,
        );
      }

      onNotify(
        isEmployee ? 'Department Saved & Locked' : 'Excel Row Updated',
        isEmployee
          ? `${DEPARTMENT_LABELS[currentUser.department] || currentUser.department} updated for ${student.studentName}.`
          : `Updated ${cleanName} & fee schedule in live Excel sheet.`,
        'success',
      );
      setInlineEditId(null);
      setInlineEditDraft(null);
      setInlineFocusField(null);
    } catch (err) {
      onNotify('Update Failed', err instanceof Error ? err.message : 'Unable to save inline changes.', 'error');
    } finally {
      setInlineEditSaving(false);
    }
  };

  const handleInlineEditKeyDown = (
    e: React.KeyboardEvent<HTMLInputElement | HTMLSelectElement>,
    student: Student,
  ) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (!inlineEditSaving) {
        void handleSaveInlineEdit(student);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      handleCancelInlineEdit();
    }
  };

  const buildEditableConfigBase = useCallback(
    (configId: string) => {
      const existingDoc = sheetConfigs.find((c) => c.configId === configId);
      const source = existingDoc ?? activeSheetConfig;
      return {
        headerLabels: { ...(source.headerLabels || {}) },
        customColumns: [...(source.customColumns || [])],
        hiddenCoreColumns: [...(source.hiddenCoreColumns || [])],
        deletedExtraColumns: [...(source.deletedExtraColumns || [])],
      };
    },
    [sheetConfigs, activeSheetConfig],
  );

  const handleOpenAddColumnModal = () => {
    if (!canManageColumns) return;
    if (extraColumnKeys.length >= 35) {
      onNotify(
        'Max Extra Columns Reached (35)',
        'Excel sheet me maximum 35 custom columns allowed hain. Naya column jodne ke liye pehle koi purana unused column delete karein.',
        'warning',
      );
      return;
    }
    setNewColName('');
    setNewColDefaultValue('');
    setAddColToAllCentres(true);
    setShowAddColumnModal(true);
  };

  const handleOpenColumnManager = () => {
    const initialDrafts: Record<string, string> = {};
    for (const c of CORE_EXCEL_COLUMNS) {
      initialDrafts[c.key] = activeSheetConfig.headerLabels?.[c.key] || '';
    }
    for (const ek of extraColumnKeys) {
      initialDrafts[`extra:${ek}`] = ek;
    }
    setManagerDraftLabels(initialDrafts);
    setSelectedManagerCols(new Set());
    setShowColumnManagerModal(true);
  };

  const handleConfirmAddColumn = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canManageColumns || columnBusy) return;
    const cleanName = newColName.trim().slice(0, 50);
    if (!cleanName) {
      onNotify('Column Name Required', 'Please enter a valid column heading name.', 'error');
      return;
    }
    if (extraColumnKeys.some((k) => k.toLowerCase() === cleanName.toLowerCase())) {
      onNotify('Column Already Exists', `"${cleanName}" column is already present in this sheet.`, 'warning');
      return;
    }
    if (extraColumnKeys.length >= 35) {
      onNotify('Column Limit Reached', 'Maximum 35 custom columns are supported per sheet.', 'warning');
      return;
    }

    const effectiveSaveConfigId = isSuperAdmin && addColToAllCentres ? 'global' : targetConfigId;
    const effectiveScopeLabel =
      effectiveSaveConfigId === 'global' ? 'All Centres (Master Global Sheet)' : saveScopeLabel;
    const targetRowsForDefault =
      effectiveSaveConfigId === 'global' ? students : columnMutationStudents;

    setColumnBusy(true);
    try {
      const nextConfig = buildEditableConfigBase(effectiveSaveConfigId);
      nextConfig.customColumns = [
        ...nextConfig.customColumns.filter((k) => k.toLowerCase() !== cleanName.toLowerCase()),
        cleanName,
      ];
      nextConfig.deletedExtraColumns = nextConfig.deletedExtraColumns.filter(
        (k) => k.toLowerCase() !== cleanName.toLowerCase(),
      );

      await saveExcelSheetConfig(
        effectiveSaveConfigId,
        nextConfig,
        currentUser,
        `Added custom Excel column "${cleanName}" (${effectiveScopeLabel})`,
      );

      if (
        isSuperAdmin &&
        effectiveSaveConfigId === 'global' &&
        centreSheetConfig?.deletedExtraColumns?.some(
          (k) => k.toLowerCase() === cleanName.toLowerCase(),
        )
      ) {
        const cleanCentre = buildEditableConfigBase(centreSheetConfig.configId);
        cleanCentre.deletedExtraColumns = cleanCentre.deletedExtraColumns.filter(
          (k) => k.toLowerCase() !== cleanName.toLowerCase(),
        );
        await saveExcelSheetConfig(
          centreSheetConfig.configId,
          cleanCentre,
          currentUser,
          `Unmasked global column "${cleanName}" on ${centreSheetConfig.configId}`,
        );
      }

      let updatedCount = 0;
      const defaultVal = newColDefaultValue.trim().slice(0, 300);
      if (defaultVal && targetRowsForDefault.length > 0) {
        const batchUpdates = computeAddExtraColumnDefaultUpdates(
          targetRowsForDefault,
          cleanName,
          defaultVal,
        );
        if (batchUpdates.length > 0) {
          updatedCount = await batchUpdateStudentExtraColumns(
            batchUpdates,
            currentUser,
            `Backfilled "${cleanName}" = "${defaultVal}"`,
          );
        }
      }

      setShowAddColumnModal(false);
      setNewColName('');
      setNewColDefaultValue('');
      setSelectedCell({
        coord: 'NEW COL',
        value: `Added Column: ${cleanName}${updatedCount > 0 ? ` (${updatedCount} rows filled)` : ''}`,
      });
      onNotify(
        'Column Added to Excel',
        updatedCount > 0
          ? `"${cleanName}" column add ho gaya aur ${updatedCount} students me "${defaultVal}" fill ho gaya.`
          : `"${cleanName}" column add ho gaya! Ab aap kisi bhi row par double-click karke values bhar sakte hain.`,
        'success',
      );
    } catch (err) {
      onNotify('Add Column Failed', err instanceof Error ? err.message : 'Unable to add column.', 'error');
    } finally {
      setColumnBusy(false);
    }
  };

  const handleRenameColumnHeading = async (colKey: string, nextTitleRaw: string) => {
    if (!canManageColumns || columnBusy) return;
    const cleanNew = nextTitleRaw.trim().slice(0, colKey.startsWith('extra:') ? 50 : 60);

    if (colKey.startsWith('extra:')) {
      const oldKey = colKey.slice(6);
      if (!cleanNew || cleanNew === oldKey) {
        setEditingHeaderKey(null);
        return;
      }
      if (extraColumnKeys.some((k) => k !== oldKey && k.toLowerCase() === cleanNew.toLowerCase())) {
        onNotify(
          'Duplicate Column Heading',
          `"${cleanNew}" naam ka ek aur column pehle se maujood hai. Alag heading naam dein.`,
          'warning',
        );
        return;
      }

      setColumnBusy(true);
      try {
        const nextConfig = buildEditableConfigBase(targetConfigId);
        const oldIdx = nextConfig.customColumns.findIndex((k) => k === oldKey);
        if (oldIdx >= 0) {
          nextConfig.customColumns[oldIdx] = cleanNew;
        } else {
          // Preserve visual column order if column originated from uploaded Excel data
          const visualList = extraColumnKeys.map((k) => (k === oldKey ? cleanNew : k));
          nextConfig.customColumns = visualList.slice(0, 35);
        }
        nextConfig.deletedExtraColumns = Array.from(
          new Set([
            ...nextConfig.deletedExtraColumns.filter((k) => k.toLowerCase() !== cleanNew.toLowerCase()),
            oldKey,
          ]),
        );
        delete nextConfig.headerLabels[colKey];

        await saveExcelSheetConfig(
          targetConfigId,
          nextConfig,
          currentUser,
          `Renamed Excel column "${oldKey}" to "${cleanNew}"`,
        );

        const rowUpdates = computeRenameExtraColumnStudentUpdates(
          columnMutationStudents,
          oldKey,
          cleanNew,
        );
        if (rowUpdates.length > 0) {
          await batchUpdateStudentExtraColumns(
            rowUpdates,
            currentUser,
            `Migrated column heading "${oldKey}" -> "${cleanNew}"`,
          );
        }

        // Migrate any saved width for renamed column
        setCustomColWidths((prev) => {
          if (prev[colKey] === undefined) return prev;
          const copy = { ...prev };
          copy[`extra:${cleanNew}`] = copy[colKey];
          delete copy[colKey];
          return copy;
        });

        setManagerDraftLabels((prev) => {
          const copy = { ...prev };
          delete copy[colKey];
          copy[`extra:${cleanNew}`] = cleanNew;
          return copy;
        });

        setEditingHeaderKey(null);
        onNotify(
          'Column Heading Updated',
          `"${oldKey}" ab "${cleanNew}" me rename aur sync ho gaya.`,
          'success',
        );
      } catch (err) {
        onNotify('Rename Failed', err instanceof Error ? err.message : 'Unable to rename column.', 'error');
      } finally {
        setColumnBusy(false);
      }
      return;
    }

    // Built-in core column heading rename
    const meta = CORE_COLUMN_META_MAP[colKey];
    const currentDisplay = getHeaderLabel(colKey);
    if (cleanNew === currentDisplay && activeSheetConfig.headerLabels[colKey]) {
      setEditingHeaderKey(null);
      return;
    }

    setColumnBusy(true);
    try {
      const nextConfig = buildEditableConfigBase(targetConfigId);
      const isRevertingToDefault =
        !cleanNew ||
        (meta &&
          (cleanNew === meta.fitLabel ||
            cleanNew === meta.wideLabel ||
            cleanNew === meta.exportLabel));

      if (isRevertingToDefault) {
        delete nextConfig.headerLabels[colKey];
      } else {
        nextConfig.headerLabels[colKey] = cleanNew;
      }

      await saveExcelSheetConfig(
        targetConfigId,
        nextConfig,
        currentUser,
        isRevertingToDefault
          ? `Reset heading for ${colKey} to default`
          : `Edited heading for ${colKey} to "${cleanNew}"`,
      );
      setEditingHeaderKey(null);
      onNotify(
        isRevertingToDefault ? 'Heading Reset to Default' : 'Heading Updated',
        isRevertingToDefault
          ? `"${meta?.wideLabel || colKey}" heading default par wapas aa gayi.`
          : `Heading updated to "${cleanNew}".`,
        'success',
      );
    } catch (err) {
      onNotify('Heading Update Failed', err instanceof Error ? err.message : 'Unable to save heading.', 'error');
    } finally {
      setColumnBusy(false);
    }
  };

  const handleToggleCoreColumnHidden = async (colKey: string, hide: boolean) => {
    if (!canManageColumns || columnBusy) return;
    const meta = CORE_COLUMN_META_MAP[colKey];
    if (!meta) return;

    setColumnBusy(true);
    try {
      const nextConfig = buildEditableConfigBase(targetConfigId);
      const nextHidden = new Set(nextConfig.hiddenCoreColumns);
      if (hide) nextHidden.add(colKey);
      else nextHidden.delete(colKey);
      nextConfig.hiddenCoreColumns = Array.from(nextHidden);

      await saveExcelSheetConfig(
        targetConfigId,
        nextConfig,
        currentUser,
        `${hide ? 'Deleted/Hidden' : 'Restored'} core column "${getHeaderLabel(colKey, 'export')}"`,
      );
      onNotify(
        hide ? 'Column Removed from Sheet' : 'Column Restored to Sheet',
        hide
          ? `"${getHeaderLabel(colKey, 'export')}" ab sheet se hat gaya hai (Columns Manager se kabhi bhi restore karein).`
          : `"${getHeaderLabel(colKey, 'export')}" wapas Excel sheet me dikhne laga hai.`,
        hide ? 'info' : 'success',
      );
    } catch (err) {
      onNotify('Column Update Failed', err instanceof Error ? err.message : 'Unable to update column.', 'error');
    } finally {
      setColumnBusy(false);
    }
  };

  const handleRestoreAllCoreAndHeadings = async () => {
    if (!canManageColumns || columnBusy) return;
    setColumnBusy(true);
    try {
      const nextConfig = buildEditableConfigBase(targetConfigId);
      nextConfig.headerLabels = {};
      nextConfig.hiddenCoreColumns = [];
      await saveExcelSheetConfig(
        targetConfigId,
        nextConfig,
        currentUser,
        `Reset all core headings and restored hidden columns (${saveScopeLabel})`,
      );
      const resetDrafts: Record<string, string> = {};
      for (const c of CORE_EXCEL_COLUMNS) resetDrafts[c.key] = '';
      for (const ek of extraColumnKeys) resetDrafts[`extra:${ek}`] = ek;
      setManagerDraftLabels(resetDrafts);
      onNotify(
        'Columns & Headings Restored',
        'Saare core columns wapas show ho gaye aur headings default par reset ho gayi.',
        'success',
      );
    } catch (err) {
      onNotify('Reset Failed', err instanceof Error ? err.message : 'Unable to reset columns.', 'error');
    } finally {
      setColumnBusy(false);
    }
  };

  const buildDeleteItemForKey = useCallback(
    (colKey: string) => {
      const isExtra = colKey.startsWith('extra:');
      if (isExtra) {
        const extraName = colKey.slice(6);
        const affectedCount = computeDeleteMultipleExtraColumnsStudentUpdates(
          columnMutationStudents,
          [extraName],
        ).length;
        return {
          colKey,
          label: extraName,
          isExtra: true,
          extraName,
          affectedCount,
        };
      }
      const meta = CORE_COLUMN_META_MAP[colKey];
      if (!meta) return null;
      return {
        colKey,
        label: getHeaderLabel(colKey, 'export'),
        isExtra: false,
        affectedCount: 0,
      };
    },
    [columnMutationStudents, getHeaderLabel],
  );

  const handleRequestDeleteColumn = (colKey: string) => {
    if (!canManageColumns) return;
    const item = buildDeleteItemForKey(colKey);
    if (!item) return;
    playDeleteWarningVoice();
    setDeletingColumnTargets([item]);
  };

  const handleRequestDeleteMultipleColumns = (colKeys: string[]) => {
    if (!canManageColumns || colKeys.length === 0) return;
    const items = colKeys
      .map((k) => buildDeleteItemForKey(k))
      .filter((x): x is NonNullable<typeof x> => x !== null);
    if (items.length === 0) return;
    playDeleteWarningVoice();
    setDeletingColumnTargets(items);
  };

  const handleConfirmDeleteColumn = async () => {
    if (!deletingColumnTargets || deletingColumnTargets.length === 0 || !canManageColumns || columnBusy) {
      return;
    }
    const targets = deletingColumnTargets;
    const extraTargets = targets.filter((t) => t.isExtra && t.extraName);
    const coreTargets = targets.filter((t) => !t.isExtra);

    setColumnBusy(true);
    try {
      const extraNames = extraTargets.map((t) => t.extraName!).filter(Boolean);
      const extraLower = new Set(extraNames.map((n) => n.toLowerCase()));
      const extraTokens = new Set(extraNames.map((n) => canonicalCommonHeaderToken(n)).filter(Boolean));
      const matchesDeletedExtra = (candidate: string): boolean => {
        const clean = String(candidate || '').trim();
        if (!clean) return false;
        if (extraLower.has(clean.toLowerCase())) return true;
        const tok = canonicalCommonHeaderToken(clean);
        return Boolean(tok && extraTokens.has(tok));
      };

      const mergeDeletedExtras = (existing: readonly string[], additions: readonly string[]) => {
        const out = [...existing];
        const seenLower = new Set(existing.map((k) => String(k || '').trim().toLowerCase()).filter(Boolean));
        for (const name of additions) {
          const clean = String(name || '').trim().slice(0, 50);
          if (!clean || seenLower.has(clean.toLowerCase())) continue;
          seenLower.add(clean.toLowerCase());
          out.push(clean);
        }
        return out.slice(-60);
      };

      // 1. Update primary targetConfigId (covers both extra + core column deletions in one write)
      const nextConfig = buildEditableConfigBase(targetConfigId);
      if (extraNames.length > 0) {
        nextConfig.customColumns = nextConfig.customColumns.filter((k) => !matchesDeletedExtra(k));
        nextConfig.deletedExtraColumns = mergeDeletedExtras(nextConfig.deletedExtraColumns, extraNames);
        for (const t of extraTargets) {
          delete nextConfig.headerLabels[t.colKey];
        }
      }
      if (coreTargets.length > 0) {
        const hiddenSet = new Set(nextConfig.hiddenCoreColumns);
        for (const c of coreTargets) {
          hiddenSet.add(c.colKey);
        }
        nextConfig.hiddenCoreColumns = Array.from(hiddenSet).slice(0, 20);
      }

      const deletedSummaryLabel =
        targets.length === 1
          ? `"${targets[0].label}"`
          : `${targets.length} columns (${targets.map((t) => t.label).slice(0, 3).join(', ')}${targets.length > 3 ? '...' : ''})`;

      await saveExcelSheetConfig(
        targetConfigId,
        nextConfig,
        currentUser,
        `Deleted Excel column(s): ${deletedSummaryLabel}`,
      );

      // 2. For Super Admin, clean shared/custom extra columns across global + any centre sheetConfig that holds them
      if (isSuperAdmin && extraNames.length > 0) {
        const additionalConfigIds = new Set<string>();
        if (targetConfigId !== 'global') {
          additionalConfigIds.add('global');
        }
        for (const cfg of sheetConfigs) {
          if (cfg.configId === targetConfigId || cfg.configId === 'global') continue;
          if ((cfg.customColumns || []).some((k) => matchesDeletedExtra(k))) {
            additionalConfigIds.add(cfg.configId);
          }
        }
        for (const cfgId of additionalConfigIds) {
          const base = buildEditableConfigBase(cfgId);
          base.customColumns = base.customColumns.filter((k) => !matchesDeletedExtra(k));
          base.deletedExtraColumns = mergeDeletedExtras(base.deletedExtraColumns, extraNames);
          for (const t of extraTargets) {
            delete base.headerLabels[t.colKey];
          }
          await saveExcelSheetConfig(
            cfgId,
            base,
            currentUser,
            `Synced deleted Excel column(s) ${deletedSummaryLabel} on ${cfgId}`,
          );
        }
      }

      // 3. Strip deleted extra column values & cell colors from affected student documents + local common header cache
      let strippedRowsCount = 0;
      if (extraNames.length > 0) {
        pruneStoredCommonBranchHeaders(extraNames);
        const studentsToClean =
          isSuperAdmin && (targetConfigId === 'global' || extraNames.some((n) => baseExtractedExtraHeaders.includes(n)))
            ? students
            : columnMutationStudents;
        const stripUpdates = computeDeleteMultipleExtraColumnsStudentUpdates(
          studentsToClean,
          extraNames,
        );
        if (stripUpdates.length > 0) {
          strippedRowsCount = await batchUpdateStudentExtraColumns(
            stripUpdates,
            currentUser,
            `Removed data for deleted column(s) ${deletedSummaryLabel}`,
          );
        }
      }

      setCustomColWidths((prev) => {
        const copy = { ...prev };
        let changed = false;
        for (const t of targets) {
          if (copy[t.colKey] !== undefined) {
            delete copy[t.colKey];
            changed = true;
          }
        }
        return changed ? copy : prev;
      });
      setSelectedManagerCols((prev) => {
        if (prev.size === 0) return prev;
        const next = new Set(prev);
        for (const t of targets) next.delete(t.colKey);
        return next;
      });

      setDeletingColumnTargets(null);
      onNotify(
        targets.length === 1 ? 'Column Deleted' : `${targets.length} Columns Deleted`,
        extraNames.length > 0
          ? `${deletedSummaryLabel} Excel sheet se delete ho gaya (${strippedRowsCount} student rows cleaned).`
          : `${deletedSummaryLabel} Excel sheet se remove ho gaya. Zarurat padne par "Columns & Headings" se restore kar sakte hain.`,
        'info',
      );
    } catch (err) {
      onNotify('Delete Column Failed', err instanceof Error ? err.message : 'Unable to delete column.', 'error');
    } finally {
      setColumnBusy(false);
    }
  };

  const handleStartHeaderEdit = (colKey: string) => {
    if (!canManageColumns) return;
    setEditingHeaderKey(colKey);
    setEditingHeaderValue(getHeaderLabel(colKey));
  };

  const handleExportCsv = () => {
    const includeCentreCol = effectiveCentre === 'all';
    const showSno = isCoreColVisible('serialNumber');
    const showName = isCoreColVisible('studentName');
    const headers = [
      ...(showSno ? [getHeaderLabel('serialNumber', 'export')] : []),
      ...(showName ? [getHeaderLabel('studentName', 'export')] : []),
      ...(isCoreColVisible('mobile') ? [getHeaderLabel('mobile', 'export')] : []),
      ...(includeCentreCol ? ['Centre'] : []),
      ...(isCoreColVisible('tma') ? [getHeaderLabel('tma', 'export')] : []),
      ...(isCoreColVisible('practical') ? [getHeaderLabel('practical', 'export')] : []),
      ...(isCoreColVisible('classes') ? [getHeaderLabel('classes', 'export')] : []),
      ...(isCoreColVisible('totalFee') ? [getHeaderLabel('totalFee', 'export')] : []),
      ...(isCoreColVisible('paidAmount') ? [getHeaderLabel('paidAmount', 'export')] : []),
      ...(isCoreColVisible('pendingAmount') ? [getHeaderLabel('pendingAmount', 'export')] : []),
      ...(isCoreColVisible('tmaFee') ? [getHeaderLabel('tmaFee', 'export')] : []),
      ...(isCoreColVisible('examFee') ? [getHeaderLabel('examFee', 'export')] : []),
      ...(isCoreColVisible('feeStatus') ? [getHeaderLabel('feeStatus', 'export')] : []),
      'Subjects',
      'Admission Date',
      ...extraColumnKeys,
    ];
    exportToCsv(
      `database-security-students-${effectiveCentre}.csv`,
      headers,
      filtered.map((s) => {
        const fee = studentFeeSummaryMap.get(s.studentId);
        return [
          ...(showSno ? [displaySerialMap.get(s.studentId) ?? s.serialNumber] : []),
          ...(showName ? [s.studentName] : []),
          ...(isCoreColVisible('mobile') ? [maskMobileNumber(s.mobileNumber)] : []),
          ...(includeCentreCol ? [s.centreName] : []),
          ...(isCoreColVisible('tma') ? [s.tmaStatus] : []),
          ...(isCoreColVisible('practical') ? [s.practicalStatus] : []),
          ...(isCoreColVisible('classes') ? [s.classAttendanceStatus] : []),
          ...(isCoreColVisible('totalFee') ? [fee?.totalFee ?? 0] : []),
          ...(isCoreColVisible('paidAmount') ? [fee?.paidAmount ?? 0] : []),
          ...(isCoreColVisible('pendingAmount') ? [fee?.pendingAmount ?? 0] : []),
          ...(isCoreColVisible('tmaFee') ? [fee?.tmaFee ?? 0] : []),
          ...(isCoreColVisible('examFee') ? [fee?.examFee ?? 0] : []),
          ...(isCoreColVisible('feeStatus') ? [fee?.recoveryStatus ?? 'Pending'] : []),
          s.subject,
          s.admissionDate,
          ...extraColumnKeys.map((k) => {
            const val = getStudentExtraColumnValue(s.extraColumns, k);
            return /mobile|phone|contact|whatsapp/i.test(k) ? maskMobileNumber(val) : val;
          }),
        ];
      }),
    );
    onNotify('Export Complete', `Exported ${filtered.length} student rows to CSV.`, 'success');
  };

  const handleExportExcel = () => {
    const includeCentreCol = effectiveCentre === 'all';
    const showSno = isCoreColVisible('serialNumber');
    const showName = isCoreColVisible('studentName');
    const headers = [
      ...(showSno ? [getHeaderLabel('serialNumber', 'export')] : []),
      ...(showName ? [getHeaderLabel('studentName', 'export')] : []),
      ...(isCoreColVisible('mobile') ? [getHeaderLabel('mobile', 'export')] : []),
      ...(includeCentreCol ? ['Centre'] : []),
      ...(isCoreColVisible('tma') ? [getHeaderLabel('tma', 'export')] : []),
      ...(isCoreColVisible('practical') ? [getHeaderLabel('practical', 'export')] : []),
      ...(isCoreColVisible('classes') ? [getHeaderLabel('classes', 'export')] : []),
      ...(isCoreColVisible('totalFee') ? [getHeaderLabel('totalFee', 'export')] : []),
      ...(isCoreColVisible('paidAmount') ? [getHeaderLabel('paidAmount', 'export')] : []),
      ...(isCoreColVisible('pendingAmount') ? [getHeaderLabel('pendingAmount', 'export')] : []),
      ...(isCoreColVisible('tmaFee') ? [getHeaderLabel('tmaFee', 'export')] : []),
      ...(isCoreColVisible('examFee') ? [getHeaderLabel('examFee', 'export')] : []),
      ...(isCoreColVisible('feeStatus') ? [getHeaderLabel('feeStatus', 'export')] : []),
      'Subjects',
      'Admission Date',
      ...extraColumnKeys,
    ];
    exportToExcel(
      `database-security-students-${effectiveCentre}.xlsx`,
      'Student Database',
      headers,
      filtered.map((s) => {
        const fee = studentFeeSummaryMap.get(s.studentId);
        return [
          ...(showSno ? [displaySerialMap.get(s.studentId) ?? s.serialNumber] : []),
          ...(showName ? [s.studentName] : []),
          ...(isCoreColVisible('mobile') ? [maskMobileNumber(s.mobileNumber)] : []),
          ...(includeCentreCol ? [s.centreName] : []),
          ...(isCoreColVisible('tma') ? [s.tmaStatus] : []),
          ...(isCoreColVisible('practical') ? [s.practicalStatus] : []),
          ...(isCoreColVisible('classes') ? [s.classAttendanceStatus] : []),
          ...(isCoreColVisible('totalFee') ? [fee?.totalFee ?? 0] : []),
          ...(isCoreColVisible('paidAmount') ? [fee?.paidAmount ?? 0] : []),
          ...(isCoreColVisible('pendingAmount') ? [fee?.pendingAmount ?? 0] : []),
          ...(isCoreColVisible('tmaFee') ? [fee?.tmaFee ?? 0] : []),
          ...(isCoreColVisible('examFee') ? [fee?.examFee ?? 0] : []),
          ...(isCoreColVisible('feeStatus') ? [fee?.recoveryStatus ?? 'Pending'] : []),
          s.subject,
          s.admissionDate,
          ...extraColumnKeys.map((k) => {
            const val = getStudentExtraColumnValue(s.extraColumns, k);
            return /mobile|phone|contact|whatsapp/i.test(k) ? maskMobileNumber(val) : val;
          }),
        ];
      }),
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
    <div
      className={
        fullScreenSheet
          ? 'fixed inset-0 z-40 bg-[#f4f7fc] p-3 sm:p-4 overflow-y-auto space-y-2.5'
          : 'space-y-3'
      }
    >
      {/* Obsidian-Crimson Translucent Glass Excel Ribbon & Action Header */}
      <div className={`glass-dark-panel text-white rounded-2xl ${fullScreenSheet ? 'p-3.5' : 'p-4'}`}>
        <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-2 text-[11px] font-mono uppercase tracking-wider text-rose-200">
              <FileSpreadsheet className="w-4 h-4 text-[#FBBF24]" />
              <span>DATABASE_SECURITY_STUDENTS.xlsx</span>
              <span className="text-rose-300/40">·</span>
              <span className="text-[#FBBF24] font-bold">{filtered.length} Records</span>
            </div>
            <h2 className="text-lg font-extrabold text-white mt-0.5">Student Database Excel Sheet</h2>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setFullScreenSheet((v) => !v)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold text-white bg-white/15 hover:bg-white/25 border border-white/25 rounded-xl backdrop-blur-md whitespace-nowrap"
              title={fullScreenSheet ? 'Exit Full Screen Excel' : 'Expand Excel to Full Screen'}
            >
              {fullScreenSheet ? (
                <>
                  <Minimize2 className="w-3.5 h-3.5 text-[#FBBF24]" />
                  Exit Full Screen
                </>
              ) : (
                <>
                  <Maximize2 className="w-3.5 h-3.5 text-[#FBBF24]" />
                  Full Screen Sheet
                </>
              )}
            </button>
            <button
              type="button"
              onClick={handleExportCsv}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-semibold text-white bg-white/10 hover:bg-white/20 border border-white/20 rounded-xl backdrop-blur-md whitespace-nowrap"
            >
              <Download className="w-3.5 h-3.5 text-[#FBBF24]" />
              CSV
            </button>
            <button
              type="button"
              onClick={handleExportExcel}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-semibold text-white bg-white/10 hover:bg-white/20 border border-white/20 rounded-xl backdrop-blur-md whitespace-nowrap"
            >
              <FileSpreadsheet className="w-3.5 h-3.5 text-emerald-300" />
              Excel (.xlsx)
            </button>
            {canBulkImport && (
              <button
                type="button"
                onClick={() => setShowBulkImport(true)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-white/10 hover:bg-white/20 border border-white/20 rounded-xl backdrop-blur-md whitespace-nowrap"
              >
                <Upload className="w-3.5 h-3.5 text-[#FBBF24]" />
                Import Excel / CSV
              </button>
            )}
            {canReorderRows && (
              <button
                type="button"
                onClick={() => {
                  const next = !reorderMode;
                  if (next && !isSerialSortedAsc) {
                    setSortKey('serialNumber');
                    setSortAsc(true);
                  }
                  setReorderMode(next);
                }}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold border rounded-xl backdrop-blur-md whitespace-nowrap ${
                  reorderMode
                    ? 'bg-[#F59E0B] text-[#08152E] border-[#FBBF24]'
                    : 'text-white bg-white/10 hover:bg-white/20 border-white/25'
                }`}
                title="Rows ko drag karke ya up/down/number se bich me move & shuffle karein"
              >
                <GripVertical className="w-3.5 h-3.5" />
                {reorderMode ? 'Reorder Mode: ON' : 'Move / Shuffle Rows'}
              </button>
            )}
            {canManageColumns && (
              <button
                type="button"
                onClick={handleOpenAddColumnModal}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold text-[#08152E] bg-[#F59E0B] hover:bg-amber-400 rounded-xl whitespace-nowrap"
                title="Naya Excel column add karein (heading edit aur delete support ke saath)"
              >
                <Plus className="w-3.5 h-3.5" />
                Add Column
              </button>
            )}
            {canCreate && (
              <>
                <button
                  type="button"
                  onClick={handleOpenInlineRow}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold text-white btn-crimson-gloss rounded-xl whitespace-nowrap"
                >
                  <Plus className="w-3.5 h-3.5" />
                  Add Row in Excel
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setEditingStudent(null);
                    setShowFormModal(true);
                  }}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-white/15 hover:bg-white/25 border border-white/25 rounded-xl whitespace-nowrap"
                >
                  Detailed Form
                </button>
              </>
            )}
            {canDelete && filtered.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  playDeleteWarningVoice();
                  setShowDeleteAllConfirm(true);
                }}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-bold text-rose-100 bg-red-600/35 hover:bg-red-600/60 border border-red-400/50 rounded-xl whitespace-nowrap"
                title="Delete all currently shown student records so you can re-upload fresh Excel"
              >
                <Trash2 className="w-3.5 h-3.5 text-rose-200" />
                {filtered.length === students.length
                  ? `Delete All (${filtered.length})`
                  : `Delete (${filtered.length})`}
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

        <button
          type="button"
          onClick={() => {
            setFitScreenMode((v) => !v);
          }}
          className={`inline-flex items-center gap-1.5 px-3 py-2 text-xs font-bold rounded-lg border whitespace-nowrap ${
            fitScreenMode
              ? 'bg-emerald-700 text-white border-emerald-700'
              : 'bg-white text-[#08152E] border-slate-300 hover:bg-slate-100'
          }`}
          title="Fit all core columns on one screen without horizontal scroll"
        >
          {fitScreenMode ? 'Fit Screen: ON (No Scroll)' : 'Fit Screen: OFF (Wide)'}
        </button>

        {Object.keys(customColWidths).length > 0 && (
          <button
            type="button"
            onClick={() => setCustomColWidths({})}
            className="inline-flex items-center gap-1.5 px-2.5 py-2 text-xs font-bold text-[#0B2454] bg-sky-50 hover:bg-sky-100 border border-sky-200 rounded-lg whitespace-nowrap"
            title="Reset all column widths back to default sizes"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Reset Cols
          </button>
        )}

        {canManageColumns && (
          <button
            type="button"
            onClick={handleOpenColumnManager}
            className={`inline-flex items-center gap-1.5 px-3 py-2 text-xs font-bold rounded-lg border whitespace-nowrap ${
              hiddenCoreSet.size > 0 || Object.keys(activeSheetConfig.headerLabels).length > 0
                ? 'bg-sky-50 text-[#0B2454] border-sky-300 hover:bg-sky-100'
                : 'bg-white text-[#08152E] border-slate-300 hover:bg-slate-100'
            }`}
            title="Koi bhi column delete/restore karein aur kisi bhi Excel heading ko edit karein"
          >
            <Columns3 className="w-3.5 h-3.5 text-[#0F2F6B]" />
            Columns / Delete
            {hiddenCoreSet.size > 0 && (
              <span className="ml-0.5 font-mono text-[10px] text-[#B91C1C]">
                ({hiddenCoreSet.size} deleted)
              </span>
            )}
          </button>
        )}

        {canReorderRows && (reorderMode || isReorderReady) && (
          <button
            type="button"
            disabled={!isReorderReady || reorderingBusy}
            onClick={() => setShowShuffleConfirm(true)}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-bold text-[#08152E] bg-amber-100 hover:bg-amber-200 border border-amber-300 rounded-lg whitespace-nowrap disabled:opacity-45"
            title="Saare rows ka order randomly shuffle karein (ya Column A drag handle se kisi bhi row ko bich me rakhein)"
          >
            <Shuffle className="w-3.5 h-3.5 text-amber-800" />
            Shuffle All Rows
          </button>
        )}
      </div>

      {/* Live Financial Fee Detection Strip (Super Admin, Centre Head & Fee Dept) */}
      {showFeeColumns && filtered.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-2.5">
          <div className="bg-white rounded-xl border border-slate-200 px-3.5 py-2.5 flex items-center justify-between gap-2">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Excel Total Fee</p>
              <p className="text-base font-extrabold font-mono text-[#08152E] tabular-nums mt-0.5">
                ₹{sheetFeeTotals.totalFee.toLocaleString('en-IN')}
              </p>
            </div>
            <IndianRupee className="w-4 h-4 text-slate-400 shrink-0" />
          </div>
          <div className="bg-white rounded-xl border border-emerald-200 px-3.5 py-2.5 flex items-center justify-between gap-2">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-wider text-emerald-700">Paid (Jama)</p>
              <p className="text-base font-extrabold font-mono text-emerald-700 tabular-nums mt-0.5">
                ₹{sheetFeeTotals.totalPaid.toLocaleString('en-IN')}
              </p>
            </div>
            <span className="text-[11px] font-mono font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 rounded">
              {sheetFeeTotals.collectionRatePct}%
            </span>
          </div>
          <div className="bg-white rounded-xl border border-rose-200 px-3.5 py-2.5 flex items-center justify-between gap-2">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-wider text-[#B91C1C]">Pending (Baki)</p>
              <p className="text-base font-extrabold font-mono text-[#B91C1C] tabular-nums mt-0.5">
                ₹{sheetFeeTotals.totalPending.toLocaleString('en-IN')}
              </p>
            </div>
            <span className="text-[10px] font-mono font-semibold text-rose-700">
              {sheetFeeTotals.partialStudents + sheetFeeTotals.pendingStudents} Due
            </span>
          </div>
          <div className="bg-white rounded-xl border border-amber-200 px-3.5 py-2.5 flex items-center justify-between gap-2">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-wider text-amber-800">TMA Fees</p>
              <p className="text-base font-extrabold font-mono text-amber-900 tabular-nums mt-0.5">
                ₹{sheetFeeTotals.totalTmaFee.toLocaleString('en-IN')}
              </p>
            </div>
            <IndianRupee className="w-4 h-4 text-amber-500 shrink-0" />
          </div>
          <div className="bg-white rounded-xl border border-indigo-200 px-3.5 py-2.5 flex items-center justify-between gap-2">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-wider text-indigo-800">Exam Fees</p>
              <p className="text-base font-extrabold font-mono text-indigo-900 tabular-nums mt-0.5">
                ₹{sheetFeeTotals.totalExamFee.toLocaleString('en-IN')}
              </p>
            </div>
            <IndianRupee className="w-4 h-4 text-indigo-500 shrink-0" />
          </div>
          <div className="bg-white rounded-xl border border-slate-200 px-3.5 py-2.5">
            <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Fee Status Split</p>
            <p className="text-[11px] font-mono font-bold text-[#08152E] mt-1">
              <span className="text-emerald-700">{sheetFeeTotals.paidStudents}P</span> ·{' '}
              <span className="text-amber-700">{sheetFeeTotals.partialStudents}Pt</span> ·{' '}
              <span className="text-rose-700">{sheetFeeTotals.pendingStudents}Due</span>
            </p>
          </div>
        </div>
      )}

      {/* Authentic Excel Formula Bar + Spreadsheet Grid */}
      <div className="glass-light-card rounded-xl overflow-hidden border border-slate-300">
        {/* Excel Formula / Selection & Row Manipulation Bar */}
        <div className="flex flex-wrap items-center justify-between border-b border-slate-300 bg-slate-50 text-xs">
          <div className="flex items-center flex-1 min-w-[240px]">
            <div className="w-24 shrink-0 px-2.5 py-2 font-mono font-bold text-[#B91C1C] border-r border-slate-300 text-center bg-white truncate">
              {selectedCell.coord}
            </div>
            <div className="px-3 py-2 font-mono font-bold text-slate-500 border-r border-slate-300 select-none">
              fx
            </div>
            <div className="flex-1 px-3 py-2 font-mono text-[#0F172A] truncate bg-white">
              {selectedCell.value}
            </div>
          </div>

          {canReorderRows && selectedStudent && selectedFilteredIndex >= 0 ? (
            <form
              onSubmit={handleJumpSelectedToPosition}
              className="flex flex-wrap items-center gap-1.5 px-2.5 py-1 border-l border-slate-300 bg-amber-50/70 shrink-0"
            >
              <span className="font-mono font-bold text-[11px] text-[#08152E]">
                Row #{selectedFilteredIndex + 1}:
              </span>
              <button
                type="button"
                disabled={reorderingBusy || selectedFilteredIndex <= 0}
                onClick={() => void handleMoveFilteredRow(selectedFilteredIndex, selectedFilteredIndex - 1)}
                className="inline-flex items-center gap-0.5 px-1.5 py-1 text-[10px] font-bold bg-white border border-slate-300 rounded hover:bg-slate-100 text-[#08152E] disabled:opacity-40"
                title="Move Selected Row 1 Position Up"
              >
                <ArrowUp className="w-3 h-3" />
                Up
              </button>
              <button
                type="button"
                disabled={reorderingBusy || selectedFilteredIndex >= filtered.length - 1}
                onClick={() => void handleMoveFilteredRow(selectedFilteredIndex, selectedFilteredIndex + 1)}
                className="inline-flex items-center gap-0.5 px-1.5 py-1 text-[10px] font-bold bg-white border border-slate-300 rounded hover:bg-slate-100 text-[#08152E] disabled:opacity-40"
                title="Move Selected Row 1 Position Down"
              >
                <ArrowDown className="w-3 h-3" />
                Down
              </button>
              <span className="text-[10px] text-slate-600 font-semibold ml-0.5">To #</span>
              <input
                type="number"
                min={1}
                max={Math.max(1, filtered.length)}
                value={moveTargetInput}
                onChange={(e) => setMoveTargetInput(e.target.value)}
                className="w-14 px-1.5 py-0.5 text-[11px] font-mono bg-white border border-slate-300 rounded text-[#08152E] text-center"
                title={`Jump selected row directly to any position (1-${filtered.length})`}
              />
              <button
                type="submit"
                disabled={reorderingBusy}
                className="px-2 py-0.5 text-[10px] font-bold bg-[#0F2F6B] text-white rounded hover:bg-[#0B2454] disabled:opacity-40"
              >
                {reorderingBusy ? '..' : 'Move'}
              </button>
              <span className="text-slate-300">|</span>
              <button
                type="button"
                onClick={() => handleOpenInlineRowAt(selectedFilteredIndex, selectedStudent.centreId)}
                className="inline-flex items-center gap-0.5 px-1.5 py-1 text-[10px] font-bold bg-emerald-50 text-emerald-800 border border-emerald-300 rounded hover:bg-emerald-100"
                title="Insert new editable Excel row right ABOVE selected row"
              >
                <Plus className="w-3 h-3" />
                Above
              </button>
              <button
                type="button"
                onClick={() => handleOpenInlineRowAt(selectedFilteredIndex + 1, selectedStudent.centreId)}
                className="inline-flex items-center gap-0.5 px-1.5 py-1 text-[10px] font-bold bg-emerald-50 text-emerald-800 border border-emerald-300 rounded hover:bg-emerald-100"
                title="Insert new editable Excel row right BELOW selected row"
              >
                <Plus className="w-3 h-3" />
                Below
              </button>
            </form>
          ) : (
            <div className="hidden md:flex items-center gap-2 px-3 py-1.5 text-[11px] text-slate-600 border-l border-slate-200 bg-slate-50 shrink-0">
              {(isSuperAdmin || isCentreHead) && (
                <span className="font-semibold text-[#0B2454]">
                  Double-click heading/cell to edit · Click row to Move · Drag S.No grip to Shuffle
                </span>
              )}
              <span className="text-slate-400">·</span>
              <span>Drag border = Resize</span>
            </div>
          )}
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
          (() => {
            const visibleColKeys: string[] = [
              ...(isCoreColVisible('serialNumber') ? ['serialNumber'] : []),
              ...(isCoreColVisible('studentName') ? ['studentName'] : []),
              ...(isCoreColVisible('mobile') ? ['mobile'] : []),
              ...(isCoreColVisible('tma') ? ['tma'] : []),
              ...(isCoreColVisible('practical') ? ['practical'] : []),
              ...(isCoreColVisible('classes') ? ['classes'] : []),
              ...(isCoreColVisible('totalFee') ? ['totalFee'] : []),
              ...(isCoreColVisible('paidAmount') ? ['paidAmount'] : []),
              ...(isCoreColVisible('pendingAmount') ? ['pendingAmount'] : []),
              ...(isCoreColVisible('tmaFee') ? ['tmaFee'] : []),
              ...(isCoreColVisible('examFee') ? ['examFee'] : []),
              ...(isCoreColVisible('feeStatus') ? ['feeStatus'] : []),
              ...extraColumnKeys.map((k) => `extra:${k}`),
              ...(isCoreColVisible('actions') ? ['actions'] : []),
            ];
            if (visibleColKeys.length === 0) {
              return (
                <div className="p-10 text-center bg-white space-y-3">
                  <Columns3 className="w-10 h-10 text-slate-400 mx-auto" />
                  <h3 className="text-sm font-bold text-[#08152E]">Saare Columns Delete / Hide Kiye Gaye Hain</h3>
                  <p className="text-xs text-slate-600 max-w-md mx-auto">
                    Abhi is Excel sheet me koi visible column nahi bacha hai. Wapas columns laane ke liye niche button par click karein.
                  </p>
                  {canManageColumns && (
                    <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
                      <button
                        type="button"
                        disabled={columnBusy}
                        onClick={() => void handleRestoreAllCoreAndHeadings()}
                        className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-bold text-white btn-crimson-gloss rounded-lg disabled:opacity-50"
                      >
                        <RotateCcw className="w-3.5 h-3.5" />
                        Restore All Core Columns
                      </button>
                      <button
                        type="button"
                        onClick={handleOpenColumnManager}
                        className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-bold text-[#08152E] bg-slate-100 hover:bg-slate-200 border border-slate-300 rounded-lg"
                      >
                        <Columns3 className="w-3.5 h-3.5" />
                        Open Columns Manager
                      </button>
                    </div>
                  )}
                </div>
              );
            }
            const colLetterMap: Record<string, string> = Object.fromEntries(
              visibleColKeys.map((k, idx) => [k, toExcelColName(idx)]),
            );
            const serialColWidth = reorderMode
              ? Math.max(getColWidth('serialNumber'), 82)
              : getColWidth('serialNumber');
            const totalTableWidth = visibleColKeys.reduce(
              (acc, k) => acc + (k === 'serialNumber' ? serialColWidth : getColWidth(k)),
              0,
            );

            const renderResizeHandle = (colKey: string, tone: 'light' | 'dark') => (
              <div
                onMouseDown={(e) => handleStartColResize(e, colKey)}
                onDoubleClick={(e) => handleToggleColAutoSize(e, colKey)}
                onClick={(e) => e.stopPropagation()}
                title="Drag left/right to make column smaller/bigger (Double-click to auto-resize)"
                className={`absolute right-0 top-0 bottom-0 w-2 cursor-col-resize z-10 transition-colors ${
                  tone === 'dark' ? 'hover:bg-[#F59E0B]/80' : 'hover:bg-[#0F2F6B]/35'
                }`}
              />
            );

            const renderHeaderTh = (
              colKey: string,
              opts: {
                sortKey?: SortKey;
                align?: 'left' | 'right' | 'center';
                canDelete?: boolean;
                isExtra?: boolean;
              } = {},
            ) => {
              const label = getHeaderLabel(colKey);
              const isEditingThisHeader = editingHeaderKey === colKey;
              const alignClass =
                opts.align === 'right'
                  ? 'text-right justify-end'
                  : opts.align === 'center'
                    ? 'text-center justify-center'
                    : 'text-left justify-start';

              return (
                <th
                  key={colKey}
                  onDoubleClick={(e) => {
                    if (!canManageColumns || isEditingThisHeader) return;
                    e.stopPropagation();
                    handleStartHeaderEdit(colKey);
                  }}
                  title={
                    canManageColumns
                      ? `${label} — Double-click to edit heading`
                      : label
                  }
                  className={`group/hdr relative align-middle whitespace-normal ${
                    opts.align === 'right'
                      ? 'text-right'
                      : opts.align === 'center'
                        ? 'text-center'
                        : 'text-left'
                  }`}
                >
                  {isEditingThisHeader ? (
                    <div
                      className="flex items-center gap-0.5 pr-1.5"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <input
                        autoFocus
                        type="text"
                        maxLength={opts.isExtra ? 50 : 60}
                        value={editingHeaderValue}
                        onChange={(e) => setEditingHeaderValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            void handleRenameColumnHeading(colKey, editingHeaderValue);
                          } else if (e.key === 'Escape') {
                            e.preventDefault();
                            setEditingHeaderKey(null);
                          }
                        }}
                        className="w-full min-w-0 px-1 py-0.5 text-[11px] font-sans font-semibold bg-white text-[#08152E] border border-[#F59E0B] rounded focus:outline-none"
                      />
                      <button
                        type="button"
                        disabled={columnBusy}
                        onClick={() => void handleRenameColumnHeading(colKey, editingHeaderValue)}
                        className="p-0.5 rounded bg-emerald-600 hover:bg-emerald-500 text-white shrink-0"
                        title="Save Heading (Enter)"
                      >
                        <Check className="w-2.5 h-2.5" />
                      </button>
                      <button
                        type="button"
                        disabled={columnBusy}
                        onClick={() => setEditingHeaderKey(null)}
                        className="p-0.5 rounded bg-slate-600 hover:bg-slate-500 text-white shrink-0"
                        title="Cancel (Esc)"
                      >
                        <X className="w-2.5 h-2.5" />
                      </button>
                    </div>
                  ) : (
                    <div className={`flex items-center gap-1 pr-1 min-w-0 ${alignClass}`}>
                      {opts.sortKey ? (
                        <button
                          type="button"
                          onClick={() => toggleSort(opts.sortKey!)}
                          className="inline-flex items-center gap-0.5 hover:text-[#F59E0B] text-left min-w-0"
                        >
                          <span className="whitespace-normal break-words leading-snug">{label}</span>
                          <ArrowUpDown className="w-2.5 h-2.5 shrink-0" />
                        </button>
                      ) : (
                        <span className="whitespace-normal break-words leading-snug block">{label}</span>
                      )}

                      {canManageColumns && (
                        <span className="hidden group-hover/hdr:inline-flex focus-within:inline-flex items-center gap-0.5 absolute top-1 right-1.5 bg-[#121c38]/95 px-1 py-0.5 rounded border border-white/20 shadow z-20">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleStartHeaderEdit(colKey);
                            }}
                            className="p-0.5 rounded hover:bg-white/20 text-[#FBBF24]"
                            title={`Edit "${label}" heading`}
                          >
                            <Pencil className="w-2.5 h-2.5" />
                          </button>
                          {opts.canDelete && (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleRequestDeleteColumn(colKey);
                              }}
                              className="p-0.5 rounded hover:bg-red-500/80 text-rose-300 hover:text-white"
                              title={
                                opts.isExtra
                                  ? `Delete "${label}" column permanently`
                                  : `Remove "${label}" column from sheet`
                              }
                            >
                              <Trash2 className="w-2.5 h-2.5" />
                            </button>
                          )}
                        </span>
                      )}
                    </div>
                  )}
                  {renderResizeHandle(colKey, 'dark')}
                </th>
              );
            };

            const handleInlineAddKeyDown = (
              e: React.KeyboardEvent<HTMLInputElement | HTMLSelectElement>,
            ) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                if (!inlineSaving) {
                  void handleSaveInlineRow(e.shiftKey);
                }
              } else if (e.key === 'Escape') {
                e.preventDefault();
                setInlineInsertIndex(null);
              }
            };

            const renderInlineInsertTr = () => {
              const previewPaid = clampFeeNumber(inlinePaidAmount);
              const previewTot = Math.max(previewPaid, clampFeeNumber(inlineTotalFee));
              const previewPending = Math.max(0, previewTot - previewPaid);
              const previewStatus =
                previewTot > 0 && previewPending === 0
                  ? 'Paid'
                  : previewPaid > 0
                    ? 'Partial'
                    : 'Pending';

              return (
              <tr key="__inline_add_row__" className="bg-amber-50/95 border-y-2 border-[#F59E0B]">
                {isCoreColVisible('serialNumber') && (
                  <td className="px-1.5 py-2 text-center font-mono font-bold text-[#0B2454]">
                    <div className="leading-tight">
                      <div>{nextSerialPreview}</div>
                      <div className="text-[9px] uppercase tracking-wider text-amber-800">
                        {inlineInsertIndex !== null && inlineInsertIndex < filtered.length ? 'Mid+' : 'New'}
                      </div>
                    </div>
                  </td>
                )}
                {isCoreColVisible('studentName') && (
                  <td className="p-1.5 space-y-1">
                    <input
                      autoFocus
                      type="text"
                      value={inlineName}
                      onChange={(e) => setInlineName(e.target.value)}
                      onKeyDown={handleInlineAddKeyDown}
                      placeholder="Enter Student Name*"
                      className="w-full px-2 py-1 text-xs bg-white border border-[#0F2F6B] rounded text-[#08152E] focus:outline-none"
                    />
                    {isSuperAdmin && effectiveCentre === 'all' && (
                      <select
                        value={inlineCentre}
                        onChange={(e) => setInlineCentre(e.target.value as CentreId)}
                        onKeyDown={handleInlineAddKeyDown}
                        className="w-full px-1.5 py-0.5 text-[10px] bg-white border border-slate-300 rounded text-[#08152E]"
                        title="Select Centre for this new student"
                      >
                        {CANONICAL_CENTRES.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.code} · {c.name}
                          </option>
                        ))}
                      </select>
                    )}
                  </td>
                )}
                {isCoreColVisible('mobile') && (
                  <td className="p-1.5">
                    <input
                      type="tel"
                      value={inlineMobile}
                      onChange={(e) => setInlineMobile(e.target.value)}
                      onKeyDown={handleInlineAddKeyDown}
                      placeholder="Mobile No*"
                      className="w-full px-2 py-1 text-xs font-mono bg-white border border-slate-300 rounded text-[#08152E] focus:outline-none focus:border-[#0F2F6B]"
                    />
                  </td>
                )}
                {isCoreColVisible('tma') && (
                  <td className="p-1.5">
                    <select
                      disabled={currentUser.role === 'employee'}
                      value={inlineTma}
                      onChange={(e) => setInlineTma(e.target.value as TmaStatus)}
                      onKeyDown={handleInlineAddKeyDown}
                      className="w-full px-1.5 py-1 text-xs bg-white border border-slate-300 rounded text-[#08152E] disabled:bg-slate-100 disabled:text-slate-500"
                    >
                      <option value="Submitted">Submitted</option>
                      <option value="Pending">Pending</option>
                      <option value="Not Submitted">Not Submitted</option>
                    </select>
                  </td>
                )}
                {isCoreColVisible('practical') && (
                  <td className="p-1.5">
                    <select
                      disabled={currentUser.role === 'employee'}
                      value={inlinePractical}
                      onChange={(e) => setInlinePractical(e.target.value as PracticalStatus)}
                      onKeyDown={handleInlineAddKeyDown}
                      className="w-full px-1.5 py-1 text-xs bg-white border border-slate-300 rounded text-[#08152E] disabled:bg-slate-100 disabled:text-slate-500"
                    >
                      <option value="Completed">Completed</option>
                      <option value="Pending">Pending</option>
                      <option value="Not Completed">Not Completed</option>
                    </select>
                  </td>
                )}
                {isCoreColVisible('classes') && (
                  <td className="p-1.5">
                    <select
                      disabled={currentUser.role === 'employee'}
                      value={inlineAttendance}
                      onChange={(e) => setInlineAttendance(e.target.value as ClassAttendanceStatus)}
                      onKeyDown={handleInlineAddKeyDown}
                      className="w-full px-1.5 py-1 text-xs bg-white border border-slate-300 rounded text-[#08152E] disabled:bg-slate-100 disabled:text-slate-500"
                    >
                      <option value="Regular">Regular</option>
                      <option value="Irregular">Irregular</option>
                      <option value="Not Attending">Not Attending</option>
                    </select>
                  </td>
                )}
                {isCoreColVisible('totalFee') && (
                  <td className="p-1">
                    <input
                      type="number"
                      min={0}
                      value={inlineTotalFee}
                      onChange={(e) => setInlineTotalFee(e.target.value)}
                      onKeyDown={handleInlineAddKeyDown}
                      className="w-full px-1 py-1 text-[11px] font-mono text-right bg-white border border-slate-300 rounded text-[#08152E]"
                      title="Total Fee"
                    />
                  </td>
                )}
                {isCoreColVisible('paidAmount') && (
                  <td className="p-1">
                    <input
                      type="number"
                      min={0}
                      value={inlinePaidAmount}
                      onChange={(e) => setInlinePaidAmount(e.target.value)}
                      onKeyDown={handleInlineAddKeyDown}
                      className="w-full px-1 py-1 text-[11px] font-mono text-right bg-white border border-slate-300 rounded text-[#08152E]"
                      title="Paid Amount"
                    />
                  </td>
                )}
                {isCoreColVisible('pendingAmount') && (
                  <td className="px-1.5 py-1 text-[11px] font-mono font-bold text-[#B91C1C] text-right tabular-nums">
                    ₹{previewPending.toLocaleString('en-IN')}
                  </td>
                )}
                {isCoreColVisible('tmaFee') && (
                  <td className="p-1">
                    <input
                      type="number"
                      min={0}
                      value={inlineTmaFee}
                      onChange={(e) => setInlineTmaFee(e.target.value)}
                      onKeyDown={handleInlineAddKeyDown}
                      className="w-full px-1 py-1 text-[11px] font-mono text-right bg-white border border-amber-300 rounded text-[#08152E]"
                      title="TMA Fee"
                    />
                  </td>
                )}
                {isCoreColVisible('examFee') && (
                  <td className="p-1">
                    <input
                      type="number"
                      min={0}
                      value={inlineExamFee}
                      onChange={(e) => setInlineExamFee(e.target.value)}
                      onKeyDown={handleInlineAddKeyDown}
                      className="w-full px-1 py-1 text-[11px] font-mono text-right bg-white border border-indigo-300 rounded text-[#08152E]"
                      title="Exam Fee"
                    />
                  </td>
                )}
                {isCoreColVisible('feeStatus') && (
                  <td className="px-1.5 py-1 text-[11px] font-bold text-slate-700 text-center">
                    {previewStatus}
                  </td>
                )}
                {extraColumnKeys.map((k) => (
                  <td key={k} className="p-1">
                    <input
                      type="text"
                      value={inlineExtraColumns[k] || ''}
                      onChange={(e) =>
                        setInlineExtraColumns((prev) => ({ ...prev, [k]: e.target.value }))
                      }
                      onKeyDown={handleInlineAddKeyDown}
                      placeholder={k}
                      className="w-full px-1.5 py-1 text-[11px] bg-white border border-slate-300 rounded text-[#08152E]"
                    />
                  </td>
                ))}
                {isCoreColVisible('actions') && (
                  <td className="p-1 text-center">
                    <div className="inline-flex items-center gap-1">
                      <button
                        type="button"
                        disabled={inlineSaving}
                        onClick={() => void handleSaveInlineRow(false)}
                        className="inline-flex items-center gap-0.5 px-2 py-1 text-[10px] font-bold btn-crimson-gloss text-white rounded disabled:opacity-50"
                        title="Save Row (Enter)"
                      >
                        <Check className="w-3 h-3" />
                        {inlineSaving ? '..' : 'Save'}
                      </button>
                      <button
                        type="button"
                        disabled={inlineSaving}
                        onClick={() => void handleSaveInlineRow(true)}
                        className="px-1.5 py-1 text-[10px] font-bold bg-emerald-700 hover:bg-emerald-800 text-white rounded disabled:opacity-50"
                        title="Save & immediately add next row below (Shift+Enter)"
                      >
                        +Next
                      </button>
                      <button
                        type="button"
                        disabled={inlineSaving}
                        onClick={() => setInlineInsertIndex(null)}
                        className="p-1 text-slate-600 hover:text-[#08152E] rounded hover:bg-slate-200"
                        title="Cancel row (Esc)"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </td>
                )}
              </tr>
              );
            };

            return (
              <div className="overflow-x-auto bg-white">
                <table
                  style={{ width: `${totalTableWidth}px` }}
                  className={`excel-sheet-table table-fixed ${fitScreenMode ? 'excel-sheet-compact' : ''}`}
                >
                  <colgroup>
                    {visibleColKeys.map((colKey) => (
                      <col
                        key={colKey}
                        style={{ width: `${colKey === 'serialNumber' ? serialColWidth : getColWidth(colKey)}px` }}
                      />
                    ))}
                  </colgroup>
                  <thead>
                    {/* Dynamic Excel Column Letters Row */}
                    <tr className="excel-col-letters">
                      {visibleColKeys.map((colKey, colIdx) => (
                        <th key={colKey} className="relative">
                          {toExcelColName(colIdx)}
                          {renderResizeHandle(colKey, 'light')}
                        </th>
                      ))}
                    </tr>

                    {/* Editable Excel Header Columns */}
                    <tr className="excel-col-header text-left">
                      {isCoreColVisible('serialNumber') &&
                        renderHeaderTh('serialNumber', { sortKey: 'serialNumber', align: 'left', canDelete: true })}
                      {isCoreColVisible('studentName') &&
                        renderHeaderTh('studentName', { sortKey: 'studentName', align: 'left', canDelete: true })}
                      {isCoreColVisible('mobile') &&
                        renderHeaderTh('mobile', { align: 'left', canDelete: true })}
                      {isCoreColVisible('tma') &&
                        renderHeaderTh('tma', { sortKey: 'tmaStatus', align: 'left', canDelete: true })}
                      {isCoreColVisible('practical') &&
                        renderHeaderTh('practical', { sortKey: 'practicalStatus', align: 'left', canDelete: true })}
                      {isCoreColVisible('classes') &&
                        renderHeaderTh('classes', { sortKey: 'classAttendanceStatus', align: 'left', canDelete: true })}
                      {isCoreColVisible('totalFee') &&
                        renderHeaderTh('totalFee', { align: 'right', canDelete: true })}
                      {isCoreColVisible('paidAmount') &&
                        renderHeaderTh('paidAmount', { align: 'right', canDelete: true })}
                      {isCoreColVisible('pendingAmount') &&
                        renderHeaderTh('pendingAmount', { align: 'right', canDelete: true })}
                      {isCoreColVisible('tmaFee') &&
                        renderHeaderTh('tmaFee', { align: 'right', canDelete: true })}
                      {isCoreColVisible('examFee') &&
                        renderHeaderTh('examFee', { align: 'right', canDelete: true })}
                      {isCoreColVisible('feeStatus') &&
                        renderHeaderTh('feeStatus', { align: 'center', canDelete: true })}
                      {extraColumnKeys.map((k) =>
                        renderHeaderTh(`extra:${k}`, { align: 'left', canDelete: true, isExtra: true }),
                      )}
                      {isCoreColVisible('actions') &&
                        renderHeaderTh('actions', { align: 'center', canDelete: true })}
                    </tr>
                  </thead>

              <tbody>
                {/* Inline Quick-Add Excel Row when inserting at top (index 0) or empty sheet */}
                {showInlineRow && (paginated.length === 0 || inlineInsertIndex === 0) && renderInlineInsertTr()}

                {paginated.map((s, idx) => {
                  const filteredIdx = (safePage - 1) * effectivePageSize + idx;
                  const rowNum = filteredIdx + 1;
                  const displaySerial = displaySerialMap.get(s.studentId) ?? s.serialNumber;
                  const canEditRow = canUserEditStudentRow(s, currentUser);
                  const isEditingThisRow = inlineEditId === s.studentId && inlineEditDraft !== null;
                  const isSelectedRow = selectedStudentId === s.studentId;
                  const canDragThisRow =
                    isReorderReady &&
                    isSerialSortedAsc &&
                    !isEditingThisRow &&
                    !reorderingBusy &&
                    (reorderMode || dragArmStudentId === s.studentId);
                  const isBeingDragged = draggedStudentId === s.studentId;
                  const dropIndicatorShadow =
                    dragOverState?.studentId === s.studentId
                      ? dragOverState.position === 'above'
                        ? 'inset 0 3px 0 #DC2626'
                        : 'inset 0 -3px 0 #DC2626'
                      : undefined;

                  const canEditIdentityInline =
                    isSuperAdmin || isCentreHead || (isEmployee && currentUser.department === 'admission');
                  const canEditTmaInline =
                    isSuperAdmin || isCentreHead || (isEmployee && currentUser.department === 'tma');
                  const canEditPracticalInline =
                    isSuperAdmin || isCentreHead || (isEmployee && currentUser.department === 'practical');
                  const canEditAttendanceInline =
                    isSuperAdmin || isCentreHead || (isEmployee && currentUser.department === 'online_classes');

                  const snoStyle = getExcelCellStyle(s, 'serialNumber', isEditingThisRow);
                  const nameStyle = getExcelCellStyle(s, 'studentName', isEditingThisRow);
                  const mobileStyle = getExcelCellStyle(s, 'mobileNumber', isEditingThisRow);
                  const tmaStyle = getExcelCellStyle(s, 'tmaStatus', isEditingThisRow);
                  const practicalStyle = getExcelCellStyle(s, 'practicalStatus', isEditingThisRow);
                  const attendanceStyle = getExcelCellStyle(s, 'classAttendanceStatus', isEditingThisRow);

                  return (
                    <React.Fragment key={s.studentId}>
                      {showInlineRow && inlineInsertIndex === filteredIdx && filteredIdx > 0 && renderInlineInsertTr()}
                      <tr
                        draggable={canDragThisRow}
                        onDragStart={(e) => {
                          if (!canDragThisRow) {
                            e.preventDefault();
                            return;
                          }
                          setDraggedStudentId(s.studentId);
                          e.dataTransfer.effectAllowed = 'move';
                          e.dataTransfer.setData('text/plain', s.studentId);
                        }}
                        onDragOver={(e) => {
                          if (!draggedStudentId || draggedStudentId === s.studentId || !isReorderReady) return;
                          e.preventDefault();
                          e.dataTransfer.dropEffect = 'move';
                          const rect = e.currentTarget.getBoundingClientRect();
                          const position: 'above' | 'below' =
                            e.clientY < rect.top + rect.height / 2 ? 'above' : 'below';
                          if (
                            dragOverState?.studentId !== s.studentId ||
                            dragOverState?.position !== position
                          ) {
                            setDragOverState({ studentId: s.studentId, position });
                          }
                        }}
                        onDrop={(e) => {
                          e.preventDefault();
                          const sourceId = draggedStudentId || e.dataTransfer.getData('text/plain');
                          const dropPos = dragOverState?.studentId === s.studentId ? dragOverState.position : 'below';
                          setDraggedStudentId(null);
                          setDragOverState(null);
                          setDragArmStudentId(null);
                          if (!sourceId || sourceId === s.studentId || !isReorderReady) return;
                          const fromIdx = filtered.findIndex((item) => item.studentId === sourceId);
                          if (fromIdx < 0) return;
                          let destIdx = filteredIdx;
                          if (fromIdx < filteredIdx) {
                            destIdx = dropPos === 'above' ? filteredIdx - 1 : filteredIdx;
                          } else {
                            destIdx = dropPos === 'above' ? filteredIdx : filteredIdx + 1;
                          }
                          void handleMoveFilteredRow(fromIdx, destIdx);
                        }}
                        onDragEnd={() => {
                          setDraggedStudentId(null);
                          setDragOverState(null);
                          setDragArmStudentId(null);
                        }}
                        onClick={() => {
                          setSelectedStudentId(s.studentId);
                          setMoveTargetInput(String(rowNum));
                        }}
                        style={{
                          ...(!isEditingThisRow && s.rowColor ? { backgroundColor: s.rowColor } : undefined),
                          ...(dropIndicatorShadow ? { boxShadow: dropIndicatorShadow } : undefined),
                        }}
                        className={`group excel-row transition-colors ${
                          isEditingThisRow
                            ? 'bg-amber-50/75'
                            : isBeingDragged
                              ? 'opacity-45 bg-sky-50'
                              : isSelectedRow
                                ? 'ring-1 ring-inset ring-[#0F2F6B]/35'
                                : ''
                        }`}
                      >
                        {/* A: S.No + Drag / Move / Middle-Insert Controls */}
                        {isCoreColVisible('serialNumber') && (
                        <td
                          style={snoStyle}
                          onClick={() => handleSelectRowCell(s, `${colLetterMap.serialNumber || 'A'}${rowNum}`, String(displaySerial), rowNum)}
                          onDoubleClick={() =>
                            canEditRow && canEditIdentityInline && handleStartInlineEdit(s, 'studentName')
                          }
                          title={
                            isReorderReady
                              ? `Row #${displaySerial} — Drag grip to move/shuffle in middle (Double-click to edit)`
                              : canEditRow
                                ? `Row #${displaySerial} (Double-click to edit row)`
                                : String(displaySerial)
                          }
                          className={`px-1 py-1 text-center font-mono font-bold tabular-nums cursor-cell select-none ${
                            snoStyle ? '' : isSelectedRow ? 'text-[#B91C1C] bg-amber-50/70' : 'text-[#0B2454] bg-[#F8FAFC]'
                          }`}
                        >
                          <div className="inline-flex items-center justify-center gap-0.5 w-full">
                            {isReorderReady && isSerialSortedAsc && !isEditingThisRow && (
                              <span
                                onMouseEnter={() => setDragArmStudentId(s.studentId)}
                                onMouseLeave={() => {
                                  if (!draggedStudentId) setDragArmStudentId(null);
                                }}
                                className={`cursor-grab active:cursor-grabbing text-slate-400 hover:text-[#B91C1C] transition-opacity ${
                                  reorderMode ? 'opacity-100' : 'opacity-40 group-hover:opacity-100'
                                }`}
                                title="Drag row up/down into any position"
                              >
                                <GripVertical className="w-3 h-3" />
                              </span>
                            )}
                            <span>{displaySerial}</span>
                            {reorderMode && isReorderReady && isSerialSortedAsc && !isEditingThisRow && (
                              <span className="inline-flex flex-col leading-none ml-0.5">
                                <button
                                  type="button"
                                  disabled={reorderingBusy || filteredIdx <= 0}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    void handleMoveFilteredRow(filteredIdx, filteredIdx - 1);
                                  }}
                                  className="text-slate-500 hover:text-[#0F2F6B] disabled:opacity-25 p-0"
                                  title="Move row up"
                                >
                                  <ArrowUp className="w-2.5 h-2.5" />
                                </button>
                                <button
                                  type="button"
                                  disabled={reorderingBusy || filteredIdx >= filtered.length - 1}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    void handleMoveFilteredRow(filteredIdx, filteredIdx + 1);
                                  }}
                                  className="text-slate-500 hover:text-[#0F2F6B] disabled:opacity-25 p-0"
                                  title="Move row down"
                                >
                                  <ArrowDown className="w-2.5 h-2.5" />
                                </button>
                              </span>
                            )}
                          </div>
                        </td>
                        )}

                        {/* B: Student Name */}
                        {isCoreColVisible('studentName') && (
                        <td
                          style={nameStyle}
                          onClick={() =>
                            handleSelectRowCell(s, `${colLetterMap.studentName || 'B'}${rowNum}`, `${s.studentName} (${s.subject})`, rowNum)
                          }
                          onDoubleClick={() =>
                            canEditRow && canEditIdentityInline && handleStartInlineEdit(s, 'studentName')
                          }
                          className={`px-2 py-1.5 font-semibold cursor-cell truncate ${
                            nameStyle ? '' : 'text-[#08152E]'
                          }`}
                          title={
                            canEditRow && canEditIdentityInline
                              ? `${s.studentName} (Double-click to edit)`
                              : s.studentName
                          }
                        >
                        {isEditingThisRow && canEditIdentityInline ? (
                          <input
                            ref={attachInlineFocusRef('studentName')}
                            type="text"
                            value={inlineEditDraft.studentName}
                            onChange={(e) =>
                              setInlineEditDraft((prev) => (prev ? { ...prev, studentName: e.target.value } : prev))
                            }
                            onKeyDown={(e) => handleInlineEditKeyDown(e, s)}
                            className="w-full px-1.5 py-1 text-[11px] bg-white border border-[#0F2F6B] rounded text-[#08152E] focus:outline-none"
                          />
                        ) : (
                          s.studentName
                        )}
                      </td>
                        )}

                      {/* Mobile No (Masked Privacy + Direct Call & WhatsApp Icons) */}
                      {isCoreColVisible('mobile') && (
                      <td
                        style={mobileStyle}
                        onClick={() =>
                          setSelectedCell({
                            coord: `${colLetterMap.mobile || 'C'}${rowNum}`,
                            value: maskMobileNumber(s.mobileNumber),
                          })
                        }
                        onDoubleClick={() =>
                          canEditRow && canEditIdentityInline && handleStartInlineEdit(s, 'mobileNumber')
                        }
                        title={
                          canEditRow && canEditIdentityInline
                            ? `${maskMobileNumber(s.mobileNumber)} (Double-click to edit)`
                            : maskMobileNumber(s.mobileNumber)
                        }
                        className={`px-1.5 py-1.5 font-mono tabular-nums cursor-cell whitespace-nowrap ${
                          mobileStyle ? '' : 'text-[#08152E]'
                        }`}
                      >
                        {isEditingThisRow && canEditIdentityInline ? (
                          <input
                            ref={attachInlineFocusRef('mobileNumber')}
                            type="tel"
                            value={inlineEditDraft.mobileNumber}
                            onChange={(e) =>
                              setInlineEditDraft((prev) => (prev ? { ...prev, mobileNumber: e.target.value } : prev))
                            }
                            onKeyDown={(e) => handleInlineEditKeyDown(e, s)}
                            placeholder={maskMobileNumber(s.mobileNumber)}
                            title="Leave blank to keep existing number or enter new number"
                            className="w-full px-1.5 py-1 text-[11px] font-mono bg-white border border-[#0F2F6B] rounded text-[#08152E] focus:outline-none"
                          />
                        ) : (
                          <div className="inline-flex items-center gap-1">
                            <span className="font-mono tracking-tight text-[11px]">
                              {maskMobileNumber(s.mobileNumber)}
                            </span>
                            {buildTelHref(s.mobileNumber) ? (
                              <a
                                href={buildTelHref(s.mobileNumber)!}
                                onClick={(e) => e.stopPropagation()}
                                aria-label={`Call ${s.studentName}`}
                                title="Direct Call"
                                className="p-0.5 rounded bg-emerald-50 text-emerald-700 hover:bg-emerald-600 hover:text-white border border-emerald-200 transition-colors shrink-0"
                              >
                                <Phone className="w-3 h-3" />
                              </a>
                            ) : (
                              <span
                                aria-hidden="true"
                                className="p-0.5 rounded bg-slate-100 text-slate-400 border border-slate-200 opacity-50 cursor-not-allowed shrink-0"
                              >
                                <Phone className="w-3 h-3" />
                              </span>
                            )}
                            {buildWhatsAppHref(s.mobileNumber, s.studentName) ? (
                              <a
                                href={buildWhatsAppHref(s.mobileNumber, s.studentName)!}
                                target="_blank"
                                rel="noopener noreferrer"
                                onClick={(e) => e.stopPropagation()}
                                aria-label={`WhatsApp ${s.studentName}`}
                                title="Open WhatsApp Chat"
                                className="p-0.5 rounded bg-green-50 text-green-700 hover:bg-[#16A34A] hover:text-white border border-green-200 transition-colors shrink-0"
                              >
                                <MessageCircle className="w-3 h-3" />
                              </a>
                            ) : (
                              <span
                                aria-hidden="true"
                                className="p-0.5 rounded bg-slate-100 text-slate-400 border border-slate-200 opacity-50 cursor-not-allowed shrink-0"
                              >
                                <MessageCircle className="w-3 h-3" />
                              </span>
                            )}
                          </div>
                        )}
                      </td>
                      )}

                      {/* TMA */}
                      {isCoreColVisible('tma') && (
                      <td
                        style={tmaStyle}
                        onClick={() => setSelectedCell({ coord: `${colLetterMap.tma || 'D'}${rowNum}`, value: s.tmaStatus })}
                        onDoubleClick={() => canEditRow && canEditTmaInline && handleStartInlineEdit(s, 'tmaStatus')}
                        className={`${fitScreenMode ? 'px-1.5 py-1 truncate' : 'px-3 py-2'} font-bold cursor-cell ${
                          tmaStyle
                            ? ''
                            : s.tmaStatus === 'Submitted'
                              ? 'bg-emerald-50/70 text-emerald-800'
                              : s.tmaStatus === 'Pending'
                                ? 'bg-amber-50/70 text-amber-800'
                                : 'bg-red-50/70 text-red-800'
                        }`}
                        title={
                          canEditRow && canEditTmaInline
                            ? `${s.tmaStatus} (Double-click to edit TMA)`
                            : s.tmaStatus
                        }
                      >
                        {isEditingThisRow && canEditTmaInline ? (
                          <select
                            ref={attachInlineFocusRef('tmaStatus')}
                            value={inlineEditDraft.tmaStatus}
                            onChange={(e) =>
                              setInlineEditDraft((prev) =>
                                prev ? { ...prev, tmaStatus: e.target.value as TmaStatus } : prev,
                              )
                            }
                            onKeyDown={(e) => handleInlineEditKeyDown(e, s)}
                            className="w-full px-1 py-0.5 text-[11px] bg-white border border-[#0F2F6B] rounded text-[#08152E]"
                          >
                            <option value="Submitted">Submitted</option>
                            <option value="Pending">Pending</option>
                            <option value="Not Submitted">Not Submitted</option>
                          </select>
                        ) : (
                          s.tmaStatus
                        )}
                      </td>
                      )}

                      {/* Practical */}
                      {isCoreColVisible('practical') && (
                      <td
                        style={practicalStyle}
                        onClick={() => setSelectedCell({ coord: `${colLetterMap.practical || 'E'}${rowNum}`, value: s.practicalStatus })}
                        onDoubleClick={() =>
                          canEditRow && canEditPracticalInline && handleStartInlineEdit(s, 'practicalStatus')
                        }
                        className={`${fitScreenMode ? 'px-1.5 py-1 truncate' : 'px-3 py-2'} font-bold cursor-cell ${
                          practicalStyle
                            ? ''
                            : s.practicalStatus === 'Completed'
                              ? 'bg-emerald-50/70 text-emerald-800'
                              : s.practicalStatus === 'Pending'
                                ? 'bg-amber-50/70 text-amber-800'
                                : 'bg-red-50/70 text-red-800'
                        }`}
                        title={
                          canEditRow && canEditPracticalInline
                            ? `${s.practicalStatus} (Double-click to edit Practical)`
                            : s.practicalStatus
                        }
                      >
                        {isEditingThisRow && canEditPracticalInline ? (
                          <select
                            ref={attachInlineFocusRef('practicalStatus')}
                            value={inlineEditDraft.practicalStatus}
                            onChange={(e) =>
                              setInlineEditDraft((prev) =>
                                prev ? { ...prev, practicalStatus: e.target.value as PracticalStatus } : prev,
                              )
                            }
                            onKeyDown={(e) => handleInlineEditKeyDown(e, s)}
                            className="w-full px-1 py-0.5 text-[11px] bg-white border border-[#0F2F6B] rounded text-[#08152E]"
                          >
                            <option value="Completed">Completed</option>
                            <option value="Pending">Pending</option>
                            <option value="Not Completed">Not Completed</option>
                          </select>
                        ) : (
                          s.practicalStatus
                        )}
                      </td>
                      )}

                      {/* Attendance Live Classes */}
                      {isCoreColVisible('classes') && (
                      <td
                        style={attendanceStyle}
                        onClick={() => setSelectedCell({ coord: `${colLetterMap.classes || 'F'}${rowNum}`, value: s.classAttendanceStatus })}
                        onDoubleClick={() =>
                          canEditRow && canEditAttendanceInline && handleStartInlineEdit(s, 'classAttendanceStatus')
                        }
                        className={`${fitScreenMode ? 'px-1.5 py-1 truncate' : 'px-3 py-2'} font-semibold cursor-cell ${
                          attendanceStyle
                            ? ''
                            : s.classAttendanceStatus === 'Regular'
                              ? 'text-emerald-800'
                              : s.classAttendanceStatus === 'Irregular'
                                ? 'text-amber-800'
                                : 'text-red-800'
                        }`}
                        title={
                          canEditRow && canEditAttendanceInline
                            ? `${s.classAttendanceStatus} (Double-click to edit Attendance)`
                            : s.classAttendanceStatus
                        }
                      >
                        {isEditingThisRow && canEditAttendanceInline ? (
                          <select
                            ref={attachInlineFocusRef('classAttendanceStatus')}
                            value={inlineEditDraft.classAttendanceStatus}
                            onChange={(e) =>
                              setInlineEditDraft((prev) =>
                                prev
                                  ? { ...prev, classAttendanceStatus: e.target.value as ClassAttendanceStatus }
                                  : prev,
                              )
                            }
                            onKeyDown={(e) => handleInlineEditKeyDown(e, s)}
                            className="w-full px-1 py-0.5 text-[11px] bg-white border border-[#0F2F6B] rounded text-[#08152E]"
                          >
                            <option value="Regular">Regular</option>
                            <option value="Irregular">Irregular</option>
                            <option value="Not Attending">Not Attending</option>
                          </select>
                        ) : (
                          s.classAttendanceStatus
                        )}
                      </td>
                      )}

                      {/* Detected Fee Math + TMA Fee + Exam Fee Columns */}
                      {showFeeColumns &&
                        (() => {
                          const fee = studentFeeSummaryMap.get(s.studentId);
                          const hasFee = Boolean(fee?.hasFeeData);
                          const hasTmaFee = Boolean(fee?.hasTmaFee);
                          const hasExamFee = Boolean(fee?.hasExamFee);
                          const canEditFeeInline = isSuperAdmin || isCentreHead;
                          const liveDraftPaid = isEditingThisRow ? clampFeeNumber(inlineEditDraft.paidAmount) : 0;
                          const liveDraftTotal = isEditingThisRow
                            ? Math.max(liveDraftPaid, clampFeeNumber(inlineEditDraft.totalFee))
                            : 0;
                          const liveDraftPending = Math.max(0, liveDraftTotal - liveDraftPaid);
                          const totalFeeStyle = getExcelCellStyle(s, 'totalFee', isEditingThisRow);
                          const paidFeeStyle = getExcelCellStyle(s, 'paidAmount', isEditingThisRow);
                          const pendingFeeStyle = getExcelCellStyle(s, 'pendingAmount', isEditingThisRow);
                          const tmaFeeStyle = getExcelCellStyle(s, 'tmaFee', isEditingThisRow);
                          const examFeeStyle = getExcelCellStyle(s, 'examFee', isEditingThisRow);
                          const feeStatusStyle = getExcelCellStyle(s, 'feeStatus', isEditingThisRow);
                          return (
                            <>
                              {isCoreColVisible('totalFee') && (
                              <td
                                style={totalFeeStyle}
                                onClick={() =>
                                  setSelectedCell({
                                    coord: `${colLetterMap.totalFee || 'G'}${rowNum}`,
                                    value: hasFee ? `₹${fee!.totalFee.toLocaleString('en-IN')}` : '—',
                                  })
                                }
                                onDoubleClick={() =>
                                  canEditRow && canEditFeeInline && handleStartInlineEdit(s, 'totalFee')
                                }
                                className={`${fitScreenMode ? 'px-1.5 py-1 truncate' : 'px-3 py-2'} font-mono font-semibold text-right tabular-nums cursor-cell ${
                                  totalFeeStyle ? '' : 'text-[#08152E]'
                                }`}
                                title={
                                  canEditFeeInline
                                    ? `${hasFee ? `₹${fee!.totalFee.toLocaleString('en-IN')}` : '—'} (Double-click to edit)`
                                    : hasFee
                                      ? `₹${fee!.totalFee.toLocaleString('en-IN')}`
                                      : '—'
                                }
                              >
                                {isEditingThisRow && canEditFeeInline ? (
                                  <input
                                    ref={attachInlineFocusRef('totalFee')}
                                    type="number"
                                    min={0}
                                    value={inlineEditDraft.totalFee}
                                    onChange={(e) =>
                                      setInlineEditDraft((prev) => (prev ? { ...prev, totalFee: e.target.value } : prev))
                                    }
                                    onKeyDown={(e) => handleInlineEditKeyDown(e, s)}
                                    className="w-full px-1 py-0.5 text-[11px] font-mono text-right bg-white border border-[#0F2F6B] rounded text-[#08152E]"
                                  />
                                ) : hasFee ? (
                                  `₹${fee!.totalFee.toLocaleString('en-IN')}`
                                ) : (
                                  '—'
                                )}
                              </td>
                              )}
                              {isCoreColVisible('paidAmount') && (
                              <td
                                style={paidFeeStyle}
                                onClick={() =>
                                  setSelectedCell({
                                    coord: `${colLetterMap.paidAmount || 'H'}${rowNum}`,
                                    value: hasFee ? `₹${fee!.paidAmount.toLocaleString('en-IN')}` : '—',
                                  })
                                }
                                onDoubleClick={() =>
                                  canEditRow && canEditFeeInline && handleStartInlineEdit(s, 'paidAmount')
                                }
                                className={`${fitScreenMode ? 'px-1.5 py-1 truncate' : 'px-3 py-2'} font-mono font-bold text-right tabular-nums cursor-cell ${
                                  paidFeeStyle ? '' : 'text-emerald-700'
                                }`}
                                title={
                                  canEditFeeInline
                                    ? `${hasFee ? `₹${fee!.paidAmount.toLocaleString('en-IN')}` : '—'} (Double-click to edit)`
                                    : hasFee
                                      ? `₹${fee!.paidAmount.toLocaleString('en-IN')}`
                                      : '—'
                                }
                              >
                                {isEditingThisRow && canEditFeeInline ? (
                                  <input
                                    ref={attachInlineFocusRef('paidAmount')}
                                    type="number"
                                    min={0}
                                    value={inlineEditDraft.paidAmount}
                                    onChange={(e) =>
                                      setInlineEditDraft((prev) =>
                                        prev ? { ...prev, paidAmount: e.target.value } : prev,
                                      )
                                    }
                                    onKeyDown={(e) => handleInlineEditKeyDown(e, s)}
                                    className="w-full px-1 py-0.5 text-[11px] font-mono text-right bg-white border border-emerald-600 rounded text-[#08152E]"
                                  />
                                ) : hasFee ? (
                                  `₹${fee!.paidAmount.toLocaleString('en-IN')}`
                                ) : (
                                  '—'
                                )}
                              </td>
                              )}
                              {isCoreColVisible('pendingAmount') && (
                              <td
                                style={pendingFeeStyle}
                                onClick={() =>
                                  setSelectedCell({
                                    coord: `${colLetterMap.pendingAmount || 'I'}${rowNum}`,
                                    value: hasFee ? `₹${fee!.pendingAmount.toLocaleString('en-IN')}` : '—',
                                  })
                                }
                                onDoubleClick={() =>
                                  canEditRow && canEditFeeInline && handleStartInlineEdit(s, 'paidAmount')
                                }
                                className={`${fitScreenMode ? 'px-1.5 py-1 truncate' : 'px-3 py-2'} font-mono font-bold text-right tabular-nums cursor-cell ${
                                  pendingFeeStyle
                                    ? ''
                                    : (isEditingThisRow ? liveDraftPending > 0 : hasFee && fee!.pendingAmount > 0)
                                      ? 'text-[#B91C1C]'
                                      : 'text-slate-600'
                                }`}
                                title={
                                  canEditFeeInline
                                    ? `${hasFee ? `₹${fee!.pendingAmount.toLocaleString('en-IN')}` : '—'} (Double-click to update Paid / Total Fee)`
                                    : hasFee
                                      ? `₹${fee!.pendingAmount.toLocaleString('en-IN')}`
                                      : '—'
                                }
                              >
                                {isEditingThisRow && canEditFeeInline
                                  ? `₹${liveDraftPending.toLocaleString('en-IN')}`
                                  : hasFee
                                    ? `₹${fee!.pendingAmount.toLocaleString('en-IN')}`
                                    : '—'}
                              </td>
                              )}
                              {isCoreColVisible('tmaFee') && (
                              <td
                                style={tmaFeeStyle}
                                onClick={() =>
                                  setSelectedCell({
                                    coord: `${colLetterMap.tmaFee || 'J'}${rowNum}`,
                                    value: hasTmaFee || (fee?.tmaFee ?? 0) > 0 ? `₹${fee!.tmaFee.toLocaleString('en-IN')}` : '₹0',
                                  })
                                }
                                onDoubleClick={() =>
                                  canEditRow && (canEditFeeInline || canEditIdentityInline) && handleStartInlineEdit(s, 'tmaFee')
                                }
                                className={`${fitScreenMode ? 'px-1.5 py-1 truncate' : 'px-3 py-2'} font-mono font-semibold text-right tabular-nums cursor-cell ${
                                  tmaFeeStyle ? '' : 'text-amber-900 bg-amber-50/35'
                                }`}
                                title={
                                  canEditFeeInline
                                    ? `TMA Fee: ₹${(fee?.tmaFee ?? 0).toLocaleString('en-IN')} (Double-click to edit)`
                                    : `TMA Fee: ₹${(fee?.tmaFee ?? 0).toLocaleString('en-IN')}`
                                }
                              >
                                {isEditingThisRow && (canEditFeeInline || canEditIdentityInline) ? (
                                  <input
                                    ref={attachInlineFocusRef('tmaFee')}
                                    type="number"
                                    min={0}
                                    value={inlineEditDraft.tmaFee}
                                    onChange={(e) =>
                                      setInlineEditDraft((prev) => (prev ? { ...prev, tmaFee: e.target.value } : prev))
                                    }
                                    onKeyDown={(e) => handleInlineEditKeyDown(e, s)}
                                    className="w-full px-1 py-0.5 text-[11px] font-mono text-right bg-white border border-amber-500 rounded text-[#08152E]"
                                  />
                                ) : hasTmaFee || (fee?.tmaFee ?? 0) > 0 ? (
                                  `₹${fee!.tmaFee.toLocaleString('en-IN')}`
                                ) : (
                                  '—'
                                )}
                              </td>
                              )}
                              {isCoreColVisible('examFee') && (
                              <td
                                style={examFeeStyle}
                                onClick={() =>
                                  setSelectedCell({
                                    coord: `${colLetterMap.examFee || 'K'}${rowNum}`,
                                    value: hasExamFee || (fee?.examFee ?? 0) > 0 ? `₹${fee!.examFee.toLocaleString('en-IN')}` : '₹0',
                                  })
                                }
                                onDoubleClick={() =>
                                  canEditRow && (canEditFeeInline || canEditIdentityInline) && handleStartInlineEdit(s, 'examFee')
                                }
                                className={`${fitScreenMode ? 'px-1.5 py-1 truncate' : 'px-3 py-2'} font-mono font-semibold text-right tabular-nums cursor-cell ${
                                  examFeeStyle ? '' : 'text-indigo-900 bg-indigo-50/35'
                                }`}
                                title={
                                  canEditFeeInline
                                    ? `Exam Fee: ₹${(fee?.examFee ?? 0).toLocaleString('en-IN')} (Double-click to edit)`
                                    : `Exam Fee: ₹${(fee?.examFee ?? 0).toLocaleString('en-IN')}`
                                }
                              >
                                {isEditingThisRow && (canEditFeeInline || canEditIdentityInline) ? (
                                  <input
                                    ref={attachInlineFocusRef('examFee')}
                                    type="number"
                                    min={0}
                                    value={inlineEditDraft.examFee}
                                    onChange={(e) =>
                                      setInlineEditDraft((prev) => (prev ? { ...prev, examFee: e.target.value } : prev))
                                    }
                                    onKeyDown={(e) => handleInlineEditKeyDown(e, s)}
                                    className="w-full px-1 py-0.5 text-[11px] font-mono text-right bg-white border border-indigo-500 rounded text-[#08152E]"
                                  />
                                ) : hasExamFee || (fee?.examFee ?? 0) > 0 ? (
                                  `₹${fee!.examFee.toLocaleString('en-IN')}`
                                ) : (
                                  '—'
                                )}
                              </td>
                              )}
                              {isCoreColVisible('feeStatus') && (
                              <td
                                style={feeStatusStyle}
                                onClick={() =>
                                  setSelectedCell({
                                    coord: `${colLetterMap.feeStatus || 'L'}${rowNum}`,
                                    value: hasFee ? fee!.recoveryStatus : 'Pending',
                                  })
                                }
                                onDoubleClick={() =>
                                  canEditRow && canEditFeeInline && handleStartInlineEdit(s, 'paidAmount')
                                }
                                className={`${fitScreenMode ? 'px-1.5 py-1 truncate' : 'px-3 py-2'} font-bold text-center cursor-cell ${
                                  feeStatusStyle
                                    ? ''
                                    : fee?.recoveryStatus === 'Paid'
                                      ? 'bg-emerald-50/70 text-emerald-800'
                                      : fee?.recoveryStatus === 'Partial'
                                        ? 'bg-amber-50/70 text-amber-800'
                                        : fee?.recoveryStatus === 'Overdue'
                                          ? 'bg-red-50/70 text-red-800'
                                          : 'text-slate-600'
                                }`}
                                title={
                                  canEditFeeInline
                                    ? `${hasFee ? fee!.recoveryStatus : '—'} (Double-click to edit Paid / Total Fee)`
                                    : hasFee
                                      ? fee!.recoveryStatus
                                      : '—'
                                }
                              >
                                {hasFee ? fee!.recoveryStatus : '—'}
                              </td>
                              )}
                            </>
                          );
                        })()}

                      {/* Dynamic Shared & Jaunpur Extra Excel Columns */}
                      {extraColumnKeys.map((colKey) => {
                        const rawCellVal = getStudentExtraColumnValue(s.extraColumns, colKey);
                        const isPhoneCol = /mobile|phone|contact|whatsapp/i.test(colKey);
                        const cellVal = isPhoneCol && rawCellVal ? maskMobileNumber(rawCellVal) : rawCellVal;
                        const canEditExtra = isSuperAdmin || isCentreHead;
                        const extraStyle = getExcelCellStyle(s, `extra:${colKey}`, isEditingThisRow);
                        return (
                          <td
                            key={colKey}
                            style={extraStyle}
                            onClick={() =>
                              setSelectedCell({ coord: `${colKey}#${rowNum}`, value: cellVal || '—' })
                            }
                            onDoubleClick={() =>
                              canEditRow && canEditExtra && handleStartInlineEdit(s, `extra:${colKey}`)
                            }
                            className={`px-2 py-1.5 cursor-cell whitespace-nowrap truncate ${
                              extraStyle ? '' : 'text-slate-800'
                            }`}
                            title={isPhoneCol ? 'Masked Phone Column' : cellVal || (canEditExtra ? 'Double-click to edit inline' : undefined)}
                          >
                            {isEditingThisRow && canEditExtra ? (
                              <input
                                ref={attachInlineFocusRef(`extra:${colKey}`)}
                                type="text"
                                value={inlineEditDraft.extraColumns[colKey] ?? rawCellVal}
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
                                onKeyDown={(e) => handleInlineEditKeyDown(e, s)}
                                className="w-full px-1.5 py-1 text-[11px] bg-white border border-[#0F2F6B] rounded text-[#08152E] focus:outline-none"
                              />
                            ) : (
                              cellVal || '—'
                            )}
                          </td>
                        );
                      })}

                      {/* Actions */}
                      {isCoreColVisible('actions') && (
                      <td className="px-1 py-1 text-center whitespace-nowrap">
                        <div className="inline-flex items-center justify-center gap-0.5">
                          {isEditingThisRow ? (
                            <>
                              <button
                                type="button"
                                disabled={inlineEditSaving}
                                onClick={() => handleSaveInlineEdit(s)}
                                className="inline-flex items-center gap-0.5 px-2 py-1 text-[10px] font-bold text-white bg-emerald-700 hover:bg-emerald-800 rounded disabled:opacity-50"
                                title="Save Excel Row (or press Enter)"
                              >
                                <Check className="w-3 h-3" />
                                {inlineEditSaving ? '..' : 'Save'}
                              </button>
                              <button
                                type="button"
                                disabled={inlineEditSaving}
                                onClick={handleCancelInlineEdit}
                                className="p-1 text-slate-600 hover:text-[#08152E] hover:bg-slate-200 rounded"
                                title="Cancel inline edit (or press Esc)"
                              >
                                <X className="w-3 h-3" />
                              </button>
                            </>
                          ) : (
                            <>
                              <button
                                type="button"
                                onClick={() => setViewingStudent(s)}
                                className="p-1 text-slate-700 hover:text-[#08152E] hover:bg-sky-100 rounded"
                                title="View Details"
                              >
                                <Eye className="w-3.5 h-3.5" />
                              </button>

                              {canEditRow ? (
                                <>
                                  <button
                                    type="button"
                                    onClick={() => handleStartInlineEdit(s, 'studentName')}
                                    className="px-1.5 py-0.5 text-[10px] font-bold text-[#0B2454] bg-sky-50 hover:bg-sky-100 border border-sky-200 rounded"
                                    title={
                                      isEmployee
                                        ? `Quick Edit ${DEPARTMENT_LABELS[currentUser.department] || currentUser.department} cell`
                                        : 'Inline Edit right in Excel (or Double-Click any cell)'
                                    }
                                  >
                                    Edit
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setEditingStudent(s);
                                      setShowFormModal(true);
                                    }}
                                    className="p-1 text-[#0B2454] hover:bg-sky-100 rounded"
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
                                    className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-bold text-[#B45309] bg-amber-50 hover:bg-amber-100 border border-amber-200 rounded whitespace-nowrap"
                                    title="Ask Centre Head permission to unlock 1 correction edit"
                                  >
                                    <Send className="w-3 h-3" />
                                    {fitScreenMode ? 'Ask' : 'Ask Permission'}
                                  </button>
                                )
                              ) : null}

                              {canReorderRows && (
                                <button
                                  type="button"
                                  onClick={() => handleOpenInlineRowAt(filteredIdx + 1, s.centreId)}
                                  className="p-1 text-emerald-700 hover:bg-emerald-50 rounded"
                                  title={`Insert new row directly below Row #${displaySerial}`}
                                >
                                  <Plus className="w-3.5 h-3.5" />
                                </button>
                              )}

                              {canDelete && (
                                <button
                                  type="button"
                                  onClick={() => {
                                    playDeleteWarningVoice();
                                    setDeletingStudent(s);
                                  }}
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
                      )}
                    </tr>
                  </React.Fragment>
                  );
                })}

                {/* Inline Quick-Add Excel Row when appending at end (or between pages at boundary) */}
                {showInlineRow &&
                  paginated.length > 0 &&
                  inlineInsertIndex !== null &&
                  (inlineInsertIndex >= filtered.length ||
                    inlineInsertIndex < (safePage - 1) * effectivePageSize ||
                    inlineInsertIndex >= (safePage - 1) * effectivePageSize + paginated.length) &&
                  inlineInsertIndex !== 0 &&
                  renderInlineInsertTr()}

                {/* Quick Excel Bottom "+ Add Row" Strip */}
                {canCreate && !showInlineRow && (
                  <tr className="bg-slate-50/80 hover:bg-amber-50/70 border-t border-slate-200 transition-colors">
                    <td colSpan={visibleColKeys.length} className="px-3 py-1.5 text-left">
                      <button
                        type="button"
                        onClick={handleOpenInlineRow}
                        className="inline-flex items-center gap-1.5 text-xs font-bold text-[#0F2F6B] hover:text-[#B91C1C]"
                      >
                        <Plus className="w-3.5 h-3.5" />
                        Add New Student Row in Excel (#{filtered.length + 1})
                      </button>
                    </td>
                  </tr>
                )}
              </tbody>

              {showFeeColumns && filtered.length > 0 && (
                <tfoot>
                  <tr className="bg-slate-900 text-white font-mono font-bold text-[11px] border-t-2 border-[#DC2626]">
                    {isCoreColVisible('serialNumber') && (
                      <td className="px-2 py-2 text-center text-[#FBBF24]">
                        {isCoreColVisible('studentName') ? 'Σ' : `Σ (${filtered.length})`}
                      </td>
                    )}
                    {isCoreColVisible('studentName') && (
                      <td className="px-2 py-2 text-left font-sans uppercase tracking-wider text-rose-100">
                        TOTAL ({filtered.length})
                      </td>
                    )}
                    {isCoreColVisible('mobile') && (
                      <td className="px-2 py-2 text-slate-400 text-center">—</td>
                    )}
                    {isCoreColVisible('tma') && (
                      <td className="px-2 py-2 text-slate-400 text-center">—</td>
                    )}
                    {isCoreColVisible('practical') && (
                      <td className="px-2 py-2 text-slate-400 text-center">—</td>
                    )}
                    {isCoreColVisible('classes') && (
                      <td className="px-2 py-2 text-slate-400 text-center">—</td>
                    )}
                    {isCoreColVisible('totalFee') && (
                      <td className="px-1.5 py-2 text-right tabular-nums">
                        ₹{sheetFeeTotals.totalFee.toLocaleString('en-IN')}
                      </td>
                    )}
                    {isCoreColVisible('paidAmount') && (
                      <td className="px-1.5 py-2 text-right text-emerald-300 tabular-nums">
                        ₹{sheetFeeTotals.totalPaid.toLocaleString('en-IN')}
                      </td>
                    )}
                    {isCoreColVisible('pendingAmount') && (
                      <td className="px-1.5 py-2 text-right text-rose-300 tabular-nums">
                        ₹{sheetFeeTotals.totalPending.toLocaleString('en-IN')}
                      </td>
                    )}
                    {isCoreColVisible('tmaFee') && (
                      <td className="px-1.5 py-2 text-right text-amber-300 tabular-nums">
                        ₹{sheetFeeTotals.totalTmaFee.toLocaleString('en-IN')}
                      </td>
                    )}
                    {isCoreColVisible('examFee') && (
                      <td className="px-1.5 py-2 text-right text-sky-300 tabular-nums">
                        ₹{sheetFeeTotals.totalExamFee.toLocaleString('en-IN')}
                      </td>
                    )}
                    {isCoreColVisible('feeStatus') && (
                      <td className="px-1.5 py-2 text-center text-[#FBBF24]">
                        {sheetFeeTotals.collectionRatePct}%
                      </td>
                    )}
                    {extraColumnKeys.map((k) => (
                      <td key={k} className="px-2 py-2 text-slate-500 text-center">
                        —
                      </td>
                    ))}
                    {isCoreColVisible('actions') && (
                      <td className="px-2 py-2 text-center text-[10px] font-sans uppercase text-slate-300">
                        Summary Row
                      </td>
                    )}
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
            );
          })()
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
        isCentreLocked={effectiveCentre !== 'all'}
        existingStudents={students}
        sheetConfigs={sheetConfigs}
        onClose={() => setShowBulkImport(false)}
        onSuccess={(msg) => {
          setLocalSearch('');
          setTmaFilter('all');
          setPage(1);
          setRowsPerPage(999999);
          setFitScreenMode(true);
          onNotify('Excel Imported & Opened', msg, 'success');
        }}
        onError={(title, desc) => onNotify(title, desc, 'error')}
      />

      <DeleteProtectionModal
        open={Boolean(deletingStudent)}
        title="Confirm Student Deletion"
        description={`Are you sure you want to permanently delete ${deletingStudent?.studentName} (Serial #${deletingStudent?.serialNumber}) and all linked department records? This action is recorded in the audit log.`}
        confirmLabel="Verify & Delete Student"
        busy={deleteBusy}
        onConfirm={handleConfirmDelete}
        onCancel={() => {
          if (!deleteBusy) setDeletingStudent(null);
        }}
      />

      <DeleteProtectionModal
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
            : `Verify & Delete ${filtered.length} Records`
        }
        busy={deleteAllBusy}
        onConfirm={handleConfirmDeleteAll}
        onCancel={() => {
          if (!deleteAllBusy) setShowDeleteAllConfirm(false);
        }}
      />

      <ConfirmDialog
        open={showShuffleConfirm}
        title={`Shuffle Order of All ${filtered.length} Excel Rows?`}
        description={`Yeh current sheet ke saare ${filtered.length} rows ko random order me shuffle karke database me save kar dega. Agar aap kisi specific row ko bich me rakhna chahte hain, toh direct Row ke S.No grip se drag karein ya Formula Bar se "To #" move use karein.`}
        confirmLabel={`Yes, Shuffle ${filtered.length} Rows`}
        busy={reorderingBusy}
        onConfirm={handleConfirmShuffleAll}
        onCancel={() => {
          if (!reorderingBusy) setShowShuffleConfirm(false);
        }}
      />

      <DeleteProtectionModal
        open={Boolean(deletingColumnTargets && deletingColumnTargets.length > 0)}
        title={
          deletingColumnTargets && deletingColumnTargets.length > 1
            ? `Delete ${deletingColumnTargets.length} Selected Columns?`
            : deletingColumnTargets?.[0]?.isExtra
              ? `Delete Column "${deletingColumnTargets[0].label}" Permanently?`
              : `Delete Column "${deletingColumnTargets?.[0]?.label}" from Sheet?`
        }
        description={
          deletingColumnTargets && deletingColumnTargets.length > 1
            ? `Aap ${deletingColumnTargets.length} columns (${deletingColumnTargets
                .map((t) => t.label)
                .slice(0, 5)
                .join(', ')}${
                deletingColumnTargets.length > 5 ? ` +${deletingColumnTargets.length - 5} more` : ''
              }) delete karne ja rahe hain. Custom columns ka data permanently remove ho jayega aur standard columns sheet se hat jayenge (baad me Columns Manager se restore kar sakte hain).`
            : deletingColumnTargets?.[0]?.isExtra
              ? `"${deletingColumnTargets[0].label}" column Excel sheet se permanently delete ho jayega aur ${deletingColumnTargets[0].affectedCount} students ke is column ki values bhi remove ho jayengi.`
              : `"${deletingColumnTargets?.[0]?.label}" column Excel grid aur CSV/Excel exports se delete/remove ho jayega. Aap isse kabhi bhi "Columns / Delete" manager se wapas restore kar sakte hain.`
        }
        confirmLabel={
          deletingColumnTargets && deletingColumnTargets.length > 1
            ? `Verify & Delete ${deletingColumnTargets.length} Columns`
            : 'Verify & Delete Column'
        }
        busy={columnBusy}
        onConfirm={handleConfirmDeleteColumn}
        onCancel={() => {
          if (!columnBusy) setDeletingColumnTargets(null);
        }}
      />

      {/* Add New Custom Column Modal */}
      {showAddColumnModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#090d1b]/75 backdrop-blur-sm p-4">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-2xl max-w-md w-full p-6 text-[#0F172A]">
            <div className="flex items-start justify-between pb-3 border-b border-slate-200">
              <div>
                <h3 className="text-base font-bold text-[#08152E]">Add New Excel Column</h3>
                <p className="text-xs text-slate-600 mt-0.5 font-mono">
                  Scope: {isSuperAdmin && addColToAllCentres ? 'All Centres (Master Global Sheet)' : saveScopeLabel} · {extraColumnKeys.length} shared custom cols
                </p>
              </div>
              <button
                type="button"
                disabled={columnBusy}
                onClick={() => setShowAddColumnModal(false)}
                className="text-slate-500 hover:text-[#08152E] p-1"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleConfirmAddColumn} className="mt-4 space-y-4">
              <div>
                <label className="block text-xs font-semibold text-[#08152E] mb-1">
                  Column Heading Name *
                </label>
                <input
                  autoFocus
                  type="text"
                  required
                  maxLength={50}
                  value={newColName}
                  onChange={(e) => setNewColName(e.target.value)}
                  placeholder="e.g., Father Name, Batch Timing, Medium, Roll Code"
                  className="w-full px-3 py-2 text-sm bg-white text-[#08152E] placeholder:text-slate-400 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#0F2F6B]"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-[#08152E] mb-1">
                  Default Value for Existing{' '}
                  {isSuperAdmin && addColToAllCentres ? students.length : columnMutationStudents.length} Rows (Optional)
                </label>
                <input
                  type="text"
                  maxLength={300}
                  value={newColDefaultValue}
                  onChange={(e) => setNewColDefaultValue(e.target.value)}
                  placeholder="Leave blank for empty cells (or e.g. Pending / Morning)"
                  className="w-full px-3 py-2 text-sm bg-white text-[#08152E] placeholder:text-slate-400 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#0F2F6B]"
                />
              </div>
              {isSuperAdmin && targetConfigId !== 'global' && (
                <label className="flex items-center gap-2 text-xs text-[#08152E] font-medium bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={addColToAllCentres}
                    onChange={(e) => setAddColToAllCentres(e.target.checked)}
                    className="rounded border-slate-300 text-[#0F2F6B] focus:ring-[#0F2F6B]"
                  />
                  <span>Add & share across all centres (Recommended)</span>
                </label>
              )}
              <div className="flex justify-end gap-2.5 pt-2">
                <button
                  type="button"
                  disabled={columnBusy}
                  onClick={() => setShowAddColumnModal(false)}
                  className="px-4 py-2 text-xs font-semibold text-[#08152E] bg-white border border-slate-300 rounded-lg hover:bg-slate-100"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={columnBusy}
                  className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-bold text-white btn-crimson-gloss rounded-lg disabled:opacity-50"
                >
                  <Plus className="w-3.5 h-3.5" />
                  {columnBusy ? 'Adding...' : 'Add Column to Sheet'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Excel Columns & Headings Manager Modal */}
      {showColumnManagerModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#090d1b]/75 backdrop-blur-sm p-4">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-2xl max-w-3xl w-full max-h-[88vh] flex flex-col text-[#0F172A]">
            <div className="flex items-start justify-between px-6 py-4 border-b border-slate-200">
              <div>
                <div className="flex items-center gap-2">
                  <Columns3 className="w-5 h-5 text-[#B91C1C]" />
                  <h3 className="text-base font-bold text-[#08152E]">
                    Excel Columns & Headings Manager (Delete / Edit Any Column)
                  </h3>
                </div>
                <p className="text-xs text-slate-600 mt-0.5 font-mono">
                  Scope: {saveScopeLabel} · Select single ya multiple columns aur kisi ko bhi delete/restore karein
                </p>
              </div>
              <button
                type="button"
                disabled={columnBusy}
                onClick={() => setShowColumnManagerModal(false)}
                className="text-slate-500 hover:text-[#08152E] p-1"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-5 overflow-y-auto space-y-5 flex-1">
              {/* Top quick bar */}
              {(() => {
                const deletableKeys = [
                  ...CORE_EXCEL_COLUMNS.filter((c) => !hiddenCoreSet.has(c.key)).map((c) => c.key),
                  ...extraColumnKeys.map((ek) => `extra:${ek}`),
                ];
                return (
                  <div className="flex flex-wrap items-center justify-between gap-2 bg-slate-50 border border-slate-200 rounded-xl p-3">
                    <div className="text-xs text-slate-700">
                      <strong className="text-[#08152E]">{CORE_EXCEL_COLUMNS.length} Core</strong> ·{' '}
                      <strong className="text-[#0F2F6B]">{extraColumnKeys.length} Shared/Custom</strong> columns
                      {hiddenCoreSet.size > 0 && (
                        <span className="ml-2 font-mono text-[#B91C1C]">
                          ({hiddenCoreSet.size} core removed)
                        </span>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {deletableKeys.length > 0 && (
                        <button
                          type="button"
                          disabled={columnBusy}
                          onClick={() => {
                            if (selectedManagerCols.size === deletableKeys.length) {
                              setSelectedManagerCols(new Set());
                            } else {
                              setSelectedManagerCols(new Set(deletableKeys));
                            }
                          }}
                          className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold text-[#08152E] bg-white hover:bg-slate-100 border border-slate-300 rounded-lg disabled:opacity-50"
                        >
                          {selectedManagerCols.size === deletableKeys.length && deletableKeys.length > 0
                            ? 'Unselect All'
                            : `Select All (${deletableKeys.length})`}
                        </button>
                      )}
                      {selectedManagerCols.size > 0 && (
                        <button
                          type="button"
                          disabled={columnBusy}
                          onClick={() =>
                            handleRequestDeleteMultipleColumns(Array.from(selectedManagerCols))
                          }
                          className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-bold text-white bg-red-600 hover:bg-red-700 rounded-lg disabled:opacity-50"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                          Delete Selected ({selectedManagerCols.size})
                        </button>
                      )}
                      {(hiddenCoreSet.size > 0 ||
                        Object.keys(activeSheetConfig.headerLabels).length > 0) && (
                        <button
                          type="button"
                          disabled={columnBusy}
                          onClick={() => void handleRestoreAllCoreAndHeadings()}
                          className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-bold text-[#0B2454] bg-sky-50 hover:bg-sky-100 border border-sky-200 rounded-lg disabled:opacity-50"
                        >
                          <RotateCcw className="w-3.5 h-3.5" />
                          Restore All Core Columns
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={columnBusy || extraColumnKeys.length >= 35}
                        onClick={() => {
                          setShowColumnManagerModal(false);
                          handleOpenAddColumnModal();
                        }}
                        className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-bold text-white btn-crimson-gloss rounded-lg disabled:opacity-50"
                      >
                        <Plus className="w-3.5 h-3.5" />
                        Add Custom Column
                      </button>
                    </div>
                  </div>
                );
              })()}

              {/* Core Columns */}
              <div className="space-y-2">
                <h4 className="text-xs font-bold uppercase tracking-wider text-slate-500">
                  Standard Excel Columns (Kisi Ko Bhi Delete, Rename Ya Restore Karein)
                </h4>
                <div className="divide-y divide-slate-200 border border-slate-200 rounded-xl overflow-hidden">
                  {CORE_EXCEL_COLUMNS.map((c) => {
                    const isHidden = hiddenCoreSet.has(c.key);
                    const isSelected = selectedManagerCols.has(c.key);
                    const currentLabel = activeSheetConfig.headerLabels[c.key] || '';
                    const draftVal = managerDraftLabels[c.key] ?? currentLabel;
                    const dirty = draftVal.trim() !== currentLabel.trim();

                    return (
                      <div
                        key={c.key}
                        className={`flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-xs ${
                          isHidden ? 'bg-slate-100/80 opacity-80' : isSelected ? 'bg-red-50/40' : 'bg-white'
                        }`}
                      >
                        <div className="flex items-center gap-2 min-w-[155px]">
                          <input
                            type="checkbox"
                            disabled={isHidden || columnBusy}
                            checked={isSelected}
                            onChange={(e) => {
                              setSelectedManagerCols((prev) => {
                                const next = new Set(prev);
                                if (e.target.checked) next.add(c.key);
                                else next.delete(c.key);
                                return next;
                              });
                            }}
                            className="rounded border-slate-300 text-red-600 focus:ring-red-500 disabled:opacity-40"
                            title={isHidden ? 'Already removed' : `Select ${c.exportLabel} to delete`}
                          />
                          <div>
                            <div className="font-bold text-[#08152E]">{c.exportLabel}</div>
                            <div className="text-[10px] font-mono text-slate-500">
                              {isHidden ? 'Removed from grid & exports' : 'Visible in sheet'}
                            </div>
                          </div>
                        </div>

                        <div className="flex items-center gap-1.5 flex-1 min-w-[190px] max-w-sm">
                          <input
                            type="text"
                            maxLength={60}
                            value={draftVal}
                            onChange={(e) =>
                              setManagerDraftLabels((prev) => ({
                                ...prev,
                                [c.key]: e.target.value,
                              }))
                            }
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' && dirty) {
                                e.preventDefault();
                                void handleRenameColumnHeading(c.key, draftVal);
                              }
                            }}
                            placeholder={`Default: ${c.wideLabel}`}
                            className="flex-1 px-2.5 py-1 text-xs bg-white text-[#08152E] border border-slate-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-[#0F2F6B]"
                          />
                          {dirty && (
                            <button
                              type="button"
                              disabled={columnBusy}
                              onClick={() => void handleRenameColumnHeading(c.key, draftVal)}
                              className="px-2.5 py-1 text-[11px] font-bold bg-emerald-700 hover:bg-emerald-800 text-white rounded-lg disabled:opacity-50"
                            >
                              Save
                            </button>
                          )}
                        </div>

                        <div className="shrink-0">
                          {isHidden ? (
                            <button
                              type="button"
                              disabled={columnBusy}
                              onClick={() => void handleToggleCoreColumnHidden(c.key, false)}
                              className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-bold text-emerald-800 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 rounded-lg"
                            >
                              <Eye className="w-3 h-3" />
                              Restore
                            </button>
                          ) : (
                            <button
                              type="button"
                              disabled={columnBusy}
                              onClick={() => handleRequestDeleteColumn(c.key)}
                              className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-bold text-red-700 bg-red-50 hover:bg-red-100 border border-red-200 rounded-lg disabled:opacity-50"
                            >
                              <Trash2 className="w-3 h-3" />
                              Delete
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Custom & Extra Columns */}
              <div className="space-y-2">
                <h4 className="text-xs font-bold uppercase tracking-wider text-slate-500">
                  Shared & Custom Excel Columns ({extraColumnKeys.length})
                </h4>
                {extraColumnKeys.length === 0 ? (
                  <div className="p-4 text-center text-xs text-slate-500 bg-slate-50 border border-dashed border-slate-300 rounded-xl">
                    Abhi koi custom column nahi hai. Upar &ldquo;Add Custom Column&rdquo; par click karke naya column banayein.
                  </div>
                ) : (
                  <div className="divide-y divide-slate-200 border border-slate-200 rounded-xl overflow-hidden">
                    {extraColumnKeys.map((ek) => {
                      const colKey = `extra:${ek}`;
                      const isSelected = selectedManagerCols.has(colKey);
                      const draftVal = managerDraftLabels[colKey] ?? ek;
                      const dirty = draftVal.trim() !== '' && draftVal.trim() !== ek;
                      return (
                        <div
                          key={ek}
                          className={`flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-xs ${
                            isSelected ? 'bg-red-50/40' : 'bg-white'
                          }`}
                        >
                          <div className="flex items-center gap-2 min-w-[155px]">
                            <input
                              type="checkbox"
                              disabled={columnBusy}
                              checked={isSelected}
                              onChange={(e) => {
                                setSelectedManagerCols((prev) => {
                                  const next = new Set(prev);
                                  if (e.target.checked) next.add(colKey);
                                  else next.delete(colKey);
                                  return next;
                                });
                              }}
                              className="rounded border-slate-300 text-red-600 focus:ring-red-500"
                              title={`Select ${ek} to delete`}
                            />
                            <div>
                              <div className="font-bold text-[#0B2454]">{ek}</div>
                              <div className="text-[10px] font-mono text-slate-500">
                                Custom / Uploaded Column
                              </div>
                            </div>
                          </div>

                          <div className="flex items-center gap-1.5 flex-1 min-w-[190px] max-w-sm">
                            <input
                              type="text"
                              maxLength={50}
                              value={draftVal}
                              onChange={(e) =>
                                setManagerDraftLabels((prev) => ({
                                  ...prev,
                                  [colKey]: e.target.value,
                                }))
                              }
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' && dirty) {
                                  e.preventDefault();
                                  void handleRenameColumnHeading(colKey, draftVal);
                                }
                              }}
                              className="flex-1 px-2.5 py-1 text-xs bg-white text-[#08152E] border border-slate-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-[#0F2F6B]"
                            />
                            {dirty && (
                              <button
                                type="button"
                                disabled={columnBusy}
                                onClick={() => void handleRenameColumnHeading(colKey, draftVal)}
                                className="px-2.5 py-1 text-[11px] font-bold bg-emerald-700 hover:bg-emerald-800 text-white rounded-lg disabled:opacity-50"
                              >
                                Rename
                              </button>
                            )}
                          </div>

                          <button
                            type="button"
                            disabled={columnBusy}
                            onClick={() => handleRequestDeleteColumn(colKey)}
                            className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-bold text-red-700 bg-red-50 hover:bg-red-100 border border-red-200 rounded-lg disabled:opacity-50"
                          >
                            <Trash2 className="w-3 h-3" />
                            Delete
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            <div className="px-6 py-3 border-t border-slate-200 bg-slate-50 flex items-center justify-between rounded-b-2xl">
              <span className="text-[11px] text-slate-500">
                All heading edits, column deletions & restorations sync live across centres.
              </span>
              <button
                type="button"
                disabled={columnBusy}
                onClick={() => setShowColumnManagerModal(false)}
                className="px-4 py-1.5 text-xs font-bold text-white bg-[#08152E] hover:bg-[#0F2F6B] rounded-lg"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}

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
