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
): string | null {
  const digits = extractCallableDigits(mobile);
  if (!digits) return null;
  const cleanName = (studentName || 'Student').trim();
  const text = encodeURIComponent(
    `Namaste ${cleanName}, Vision Point / Axis Academy (Database Security) se aapke admission aur fees update ke sambandh mein sampark kiya ja raha hai.`,
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
  const defaultTotal = Math.max(0, Math.round(params.defaultTotalFee ?? 12000));
  const rawTotal = parseFeeNumberNullable(params.totalFeeRaw);
  const rawPaid = parseFeeNumberNullable(params.paidAmountRaw);
  const rawPending = parseFeeNumberNullable(params.pendingAmountRaw);
  const statusText = String(params.feeStatusRaw ?? '').trim().toLowerCase();

  const statusIndicatesPaid =
    /\b(full\s*paid|fully\s*paid|paid|clear|cleared|completed|settled|no\s*due|nil)\b/.test(statusText) &&
    !/\b(unpaid|not\s*paid|partial|pending|due|overdue)\b/.test(statusText);
  const statusIndicatesOverdue = /\b(overdue|defaulter|late)\b/.test(statusText);
  const statusIndicatesUnpaid = /\b(unpaid|not\s*paid)\b/.test(statusText);

  const explicitFeeDetected =
    rawTotal !== null || rawPaid !== null || rawPending !== null || statusText.length > 0;

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
    if (statusIndicatesPaid) {
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
  let paidCount = 0;
  let partialCount = 0;
  let pendingCount = 0;
  let overdueCount = 0;

  // Compute fee financials across ALL scoped students (joining with fee_recovery or extraColumns if present)
  const resolvedFeePerStudent = new Map<string, ReconciledFeeResult>();
  for (const s of scopedStudents) {
    const rec = feeByStudent.get(s.studentId);
    let resolved: ReconciledFeeResult;
    if (rec) {
      const tot = Math.max(0, Number(rec.totalFee || 0));
      const paid = Math.max(0, Number(rec.paidAmount || 0));
      const pending = Math.max(0, Number(rec.pendingAmount ?? Math.max(0, tot - paid)));
      resolved = {
        totalFee: tot,
        paidAmount: paid,
        pendingAmount: pending,
        recoveryStatus: rec.recoveryStatus,
        followUpStatus: rec.followUpStatus,
        explicitFeeDetected: true,
      };
    } else {
      // Fallback: inspect extraColumns if fee_recovery doc hasn't been created yet
      const extras = s.extraColumns || {};
      const findExtra = (rx: RegExp): string => {
        for (const [k, v] of Object.entries(extras)) {
          if (rx.test(k.toLowerCase())) return v;
        }
        return '';
      };
      const hasAnyExtraFee =
        Boolean(findExtra(/total.*fee|course.*fee|package/)) ||
        Boolean(findExtra(/paid|jama|deposit|received/)) ||
        Boolean(findExtra(/pending|baki|baaki|due|balance/));
      resolved = hasAnyExtraFee
        ? reconcileFeeNumbers({
            totalFeeRaw: findExtra(/total.*fee|course.*fee|package/),
            paidAmountRaw: findExtra(/paid|jama|deposit|received/),
            pendingAmountRaw: findExtra(/pending|baki|baaki|due|balance/),
            feeStatusRaw: findExtra(/fee.*status|payment.*status/),
          })
        : {
            totalFee: 0,
            paidAmount: 0,
            pendingAmount: 0,
            recoveryStatus: 'Pending',
            followUpStatus: 'Scheduled',
            explicitFeeDetected: false,
          };
    }
    resolvedFeePerStudent.set(s.studentId, resolved);
    totalFeeBilled += resolved.totalFee;
    totalFeePaid += resolved.paidAmount;
    totalFeePending += resolved.pendingAmount;

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
