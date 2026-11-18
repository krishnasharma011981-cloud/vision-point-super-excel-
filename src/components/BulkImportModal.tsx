import {
  AlertCircle,
  CheckCircle2,
  Download,
  FileSpreadsheet,
  SlidersHorizontal,
  Upload,
  X,
} from 'lucide-react';
import React, { useEffect, useMemo, useState } from 'react';
import { CANONICAL_CENTRES, CENTRE_MAP } from '../constants/centres';
import { isFeeFullyPaid, maskMobileNumber } from '../lib/analyticsMath';
import {
  buildImportPreviewRows,
  type PreviewImportRow,
} from '../lib/importMatching';
import {
  alignHeaderToCommonSchema,
  cleanMobileNumber,
  exportToCsv,
  exportToExcel,
  extractBlankAndSparseSheetHeadings,
  extractCommonBranchExtraHeaders,
  extractJaunpurHeadingAndBlankColumns,
  fuzzyDetectColumnMapping,
  getReadableTextColor,
  isMockSubjectValue,
  loadStoredCommonBranchHeaders,
  mergeExtraColumnsWithConfig,
  mergeImportedExtraColumns,
  parseSpreadsheetFile,
  saveCommonBranchHeaders,
  type ExcelColumnMapping,
  type ExcludedSummaryRow,
} from '../lib/csvUtils';
import { verifyOperationLocation } from '../lib/securityClient';
import {
  bulkImportStudentsBatch,
  deleteStudentsBatch,
  getNextSerialNumber,
  mergeCustomColumnsIntoSharedConfig,
  type BulkImportRowPayload,
} from '../services/firestoreService';
import type { CentreId, ExcelSheetConfig, FeeRecoveryRecord, Student, UserAccount } from '../types/domain';

interface BulkImportModalProps {
  open: boolean;
  currentUser: UserAccount;
  defaultCentreId: CentreId;
  isCentreLocked?: boolean;
  existingStudents: Student[];
  sheetConfigs?: ExcelSheetConfig[];
  mode?: 'full' | 'fee_sync' | 'academic_sync';
  defaultAcademicType?: 'tma' | 'practical';
  feeRecords?: FeeRecoveryRecord[];
  onClose: () => void;
  onSuccess: (msg: string) => void;
  onError: (title: string, desc: string) => void;
}

const ALL_SHEETS_KEY = '__ALL_SHEETS__';

export const BulkImportModal: React.FC<BulkImportModalProps> = ({
  open,
  currentUser,
  defaultCentreId,
  isCentreLocked = false,
  existingStudents,
  sheetConfigs = [],
  mode = 'full',
  defaultAcademicType = 'tma',
  feeRecords = [],
  onClose,
  onSuccess,
  onError,
}) => {
  const isSuperAdmin = currentUser.role === 'super_admin';
  const [selectedCentre, setSelectedCentre] = useState<CentreId>(
    isSuperAdmin ? defaultCentreId : currentUser.centreId,
  );
  const [autoDetectCentre, setAutoDetectCentre] = useState<boolean>(
    isSuperAdmin && !isCentreLocked,
  );
  const [allowMissingMobile, setAllowMissingMobile] = useState<boolean>(true);
  const [importMode, setImportMode] = useState<'upsert' | 'skip_duplicates' | 'replace_all'>('upsert');
  const [feeSyncOnlyMode, setFeeSyncOnlyMode] = useState<boolean>(mode === 'fee_sync');
  const [academicSyncOnlyMode, setAcademicSyncOnlyMode] = useState<boolean>(mode === 'academic_sync');
  const [skipUnmatchedNewInFeeSync, setSkipUnmatchedNewInFeeSync] = useState<boolean>(false);
  const defaultTotalFee = 0;
  const [showColumnMapper, setShowColumnMapper] = useState<boolean>(
    mode === 'fee_sync' || mode === 'academic_sync',
  );

  const [sheetNames, setSheetNames] = useState<string[]>([]);
  const [activeSheet, setActiveSheet] = useState<string>('');
  const [rawSheets, setRawSheets] = useState<Record<string, Array<Record<string, string>>>>({});
  const [headersBySheet, setHeadersBySheet] = useState<Record<string, string[]>>({});
  const [rowColorsBySheet, setRowColorsBySheet] = useState<Record<string, Array<Record<string, string>>>>({});
  const [summaryRowsFilteredBySheet, setSummaryRowsFilteredBySheet] = useState<Record<string, number>>({});
  const [excludedSummaryRowsBySheet, setExcludedSummaryRowsBySheet] = useState<
    Record<string, ExcludedSummaryRow[]>
  >({});
  const [includeExcludedRows, setIncludeExcludedRows] = useState<boolean>(false);
  const [allowDuplicateRowsInSheet, setAllowDuplicateRowsInSheet] = useState<boolean>(false);
  const [previewFilter, setPreviewFilter] = useState<'all' | 'ready' | 'issues'>('all');
  const [showAllPreviewRows, setShowAllPreviewRows] = useState<boolean>(true);
  const [columnMapping, setColumnMapping] = useState<ExcelColumnMapping>({});
  const [editedOverrides, setEditedOverrides] = useState<
    Record<number, { studentName?: string; mobileNumber?: string }>
  >({});

  const [fileName, setFileName] = useState('');
  const [parsing, setParsing] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [importStatusText, setImportStatusText] = useState<string>('');

  useEffect(() => {
    if (open) {
      setSelectedCentre(isSuperAdmin ? defaultCentreId : currentUser.centreId);
      setAutoDetectCentre(isSuperAdmin && !isCentreLocked);
      setImportMode('upsert');
      setFeeSyncOnlyMode(mode === 'fee_sync');
      setAcademicSyncOnlyMode(mode === 'academic_sync');
      setSkipUnmatchedNewInFeeSync(false);
      setShowColumnMapper(mode === 'fee_sync' || mode === 'academic_sync');
      setImportStatusText('');
      setImportError(null);
      setParseError(null);
      setPreviewFilter('all');
    }
  }, [open, defaultCentreId, isCentreLocked, isSuperAdmin, currentUser.centreId, mode]);

  const fallbackCentre = isSuperAdmin ? selectedCentre : currentUser.centreId;

  const commonExtraHeadings = useMemo(() => {
    const globalCfg = sheetConfigs.find((c) => c.configId === 'global');
    const jaunpurCfg = sheetConfigs.find((c) => c.configId === 'xis_jaunpur');
    const centreCfg = sheetConfigs.find((c) => c.configId === fallbackCentre);
    const mergedCfg = {
      customColumns: [
        ...(centreCfg?.customColumns || []),
        ...(globalCfg?.customColumns || []),
        ...(jaunpurCfg?.customColumns || []),
      ],
      deletedExtraColumns: [
        ...(globalCfg?.deletedExtraColumns || []),
        ...(centreCfg?.deletedExtraColumns || []),
      ],
    };
    const jaunpurAndShared = mergeExtraColumnsWithConfig(
      extractJaunpurHeadingAndBlankColumns(existingStudents, sheetConfigs),
      mergedCfg,
    );
    const branchExtras = extractCommonBranchExtraHeaders(existingStudents);
    return mergeExtraColumnsWithConfig([...jaunpurAndShared, ...branchExtras], {
      customColumns: jaunpurAndShared,
      deletedExtraColumns: mergedCfg.deletedExtraColumns,
    });
  }, [existingStudents, sheetConfigs, fallbackCentre]);

  useEffect(() => {
    const lkgKeys: string[] = [];
    const seen = new Set<string>();
    for (const s of existingStudents) {
      if (s.centreId !== 'vp_lookerganj' || !s.extraColumns) continue;
      for (const k of Object.keys(s.extraColumns)) {
        const clean = k.trim().slice(0, 50);
        if (clean && !seen.has(clean)) {
          seen.add(clean);
          lkgKeys.push(clean);
        }
        if (lkgKeys.length >= 35) break;
      }
      if (lkgKeys.length >= 35) break;
    }
    if (lkgKeys.length > 0) {
      saveCommonBranchHeaders(lkgKeys);
    }
  }, [existingStudents]);

  const activeHeaders = useMemo(
    () => headersBySheet[activeSheet] || [],
    [headersBySheet, activeSheet],
  );
  const activeExcludedRows = useMemo(
    () => excludedSummaryRowsBySheet[activeSheet] || [],
    [excludedSummaryRowsBySheet, activeSheet],
  );
  const activeRawRows = useMemo(() => {
    const base = rawSheets[activeSheet] || [];
    if (!includeExcludedRows || activeExcludedRows.length === 0) return base;
    return [...base, ...activeExcludedRows.map((item) => item.row)];
  }, [rawSheets, activeSheet, includeExcludedRows, activeExcludedRows]);
  const activeRowColors = useMemo(() => {
    const base = rowColorsBySheet[activeSheet] || [];
    if (!includeExcludedRows || activeExcludedRows.length === 0) return base;
    return [...base, ...activeExcludedRows.map((item) => item.colors)];
  }, [rowColorsBySheet, activeSheet, includeExcludedRows, activeExcludedRows]);
  const activeSummaryFiltered = includeExcludedRows
    ? 0
    : summaryRowsFilteredBySheet[activeSheet] || activeExcludedRows.length || 0;

  const effectiveBranchLocked = isCentreLocked || !autoDetectCentre;

  const previewRows = useMemo<PreviewImportRow[]>(
    () =>
      buildImportPreviewRows({
        rawRows: activeRawRows,
        rowColors: activeRowColors,
        fallbackCentre,
        allowCentreOverride: isSuperAdmin && autoDetectCentre,
        isCentreLocked: effectiveBranchLocked,
        columnMapping,
        allowMissingMobile,
        allowDuplicateRowsInSheet,
        defaultTotalFee,
        importMode,
        mode,
        isSuperAdmin,
        currentUserCentreId: currentUser.centreId,
        editedOverrides,
        existingStudents,
        commonExtraHeadings,
      }),
    [
      activeRawRows,
      activeRowColors,
      fallbackCentre,
      isSuperAdmin,
      autoDetectCentre,
      effectiveBranchLocked,
      columnMapping,
      allowMissingMobile,
      allowDuplicateRowsInSheet,
      defaultTotalFee,
      importMode,
      mode,
      currentUser.centreId,
      editedOverrides,
      existingStudents,
      commonExtraHeadings,
    ],
  );

  const readyRows = useMemo(
    () => previewRows.filter((r) => !r.validationError && !r.duplicateReason),
    [previewRows],
  );
  const newReadyCount = useMemo(
    () => readyRows.filter((r) => r.operation === 'create').length,
    [readyRows],
  );
  const updateReadyCount = useMemo(
    () => readyRows.filter((r) => r.operation === 'update').length,
    [readyRows],
  );
  const issueRows = useMemo(
    () => previewRows.filter((r) => r.validationError || r.duplicateReason),
    [previewRows],
  );
  const duplicateIssueCount = useMemo(
    () => previewRows.filter((r) => !r.validationError && Boolean(r.duplicateReason)).length,
    [previewRows],
  );
  const filteredPreviewRows = useMemo(() => {
    if (previewFilter === 'ready') return readyRows;
    if (previewFilter === 'issues') return issueRows;
    return previewRows;
  }, [previewFilter, previewRows, readyRows, issueRows]);
  const visiblePreviewRows = useMemo(() => {
    if (showAllPreviewRows || filteredPreviewRows.length <= 500) return filteredPreviewRows;
    return filteredPreviewRows.slice(0, 150);
  }, [filteredPreviewRows, showAllPreviewRows]);
  const coloredRowsCount = useMemo(
    () =>
      readyRows.filter((r) => Boolean(r.rowColor) || Object.keys(r.cellColors).length > 0).length,
    [readyRows],
  );

  const feeSummary = useMemo(() => {
    const total = readyRows.reduce((s, r) => s + r.totalFee, 0);
    const paid = readyRows.reduce((s, r) => s + r.paidAmount, 0);
    const pending = readyRows.reduce((s, r) => s + r.pendingAmount, 0);
    const tmaFee = readyRows.reduce((s, r) => s + r.tmaFee, 0);
    const examFee = readyRows.reduce((s, r) => s + r.examFee, 0);
    const pct = total > 0 ? Math.round((paid / total) * 100) : 0;
    return { total, paid, pending, tmaFee, examFee, pct };
  }, [readyRows]);

  const existingFeeMap = useMemo(() => {
    const map = new Map<string, FeeRecoveryRecord>();
    feeRecords.forEach((f) => map.set(f.studentId, f));
    return map;
  }, [feeRecords]);

  const rowsWithAnyFeeCount = useMemo(
    () =>
      readyRows.filter(
        (r) =>
          r.totalFee > 0 ||
          r.paidAmount > 0 ||
          r.pendingAmount > 0 ||
          r.tmaFee > 0 ||
          r.examFee > 0 ||
          r.explicitFeeDetected,
      ).length,
    [readyRows],
  );

  const rowsWithPendingDueCount = useMemo(
    () => readyRows.filter((r) => r.pendingAmount > 0 || r.recoveryStatus === 'Overdue').length,
    [readyRows],
  );

  const paidReadyCount = useMemo(
    () => readyRows.filter((r) => isFeeFullyPaid(r)).length,
    [readyRows],
  );

  const unpaidReadyCount = readyRows.length - paidReadyCount;

  const readyCentreCounts = useMemo(() => {
    const counts = new Map<CentreId, number>();
    for (const r of readyRows) {
      counts.set(r.centreId, (counts.get(r.centreId) || 0) + 1);
    }
    return CANONICAL_CENTRES
      .map((c) => ({ centre: c, count: counts.get(c.id) || 0 }))
      .filter((item) => item.count > 0);
  }, [readyRows]);

  const rowsOutsideSelectedCentreCount = useMemo(
    () => readyRows.filter((r) => r.centreId !== fallbackCentre).length,
    [readyRows, fallbackCentre],
  );

  const studentsToReplace = useMemo(
    () =>
      effectiveBranchLocked
        ? existingStudents.filter((s) => s.centreId === fallbackCentre)
        : existingStudents,
    [effectiveBranchLocked, existingStudents, fallbackCentre],
  );

  const hasAnyMappedFeeColumn = Boolean(
    columnMapping.totalFee ||
      columnMapping.paidAmount ||
      columnMapping.pendingAmount ||
      columnMapping.tmaFee ||
      columnMapping.examFee,
  );

  const feeMissingWarning =
    mode !== 'academic_sync' &&
    activeRawRows.length > 0 &&
    readyRows.length > 0 &&
    rowsWithAnyFeeCount === 0 &&
    defaultTotalFee === 0;

  const extraPreviewHeaders = useMemo(
    () =>
      activeHeaders.filter(
        (h) => h !== columnMapping.studentName && h !== columnMapping.mobileNumber,
      ),
    [activeHeaders, columnMapping.studentName, columnMapping.mobileNumber],
  );

  const columnSampleMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const h of activeHeaders) {
      for (const row of activeRawRows.slice(0, 20)) {
        const val = String(row[h] ?? '').trim();
        if (val) {
          map.set(h, val.slice(0, 24));
          break;
        }
      }
    }
    return map;
  }, [activeHeaders, activeRawRows]);

  const commonTemplateHeaders = useMemo(() => {
    const baseHeaders = [
      'Student Name',
      'Mobile No',
      'Centre',
      'Subjects',
      'TMA',
      'Practical',
      'Attendance (Live Classes)',
      'TC Status',
      'Book Status',
      'Examination',
      'Admission Date',
      'Total Fee',
      'Paid Amount',
      'TMA Fee',
      'Exam Fee',
      'Additional Remarks',
    ];
    const baseLower = new Set(baseHeaders.map((h) => h.toLowerCase()));
    const extraCommon = commonExtraHeadings.filter((h) => !baseLower.has(h.toLowerCase()));
    return {
      headers: [...baseHeaders, ...extraCommon],
      extraCount: extraCommon.length,
    };
  }, [commonExtraHeadings]);

  if (!open) return null;

  const handleDownloadExcelTemplate = () => {
    exportToExcel(
      'vision-point-student-import-template.xlsx',
      'Students',
      commonTemplateHeaders.headers,
      [
        [
          'Aarav Sharma',
          '9876543210',
          CENTRE_MAP[fallbackCentre].name,
          'English, Mathematics, Science, Social Science, Hindi',
          'Submitted',
          'Pending',
          'Not Attending',
          'Received',
          'Received',
          'Not Completed',
          new Date().toISOString().slice(0, 10),
          0,
          0,
          0,
          0,
          '',
          ...Array.from({ length: commonTemplateHeaders.extraCount }, () => ''),
        ],
      ],
    );
  };

  const handleDownloadCsvTemplate = () => {
    exportToCsv(
      'vision-point-student-import-template.csv',
      commonTemplateHeaders.headers,
      [
        [
          'Aarav Sharma',
          '9876543210',
          CENTRE_MAP[fallbackCentre].name,
          'English, Mathematics, Science, Social Science, Hindi',
          'Submitted',
          'Pending',
          'Not Attending',
          'Received',
          'Received',
          'Not Completed',
          new Date().toISOString().slice(0, 10),
          0,
          0,
          0,
          0,
          '',
          ...Array.from({ length: commonTemplateHeaders.extraCount }, () => ''),
        ],
      ],
    );
  };

  const applySheetSelection = (
    nextSheet: string,
    sheetsMap: Record<string, Array<Record<string, string>>>,
    hdrsMap: Record<string, string[]>,
  ) => {
    setActiveSheet(nextSheet);
    setEditedOverrides({});
    const hdrs = hdrsMap[nextSheet] || [];
    const rows = sheetsMap[nextSheet] || [];
    const detected = fuzzyDetectColumnMapping(hdrs, rows);
    setColumnMapping(detected);
    if (
      mode === 'fee_sync' ||
      !detected.studentName ||
      (rows.length > 0 && !detected.totalFee && !detected.paidAmount && !detected.pendingAmount)
    ) {
      setShowColumnMapper(true);
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setParseError(null);
    setImportError(null);
    setEditedOverrides({});
    setIncludeExcludedRows(false);
    setAllowDuplicateRowsInSheet(false);
    setPreviewFilter('all');
    setParsing(true);
    try {
      const result = await parseSpreadsheetFile(file);
      if (result.sheetNames.length === 0 || (result.sheets[result.sheetNames[0]] || []).length === 0) {
        setParseError(
          'No student rows detected in this file. Make sure the sheet is not empty and contains student rows.',
        );
        setSheetNames([]);
        setRawSheets({});
        setHeadersBySheet({});
        setRowColorsBySheet({});
        setSummaryRowsFilteredBySheet({});
        setExcludedSummaryRowsBySheet({});
        setActiveSheet('');
        setColumnMapping({});
      } else {
        const nextSheets = { ...result.sheets };
        const nextHeaders = { ...result.headersBySheet };
        const nextColors = { ...(result.rowColorsBySheet || {}) };
        const nextFiltered = { ...(result.summaryRowsFilteredBySheet || {}) };
        const nextExcluded = { ...(result.excludedSummaryRowsBySheet || {}) };
        let selectableNames = [...result.sheetNames];
        let initialSheet = result.sheetNames[0];

        if (result.sheetNames.length > 1) {
          const allRows: Array<Record<string, string>> = [];
          const allColors: Array<Record<string, string>> = [];
          const allExcluded: ExcludedSummaryRow[] = [];
          const unionHeaders: string[] = [];
          const headerSet = new Set<string>();
          let totalSummaryFiltered = 0;

          const firstSet = new Set(result.headersBySheet[result.sheetNames[0]] || []);
          let overlapSum = 0;

          result.sheetNames.forEach((sName) => {
            const sRows = result.sheets[sName] || [];
            const sCols = result.rowColorsBySheet?.[sName] || [];
            const sHdrs = result.headersBySheet[sName] || [];
            const sExcl = result.excludedSummaryRowsBySheet?.[sName] || [];
            sHdrs.forEach((h) => {
              if (!headerSet.has(h)) {
                headerSet.add(h);
                unionHeaders.push(h);
              }
            });
            const shared = sHdrs.filter((h) => firstSet.has(h)).length;
            overlapSum += sHdrs.length > 0 ? shared / sHdrs.length : 0;

            sRows.forEach((r, rIdx) => {
              allRows.push(r);
              allColors.push(sCols[rIdx] || {});
            });
            sExcl.forEach((ex) => allExcluded.push(ex));
            totalSummaryFiltered += result.summaryRowsFilteredBySheet?.[sName] || 0;
          });

          nextSheets[ALL_SHEETS_KEY] = allRows;
          nextHeaders[ALL_SHEETS_KEY] = unionHeaders;
          nextColors[ALL_SHEETS_KEY] = allColors;
          nextFiltered[ALL_SHEETS_KEY] = totalSummaryFiltered;
          nextExcluded[ALL_SHEETS_KEY] = allExcluded;
          selectableNames = [ALL_SHEETS_KEY, ...result.sheetNames];
          if (overlapSum / result.sheetNames.length >= 0.85) {
            initialSheet = ALL_SHEETS_KEY;
          }
        }

        setSheetNames(selectableNames);
        setRawSheets(nextSheets);
        setHeadersBySheet(nextHeaders);
        setRowColorsBySheet(nextColors);
        setSummaryRowsFilteredBySheet(nextFiltered);
        setExcludedSummaryRowsBySheet(nextExcluded);
        applySheetSelection(initialSheet, nextSheets, nextHeaders);
      }
    } catch (err) {
      setParseError(
        err instanceof Error
          ? `Unable to read file: ${err.message}`
          : 'Unable to parse Excel/CSV file. Try saving as .xlsx or UTF-8 .csv.',
      );
      setSheetNames([]);
      setRawSheets({});
      setHeadersBySheet({});
      setRowColorsBySheet({});
      setSummaryRowsFilteredBySheet({});
      setExcludedSummaryRowsBySheet({});
      setActiveSheet('');
      setColumnMapping({});
    } finally {
      setParsing(false);
      e.target.value = '';
    }
  };

  const handleImport = async () => {
    if (readyRows.length === 0) return;
    setImporting(true);
    setImportError(null);
    setImportStatusText('');
    try {
      const loc = await verifyOperationLocation(currentUser, 'BULK_STUDENT_IMPORT', fallbackCentre);
      if (!loc.allowed) {
        const msg = loc.error || 'Physical presence required at assigned centre.';
        setImportError(msg);
        onError('Location Verification Failed', msg);
        setImporting(false);
        return;
      }

      const shouldReplace = isSuperAdmin && importMode === 'replace_all' && studentsToReplace.length > 0;
      if (shouldReplace) {
        setImportStatusText(`Clearing existing ${studentsToReplace.length} records...`);
        await deleteStudentsBatch(studentsToReplace, currentUser, {
          onProgress: (done, total) => setImportStatusText(`Clearing old records (${done}/${total})...`),
        });
      }

      const effectiveRowsToSync =
        (mode === 'fee_sync' || mode === 'academic_sync') && skipUnmatchedNewInFeeSync
          ? readyRows.filter((r) => r.operation === 'update')
          : readyRows;
      if (effectiveRowsToSync.length === 0) {
        setImportError('No matched existing students to update. Uncheck "Matched Students Only" or fix Student Name mapping.');
        setImporting(false);
        return;
      }

      setImportStatusText(
        academicSyncOnlyMode
          ? `Syncing 0/${effectiveRowsToSync.length} subjects & statuses...`
          : `Syncing 0/${effectiveRowsToSync.length} students & fees...`,
      );
      const replacedIdSet = new Set(studentsToReplace.map((s) => s.studentId.toLowerCase()));
      const remainingAfterReplace = shouldReplace
        ? existingStudents.filter((s) => !replacedIdSet.has(s.studentId.toLowerCase()))
        : existingStudents;
      let nextSerial =
        remainingAfterReplace.length === 0 ? 1 : await getNextSerialNumber(remainingAfterReplace);
      const year = new Date().getFullYear();
      const usedPayloadIds = new Set<string>(
        remainingAfterReplace.map((s) => s.studentId.toLowerCase()),
      );

      const payloads: BulkImportRowPayload[] = effectiveRowsToSync.map((row) => {
        if (row.operation === 'update' && row.matchedExisting) {
          usedPayloadIds.add(row.matchedExisting.studentId.toLowerCase());
          const existingSubject = (row.matchedExisting.subject || '').trim();
          const hasCustomExistingSubject =
            existingSubject.length > 0 && !isMockSubjectValue(existingSubject);
          const resolvedSubject = row.explicitSubjectDetected
            ? row.subject
            : hasCustomExistingSubject
              ? existingSubject
              : '';
          const mergedExtraColumns = mergeImportedExtraColumns(
            row.extraColumns,
            row.matchedExisting.extraColumns,
          );
          return {
            operation: 'update',
            serialNumber: row.matchedExisting.serialNumber,
            studentId: row.matchedExisting.studentId,
            studentName: row.studentName,
            mobileNumber:
              row.mobileNumber === 'Not Provided' && row.matchedExisting.mobileNumber
                ? row.matchedExisting.mobileNumber
                : row.mobileNumber,
            subject: resolvedSubject,
            tcStatus: row.tcStatus,
            bookStatus: row.bookStatus,
            classAttendanceStatus: row.classAttendanceStatus,
            whyNios: row.whyNios,
            currentEducationStatus: row.currentEducationStatus,
            futurePlanning: row.futurePlanning,
            tmaStatus: row.tmaStatus,
            practicalStatus: row.practicalStatus,
            examinationStatus: row.examinationStatus,
            centreId: row.centreId,
            centreName: row.centreName,
            admissionDate: row.admissionDate,
            additionalRemarks: row.additionalRemarks,
            totalFee: row.totalFee,
            paidAmount: row.paidAmount,
            pendingAmount: row.pendingAmount,
            tmaFee: row.tmaFee,
            examFee: row.examFee,
            recoveryStatus: row.recoveryStatus,
            followUpStatus: row.followUpStatus,
            explicitFeeDetected: row.explicitFeeDetected,
            explicitTmaFeeDetected: row.explicitTmaFeeDetected,
            explicitExamFeeDetected: row.explicitExamFeeDetected,
            explicitSubjectDetected: row.explicitSubjectDetected,
            explicitTmaDetected: row.explicitTmaDetected,
            explicitPracticalDetected: row.explicitPracticalDetected,
            extraColumns: mergedExtraColumns,
            rowColor: row.rowColor,
            cellColors: row.cellColors,
          };
        }

        const serialNumber = nextSerial++;
        const canReuseRawId =
          Boolean(row.studentId) &&
          /^[a-zA-Z0-9_-]+$/.test(row.studentId) &&
          !usedPayloadIds.has(row.studentId.toLowerCase());
        let sid = canReuseRawId
          ? row.studentId
          : `${CENTRE_MAP[row.centreId].code}-${year}-${String(serialNumber).padStart(4, '0')}-${Math.random()
              .toString(36)
              .slice(2, 5)
              .toUpperCase()}`;
        while (usedPayloadIds.has(sid.toLowerCase())) {
          sid = `${CENTRE_MAP[row.centreId].code}-${year}-${String(serialNumber).padStart(4, '0')}-${Math.random()
            .toString(36)
            .slice(2, 6)
            .toUpperCase()}`;
        }
        usedPayloadIds.add(sid.toLowerCase());

        return {
          operation: 'create',
          serialNumber,
          studentId: sid,
          studentName: row.studentName,
          mobileNumber: row.mobileNumber,
          subject: row.subject,
          tcStatus: row.tcStatus,
          bookStatus: row.bookStatus,
          classAttendanceStatus: row.classAttendanceStatus,
          whyNios: row.whyNios,
          currentEducationStatus: row.currentEducationStatus,
          futurePlanning: row.futurePlanning,
          tmaStatus: row.tmaStatus,
          practicalStatus: row.practicalStatus,
          examinationStatus: row.examinationStatus,
          centreId: row.centreId,
          centreName: row.centreName,
          admissionDate: row.admissionDate,
          additionalRemarks: row.additionalRemarks,
          totalFee: row.totalFee,
          paidAmount: row.paidAmount,
          pendingAmount: row.pendingAmount,
          tmaFee: row.tmaFee,
          examFee: row.examFee,
          recoveryStatus: row.recoveryStatus,
          followUpStatus: row.followUpStatus,
          explicitFeeDetected: row.explicitFeeDetected,
          explicitTmaFeeDetected: row.explicitTmaFeeDetected,
          explicitExamFeeDetected: row.explicitExamFeeDetected,
          explicitSubjectDetected: row.explicitSubjectDetected,
          explicitTmaDetected: row.explicitTmaDetected,
          explicitPracticalDetected: row.explicitPracticalDetected,
          extraColumns: row.extraColumns,
          rowColor: row.rowColor,
          cellColors: row.cellColors,
        };
      });

      const result = await bulkImportStudentsBatch(payloads, currentUser, true, {
        onProgress: (done, total) =>
          setImportStatusText(
            academicSyncOnlyMode
              ? `Syncing ${done}/${total} subjects & statuses...`
              : `Syncing ${done}/${total} students & fees...`,
          ),
        feeSyncOnly: feeSyncOnlyMode,
        academicSyncOnly: academicSyncOnlyMode,
        forceSyncFees: mode === 'fee_sync',
      });
      const totalSkipped = issueRows.length + result.failedRows.length;

      if (result.failedRows.length > 0) {
        const errMsg = `${result.failedRows.length} student row(s) could not be saved (e.g. ${result.failedRows[0]?.studentName || 'Row'}: ${result.failedRows[0]?.error || 'Firestore rejected write'}). ${result.importedCount + result.updatedCount} succeeded.`;
        setImportError(errMsg);
        onError('Some Rows Failed to Upload', errMsg);
        if (result.importedCount > 0 || result.updatedCount > 0 || result.feeSyncedCount > 0) {
          onSuccess(
            `Partial sync: ${result.importedCount} new added, ${result.updatedCount} updated, ${result.failedRows.length} failed.`,
          );
        }
      } else {
        if (!feeSyncOnlyMode && !academicSyncOnlyMode) {
          const blankAndHeadingOnlyCols = extractBlankAndSparseSheetHeadings(
            activeHeaders,
            columnMapping,
            activeRawRows,
            fallbackCentre,
          );
          if (
            blankAndHeadingOnlyCols.length > 0 &&
            (currentUser.role === 'super_admin' || currentUser.role === 'centre_head')
          ) {
            await mergeCustomColumnsIntoSharedConfig(
              blankAndHeadingOnlyCols,
              currentUser,
              `Preserved heading-only/blank columns from ${fileName || 'Excel import'}`,
            ).catch(() => {});
          }

          const lkgImportedKeys: string[] = [];
          const lkgSeen = new Set<string>();
          for (const row of readyRows) {
            if (row.centreId !== 'vp_lookerganj') continue;
            for (const k of Object.keys(row.extraColumns)) {
              if (!lkgSeen.has(k)) {
                lkgSeen.add(k);
                lkgImportedKeys.push(k);
              }
            }
          }
          if (lkgImportedKeys.length > 0) {
            const merged = [...lkgImportedKeys];
            for (const oldKey of loadStoredCommonBranchHeaders()) {
              if (!lkgSeen.has(oldKey)) {
                lkgSeen.add(oldKey);
                merged.push(oldKey);
              }
            }
            saveCommonBranchHeaders(merged);
          }
        }

        const summaryMsg = feeSyncOnlyMode
          ? `Fee sync complete: ${result.feeSyncedCount} student fee records updated, ${result.importedCount} new added${
              totalSkipped > 0 ? `, ${totalSkipped} skipped` : ''
            }.`
          : academicSyncOnlyMode
            ? `Subjects & status sync complete: ${result.updatedCount} existing updated, ${result.importedCount} new added${
                totalSkipped > 0 ? `, ${totalSkipped} skipped` : ''
              }.`
            : `Excel sync complete: ${result.importedCount} new added, ${result.updatedCount} existing updated, ${result.feeSyncedCount} fee records synced${
                totalSkipped > 0 ? `, ${totalSkipped} skipped` : ''
              }.`;

        onSuccess(summaryMsg);
        setRawSheets({});
        setHeadersBySheet({});
        setRowColorsBySheet({});
        setSummaryRowsFilteredBySheet({});
        setExcludedSummaryRowsBySheet({});
        setIncludeExcludedRows(false);
        setAllowDuplicateRowsInSheet(false);
        setPreviewFilter('all');
        setSheetNames([]);
        setActiveSheet('');
        setFileName('');
        setEditedOverrides({});
        setImportMode('upsert');
        onClose();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Import failed.';
      setImportError(msg);
      onError('Bulk Import Error', msg);
    } finally {
      setImporting(false);
      setImportStatusText('');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#090d1b]/80 backdrop-blur-sm p-3 sm:p-5">
      <div className="bg-white/98 backdrop-blur-xl rounded-2xl border border-slate-200 shadow-2xl max-w-6xl w-full max-h-[92vh] flex flex-col overflow-hidden text-[#0F172A]">
        {/* Header */}
        <div className="flex items-start justify-between gap-4 px-6 py-4 glass-dark-panel border-b border-rose-400/20 text-white shrink-0">
          <div>
            <h3 className="text-lg font-bold text-white flex items-center gap-2">
              <FileSpreadsheet className="w-5 h-5 text-[#FBBF24]" />
              {mode === 'fee_sync'
                ? 'Update Student Fees from Excel'
                : mode === 'academic_sync'
                  ? defaultAcademicType === 'practical'
                    ? 'Update Subjects & Practical Status from Excel'
                    : 'Update Subjects & TMA Status from Excel'
                  : 'Bulk Excel & CSV Student Import'}
            </h3>
            <p className="text-xs text-slate-200/85 mt-0.5">
              {mode === 'fee_sync'
                ? 'Matches students by Name/Mobile across branches and updates Total, Paid (Jama) & Pending (Baki) safely.'
                : mode === 'academic_sync'
                  ? 'Matches students by Name/Mobile and updates real Subjects (single or Sub 1–5) & TMA/Practical status without touching fees or custom columns.'
                  : 'Supports .xlsx, .xls, .ods, .csv (all Excel columns & cell colours preserved!)'}{' '}
              ·{' '}
              {isSuperAdmin ? (
                <span>Super Admin Mode: Multi-centre Excel supported</span>
              ) : (
                <span>
                  Target Branch: <strong className="text-[#FBBF24]">{CENTRE_MAP[currentUser.centreId].name}</strong>
                </span>
              )}
            </p>
          </div>
          <button type="button" onClick={onClose} className="text-slate-200 hover:text-white p-1">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="p-5 space-y-4 overflow-y-auto flex-1">
          {/* Templates & File Picker */}
          <div className="flex flex-wrap items-center justify-between gap-3 p-3 rounded-xl bg-slate-50 border border-slate-200">
            <div className="flex items-center gap-2.5 text-xs text-slate-700">
              <FileSpreadsheet className="w-4 h-4 text-[#B45309] shrink-0" />
              <span>
                Upload your existing Excel sheet directly — all rows, columns, fees &amp; row/cell colours save to Firestore.
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={handleDownloadExcelTemplate}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold text-emerald-900 bg-emerald-50 border border-emerald-300 rounded-lg hover:bg-emerald-100"
              >
                <Download className="w-3.5 h-3.5" />
                Sample .xlsx
              </button>
              <button
                type="button"
                onClick={handleDownloadCsvTemplate}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-[#08152E] bg-white border border-slate-300 rounded-lg hover:bg-slate-100"
              >
                <Download className="w-3.5 h-3.5" />
                Sample .csv
              </button>
            </div>
          </div>

          {/* Import Behavior & Centre Settings */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 p-3 rounded-xl bg-sky-50/70 border border-sky-200">
            {isSuperAdmin && (
              <>
                <div>
                  <label className="block text-[11px] font-bold uppercase tracking-wider text-[#0B2454] mb-1">
                    Fallback / Default Centre
                  </label>
                  <select
                    value={selectedCentre}
                    onChange={(e) => setSelectedCentre(e.target.value as CentreId)}
                    className="w-full px-3 py-2 text-xs bg-white text-[#08152E] font-semibold border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#0F2F6B]"
                  >
                    {CANONICAL_CENTRES.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name} ({c.code})
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex items-end">
                  <label className="flex items-center gap-2.5 text-xs font-semibold text-[#08152E] bg-white px-3 py-2 rounded-lg border border-slate-300 w-full cursor-pointer">
                    <input
                      type="checkbox"
                      checked={autoDetectCentre}
                      onChange={(e) => setAutoDetectCentre(e.target.checked)}
                      className="rounded border-slate-300 text-[#B91C1C] focus:ring-[#B91C1C]"
                    />
                    <span>Auto-detect Centre column</span>
                  </label>
                </div>
              </>
            )}

            <div>
              <label className="block text-[11px] font-bold uppercase tracking-wider text-[#0B2454] mb-1">
                Excel Upload / Update Mode
              </label>
              <select
                value={importMode}
                onChange={(e) =>
                  setImportMode(e.target.value as 'upsert' | 'skip_duplicates' | 'replace_all')
                }
                className="w-full px-3 py-2 text-xs bg-white text-[#08152E] font-semibold border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#0F2F6B]"
              >
                <option value="upsert">Add New &amp; Update Existing Rows (Sync Fees)</option>
                <option value="skip_duplicates">Add New Rows Only (Skip Existing)</option>
                {isSuperAdmin && studentsToReplace.length > 0 && (
                  <option value="replace_all">
                    Fresh Re-Upload (Delete All {studentsToReplace.length}{' '}
                    {effectiveBranchLocked ? CENTRE_MAP[fallbackCentre].code : 'Existing'})
                  </option>
                )}
              </select>
            </div>
          </div>

          {/* File Picker Dropzone */}
          <label className="flex flex-col items-center justify-center border-2 border-dashed border-slate-300 rounded-xl p-4 cursor-pointer hover:border-[#DC2626] hover:bg-rose-50/30 transition-colors">
            <Upload className="w-6 h-6 text-[#DC2626] mb-1.5" />
            <span className="text-sm font-semibold text-[#08152E]">
              {parsing
                ? 'Reading Excel workbook...'
                : fileName
                  ? `Selected: ${fileName} (Click to upload a different file)`
                  : 'Choose Excel (.xlsx, .xls, .ods) or CSV (.csv) file'}
            </span>
            <span className="text-xs text-slate-600 mt-0.5">
              {previewRows.length > 0
                ? `${readyRows.length} ready of ${previewRows.length} student rows · ${activeHeaders.length} columns · ${newReadyCount} new + ${updateReadyCount} updates${
                    issueRows.length > 0 ? ` · ${issueRows.length} skipped` : ''
                  }`
                : 'Auto-detects Paid (Jama), Pending (Baki), Total Fee, Excel Colours & custom columns'}
            </span>
            <input
              type="file"
              accept=".xlsx,.xls,.xlsm,.xlsb,.ods,.csv,.tsv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv"
              onChange={handleFileChange}
              className="hidden"
            />
          </label>

          {(parseError || importError) && (
            <div className="flex items-start gap-2.5 p-3.5 rounded-xl bg-red-50 border border-red-300 text-xs text-red-900">
              <AlertCircle className="w-4 h-4 text-red-700 shrink-0 mt-0.5" />
              <div className="space-y-0.5">
                <p className="font-bold">{importError ? 'Import Error' : 'File Read Error'}</p>
                <p>{importError || parseError}</p>
              </div>
            </div>
          )}

          {feeMissingWarning && (
            <div className="flex items-start gap-2.5 p-3.5 rounded-xl bg-amber-50 border-2 border-amber-400 text-xs text-amber-950">
              <AlertCircle className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
              <div className="space-y-1">
                <p className="font-bold">
                  {hasAnyMappedFeeColumn
                    ? 'Selected fee columns appear empty (₹0 across all rows)'
                    : 'Fee columns were not auto-detected from this Excel sheet'}
                </p>
                <p>
                  {mode === 'fee_sync'
                    ? 'Please pick your sheet’s Total Fee, Paid (Jama), or Pending (Baki) column in the Column Mapping dropdowns below so real pending fees calculate properly.'
                    : 'Your file does not have a recognized Total Fee / Paid / Pending column mapped yet. Select them below or leave ₹0 if fees will be updated separately.'}
                </p>
              </div>
            </div>
          )}

          {/* Column Mapper + Full Spreadsheet Preview */}
          {activeRawRows.length > 0 && (
            <div className="space-y-3">
              {/* Mathematical Fee & Sync Detection Banner */}
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-7 gap-2.5 p-3 rounded-xl bg-slate-900 text-white text-xs">
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-slate-300">Rows to Sync</p>
                  <p className="font-mono font-bold text-sm mt-0.5">
                    {newReadyCount} New · {updateReadyCount} Upd
                  </p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-slate-300">Total Fee</p>
                  <p className="font-mono font-bold text-sm mt-0.5">₹{feeSummary.total.toLocaleString('en-IN')}</p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-emerald-300">Paid (Jama)</p>
                  <p className="font-mono font-bold text-sm text-emerald-400 mt-0.5">
                    ₹{feeSummary.paid.toLocaleString('en-IN')}
                  </p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-rose-300">Pending (Baki)</p>
                  <p className="font-mono font-bold text-sm text-rose-400 mt-0.5">
                    ₹{feeSummary.pending.toLocaleString('en-IN')}
                  </p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-amber-300">TMA Fees</p>
                  <p className="font-mono font-bold text-sm text-amber-300 mt-0.5">
                    ₹{feeSummary.tmaFee.toLocaleString('en-IN')}
                  </p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-sky-300">Exam Fees</p>
                  <p className="font-mono font-bold text-sm text-sky-300 mt-0.5">
                    ₹{feeSummary.examFee.toLocaleString('en-IN')}
                  </p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-amber-300">Collection</p>
                  <p className="font-mono font-bold text-sm text-[#FBBF24] mt-0.5">{feeSummary.pct}%</p>
                </div>
              </div>

              {/* Fee Sync Mapping & Match Diagnostics */}
              <div className="px-3.5 py-2.5 rounded-xl bg-slate-100 border border-slate-300 text-[11px] text-slate-800 flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span>
                    <strong>Detected Columns:</strong> Name=
                    <span className="font-mono text-[#0F2F6B]">
                      {columnMapping.studentName || 'Not Selected'}
                    </span>
                  </span>
                  <span>
                    Total=
                    <span className="font-mono text-[#0F2F6B]">{columnMapping.totalFee || 'None'}</span>
                  </span>
                  <span>
                    Paid=
                    <span className="font-mono text-emerald-700">{columnMapping.paidAmount || 'None'}</span>
                  </span>
                  <span>
                    Pending=
                    <span className="font-mono text-rose-700">{columnMapping.pendingAmount || 'None'}</span>
                  </span>
                  {readyCentreCounts.length > 0 && (
                    <span>
                      Target Branch=
                      <span className="font-mono font-bold text-[#0F2F6B]">
                        {readyCentreCounts.map((c) => `${c.centre.code}: ${c.count}`).join(' · ')}
                      </span>
                    </span>
                  )}
                </div>
                <div className="font-mono font-semibold text-slate-900">
                  Matched DB: <span className="text-blue-700">{updateReadyCount}</span> · Paid:{' '}
                  <span className="text-emerald-700">{paidReadyCount}</span> · Unpaid:{' '}
                  <span className="text-rose-700">
                    {unpaidReadyCount}
                    {rowsWithPendingDueCount > 0 ? ` (${rowsWithPendingDueCount} with Baki)` : ''}
                  </span>
                </div>
              </div>

              {isSuperAdmin && rowsOutsideSelectedCentreCount > 0 && (
                <div className="flex flex-wrap items-center justify-between gap-2.5 p-3 rounded-xl bg-amber-50 border border-amber-400 text-xs text-amber-950">
                  <div className="flex items-start gap-2">
                    <AlertCircle className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
                    <p>
                      <strong>{rowsOutsideSelectedCentreCount} ready row(s)</strong> are currently routed to other branches instead of{' '}
                      <strong>{CENTRE_MAP[fallbackCentre].name}</strong>.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setAutoDetectCentre(false)}
                    className="px-3 py-1.5 text-xs font-bold bg-[#0F2F6B] text-white rounded-lg hover:bg-[#172554]"
                  >
                    Send All {readyRows.length} Rows to {CENTRE_MAP[fallbackCentre].code}
                  </button>
                </div>
              )}

              {(mode === 'fee_sync' || mode === 'academic_sync') && readyRows.length > 0 && updateReadyCount === 0 && (
                <div className="flex items-start gap-2.5 p-3 rounded-xl bg-amber-50 border border-amber-400 text-xs text-amber-950">
                  <AlertCircle className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
                  <div>
                    <p className="font-bold">0 existing students matched in database!</p>
                    <p>
                      Check <strong>Fallback / Default Centre</strong> above or verify the{' '}
                      <strong>Student Name</strong> &amp; <strong>Mobile No</strong> column mapping below — otherwise{' '}
                      {newReadyCount} new student entries will be created instead of updating existing students.
                    </p>
                  </div>
                </div>
              )}

              {/* Toolbar */}
              <div className="flex flex-wrap items-center justify-between gap-2.5">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <button
                    type="button"
                    onClick={() => setPreviewFilter('all')}
                    className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border font-bold transition-colors ${
                      previewFilter === 'all'
                        ? 'bg-[#0F172A] text-white border-[#0F172A]'
                        : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-100'
                    }`}
                  >
                    All ({previewRows.length})
                  </button>
                  <button
                    type="button"
                    onClick={() => setPreviewFilter((f) => (f === 'ready' ? 'all' : 'ready'))}
                    className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border font-bold transition-colors ${
                      previewFilter === 'ready'
                        ? 'bg-emerald-700 text-white border-emerald-700'
                        : 'bg-emerald-50 text-emerald-800 border-emerald-200 hover:bg-emerald-100'
                    }`}
                  >
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    {readyRows.length} Ready
                  </button>
                  {coloredRowsCount > 0 && (
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-indigo-50 text-indigo-900 border border-indigo-200 font-bold">
                      {coloredRowsCount} Colored Rows Detected
                    </span>
                  )}
                  {(activeSummaryFiltered > 0 || (includeExcludedRows && activeExcludedRows.length > 0)) && (
                    <button
                      type="button"
                      onClick={() => setIncludeExcludedRows((v) => !v)}
                      title="Click to include or exclude detected summary/footer row"
                      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border font-semibold transition-colors ${
                        includeExcludedRows
                          ? 'bg-emerald-50 text-emerald-900 border-emerald-300'
                          : 'bg-slate-100 text-slate-700 border-slate-300 hover:bg-slate-200'
                      }`}
                    >
                      {includeExcludedRows
                        ? `Included ${activeExcludedRows.length} Footer Row (Click to Exclude)`
                        : `${activeSummaryFiltered} Footer Total Row Excluded (Click to Include)`}
                    </button>
                  )}
                  {issueRows.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setPreviewFilter((f) => (f === 'issues' ? 'all' : 'issues'))}
                      title="Click to inspect all skipped rows and fix or include them"
                      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border font-bold transition-colors ${
                        previewFilter === 'issues'
                          ? 'bg-amber-600 text-white border-amber-600'
                          : 'bg-amber-50 text-amber-900 border-amber-300 hover:bg-amber-100'
                      }`}
                    >
                      <AlertCircle className="w-3.5 h-3.5" />
                      {issueRows.length} Skipped / Fix Needed (Click to View)
                    </button>
                  )}
                  {(duplicateIssueCount > 0 || allowDuplicateRowsInSheet) && (
                    <label className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-rose-50 text-rose-900 border border-rose-200 font-bold cursor-pointer">
                      <input
                        type="checkbox"
                        checked={allowDuplicateRowsInSheet}
                        onChange={(e) => setAllowDuplicateRowsInSheet(e.target.checked)}
                        className="rounded border-rose-300 text-[#B91C1C]"
                      />
                      Import All Repeat/Duplicate Rows ({duplicateIssueCount > 0 ? `+${duplicateIssueCount}` : 'All'})
                    </label>
                  )}
                  <label className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-slate-100 text-[#08152E] border border-slate-200 font-semibold cursor-pointer">
                    <input
                      type="checkbox"
                      checked={allowMissingMobile}
                      onChange={(e) => setAllowMissingMobile(e.target.checked)}
                      className="rounded border-slate-300 text-[#B91C1C]"
                    />
                    Auto-fill missing Mobile No
                  </label>
                  {(mode === 'fee_sync' || (mode === 'full' && updateReadyCount > 0)) && (
                    <label
                      title="Recommended when updating fees: preserves existing subjects, TMA, practical, attendance, colors and custom columns."
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-emerald-50 text-emerald-950 border border-emerald-300 font-bold cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={feeSyncOnlyMode}
                        onChange={(e) => setFeeSyncOnlyMode(e.target.checked)}
                        className="rounded border-emerald-400 text-emerald-700"
                      />
                      Keep Subjects, Attendance &amp; Custom Cols Untouched (Update Fees Only)
                    </label>
                  )}
                  {mode === 'academic_sync' && (
                    <label
                      title="Preserves fees, colors, and other Student Database custom columns while updating Subjects & TMA/Practical status."
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-indigo-50 text-indigo-950 border border-indigo-300 font-bold cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={academicSyncOnlyMode}
                        onChange={(e) => setAcademicSyncOnlyMode(e.target.checked)}
                        className="rounded border-indigo-400 text-indigo-700"
                      />
                      Update Subjects &amp; Status Only (Preserve Fees &amp; Custom Cols)
                    </label>
                  )}
                  {(mode === 'fee_sync' || mode === 'academic_sync') && updateReadyCount > 0 && newReadyCount > 0 && (
                    <label
                      title="If checked, only updates matched existing students and skips unmatched new rows."
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-sky-50 text-sky-950 border border-sky-300 font-bold cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={skipUnmatchedNewInFeeSync}
                        onChange={(e) => setSkipUnmatchedNewInFeeSync(e.target.checked)}
                        className="rounded border-sky-400 text-sky-700"
                      />
                      Update Matched Only (Skip {newReadyCount} Unmatched)
                    </label>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setShowColumnMapper((v) => !v)}
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-lg border ${
                      showColumnMapper || !columnMapping.studentName
                        ? 'bg-[#0F2F6B] text-white border-[#0F2F6B]'
                        : 'bg-white text-[#08152E] border-slate-300 hover:bg-slate-100'
                    }`}
                  >
                    <SlidersHorizontal className="w-3.5 h-3.5" />
                    {columnMapping.studentName ? 'Match Excel Columns' : 'Select Student Name Column*'}
                  </button>

                  {sheetNames.length > 1 && (
                    <select
                      value={activeSheet}
                      onChange={(e) => applySheetSelection(e.target.value, rawSheets, headersBySheet)}
                      className="px-2.5 py-1.5 text-xs bg-white border border-slate-300 rounded-lg font-semibold text-[#08152E]"
                    >
                      {sheetNames.map((s) => (
                        <option key={s} value={s}>
                          {s === ALL_SHEETS_KEY
                            ? `All Sheets Combined (${(rawSheets[s] || []).length} rows)`
                            : `Sheet: ${s} (${(rawSheets[s] || []).length} rows)`}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              </div>

              {/* Interactive Column Mapper */}
              {(showColumnMapper || !columnMapping.studentName) && (
                <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-300 space-y-2.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-xs font-bold text-[#08152E]">
                      Smart Auto-Mapped Columns (all Excel columns up to 35 are also preserved)
                    </p>
                    {commonExtraHeadings.length > 0 && (
                      <span className="inline-flex items-center px-2 py-0.5 rounded-md bg-emerald-50 border border-emerald-200 text-[11px] font-bold text-emerald-800">
                        Common Lookerganj Headings Synced ({commonExtraHeadings.length})
                      </span>
                    )}
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5">
                    {(
                      [
                        { key: 'studentName', label: 'Student Name *' },
                        { key: 'mobileNumber', label: 'Mobile No' },
                        { key: 'studentId', label: 'Unique ID / Enrol' },
                        { key: 'centre', label: 'Centre / Branch' },
                        { key: 'subject', label: 'Subjects / Course' },
                        { key: 'tmaStatus', label: 'TMA Status' },
                        { key: 'practicalStatus', label: 'Practical Status' },
                        { key: 'classAttendanceStatus', label: 'Attendance' },
                        { key: 'totalFee', label: 'Total Fee' },
                        { key: 'paidAmount', label: 'Paid (Jama)' },
                        { key: 'pendingAmount', label: 'Pending / Left Fees (Unpaid)' },
                        { key: 'tmaFee', label: 'TMA Fee' },
                        { key: 'examFee', label: 'Exam Fee' },
                        { key: 'feeStatus', label: 'Fee Status' },
                        { key: 'admissionDate', label: 'Admission Date' },
                        { key: 'additionalRemarks', label: 'Remarks / Notes' },
                      ] as Array<{ key: keyof ExcelColumnMapping; label: string }>
                    ).map((field) => (
                      <div key={field.key}>
                        <label className="block text-[10px] font-bold uppercase text-slate-600 mb-1">
                          {field.label}
                        </label>
                        <select
                          value={columnMapping[field.key] || ''}
                          onChange={(e) =>
                            setColumnMapping((prev) => ({
                              ...prev,
                              [field.key]: e.target.value || undefined,
                            }))
                          }
                          className="w-full px-2 py-1.5 text-xs bg-white border border-slate-300 rounded-lg text-[#08152E] font-medium"
                        >
                          <option value="">-- Auto / None --</option>
                          {activeHeaders.map((h) => {
                            const sample = columnSampleMap.get(h);
                            return (
                              <option key={h} value={h}>
                                {sample ? `${h} (e.g. ${sample})` : h}
                              </option>
                            );
                          })}
                        </select>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Auto-surfaced Inspector for Any Skipped / Excluded Rows */}
              {(issueRows.length > 0 || (!includeExcludedRows && activeExcludedRows.length > 0)) && (
                <div className="p-3.5 rounded-xl bg-amber-50 border border-amber-300 space-y-2.5 text-xs">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2 font-bold text-amber-950">
                      <AlertCircle className="w-4 h-4 text-amber-700 shrink-0" />
                      <span>
                        Why {issueRows.length + (!includeExcludedRows ? activeExcludedRows.length : 0)} row(s) are not yet in Ready ({readyRows.length}):
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {issueRows.some((r) => r.validationError?.includes('Student Name')) && (
                        <button
                          type="button"
                          onClick={() =>
                            setEditedOverrides((prev) => {
                              const next = { ...prev };
                              for (const row of issueRows) {
                                if (!row.validationError?.includes('Student Name')) continue;
                                const filled = Object.entries(row.raw)
                                  .map(([k, v]) => [k, String(v ?? '').trim()] as const)
                                  .filter(([, v]) => v.length > 0);
                                const suggestion =
                                  filled.find(([k, v]) => /father|guardian|candidate|name|remark/i.test(k) && v.length >= 2)?.[1] ||
                                  `Student #${row.rowIndex}`;
                                next[row.origIndex] = {
                                  ...next[row.origIndex],
                                  studentName: suggestion.slice(0, 120),
                                };
                              }
                              return next;
                            })
                          }
                          className="px-2.5 py-1 text-[11px] font-bold bg-[#0F2F6B] text-white rounded-lg hover:bg-[#172554]"
                        >
                          Auto-Fix All Blank Names
                        </button>
                      )}
                      {duplicateIssueCount > 0 && !allowDuplicateRowsInSheet && (
                        <button
                          type="button"
                          onClick={() => setAllowDuplicateRowsInSheet(true)}
                          className="px-2.5 py-1 text-[11px] font-bold bg-rose-700 text-white rounded-lg hover:bg-rose-800"
                        >
                          Include All {duplicateIssueCount} Duplicate Rows
                        </button>
                      )}
                      {!includeExcludedRows && activeExcludedRows.length > 0 && (
                        <button
                          type="button"
                          onClick={() => setIncludeExcludedRows(true)}
                          className="px-2.5 py-1 text-[11px] font-bold bg-emerald-700 text-white rounded-lg hover:bg-emerald-800"
                        >
                          Include {activeExcludedRows.length} Footer Row
                        </button>
                      )}
                    </div>
                  </div>

                  {issueRows.slice(0, 25).map((row) => {
                    const rowOrigIdx = row.origIndex;
                    const errReason = row.validationError || row.duplicateReason || 'Needs attention';
                    const filledCells = Object.entries(row.raw)
                      .map(([k, v]) => [k, String(v ?? '').trim()] as const)
                      .filter(([, v]) => v.length > 0);
                    const suggestedFallback =
                      filledCells.find(([k, v]) => /father|guardian|candidate|name|remark/i.test(k) && v.length >= 2)?.[1] ||
                      `Student #${row.rowIndex}`;

                    return (
                      <div
                        key={`issue-${rowOrigIdx}`}
                        className="p-2.5 rounded-lg bg-white border border-amber-200 flex flex-col lg:flex-row lg:items-center justify-between gap-2"
                      >
                        <div className="space-y-1 min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-950 font-mono font-bold">
                              Row #{row.rowIndex}
                            </span>
                            <span className="font-bold text-rose-700">{errReason}</span>
                          </div>
                          <p className="text-[11px] text-slate-600 truncate">
                            {filledCells.length > 0
                              ? filledCells
                                  .slice(0, 8)
                                  .map(([k, v]) => `${k}: ${v}`)
                                  .join(' · ')
                              : 'Empty row'}
                          </p>
                        </div>

                        {row.validationError?.includes('Student Name') && (
                          <div className="flex flex-wrap items-center gap-2 shrink-0">
                            <input
                              type="text"
                              value={editedOverrides[rowOrigIdx]?.studentName ?? row.studentName}
                              onChange={(e) =>
                                setEditedOverrides((prev) => ({
                                  ...prev,
                                  [rowOrigIdx]: { ...prev[rowOrigIdx], studentName: e.target.value },
                                }))
                              }
                              placeholder="Type Student Name..."
                              className="px-2.5 py-1 text-xs bg-white border border-amber-400 rounded-lg font-semibold text-[#08152E] w-44"
                            />
                            <button
                              type="button"
                              onClick={() =>
                                setEditedOverrides((prev) => ({
                                  ...prev,
                                  [rowOrigIdx]: {
                                    ...prev[rowOrigIdx],
                                    studentName: suggestedFallback.slice(0, 120),
                                  },
                                }))
                              }
                              className="px-2.5 py-1 text-[11px] font-bold bg-[#0F2F6B] text-white rounded-lg hover:bg-[#172554]"
                            >
                              Auto-Fix (&ldquo;{suggestedFallback.slice(0, 18)}&rdquo;)
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}

                  {!includeExcludedRows &&
                    activeExcludedRows.slice(0, 3).map((ex, exIdx) => {
                      const exCells = Object.entries(ex.row)
                        .map(([k, v]) => [k, String(v ?? '').trim()] as const)
                        .filter(([, v]) => v.length > 0);
                      return (
                        <div
                          key={`excl-${exIdx}`}
                          className="p-2.5 rounded-lg bg-white/90 border border-slate-300 flex flex-col sm:flex-row sm:items-center justify-between gap-2"
                        >
                          <div className="space-y-0.5 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="px-1.5 py-0.5 rounded bg-slate-200 text-slate-800 font-bold text-[10px] uppercase">
                                Auto-Excluded Footer / Summary Row
                              </span>
                            </div>
                            <p className="text-[11px] text-slate-700 truncate">
                              {exCells
                                .slice(0, 8)
                                .map(([k, v]) => `${k}: ${v}`)
                                .join(' · ')}
                            </p>
                          </div>
                          <button
                            type="button"
                            onClick={() => setIncludeExcludedRows(true)}
                            className="px-2.5 py-1 text-[11px] font-bold bg-slate-800 text-white rounded-lg hover:bg-slate-900 shrink-0"
                          >
                            Include If Student
                          </button>
                        </div>
                      );
                    })}
                </div>
              )}

              {/* Full Excel Spreadsheet Preview */}
              <div className="border border-slate-300 rounded-xl overflow-hidden bg-white">
                <div className="max-h-72 overflow-auto">
                  <table className="w-full text-left text-xs border-collapse">
                    <thead className="bg-[#0F172A] text-white sticky top-0 z-10">
                      <tr>
                        <th className="px-2.5 py-2 font-semibold border-r border-slate-700">#</th>
                        <th className="px-2.5 py-2 font-semibold border-r border-slate-700 min-w-[160px]">
                          Student Name*
                        </th>
                        <th className="px-2.5 py-2 font-semibold border-r border-slate-700 min-w-[115px]">
                          Mobile (Masked)
                        </th>
                        <th className="px-2.5 py-2 font-semibold border-r border-slate-700 whitespace-nowrap">
                          Target Centre
                        </th>
                        <th className="px-2.5 py-2 font-semibold border-r border-slate-700 whitespace-nowrap bg-[#172554]">
                          Total Fee
                        </th>
                        <th className="px-2.5 py-2 font-semibold border-r border-slate-700 whitespace-nowrap bg-[#172554]">
                          Paid (Jama)
                        </th>
                        <th className="px-2.5 py-2 font-semibold border-r border-slate-700 whitespace-nowrap bg-[#172554]">
                          Pending (Baki)
                        </th>
                        <th className="px-2.5 py-2 font-semibold border-r border-slate-700 whitespace-nowrap bg-[#172554]">
                          TMA Fee
                        </th>
                        <th className="px-2.5 py-2 font-semibold border-r border-slate-700 whitespace-nowrap bg-[#172554]">
                          Exam Fee
                        </th>
                        <th className="px-2.5 py-2 font-semibold border-r border-slate-700 whitespace-nowrap bg-[#172554]">
                          Fee Status
                        </th>
                        {extraPreviewHeaders.map((h) => (
                          <th
                            key={h}
                            className="px-2.5 py-2 font-semibold border-r border-slate-700 whitespace-nowrap bg-[#1E293B]"
                          >
                            {alignHeaderToCommonSchema(h, commonExtraHeadings)}
                          </th>
                        ))}
                        <th className="px-2.5 py-2 font-semibold whitespace-nowrap">Sync Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200 bg-white">
                      {visiblePreviewRows.map((row) => {
                        const rowOrigIdx = row.origIndex;
                        const errMsg = row.validationError || row.duplicateReason;
                        const getCellPreviewStyle = (fieldKey: string): React.CSSProperties | undefined => {
                          const bg = row.cellColors?.[fieldKey] || row.rowColor;
                          if (!bg) return undefined;
                          return { backgroundColor: bg, color: getReadableTextColor(bg) };
                        };
                        return (
                          <tr
                            key={`${rowOrigIdx}-${row.studentId}`}
                            style={
                              !errMsg && row.rowColor
                                ? { backgroundColor: row.rowColor, color: getReadableTextColor(row.rowColor) }
                                : undefined
                            }
                            className={
                              errMsg
                                ? 'bg-amber-50/75'
                                : row.rowColor
                                  ? ''
                                  : row.operation === 'update'
                                    ? 'bg-sky-50/50 hover:bg-sky-50'
                                    : 'hover:bg-slate-50'
                            }
                          >
                            <td
                              style={getCellPreviewStyle('serialNumber')}
                              className="px-2.5 py-1.5 font-mono text-slate-500 border-r border-slate-200"
                            >
                              {row.rowIndex}
                            </td>
                            <td
                              style={getCellPreviewStyle('studentName')}
                              className="px-2 py-1 border-r border-slate-200"
                            >
                              <input
                                type="text"
                                value={editedOverrides[rowOrigIdx]?.studentName ?? row.studentName}
                                onChange={(e) =>
                                  setEditedOverrides((prev) => ({
                                    ...prev,
                                    [rowOrigIdx]: { ...prev[rowOrigIdx], studentName: e.target.value },
                                  }))
                                }
                                placeholder="Enter Name"
                                className="w-full px-2 py-1 text-xs bg-white/90 border border-slate-200 rounded focus:border-[#0F2F6B] focus:outline-none font-semibold text-[#08152E]"
                              />
                            </td>
                            <td
                              style={getCellPreviewStyle('mobileNumber')}
                              className="px-2.5 py-1.5 font-mono text-slate-800 whitespace-nowrap border-r border-slate-200"
                            >
                              {row.validationError?.includes('Mobile') ? (
                                <input
                                  type="text"
                                  value={editedOverrides[rowOrigIdx]?.mobileNumber ?? ''}
                                  onChange={(e) =>
                                    setEditedOverrides((prev) => ({
                                      ...prev,
                                      [rowOrigIdx]: { ...prev[rowOrigIdx], mobileNumber: e.target.value },
                                    }))
                                  }
                                  placeholder="Enter Mobile"
                                  className="w-full px-2 py-1 text-xs font-mono bg-white border border-amber-400 rounded text-[#08152E]"
                                />
                              ) : (
                                maskMobileNumber(row.mobileNumber)
                              )}
                            </td>
                            <td className="px-2.5 py-1.5 font-medium text-[#0B2454] whitespace-nowrap border-r border-slate-200">
                              {CENTRE_MAP[row.centreId].code} · {row.centreName}
                            </td>
                            <td
                              style={getCellPreviewStyle('totalFee')}
                              className="px-2.5 py-1.5 font-mono font-semibold text-slate-900 whitespace-nowrap border-r border-slate-200"
                            >
                              ₹{row.totalFee.toLocaleString('en-IN')}
                            </td>
                            <td
                              style={getCellPreviewStyle('paidAmount')}
                              className="px-2.5 py-1.5 font-mono font-bold text-emerald-700 whitespace-nowrap border-r border-slate-200"
                            >
                              ₹{row.paidAmount.toLocaleString('en-IN')}
                            </td>
                            <td
                              style={getCellPreviewStyle('pendingAmount')}
                              className="px-2.5 py-1.5 font-mono font-bold text-rose-700 whitespace-nowrap border-r border-slate-200"
                            >
                              ₹{row.pendingAmount.toLocaleString('en-IN')}
                            </td>
                            <td
                              style={getCellPreviewStyle('tmaFee')}
                              className="px-2.5 py-1.5 font-mono font-semibold text-amber-800 whitespace-nowrap border-r border-slate-200"
                            >
                              ₹{row.tmaFee.toLocaleString('en-IN')}
                            </td>
                            <td
                              style={getCellPreviewStyle('examFee')}
                              className="px-2.5 py-1.5 font-mono font-semibold text-indigo-800 whitespace-nowrap border-r border-slate-200"
                            >
                              ₹{row.examFee.toLocaleString('en-IN')}
                            </td>
                            <td
                              style={getCellPreviewStyle('feeStatus')}
                              className="px-2.5 py-1.5 whitespace-nowrap border-r border-slate-200"
                            >
                              {(() => {
                                const rowPaid = isFeeFullyPaid(row);
                                return (
                                  <span
                                    style={
                                      row.cellColors?.feeStatus || row.rowColor
                                        ? { color: getReadableTextColor(row.cellColors?.feeStatus || row.rowColor) }
                                        : undefined
                                    }
                                    className={`font-bold ${
                                      row.cellColors?.feeStatus || row.rowColor
                                        ? ''
                                        : rowPaid
                                          ? 'text-emerald-700'
                                          : row.paidAmount > 0 && row.pendingAmount > 0
                                            ? 'text-amber-700'
                                            : 'text-rose-700'
                                    }`}
                                  >
                                    {rowPaid
                                      ? 'Paid'
                                      : row.paidAmount > 0 && row.pendingAmount > 0
                                        ? 'Unpaid (Half Paid)'
                                        : 'Unpaid'}
                                  </span>
                                );
                              })()}
                            </td>
                            {extraPreviewHeaders.map((h) => {
                              const cleanKey = alignHeaderToCommonSchema(h, commonExtraHeadings).trim().slice(0, 50);
                              const extraStyle = getCellPreviewStyle(`extra:${cleanKey}`);
                              return (
                                <td
                                  key={h}
                                  style={extraStyle}
                                  className="px-2.5 py-1.5 text-slate-700 whitespace-nowrap max-w-[200px] truncate border-r border-slate-200"
                                >
                                  {row.raw[h] || '—'}
                                </td>
                              );
                            })}
                            <td className="px-2.5 py-1.5 whitespace-nowrap bg-white/85">
                              {errMsg ? (
                                <span className="text-[11px] font-semibold text-amber-900">{errMsg}</span>
                              ) : row.operation === 'update' && row.matchedExisting ? (
                                (() => {
                                  const prevFee = existingFeeMap.get(row.matchedExisting.studentId);
                                  return (
                                    <span className="text-[11px] font-bold text-blue-700">
                                      Update #{row.matchedExisting.serialNumber}
                                      {mode === 'fee_sync' && prevFee
                                        ? ` (Was ₹${prevFee.pendingAmount.toLocaleString('en-IN')} baki)`
                                        : ''}
                                    </span>
                                  );
                                })()
                              ) : (
                                <span className="text-[11px] font-bold text-emerald-700">New Row</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <div className="px-3 py-1.5 bg-slate-50 border-t border-slate-200 text-[11px] text-slate-600 flex flex-wrap items-center justify-between gap-2">
                  <span>
                    Showing {visiblePreviewRows.length} of {filteredPreviewRows.length} rows in preview (all {readyRows.length} ready rows will be synced into the database).
                  </span>
                  {filteredPreviewRows.length > 500 && !showAllPreviewRows && (
                    <button
                      type="button"
                      onClick={() => setShowAllPreviewRows(true)}
                      className="text-xs font-bold text-[#0F2F6B] hover:underline"
                    >
                      Show All {filteredPreviewRows.length} Rows
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3.5 border-t border-slate-200 bg-slate-50 flex flex-wrap items-center justify-between gap-3 shrink-0">
          <div className="flex flex-wrap items-center gap-2.5 text-[11px] text-slate-600">
            <span>
              Edit Rights: <strong>Super Admin</strong> edits all centres ·{' '}
              <strong>Centre Head</strong> edits own centre · <strong>Workers</strong> edit own department only.
            </span>
            {issueRows.length > 0 && (
              <button
                type="button"
                onClick={() => setPreviewFilter('issues')}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-amber-100 text-amber-950 border border-amber-300 font-bold hover:bg-amber-200"
              >
                <AlertCircle className="w-3 h-3 text-amber-700" />
                {issueRows.length} row(s) skipped ({readyRows.length}/{previewRows.length} uploading) — View
              </button>
            )}
          </div>
          <div className="flex items-center gap-2.5">
            {duplicateIssueCount > 0 && !allowDuplicateRowsInSheet && (
              <button
                type="button"
                onClick={() => setAllowDuplicateRowsInSheet(true)}
                className="px-3 py-2 text-xs font-bold text-rose-900 bg-rose-50 border border-rose-300 rounded-lg hover:bg-rose-100"
              >
                Include +{duplicateIssueCount} Repeat Rows
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              disabled={importing}
              className="px-4 py-2 text-xs font-semibold text-[#08152E] bg-white border border-slate-300 rounded-lg hover:bg-slate-100"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={
                importing ||
                readyRows.length === 0 ||
                ((mode === 'fee_sync' || mode === 'academic_sync') &&
                  skipUnmatchedNewInFeeSync &&
                  updateReadyCount === 0) ||
                (mode === 'fee_sync' && rowsWithAnyFeeCount === 0 && defaultTotalFee === 0)
              }
              onClick={handleImport}
              className="px-5 py-2 text-xs font-bold text-white btn-crimson-gloss rounded-lg disabled:opacity-50"
            >
              {importing
                ? importStatusText || `Syncing ${readyRows.length} Students...`
                : feeSyncOnlyMode
                  ? `Update Fees for ${updateReadyCount} Matched${!skipUnmatchedNewInFeeSync && newReadyCount > 0 ? ` + ${newReadyCount} New` : ''}`
                  : academicSyncOnlyMode
                    ? `Update Subjects for ${updateReadyCount} Matched${!skipUnmatchedNewInFeeSync && newReadyCount > 0 ? ` + ${newReadyCount} New` : ''}`
                    : updateReadyCount > 0
                      ? `Sync ${newReadyCount} New + ${updateReadyCount} Updates`
                      : `Import ${readyRows.length} Students & Open Full Sheet`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
