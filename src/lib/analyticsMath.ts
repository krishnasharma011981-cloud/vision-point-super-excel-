import { CANONICAL_CENTRES, CENTRE_MAP } from '../constants/centres';
import type {
  AdmissionRecord,
  CentreId,
  FeeFollowUpStatus,
  FeeRecoveryRecord,
  RecoveryStatus,
  Student,
} from '../types/domain';

export interface ReconciledFeeResult {
  totalFee: number;
  paidAmount: number;
  pendingAmount: number;
  recoveryStatus: RecoveryStatus;
  followUpStatus: FeeFollowUpStatus;
  explicitFeeDetected: boolean;
}

export interface ResolvedStudentFeeSummary {
  totalFee: number;
  paidAmount: number;
  pendingAmount: number;
  tmaFee: number;
  examFee: number;
  recoveryStatus: RecoveryStatus;
  followUpStatus: FeeFollowUpStatus;
  hasFeeData: boolean;
  hasTmaFee: boolean;
  hasExamFee: boolean;
}

export function clampFeeNumber(val: unknown): number {
  const n = Number(val);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(1000000, Math.round(n));
}

export function formatCompactInr(val: unknown): string {
  const n = Number(val || 0);
  if (!Number.isFinite(n) || n <= 0) return '₹0';
  if (n >= 100000) {
    const lakhs = n / 100000;
    return `₹${Number.isInteger(lakhs) ? lakhs : lakhs.toFixed(1)}L`;
  }
  if (n >= 1000) {
    const k = n / 1000;
    return `₹${Number.isInteger(k) ? k : k.toFixed(1)}k`;
  }
  return `₹${Math.round(n)}`;
}

/**
 * Masks a mobile number for UI privacy while preserving only the first 2 digits.
 * Example: "9612345678" -> "96********"
 * Returns "Not Provided" when no real phone digits exist.
 */
export function maskMobileNumber(mobile: string | null | undefined): string {
  const raw = String(mobile ?? '').trim();
  if (!raw || raw.toLowerCase() === 'not provided') {
    return 'Not Provided';
  }
  const digits = raw.replace(/\D/g, '');
  let localDigits = digits;
  if (localDigits.length === 12 && localDigits.startsWith('91')) {
    localDigits = localDigits.slice(2);
  } else if (localDigits.length === 11 && localDigits.startsWith('0')) {
    localDigits = localDigits.slice(1);
  }
  if (localDigits.length < 4) {
    return raw.length >= 2 ? `${raw.slice(0, 2)}${'*'.repeat(Math.max(7, raw.length - 2))}` : 'Not Provided';
  }
  const starCount = Math.max(7, localDigits.length - 2);
  return `${localDigits.slice(0, 2)}${'*'.repeat(starCount)}`;
}

/**
 * Extracts callable phone digits for tel: and WhatsApp links without exposing them in UI text.
 */
export function extractCallableDigits(mobile: string | null | undefined): string {
  const raw = String(mobile ?? '').trim();
  if (!raw || raw.toLowerCase() === 'not provided') return '';
  let digits = raw.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('0')) {
    digits = digits.slice(1);
  }
  if (digits.length === 10) {
    return `91${digits}`;
  }
  if (digits.length >= 7 && digits.length <= 15) {
    return digits;
  }
  return '';
}

export function buildTelHref(mobile: string | null | undefined): string | null {
  const digits = extractCallableDigits(mobile);
  if (!digits) return null;
  return digits.length === 12 && digits.startsWith('91') ? `tel:+${digits}` : `tel:${digits}`;
}

export function buildWhatsAppHref(
  mobile: string | null | undefined,
  studentName?: string,
  topic = 'admission aur fees update',
): string | null {
  const digits = extractCallableDigits(mobile);
  if (!digits) return null;
  const cleanName = (studentName || 'Student').trim();
  const cleanTopic = topic.trim() || 'admission aur fees update';
  const text = encodeURIComponent(
    `Namaste ${cleanName}, Vision Point / Axis Academy (Database Security) se aapke ${cleanTopic} ke sambandh mein sampark kiya ja raha hai.`,
  );
  return `https://wa.me/${digits}?text=${text}`;
}

/**
 * Parses Indian & standard currency expressions from Excel cells accurately.
 * Handles: "Rs. 12,000/-", "₹ 5,500.00", "INR 4000", "5000 + 2000", "12k", "1.5 lakh".
 * Never breaks on dots in "Rs. 5000" (unlike naive regex replace).
 */
export function parseFeeNumberNullable(raw: unknown): number | null {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) && raw >= 0 ? Math.round(raw) : null;
  }
  const str = String(raw ?? '').trim();
  if (!str) return null;

  const lower = str.toLowerCase();
  if (['na', 'n/a', '-', '--', 'nil', 'none', 'null'].includes(lower)) {
    return null;
  }

  // Strip currency prefixes/suffixes cleanly before parsing numeric tokens
  const stripped = lower
    .replace(/\b(rs|inr|rupees?)\.?\s*/gi, ' ')
    .replace(/[₹$€£]/g, ' ')
    .replace(/\/-/g, ' ')
    .trim();

  // Support simple addition expressions in Excel cells like "5000 + 2500"
  if (/^\s*[\d,]+(?:\.\d+)?(?:\s*\+\s*[\d,]+(?:\.\d+)?)+\s*$/.test(stripped)) {
    const parts = stripped.split('+').map((p) => Number(p.replace(/,/g, '').trim()));
    if (parts.every((n) => Number.isFinite(n) && n >= 0)) {
      return Math.round(parts.reduce((a, b) => a + b, 0));
    }
  }

  // Support shorthand like "12k" or "1.5 lakh"
  const unitMatch = stripped.match(/^(\d+(?:,\d+)*(?:\.\d+)?)\s*(k|thousand|lakh|lac)s?$/i);
  if (unitMatch) {
    const base = Number(unitMatch[1].replace(/,/g, ''));
    const unit = unitMatch[2].toLowerCase();
    const mult = unit === 'k' || unit === 'thousand' ? 1000 : 100000;
    if (Number.isFinite(base) && base >= 0) {
      return Math.round(base * mult);
    }
  }

  // Extract first clean decimal/grouped number token (avoids leading-dot bugs like ".5000")
  const numMatch = stripped.match(/\d[\d,]*(?:\.\d+)?/);
  if (!numMatch) return null;
  const parsed = Number(numMatch[0].replace(/,/g, ''));
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.round(parsed);
}

/**
 * Reconciles Total Fee, Paid (Jama), Pending (Baki), and Status from partial Excel columns
 * using deterministic mathematical relationships:
 *   Total Fee = Paid + Pending
 */
export function reconcileFeeNumbers(params: {
  totalFeeRaw?: unknown;
  paidAmountRaw?: unknown;
  pendingAmountRaw?: unknown;
  feeStatusRaw?: unknown;
  defaultTotalFee?: number;
}): ReconciledFeeResult {
  const defaultTotal = Math.max(0, Math.round(params.defaultTotalFee ?? 0));
  const pendingStr = String(params.pendingAmountRaw ?? '').trim().toLowerCase();
  const paidStr = String(params.paidAmountRaw ?? '').trim().toLowerCase();

  const pendingTextIndicatesZero = /^(nil|nill|zero|no\s*due|no\s*dues|clear|cleared|settled|full\s*paid|paid)$/i.test(
    pendingStr,
  );
  const pendingTextIndicatesUnpaid = /^(unpaid|not\s*paid|due|pending)$/i.test(pendingStr);
  const paidTextIndicatesZero = /^(nil|nill|zero|unpaid|not\s*paid|none)$/i.test(paidStr);
  const paidTextIndicatesFull = /^(paid|full\s*paid|fully\s*paid|clear|cleared|done|yes|complete|completed|settled)$/i.test(
    paidStr,
  );

  let rawTotal = parseFeeNumberNullable(params.totalFeeRaw);
  let rawPaid = parseFeeNumberNullable(params.paidAmountRaw);
  let rawPending = parseFeeNumberNullable(params.pendingAmountRaw);
  if (rawPending === null && pendingTextIndicatesZero) rawPending = 0;
  if (rawPaid === null && paidTextIndicatesZero) rawPaid = 0;
  if (rawPaid === null && paidTextIndicatesFull && rawTotal !== null) rawPaid = rawTotal;
  if (rawPending === null && pendingTextIndicatesUnpaid && rawTotal !== null) rawPending = rawTotal;

  const statusText = String(params.feeStatusRaw ?? '').trim().toLowerCase();

  const statusIndicatesPaid =
    paidTextIndicatesFull ||
    (pendingTextIndicatesZero && rawTotal === null && rawPaid === null) ||
    (/\b(full\s*paid|fully\s*paid|paid|clear|cleared|completed|settled|no\s*due|nil)\b/.test(statusText) &&
      !/\b(unpaid|not\s*paid|partial|pending|due|overdue)\b/.test(statusText));
  const statusIndicatesOverdue = /\b(overdue|defaulter|late)\b/.test(statusText);
  const statusIndicatesUnpaid = /\b(unpaid|not\s*paid)\b/.test(statusText);

  const explicitFeeDetected =
    rawTotal !== null ||
    rawPaid !== null ||
    rawPending !== null ||
    statusText.length > 0 ||
    paidTextIndicatesFull ||
    pendingTextIndicatesZero ||
    pendingTextIndicatesUnpaid ||
    paidTextIndicatesZero;

  let totalFee = defaultTotal;
  let paidAmount = 0;
  let pendingAmount = defaultTotal;

  if (rawTotal !== null && rawPaid !== null && rawPending !== null) {
    totalFee = rawTotal;
    paidAmount = rawPaid;
    pendingAmount = rawPending;
    // Reconcile if total was 0 or smaller than paid + pending
    if (totalFee === 0 && paidAmount + pendingAmount > 0) {
      totalFee = paidAmount + pendingAmount;
    } else if (paidAmount + pendingAmount !== totalFee) {
      // Keep paid authoritative if paid <= total, else adjust total
      if (paidAmount > totalFee) {
        totalFee = paidAmount + pendingAmount;
      } else {
        pendingAmount = Math.max(0, totalFee - paidAmount);
      }
    }
  } else if (rawTotal !== null && rawPaid !== null) {
    totalFee = Math.max(rawTotal, rawPaid);
    paidAmount = rawPaid;
    pendingAmount = Math.max(0, totalFee - paidAmount);
  } else if (rawTotal !== null && rawPending !== null) {
    totalFee = Math.max(rawTotal, rawPending);
    pendingAmount = rawPending;
    paidAmount = Math.max(0, totalFee - pendingAmount);
  } else if (rawPaid !== null && rawPending !== null) {
    paidAmount = rawPaid;
    pendingAmount = rawPending;
    totalFee = paidAmount + pendingAmount;
  } else if (rawTotal !== null) {
    totalFee = rawTotal;
    if (statusIndicatesPaid) {
      paidAmount = totalFee;
      pendingAmount = 0;
    } else {
      paidAmount = 0;
      pendingAmount = totalFee;
    }
  } else if (rawPaid !== null) {
    paidAmount = rawPaid;
    if (statusIndicatesPaid || defaultTotal <= paidAmount) {
      totalFee = paidAmount;
      pendingAmount = 0;
    } else {
      totalFee = Math.max(defaultTotal, paidAmount);
      pendingAmount = Math.max(0, totalFee - paidAmount);
    }
  } else if (rawPending !== null) {
    pendingAmount = rawPending;
    totalFee = Math.max(defaultTotal, pendingAmount);
    paidAmount = Math.max(0, totalFee - pendingAmount);
  } else if (statusIndicatesPaid) {
    totalFee = defaultTotal;
    paidAmount = defaultTotal;
    pendingAmount = 0;
  } else if (statusIndicatesUnpaid || statusIndicatesOverdue) {
    totalFee = defaultTotal;
    paidAmount = 0;
    pendingAmount = defaultTotal;
  }

  let recoveryStatus: RecoveryStatus;
  if (totalFee > 0 && pendingAmount === 0 && paidAmount >= totalFee) {
    recoveryStatus = 'Paid';
  } else if (totalFee === 0 && paidAmount === 0 && statusIndicatesPaid) {
    recoveryStatus = 'Paid';
  } else if (paidAmount > 0 && pendingAmount > 0) {
    recoveryStatus = 'Partial';
  } else if (statusIndicatesOverdue && pendingAmount > 0) {
    recoveryStatus = 'Overdue';
  } else {
    recoveryStatus = 'Pending';
  }

  const followUpStatus: FeeFollowUpStatus =
    recoveryStatus === 'Paid'
      ? 'Closed'
      : recoveryStatus === 'Partial'
        ? 'Promise to Pay'
        : 'Scheduled';

  return {
    totalFee,
    paidAmount,
    pendingAmount,
    recoveryStatus,
    followUpStatus,
    explicitFeeDetected,
  };
}

export interface ExtractedExtraFeeSignals {
  totalFeeRaw: string;
  paidAmountRaw: string;
  pendingAmountRaw: string;
  feeStatusRaw: string;
  tmaFee: number | null;
  examFee: number | null;
  hasMainFeeSignals: boolean;
}

const NON_FEE_EXTRA_KEY_RE =
  /(s\.?\s*no|sr\.?\s*no|serial|roll|enrol|registration\s*no|reg\s*no|student\s*id|mobile|phone|contact|whatsapp|date|doj|dob|year|session|batch|aadhar|aadhaar|age|pincode|pin\s*code|mark|score|percent|percentage|attend|subject|stream|code|remark|note|comment|address|father|mother|guardian|purpose|goal|plan)/i;

function isFeeZeroOrStatusToken(val: string): boolean {
  return /^(nil|zero|no\s*due|no\s*dues|clear|cleared|settled|full\s*paid|paid|unpaid|not\s*paid|partial|pending|overdue|none)$/i.test(
    val.trim(),
  );
}

export function extractFeeSignalsFromExtraColumns(
  extraColumns?: Record<string, string>,
): ExtractedExtraFeeSignals {
  const extras = extraColumns || {};
  let tmaFee: number | null = null;
  let examFee: number | null = null;
  let totalFeeRaw = '';
  let explicitPaidRaw = '';
  let installmentPaidSum = 0;
  let installmentPaidCount = 0;
  let pendingAmountRaw = '';
  let feeStatusRaw = '';

  for (const [rawKey, rawVal] of Object.entries(extras)) {
    const val = String(rawVal ?? '').trim();
    if (!val) continue;
    const keyLower = rawKey.trim().toLowerCase();
    const keyNorm = keyLower.replace(/[^a-z0-9]/g, '');
    if (!keyNorm) continue;

    // 1. TMA Fee & Exam Fee
    if (/tma.*(fee|charge|amount|rs)|assignment.*fee/.test(keyLower)) {
      const n = parseFeeNumberNullable(val);
      if (n !== null && tmaFee === null) tmaFee = clampFeeNumber(n);
      continue;
    }
    if (/(exam|examination|board).*(fee|charge|amount|rs)/.test(keyLower)) {
      const n = parseFeeNumberNullable(val);
      if (n !== null && examFee === null) examFee = clampFeeNumber(n);
      continue;
    }

    if (NON_FEE_EXTRA_KEY_RE.test(keyLower)) continue;

    // 2. Fee / Payment status
    if (/fee.*status|payment.*status|recovery.*status/.test(keyLower)) {
      if (!feeStatusRaw) feeStatusRaw = val;
      continue;
    }

    const parsedNum = parseFeeNumberNullable(val);
    const hasNumericOrZeroFeeVal = parsedNum !== null || isFeeZeroOrStatusToken(val);
    if (!hasNumericOrZeroFeeVal) continue;

    // 3. Pending / Baki / Due / Balance / Left Fees (Unpaid)
    if (
      /(pending|baki|baaki|bakaya|baqaya|due|balance|remaining|unpaid|left|shesh)/.test(keyLower) ||
      /^(bal|rest)$/.test(keyNorm)
    ) {
      if (!pendingAmountRaw) pendingAmountRaw = val;
      continue;
    }

    // 4. Paid / Jama / Received / Installments
    if (/(paid|jama|deposit|received|recd|collected|submitted)/.test(keyLower)) {
      if (!explicitPaidRaw) explicitPaidRaw = val;
      continue;
    }
    if (/(inst|installment|instalment|kist|part\s*[12345]|pay\s*[12345]|dep\s*[12345]|1st|2nd|3rd|4th|cash|online|upi)/.test(keyLower)) {
      if (parsedNum !== null) {
        installmentPaidSum += parsedNum;
        installmentPaidCount += 1;
      }
      continue;
    }

    // 5. Total / Course / Package / Settled / Decided / Singular Fee
    if (
      /(total.*fee|total.*amt|total.*amount|course.*fee|package|decided|settled|agreed|fixed.*fee|actual.*fee|final.*fee|tuition.*fee|payable|net.*fee|annual.*fee|nios.*fee|student.*fee|coaching.*fee|admission.*fee|reg.*fee)/.test(
        keyLower,
      ) ||
      /^(total|fee|fees|feers|feesrs|feeamount|feesamount|totalrs|totalamt)$/.test(keyNorm)
    ) {
      if (!totalFeeRaw) totalFeeRaw = val;
    }
  }

  const paidAmountRaw =
    explicitPaidRaw || (installmentPaidCount > 0 ? String(installmentPaidSum) : '');

  const hasMainFeeSignals = Boolean(
    totalFeeRaw || paidAmountRaw || pendingAmountRaw || feeStatusRaw,
  );

  return {
    totalFeeRaw,
    paidAmountRaw,
    pendingAmountRaw,
    feeStatusRaw,
    tmaFee,
    examFee,
    hasMainFeeSignals,
  };
}

export function isUntouchedAutoImportDefaultFee(rec?: FeeRecoveryRecord | null): boolean {
  if (!rec) return false;
  if (rec.totalFee !== 12000 || rec.paidAmount !== 0 || rec.pendingAmount !== 12000) {
    return false;
  }
  if (rec.recoveryStatus !== 'Pending') return false;
  const note = String(rec.followUpNotes ?? '').trim();
  return (
    note.length === 0 ||
    /^(Imported via Excel Bulk Import|Created from updated Excel sheet|Initial fee schedule created on admission|Fees synced from updated Excel sheet|Synced with updated Excel sheet \(no fee due\)|Initialized fee record from student sheet|Fees synced from student Excel columns|Synced from student Excel columns|Fees updated from uploaded Excel)\.?$/i.test(
      note,
    )
  );
}

export function isFeeFullyPaid(rec: {
  totalFee: number;
  paidAmount: number;
  pendingAmount: number;
  recoveryStatus: RecoveryStatus;
}): boolean {
  if (rec.pendingAmount > 0) return false;
  if (rec.totalFee > 0 && rec.pendingAmount === 0 && rec.paidAmount >= rec.totalFee) return true;
  if (rec.recoveryStatus === 'Paid') return true;
  return false;
}

export function isAutoClearedZeroFee(rec?: FeeRecoveryRecord | null): boolean {
  if (!rec) return false;
  if (rec.totalFee !== 0 || rec.paidAmount !== 0 || rec.pendingAmount !== 0) {
    return false;
  }
  if (rec.recoveryStatus !== 'Pending') return false;
  const note = String(rec.followUpNotes ?? '').trim();
  if (/reset to ₹?0/i.test(note)) return false;
  return (
    note.length === 0 ||
    /^(Cleared untouched default ₹?12,?000 placeholder to ₹?0|Synced with updated Excel sheet \(no fee due\)|Initialized fee record from student sheet|Created from updated Excel sheet|Imported via Excel Bulk Import|Initial fee schedule created on admission)\.?$/i.test(
      note,
    )
  );
}

export function resolveStudentFeeSummary(
  student: Pick<Student, 'tmaFee' | 'examFee' | 'extraColumns'>,
  rec?: FeeRecoveryRecord,
): ResolvedStudentFeeSummary {
  const extraSignals = extractFeeSignalsFromExtraColumns(student.extraColumns);

  const hasTmaFee = rec?.tmaFee !== undefined || student.tmaFee !== undefined || extraSignals.tmaFee !== null;
  const hasExamFee = rec?.examFee !== undefined || student.examFee !== undefined || extraSignals.examFee !== null;

  const tmaFee =
    rec?.tmaFee !== undefined && (rec.tmaFee > 0 || (student.tmaFee ?? 0) === 0)
      ? clampFeeNumber(rec.tmaFee)
      : student.tmaFee !== undefined && (student.tmaFee > 0 || extraSignals.tmaFee === null)
        ? clampFeeNumber(student.tmaFee)
        : extraSignals.tmaFee !== null
          ? clampFeeNumber(extraSignals.tmaFee)
          : 0;

  const examFee =
    rec?.examFee !== undefined && (rec.examFee > 0 || (student.examFee ?? 0) === 0)
      ? clampFeeNumber(rec.examFee)
      : student.examFee !== undefined && (student.examFee > 0 || extraSignals.examFee === null)
        ? clampFeeNumber(student.examFee)
        : extraSignals.examFee !== null
          ? clampFeeNumber(extraSignals.examFee)
          : 0;

  // Prefer Excel extraColumns if fee_recovery is missing OR stuck at an untouched 12000 or auto-cleared zero placeholder
  if (
    extraSignals.hasMainFeeSignals &&
    (!rec || isUntouchedAutoImportDefaultFee(rec) || isAutoClearedZeroFee(rec))
  ) {
    const reconciled = reconcileFeeNumbers({
      totalFeeRaw: extraSignals.totalFeeRaw,
      paidAmountRaw: extraSignals.paidAmountRaw,
      pendingAmountRaw: extraSignals.pendingAmountRaw,
      feeStatusRaw: extraSignals.feeStatusRaw,
      defaultTotalFee: 0,
    });
    return {
      totalFee: reconciled.totalFee,
      paidAmount: reconciled.paidAmount,
      pendingAmount: reconciled.pendingAmount,
      tmaFee,
      examFee,
      recoveryStatus: reconciled.recoveryStatus,
      followUpStatus: reconciled.followUpStatus,
      hasFeeData:
        reconciled.totalFee > 0 ||
        reconciled.paidAmount > 0 ||
        reconciled.pendingAmount > 0 ||
        hasTmaFee ||
        hasExamFee,
      hasTmaFee,
      hasExamFee,
    };
  }

  if (rec) {
    const tot = clampFeeNumber(rec.totalFee);
    const paid = clampFeeNumber(rec.paidAmount);
    const pending = Math.max(0, Number(rec.pendingAmount ?? Math.max(0, tot - paid)));
    return {
      totalFee: tot,
      paidAmount: paid,
      pendingAmount: pending,
      tmaFee,
      examFee,
      recoveryStatus: rec.recoveryStatus,
      followUpStatus: rec.followUpStatus,
      hasFeeData: tot > 0 || paid > 0 || pending > 0 || hasTmaFee || hasExamFee,
      hasTmaFee,
      hasExamFee,
    };
  }

  return {
    totalFee: 0,
    paidAmount: 0,
    pendingAmount: 0,
    tmaFee,
    examFee,
    recoveryStatus: 'Pending',
    followUpStatus: 'Scheduled',
    hasFeeData: hasTmaFee || hasExamFee,
    hasTmaFee,
    hasExamFee,
  };
}

export interface FeeSyncPlanItem {
  student: Student;
  existingRecord?: FeeRecoveryRecord;
  operation: 'create' | 'update';
  totalFee: number;
  paidAmount: number;
  pendingAmount: number;
  tmaFee: number;
  examFee: number;
  recoveryStatus: RecoveryStatus;
  followUpStatus: FeeFollowUpStatus;
  reason: 'excel_columns' | 'missing_record' | 'reset_12k_default' | 'tma_exam_sync';
}

export function computeFeeSyncPlanFromStudents(
  students: readonly Student[],
  feeRecords: readonly FeeRecoveryRecord[],
  options?: { resetUntouched12000Defaults?: boolean },
): {
  items: FeeSyncPlanItem[];
  excelSyncCount: number;
  missingRecordCount: number;
  untouched12kCount: number;
} {
  const feeMap = new Map<string, FeeRecoveryRecord>();
  for (const r of feeRecords) feeMap.set(r.studentId, r);

  const items: FeeSyncPlanItem[] = [];
  let excelSyncCount = 0;
  let missingRecordCount = 0;
  let untouched12kCount = 0;
  const shouldReset12k = Boolean(options?.resetUntouched12000Defaults);

  for (const s of students) {
    const rec = feeMap.get(s.studentId);
    const extraSignals = extractFeeSignalsFromExtraColumns(s.extraColumns);
    const untouched12k = isUntouchedAutoImportDefaultFee(rec);
    const autoZeroFee = isAutoClearedZeroFee(rec);
    if (untouched12k && !extraSignals.hasMainFeeSignals) {
      untouched12kCount += 1;
    }

    const resolvedTma =
      extraSignals.tmaFee !== null
        ? extraSignals.tmaFee
        : s.tmaFee !== undefined
          ? clampFeeNumber(s.tmaFee)
          : rec?.tmaFee !== undefined
            ? clampFeeNumber(rec.tmaFee)
            : 0;
    const resolvedExam =
      extraSignals.examFee !== null
        ? extraSignals.examFee
        : s.examFee !== undefined
          ? clampFeeNumber(s.examFee)
          : rec?.examFee !== undefined
            ? clampFeeNumber(rec.examFee)
            : 0;

    if (extraSignals.hasMainFeeSignals && (!rec || untouched12k || autoZeroFee)) {
      const reconciled = reconcileFeeNumbers({
        totalFeeRaw: extraSignals.totalFeeRaw,
        paidAmountRaw: extraSignals.paidAmountRaw,
        pendingAmountRaw: extraSignals.pendingAmountRaw,
        feeStatusRaw: extraSignals.feeStatusRaw,
        defaultTotalFee: 0,
      });
      excelSyncCount += 1;
      items.push({
        student: s,
        existingRecord: rec,
        operation: rec ? 'update' : 'create',
        totalFee: reconciled.totalFee,
        paidAmount: reconciled.paidAmount,
        pendingAmount: reconciled.pendingAmount,
        tmaFee: resolvedTma,
        examFee: resolvedExam,
        recoveryStatus: reconciled.recoveryStatus,
        followUpStatus: reconciled.followUpStatus,
        reason: 'excel_columns',
      });
      continue;
    }

    if (!rec) {
      missingRecordCount += 1;
      items.push({
        student: s,
        existingRecord: undefined,
        operation: 'create',
        totalFee: 0,
        paidAmount: 0,
        pendingAmount: 0,
        tmaFee: resolvedTma,
        examFee: resolvedExam,
        recoveryStatus: 'Pending',
        followUpStatus: 'Scheduled',
        reason: 'missing_record',
      });
      continue;
    }

    if (shouldReset12k && untouched12k && !extraSignals.hasMainFeeSignals) {
      items.push({
        student: s,
        existingRecord: rec,
        operation: 'update',
        totalFee: 0,
        paidAmount: 0,
        pendingAmount: 0,
        tmaFee: resolvedTma,
        examFee: resolvedExam,
        recoveryStatus: 'Pending',
        followUpStatus: 'Scheduled',
        reason: 'reset_12k_default',
      });
      continue;
    }

    const recTma = clampFeeNumber(rec.tmaFee ?? 0);
    const recExam = clampFeeNumber(rec.examFee ?? 0);
    if (
      (resolvedTma > 0 && recTma !== resolvedTma) ||
      (resolvedExam > 0 && recExam !== resolvedExam)
    ) {
      excelSyncCount += 1;
      items.push({
        student: s,
        existingRecord: rec,
        operation: 'update',
        totalFee: clampFeeNumber(rec.totalFee),
        paidAmount: clampFeeNumber(rec.paidAmount),
        pendingAmount: clampFeeNumber(rec.pendingAmount),
        tmaFee: resolvedTma,
        examFee: resolvedExam,
        recoveryStatus: rec.recoveryStatus,
        followUpStatus: rec.followUpStatus,
        reason: 'tma_exam_sync',
      });
    }
  }

  return { items, excelSyncCount, missingRecordCount, untouched12kCount };
}

/**
 * Allocates integer percentages whose sum is guaranteed to equal 100 (Largest Remainder / Hamilton method).
 */
export function allocateExactPercentages(counts: number[]): number[] {
  const total = counts.reduce((a, b) => a + Math.max(0, b), 0);
  if (total <= 0) return counts.map(() => 0);

  const exact = counts.map((c) => (Math.max(0, c) / total) * 100);
  const floors = exact.map((v) => Math.floor(v));
  let remainder = 100 - floors.reduce((a, b) => a + b, 0);

  const ranked = exact
    .map((v, idx) => ({ idx, frac: v - floors[idx] }))
    .sort((a, b) => b.frac - a.frac);

  for (let i = 0; i < remainder && i < ranked.length; i++) {
    floors[ranked[i].idx] += 1;
  }
  return floors;
}

export interface BranchMetricPoint {
  centreId: CentreId;
  name: string;
  fullName: string;
  students: number;
  percentage: number;
  color: string;
  totalFee: number;
  paidFee: number;
  pendingFee: number;
  collectionRate: number;
  tmaSubmitted: number;
  practicalDone: number;
  regularAttendance: number;
}

export interface ReasoningInsight {
  id: string;
  severity: 'good' | 'attention' | 'critical';
  title: string;
  metric: string;
  explanation: string;
}

export interface InstitutionalAnalytics {
  totalStudents: number;
  totalFeeBilled: number;
  totalFeePaid: number;
  totalFeePending: number;
  totalTmaFee: number;
  totalExamFee: number;
  collectionRatePct: number;
  avgFeePerStudent: number;
  paidCount: number;
  partialCount: number;
  pendingCount: number;
  overdueCount: number;
  tmaSubmittedCount: number;
  tmaRatePct: number;
  practicalDoneCount: number;
  practicalRatePct: number;
  regularAttendanceCount: number;
  attendanceRatePct: number;
  confirmedAdmissionsCount: number;
  admissionRatePct: number;
  branchMetrics: BranchMetricPoint[];
  departmentPerformance: Array<{
    department: string;
    Completed: number;
    Pending: number;
    completionPct: number;
  }>;
  reasoningInsights: ReasoningInsight[];
}

const BRANCH_COLORS = ['#DC2626', '#2563EB', '#7C3AED', '#059669'];

export function computeInstitutionalAnalytics(
  students: Student[],
  feeRecords: FeeRecoveryRecord[],
  admissionRecords: AdmissionRecord[],
  effectiveCentre: CentreId | 'all',
): InstitutionalAnalytics {
  const scopedStudents =
    effectiveCentre === 'all' ? students : students.filter((s) => s.centreId === effectiveCentre);
  const feeByStudent = new Map<string, FeeRecoveryRecord>();
  feeRecords.forEach((f) => feeByStudent.set(f.studentId, f));

  const admByStudent = new Map<string, AdmissionRecord>();
  admissionRecords.forEach((a) => admByStudent.set(a.studentId, a));

  let totalFeeBilled = 0;
  let totalFeePaid = 0;
  let totalFeePending = 0;
  let totalTmaFee = 0;
  let totalExamFee = 0;
  let paidCount = 0;
  let partialCount = 0;
  let pendingCount = 0;
  let overdueCount = 0;

  // Compute fee financials across ALL scoped students (joining with fee_recovery or extraColumns if present)
  const resolvedFeePerStudent = new Map<string, ResolvedStudentFeeSummary>();
  for (const s of scopedStudents) {
    const rec = feeByStudent.get(s.studentId);
    const resolved = resolveStudentFeeSummary(s, rec);
    resolvedFeePerStudent.set(s.studentId, resolved);
    totalFeeBilled += resolved.totalFee;
    totalFeePaid += resolved.paidAmount;
    totalFeePending += resolved.pendingAmount;
    totalTmaFee += resolved.tmaFee;
    totalExamFee += resolved.examFee;

    if (resolved.recoveryStatus === 'Paid') paidCount++;
    else if (resolved.recoveryStatus === 'Partial') partialCount++;
    else if (resolved.recoveryStatus === 'Overdue') overdueCount++;
    else pendingCount++;
  }

  const totalStudents = scopedStudents.length;
  const collectionRatePct =
    totalFeeBilled > 0 ? Math.round((totalFeePaid / totalFeeBilled) * 100) : 0;
  const avgFeePerStudent = totalStudents > 0 ? Math.round(totalFeePaid / totalStudents) : 0;

  const tmaSubmittedCount = scopedStudents.filter((s) => s.tmaStatus === 'Submitted').length;
  const practicalDoneCount = scopedStudents.filter((s) => s.practicalStatus === 'Completed').length;
  const regularAttendanceCount = scopedStudents.filter(
    (s) => s.classAttendanceStatus === 'Regular',
  ).length;
  const confirmedAdmissionsCount = scopedStudents.filter((s) => {
    const rec = admByStudent.get(s.studentId);
    return rec ? rec.admissionStatus === 'Confirmed' : true;
  }).length;

  const tmaRatePct = totalStudents > 0 ? Math.round((tmaSubmittedCount / totalStudents) * 100) : 0;
  const practicalRatePct =
    totalStudents > 0 ? Math.round((practicalDoneCount / totalStudents) * 100) : 0;
  const attendanceRatePct =
    totalStudents > 0 ? Math.round((regularAttendanceCount / totalStudents) * 100) : 0;
  const admissionRatePct =
    totalStudents > 0 ? Math.round((confirmedAdmissionsCount / totalStudents) * 100) : 0;

  const targetCentres =
    effectiveCentre === 'all'
      ? CANONICAL_CENTRES
      : CANONICAL_CENTRES.filter((c) => c.id === effectiveCentre);

  const branchCounts = targetCentres.map(
    (c) => scopedStudents.filter((s) => s.centreId === c.id).length,
  );
  const exactPcts = allocateExactPercentages(branchCounts);

  const branchMetrics: BranchMetricPoint[] = targetCentres.map((c, idx) => {
    const cStudents = scopedStudents.filter((s) => s.centreId === c.id);
    let cTotalFee = 0;
    let cPaidFee = 0;
    let cPendingFee = 0;
    for (const s of cStudents) {
      const f = resolvedFeePerStudent.get(s.studentId);
      if (f) {
        cTotalFee += f.totalFee;
        cPaidFee += f.paidAmount;
        cPendingFee += f.pendingAmount;
      }
    }
    return {
      centreId: c.id,
      name: c.code,
      fullName: c.name,
      students: cStudents.length,
      percentage: exactPcts[idx] ?? 0,
      color: BRANCH_COLORS[idx % BRANCH_COLORS.length],
      totalFee: cTotalFee,
      paidFee: cPaidFee,
      pendingFee: cPendingFee,
      collectionRate: cTotalFee > 0 ? Math.round((cPaidFee / cTotalFee) * 100) : 0,
      tmaSubmitted: cStudents.filter((s) => s.tmaStatus === 'Submitted').length,
      practicalDone: cStudents.filter((s) => s.practicalStatus === 'Completed').length,
      regularAttendance: cStudents.filter((s) => s.classAttendanceStatus === 'Regular').length,
    };
  });

  const departmentPerformance = [
    {
      department: 'Admission',
      Completed: confirmedAdmissionsCount,
      Pending: Math.max(0, totalStudents - confirmedAdmissionsCount),
      completionPct: admissionRatePct,
    },
    {
      department: 'Fee Recovery',
      Completed: paidCount,
      Pending: Math.max(0, totalStudents - paidCount),
      completionPct: totalStudents > 0 ? Math.round((paidCount / totalStudents) * 100) : 0,
    },
    {
      department: 'TMA',
      Completed: tmaSubmittedCount,
      Pending: Math.max(0, totalStudents - tmaSubmittedCount),
      completionPct: tmaRatePct,
    },
    {
      department: 'Practical',
      Completed: practicalDoneCount,
      Pending: Math.max(0, totalStudents - practicalDoneCount),
      completionPct: practicalRatePct,
    },
    {
      department: 'Online',
      Completed: regularAttendanceCount,
      Pending: Math.max(0, totalStudents - regularAttendanceCount),
      completionPct: attendanceRatePct,
    },
  ];

  // Logic & Mathematical Reasoning Insights (Deterministic audit)
  const reasoningInsights: ReasoningInsight[] = [];

  if (totalStudents === 0) {
    reasoningInsights.push({
      id: 'empty',
      severity: 'attention',
      title: 'Awaiting Student Excel Data',
      metric: '0 Students',
      explanation: 'Upload an Excel/CSV sheet to activate live fee recovery math, completion ratios, and branch comparisons.',
    });
  } else {
    reasoningInsights.push({
      id: 'fee_ratio',
      severity: collectionRatePct >= 75 ? 'good' : collectionRatePct >= 40 ? 'attention' : 'critical',
      title: 'Mathematical Fee Recovery Ratio',
      metric: `${collectionRatePct}% Collected`,
      explanation: `₹${totalFeePaid.toLocaleString('en-IN')} collected out of ₹${totalFeeBilled.toLocaleString('en-IN')} total billed (${paidCount} Full Paid, ${partialCount} Partial, ${pendingCount + overdueCount} Unpaid/Overdue).`,
    });

    const highestPendingBranch = branchMetrics
      .slice()
      .sort((a, b) => b.pendingFee - a.pendingFee)[0];
    if (highestPendingBranch && highestPendingBranch.pendingFee > 0) {
      const pendingShare =
        totalFeePending > 0
          ? Math.round((highestPendingBranch.pendingFee / totalFeePending) * 100)
          : 0;
      reasoningInsights.push({
        id: 'pending_concentration',
        severity: pendingShare >= 50 ? 'critical' : 'attention',
        title: 'Highest Pending Fee Concentration',
        metric: `${highestPendingBranch.name} · ₹${highestPendingBranch.pendingFee.toLocaleString('en-IN')}`,
        explanation: `${CENTRE_MAP[highestPendingBranch.centreId].name} holds ${pendingShare}% of total pending dues (${highestPendingBranch.collectionRate}% recovered).`,
      });
    }

    const academicDepts = departmentPerformance.filter((d) => d.department !== 'Admission');
    const bottleneck = academicDepts.slice().sort((a, b) => a.completionPct - b.completionPct)[0];
    if (bottleneck) {
      reasoningInsights.push({
        id: 'dept_bottleneck',
        severity: bottleneck.completionPct >= 70 ? 'good' : bottleneck.completionPct >= 40 ? 'attention' : 'critical',
        title: `Lowest Department Rate: ${bottleneck.department}`,
        metric: `${bottleneck.completionPct}% Done (${bottleneck.Pending} Pending)`,
        explanation: `${bottleneck.Completed} of ${totalStudents} students completed ${bottleneck.department}; prioritizing ${bottleneck.Pending} pending students yields highest score gain.`,
      });
    }

    const regularPaidOverlap = scopedStudents.filter((s) => {
      const fee = resolvedFeePerStudent.get(s.studentId);
      return s.tmaStatus !== 'Submitted' && fee && fee.pendingAmount > 0;
    }).length;
    if (regularPaidOverlap > 0) {
      reasoningInsights.push({
        id: 'dual_risk',
        severity: 'attention',
        title: 'Dual-Follow-Up Cohort (Fee + TMA)',
        metric: `${regularPaidOverlap} Students`,
        explanation: `${regularPaidOverlap} students have both pending fee dues and pending TMA submission — combine fee + TMA follow-up in one WhatsApp/Call touchpoint.`,
      });
    }
  }

  return {
    totalStudents,
    totalFeeBilled,
    totalFeePaid,
    totalFeePending,
    totalTmaFee,
    totalExamFee,
    collectionRatePct,
    avgFeePerStudent,
    paidCount,
    partialCount,
    pendingCount,
    overdueCount,
    tmaSubmittedCount,
    tmaRatePct,
    practicalDoneCount,
    practicalRatePct,
    regularAttendanceCount,
    attendanceRatePct,
    confirmedAdmissionsCount,
    admissionRatePct,
    branchMetrics,
    departmentPerformance,
    reasoningInsights,
  };
}
