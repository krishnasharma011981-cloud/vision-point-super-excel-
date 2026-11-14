import * as XLSX from 'xlsx';
import { CANONICAL_CENTRES, CENTRE_MAP } from '../constants/centres';
import type {
  BookStatus,
  CentreId,
  ClassAttendanceStatus,
  ExaminationStatus,
  PracticalStatus,
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

  if (rows.length < 2) return [];
  const headerIdx = findBestHeaderRowIndex(rows);
  const headers = makeUniqueHeaders(rows[headerIdx].map((h, i) => h.replace(/^\uFEFF/, '').trim() || `Column_${i + 1}`));
  return rows.slice(headerIdx + 1).map((r) => {
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

const HEADER_MATCH_HINTS = [
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
  'serial',
  'roll',
  'enrol',
  'reg',
  'centre',
  'center',
  'branch',
  'tma',
  'practical',
  'attend',
  'subject',
  'stream',
  'course',
  'fee',
  'paid',
  'date',
  'remark',
  'father',
  'class',
];

function findBestHeaderRowIndex(grid: unknown[][]): number {
  let headerRowIdx = 0;
  let bestScore = -1;
  const scanLimit = Math.min(grid.length - 1, 15);
  for (let r = 0; r < scanLimit; r++) {
    const row = grid[r] || [];
    const nonEmpty = row.map(formatCellValue).filter(Boolean);
    if (nonEmpty.length === 0) continue;

    let score = 0;
    for (const cell of nonEmpty) {
      const token = normalizeHeaderToken(cell);
      if (token && HEADER_MATCH_HINTS.some((hint) => token.includes(hint))) {
        score += 5;
      }
    }
    // Slight preference for rows with more distinct header-like text columns
    if (nonEmpty.length >= 2) {
      score += Math.min(nonEmpty.length, 6);
    }
    if (score > bestScore) {
      bestScore = score;
      headerRowIdx = r;
    }
  }
  return headerRowIdx;
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

function worksheetToRowObjects(ws: XLSX.WorkSheet): {
  headers: string[];
  rows: Array<Record<string, string>>;
} {
  // Propagate top-left value of merged cells cleanly before extracting grid
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
        }
      }
    }
  }

  const grid = XLSX.utils.sheet_to_json<unknown[]>(ws, {
    header: 1,
    raw: true,
    defval: '',
    blankrows: false,
  });

  if (!grid || grid.length === 0) return { headers: [], rows: [] };

  // Find max column span across all rows (since trailing empty header columns can have values below)
  const headerRowIdx = grid.length > 1 ? findBestHeaderRowIndex(grid) : 0;
  const maxCols = Math.max(
    (grid[headerRowIdx] || []).length,
    ...grid.slice(headerRowIdx + 1, headerRowIdx + 25).map((r) => (r || []).length),
  );

  const rawHeaders: string[] = [];
  for (let c = 0; c < maxCols; c++) {
    const cellText = formatCellValue((grid[headerRowIdx] || [])[c]).replace(/^\uFEFF/, '');
    rawHeaders.push(cellText || `Column_${c + 1}`);
  }
  const uniqueHeaders = makeUniqueHeaders(rawHeaders);

  const records: Array<Record<string, string>> = [];
  for (let r = headerRowIdx + 1; r < grid.length; r++) {
    const row = grid[r] || [];
    const obj: Record<string, string> = {};
    let nonEmptyCells = 0;
    uniqueHeaders.forEach((h, idx) => {
      const formatted = formatCellValue(row[idx]);
      obj[h] = formatted;
      if (formatted.length > 0) nonEmptyCells++;
    });
    if (nonEmptyCells > 0) {
      records.push(obj);
    }
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

  return { headers: activeHeaders, rows: cleanRecords };
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

function parseHtmlTableFallback(htmlText: string): Array<Record<string, string>> {
  if (typeof DOMParser === 'undefined') return [];
  const doc = new DOMParser().parseFromString(htmlText, 'text/html');
  const tables = Array.from(doc.querySelectorAll('table'));
  if (tables.length === 0) return [];
  const rows: string[][] = [];
  const primaryTable = tables[0];
  primaryTable.querySelectorAll('tr').forEach((tr) => {
    const cells = Array.from(tr.querySelectorAll('th, td')).map((el) =>
      (el.textContent || '').replace(/\s+/g, ' ').trim(),
    );
    if (cells.some(Boolean)) rows.push(cells);
  });
  if (rows.length < 2) return [];
  const headerIdx = findBestHeaderRowIndex(rows);
  const headers = makeUniqueHeaders(rows[headerIdx].map((h, i) => h || `Column_${i + 1}`));
  return rows.slice(headerIdx + 1).map((r) => {
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => {
      obj[h] = r[i] ?? '';
    });
    return obj;
  });
}

export interface ParsedWorkbookResult {
  sheetNames: string[];
  sheets: Record<string, Array<Record<string, string>>>;
  headersBySheet: Record<string, string[]>;
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
        const extracted = worksheetToRowObjects(wb.Sheets[first]);
        if (extracted.rows.length > 0) {
          return {
            sheetNames: [first],
            sheets: { [first]: extracted.rows },
            headersBySheet: { [first]: extracted.headers },
          };
        }
      }
    } catch {
      // Fall through to custom delimiter parser
    }
    rows = parseCsvText(text);
    const headers = rows.length > 0 ? Object.keys(rows[0]) : [];
    return {
      sheetNames: ['Sheet1'],
      sheets: { Sheet1: rows },
      headersBySheet: { Sheet1: headers },
    };
  }

  let workbook: XLSX.WorkBook | null = null;
  try {
    workbook = XLSX.read(bytes, { type: 'array', cellDates: true });
  } catch {
    workbook = null;
  }

  if (!workbook || workbook.SheetNames.length === 0) {
    const text = decodeTextBuffer(buffer);
    try {
      workbook = XLSX.read(text, { type: 'string', cellDates: true });
    } catch {
      workbook = null;
    }
    if ((!workbook || workbook.SheetNames.length === 0) && /<(table|html|tr)/i.test(text)) {
      const htmlRows = parseHtmlTableFallback(text);
      const htmlHeaders = htmlRows.length > 0 ? Object.keys(htmlRows[0]) : [];
      return {
        sheetNames: ['Sheet1'],
        sheets: { Sheet1: htmlRows },
        headersBySheet: { Sheet1: htmlHeaders },
      };
    }
  }

  const sheets: Record<string, Array<Record<string, string>>> = {};
  const headersBySheet: Record<string, string[]> = {};
  const validSheetNames: string[] = [];

  if (workbook) {
    for (const name of workbook.SheetNames) {
      const ws = workbook.Sheets[name];
      if (!ws) continue;
      const extracted = worksheetToRowObjects(ws);
      if (extracted.rows.length > 0) {
        sheets[name] = extracted.rows;
        headersBySheet[name] = extracted.headers;
        validSheetNames.push(name);
      }
    }
  }

  if (validSheetNames.length === 0) {
    // Final fallback: attempt HTML or delimited text parse in case a .xls is plain text/TSV/HTML
    const text = decodeTextBuffer(buffer);
    if (/<(table|html|tr)/i.test(text)) {
      const htmlRows = parseHtmlTableFallback(text);
      if (htmlRows.length > 0) {
        return {
          sheetNames: ['Sheet1'],
          sheets: { Sheet1: htmlRows },
          headersBySheet: { Sheet1: Object.keys(htmlRows[0]) },
        };
      }
    }
    const textRows = parseCsvText(text);
    if (textRows.length > 0) {
      return {
        sheetNames: ['Sheet1'],
        sheets: { Sheet1: textRows },
        headersBySheet: { Sheet1: Object.keys(textRows[0]) },
      };
    }
  }

  return {
    sheetNames: validSheetNames,
    sheets,
    headersBySheet,
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
  subject: ['subject', 'subjects', 'niossubjects', 'course', 'stream', 'mainsubjects', 'class', 'medium'],
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
  totalFee: ['totalfee', 'totalfees', 'fee', 'fees', 'coursefee', 'packagefee'],
  paidAmount: ['paidamount', 'feepaid', 'paid', 'receivedfee', 'deposit', 'amountpaid'],
};

const FUZZY_CONTAINS: Array<{ field: keyof ExcelColumnMapping; keywords: string[]; exclude?: string[] }> = [
  { field: 'studentName', keywords: ['studentname', 'candidatename', 'learnername', 'nameofstudent', 'fullname', 'name'], exclude: ['father', 'mother', 'guardian', 'centre', 'center', 'branch', 'employee', 'staff', 'teacher', 'parent'] },
  { field: 'mobileNumber', keywords: ['mobile', 'phone', 'contact', 'whatsapp', 'mob'] },
  { field: 'studentId', keywords: ['enrol', 'rollno', 'regno', 'studentid', 'admno'] },
  { field: 'centre', keywords: ['centre', 'center', 'branch'] },
  { field: 'tmaStatus', keywords: ['tma'] },
  { field: 'practicalStatus', keywords: ['practical'] },
  { field: 'classAttendanceStatus', keywords: ['attend', 'liveclass', 'onlineclass'] },
  { field: 'subject', keywords: ['subject', 'stream', 'course'] },
  { field: 'tcStatus', keywords: ['transfercert', 'tcstatus'] },
  { field: 'bookStatus', keywords: ['book'] },
  { field: 'examinationStatus', keywords: ['exam'] },
  { field: 'admissionDate', keywords: ['admdate', 'admissiondate', 'joiningdate'] },
  { field: 'totalFee', keywords: ['totalfee', 'fees', 'coursefee'] },
  { field: 'paidAmount', keywords: ['paid', 'deposit', 'received'] },
  { field: 'additionalRemarks', keywords: ['remark', 'note', 'comment'] },
];

export function fuzzyDetectColumnMapping(
  headers: string[],
  sampleRows: Array<Record<string, string>> = [],
): ExcelColumnMapping {
  const mapping: ExcelColumnMapping = {};
  const tokenToHeader = headers.map((h) => ({ header: h, token: normalizeHeaderToken(h) }));
  const usedHeaders = new Set<string>();

  // Pass 1: exact alias priority
  (Object.keys(EXACT_ALIAS_LISTS) as Array<keyof ExcelColumnMapping>).forEach((field) => {
    const aliases = EXACT_ALIAS_LISTS[field];
    for (const alias of aliases) {
      const match = tokenToHeader.find((item) => item.token === alias && !usedHeaders.has(item.header));
      if (match) {
        mapping[field] = match.header;
        usedHeaders.add(match.header);
        break;
      }
    }
  });

  // Pass 2: fuzzy substring match
  for (const rule of FUZZY_CONTAINS) {
    if (mapping[rule.field]) continue;
    const match = tokenToHeader.find((item) => {
      if (usedHeaders.has(item.header) || !item.token) return false;
      if (rule.exclude?.some((ex) => item.token.includes(ex))) return false;
      return rule.keywords.some((kw) => item.token.includes(kw));
    });
    if (match) {
      mapping[rule.field] = match.header;
      usedHeaders.add(match.header);
    }
  }

  // Pass 3: content-based heuristic if Student Name or Mobile still undetected
  if (!mapping.studentName && sampleRows.length > 0) {
    const bestNameCol = headers.find((h) => {
      if (usedHeaders.has(h)) return false;
      const samples = sampleRows.slice(0, 8).map((r) => (r[h] || '').trim()).filter(Boolean);
      if (samples.length === 0) return false;
      const textyCount = samples.filter((v) => /[a-zA-Z]{2,}/.test(v) && !/^\d+$/.test(v)).length;
      return textyCount >= Math.ceil(samples.length * 0.6);
    });
    if (bestNameCol) {
      mapping.studentName = bestNameCol;
      usedHeaders.add(bestNameCol);
    }
  }

  if (!mapping.mobileNumber && sampleRows.length > 0) {
    const bestPhoneCol = headers.find((h) => {
      if (usedHeaders.has(h)) return false;
      const samples = sampleRows.slice(0, 8).map((r) => (r[h] || '').trim()).filter(Boolean);
      if (samples.length === 0) return false;
      const phoneCount = samples.filter((v) => v.replace(/\D/g, '').length >= 9 && v.replace(/\D/g, '').length <= 13).length;
      return phoneCount >= Math.ceil(samples.length * 0.5);
    });
    if (bestPhoneCol) {
      mapping.mobileNumber = bestPhoneCol;
      usedHeaders.add(bestPhoneCol);
    }
  }

  return mapping;
}

export function cleanMobileNumber(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
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
  if (!v) return 'Regular';
  if (v.includes('not') || v.includes('absent') || v === 'no' || v === 'never') return 'Not Attending';
  if (v.includes('irreg') || v.includes('low') || v.includes('some') || v.includes('rare')) return 'Irregular';
  return 'Regular';
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

function parseFeeNumber(raw: string, fallback: number): number {
  if (!raw) return fallback;
  const cleaned = raw.replace(/[^0-9.]/g, '');
  const num = Number(cleaned);
  return Number.isFinite(num) && num >= 0 ? Math.round(num) : fallback;
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
  extraColumns: Record<string, string>;
  validationError: string | null;
}

export function normalizeImportedStudentRow(
  rawRow: Record<string, string>,
  rowIndex: number,
  defaultCentreId: CentreId,
  allowCentreOverride: boolean,
  explicitMapping?: ExcelColumnMapping,
  allowMissingMobile = true,
): NormalizedImportStudent {
  const headers = Object.keys(rawRow);
  const activeMapping = explicitMapping || fuzzyDetectColumnMapping(headers, [rawRow]);

  const getField = (field: keyof ExcelColumnMapping): string => {
    const colHeader = activeMapping[field];
    if (!colHeader) return '';
    return String(rawRow[colHeader] ?? '').trim();
  };

  const todayIso = new Date().toISOString().slice(0, 10);
  const rawName = getField('studentName').replace(/\s+/g, ' ').trim();
  const rawMobile = getField('mobileNumber');
  let cleanMobile = cleanMobileNumber(rawMobile);
  if ((cleanMobile.length < 7 || cleanMobile.length > 20) && allowMissingMobile) {
    cleanMobile = 'Not Provided';
  }

  const rawCentre = getField('centre');
  const resolvedCentreId = allowCentreOverride ? resolveCentreFromExcel(rawCentre, defaultCentreId) : defaultCentreId;
  const rawStudentId = getField('studentId');
  const sanitizedId = rawStudentId
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);

  const rawSubject = getField('subject') || 'Hindi, English, Mathematics, Science, Social Science';
  const totalFee = parseFeeNumber(getField('totalFee'), 12000);
  const paidAmount = Math.min(totalFee, parseFeeNumber(getField('paidAmount'), 0));

  // Preserve ALL other custom Excel columns (excluding serial no / mapped core fields)
  const mappedHeadersUsed = new Set(Object.values(activeMapping).filter((v): v is string => Boolean(v)));
  const extraColumns: Record<string, string> = {};
  for (const h of headers) {
    if (mappedHeadersUsed.has(h)) continue;
    const token = normalizeHeaderToken(h);
    if (token === 'sno' || token === 'srno' || token === 'serialno' || token === 'serialnumber') continue;
    const val = String(rawRow[h] ?? '').trim();
    if (!val) continue;
    const cleanKey = h.trim().slice(0, 50);
    if (cleanKey && Object.keys(extraColumns).length < 30) {
      extraColumns[cleanKey] = val.slice(0, 300);
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
    whyNios: getField('whyNios').slice(0, 1000),
    currentEducationStatus: getField('currentEducationStatus').slice(0, 1000),
    futurePlanning: getField('futurePlanning').slice(0, 1000),
    additionalRemarks: (getField('additionalRemarks') || 'Excel Bulk Import').slice(0, 1000),
    totalFee,
    paidAmount,
    extraColumns,
    validationError,
  };
}
