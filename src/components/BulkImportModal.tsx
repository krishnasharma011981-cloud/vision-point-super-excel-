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
import { maskMobileNumber } from '../lib/analyticsMath';
import {
  cleanMobileNumber,
  exportToCsv,
  exportToExcel,
  fuzzyDetectColumnMapping,
  normalizeImportedStudentRow,
  parseSpreadsheetFile,
  type ExcelColumnMapping,
  type NormalizedImportStudent,
} from '../lib/csvUtils';
import { verifyOperationLocation } from '../lib/securityClient';
import {
  bulkImportStudentsBatch,
  deleteStudentsBatch,
  getNextSerialNumber,
  type BulkImportRowPayload,
} from '../services/firestoreService';
import type { CentreId, Student, UserAccount } from '../types/domain';

interface BulkImportModalProps {
  open: boolean;
  currentUser: UserAccount;
  defaultCentreId: CentreId;
  existingStudents: Student[];
  onClose: () => void;
  onSuccess: (msg: string) => void;
  onError: (title: string, desc: string) => void;
}

export const BulkImportModal: React.FC<BulkImportModalProps> = ({
  open,
  currentUser,
  defaultCentreId,
  existingStudents,
  onClose,
  onSuccess,
  onError,
}) => {
  const isSuperAdmin = currentUser.role === 'super_admin';
  const [selectedCentre, setSelectedCentre] = useState<CentreId>(
    isSuperAdmin ? defaultCentreId : currentUser.centreId,
  );
  const [autoDetectCentre, setAutoDetectCentre] = useState<boolean>(isSuperAdmin);
  const [allowMissingMobile, setAllowMissingMobile] = useState<boolean>(true);
  const [importMode, setImportMode] = useState<'upsert' | 'skip_duplicates' | 'replace_all'>('upsert');
  const [defaultTotalFee, setDefaultTotalFee] = useState<number>(12000);
  const [showColumnMapper, setShowColumnMapper] = useState<boolean>(false);

  const [sheetNames, setSheetNames] = useState<string[]>([]);
  const [activeSheet, setActiveSheet] = useState<string>('');
  const [rawSheets, setRawSheets] = useState<Record<string, Array<Record<string, string>>>>({});
  const [headersBySheet, setHeadersBySheet] = useState<Record<string, string[]>>({});
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
      setImportMode('upsert');
      setImportStatusText('');
      setImportError(null);
      setParseError(null);
    }
  }, [open, defaultCentreId, isSuperAdmin, currentUser.centreId]);

  const fallbackCentre = isSuperAdmin ? selectedCentre : currentUser.centreId;
  const activeHeaders = useMemo(
    () => headersBySheet[activeSheet] || [],
    [headersBySheet, activeSheet],
  );
  const activeRawRows = useMemo(
    () => rawSheets[activeSheet] || [],
    [rawSheets, activeSheet],
  );

  const existingById = useMemo(() => {
    const map = new Map<string, Student>();
    existingStudents.forEach((s) => map.set(s.studentId.trim().toLowerCase(), s));
    return map;
  }, [existingStudents]);

  const existingByCentreMobile = useMemo(() => {
    const map = new Map<string, Student>();
    existingStudents.forEach((s) => {
      const m = cleanMobileNumber(s.mobileNumber);
      if (m.length >= 7 && m.toLowerCase() !== 'not provided') {
        map.set(`${s.centreId}::${m}`, s);
      }
    });
    return map;
  }, [existingStudents]);

  const existingUniqueByCentreName = useMemo(() => {
    const counts = new Map<string, number>();
    const map = new Map<string, Student>();
    existingStudents.forEach((s) => {
      const key = `${s.centreId}::${s.studentName.trim().toLowerCase()}`;
      counts.set(key, (counts.get(key) || 0) + 1);
      map.set(key, s);
    });
    for (const [k, count] of counts.entries()) {
      if (count > 1) map.delete(k);
    }
    return map;
  }, [existingStudents]);

  const previewRows = useMemo<
    Array<
      NormalizedImportStudent & {
        duplicateReason: string | null;
        matchedExisting: Student | null;
        operation: 'create' | 'update';
        raw: Record<string, string>;
      }
    >
  >(() => {
    const seenIds = new Set<string>();
    const seenCentreMobiles = new Set<string>();

    return activeRawRows.map((raw, idx) => {
      const normalized = normalizeImportedStudentRow(
        raw,
        idx + 1,
        fallbackCentre,
        isSuperAdmin && autoDetectCentre,
        columnMapping,
        allowMissingMobile,
        defaultTotalFee,
      );

      const override = editedOverrides[idx];
      if (override?.studentName !== undefined) {
        normalized.studentName = override.studentName.trim().slice(0, 120);
      }
      if (override?.mobileNumber !== undefined) {
        const cleaned = cleanMobileNumber(override.mobileNumber);
        normalized.mobileNumber =
          cleaned.length >= 7 && cleaned.length <= 20
            ? cleaned
            : allowMissingMobile
              ? 'Not Provided'
              : cleaned;
      }

      if (normalized.studentName.length < 2) {
        normalized.validationError = 'Student Name (min 2 chars) required.';
      } else if (normalized.mobileNumber.length < 7 || normalized.mobileNumber.length > 20) {
        normalized.validationError = 'Mobile Number (7–15 digits) required.';
      } else {
        normalized.validationError = null;
      }

      let matchedExisting: Student | null = null;
      if (importMode !== 'replace_all') {
        if (normalized.studentId) {
          matchedExisting = existingById.get(normalized.studentId.toLowerCase()) || null;
        }
        if (
          !matchedExisting &&
          normalized.mobileNumber.length >= 7 &&
          normalized.mobileNumber.toLowerCase() !== 'not provided'
        ) {
          matchedExisting =
            existingByCentreMobile.get(`${normalized.centreId}::${normalized.mobileNumber}`) || null;
        }
        if (!matchedExisting && normalized.studentName.length >= 2) {
          const nameMatch =
            existingUniqueByCentreName.get(
              `${normalized.centreId}::${normalized.studentName.toLowerCase()}`,
            ) || null;
          if (
            nameMatch &&
            (normalized.mobileNumber === 'Not Provided' || nameMatch.mobileNumber === normalized.mobileNumber)
          ) {
            matchedExisting = nameMatch;
          }
        }
      }

      let duplicateReason: string | null = null;
      const sheetIdKey = (matchedExisting?.studentId || normalized.studentId).toLowerCase();
      if (sheetIdKey) {
        if (seenIds.has(sheetIdKey)) {
          duplicateReason = `Duplicate Student ID "${matchedExisting?.studentId || normalized.studentId}" in sheet.`;
        }
        seenIds.add(sheetIdKey);
      }
      if (
        !duplicateReason &&
        normalized.mobileNumber.length >= 7 &&
        normalized.mobileNumber.toLowerCase() !== 'not provided'
      ) {
        const mobKey = `${normalized.centreId}::${normalized.mobileNumber}`;
        if (seenCentreMobiles.has(mobKey)) {
          duplicateReason = `Duplicate mobile ${maskMobileNumber(normalized.mobileNumber)} in sheet.`;
        }
        seenCentreMobiles.add(mobKey);
      }

      if (!duplicateReason && matchedExisting && importMode === 'skip_duplicates') {
        duplicateReason = `Already exists (#${matchedExisting.serialNumber} ${matchedExisting.studentName}).`;
      }

      // Centre Head can only update students belonging to their own centre
      if (
        !duplicateReason &&
        matchedExisting &&
        importMode === 'upsert' &&
        !isSuperAdmin &&
        matchedExisting.centreId !== currentUser.centreId
      ) {
        duplicateReason = 'Matches student in another centre (read-only).';
      }

      const operation: 'create' | 'update' =
        matchedExisting && importMode === 'upsert' ? 'update' : 'create';

      return { ...normalized, duplicateReason, matchedExisting, operation, raw };
    });
  }, [
    activeRawRows,
    fallbackCentre,
    isSuperAdmin,
    autoDetectCentre,
    columnMapping,
    allowMissingMobile,
    defaultTotalFee,
    importMode,
    editedOverrides,
    existingById,
    existingByCentreMobile,
    existingUniqueByCentreName,
    currentUser.centreId,
  ]);

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

  const feeSummary = useMemo(() => {
    const total = readyRows.reduce((s, r) => s + r.totalFee, 0);
    const paid = readyRows.reduce((s, r) => s + r.paidAmount, 0);
    const pending = readyRows.reduce((s, r) => s + r.pendingAmount, 0);
    const pct = total > 0 ? Math.round((paid / total) * 100) : 0;
    return { total, paid, pending, pct };
  }, [readyRows]);

  // Columns beyond Student Name & Mobile No to render the full Excel spreadsheet preview
  const extraPreviewHeaders = useMemo(
    () =>
      activeHeaders.filter(
        (h) => h !== columnMapping.studentName && h !== columnMapping.mobileNumber,
      ),
    [activeHeaders, columnMapping.studentName, columnMapping.mobileNumber],
  );

  if (!open) return null;

  const handleDownloadExcelTemplate = () => {
    exportToExcel(
      'vision-point-student-import-template.xlsx',
      'Students',
      [
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
        'Additional Remarks',
      ],
      [
        [
          'Aarav Sharma',
          '9876543210',
          CENTRE_MAP[fallbackCentre].name,
          'English, Mathematics, Science, Social Science, Hindi',
          'Submitted',
          'Pending',
          'Regular',
          'Received',
          'Received',
          'Not Completed',
          new Date().toISOString().slice(0, 10),
          12000,
          6000,
          'Sample Student Row',
        ],
      ],
    );
  };

  const handleDownloadCsvTemplate = () => {
    exportToCsv(
      'vision-point-student-import-template.csv',
      [
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
        'Additional Remarks',
      ],
      [
        [
          'Aarav Sharma',
          '9876543210',
          CENTRE_MAP[fallbackCentre].name,
          'English, Mathematics, Science, Social Science, Hindi',
          'Submitted',
          'Pending',
          'Regular',
          'Received',
          'Received',
          'Not Completed',
          new Date().toISOString().slice(0, 10),
          12000,
          6000,
          'Sample Student Row',
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
    if (!detected.studentName) {
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
        setActiveSheet('');
        setColumnMapping({});
      } else {
        setSheetNames(result.sheetNames);
        setRawSheets(result.sheets);
        setHeadersBySheet(result.headersBySheet);
        applySheetSelection(result.sheetNames[0], result.sheets, result.headersBySheet);
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

      const shouldReplace = isSuperAdmin && importMode === 'replace_all' && existingStudents.length > 0;
      if (shouldReplace) {
        setImportStatusText(`Clearing existing ${existingStudents.length} records...`);
        await deleteStudentsBatch(existingStudents, currentUser, {
          onProgress: (done, total) => setImportStatusText(`Clearing old records (${done}/${total})...`),
        });
      }

      setImportStatusText(`Syncing ${readyRows.length} students & fees...`);
      let nextSerial = shouldReplace ? 1 : await getNextSerialNumber(existingStudents);
      const year = new Date().getFullYear();

      const payloads: BulkImportRowPayload[] = readyRows.map((row) => {
        if (row.operation === 'update' && row.matchedExisting) {
          return {
            operation: 'update',
            serialNumber: row.matchedExisting.serialNumber,
            studentId: row.matchedExisting.studentId,
            studentName: row.studentName,
            mobileNumber:
              row.mobileNumber === 'Not Provided' && row.matchedExisting.mobileNumber
                ? row.matchedExisting.mobileNumber
                : row.mobileNumber,
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
            recoveryStatus: row.recoveryStatus,
            followUpStatus: row.followUpStatus,
            explicitFeeDetected: row.explicitFeeDetected,
            extraColumns: row.extraColumns,
          };
        }

        const serialNumber = nextSerial++;
        const sid =
          row.studentId && /^[a-zA-Z0-9_-]+$/.test(row.studentId)
            ? row.studentId
            : `${CENTRE_MAP[row.centreId].code}-${year}-${String(serialNumber).padStart(4, '0')}-${Math.random()
                .toString(36)
                .slice(2, 5)
                .toUpperCase()}`;

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
          recoveryStatus: row.recoveryStatus,
          followUpStatus: row.followUpStatus,
          explicitFeeDetected: row.explicitFeeDetected,
          extraColumns: row.extraColumns,
        };
      });

      const result = await bulkImportStudentsBatch(payloads, currentUser, true);
      const totalSkipped = issueRows.length + result.failedRows.length;

      if (result.importedCount === 0 && result.updatedCount === 0 && result.failedRows.length > 0) {
        const errMsg = result.failedRows[0]?.error || 'Firestore denied or rejected the imported rows.';
        setImportError(errMsg);
        onError('Import Rejected', errMsg);
      } else {
        onSuccess(
          `Excel sync complete: ${result.importedCount} new added, ${result.updatedCount} existing updated (fees & graphs synced)${
            totalSkipped > 0 ? `, ${totalSkipped} skipped` : ''
          }.`,
        );
        setRawSheets({});
        setHeadersBySheet({});
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
              Bulk Excel &amp; CSV Student Import
            </h3>
            <p className="text-xs text-slate-200/85 mt-0.5">
              Supports <strong className="text-white">.xlsx, .xls, .ods, .csv</strong> (any custom Excel columns preserved!) ·{' '}
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
                Upload your existing Excel sheet directly — all columns open in the live sheet &amp; save to Firestore.
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
                {isSuperAdmin && existingStudents.length > 0 && (
                  <option value="replace_all">
                    Fresh Re-Upload (Delete All {existingStudents.length} Existing)
                  </option>
                )}
              </select>
            </div>

            <div>
              <label className="block text-[11px] font-bold uppercase tracking-wider text-[#0B2454] mb-1">
                Default Total Fee (If Column Missing)
              </label>
              <input
                type="number"
                min={0}
                value={defaultTotalFee}
                onChange={(e) => setDefaultTotalFee(Math.max(0, Number(e.target.value) || 0))}
                className="w-full px-3 py-2 text-xs font-mono font-bold bg-white text-[#08152E] border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#0F2F6B]"
              />
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
                ? `${previewRows.length} rows found · ${activeHeaders.length} columns · ${newReadyCount} new + ${updateReadyCount} updates`
                : 'Auto-detects Paid (Jama), Pending (Baki), Total Fee & all custom columns'}
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

          {/* Column Mapper + Full Spreadsheet Preview */}
          {activeRawRows.length > 0 && (
            <div className="space-y-3">
              {/* Mathematical Fee & Sync Detection Banner */}
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-2.5 p-3 rounded-xl bg-slate-900 text-white text-xs">
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-slate-300">Rows to Sync</p>
                  <p className="font-mono font-bold text-sm mt-0.5">
                    {newReadyCount} New · {updateReadyCount} Update
                  </p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-slate-300">Detected Total Fee</p>
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
                  <p className="text-[10px] uppercase tracking-wider text-amber-300">Collection Rate</p>
                  <p className="font-mono font-bold text-sm text-[#FBBF24] mt-0.5">{feeSummary.pct}%</p>
                </div>
              </div>

              {/* Toolbar */}
              <div className="flex flex-wrap items-center justify-between gap-2.5">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-emerald-50 text-emerald-800 border border-emerald-200 font-bold">
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    {readyRows.length} Ready
                  </span>
                  {issueRows.length > 0 && (
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-amber-50 text-amber-900 border border-amber-200 font-bold">
                      <AlertCircle className="w-3.5 h-3.5" />
                      {issueRows.length} Skipped / Fix Needed
                    </span>
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
                          Sheet: {s} ({(rawSheets[s] || []).length} rows)
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              </div>

              {/* Interactive Column Mapper */}
              {(showColumnMapper || !columnMapping.studentName) && (
                <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-300 space-y-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs font-bold text-[#08152E]">
                      Column Mapping (All other Excel columns up to 35 are also preserved!)
                    </p>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5">
                    {(
                      [
                        { key: 'studentName', label: 'Student Name *' },
                        { key: 'mobileNumber', label: 'Mobile No' },
                        { key: 'centre', label: 'Centre / Branch' },
                        { key: 'subject', label: 'Subjects / Course' },
                        { key: 'tmaStatus', label: 'TMA Status' },
                        { key: 'practicalStatus', label: 'Practical Status' },
                        { key: 'classAttendanceStatus', label: 'Attendance' },
                        { key: 'totalFee', label: 'Total Fee' },
                        { key: 'paidAmount', label: 'Paid (Jama)' },
                        { key: 'pendingAmount', label: 'Pending (Baki)' },
                        { key: 'feeStatus', label: 'Fee Status' },
                        { key: 'admissionDate', label: 'Admission Date' },
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
                          {activeHeaders.map((h) => (
                            <option key={h} value={h}>
                              {h}
                            </option>
                          ))}
                        </select>
                      </div>
                    ))}
                  </div>
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
                          Fee Status
                        </th>
                        {extraPreviewHeaders.map((h) => (
                          <th
                            key={h}
                            className="px-2.5 py-2 font-semibold border-r border-slate-700 whitespace-nowrap bg-[#1E293B]"
                          >
                            {h}
                          </th>
                        ))}
                        <th className="px-2.5 py-2 font-semibold whitespace-nowrap">Sync Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200 bg-white">
                      {previewRows.slice(0, 150).map((row, idx) => {
                        const errMsg = row.validationError || row.duplicateReason;
                        return (
                          <tr
                            key={`${idx}-${row.studentId}`}
                            className={errMsg ? 'bg-amber-50/75' : row.operation === 'update' ? 'bg-sky-50/50 hover:bg-sky-50' : 'hover:bg-slate-50'}
                          >
                            <td className="px-2.5 py-1.5 font-mono text-slate-500 border-r border-slate-200">
                              {row.rowIndex}
                            </td>
                            <td className="px-2 py-1 border-r border-slate-200">
                              <input
                                type="text"
                                value={editedOverrides[idx]?.studentName ?? row.studentName}
                                onChange={(e) =>
                                  setEditedOverrides((prev) => ({
                                    ...prev,
                                    [idx]: { ...prev[idx], studentName: e.target.value },
                                  }))
                                }
                                placeholder="Enter Name"
                                className="w-full px-2 py-1 text-xs bg-white border border-slate-200 rounded focus:border-[#0F2F6B] focus:outline-none font-semibold text-[#08152E]"
                              />
                            </td>
                            <td className="px-2.5 py-1.5 font-mono text-slate-800 whitespace-nowrap border-r border-slate-200">
                              {row.validationError?.includes('Mobile') ? (
                                <input
                                  type="text"
                                  value={editedOverrides[idx]?.mobileNumber ?? ''}
                                  onChange={(e) =>
                                    setEditedOverrides((prev) => ({
                                      ...prev,
                                      [idx]: { ...prev[idx], mobileNumber: e.target.value },
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
                            <td className="px-2.5 py-1.5 font-mono font-semibold text-slate-900 whitespace-nowrap border-r border-slate-200">
                              ₹{row.totalFee.toLocaleString('en-IN')}
                            </td>
                            <td className="px-2.5 py-1.5 font-mono font-bold text-emerald-700 whitespace-nowrap border-r border-slate-200">
                              ₹{row.paidAmount.toLocaleString('en-IN')}
                            </td>
                            <td className="px-2.5 py-1.5 font-mono font-bold text-rose-700 whitespace-nowrap border-r border-slate-200">
                              ₹{row.pendingAmount.toLocaleString('en-IN')}
                            </td>
                            <td className="px-2.5 py-1.5 whitespace-nowrap border-r border-slate-200">
                              <span
                                className={`font-bold ${
                                  row.recoveryStatus === 'Paid'
                                    ? 'text-emerald-700'
                                    : row.recoveryStatus === 'Partial'
                                      ? 'text-amber-700'
                                      : 'text-rose-700'
                                }`}
                              >
                                {row.recoveryStatus}
                              </span>
                            </td>
                            {extraPreviewHeaders.map((h) => (
                              <td
                                key={h}
                                className="px-2.5 py-1.5 text-slate-700 whitespace-nowrap max-w-[200px] truncate border-r border-slate-200"
                              >
                                {row.raw[h] || '—'}
                              </td>
                            ))}
                            <td className="px-2.5 py-1.5 whitespace-nowrap">
                              {errMsg ? (
                                <span className="text-[11px] font-semibold text-amber-900">{errMsg}</span>
                              ) : row.operation === 'update' ? (
                                <span className="text-[11px] font-bold text-blue-700">
                                  Update #{row.matchedExisting?.serialNumber}
                                </span>
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
                {previewRows.length > 150 && (
                  <div className="px-3 py-1.5 bg-slate-50 border-t border-slate-200 text-[11px] text-slate-600">
                    Showing first 150 of {previewRows.length} rows in preview (all {readyRows.length} ready rows will be synced into the database).
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3.5 border-t border-slate-200 bg-slate-50 flex flex-wrap items-center justify-between gap-3 shrink-0">
          <p className="text-[11px] text-slate-600">
            Edit Rights: <strong>Super Admin</strong> edits all centres ·{' '}
            <strong>Centre Head</strong> edits own centre · <strong>Workers</strong> edit own department only.
          </p>
          <div className="flex items-center gap-2.5">
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
              disabled={importing || readyRows.length === 0}
              onClick={handleImport}
              className="px-5 py-2 text-xs font-bold text-white btn-crimson-gloss rounded-lg disabled:opacity-50"
            >
              {importing
                ? importStatusText || `Syncing ${readyRows.length} Students...`
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
