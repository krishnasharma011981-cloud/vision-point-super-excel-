import * as XLSX from 'xlsx';
import { CANONICAL_CENTRES, CENTRE_MAP } from '../constants/centres';
import { clampFeeNumber, parseFeeNumberNullable, reconcileFeeNumbers } from './analyticsMath';
import type {
  BookStatus,
  CentreId,
  ClassAttendanceStatus,
  ExcelSheetConfig,
  ExaminationStatus,
  FeeFollowUpStatus,
  PracticalStatus,
  RecoveryStatus,
  Student,
  TcStatus,
  TmaStatus,
} from '../types/domain';

export function buildContextualSerialMap(
  students: Pick<Student, 'studentId' | 'serialNumber' | 'studentName' | 'centreId'>[],
  scope: CentreId | 'all',
): Map<string, number> {
  const scoped = (scope === 'all' ? students : students.filter((s) => s.centreId === scope))
    .slice()
    .sort((a, b) => {
      const diff = Number(a.serialNumber || 0) - Number(b.serialNumber || 0);
      if (diff !== 0) return diff;
      return a.studentName.localeCompare(b.studentName);
    });
  const map = new Map<string, number>();
  scoped.forEach((s, idx) => {
    map.set(s.studentId, idx + 1);
  });
  return map;
}

export interface SerialOrderUpdate {
  studentId: string;
  serialNumber: number;
}

function buildStrictlyAscendingSlots(orderedRows: ReadonlyArray<{ serialNumber: number }>): number[] {
  const slots: number[] = [];
  for (let i = 0; i < orderedRows.length; i++) {
    const raw = Math.max(1, Math.round(Number(orderedRows[i].serialNumber || 1)));
    const prev = i > 0 ? slots[i - 1] : 0;
    slots.push(Math.max(prev + 1, raw));
  }
  return slots;
}

export function computeStudentOrderFromPermutation<T extends { studentId: string; serialNumber: number }>(
  orderedRows: readonly T[],
  targetOrder: readonly T[],
): SerialOrderUpdate[] {
  if (orderedRows.length < 2 || orderedRows.length !== targetOrder.length) return [];
  const slots = buildStrictlyAscendingSlots(orderedRows);
  const updates: SerialOrderUpdate[] = [];
  for (let i = 0; i < targetOrder.length; i++) {
    const targetSerial = slots[i];
    const currentSerial = Math.round(Number(targetOrder[i].serialNumber || 0));
    if (currentSerial !== targetSerial) {
      updates.push({ studentId: targetOrder[i].studentId, serialNumber: targetSerial });
    }
  }
  return updates;
}

export function computeStudentReorderUpdates<T extends { studentId: string; serialNumber: number }>(
  orderedRows: readonly T[],
  fromIndex: number,
  toIndex: number,
): SerialOrderUpdate[] {
  if (orderedRows.length < 2) return [];
  if (fromIndex < 0 || fromIndex >= orderedRows.length) return [];
  const clampedTo = Math.max(0, Math.min(toIndex, orderedRows.length - 1));
  if (fromIndex === clampedTo) return [];

  const nextOrder = orderedRows.slice();
  const [moved] = nextOrder.splice(fromIndex, 1);
  nextOrder.splice(clampedTo, 0, moved);
  return computeStudentOrderFromPermutation(orderedRows, nextOrder);
}

export function computeShuffledStudentOrderUpdates<T extends { studentId: string; serialNumber: number }>(
  orderedRows: readonly T[],
): SerialOrderUpdate[] {
  if (orderedRows.length < 2) return [];
  const nextOrder = orderedRows.slice();
  for (let i = nextOrder.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = nextOrder[i];
    nextOrder[i] = nextOrder[j];
    nextOrder[j] = tmp;
  }
  const sameOrder = nextOrder.every((r, idx) => r.studentId === orderedRows[idx].studentId);
  if (sameOrder && nextOrder.length >= 2) {
    const tmp = nextOrder[0];
    nextOrder[0] = nextOrder[1];
    nextOrder[1] = tmp;
  }
  return computeStudentOrderFromPermutation(orderedRows, nextOrder);
}

export function computeInsertRowSerialPlan<T extends { studentId: string; serialNumber: number }>(
  orderedScopedRows: readonly T[],
  insertIndex: number,
  allStudents?: readonly T[],
): { newSerialNumber: number; shiftUpdates: SerialOrderUpdate[] } {
  if (orderedScopedRows.length === 0) {
    const maxExisting = allStudents
      ? Math.max(0, ...allStudents.map((s) => Math.round(Number(s.serialNumber || 0))))
      : 0;
    return { newSerialNumber: maxExisting + 1, shiftUpdates: [] };
  }

  const clampedIdx = Math.max(0, Math.min(insertIndex, orderedScopedRows.length));
  if (clampedIdx >= orderedScopedRows.length) {
    const pool = allStudents && allStudents.length > 0 ? allStudents : orderedScopedRows;
    const maxSerial = Math.max(0, ...pool.map((s) => Math.round(Number(s.serialNumber || 0))));
    return { newSerialNumber: maxSerial + 1, shiftUpdates: [] };
  }

  const slots = buildStrictlyAscendingSlots(orderedScopedRows);
  const shiftUpdates: SerialOrderUpdate[] = [];
  let newSerialNumber = 1;

  if (clampedIdx === 0) {
    if (slots[0] > 1) {
      return { newSerialNumber: slots[0] - 1, shiftUpdates: [] };
    }
    newSerialNumber = 1;
  } else {
    // Preserve strict ascending slots before insertIndex so relative order never flips on tie
    for (let k = 0; k < clampedIdx; k++) {
      const current = Math.round(Number(orderedScopedRows[k].serialNumber || 0));
      if (current !== slots[k]) {
        shiftUpdates.push({ studentId: orderedScopedRows[k].studentId, serialNumber: slots[k] });
      }
    }
    newSerialNumber = slots[clampedIdx - 1] + 1;
  }

  let prevAssigned = newSerialNumber;
  for (let j = clampedIdx; j < orderedScopedRows.length; j++) {
    const currentRaw = Math.round(Number(orderedScopedRows[j].serialNumber || 0));
    const target = Math.max(prevAssigned + 1, currentRaw);
    if (currentRaw !== target) {
      shiftUpdates.push({ studentId: orderedScopedRows[j].studentId, serialNumber: target });
    }
    prevAssigned = target;
  }

  return { newSerialNumber, shiftUpdates };
}

export function formatDateTime(ts: unknown): string {
  if (!ts) return '—';
  let date: Date | null = null;
  if (typeof ts === 'string' || typeof ts === 'number') {
    const parsed = new Date(ts);
    if (!Number.isNaN(parsed.getTime())) date = parsed;
  } else if (
    typeof ts === 'object' &&
    ts !== null &&
    'toDate' in ts &&
    typeof (ts as { toDate: () => Date }).toDate === 'function'
  ) {
    date = (ts as { toDate: () => Date }).toDate();
  } else if (typeof ts === 'object' && ts !== null && 'seconds' in ts) {
    date = new Date(Number((ts as { seconds: number }).seconds) * 1000);
  }
  if (!date) return '—';
  return date.toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function escapeCsvCell(val: unknown): string {
  const str = String(val ?? '');
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function exportToCsv(filename: string, headers: string[], rows: Array<Array<unknown>>): void {
  const csvLines = [headers.map(escapeCsvCell).join(',')];
  for (const row of rows) {
    csvLines.push(row.map(escapeCsvCell).join(','));
  }
  const blob = new Blob(['\uFEFF' + csvLines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
  triggerDownload(blob, filename.endsWith('.csv') ? filename : `${filename}.csv`);
}

export function exportToExcel(
  filename: string,
  sheetName: string,
  headers: string[],
  rows: Array<Array<unknown>>,
): void {
  const aoa = [headers, ...rows];
  const worksheet = XLSX.utils.aoa_to_sheet(aoa);
  worksheet['!cols'] = headers.map((h, colIdx) => {
    const maxLen = Math.max(
      h.length,
      ...rows.map((r) => String(r[colIdx] ?? '').length),
    );
    return { wch: Math.min(Math.max(maxLen + 4, 12), 42) };
  });
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, sheetName.slice(0, 31) || 'Sheet1');
  const xlsxName = filename.replace(/\.xls$/i, '.xlsx');
  XLSX.writeFile(workbook, xlsxName.endsWith('.xlsx') ? xlsxName : `${xlsxName}.xlsx`);
}

export function exportJsonBackup(filename: string, payload: unknown): void {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8;' });
  triggerDownload(blob, filename.endsWith('.json') ? filename : `${filename}.json`);
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function detectDelimiter(text: string): string {
  const sampleLines = text.split(/\r?\n/).slice(0, 5).join('\n');
  const commas = (sampleLines.match(/,/g) || []).length;
  const tabs = (sampleLines.match(/\t/g) || []).length;
  const semis = (sampleLines.match(/;/g) || []).length;
  if (tabs > commas && tabs > semis) return '\t';
  if (semis > commas && semis > tabs) return ';';
  return ',';
}

export function parseCsvText(text: string, forcedDelimiter?: string): Array<Record<string, string>> {
  const delimiter = forcedDelimiter || detectDelimiter(text);
  const rows: string[][] = [];
  let current: string[] = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (inQuotes) {
      if (ch === '"' && next === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      current.push(cell.trim());
      cell = '';
    } else if (ch === '\r' && next === '\n') {
      current.push(cell.trim());
      if (current.some((c) => c.length > 0)) rows.push(current);
      current = [];
      cell = '';
      i++;
    } else if (ch === '\n' || ch === '\r') {
      current.push(cell.trim());
      if (current.some((c) => c.length > 0)) rows.push(current);
      current = [];
      cell = '';
    } else {
      cell += ch;
    }
  }
  current.push(cell.trim());
  if (current.some((c) => c.length > 0)) rows.push(current);

  if (rows.length === 0) return [];
  const headerIdx = findBestHeaderRowIndex(rows);
  const maxCols = Math.max(...rows.map((r) => r.length));
  const headers =
    headerIdx >= 0
      ? makeUniqueHeaders(
          Array.from({ length: maxCols }, (_, i) => (rows[headerIdx]?.[i] || '').replace(/^\uFEFF/, '').trim() || `Column_${i + 1}`),
        )
      : Array.from({ length: maxCols }, (_, i) => `Column_${i + 1}`);
  const dataStartIdx = headerIdx >= 0 ? headerIdx + 1 : 0;
  return rows.slice(dataStartIdx).map((r) => {
    const obj: Record<string, string> = {};
    headers.forEach((h, idx) => {
      obj[h] = (r[idx] ?? '').trim();
    });
    return obj;
  });
}

function normalizeHeaderToken(h: string): string {
  return h
    .replace(/^\uFEFF/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

const EXACT_HEADER_TOKENS = new Set([
  'sn',
  'sr',
  'sno',
  'srno',
  'slno',
  'serialno',
  'serialnumber',
  'studentname',
  'studentsname',
  'nameofstudent',
  'nameofthestudent',
  'candidatename',
  'learnername',
  'pupilname',
  'fullname',
  'name',
  'student',
  'sname',
  'fathername',
  'fathersname',
  'mothername',
  'mothersname',
  'mobileno',
  'mobilenumber',
  'mobile',
  'mob',
  'mobno',
  'phoneno',
  'phonenumber',
  'phone',
  'contact',
  'contactno',
  'contactnumber',
  'whatsapp',
  'whatsappno',
  'enrol',
  'enrolment',
  'enrollment',
  'enrolmentno',
  'enrollmentno',
  'enrolmentnumber',
  'enrollmentnumber',
  'enrolno',
  'rollno',
  'rollnumber',
  'regno',
  'registrationno',
  'admissionno',
  'studentid',
  'id',
  'centre',
  'centrename',
  'center',
  'centername',
  'branch',
  'branchname',
  'tma',
  'tmastatus',
  'practical',
  'practicalstatus',
  'attendance',
  'attendanceliveclasses',
  'liveclasses',
  'classes',
  'onlineclasses',
  'subject',
  'subjects',
  'course',
  'stream',
  'medium',
  'class',
  'totalfee',
  'totalfees',
  'totalamount',
  'fee',
  'fees',
  'coursefee',
  'paid',
  'paidamount',
  'feepaid',
  'feespaid',
  'jama',
  'feejama',
  'pending',
  'pendingamount',
  'pendingfee',
  'pendingfees',
  'baki',
  'baaki',
  'due',
  'dues',
  'balance',
  'tmafee',
  'tmafees',
  'examfee',
  'examfees',
  'examinationfee',
  'feestatus',
  'feesstatus',
  'paymentstatus',
  'admissiondate',
  'dateofadmission',
  'joiningdate',
  'tcstatus',
  'bookstatus',
  'examstatus',
  'examinationstatus',
  'remark',
  'remarks',
  'additionalremarks',
  'address',
  'dob',
  'dateofbirth',
  'email',
]);

const HEADER_WORD_HINTS = [
  'name',
  'student',
  'candidate',
  'learner',
  'pupil',
  'mobile',
  'mob',
  'phone',
  'contact',
  'whatsapp',
  'sno',
  'srno',
  'slno',
  'serial',
  'roll',
  'enrol',
  'registration',
  'centre',
  'center',
  'branch',
  'tma',
  'exam',
  'practical',
  'attend',
  'subject',
  'stream',
  'course',
  'fee',
  'fees',
  'paid',
  'jama',
  'baki',
  'baaki',
  'due',
  'dues',
  'pending',
  'balance',
  'amount',
  'received',
  'deposit',
  'installment',
  'receipt',
  'status',
  'date',
  'remark',
  'father',
  'mother',
  'class',
  'classes',
  'address',
  'medium',
];

const DATA_ONLY_VALUE_RE =
  /^(fees?\s*low|low\s*fee|regular|irregular|not\s*attending|submitted|not\s*submitted|completed|not\s*completed|partial|over\s*due|overdue|received|not\s*received|yes|no|na|n\/a|ok|nil|none|general|hindi|english)$/i;

export function isLikelyIndianMobileValue(raw: string): boolean {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return false;
  // Reject alphabetic-prefixed enrollment / reference codes like A1126307633 or N2104567890
  if (/^[a-zA-Z]+\d{5,}/.test(trimmed)) return false;

  const parts = /[/,;|&\n]/.test(trimmed)
    ? trimmed.split(/[/,;|&\n]+/).map((p) => p.trim()).filter(Boolean)
    : [trimmed];

  for (const part of parts) {
    if (/^[a-zA-Z]+\d{5,}/.test(part)) continue;
    const expanded =
      /^\d+(\.\d+)?e[+-]?\d+$/i.test(part) && Number.isFinite(Number(part))
        ? Number(part).toFixed(0)
        : part;
    const digits = expanded.replace(/\.0+$/, '').replace(/\D/g, '');
    const stripped =
      digits.length === 12 && digits.startsWith('91')
        ? digits.slice(2)
        : digits.length === 11 && digits.startsWith('0')
          ? digits.slice(1)
          : digits;
    if (/^[6-9]\d{9}$/.test(stripped)) return true;
  }
  return false;
}

export function isLikelyEnrollmentOrStudentId(raw: string): boolean {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return false;
  if (/^[a-zA-Z]{1,5}[-_/]?\d{5,16}$/.test(trimmed)) return true;
  if (/^\d{11,16}$/.test(trimmed) && !isLikelyIndianMobileValue(trimmed)) return true;
  if (/^(VP|XIS|NIOS|EN|REG)[-_]?\d{3,}/i.test(trimmed)) return true;
  return false;
}

function classifyHeaderCandidateRow(row: unknown[]): {
  score: number;
  exactHeaderHits: number;
  dataSignals: number;
} {
  const cells = row.map(formatCellValue).filter(Boolean);
  if (cells.length === 0) {
    return { score: -100, exactHeaderHits: 0, dataSignals: 0 };
  }

  let score = 0;
  let exactHeaderHits = 0;
  let dataSignals = 0;
  let headerHintHits = 0;

  for (const cell of cells) {
    const cleanLower = cell.toLowerCase().trim();
    const token = normalizeHeaderToken(cell);

    if (isLikelyIndianMobileValue(cell)) {
      dataSignals += 2;
      score -= 25;
      continue;
    }

    if (isLikelyEnrollmentOrStudentId(cell)) {
      dataSignals += 2;
      score -= 25;
      continue;
    }

    if (DATA_ONLY_VALUE_RE.test(cleanLower)) {
      dataSignals += 1;
      score -= 10;
      continue;
    }

    // Monetary or pure numeric data values (except years like 2025/2026 inside a header)
    const numericCandidate = cleanLower.replace(/[₹,\s]/g, '');
    if (/^\d+(\.\d+)?$/.test(numericCandidate)) {
      const n = Number(numericCandidate);
      if (!(n >= 1990 && n <= 2100 && cells.length >= 3)) {
        dataSignals += 1;
        score -= 12;
      }
      continue;
    }

    if (!token) continue;

    if (EXACT_HEADER_TOKENS.has(token)) {
      exactHeaderHits += 1;
      headerHintHits += 1;
      score += 12;
      continue;
    }

    // Word-level header keyword check (only on concise label-sized cells without long prose)
    const words = cleanLower.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
    if (cell.length <= 36 && words.length <= 6) {
      const hasWordHint = words.some((w) =>
        HEADER_WORD_HINTS.some((hint) => w === hint || (hint.length >= 4 && w.startsWith(hint))),
      );
      if (hasWordHint) {
        headerHintHits += 1;
        score += 5;
      }
    }
  }

  // Serial number 1..2000 at start + name-like text next = clearly a student data row
  if (/^\d{1,4}$/.test(cells[0]) && Number(cells[0]) >= 1 && Number(cells[0]) <= 2000 && cells.length >= 2) {
    dataSignals += 2;
    score -= 22;
  }

  if (cells.length >= 2 && headerHintHits > 0 && dataSignals === 0) {
    score += Math.min(cells.length, 6);
  }

  return { score, exactHeaderHits, dataSignals };
}

function detectHeaderRowStatus(grid: unknown[][]): { hasHeader: boolean; headerRowIdx: number } {
  if (grid.length === 0) return { hasHeader: false, headerRowIdx: -1 };
  if (grid.length === 1) {
    const first = classifyHeaderCandidateRow(grid[0] || []);
    return first.exactHeaderHits >= 2 && first.dataSignals === 0
      ? { hasHeader: true, headerRowIdx: 0 }
      : { hasHeader: false, headerRowIdx: -1 };
  }

  let bestIdx = 0;
  let bestEval = { score: -9999, exactHeaderHits: 0, dataSignals: 99 };
  const scanLimit = Math.min(grid.length, 25);

  for (let r = 0; r < scanLimit; r++) {
    const ev = classifyHeaderCandidateRow(grid[r] || []);
    if (ev.score > bestEval.score) {
      bestEval = ev;
      bestIdx = r;
    }
  }

  // If the highest-scoring row still carries strong data signals or lacks genuine header labels,
  // this sheet is headerless (starts directly with student data from Row 0) — keep EVERY row!
  if (
    bestEval.score < 12 ||
    (bestEval.dataSignals >= 2 && bestEval.exactHeaderHits < 2) ||
    bestEval.dataSignals >= 4
  ) {
    return { hasHeader: false, headerRowIdx: -1 };
  }

  // Extra guard: if rows BEFORE bestIdx already contain student data (e.g. phone numbers / enrol IDs),
  // bestIdx was actually just a data row with a misleading phrase — do not discard rows above it!
  for (let r = 0; r < bestIdx; r++) {
    const preCells = (grid[r] || []).map(formatCellValue).filter(Boolean);
    const hasRealStudentSignal = preCells.some(
      (c) => isLikelyIndianMobileValue(c) || isLikelyEnrollmentOrStudentId(c),
    );
    if (hasRealStudentSignal && bestEval.exactHeaderHits < 4) {
      return { hasHeader: false, headerRowIdx: -1 };
    }
  }

  return { hasHeader: true, headerRowIdx: bestIdx };
}

function findBestHeaderRowIndex(grid: unknown[][]): number {
  const status = detectHeaderRowStatus(grid);
  return status.hasHeader ? status.headerRowIdx : -1;
}

function makeUniqueHeaders(rawHeaders: string[]): string[] {
  const seen = new Map<string, number>();
  return rawHeaders.map((h) => {
    const clean = h.replace(/\s+/g, ' ').trim();
    const count = seen.get(clean) || 0;
    seen.set(clean, count + 1);
    return count === 0 ? clean : `${clean} (${count + 1})`;
  });
}

function formatCellValue(val: unknown): string {
  if (val === null || val === undefined) return '';
  if (val instanceof Date && !Number.isNaN(val.getTime())) {
    const y = val.getFullYear();
    const m = String(val.getMonth() + 1).padStart(2, '0');
    const d = String(val.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  if (typeof val === 'number') {
    if (!Number.isFinite(val)) return '';
    if (Number.isInteger(val)) return val.toFixed(0);
    return String(val);
  }
  return String(val).trim();
}

const EXCEL_INDEXED_PALETTE: string[] = [
  '000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF', 'FFFF00', 'FF00FF', '00FFFF',
  '000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF', 'FFFF00', 'FF00FF', '00FFFF',
  '800000', '008000', '000080', '808000', '800080', '008080', 'C0C0C0', '808080',
  '9999FF', '993366', 'FFFFCC', 'CCFFFF', '660066', 'FF8080', '0066CC', 'CCCCFF',
  '000080', 'FF00FF', 'FFFF00', '00FFFF', '800080', '800000', '008080', '0000FF',
  '00CCFF', 'CCFFFF', 'CCFFCC', 'FFFF99', '99CCFF', 'FF99CC', 'CC99FF', 'FFCC99',
  '3366FF', '33CCCC', '99CC00', 'FFCC00', 'FF9900', 'FF6600', '666699', '969696',
  '003366', '339966', '003300', '333300', '993300', '993366', '333399', '333333',
];

const DEFAULT_OFFICE_THEME_COLORS: string[] = [
  'FFFFFF', '000000', 'EEECE1', '1F497D', '4F81BD', 'C0504D',
  '9BBB59', '8064A2', '4BACC6', 'F79646', '0000FF', '800080',
];

function applyExcelTint(hex6: string, tint?: number): string {
  if (!tint || !Number.isFinite(tint) || Math.abs(tint) < 0.001) return hex6.toUpperCase();
  const r = parseInt(hex6.slice(0, 2), 16) / 255;
  const g = parseInt(hex6.slice(2, 4), 16) / 255;
  const b = parseInt(hex6.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  let l = (max + min) / 2;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      default:
        h = (r - g) / d + 4;
        break;
    }
    h /= 6;
  }

  if (tint < 0) {
    l = l * (1 + tint);
  } else {
    l = l * (1 - tint) + (1 - (1 - tint));
  }
  l = Math.min(1, Math.max(0, l));

  const hue2rgb = (p: number, q: number, t: number) => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };

  let nr = l;
  let ng = l;
  let nb = l;
  if (s !== 0) {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    nr = hue2rgb(p, q, h + 1 / 3);
    ng = hue2rgb(p, q, h);
    nb = hue2rgb(p, q, h - 1 / 3);
  }
  const toHex = (v: number) => Math.min(255, Math.max(0, Math.round(v * 255))).toString(16).padStart(2, '0');
  return `${toHex(nr)}${toHex(ng)}${toHex(nb)}`.toUpperCase();
}

interface XlsxColorObj {
  rgb?: string;
  theme?: number;
  tint?: number;
  indexed?: number;
}

interface XlsxCellStyleObj {
  patternType?: string;
  fgColor?: XlsxColorObj;
  bgColor?: XlsxColorObj;
  fill?: {
    patternType?: string;
    fgColor?: XlsxColorObj;
    bgColor?: XlsxColorObj;
  };
}

function resolveColorSpec(color: XlsxColorObj | undefined, wb?: XLSX.WorkBook): string {
  if (!color) return '';
  if (typeof color.rgb === 'string' && color.rgb.trim()) {
    const clean = color.rgb.trim().replace(/^#/, '').toUpperCase();
    if (clean.length === 8) {
      if (clean.startsWith('00')) return '';
      const hex6 = applyExcelTint(clean.slice(2), color.tint);
      return hex6 === 'FFFFFF' ? '' : `#${hex6}`;
    }
    if (clean.length === 6) {
      const hex6 = applyExcelTint(clean, color.tint);
      return hex6 === 'FFFFFF' ? '' : `#${hex6}`;
    }
  }
  if (typeof color.theme === 'number') {
    const scheme = (wb as { Themes?: { themeElements?: { clrScheme?: Array<{ rgb?: string }> } } } | undefined)
      ?.Themes?.themeElements?.clrScheme;
    const baseHex = scheme?.[color.theme]?.rgb || DEFAULT_OFFICE_THEME_COLORS[color.theme];
    if (baseHex && /^[0-9a-fA-F]{6}$/.test(baseHex)) {
      const hex6 = applyExcelTint(baseHex.toUpperCase(), color.tint);
      return hex6 === 'FFFFFF' ? '' : `#${hex6}`;
    }
  }
  if (typeof color.indexed === 'number') {
    if (color.indexed === 64 || color.indexed === 65) return '';
    const indexedHex = EXCEL_INDEXED_PALETTE[color.indexed];
    if (indexedHex) {
      const hex6 = applyExcelTint(indexedHex, color.tint);
      return hex6 === 'FFFFFF' ? '' : `#${hex6}`;
    }
  }
  return '';
}

export function extractCellFillHex(cell: XLSX.CellObject | undefined, wb?: XLSX.WorkBook): string {
  if (!cell || !cell.s) return '';
  const style = cell.s as XlsxCellStyleObj;
  const fillObj = style.fill || style;
  if (fillObj.patternType === 'none') return '';
  const fromFg = resolveColorSpec(fillObj.fgColor, wb);
  if (fromFg) return fromFg;
  const fromBg = resolveColorSpec(fillObj.bgColor, wb);
  if (fromBg) return fromBg;
  return '';
}

const NAMED_HTML_COLORS: Record<string, string> = {
  yellow: '#FFFF00',
  lightyellow: '#FFFFE0',
  red: '#FF0000',
  green: '#008000',
  lightgreen: '#90EE90',
  lime: '#00FF00',
  blue: '#0000FF',
  lightblue: '#ADD8E6',
  skyblue: '#87CEEB',
  cyan: '#00FFFF',
  aqua: '#00FFFF',
  pink: '#FFC0CB',
  orange: '#FFA500',
  gold: '#FFD700',
  khaki: '#F0E68C',
  salmon: '#FA8072',
  coral: '#FF7F50',
  lavender: '#E6E6FA',
  beige: '#F5F5DC',
  silver: '#C0C0C0',
  gray: '#808080',
  grey: '#808080',
  lightgray: '#D3D3D3',
  lightgrey: '#D3D3D3',
  purple: '#800080',
  navy: '#000080',
  teal: '#008080',
  maroon: '#800000',
};

function parseCssColorToHex(raw: string): string {
  const clean = (raw || '').trim().toLowerCase();
  if (!clean || clean === 'transparent' || clean === 'none' || clean === 'inherit' || clean === 'initial') return '';
  const named = NAMED_HTML_COLORS[clean];
  if (named) return named === '#FFFFFF' ? '' : named;
  const hexMatch = clean.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hexMatch) {
    const body = hexMatch[1].toUpperCase();
    const full =
      body.length === 3
        ? `${body[0]}${body[0]}${body[1]}${body[1]}${body[2]}${body[2]}`
        : body;
    return full === 'FFFFFF' ? '' : `#${full}`;
  }
  const rgbMatch = clean.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)$/);
  if (rgbMatch) {
    if (rgbMatch[4] !== undefined && Number(rgbMatch[4]) === 0) return '';
    const toHex = (s: string) => Math.min(255, Math.max(0, Number(s))).toString(16).padStart(2, '0').toUpperCase();
    const hex = `#${toHex(rgbMatch[1])}${toHex(rgbMatch[2])}${toHex(rgbMatch[3])}`;
    return hex === '#FFFFFF' ? '' : hex;
  }
  return '';
}

export function getReadableTextColor(bgHex: string): string {
  const clean = (bgHex || '').trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) return '#08152E';
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
  return luminance < 145 ? '#FFFFFF' : '#08152E';
}

export function isExcelSummaryRow(rawRow: Record<string, string>): boolean {
  const entries = Object.entries(rawRow)
    .map(([k, v]) => [k, String(v ?? '').trim()] as const)
    .filter(([, v]) => v.length > 0);
  const values = entries.map(([, v]) => v);
  if (values.length === 0) return true;

  const hasPhone = values.some((v) => {
    if (isLikelyIndianMobileValue(v)) return true;
    const digits = v.replace(/\D/g, '');
    return digits.length >= 9 && digits.length <= 13 && !/[\p{L}]{3,}/u.test(v);
  });
  if (hasPhone) return false;

  const hasEnrollmentId = values.some((v) => isLikelyEnrollmentOrStudentId(v));
  if (hasEnrollmentId) return false;

  // Match Unicode letters or letter+dot initials like "R. K." while excluding currency prefixes "Rs"/"INR"
  const nonNumericTexts = values.filter(
    (v) => (/[\p{L}]{2,}/u.test(v) || /[\p{L}]\s*\./u.test(v)) && !/^(rs|inr)\.?$/i.test(v),
  );
  const anyLetterTexts = values.filter(
    (v) => /[\p{L}]/u.test(v) && !/^(rs|inr)\.?$/i.test(v),
  );

  if (nonNumericTexts.some((t) => /^(grand\s*total|sub\s*total|subtotal)$/i.test(t))) {
    return true;
  }

  // If either of the first two non-empty cells is an integer serial number 1..10000 and another cell has text,
  // treat it as a real student row rather than a footer total.
  const hasSerialNo = entries.slice(0, 2).some(([, rawCell]) => {
    const cleanCell = rawCell.replace(/[.)]+$/, '').trim();
    return /^\d{1,5}$/.test(cleanCell) && Number(cleanCell) >= 1 && Number(cleanCell) <= 10000;
  });
  if (hasSerialNo && anyLetterTexts.length >= 1) {
    const joined = nonNumericTexts.join(' ').trim();
    if (!/^(total|grand\s*total|sub\s*total|subtotal|overall\s*total|net\s*total|total\s*fees?|total\s*amount|sum)(\s*[:\-].*)?$/i.test(joined)) {
      return false;
    }
  }

  if (nonNumericTexts.length === 0) return true;

  if (nonNumericTexts.length <= 2) {
    const joined = nonNumericTexts.join(' ').trim();
    if (/^(total|grand\s*total|sub\s*total|subtotal|overall\s*total|net\s*total|total\s*fees?|total\s*amount|sum|total\s*\(\d+\))(\s*[:\-].*)?$/i.test(joined)) {
      return true;
    }
  }
  return false;
}

export interface ExcludedSummaryRow {
  row: Record<string, string>;
  colors: Record<string, string>;
}

function worksheetToRowObjects(
  ws: XLSX.WorkSheet,
  wb?: XLSX.WorkBook,
): {
  headers: string[];
  rows: Array<Record<string, string>>;
  rowColors: Array<Record<string, string>>;
  summaryRowsFiltered: number;
  excludedSummaryRows: ExcludedSummaryRow[];
} {
  // Propagate top-left value AND style of merged cells cleanly before extracting grid
  const merges = ws['!merges'] || [];
  for (const merge of merges) {
    const topLeftAddr = XLSX.utils.encode_cell({ r: merge.s.r, c: merge.s.c });
    const topLeftCell = ws[topLeftAddr];
    if (!topLeftCell) continue;
    for (let r = merge.s.r; r <= merge.e.r; r++) {
      for (let c = merge.s.c; c <= merge.e.c; c++) {
        if (r === merge.s.r && c === merge.s.c) continue;
        const targetAddr = XLSX.utils.encode_cell({ r, c });
        if (!ws[targetAddr]) {
          ws[targetAddr] = { ...topLeftCell };
        } else if (!ws[targetAddr].s && topLeftCell.s) {
          ws[targetAddr].s = topLeftCell.s;
        }
      }
    }
  }

  // Ensure SheetJS '!ref' exists and covers every populated cell outside a stale/truncated range
  {
    const existingRef = ws['!ref'] ? XLSX.utils.decode_range(ws['!ref']) : null;
    let maxRow = existingRef ? existingRef.e.r : 0;
    let maxCol = existingRef ? existingRef.e.c : 0;
    for (const key of Object.keys(ws)) {
      if (key.startsWith('!')) continue;
      if (!/^[A-Z]{1,3}\d+$/.test(key)) continue;
      const decoded = XLSX.utils.decode_cell(key);
      if (decoded.r > maxRow) maxRow = decoded.r;
      if (decoded.c > maxCol) maxCol = decoded.c;
    }
    if (!existingRef || maxRow > existingRef.e.r || maxCol > existingRef.e.c) {
      ws['!ref'] = XLSX.utils.encode_range({
        s: existingRef ? existingRef.s : { r: 0, c: 0 },
        e: { r: maxRow, c: maxCol },
      });
    }
  }

  const grid = XLSX.utils.sheet_to_json<unknown[]>(ws, {
    header: 1,
    raw: true,
    defval: '',
    blankrows: true,
  });

  if (!grid || grid.length === 0) {
    return { headers: [], rows: [], rowColors: [], summaryRowsFiltered: 0, excludedSummaryRows: [] };
  }

  const headerIdx = findBestHeaderRowIndex(grid);
  let dataStartIdx = headerIdx >= 0 ? headerIdx + 1 : 0;
  let maxCols = headerIdx >= 0 ? (grid[headerIdx] || []).length : 0;
  for (let r = dataStartIdx; r < grid.length; r++) {
    const len = (grid[r] || []).length;
    if (len > maxCols) maxCols = len;
  }

  let rawHeaders: string[] = [];
  if (headerIdx >= 0) {
    const row0 = grid[headerIdx] || [];
    const nextRow = headerIdx + 1 < grid.length ? grid[headerIdx + 1] || [] : [];
    const nextEval = nextRow.length > 0 ? classifyHeaderCandidateRow(nextRow) : null;

    // Detect duplicate merged parent headings (e.g. "Fee Details | Fee Details | Fee Details") over sub-headers ("Total | Paid | Pending")
    const r0Counts = new Map<string, number>();
    for (let c = 0; c < maxCols; c++) {
      const t0 = formatCellValue(row0[c]).replace(/^\uFEFF/, '').trim().toLowerCase();
      if (t0) r0Counts.set(t0, (r0Counts.get(t0) || 0) + 1);
    }
    const hasDuplicateGroupHeader = Array.from(r0Counts.values()).some((cnt) => cnt >= 2);
    const nextRowShortLabels = nextRow
      .map(formatCellValue)
      .filter((v) => v.length > 0 && v.length <= 30 && !/^\d[\d,.]*$/.test(v));
    const nextRowHasStudentStatusValues = nextRow
      .map(formatCellValue)
      .some((v) =>
        /^(not\s*provided|not\s*submitted|not\s*completed|not\s*attending|not\s*received|fees?\s*low)$/i.test(v),
      );

    const isSubHeaderRow =
      Boolean(nextEval) &&
      nextEval!.dataSignals === 0 &&
      !nextRowHasStudentStatusValues &&
      nextRowShortLabels.length >= 2 &&
      ((hasDuplicateGroupHeader && nextEval!.exactHeaderHits >= 1) ||
        (nextEval!.exactHeaderHits >= 2 &&
          nextRow.map(formatCellValue).filter(Boolean).length <= Math.max(3, Math.floor(maxCols * 0.65))));

    if (isSubHeaderRow) {
      for (let c = 0; c < maxCols; c++) {
        const t0 = formatCellValue(row0[c]).replace(/^\uFEFF/, '').trim();
        const t1 = formatCellValue(nextRow[c]).replace(/^\uFEFF/, '').trim();
        if (t0 && t1 && t0.toLowerCase() !== t1.toLowerCase()) {
          const isRepeatedParent = (r0Counts.get(t0.toLowerCase()) || 0) >= 2;
          rawHeaders.push(isRepeatedParent ? `${t0} - ${t1}` : t1);
        } else {
          rawHeaders.push(t0 || t1 || `Column_${c + 1}`);
        }
      }
      dataStartIdx = headerIdx + 2;
    } else {
      for (let c = 0; c < maxCols; c++) {
        const cellText = formatCellValue(row0[c]).replace(/^\uFEFF/, '');
        rawHeaders.push(cellText || `Column_${c + 1}`);
      }
    }
  } else {
    rawHeaders = Array.from({ length: maxCols }, (_, c) => `Column_${c + 1}`);
  }
  const uniqueHeaders = makeUniqueHeaders(rawHeaders);

  const records: Array<Record<string, string>> = [];
  const rawRecordColors: Array<Record<string, string>> = [];
  const rawExcluded: ExcludedSummaryRow[] = [];

  for (let r = dataStartIdx; r < grid.length; r++) {
    const row = grid[r] || [];
    const obj: Record<string, string> = {};
    const colorObj: Record<string, string> = {};
    let nonEmptyCells = 0;
    uniqueHeaders.forEach((h, idx) => {
      const cellAddr = XLSX.utils.encode_cell({ r, c: idx });
      const cellObj = ws[cellAddr];
      let formatted = formatCellValue(row[idx]);
      if (!formatted && cellObj) {
        if (typeof cellObj.w === 'string' && cellObj.w.trim()) {
          formatted = cellObj.w.trim();
        } else if (cellObj.v !== undefined && cellObj.v !== null) {
          formatted = formatCellValue(cellObj.v);
        }
      }
      obj[h] = formatted;
      if (formatted.length > 0) nonEmptyCells++;
      const hex = extractCellFillHex(cellObj, wb);
      if (hex) {
        colorObj[h] = hex;
      }
    });
    if (nonEmptyCells === 0) continue;
    if (isExcelSummaryRow(obj)) {
      rawExcluded.push({ row: obj, colors: colorObj });
      continue;
    }
    records.push(obj);
    rawRecordColors.push(colorObj);
  }

  // Strip completely unused auto-generated "Column_X" headers
  const activeHeaders = uniqueHeaders.filter((h) => {
    if (!/^Column_\d+$/.test(h)) return true;
    return records.some((rec) => (rec[h] || '').length > 0);
  });

  const cleanRecords = records.map((rec) => {
    const cleaned: Record<string, string> = {};
    activeHeaders.forEach((h) => {
      cleaned[h] = rec[h] ?? '';
    });
    return cleaned;
  });

  const cleanColors = rawRecordColors.map((colRec) => {
    const cleaned: Record<string, string> = {};
    activeHeaders.forEach((h) => {
      if (colRec[h]) cleaned[h] = colRec[h];
    });
    return cleaned;
  });

  const cleanExcluded = rawExcluded.map(({ row, colors }) => {
    const cleanedRow: Record<string, string> = {};
    const cleanedColors: Record<string, string> = {};
    activeHeaders.forEach((h) => {
      cleanedRow[h] = row[h] ?? '';
      if (colors[h]) cleanedColors[h] = colors[h];
    });
    return { row: cleanedRow, colors: cleanedColors };
  });

  return {
    headers: activeHeaders,
    rows: cleanRecords,
    rowColors: cleanColors,
    summaryRowsFiltered: cleanExcluded.length,
    excludedSummaryRows: cleanExcluded,
  };
}

function decodeTextBuffer(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(bytes.subarray(3));
  }
  return new TextDecoder('utf-8').decode(bytes);
}

function parseElementBackgroundHex(el: Element): string {
  const bgAttr = el.getAttribute('bgcolor');
  if (bgAttr) {
    const parsed = parseCssColorToHex(bgAttr);
    if (parsed) return parsed;
  }
  const styleAttr = el.getAttribute('style') || '';
  const match = styleAttr.match(/background(?:-color)?\s*:\s*([^;]+)/i);
  if (match) {
    const parsed = parseCssColorToHex(match[1]);
    if (parsed) return parsed;
  }
  return '';
}

function parseHtmlTableFallback(htmlText: string): {
  rows: Array<Record<string, string>>;
  rowColors: Array<Record<string, string>>;
  summaryRowsFiltered: number;
  excludedSummaryRows: ExcludedSummaryRow[];
} {
  if (typeof DOMParser === 'undefined') {
    return { rows: [], rowColors: [], summaryRowsFiltered: 0, excludedSummaryRows: [] };
  }
  const doc = new DOMParser().parseFromString(htmlText, 'text/html');
  const tables = Array.from(doc.querySelectorAll('table'));
  if (tables.length === 0) {
    return { rows: [], rowColors: [], summaryRowsFiltered: 0, excludedSummaryRows: [] };
  }
  const rows: string[][] = [];
  const rowColorMatrix: Array<{ trBg: string; cellBgs: string[] }> = [];
  const primaryTable = tables[0];
  primaryTable.querySelectorAll('tr').forEach((tr) => {
    const trBg = parseElementBackgroundHex(tr);
    const cellEls = Array.from(tr.querySelectorAll('th, td'));
    const cells = cellEls.map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim());
    const cellBgs = cellEls.map((el) => parseElementBackgroundHex(el) || trBg);
    if (cells.some(Boolean)) {
      rows.push(cells);
      rowColorMatrix.push({ trBg, cellBgs });
    }
  });
  if (rows.length === 0) {
    return { rows: [], rowColors: [], summaryRowsFiltered: 0, excludedSummaryRows: [] };
  }
  const headerIdx = findBestHeaderRowIndex(rows);
  const maxCols = Math.max(...rows.map((r) => r.length));
  const headers =
    headerIdx >= 0
      ? makeUniqueHeaders(
          Array.from({ length: maxCols }, (_, i) => rows[headerIdx]?.[i] || `Column_${i + 1}`),
        )
      : Array.from({ length: maxCols }, (_, i) => `Column_${i + 1}`);
  const dataStartIdx = headerIdx >= 0 ? headerIdx + 1 : 0;

  const outRows: Array<Record<string, string>> = [];
  const outColors: Array<Record<string, string>> = [];
  const excludedSummaryRows: ExcludedSummaryRow[] = [];

  rows.slice(dataStartIdx).forEach((r, idx) => {
    const obj: Record<string, string> = {};
    const cObj: Record<string, string> = {};
    const meta = rowColorMatrix[dataStartIdx + idx];
    if (meta?.trBg) cObj._rowBg = meta.trBg;
    headers.forEach((h, i) => {
      obj[h] = r[i] ?? '';
      if (meta?.cellBgs[i]) cObj[h] = meta.cellBgs[i];
    });
    if (isExcelSummaryRow(obj)) {
      excludedSummaryRows.push({ row: obj, colors: cObj });
      return;
    }
    outRows.push(obj);
    outColors.push(cObj);
  });

  return {
    rows: outRows,
    rowColors: outColors,
    summaryRowsFiltered: excludedSummaryRows.length,
    excludedSummaryRows,
  };
}

export interface ParsedWorkbookResult {
  sheetNames: string[];
  sheets: Record<string, Array<Record<string, string>>>;
  headersBySheet: Record<string, string[]>;
  rowColorsBySheet?: Record<string, Array<Record<string, string>>>;
  summaryRowsFilteredBySheet?: Record<string, number>;
  excludedSummaryRowsBySheet?: Record<string, ExcludedSummaryRow[]>;
}

export async function parseSpreadsheetFile(file: File): Promise<ParsedWorkbookResult> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const lowerName = file.name.toLowerCase();
  const isTextFormat =
    lowerName.endsWith('.csv') ||
    lowerName.endsWith('.tsv') ||
    lowerName.endsWith('.txt') ||
    file.type === 'text/csv';

  if (isTextFormat) {
    const text = decodeTextBuffer(buffer);
    let rows: Array<Record<string, string>> = [];
    try {
      const wb = XLSX.read(text, { type: 'string', cellDates: true });
      const first = wb.SheetNames[0];
      if (first && wb.Sheets[first]) {
        const extracted = worksheetToRowObjects(wb.Sheets[first], wb);
        if (extracted.rows.length > 0) {
          return {
            sheetNames: [first],
            sheets: { [first]: extracted.rows },
            headersBySheet: { [first]: extracted.headers },
            rowColorsBySheet: { [first]: extracted.rowColors },
            summaryRowsFilteredBySheet: { [first]: extracted.summaryRowsFiltered },
            excludedSummaryRowsBySheet: { [first]: extracted.excludedSummaryRows },
          };
        }
      }
    } catch {
      // Fall through to custom delimiter parser
    }
    const rawCsv = parseCsvText(text);
    const excluded: ExcludedSummaryRow[] = [];
    rows = rawCsv.filter((r) => {
      if (isExcelSummaryRow(r)) {
        excluded.push({ row: r, colors: {} });
        return false;
      }
      return true;
    });
    const headers = rows.length > 0 ? Object.keys(rows[0]) : [];
    return {
      sheetNames: ['Sheet1'],
      sheets: { Sheet1: rows },
      headersBySheet: { Sheet1: headers },
      rowColorsBySheet: { Sheet1: rows.map(() => ({})) },
      summaryRowsFilteredBySheet: { Sheet1: excluded.length },
      excludedSummaryRowsBySheet: { Sheet1: excluded },
    };
  }

  let workbook: XLSX.WorkBook | null = null;
  try {
    workbook = XLSX.read(bytes, { type: 'array', cellDates: true, cellStyles: true });
  } catch {
    try {
      workbook = XLSX.read(bytes, { type: 'array', cellDates: true });
    } catch {
      workbook = null;
    }
  }

  if (!workbook || workbook.SheetNames.length === 0) {
    const text = decodeTextBuffer(buffer);
    try {
      workbook = XLSX.read(text, { type: 'string', cellDates: true, cellStyles: true });
    } catch {
      try {
        workbook = XLSX.read(text, { type: 'string', cellDates: true });
      } catch {
        workbook = null;
      }
    }
    if ((!workbook || workbook.SheetNames.length === 0) && /<(table|html|tr)/i.test(text)) {
      const htmlParsed = parseHtmlTableFallback(text);
      const htmlHeaders = htmlParsed.rows.length > 0 ? Object.keys(htmlParsed.rows[0]) : [];
      return {
        sheetNames: ['Sheet1'],
        sheets: { Sheet1: htmlParsed.rows },
        headersBySheet: { Sheet1: htmlHeaders },
        rowColorsBySheet: { Sheet1: htmlParsed.rowColors },
        summaryRowsFilteredBySheet: { Sheet1: htmlParsed.summaryRowsFiltered },
        excludedSummaryRowsBySheet: { Sheet1: htmlParsed.excludedSummaryRows },
      };
    }
  }

  const sheets: Record<string, Array<Record<string, string>>> = {};
  const headersBySheet: Record<string, string[]> = {};
  const rowColorsBySheet: Record<string, Array<Record<string, string>>> = {};
  const summaryRowsFilteredBySheet: Record<string, number> = {};
  const excludedSummaryRowsBySheet: Record<string, ExcludedSummaryRow[]> = {};
  const validSheetNames: string[] = [];

  if (workbook) {
    for (const name of workbook.SheetNames) {
      const ws = workbook.Sheets[name];
      if (!ws) continue;
      const extracted = worksheetToRowObjects(ws, workbook);
      if (extracted.rows.length > 0) {
        sheets[name] = extracted.rows;
        headersBySheet[name] = extracted.headers;
        rowColorsBySheet[name] = extracted.rowColors;
        summaryRowsFilteredBySheet[name] = extracted.summaryRowsFiltered;
        excludedSummaryRowsBySheet[name] = extracted.excludedSummaryRows;
        validSheetNames.push(name);
      }
    }
  }

  if (validSheetNames.length === 0) {
    const text = decodeTextBuffer(buffer);
    if (/<(table|html|tr)/i.test(text)) {
      const htmlParsed = parseHtmlTableFallback(text);
      if (htmlParsed.rows.length > 0) {
        return {
          sheetNames: ['Sheet1'],
          sheets: { Sheet1: htmlParsed.rows },
          headersBySheet: { Sheet1: Object.keys(htmlParsed.rows[0]) },
          rowColorsBySheet: { Sheet1: htmlParsed.rowColors },
          summaryRowsFilteredBySheet: { Sheet1: htmlParsed.summaryRowsFiltered },
          excludedSummaryRowsBySheet: { Sheet1: htmlParsed.excludedSummaryRows },
        };
      }
    }
    const rawTextRows = parseCsvText(text);
    const excluded: ExcludedSummaryRow[] = [];
    const textRows = rawTextRows.filter((r) => {
      if (isExcelSummaryRow(r)) {
        excluded.push({ row: r, colors: {} });
        return false;
      }
      return true;
    });
    if (textRows.length > 0) {
      return {
        sheetNames: ['Sheet1'],
        sheets: { Sheet1: textRows },
        headersBySheet: { Sheet1: Object.keys(textRows[0]) },
        rowColorsBySheet: { Sheet1: textRows.map(() => ({})) },
        summaryRowsFilteredBySheet: { Sheet1: excluded.length },
        excludedSummaryRowsBySheet: { Sheet1: excluded },
      };
    }
  }

  return {
    sheetNames: validSheetNames,
    sheets,
    headersBySheet,
    rowColorsBySheet,
    summaryRowsFilteredBySheet,
    excludedSummaryRowsBySheet,
  };
}

export interface ExcelColumnMapping {
  studentId?: string;
  studentName?: string;
  mobileNumber?: string;
  centre?: string;
  subject?: string;
  tmaStatus?: string;
  practicalStatus?: string;
  classAttendanceStatus?: string;
  tcStatus?: string;
  bookStatus?: string;
  examinationStatus?: string;
  admissionDate?: string;
  whyNios?: string;
  currentEducationStatus?: string;
  futurePlanning?: string;
  additionalRemarks?: string;
  totalFee?: string;
  paidAmount?: string;
  pendingAmount?: string;
  tmaFee?: string;
  examFee?: string;
  feeStatus?: string;
}

const EXACT_ALIAS_LISTS: Record<keyof ExcelColumnMapping, string[]> = {
  studentId: [
    'studentid',
    'enrollmentno',
    'enrolmentno',
    'enrollmentnumber',
    'enrolmentnumber',
    'rollno',
    'rollnumber',
    'regno',
    'registrationno',
    'admissionno',
    'id',
  ],
  studentName: [
    'studentname',
    'studentsname',
    'nameofstudent',
    'nameofthestudent',
    'candidatename',
    'learnername',
    'pupilname',
    'fullname',
    'name',
    'student',
    'sname',
  ],
  mobileNumber: [
    'mobilenumber',
    'mobileno',
    'mobile',
    'mob',
    'mobno',
    'phonenumber',
    'phoneno',
    'phone',
    'phno',
    'contactnumber',
    'contactno',
    'contact',
    'whatsappno',
    'whatsapp',
    'tel',
    'telephone',
  ],
  centre: ['centre', 'centrename', 'centreid', 'branch', 'branchname', 'center', 'centername', 'location'],
  subject: [
    'subject',
    'subjects',
    'niossubject',
    'niossubjects',
    'appearingsubject',
    'appearingsubjects',
    'optedsubject',
    'optedsubjects',
    'mainsubject',
    'mainsubjects',
    'subjectname',
    'subjectnames',
    'subjectcode',
    'subjectcodes',
    'sub',
    'subs',
    'course',
    'stream',
    'class',
    'medium',
  ],
  tmaStatus: ['tmastatus', 'tma', 'tmasubmission'],
  practicalStatus: ['practicalstatus', 'practical', 'practicals'],
  classAttendanceStatus: [
    'classattendancestatus',
    'attendanceliveclasses',
    'liveclasses',
    'attendance',
    'onlineclasses',
    'classattendance',
    'onlineclassattendance',
  ],
  tcStatus: ['tcstatus', 'tc', 'transfercertificate'],
  bookStatus: ['bookstatus', 'book', 'books', 'studymaterial'],
  examinationStatus: ['examinationstatus', 'examstatus', 'examination', 'exam'],
  admissionDate: ['admissiondate', 'admdate', 'joiningdate', 'dateofadmission', 'date', 'doj'],
  whyNios: ['whynios', 'niospurpose', 'purpose', 'reason'],
  currentEducationStatus: [
    'currenteducationstatus',
    'educationstatus',
    'education',
    'qualification',
    'currentclass',
    'academicbackground',
  ],
  futurePlanning: ['futureplanning', 'futureplan', 'goal', 'careerplan', 'aim'],
  additionalRemarks: ['additionalremarks', 'remarks', 'remark', 'notes', 'note', 'comment', 'comments'],
  totalFee: [
    'totalfee',
    'totalfees',
    'totalfeesrs',
    'totalfeers',
    'totalamt',
    'totalamount',
    'fee',
    'fees',
    'feers',
    'feesrs',
    'feeamount',
    'feesamount',
    'feesdetail',
    'feedetails',
    'coursefee',
    'coursefees',
    'courseamt',
    'packagefee',
    'totalpackage',
    'package',
    'actualfee',
    'actualamt',
    'decidedfee',
    'feesdecided',
    'decided',
    'settledfee',
    'settled',
    'agreed',
    'fixedfee',
    'finalfee',
    'annualfee',
    'fullfee',
    'studentfee',
    'niosfee',
    'coachingfee',
    'payablefee',
    'netfee',
    'payableamount',
    'tuitionfee',
    'totalcoursefee',
    'programfee',
    'admissionfee',
    'kulfee',
    'kulfees',
    'totalrs',
  ],
  paidAmount: [
    'paidamount',
    'paidamt',
    'feepaid',
    'feespaid',
    'paid',
    'paidfee',
    'paidfees',
    'paidtilldate',
    'jama',
    'feejama',
    'feesjama',
    'jamafee',
    'jamarashi',
    'jamaamount',
    'amountjama',
    'receivedfee',
    'feereceived',
    'receivedamount',
    'amountreceived',
    'receivedrs',
    'feesubmitted',
    'submittedfee',
    'submittedfees',
    'feesubmit',
    'amtpaid',
    'amtreceived',
    'feerecd',
    'feesrecd',
    'recd',
    'collectedfee',
    'feecollected',
    'feescollected',
    'paidrs',
    'deposit',
    'deposited',
    'feesdeposited',
    'depositedfee',
    'depositamt',
    'depositedamount',
    'amountdeposited',
    'amountpaid',
    'collected',
    'collection',
    '1stinstallment',
    'firstinstallment',
    'installment1',
    'inst1',
    '1stinst',
    '1stkist',
    'kist1',
    'kist',
    '1stpay',
    'pay1',
    'installment',
    'instalment',
  ],
  pendingAmount: [
    'pendingamount',
    'pendingfee',
    'pendingfees',
    'pendingamt',
    'pendingrs',
    'pending',
    'due',
    'dues',
    'duefee',
    'duefees',
    'dueamount',
    'dueamt',
    'duers',
    'duerashi',
    'balance',
    'balancefee',
    'balancefees',
    'balanceamount',
    'balanceamt',
    'balancetopay',
    'balancers',
    'bal',
    'balfee',
    'balfees',
    'balamt',
    'baldue',
    'balancetobepaid',
    'pendingbalance',
    'baki',
    'baaki',
    'bakirashi',
    'bakiamount',
    'bakaya',
    'baqaya',
    'bakayafee',
    'baqayafee',
    'shesh',
    'sheshfee',
    'sheshrashi',
    'rest',
    'restfee',
    'restamount',
    'remaining',
    'remainingfee',
    'remainingfees',
    'remainingamount',
    'remainingbalance',
    'leftfee',
    'leftfees',
    'leftfeesrs',
    'leftfeers',
    'feesleft',
    'feeleft',
    'leftamount',
    'leftamt',
    'leftrs',
    'leftbalance',
    'leftbal',
    'balanceleft',
    'amountleft',
    'amtleft',
    'left',
    'unpaidamount',
    'unpaidamt',
    'unpaidrs',
    'unpaidfee',
    'unpaidfees',
    'topay',
    'payablebalance',
  ],
  tmaFee: [
    'tmafee',
    'tmafees',
    'tmafeesrs',
    'tmafeespaid',
    'tmafeepaid',
    'tmafeespending',
    'tmaamount',
    'tmacharge',
    'tmacharges',
    'tmafeers',
    'tmars',
    'assignmentfee',
    'assignmentfees',
  ],
  examFee: [
    'examfee',
    'examfees',
    'examfeesrs',
    'examfeespaid',
    'examfeepaid',
    'examinationfee',
    'examinationfees',
    'examinationfeesrs',
    'examamount',
    'examcharge',
    'examcharges',
    'boardfee',
    'boardfees',
    'boardexamfee',
    'examinationsfee',
    'examfeers',
    'examrs',
    'examformfee',
  ],
  feeStatus: ['feestatus', 'feesstatus', 'paymentstatus', 'recoverystatus', 'paidstatus'],
};

const FUZZY_CONTAINS: Array<{ field: keyof ExcelColumnMapping; keywords: string[]; exclude?: string[] }> = [
  { field: 'studentName', keywords: ['studentname', 'candidatename', 'learnername', 'nameofstudent', 'fullname', 'name'], exclude: ['father', 'mother', 'guardian', 'centre', 'center', 'branch', 'employee', 'staff', 'teacher', 'parent'] },
  { field: 'mobileNumber', keywords: ['mobile', 'phone', 'contact', 'whatsapp', 'mob'] },
  { field: 'studentId', keywords: ['enrol', 'rollno', 'regno', 'studentid', 'admno'] },
  { field: 'centre', keywords: ['centre', 'center', 'branch'] },
  { field: 'tmaFee', keywords: ['tmafee', 'tmafees', 'tmacharge', 'tmaamount', 'tmars', 'assignmentfee'] },
  { field: 'examFee', keywords: ['examfee', 'examfees', 'examinationfee', 'examinationfees', 'examcharge', 'examamount', 'examrs', 'boardfee'] },
  { field: 'tmaStatus', keywords: ['tma'], exclude: ['fee', 'fees', 'amount', 'charge', 'charges', 'rs', 'paid', 'pending', 'due'] },
  { field: 'practicalStatus', keywords: ['practical'], exclude: ['fee', 'fees', 'amount', 'charge'] },
  { field: 'classAttendanceStatus', keywords: ['attend', 'liveclass', 'onlineclass'] },
  {
    field: 'subject',
    keywords: ['subject', 'stream', 'course'],
    exclude: ['fee', 'fees', 'charge', 'amount', 'toc', 'why', 'plan', 'source'],
  },
  { field: 'tcStatus', keywords: ['transfercert', 'tcstatus'] },
  { field: 'bookStatus', keywords: ['book'] },
  { field: 'examinationStatus', keywords: ['exam'], exclude: ['fee', 'fees', 'amount', 'charge', 'charges', 'rs', 'paid', 'pending', 'due'] },
  { field: 'admissionDate', keywords: ['admdate', 'admissiondate', 'joiningdate'] },
  { field: 'feeStatus', keywords: ['feestatus', 'paymentstatus', 'recoverystatus'] },
  {
    field: 'pendingAmount',
    keywords: [
      'pending',
      'due',
      'balance',
      'baki',
      'baaki',
      'bakaya',
      'baqaya',
      'remaining',
      'unpaid',
      'leftfee',
      'feeleft',
      'leftamt',
      'amountleft',
      'amtleft',
      'leftrs',
      'leftbal',
      'balanceleft',
      'left',
      'shesh',
      'balfee',
      'balamt',
      'baldue',
    ],
    exclude: ['tma', 'exam', 'date', 'reason', 'remark', 'note', 'dropout'],
  },
  {
    field: 'paidAmount',
    keywords: ['paid', 'jama', 'deposit', 'received', 'collected', 'submitted', 'recd', 'installment', 'instalment', 'kist'],
    exclude: ['tma', 'exam', 'status', 'unpaid', 'left'],
  },
  {
    field: 'totalFee',
    keywords: [
      'totalfee',
      'totalamt',
      'coursefee',
      'packagefee',
      'package',
      'decided',
      'settled',
      'actualfee',
      'fixedfee',
      'finalfee',
      'tuitionfee',
      'totalamount',
      'netfee',
      'payablefee',
      'admissionfee',
      'feers',
      'feesrs',
      'feeamount',
      'feesamount',
      'fees',
      'fee',
    ],
    exclude: [
      'tma',
      'exam',
      'practical',
      'status',
      'remark',
      'note',
      'receipt',
      'mode',
      'type',
      'date',
      'paid',
      'jama',
      'pending',
      'due',
      'baki',
      'balance',
      'left',
      'unpaid',
      'concession',
      'discount',
      'refund',
      'installment',
    ],
  },
  { field: 'additionalRemarks', keywords: ['remark', 'note', 'comment'] },
];

const ZERO_OR_FEE_STATUS_CELL_RE =
  /^(nil|nill|zero|no\s*due|no\s*dues|clear|cleared|settled|full\s*paid|paid|unpaid|not\s*paid|partial|pending|overdue|free|exempt|concession|discount|waived|scholarship|done|na|n\/a|none)$/i;

function isMostlyNonNumericRemarkValues(samples: string[]): boolean {
  if (samples.length === 0) return false;
  let numericCount = 0;
  let remarkTextCount = 0;
  for (const v of samples) {
    const trimmed = v.trim();
    if (!trimmed) continue;
    const num = parseFeeNumberNullable(trimmed);
    if (num !== null) {
      numericCount += 1;
    } else if (!ZERO_OR_FEE_STATUS_CELL_RE.test(trimmed) && /[\p{L}]{2,}/u.test(trimmed)) {
      remarkTextCount += 1;
    }
  }
  if (numericCount >= 3 || (numericCount >= 2 && numericCount >= remarkTextCount)) return false;
  return remarkTextCount >= Math.ceil(samples.length * 0.55);
}

const FEE_MAPPING_FIELDS = new Set<keyof ExcelColumnMapping>([
  'totalFee',
  'paidAmount',
  'pendingAmount',
  'tmaFee',
  'examFee',
]);

export function fuzzyDetectColumnMapping(
  headers: string[],
  sampleRows: Array<Record<string, string>> = [],
): ExcelColumnMapping {
  const mapping: ExcelColumnMapping = {};
  const tokenToHeader = headers.map((h) => ({ header: h, token: normalizeHeaderToken(h) }));
  const usedHeaders = new Set<string>();
  const sampleSlice = sampleRows.slice(0, 120);

  const colSamples = new Map<string, string[]>();
  for (const h of headers) {
    colSamples.set(
      h,
      sampleSlice.map((r) => String(r[h] ?? '').trim()).filter(Boolean),
    );
  }

  // Pass 1: exact alias priority (ignoring synthetic headerless Column_X unless matching real data)
  (Object.keys(EXACT_ALIAS_LISTS) as Array<keyof ExcelColumnMapping>).forEach((field) => {
    const aliases = EXACT_ALIAS_LISTS[field];
    for (const alias of aliases) {
      const match = tokenToHeader.find((item) => {
        if (usedHeaders.has(item.header) || item.token !== alias) return false;
        if (FEE_MAPPING_FIELDS.has(field)) {
          const samples = colSamples.get(item.header) || [];
          if (samples.length > 0 && isMostlyNonNumericRemarkValues(samples)) return false;
        }
        return true;
      });
      if (match) {
        mapping[field] = match.header;
        usedHeaders.add(match.header);
        break;
      }
    }
  });

  // Pass 2: fuzzy substring match (guarded against data phrases like "fees low" masquerading as fee columns)
  for (const rule of FUZZY_CONTAINS) {
    if (mapping[rule.field]) continue;
    const match = tokenToHeader.find((item) => {
      if (usedHeaders.has(item.header) || !item.token) return false;
      if (rule.exclude?.some((ex) => item.token.includes(ex))) return false;
      if (!rule.keywords.some((kw) => item.token.includes(kw))) return false;
      if (FEE_MAPPING_FIELDS.has(rule.field)) {
        const samples = colSamples.get(item.header) || [];
        if (samples.length > 0 && isMostlyNonNumericRemarkValues(samples)) return false;
      }
      return true;
    });
    if (match) {
      mapping[rule.field] = match.header;
      usedHeaders.add(match.header);
    }
  }

  // Pass 3: smart content-based auto-reader for headerless / differently named branch Excels
  if (sampleSlice.length > 0) {
    // 3a. Detect S.No column so it is never confused for Fee / Student ID
    const snoHeaders = new Set<string>();
    for (const h of headers) {
      const token = normalizeHeaderToken(h);
      if (token === 'sno' || token === 'srno' || token === 'slno' || token === 'serialno' || token === 'serialnumber') {
        snoHeaders.add(h);
        continue;
      }
      const samples = colSamples.get(h) || [];
      if (samples.length >= 3) {
        const smallInts = samples.filter((v) => /^\d{1,4}$/.test(v) && Number(v) >= 1 && Number(v) <= 2000);
        if (smallInts.length >= Math.ceil(samples.length * 0.85)) {
          const nums = smallInts.slice(0, 5).map(Number);
          const strictlyRising = nums.every((n, idx) => idx === 0 || n >= nums[idx - 1]);
          if (strictlyRising) snoHeaders.add(h);
        }
      }
    }

    // 3b. Mobile No (strictly Indian [6-9]xxxxxxxxx phones; rejects Enrollment IDs like A1126307633)
    if (!mapping.mobileNumber) {
      let bestCol = '';
      let bestRatio = 0;
      for (const h of headers) {
        if (usedHeaders.has(h) || snoHeaders.has(h)) continue;
        const samples = colSamples.get(h) || [];
        if (samples.length === 0) continue;
        const phoneHits = samples.filter((v) => isLikelyIndianMobileValue(v)).length;
        const ratio = phoneHits / samples.length;
        if (ratio >= 0.45 && ratio > bestRatio) {
          bestRatio = ratio;
          bestCol = h;
        }
      }
      if (bestCol) {
        mapping.mobileNumber = bestCol;
        usedHeaders.add(bestCol);
      }
    }

    // 3c. Enrollment / Unique ID (e.g. A1126307633 or 11+ digit NIOS IDs)
    if (!mapping.studentId) {
      let bestCol = '';
      let bestRatio = 0;
      for (const h of headers) {
        if (usedHeaders.has(h) || snoHeaders.has(h)) continue;
        const samples = colSamples.get(h) || [];
        if (samples.length === 0) continue;
        const idHits = samples.filter((v) => isLikelyEnrollmentOrStudentId(v)).length;
        const ratio = idHits / samples.length;
        if (ratio >= 0.45 && ratio > bestRatio) {
          bestRatio = ratio;
          bestCol = h;
        }
      }
      if (bestCol) {
        mapping.studentId = bestCol;
        usedHeaders.add(bestCol);
      }
    }

    // 3d. Centre / Branch
    if (!mapping.centre) {
      const centreCol = headers.find((h) => {
        if (usedHeaders.has(h) || snoHeaders.has(h)) return false;
        const samples = colSamples.get(h) || [];
        if (samples.length === 0) return false;
        const hits = samples.filter((v) =>
          /\b(lookerganj|civil\s*lines|varanasi|jaunpur|lkg|cln|vns|jnp)\b/i.test(v),
        ).length;
        return hits >= Math.ceil(samples.length * 0.5);
      });
      if (centreCol) {
        mapping.centre = centreCol;
        usedHeaders.add(centreCol);
      }
    }

    // 3e. Status columns (TMA, Practical, Attendance, Fee Status)
    if (!mapping.feeStatus) {
      const feeStatusCol = headers.find((h) => {
        if (usedHeaders.has(h) || snoHeaders.has(h)) return false;
        const samples = colSamples.get(h) || [];
        if (samples.length === 0) return false;
        const hits = samples.filter((v) => /^(paid|partial|pending|overdue|full\s*paid|unpaid)$/i.test(v)).length;
        return hits >= Math.ceil(samples.length * 0.5);
      });
      if (feeStatusCol) {
        mapping.feeStatus = feeStatusCol;
        usedHeaders.add(feeStatusCol);
      }
    }

    if (!mapping.classAttendanceStatus) {
      const attCol = headers.find((h) => {
        if (usedHeaders.has(h) || snoHeaders.has(h)) return false;
        const samples = colSamples.get(h) || [];
        if (samples.length === 0) return false;
        const hits = samples.filter((v) => /^(regular|irregular|not\s*attending)$/i.test(v)).length;
        return hits >= Math.ceil(samples.length * 0.5);
      });
      if (attCol) {
        mapping.classAttendanceStatus = attCol;
        usedHeaders.add(attCol);
      }
    }

    if (!mapping.practicalStatus) {
      const pracCol = headers.find((h) => {
        if (usedHeaders.has(h) || snoHeaders.has(h)) return false;
        const samples = colSamples.get(h) || [];
        if (samples.length === 0) return false;
        const hits = samples.filter((v) => /^(completed|not\s*completed)$/i.test(v)).length;
        return hits >= Math.ceil(samples.length * 0.35);
      });
      if (pracCol) {
        mapping.practicalStatus = pracCol;
        usedHeaders.add(pracCol);
      }
    }

    if (!mapping.tmaStatus) {
      const tmaCol = headers.find((h) => {
        if (usedHeaders.has(h) || snoHeaders.has(h)) return false;
        const samples = colSamples.get(h) || [];
        if (samples.length === 0) return false;
        const hits = samples.filter((v) => /^(submitted|not\s*submitted)$/i.test(v)).length;
        return hits >= Math.ceil(samples.length * 0.35);
      });
      if (tmaCol) {
        mapping.tmaStatus = tmaCol;
        usedHeaders.add(tmaCol);
      }
    }

    // 3f. Admission Date
    if (!mapping.admissionDate) {
      const dateCol = headers.find((h) => {
        if (usedHeaders.has(h) || snoHeaders.has(h)) return false;
        const samples = colSamples.get(h) || [];
        if (samples.length === 0) return false;
        const hits = samples.filter(
          (v) =>
            /^\d{4}-\d{2}-\d{2}$/.test(v) ||
            /^\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4}$/.test(v) ||
            (/^\d{5}$/.test(v) && Number(v) >= 38000 && Number(v) <= 55000),
        ).length;
        return hits >= Math.ceil(samples.length * 0.5);
      });
      if (dateCol) {
        mapping.admissionDate = dateCol;
        usedHeaders.add(dateCol);
      }
    }

    // 3g. Subjects / Course (excludes TOC / Why / Plan / Email / Father / Remarks columns)
    if (!mapping.subject) {
      const subjCol = headers.find((h) => {
        if (usedHeaders.has(h) || snoHeaders.has(h)) return false;
        const tok = normalizeHeaderToken(h);
        if (
          tok.includes('toc') ||
          tok.includes('why') ||
          tok.includes('plan') ||
          tok.includes('source') ||
          tok.includes('email') ||
          tok.includes('father') ||
          tok.includes('mother') ||
          tok.includes('login') ||
          tok.includes('remark') ||
          tok.includes('note') ||
          tok.includes('fee')
        ) {
          return false;
        }
        const samples = colSamples.get(h) || [];
        if (samples.length === 0) return false;
        const hits = samples.filter((v) =>
          /\b(hindi|english|mathematics|maths|science|social\s*science|physics|chemistry|biology|commerce|accountancy|business\s*studies|economics|history|geography|political\s*science|sociology|psychology|home\s*science|data\s*entry|painting|computer|urdu|sanskrit|physical\s*education|10th|12th|secondary|sr\.?\s*sec|nios)\b/i.test(
            v,
          ),
        ).length;
        return hits >= Math.ceil(samples.length * 0.45);
      });
      if (subjCol) {
        mapping.subject = subjCol;
        usedHeaders.add(subjCol);
      }
    }

    // 3h. Remark / Notes column detection BEFORE Student Name (prevents "fees low" / batch notes masquerading as Name)
    if (!mapping.additionalRemarks) {
      const remarkCol = headers.find((h) => {
        if (usedHeaders.has(h) || snoHeaders.has(h)) return false;
        const samples = colSamples.get(h) || [];
        if (samples.length === 0) return false;
        const hits = samples.filter((v) =>
          /\b(fees?\s*low|low\s*fee|call|follow|installment|promise|remark|note|late|wait|issue|disc|concession|regular\s*batch|morning\s*batch|evening\s*batch)\b/i.test(v),
        ).length;
        return hits >= Math.max(1, Math.ceil(samples.length * 0.2));
      });
      if (remarkCol) {
        mapping.additionalRemarks = remarkCol;
        usedHeaders.add(remarkCol);
      }
    }

    // 3i. Student Name (clean person names; prefers higher uniqueness and excludes remarks/statuses/subjects)
    if (!mapping.studentName) {
      let bestNameCol = '';
      let bestScore = -1;
      for (const h of headers) {
        if (usedHeaders.has(h) || snoHeaders.has(h)) continue;
        const samples = colSamples.get(h) || [];
        if (samples.length === 0) continue;
        const nameLike = samples.filter(
          (v) =>
            /^[\p{L}][\p{L}\s.'-]{1,60}$/u.test(v) &&
            !DATA_ONLY_VALUE_RE.test(v) &&
            !/\b(fees?\s*low|batch|lookerganj|civil\s*lines|varanasi|jaunpur)\b/i.test(v) &&
            v.split(/\s+/).length <= 5,
        );
        const ratio = nameLike.length / samples.length;
        if (ratio >= 0.55) {
          const uniqueness = new Set(nameLike.map((v) => v.toLowerCase())).size / nameLike.length;
          const colScore = ratio * 10 + uniqueness * 5;
          if (colScore > bestScore) {
            bestScore = colScore;
            bestNameCol = h;
          }
        }
      }
      if (bestNameCol) {
        mapping.studentName = bestNameCol;
        usedHeaders.add(bestNameCol);
      }
    }

    // 3j. Mathematical fee detection for unmapped/headerless/partially-mapped numeric columns
    const numericCols = headers.filter((h) => {
      if (usedHeaders.has(h) || snoHeaders.has(h)) return false;
      const samples = colSamples.get(h) || [];
      if (samples.length < 2) return false;
      if (samples.some((v) => isLikelyIndianMobileValue(v) || isLikelyEnrollmentOrStudentId(v))) {
        return false;
      }
      const nums = samples
        .map((v) => (ZERO_OR_FEE_STATUS_CELL_RE.test(v.trim()) ? 0 : parseFeeNumberNullable(v)))
        .filter((n): n is number => n !== null && n >= 0 && n <= 200000);
      return nums.length >= Math.max(2, Math.ceil(samples.length * 0.5));
    });

    if (!mapping.totalFee && !mapping.paidAmount && !mapping.pendingAmount) {
      let detectedTriple: [string, string, string] | null = null;
      for (let i = 0; i < numericCols.length && !detectedTriple; i++) {
        for (let j = 0; j < numericCols.length && !detectedTriple; j++) {
          if (i === j) continue;
          for (let k = 0; k < numericCols.length && !detectedTriple; k++) {
            if (k === i || k === j) continue;
            const cTotal = numericCols[i];
            const cPaid = numericCols[j];
            const cPend = numericCols[k];
            let validRows = 0;
            let eqMatches = 0;
            for (const r of sampleSlice) {
              const t = parseFeeNumberNullable(r[cTotal]);
              const p = parseFeeNumberNullable(r[cPaid]);
              const b = parseFeeNumberNullable(r[cPend]);
              if (t !== null && p !== null && b !== null && t > 0) {
                validRows++;
                if (Math.abs(t - (p + b)) <= 2) eqMatches++;
              }
            }
            if (validRows >= 3 && eqMatches >= Math.ceil(validRows * 0.7)) {
              detectedTriple = [cTotal, cPaid, cPend];
            }
          }
        }
      }

      if (detectedTriple) {
        mapping.totalFee = detectedTriple[0];
        mapping.paidAmount = detectedTriple[1];
        mapping.pendingAmount = detectedTriple[2];
        usedHeaders.add(detectedTriple[0]);
        usedHeaders.add(detectedTriple[1]);
        usedHeaders.add(detectedTriple[2]);
      } else {
        const feeCols = numericCols.filter((h) => {
          const vals = (colSamples.get(h) || [])
            .map(parseFeeNumberNullable)
            .filter((n): n is number => n !== null && n >= 0);
          const maxVal = vals.length > 0 ? Math.max(...vals) : 0;
          return maxVal >= 1000;
        });

        let detectedPair: [string, string] | null = null;
        for (let i = 0; i < feeCols.length && !detectedPair; i++) {
          for (let j = 0; j < feeCols.length && !detectedPair; j++) {
            if (i === j) continue;
            const cA = feeCols[i];
            const cB = feeCols[j];
            let validRows = 0;
            let aGeB = 0;
            for (const r of sampleSlice) {
              const a = parseFeeNumberNullable(r[cA]);
              const b = parseFeeNumberNullable(r[cB]);
              if (a !== null && b !== null && a >= 500) {
                validRows++;
                if (a >= b) aGeB++;
              }
            }
            if (validRows >= 3 && aGeB >= Math.ceil(validRows * 0.8)) {
              detectedPair = [cA, cB];
            }
          }
        }

        if (detectedPair) {
          mapping.totalFee = detectedPair[0];
          const secondSamples = colSamples.get(detectedPair[1]) || [];
          const looksPending = secondSamples.some((v) => /^(nil|nill|clear|cleared|no\s*due|due|pending)$/i.test(v));
          if (looksPending) {
            mapping.pendingAmount = detectedPair[1];
          } else {
            mapping.paidAmount = detectedPair[1];
          }
          usedHeaders.add(detectedPair[0]);
          usedHeaders.add(detectedPair[1]);
        } else if (feeCols.length === 1) {
          mapping.totalFee = feeCols[0];
          usedHeaders.add(feeCols[0]);
        }
      }
    } else if (numericCols.length > 0) {
      // Partial header match fallback: fill missing Total / Paid / Pending via Total == Paid + Pending
      if (mapping.totalFee && mapping.paidAmount && !mapping.pendingAmount) {
        const matchPend = numericCols.find((col) => {
          let valid = 0;
          let eq = 0;
          for (const r of sampleSlice) {
            const t = parseFeeNumberNullable(r[mapping.totalFee!]);
            const p = parseFeeNumberNullable(r[mapping.paidAmount!]);
            const c = ZERO_OR_FEE_STATUS_CELL_RE.test((r[col] || '').trim()) ? 0 : parseFeeNumberNullable(r[col]);
            if (t !== null && p !== null && c !== null && t > 0) {
              valid++;
              if (Math.abs(t - (p + c)) <= 2) eq++;
            }
          }
          return valid >= 3 && eq >= Math.ceil(valid * 0.7);
        });
        if (matchPend) {
          mapping.pendingAmount = matchPend;
          usedHeaders.add(matchPend);
        }
      } else if (mapping.totalFee && !mapping.paidAmount && mapping.pendingAmount) {
        const matchPaid = numericCols.find((col) => {
          let valid = 0;
          let eq = 0;
          for (const r of sampleSlice) {
            const t = parseFeeNumberNullable(r[mapping.totalFee!]);
            const b = parseFeeNumberNullable(r[mapping.pendingAmount!]);
            const c = parseFeeNumberNullable(r[col]);
            if (t !== null && b !== null && c !== null && t > 0) {
              valid++;
              if (Math.abs(t - (c + b)) <= 2) eq++;
            }
          }
          return valid >= 3 && eq >= Math.ceil(valid * 0.7);
        });
        if (matchPaid) {
          mapping.paidAmount = matchPaid;
          usedHeaders.add(matchPaid);
        }
      } else if (!mapping.totalFee && mapping.paidAmount && mapping.pendingAmount) {
        const matchTot = numericCols.find((col) => {
          let valid = 0;
          let eq = 0;
          for (const r of sampleSlice) {
            const p = parseFeeNumberNullable(r[mapping.paidAmount!]);
            const b = parseFeeNumberNullable(r[mapping.pendingAmount!]);
            const c = parseFeeNumberNullable(r[col]);
            if (p !== null && b !== null && c !== null && c > 0) {
              valid++;
              if (Math.abs(c - (p + b)) <= 2) eq++;
            }
          }
          return valid >= 3 && eq >= Math.ceil(valid * 0.7);
        });
        if (matchTot) {
          mapping.totalFee = matchTot;
          usedHeaders.add(matchTot);
        }
      }
    }
  }

  return mapping;
}

export function normalizeStudentMatchName(name: string): string {
  return String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/^(mr|mrs|ms|miss|km|kumari|shri|smt|dr)\.?\s+/i, '')
    .replace(/[^a-z0-9\u0900-\u097f]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function cleanMobileNumber(raw: string): string {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return '';

  // Support cells with multiple numbers like "9876543210 / 9123456789" or "9876543210, 9123456789"
  if (/[/,;|&\n]/.test(trimmed)) {
    const parts = trimmed.split(/[/,;|&\n]+/).map((p) => p.trim()).filter(Boolean);
    for (const part of parts) {
      const candidate = cleanMobileNumber(part);
      if (/^\d{7,15}$/.test(candidate)) {
        return candidate;
      }
    }
  }

  const expanded =
    /^\d+(\.\d+)?e[+-]?\d+$/i.test(trimmed) && Number.isFinite(Number(trimmed))
      ? Number(trimmed).toFixed(0)
      : trimmed;
  const noDecimal = expanded.replace(/\.0+$/, '');
  const digits = noDecimal.replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) {
    return digits.slice(2);
  }
  if (digits.length === 11 && digits.startsWith('0')) {
    return digits.slice(1);
  }
  if (digits.length >= 7 && digits.length <= 15) {
    return digits;
  }
  if (digits.length > 15) {
    const indianMatch = noDecimal.match(/(?:\+?91[\s-]?)?([6-9]\d{9})\b/);
    if (indianMatch?.[1]) return indianMatch[1];
    return digits.slice(0, 10);
  }
  return noDecimal.replace(/\s+/g, ' ').slice(0, 20);
}

export function normalizeExcelDate(raw: string, fallbackIso: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return fallbackIso;
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;

  if (/^\d{4,5}(\.\d+)?$/.test(trimmed)) {
    const serial = Math.floor(Number(trimmed));
    if (serial > 20000 && serial < 70000) {
      const utcEpoch = Date.UTC(1899, 11, 30) + serial * 86400000;
      return new Date(utcEpoch).toISOString().slice(0, 10);
    }
  }

  const dmy = trimmed.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/);
  if (dmy) {
    const day = Number(dmy[1]);
    const month = Number(dmy[2]);
    let year = Number(dmy[3]);
    if (year < 100) year += 2000;
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }

  const parsed = new Date(trimmed);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString().slice(0, 10);
  }
  return fallbackIso;
}

export function resolveCentreFromExcel(raw: string, fallback: CentreId): CentreId {
  const clean = raw.trim().toLowerCase();
  if (!clean) return fallback;

  for (const c of CANONICAL_CENTRES) {
    if (
      clean === c.id.toLowerCase() ||
      clean === c.code.toLowerCase() ||
      clean === c.name.toLowerCase()
    ) {
      return c.id;
    }
  }

  if (clean.includes('lookerganj') || clean.includes('lkg')) return 'vp_lookerganj';
  if (clean.includes('civil') || clean.includes('cln')) return 'vp_civillines';
  if (clean.includes('varanasi') || clean.includes('vns') || clean.includes('banaras')) return 'xis_varanasi';
  if (clean.includes('jaunpur') || clean.includes('jnp')) return 'xis_jaunpur';

  return fallback;
}

function normalizeTma(raw: string): TmaStatus {
  const v = raw.trim().toLowerCase();
  if (!v) return 'Pending';
  if (v.includes('not') || v === 'no' || v === 'absent' || v === '0') return 'Not Submitted';
  if (v.includes('submit') || v.includes('done') || v.includes('complete') || v === 'yes' || v === 'ok') {
    return 'Submitted';
  }
  return 'Pending';
}

function normalizePractical(raw: string): PracticalStatus {
  const v = raw.trim().toLowerCase();
  if (!v) return 'Pending';
  if (v.includes('not') || v === 'no' || v === 'absent' || v === '0') return 'Not Completed';
  if (v.includes('complet') || v.includes('submit') || v.includes('done') || v === 'yes' || v === 'ok') {
    return 'Completed';
  }
  return 'Pending';
}

function normalizeAttendance(raw: string): ClassAttendanceStatus {
  const v = raw.trim().toLowerCase();
  if (!v) return 'Not Attending';
  if (v.includes('not') || v.includes('absent') || v === 'no' || v === 'never' || v === '0') {
    return 'Not Attending';
  }
  if (v.includes('irreg') || v.includes('low') || v.includes('some') || v.includes('rare')) {
    return 'Irregular';
  }
  if (
    v.includes('reg') ||
    v === 'yes' ||
    v === 'present' ||
    v === 'attending' ||
    v === 'active' ||
    v === 'ok' ||
    v === '1'
  ) {
    return 'Regular';
  }
  return 'Not Attending';
}

function normalizeTc(raw: string): TcStatus {
  const v = raw.trim().toLowerCase();
  if (!v) return 'Not Received';
  if (v.includes('applicable') || v === 'na' || v === 'n/a') return 'Not Applicable';
  if (v.includes('not') || v === 'no') return 'Not Received';
  if (v.includes('receiv') || v.includes('submit') || v === 'yes' || v === 'done') return 'Received';
  return 'Not Received';
}

function normalizeBook(raw: string): BookStatus {
  const v = raw.trim().toLowerCase();
  if (!v) return 'Pending';
  if (v.includes('not') || v === 'no') return 'Not Received';
  if (v.includes('receiv') || v.includes('issue') || v.includes('given') || v === 'yes') return 'Received';
  return 'Pending';
}

function normalizeExam(raw: string): ExaminationStatus {
  const v = raw.trim().toLowerCase();
  if (!v) return 'Not Completed';
  if (v.includes('partial')) return 'Partially Completed';
  if (v.includes('not') || v === 'no') return 'Not Completed';
  if (v.includes('complet') || v.includes('pass') || v.includes('done') || v === 'yes') return 'Completed';
  return 'Not Completed';
}

export interface NormalizedImportStudent {
  rowIndex: number;
  studentId: string;
  studentName: string;
  mobileNumber: string;
  centreId: CentreId;
  centreName: string;
  subject: string;
  tcStatus: TcStatus;
  bookStatus: BookStatus;
  classAttendanceStatus: ClassAttendanceStatus;
  tmaStatus: TmaStatus;
  practicalStatus: PracticalStatus;
  examinationStatus: ExaminationStatus;
  admissionDate: string;
  whyNios: string;
  currentEducationStatus: string;
  futurePlanning: string;
  additionalRemarks: string;
  totalFee: number;
  paidAmount: number;
  pendingAmount: number;
  tmaFee: number;
  examFee: number;
  recoveryStatus: RecoveryStatus;
  followUpStatus: FeeFollowUpStatus;
  explicitFeeDetected: boolean;
  explicitTmaFeeDetected: boolean;
  explicitExamFeeDetected: boolean;
  explicitSubjectDetected: boolean;
  explicitTmaDetected?: boolean;
  explicitPracticalDetected?: boolean;
  extraColumns: Record<string, string>;
  rowColor: string;
  cellColors: Record<string, string>;
  validationError: string | null;
}

export const MOCK_SUBJECT_PLACEHOLDERS = [
  'hindi, english, mathematics, science, social science',
  'general nios stream',
  'n/a',
  'na',
  'none',
  'nil',
  'not provided',
  '-',
  '—',
] as const;

export function isMockSubjectValue(subject?: string): boolean {
  const normalized = String(subject ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
  if (!normalized) return false;
  return (MOCK_SUBJECT_PLACEHOLDERS as readonly string[]).includes(normalized);
}

export function sanitizeRealSubject(
  subject?: string,
  options?: { stripLegacyDefaultList?: boolean },
): string {
  const trimmed = String(subject ?? '').trim();
  if (!trimmed) return '';
  const norm = trimmed.replace(/\s+/g, ' ').toLowerCase();
  if (
    norm === 'general nios stream' ||
    norm === 'n/a' ||
    norm === 'na' ||
    norm === 'none' ||
    norm === 'nil' ||
    norm === 'not provided' ||
    norm === '-' ||
    norm === '—'
  ) {
    return '';
  }
  if (
    options?.stripLegacyDefaultList === true &&
    norm === 'hindi, english, mathematics, science, social science'
  ) {
    return '';
  }
  return trimmed.slice(0, 200);
}

export function countStudentSubjects(subject?: string): number {
  const clean = sanitizeRealSubject(subject, { stripLegacyDefaultList: false });
  if (!clean) return 0;
  const parts = clean
    .split(/[,;|\n/]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s !== '-' && s !== '—');
  return Math.min(20, parts.length);
}

const CANONICAL_COLOR_FIELDS: Array<keyof ExcelColumnMapping> = [
  'studentName',
  'mobileNumber',
  'tmaStatus',
  'practicalStatus',
  'classAttendanceStatus',
  'totalFee',
  'paidAmount',
  'pendingAmount',
  'tmaFee',
  'examFee',
  'feeStatus',
];

const PLACEHOLDER_STUDENT_ID_RE =
  /^(pending|pending-id|na|n-a|nil|none|null|new|fresh|old|tba|tbd|awaited|wait|waiting|applied|apply|applying|process|under-process|running|continue|not-allotted|not-alloted|not-generated|not-available|not-issued|not-assigned|not-done|not-received|no-id|without-id|unknown|same|self|blank|empty|yes|no|nios|student|active|inactive|completed|incomplete|regular|0+|[x_-]+)$/i;

export function sanitizeImportedStudentId(rawStudentId: string): string {
  const cleaned = String(rawStudentId ?? '')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  if (!cleaned || cleaned.length < 3 || PLACEHOLDER_STUDENT_ID_RE.test(cleaned)) {
    return '';
  }
  return cleaned;
}

export const COMMON_BRANCH_HEADERS_STORAGE_KEY = 'vp_common_lookerganj_headers_v1';

const HEADER_WORD_SYNONYMS: Record<string, string> = {
  fathers: 'father',
  mothers: 'mother',
  subjects: 'subject',
  fees: 'fee',
  corrections: 'correction',
  details: 'detail',
  numbers: 'no',
  number: 'no',
  num: 'no',
  password: 'pass',
  pwd: 'pass',
  passwd: 'pass',
  enquiry: 'inquiry',
  enquiries: 'inquiry',
  inquiries: 'inquiry',
  preparations: 'preparation',
  prep: 'preparation',
  plans: 'plan',
  planning: 'plan',
  mobiles: 'mobile',
  phones: 'phone',
  ids: 'id',
  emails: 'email',
};

function tokenizeCommonHeaderWords(h: string): string[] {
  const rawWords = String(h ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/['’]s\b/gi, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

  return rawWords.map((w) => {
    if (HEADER_WORD_SYNONYMS[w]) return HEADER_WORD_SYNONYMS[w];
    if (w.length > 4 && w.endsWith('s') && !/(ss|us|is|os)$/i.test(w)) {
      return w.slice(0, -1);
    }
    return w;
  });
}

export function canonicalCommonHeaderToken(h: string): string {
  return tokenizeCommonHeaderWords(h).join('');
}

export function isKeepEmptyManualColumnHeading(header: string): boolean {
  const cleaned = String(header ?? '')
    .replace(/^\uFEFF/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  if (!cleaned) return false;
  const compact = cleaned.replace(/\s+/g, '');
  if (
    compact === 'whynios' ||
    compact === 'currenteducationstatus' ||
    compact === 'futureplanning' ||
    compact === 'sourceofinquiry' ||
    compact === 'sourceofenquiry'
  ) {
    return true;
  }
  if (/\bwhy\b.*\b(nios|admission)\b/.test(cleaned)) return true;
  if (/\bsource\b.*\b(inquiry|enquiry)\b/.test(cleaned) || /\b(inquiry|enquiry)\s+source\b/.test(cleaned)) {
    return true;
  }
  if (/\bcurrent\b.*\beducation\b/.test(cleaned) || /\beducation\s+prep/.test(cleaned)) {
    return true;
  }
  if (/\bfuture\b.*\bplan/.test(cleaned)) return true;
  return false;
}

export function alignHeaderToCommonSchema(rawHeader: string, commonHeaders: string[]): string {
  const clean = String(rawHeader ?? '').trim().slice(0, 50);
  if (!clean || commonHeaders.length === 0) return clean;
  const targetWords = tokenizeCommonHeaderWords(clean);
  const targetToken = targetWords.join('');
  if (!targetToken) return clean;

  // 1. Exact canonical match (handles Father's Name / Fathers Name / Father Name, TOC Subject / TOC Subjects, etc.)
  for (const ch of commonHeaders) {
    if (canonicalCommonHeaderToken(ch) === targetToken) {
      return ch.trim().slice(0, 50);
    }
  }

  // 2. Safe abbreviation / extension match for multi-word sheet headers (e.g. "Email" -> "EMAIL ID", "NIOS Login ID" -> "NIOS LOGIN ID & PASSWORD")
  const conflictPairs: Array<[string, string]> = [
    ['name', 'no'],
    ['name', 'mobile'],
    ['name', 'phone'],
    ['father', 'mother'],
    ['father', 'student'],
    ['tma', 'exam'],
    ['total', 'left'],
    ['paid', 'pending'],
    ['toc', 'main'],
  ];
  const hasConflict = (aWords: string[], bWords: string[]) => {
    const aSet = new Set(aWords);
    const bSet = new Set(bWords);
    for (const [x, y] of conflictPairs) {
      if ((aSet.has(x) && bSet.has(y)) || (aSet.has(y) && bSet.has(x))) {
        return true;
      }
    }
    return false;
  };

  for (const ch of commonHeaders) {
    const chWords = tokenizeCommonHeaderWords(ch);
    if (chWords.length === 0 || hasConflict(targetWords, chWords)) continue;
    const chSet = new Set(chWords);
    const targetSet = new Set(targetWords);
    // Exact email <-> email id
    if (
      (targetToken === 'email' && chWords.includes('email')) ||
      (chWords.join('') === 'email' && targetWords.includes('email'))
    ) {
      return ch.trim().slice(0, 50);
    }
    // Meaningful multi-word subset match (at least 2 overlapping tokens or prefix word match on unique roots like nios+login / calling / correction)
    const commonWords = targetWords.filter((w) => chSet.has(w));
    const smallerLen = Math.min(targetWords.length, chWords.length);
    if (
      (smallerLen >= 2 && commonWords.length === smallerLen) ||
      (smallerLen === 1 &&
        commonWords.length === 1 &&
        ['calling', 'correction', 'toc'].includes(commonWords[0]) &&
        !targetSet.has('fee') &&
        !chSet.has('fee'))
    ) {
      return ch.trim().slice(0, 50);
    }
  }

  return clean;
}

export function getStudentExtraColumnValue(
  extraColumns: Record<string, string> | undefined,
  targetKey: string,
): string {
  if (!extraColumns) return '';
  const direct = extraColumns[targetKey];
  if (direct !== undefined && String(direct).trim().length > 0) {
    return String(direct).trim();
  }
  const targetToken = canonicalCommonHeaderToken(targetKey);
  if (!targetToken) return '';
  for (const [k, v] of Object.entries(extraColumns)) {
    const val = String(v ?? '').trim();
    if (!val) continue;
    if (
      canonicalCommonHeaderToken(k) === targetToken ||
      alignHeaderToCommonSchema(k, [targetKey]) === targetKey.trim().slice(0, 50)
    ) {
      return val;
    }
  }
  return '';
}

export function mergeImportedExtraColumns(
  newExtra: Record<string, string> | undefined,
  existingExtra?: Record<string, string>,
): Record<string, string> {
  const merged: Record<string, string> = {};
  const seenTokens = new Set<string>();

  const addEntry = (rawKey: string, rawVal: string) => {
    const cleanKey = String(rawKey ?? '').trim().slice(0, 50);
    const cleanVal = String(rawVal ?? '').trim().slice(0, 300);
    if (!cleanKey || !cleanVal || isKeepEmptyManualColumnHeading(cleanKey)) return;
    if (Object.keys(merged).length >= 35) return;
    const tok = canonicalCommonHeaderToken(cleanKey);
    if (tok && seenTokens.has(tok) && merged[cleanKey] === undefined) return;
    if (tok) seenTokens.add(tok);
    merged[cleanKey] = cleanVal;
  };

  if (newExtra) {
    for (const [k, v] of Object.entries(newExtra)) {
      addEntry(k, v);
    }
  }
  if (existingExtra) {
    for (const [k, v] of Object.entries(existingExtra)) {
      addEntry(k, v);
    }
  }

  return merged;
}

export function computeAutoExcelColumnWidth(
  label: string,
  colKey: string,
  fitScreenMode: boolean,
): number {
  const cleanLabel = String(label ?? '').trim();
  if (!cleanLabel) return fitScreenMode ? 115 : 155;
  const words = cleanLabel.split(/\s+/).filter(Boolean);
  const longestWord = words.reduce((max, w) => Math.max(max, w.length), 0);
  const charPx = fitScreenMode ? 7.6 : 8.4;
  const longestWordWidth = Math.ceil(longestWord * (fitScreenMode ? 8.3 : 9.0)) + 24;
  const targetLineChars =
    cleanLabel.length <= 13 ? cleanLabel.length : Math.ceil(cleanLabel.length / 2);
  const wrappedWidth = Math.ceil(targetLineChars * charPx) + 26;
  const minFloor = colKey.startsWith('extra:') ? (fitScreenMode ? 96 : 118) : fitScreenMode ? 60 : 86;
  return Math.max(minFloor, longestWordWidth, Math.min(fitScreenMode ? 240 : 290, wrappedWidth));
}

export function loadStoredCommonBranchHeaders(): string[] {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return [];
    const raw = window.localStorage.getItem(COMMON_BRANCH_HEADERS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed
        .map((x) => String(x ?? '').trim().slice(0, 50))
        .filter(Boolean)
        .slice(0, 35);
    }
  } catch {
    // ignore storage errors
  }
  return [];
}

export function saveCommonBranchHeaders(headers: string[]): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    const cleaned = headers.map((x) => String(x ?? '').trim().slice(0, 50)).filter(Boolean).slice(0, 35);
    if (cleaned.length > 0) {
      window.localStorage.setItem(COMMON_BRANCH_HEADERS_STORAGE_KEY, JSON.stringify(cleaned));
    } else {
      window.localStorage.removeItem(COMMON_BRANCH_HEADERS_STORAGE_KEY);
    }
  } catch {
    // ignore storage errors
  }
}

export function pruneStoredCommonBranchHeaders(deletedKeys: readonly string[]): void {
  if (deletedKeys.length === 0) return;
  const existing = loadStoredCommonBranchHeaders();
  if (existing.length === 0) return;
  const delLower = new Set(deletedKeys.map((k) => String(k ?? '').trim().toLowerCase()).filter(Boolean));
  const delTokens = new Set(deletedKeys.map((k) => canonicalCommonHeaderToken(k)).filter(Boolean));
  const remaining = existing.filter((h) => {
    const clean = h.trim();
    if (!clean) return false;
    if (delLower.has(clean.toLowerCase())) return false;
    const tok = canonicalCommonHeaderToken(clean);
    if (tok && delTokens.has(tok)) return false;
    return true;
  });
  saveCommonBranchHeaders(remaining);
}

export function extractCommonBranchExtraHeaders(students: Pick<Student, 'centreId' | 'extraColumns'>[]): string[] {
  const keys: string[] = [];
  const seenTokens = new Set<string>();

  const addKey = (rawKey: string) => {
    const clean = rawKey.trim().slice(0, 50);
    if (!clean || keys.length >= 35) return;
    const token = canonicalCommonHeaderToken(clean);
    if (!token) {
      if (!keys.includes(clean)) keys.push(clean);
      return;
    }
    if (!seenTokens.has(token)) {
      seenTokens.add(token);
      keys.push(clean);
    }
  };

  // 1. Prioritize Lookerganj branch headings as the master common schema across all centres
  for (const s of students) {
    if (s.centreId !== 'vp_lookerganj' || !s.extraColumns) continue;
    for (const k of Object.keys(s.extraColumns)) {
      addKey(k);
    }
  }

  // 2. Include any persisted Lookerganj master headings if current scope (e.g. non-super-admin) has only own centre
  for (const k of loadStoredCommonBranchHeaders()) {
    addKey(k);
  }

  // 3. Union any additional unique headings from other centres
  for (const s of students) {
    if (s.centreId === 'vp_lookerganj' || !s.extraColumns) continue;
    for (const k of Object.keys(s.extraColumns)) {
      addKey(k);
    }
  }

  return keys;
}

export function mergeExtraColumnsWithConfig(
  extractedHeaders: readonly string[],
  config?: { customColumns?: readonly string[]; deletedExtraColumns?: readonly string[] },
): string[] {
  const deletedTokens = new Set(
    (config?.deletedExtraColumns || []).map((k) => canonicalCommonHeaderToken(k)).filter(Boolean),
  );
  const deletedLower = new Set(
    (config?.deletedExtraColumns || []).map((k) => String(k ?? '').trim().toLowerCase()).filter(Boolean),
  );

  const result: string[] = [];
  const seenTokens = new Set<string>();
  const seenLower = new Set<string>();

  const pushHeader = (raw: string, allowIfDeleted = false) => {
    const clean = String(raw ?? '').trim().slice(0, 50);
    if (!clean || result.length >= 35) return;
    const lower = clean.toLowerCase();
    const token = canonicalCommonHeaderToken(clean);
    if (!allowIfDeleted) {
      if (deletedLower.has(lower) || (token && deletedTokens.has(token))) return;
    }
    if (token) {
      if (seenTokens.has(token)) return;
      seenTokens.add(token);
      seenLower.add(lower);
      result.push(clean);
    } else if (!seenLower.has(lower)) {
      seenLower.add(lower);
      result.push(clean);
    }
  };

  for (const k of config?.customColumns || []) {
    pushHeader(k, false);
  }
  for (const k of extractedHeaders) {
    pushHeader(k, false);
  }
  return result;
}

/**
 * Extracts custom / heading-only / blank extra columns belonging to the Jaunpur centre (`xis_jaunpur`)
 * so they can be uniformly added across all centres without pulling all 35 raw bulk-import columns.
 */
export function extractJaunpurHeadingAndBlankColumns(
  students: ReadonlyArray<Pick<Student, 'centreId' | 'extraColumns'>>,
  sheetConfigs: ReadonlyArray<Pick<ExcelSheetConfig, 'configId' | 'customColumns' | 'deletedExtraColumns'>> = [],
): string[] {
  const result: string[] = [];
  const seenTokens = new Set<string>();

  const globalDeletedLower = new Set<string>();
  const globalDeletedTokens = new Set<string>();
  for (const cfg of sheetConfigs) {
    if (cfg.configId !== 'global' && cfg.configId !== 'xis_jaunpur') continue;
    for (const del of cfg.deletedExtraColumns || []) {
      const cleanDel = String(del || '').trim();
      if (!cleanDel) continue;
      globalDeletedLower.add(cleanDel.toLowerCase());
      const tok = canonicalCommonHeaderToken(cleanDel);
      if (tok) globalDeletedTokens.add(tok);
    }
  }

  const pushHeading = (raw: string) => {
    const clean = String(raw || '').trim().slice(0, 50);
    if (!clean || result.length >= 35) return;
    if (/^(__EMPTY(?:_\d+)?|col_\d+|column_\d+)$/i.test(clean)) return;
    const token = canonicalCommonHeaderToken(clean);
    if (globalDeletedLower.has(clean.toLowerCase()) || (token && globalDeletedTokens.has(token))) return;
    if (token) {
      if (seenTokens.has(token)) return;
      seenTokens.add(token);
      result.push(clean);
    } else if (!result.some((r) => r.toLowerCase() === clean.toLowerCase())) {
      result.push(clean);
    }
  };

  // 1. Explicitly configured custom/blank headings saved on Jaunpur sheet config
  const jaunpurConfig = sheetConfigs.find((c) => c.configId === 'xis_jaunpur');
  for (const k of jaunpurConfig?.customColumns || []) {
    pushHeading(k);
  }

  // 2. Sparse / blank / heading-only extra columns on Jaunpur students
  const jaunpurStudents = students.filter((s) => s.centreId === 'xis_jaunpur');
  if (jaunpurStudents.length > 0) {
    const counts = new Map<string, number>();
    const orderedKeys: string[] = [];
    for (const s of jaunpurStudents) {
      if (!s.extraColumns) continue;
      for (const [rawKey, rawVal] of Object.entries(s.extraColumns)) {
        const clean = rawKey.trim().slice(0, 50);
        if (!clean) continue;
        if (!counts.has(clean)) {
          counts.set(clean, 0);
          orderedKeys.push(clean);
        }
        if (String(rawVal ?? '').trim().length > 0) {
          counts.set(clean, (counts.get(clean) || 0) + 1);
        }
      }
    }

    const includeAllJaunpurKeys = orderedKeys.length <= 15;
    const sparseThreshold = Math.max(2, Math.floor(jaunpurStudents.length * 0.35));
    for (const key of orderedKeys) {
      const filled = counts.get(key) || 0;
      if (includeAllJaunpurKeys || filled === 0 || filled <= sparseThreshold) {
        pushHeading(key);
      }
    }
  }

  return result;
}

/**
 * Finds unmapped custom column headings in an uploaded Excel/CSV sheet that have only headings
 * (all cells blank) or sparse entries on Jaunpur imports so headings are preserved across all centres.
 */
export function extractBlankAndSparseSheetHeadings(
  headers: readonly string[],
  mapping: ExcelColumnMapping,
  rawRows: ReadonlyArray<Record<string, string>>,
  targetCentre: CentreId,
): string[] {
  const mappedHeaders = new Set(
    Object.values(mapping)
      .filter((h): h is string => Boolean(h))
      .map((h) => h.trim()),
  );
  const out: string[] = [];
  const seen = new Set<string>();

  const unmappedCandidates: Array<{ clean: string; filled: number }> = [];
  for (const rawHdr of headers) {
    const clean = String(rawHdr ?? '').trim().slice(0, 50);
    if (!clean || mappedHeaders.has(clean) || /^(__EMPTY(?:_\d+)?|col_\d+|column_\d+)$/i.test(clean)) continue;
    const token = normalizeHeaderToken(clean);
    if (token === 'sno' || token === 'srno' || token === 'slno' || token === 'serialno' || token === 'serialnumber') {
      continue;
    }
    let filled = 0;
    for (const row of rawRows) {
      if (String(row[rawHdr] ?? '').trim().length > 0) filled++;
    }
    unmappedCandidates.push({ clean, filled });
  }

  const sparseThreshold = Math.max(2, Math.floor(rawRows.length * 0.35));
  const includeAllJaunpur = targetCentre === 'xis_jaunpur' && unmappedCandidates.length <= 15;

  for (const item of unmappedCandidates) {
    if (item.filled === 0 || includeAllJaunpur || (targetCentre === 'xis_jaunpur' && item.filled <= sparseThreshold)) {
      const tok = canonicalCommonHeaderToken(item.clean) || item.clean.toLowerCase();
      if (!seen.has(tok) && out.length < 35) {
        seen.add(tok);
        out.push(item.clean);
      }
    }
  }
  return out;
}

export interface StudentExtraColumnBatchUpdate {
  studentId: string;
  extraColumns: Record<string, string>;
  cellColors?: Record<string, string>;
}

export function computeRenameExtraColumnStudentUpdates<
  T extends { studentId: string; extraColumns?: Record<string, string>; cellColors?: Record<string, string> },
>(students: readonly T[], oldKey: string, newKey: string): StudentExtraColumnBatchUpdate[] {
  const cleanOld = String(oldKey ?? '').trim().slice(0, 50);
  const cleanNew = String(newKey ?? '').trim().slice(0, 50);
  if (!cleanOld || !cleanNew || cleanOld === cleanNew) return [];

  const updates: StudentExtraColumnBatchUpdate[] = [];
  const oldColorKey = `extra:${cleanOld}`;
  const newColorKey = `extra:${cleanNew}`;

  for (const s of students) {
    const hasExtra = Boolean(s.extraColumns && Object.prototype.hasOwnProperty.call(s.extraColumns, cleanOld));
    const hasColor = Boolean(s.cellColors && Object.prototype.hasOwnProperty.call(s.cellColors, oldColorKey));
    if (!hasExtra && !hasColor) continue;

    const nextExtra: Record<string, string> = {};
    if (s.extraColumns) {
      for (const [k, v] of Object.entries(s.extraColumns)) {
        if (k === cleanOld) {
          if (!Object.prototype.hasOwnProperty.call(s.extraColumns, cleanNew) || !String(s.extraColumns[cleanNew] ?? '').trim()) {
            nextExtra[cleanNew] = v;
          }
        } else {
          nextExtra[k] = v;
        }
      }
    }

    let nextCellColors: Record<string, string> | undefined;
    if (hasColor && s.cellColors) {
      nextCellColors = {};
      for (const [k, v] of Object.entries(s.cellColors)) {
        if (k === oldColorKey) {
          if (!Object.prototype.hasOwnProperty.call(s.cellColors, newColorKey)) {
            nextCellColors[newColorKey] = v;
          }
        } else {
          nextCellColors[k] = v;
        }
      }
    }

    updates.push({
      studentId: s.studentId,
      extraColumns: nextExtra,
      ...(nextCellColors ? { cellColors: nextCellColors } : {}),
    });
  }

  return updates;
}

export function computeDeleteMultipleExtraColumnsStudentUpdates<
  T extends { studentId: string; extraColumns?: Record<string, string>; cellColors?: Record<string, string> },
>(students: readonly T[], targetKeys: readonly string[]): StudentExtraColumnBatchUpdate[] {
  const cleanTargets = targetKeys
    .map((k) => String(k ?? '').trim().slice(0, 50))
    .filter(Boolean);
  if (cleanTargets.length === 0) return [];

  const targetExact = new Set(cleanTargets);
  const targetLower = new Set(cleanTargets.map((k) => k.toLowerCase()));
  const targetTokens = new Set(cleanTargets.map((k) => canonicalCommonHeaderToken(k)).filter(Boolean));

  const isTargetKey = (rawKey: string): boolean => {
    const trimmed = String(rawKey ?? '').trim();
    if (!trimmed) return false;
    if (targetExact.has(rawKey) || targetExact.has(trimmed)) return true;
    if (targetLower.has(trimmed.toLowerCase())) return true;
    const tok = canonicalCommonHeaderToken(trimmed);
    return Boolean(tok && targetTokens.has(tok));
  };

  const updates: StudentExtraColumnBatchUpdate[] = [];

  for (const s of students) {
    let removedExtra = false;
    const nextExtra: Record<string, string> = {};
    if (s.extraColumns) {
      for (const [k, v] of Object.entries(s.extraColumns)) {
        if (isTargetKey(k)) {
          removedExtra = true;
        } else {
          nextExtra[k] = v;
        }
      }
    }

    let removedColor = false;
    let nextCellColors: Record<string, string> | undefined;
    if (s.cellColors) {
      const candidateColors: Record<string, string> = {};
      for (const [k, v] of Object.entries(s.cellColors)) {
        if (k.startsWith('extra:') && isTargetKey(k.slice(6))) {
          removedColor = true;
        } else {
          candidateColors[k] = v;
        }
      }
      if (removedColor) {
        nextCellColors = candidateColors;
      }
    }

    if (!removedExtra && !removedColor) continue;

    updates.push({
      studentId: s.studentId,
      extraColumns: nextExtra,
      ...(nextCellColors ? { cellColors: nextCellColors } : {}),
    });
  }

  return updates;
}

export function computeDeleteExtraColumnStudentUpdates<
  T extends { studentId: string; extraColumns?: Record<string, string>; cellColors?: Record<string, string> },
>(students: readonly T[], targetKey: string): StudentExtraColumnBatchUpdate[] {
  return computeDeleteMultipleExtraColumnsStudentUpdates(students, [targetKey]);
}

export function computeAddExtraColumnDefaultUpdates<
  T extends { studentId: string; extraColumns?: Record<string, string> },
>(students: readonly T[], colKey: string, defaultValue: string): StudentExtraColumnBatchUpdate[] {
  const cleanKey = String(colKey ?? '').trim().slice(0, 50);
  const cleanVal = String(defaultValue ?? '').trim().slice(0, 300);
  if (!cleanKey || !cleanVal) return [];

  const updates: StudentExtraColumnBatchUpdate[] = [];
  for (const s of students) {
    const existing = s.extraColumns ? { ...s.extraColumns } : {};
    if (existing[cleanKey] && existing[cleanKey].trim().length > 0) continue;
    if (Object.keys(existing).length >= 35) continue;
    existing[cleanKey] = cleanVal;
    updates.push({
      studentId: s.studentId,
      extraColumns: existing,
    });
  }
  return updates;
}

export function normalizeImportedStudentRow(
  rawRow: Record<string, string>,
  rowIndex: number,
  defaultCentreId: CentreId,
  allowCentreOverride: boolean,
  explicitMapping?: ExcelColumnMapping,
  allowMissingMobile = true,
  defaultTotalFee = 0,
  rawRowColors?: Record<string, string>,
  commonExtraHeadings: string[] = [],
): NormalizedImportStudent {
  const headers = Object.keys(rawRow);
  const activeMapping = explicitMapping || fuzzyDetectColumnMapping(headers, [rawRow]);

  const getField = (field: keyof ExcelColumnMapping): string => {
    const colHeader = activeMapping[field];
    if (!colHeader) return '';
    return String(rawRow[colHeader] ?? '').trim();
  };

  const todayIso = new Date().toISOString().slice(0, 10);
  const rawNameRaw = getField('studentName').replace(/\s+/g, ' ').trim();
  const rawName =
    rawNameRaw.length === 1 && /\p{L}/u.test(rawNameRaw) ? `${rawNameRaw}.` : rawNameRaw;
  const rawMobile = getField('mobileNumber');
  let cleanMobile = cleanMobileNumber(rawMobile);
  if ((cleanMobile.length < 7 || cleanMobile.length > 20) && allowMissingMobile) {
    cleanMobile = 'Not Provided';
  }

  const rawCentre = getField('centre');
  const resolvedCentreId = allowCentreOverride ? resolveCentreFromExcel(rawCentre, defaultCentreId) : defaultCentreId;
  const rawStudentId = getField('studentId');
  const sanitizedId = sanitizeImportedStudentId(rawStudentId);

  // Detect Subject(s) from either single Subjects column OR multi-column Subject 1..9 / Sub 1..9
  let detectedSubjectRaw = getField('subject').trim();
  const subjectHeaderToken = normalizeHeaderToken(activeMapping.subject || '');
  const numberedSubjectHeaders = headers
    .map((h) => {
      const m = h.trim().match(/^(?:sub|subject)[\s_-]*([1-9])$/i);
      if (!m || /\btoc\b/i.test(h)) return null;
      return { header: h, idx: Number(m[1]) };
    })
    .filter((item): item is { header: string; idx: number } => item !== null)
    .sort((a, b) => a.idx - b.idx);

  if (
    numberedSubjectHeaders.length > 0 &&
    (!detectedSubjectRaw || /^(?:sub|subject)[1-9]$/.test(subjectHeaderToken))
  ) {
    const combined = numberedSubjectHeaders
      .map((item) => String(rawRow[item.header] ?? '').trim())
      .filter(Boolean);
    if (combined.length > 0) {
      detectedSubjectRaw = combined.join(', ');
    }
  }

  const cleanedDetectedSubject = sanitizeRealSubject(detectedSubjectRaw, { stripLegacyDefaultList: false });
  const explicitSubjectDetected = cleanedDetectedSubject.length > 0;
  const rawSubject = cleanedDetectedSubject;

  const paidHeader = activeMapping.paidAmount || '';
  let effectivePaidRaw = getField('paidAmount');
  const paidHeaderToken = normalizeHeaderToken(paidHeader);
  const mappedIsInstallment =
    /(inst|installment|instalment|kist|part\d|pay\d|dep\d|1st|first)/.test(paidHeaderToken) &&
    !/total|sum|overall|combined/.test(paidHeaderToken);

  if (!effectivePaidRaw || mappedIsInstallment) {
    const initialSum = mappedIsInstallment ? (parseFeeNumberNullable(effectivePaidRaw) ?? 0) : 0;
    let instHits = mappedIsInstallment && effectivePaidRaw ? 1 : 0;
    let instTotal = initialSum;
    for (const h of headers) {
      if (h === paidHeader) continue;
      const t = normalizeHeaderToken(h);
      if (
        !t ||
        t.includes('tma') ||
        t.includes('exam') ||
        t.includes('pending') ||
        t.includes('due') ||
        t.includes('baki') ||
        t.includes('balance') ||
        t.includes('left') ||
        t.includes('unpaid') ||
        t.includes('total') ||
        t.includes('date')
      ) {
        continue;
      }
      if (
        /^(1st|2nd|3rd|4th|first|second|third|fourth|inst|installment|instalment|kist|part|pay\d|dep\d)/.test(t) ||
        /(installment|instalment|kist)/.test(t)
      ) {
        const n = parseFeeNumberNullable(rawRow[h]);
        if (n !== null) {
          instTotal += n;
          instHits += 1;
        }
      }
    }
    if (instHits > 0 && (instTotal > 0 || !effectivePaidRaw)) {
      effectivePaidRaw = String(instTotal);
    }
  }

  const reconciledFee = reconcileFeeNumbers({
    totalFeeRaw: getField('totalFee'),
    paidAmountRaw: effectivePaidRaw,
    pendingAmountRaw: getField('pendingAmount'),
    feeStatusRaw: getField('feeStatus'),
    defaultTotalFee,
  });
  const parsedTmaFee = parseFeeNumberNullable(getField('tmaFee'));
  const parsedExamFee = parseFeeNumberNullable(getField('examFee'));
  const tmaFee = parsedTmaFee !== null ? clampFeeNumber(parsedTmaFee) : 0;
  const examFee = parsedExamFee !== null ? clampFeeNumber(parsedExamFee) : 0;

  // Preserve custom Excel columns up to Firestore limit (35 keys), aligned onto common sheet headings.
  // Priority 1: Columns matching commonExtraHeadings (including mapped sheet boxes like LEFT, TOTAL, CALLING NO if present in grid!)
  // Priority 2: Other unmapped named Excel columns
  // Priority 3: Synthetic Column_X / __EMPTY columns (only if room < 35)
  // Always keep the 4 manual qualitative columns (whyNios, source of inquiry, current education, future plan) empty!
  const mappedHeadersUsed = new Set(
    Object.entries(activeMapping)
      .filter(([field, hdr]) => Boolean(hdr) && !(field === 'studentId' && !sanitizedId))
      .map(([, hdr]) => hdr as string),
  );
  const commonHeadingTokens = new Set(
    commonExtraHeadings.map((ch) => canonicalCommonHeaderToken(ch)).filter(Boolean),
  );

  const priorityExtraEntries: Array<{ key: string; val: string; rawHeader: string }> = [];
  const regularExtraEntries: Array<{ key: string; val: string; rawHeader: string }> = [];
  const fallbackExtraEntries: Array<{ key: string; val: string; rawHeader: string }> = [];
  const extraHeaderToCleanKey = new Map<string, string>();

  for (const h of headers) {
    const token = normalizeHeaderToken(h);
    if (token === 'sno' || token === 'srno' || token === 'slno' || token === 'serialno' || token === 'serialnumber') {
      continue;
    }
    const cleanKey = alignHeaderToCommonSchema(h, commonExtraHeadings);
    if (!cleanKey) continue;
    if (isKeepEmptyManualColumnHeading(h) || isKeepEmptyManualColumnHeading(cleanKey)) {
      continue;
    }
    const alignedToken = canonicalCommonHeaderToken(cleanKey);
    const matchesCommonExtraHeading = Boolean(alignedToken && commonHeadingTokens.has(alignedToken));
    const isMappedCore = mappedHeadersUsed.has(h);
    // Skip mapped core columns unless the visible sheet grid explicitly has an extra column matching them (e.g. LEFT, TOTAL, CALLING NO)
    if (isMappedCore && !matchesCommonExtraHeading) continue;

    extraHeaderToCleanKey.set(h, cleanKey);
    const val = String(rawRow[h] ?? '').trim();
    if (!val) continue;

    if (matchesCommonExtraHeading) {
      priorityExtraEntries.push({ key: cleanKey, val: val.slice(0, 300), rawHeader: h });
    } else if (/^(__EMPTY(?:_\d+)?|col_\d+|column_\d+)$/i.test(cleanKey)) {
      fallbackExtraEntries.push({ key: cleanKey, val: val.slice(0, 300), rawHeader: h });
    } else {
      regularExtraEntries.push({ key: cleanKey, val: val.slice(0, 300), rawHeader: h });
    }
  }

  const extraColumns: Record<string, string> = {};
  for (const item of [...priorityExtraEntries, ...regularExtraEntries, ...fallbackExtraEntries]) {
    if (Object.keys(extraColumns).length >= 35) break;
    if (extraColumns[item.key] === undefined) {
      extraColumns[item.key] = item.val;
    }
  }

  // Synonym backfill for grid boxes like TOTAL, LEFT, CALLING NO when Excel used Total Fee / Left Fees / Mobile No
  for (const ch of commonExtraHeadings) {
    if (Object.keys(extraColumns).length >= 35) break;
    const cleanCh = ch.trim().slice(0, 50);
    if (!cleanCh || isKeepEmptyManualColumnHeading(cleanCh)) continue;
    if (extraColumns[cleanCh] !== undefined) continue;
    const tok = canonicalCommonHeaderToken(cleanCh);
    if (tok === 'total' && (reconciledFee.totalFee > 0 || getField('totalFee'))) {
      extraColumns[cleanCh] = (getField('totalFee') || String(reconciledFee.totalFee)).slice(0, 300);
    } else if (tok === 'left' && (getField('pendingAmount') || reconciledFee.explicitFeeDetected)) {
      extraColumns[cleanCh] = (getField('pendingAmount') || String(reconciledFee.pendingAmount)).slice(0, 300);
    } else if (
      (tok === 'callingno' || tok === 'calling') &&
      cleanMobile.length >= 7 &&
      cleanMobile.toLowerCase() !== 'not provided'
    ) {
      extraColumns[cleanCh] = cleanMobile.slice(0, 300);
    }
  }

  // Map preserved Excel cell & row fill colors cleanly into canonical field keys
  const rawColors = rawRowColors || {};
  const allCellColors: Record<string, string> = {};
  const colorFreq = new Map<string, number>();

  for (const field of CANONICAL_COLOR_FIELDS) {
    const hdr = activeMapping[field];
    const hex = hdr ? rawColors[hdr] : '';
    if (hex && /^#[0-9A-F]{6}$/i.test(hex)) {
      const upper = hex.toUpperCase();
      allCellColors[field] = upper;
      colorFreq.set(upper, (colorFreq.get(upper) || 0) + 1);
    }
  }

  for (const h of headers) {
    const hex = rawColors[h];
    if (!hex || !/^#[0-9A-F]{6}$/i.test(hex)) continue;
    const upper = hex.toUpperCase();
    const token = normalizeHeaderToken(h);
    if (token === 'sno' || token === 'srno' || token === 'serialno' || token === 'serialnumber') {
      allCellColors.serialNumber = upper;
      colorFreq.set(upper, (colorFreq.get(upper) || 0) + 1);
    } else if (extraHeaderToCleanKey.has(h)) {
      const cleanKey = extraHeaderToCleanKey.get(h)!;
      if (extraColumns[cleanKey] !== undefined) {
        allCellColors[`extra:${cleanKey}`] = upper;
        colorFreq.set(upper, (colorFreq.get(upper) || 0) + 1);
      }
    }
  }

  let rowColor = rawColors._rowBg && /^#[0-9A-F]{6}$/i.test(rawColors._rowBg)
    ? rawColors._rowBg.toUpperCase()
    : '';
  if (!rowColor && colorFreq.size > 0) {
    let topHex = '';
    let topCount = 0;
    for (const [hex, cnt] of colorFreq.entries()) {
      if (cnt > topCount) {
        topCount = cnt;
        topHex = hex;
      }
    }
    const nonEmptyCount = headers.filter((h) => String(rawRow[h] ?? '').trim().length > 0).length;
    const threshold = Math.max(3, Math.ceil(nonEmptyCount * 0.45));
    if (topCount >= threshold || (allCellColors.serialNumber && allCellColors.studentName && allCellColors.serialNumber === allCellColors.studentName)) {
      rowColor = topHex;
    }
  }

  // Respect Firestore rule max 45 keys in cellColors
  const cellColors: Record<string, string> = {};
  const entries = Object.entries(allCellColors);
  if (entries.length <= 45) {
    entries.forEach(([k, v]) => {
      cellColors[k] = v;
    });
  } else {
    // Prioritize cells that differ from rowColor, then remaining
    const distinct = entries.filter(([, v]) => v !== rowColor);
    const same = entries.filter(([, v]) => v === rowColor);
    for (const [k, v] of [...distinct, ...same].slice(0, 45)) {
      cellColors[k] = v;
    }
  }

  let validationError: string | null = null;
  if (rawName.length < 2) {
    validationError = 'Student Name (min 2 chars) required.';
  } else if (cleanMobile.length < 7 || cleanMobile.length > 20) {
    validationError = 'Valid Mobile Number (7–15 digits) required.';
  }

  return {
    rowIndex,
    studentId: sanitizedId,
    studentName: rawName.slice(0, 120),
    mobileNumber: cleanMobile,
    centreId: resolvedCentreId,
    centreName: CENTRE_MAP[resolvedCentreId].name,
    subject: rawSubject.slice(0, 200),
    tcStatus: normalizeTc(getField('tcStatus')),
    bookStatus: normalizeBook(getField('bookStatus')),
    classAttendanceStatus: normalizeAttendance(getField('classAttendanceStatus')),
    tmaStatus: normalizeTma(getField('tmaStatus')),
    practicalStatus: normalizePractical(getField('practicalStatus')),
    examinationStatus: normalizeExam(getField('examinationStatus')),
    admissionDate: normalizeExcelDate(getField('admissionDate'), todayIso).slice(0, 30),
    // Keep the 4 qualitative/manual columns empty during Excel import
    whyNios: '',
    currentEducationStatus: '',
    futurePlanning: '',
    additionalRemarks: (getField('additionalRemarks') || 'Excel Bulk Import').slice(0, 1000),
    totalFee: reconciledFee.totalFee,
    paidAmount: reconciledFee.paidAmount,
    pendingAmount: reconciledFee.pendingAmount,
    tmaFee,
    examFee,
    recoveryStatus: reconciledFee.recoveryStatus,
    followUpStatus: reconciledFee.followUpStatus,
    explicitFeeDetected: reconciledFee.explicitFeeDetected,
    explicitTmaFeeDetected: parsedTmaFee !== null,
    explicitExamFeeDetected: parsedExamFee !== null,
    explicitSubjectDetected,
    explicitTmaDetected: Boolean(activeMapping.tmaStatus && getField('tmaStatus')),
    explicitPracticalDetected: Boolean(activeMapping.practicalStatus && getField('practicalStatus')),
    extraColumns,
    rowColor,
    cellColors,
    validationError,
  };
}
