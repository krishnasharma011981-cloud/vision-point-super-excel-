import { buildTelHref, buildWhatsAppHref } from './analyticsMath';
import type {
  CallTaskStatus,
  CentreId,
  Student,
  UserAccount,
  WorkAssignmentDepartment,
  WorkAssignmentTask,
} from '../types/domain';

export const WORK_ASSIGNMENT_DEPARTMENT_LABELS: Record<WorkAssignmentDepartment, string> = {
  fee_recovery: 'Fee Recovery Calling',
  practical: 'Practical Follow-Up',
  tma: 'TMA Follow-Up',
};

export type QuickFollowUpPreset =
  | 'today_plus_2h'
  | 'tomorrow_11am'
  | 'tomorrow_4pm'
  | 'day_after_11am';

export interface FollowUpScheduleInfo {
  hasSchedule: boolean;
  label: string;
  isOverdue: boolean;
  isDueToday: boolean;
  sortTimestamp: number;
}

export interface AssignmentProgressSummary {
  total: number;
  completed: number;
  followUpScheduled: number;
  notAnswered: number;
  pending: number;
  dueNowCount: number;
  percentDone: number;
}

export function canAssignDepartmentWork(user: Pick<UserAccount, 'role' | 'status'> | null | undefined): boolean {
  if (!user || user.status !== 'Active') return false;
  return user.role === 'super_admin' || user.role === 'centre_head';
}

export function canManageAssignmentForCentre(
  actor: Pick<UserAccount, 'role' | 'status' | 'centreId'> | null | undefined,
  centreId: CentreId,
): boolean {
  if (!canAssignDepartmentWork(actor) || !actor) return false;
  if (actor.role === 'super_admin') return true;
  return actor.centreId === centreId;
}

export function sanitizeFirestoreDocId(raw: string, maxLen = 120): string {
  const cleaned = String(raw || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return (cleaned || 'id').slice(0, maxLen);
}

/**
 * Extracts Father's Name cleanly from student.extraColumns (supports common Excel headers
 * like "FATHERS NAME", "FATHER'S NAME", "FATHER NAME", "PAPA NAME", "GUARDIAN NAME", etc.)
 * while skipping father mobile/phone/contact columns.
 */
export function extractStudentFatherName(student: Pick<Student, 'extraColumns'>): string {
  const extras = student.extraColumns;
  if (!extras || typeof extras !== 'object') return '';

  const entries = Object.entries(extras);
  const scored: Array<{ priority: number; value: string }> = [];

  for (const [rawKey, rawVal] of entries) {
    const val = String(rawVal ?? '').trim();
    if (!val || val === '-' || val === '—' || /^n\/?a$/i.test(val)) continue;
    const keyNorm = rawKey.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (!keyNorm) continue;

    // Exclude phone/mobile/number columns (e.g., "Father Mobile No")
    if (/(mobile|phone|contact|whatsapp|\bno\b|number|mob|tel|call)/i.test(keyNorm)) {
      continue;
    }

    if (/^father'?s?\s*name$|^fathers\s*name$|^papa\s*ka\s*naam$|^papa\s*name$/.test(keyNorm)) {
      scored.push({ priority: 1, value: val });
    } else if (/(father|papa)/.test(keyNorm) && /name|naam/.test(keyNorm)) {
      scored.push({ priority: 2, value: val });
    } else if (/^(father|fathers|f\s*name|fname|papa)$/.test(keyNorm)) {
      scored.push({ priority: 3, value: val });
    } else if (/guardian/.test(keyNorm)) {
      scored.push({ priority: 4, value: val });
    }
  }

  if (scored.length === 0) return '';
  scored.sort((a, b) => a.priority - b.priority);
  return scored[0].value.slice(0, 120);
}

function isDialableNumber(value: string): boolean {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length >= 10 && digits.length <= 13;
}

/**
 * Picks the best calling mobile number for a student:
 * prefers student.mobileNumber if it has >=10 digits, otherwise checks extraColumns
 * for CALLING NO / MOBILE / WHATSAPP / FATHER MOBILE / PHONE.
 */
export function extractStudentCallingNumber(
  student: Pick<Student, 'mobileNumber' | 'extraColumns'>,
): string {
  const primary = String(student.mobileNumber ?? '').trim();
  if (isDialableNumber(primary)) return primary.slice(0, 20);

  const extras = student.extraColumns;
  if (extras && typeof extras === 'object') {
    const candidates: Array<{ priority: number; value: string }> = [];
    for (const [rawKey, rawVal] of Object.entries(extras)) {
      const val = String(rawVal ?? '').trim();
      if (!isDialableNumber(val)) continue;
      const keyNorm = rawKey.toLowerCase();
      if (/calling|call/.test(keyNorm)) candidates.push({ priority: 1, value: val });
      else if (/mobile|mob|phone|contact|whatsapp/.test(keyNorm)) candidates.push({ priority: 2, value: val });
      else candidates.push({ priority: 3, value: val });
    }
    if (candidates.length > 0) {
      candidates.sort((a, b) => a.priority - b.priority);
      return candidates[0].value.slice(0, 20);
    }
  }

  return primary.slice(0, 20);
}

export interface SerialScopedStudent {
  student: Student;
  displaySerial: number;
}

/**
 * Selects students whose contextual 1-based display serial lies in [fromSerial, toSerial]
 * (inclusive), ordered ascending by displaySerial.
 */
export function selectStudentsForAssignmentRange(
  students: Student[],
  displaySerialMap: Map<string, number>,
  fromSerial: number,
  toSerial: number,
  predicate?: (student: Student) => boolean,
): SerialScopedStudent[] {
  const safeFrom = Math.max(1, Math.floor(Number(fromSerial) || 1));
  const safeTo = Math.max(safeFrom, Math.floor(Number(toSerial) || safeFrom));

  const results: SerialScopedStudent[] = [];
  for (const student of students) {
    const serial = displaySerialMap.get(student.studentId) ?? (Number(student.serialNumber) || 0);
    if (serial < safeFrom || serial > safeTo) continue;
    if (predicate && !predicate(student)) continue;
    results.push({ student, displaySerial: serial });
  }

  results.sort((a, b) => a.displaySerial - b.displaySerial);
  return results;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export function formatLocalDateIso(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

export function formatTime12Hour(time24: string): string {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(time24 || '').trim());
  if (!match) return '';
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return '';
  const period = hours >= 12 ? 'PM' : 'AM';
  const h12 = hours % 12 === 0 ? 12 : hours % 12;
  return `${h12}:${pad2(minutes)} ${period}`;
}

export function buildQuickFollowUpPreset(
  preset: QuickFollowUpPreset,
  now: Date = new Date(),
): { date: string; time: string } {
  const base = new Date(now.getTime());

  if (preset === 'today_plus_2h') {
    const target = new Date(base.getTime() + 2 * 60 * 60 * 1000);
    // Round minutes to nearest 15-min slot for clean calling times
    const mins = Math.ceil(target.getMinutes() / 15) * 15;
    target.setMinutes(mins, 0, 0);
    return {
      date: formatLocalDateIso(target),
      time: `${pad2(target.getHours())}:${pad2(target.getMinutes())}`,
    };
  }

  if (preset === 'tomorrow_11am') {
    base.setDate(base.getDate() + 1);
    return { date: formatLocalDateIso(base), time: '11:00' };
  }

  if (preset === 'tomorrow_4pm') {
    base.setDate(base.getDate() + 1);
    return { date: formatLocalDateIso(base), time: '16:00' };
  }

  // day_after_11am
  base.setDate(base.getDate() + 2);
  return { date: formatLocalDateIso(base), time: '11:00' };
}

export function formatFollowUpSchedule(
  dateStr: string,
  timeStr: string,
  now: Date = new Date(),
): FollowUpScheduleInfo {
  const cleanDate = String(dateStr || '').trim();
  const cleanTime = String(timeStr || '').trim();
  if (!cleanDate) {
    return {
      hasSchedule: false,
      label: 'Not Scheduled',
      isOverdue: false,
      isDueToday: false,
      sortTimestamp: Number.MAX_SAFE_INTEGER,
    };
  }

  const dateParts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(cleanDate);
  if (!dateParts) {
    return {
      hasSchedule: true,
      label: cleanTime ? `${cleanDate} · ${formatTime12Hour(cleanTime) || cleanTime}` : cleanDate,
      isOverdue: false,
      isDueToday: false,
      sortTimestamp: Number.MAX_SAFE_INTEGER - 1,
    };
  }

  const year = Number(dateParts[1]);
  const month = Number(dateParts[2]) - 1;
  const day = Number(dateParts[3]);

  let hours = 18;
  let minutes = 0;
  const timeParts = /^(\d{1,2}):(\d{2})$/.exec(cleanTime);
  if (timeParts) {
    hours = Math.min(23, Math.max(0, Number(timeParts[1])));
    minutes = Math.min(59, Math.max(0, Number(timeParts[2])));
  }

  const scheduledDate = new Date(year, month, day, hours, minutes, 0, 0);
  const todayIso = formatLocalDateIso(now);
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const tomorrowIso = formatLocalDateIso(tomorrow);

  let dayLabel: string;
  if (cleanDate === todayIso) {
    dayLabel = 'Today';
  } else if (cleanDate === tomorrowIso) {
    dayLabel = 'Tomorrow';
  } else {
    dayLabel = scheduledDate.toLocaleDateString('en-IN', {
      day: '2-digit',
      month: 'short',
    });
  }

  const formattedTime = formatTime12Hour(cleanTime);
  const label = formattedTime ? `${dayLabel}, ${formattedTime}` : dayLabel;

  const isDueToday = cleanDate === todayIso;
  const isOverdue = scheduledDate.getTime() < now.getTime();

  return {
    hasSchedule: true,
    label,
    isOverdue,
    isDueToday,
    sortTimestamp: scheduledDate.getTime(),
  };
}

export function computeAssignmentProgress(
  tasks: Array<Pick<WorkAssignmentTask, 'callStatus' | 'followUpDate' | 'followUpTime'>>,
  now: Date = new Date(),
): AssignmentProgressSummary {
  let completed = 0;
  let followUpScheduled = 0;
  let notAnswered = 0;
  let pending = 0;
  let dueNowCount = 0;

  for (const task of tasks) {
    const status: CallTaskStatus = task.callStatus || 'Pending';
    if (status === 'Called - Done') {
      completed += 1;
    } else if (status === 'Follow-up Scheduled') {
      followUpScheduled += 1;
      const sched = formatFollowUpSchedule(task.followUpDate, task.followUpTime, now);
      if (sched.hasSchedule && (sched.isOverdue || sched.isDueToday)) {
        dueNowCount += 1;
      }
    } else if (status === 'Not Answered') {
      notAnswered += 1;
    } else {
      pending += 1;
    }
  }

  const total = tasks.length;
  const percentDone = total > 0 ? Math.round((completed / total) * 100) : 0;

  return {
    total,
    completed,
    followUpScheduled,
    notAnswered,
    pending,
    dueNowCount,
    percentDone,
  };
}

export function buildTaskCallLink(task: Pick<WorkAssignmentTask, 'callingNumber' | 'mobileNumber'>): string | null {
  return buildTelHref(task.callingNumber || task.mobileNumber);
}

export function buildTaskWhatsAppLink(
  task: Pick<WorkAssignmentTask, 'department' | 'callingNumber' | 'mobileNumber' | 'studentName' | 'pendingFee' | 'subject'>,
): string | null {
  const num = task.callingNumber || task.mobileNumber;
  let context = 'NIOS follow-up ke liye contact kar rahe hain';
  if (task.department === 'fee_recovery') {
    context =
      task.pendingFee > 0
        ? `Fee Recovery follow-up (Pending Fee: Rs.${task.pendingFee.toLocaleString('en-IN')})`
        : 'Fee Recovery aur status update follow-up';
  } else if (task.department === 'practical') {
    context = task.subject
      ? `Practical file aur submission follow-up (Subjects: ${task.subject})`
      : 'Practical file aur submission follow-up';
  } else if (task.department === 'tma') {
    context = task.subject
      ? `TMA assignment submission follow-up (Subjects: ${task.subject})`
      : 'TMA assignment submission follow-up';
  }
  return buildWhatsAppHref(num, task.studentName, context);
}

export function getEligibleStaffForCentre(
  employees: UserAccount[],
  centreId: CentreId,
  department: WorkAssignmentDepartment,
): UserAccount[] {
  const activeInCentre = employees.filter(
    (u) => u.status === 'Active' && u.centreId === centreId && u.role === 'employee',
  );
  // Sort department-matching employees first, then alphabetically by fullName
  return [...activeInCentre].sort((a, b) => {
    const aMatch = a.department === department ? 0 : 1;
    const bMatch = b.department === department ? 0 : 1;
    if (aMatch !== bMatch) return aMatch - bMatch;
    return a.fullName.localeCompare(b.fullName);
  });
}
