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
  const [replaceExisting, setReplaceExisting] = useState<boolean>(false);
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
      setReplaceExisting(false);
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

  const existingIds = useMemo(() => {
    const set = new Set<string>();
    existingStudents.forEach((s) => set.add(s.studentId.trim().toLowerCase()));
    return set;
  }, [existingStudents]);

  const existingMobileByCentre = useMemo(() => {
    const set = new Set<string>();
    existingStudents.forEach((s) => {
      const m = cleanMobileNumber(s.mobileNumber);
      if (m.length >= 7 && m.toLowerCase() !== 'not provided') {
        set.add(`${s.centreId}::${m}`);
      }
    });
    return set;
  }, [existingStudents]);

  const previewRows = useMemo<
    Array<NormalizedImportStudent & { duplicateReason: string | null; raw: Record<string, string> }>
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

      let duplicateReason: string | null = null;
      if (normalized.studentId) {
        const idKey = normalized.studentId.toLowerCase();
        if (!replaceExisting && existingIds.has(idKey)) {
          duplicateReason = `Student ID "${normalized.studentId}" already exists.`;
        } else if (seenIds.has(idKey)) {
          duplicateReason = `Duplicate Student ID "${normalized.studentId}" in sheet.`;
        }
        seenIds.add(idKey);
      }
      if (
        !duplicateReason &&
        normalized.mobileNumber.length >= 7 &&
        normalized.mobileNumber.toLowerCase() !== 'not provided'
      ) {
        const mobKey = `${normalized.centreId}::${normalized.mobileNumber}`;
        if (!replaceExisting && existingMobileByCentre.has(mobKey)) {
          duplicateReason = `Mobile ${normalized.mobileNumber} already exists in ${normalized.centreName}.`;
        } else if (seenCentreMobiles.has(mobKey)) {
          duplicateReason = `Duplicate mobile ${normalized.mobileNumber} in sheet.`;
        }
        seenCentreMobiles.add(mobKey);
      }

      return { ...normalized, duplicateReason, raw };
    });
  }, [
    activeRawRows,
    fallbackCentre,
    isSuperAdmin,
    autoDetectCentre,
    columnMapping,
    allowMissingMobile,
    replaceExisting,
    editedOverrides,
    existingIds,
    existingMobileByCentre,
  ]);

  const readyRows = useMemo(
    () => previewRows.filter((r) => !r.validationError && !r.duplicateReason),
    [previewRows],
  );
  const issueRows = useMemo(
    () => previewRows.filter((r) => r.validationError || r.duplicateReason),
    [previewRows],
  );

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

      const shouldReplace = isSuperAdmin && replaceExisting && existingStudents.length > 0;
      if (shouldReplace) {
        setImportStatusText(`Clearing existing ${existingStudents.length} records...`);
        await deleteStudentsBatch(existingStudents, currentUser, {
          onProgress: (done, total) => setImportStatusText(`Clearing old records (${done}/${total})...`),
        });
      }

      setImportStatusText(`Importing ${readyRows.length} students...`);
      let nextSerial = shouldReplace ? 1 : await getNextSerialNumber(existingStudents);
      const year = new Date().getFullYear();

      const payloads: BulkImportRowPayload[] = readyRows.map((row) => {
        const serialNumber = nextSerial++;
        const sid =
          row.studentId && /^[a-zA-Z0-9_-]+$/.test(row.studentId)
            ? row.studentId
            : `${CENTRE_MAP[row.centreId].code}-${year}-${String(serialNumber).padStart(4, '0')}-${Math.random()
                .toString(36)
                .slice(2, 5)
                .toUpperCase()}`;

        return {
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
          extraColumns: row.extraColumns,
        };
      });

      const result = await bulkImportStudentsBatch(payloads, currentUser, true);
      const totalSkipped = issueRows.length + result.failedRows.length;

      if (result.importedCount === 0 && result.failedRows.length > 0) {
        const errMsg = result.failedRows[0]?.error || 'Firestore denied or rejected the imported rows.';
        setImportError(errMsg);
        onError('Import Rejected', errMsg);
      } else {
        onSuccess(
          `Successfully imported ${result.importedCount} student records${
            totalSkipped > 0 ? ` (${totalSkipped} skipped/duplicates)` : ''
          }. Pura Excel database ab live table me khul gaya hai.`,
        );
        setRawSheets({});
        setHeadersBySheet({});
        setSheetNames([]);
        setActiveSheet('');
        setFileName('');
        setEditedOverrides({});
        setReplaceExisting(false);
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

          {isSuperAdmin && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 p-3 rounded-xl bg-sky-50/70 border border-sky-200">
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
                  <span>Auto-detect Centre from Excel &ldquo;Centre&rdquo; column</span>
                </label>
              </div>
              {existingStudents.length > 0 && (
                <div className="sm:col-span-2">
                  <label className="flex items-center gap-2.5 text-xs font-bold text-red-900 bg-red-50/90 px-3 py-2 rounded-lg border border-red-200 w-full cursor-pointer">
                    <input
                      type="checkbox"
                      checked={replaceExisting}
                      onChange={(e) => setReplaceExisting(e.target.checked)}
                      className="rounded border-red-300 text-red-700 focus:ring-red-600"
                    />
                    <span>
                      Clear &amp; replace all existing {existingStudents.length} student records before importing this sheet (Fresh Re-Upload)
                    </span>
                  </label>
                </div>
              )}
            </div>
          )}

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
                ? `${previewRows.length} rows found · ${activeHeaders.length} columns · ${readyRows.length} ready to import`
                : 'Works with MS Excel, Google Sheets, NIOS portals, and UTF-8/UTF-16 CSV'}
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
              {/* Toolbar */}
              <div className="flex flex-wrap items-center justify-between gap-2.5">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-emerald-50 text-emerald-800 border border-emerald-200 font-bold">
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    {readyRows.length} Ready to Import
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
                      Column Mapping (All other Excel columns will also be saved &amp; displayed in the sheet!)
                    </p>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2.5">
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
                        { key: 'paidAmount', label: 'Paid Amount' },
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
                        <th className="px-2.5 py-2 font-semibold border-r border-slate-700 min-w-[125px]">
                          Mobile No
                        </th>
                        <th className="px-2.5 py-2 font-semibold border-r border-slate-700 whitespace-nowrap">
                          Target Centre
                        </th>
                        {extraPreviewHeaders.map((h) => (
                          <th
                            key={h}
                            className="px-2.5 py-2 font-semibold border-r border-slate-700 whitespace-nowrap bg-[#1E293B]"
                          >
                            {h}
                          </th>
                        ))}
                        <th className="px-2.5 py-2 font-semibold whitespace-nowrap">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200 bg-white">
                      {previewRows.slice(0, 150).map((row, idx) => {
                        const errMsg = row.validationError || row.duplicateReason;
                        return (
                          <tr
                            key={`${idx}-${row.studentId}`}
                            className={errMsg ? 'bg-amber-50/75' : 'hover:bg-slate-50'}
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
                            <td className="px-2 py-1 border-r border-slate-200">
                              <input
                                type="text"
                                value={editedOverrides[idx]?.mobileNumber ?? row.mobileNumber}
                                onChange={(e) =>
                                  setEditedOverrides((prev) => ({
                                    ...prev,
                                    [idx]: { ...prev[idx], mobileNumber: e.target.value },
                                  }))
                                }
                                placeholder="Mobile"
                                className="w-full px-2 py-1 text-xs font-mono bg-white border border-slate-200 rounded focus:border-[#0F2F6B] focus:outline-none text-[#08152E]"
                              />
                            </td>
                            <td className="px-2.5 py-1.5 font-medium text-[#0B2454] whitespace-nowrap border-r border-slate-200">
                              {CENTRE_MAP[row.centreId].code} · {row.centreName}
                            </td>
                            {extraPreviewHeaders.map((h) => (
                              <td
                                key={h}
                                className="px-2.5 py-1.5 text-slate-700 whitespace-nowrap max-w-[200px] truncate border-r border-slate-200"
                                title={row.raw[h] || ''}
                              >
                                {row.raw[h] || '—'}
                              </td>
                            ))}
                            <td className="px-2.5 py-1.5 whitespace-nowrap">
                              {errMsg ? (
                                <span className="text-[11px] font-semibold text-amber-900">{errMsg}</span>
                              ) : (
                                <span className="text-[11px] font-bold text-emerald-700">Ready</span>
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
                    Showing first 150 of {previewRows.length} rows in preview (all {readyRows.length} ready rows will be imported into the main database).
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
                ? importStatusText || `Importing ${readyRows.length} Students...`
                : `Import ${readyRows.length} Students & Open Full Sheet`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
