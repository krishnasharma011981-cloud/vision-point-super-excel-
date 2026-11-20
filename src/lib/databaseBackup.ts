import * as XLSX from 'xlsx';
import { CANONICAL_CENTRES, CENTRE_MAP, DEPARTMENT_LABELS, ROLE_LABELS } from '../constants/centres';
import { sanitizeFirestoreDocId } from './workAssignment';
import type {
  AdmissionRecord,
  Centre,
  CentreId,
  EditRequest,
  EmployeeReport,
  ExcelSheetConfig,
  FeeRecoveryRecord,
  OnlineClassRecord,
  PracticalRecord,
  StaffInvite,
  Student,
  SystemSettings,
  TmaRecord,
  UserAccount,
  UserDepartment,
  UserRole,
  WorkAssignment,
  WorkAssignmentTask,
} from '../types/domain';

export interface FullDatabaseBackupPayload {
  version: 2 | 3;
  exportedAt: string;
  exportedBy: string;
  centres: Record<string, unknown>[];
  students: Record<string, unknown>[];
  fee_recovery: Record<string, unknown>[];
  practical_records: Record<string, unknown>[];
  tma_records: Record<string, unknown>[];
  online_class_records: Record<string, unknown>[];
  admission_records: Record<string, unknown>[];
  excel_sheet_configs: Record<string, unknown>[];
  work_assignments: Record<string, unknown>[];
  work_assignment_tasks: Record<string, unknown>[];
  users: Record<string, unknown>[];
  staff_invites: Record<string, unknown>[];
  employee_reports: Record<string, unknown>[];
  edit_requests: Record<string, unknown>[];
  settings: Record<string, unknown> | null;
}

export interface BackupSummaryCounts {
  centres: number;
  students: number;
  fee_recovery: number;
  practical_records: number;
  tma_records: number;
  online_class_records: number;
  admission_records: number;
  excel_sheet_configs: number;
  work_assignments: number;
  work_assignment_tasks: number;
  users: number;
  staff_invites: number;
  employee_reports: number;
  edit_requests: number;
  hasSettings: boolean;
  totalDocuments: number;
}

export interface RestorableStaffProfile {
  legacyUid?: string;
  fullName: string;
  email: string;
  mobileNumber: string;
  role: Exclude<UserRole, 'super_admin'>;
  centreId: CentreId;
  centreName: string;
  department: UserDepartment;
  joiningDate: string;
  status: 'Active' | 'Inactive';
}

export type ParseBackupResult =
  | { ok: true; backup: FullDatabaseBackupPayload; summary: BackupSummaryCounts; staffProfiles: RestorableStaffProfile[] }
  | { ok: false; error: string };

const VALID_CENTRE_IDS = new Set<string>(CANONICAL_CENTRES.map((c) => c.id));
const VALID_TC = new Set(['Received', 'Not Received', 'Not Applicable']);
const VALID_BOOK = new Set(['Received', 'Not Received', 'Pending']);
const VALID_ATTENDANCE = new Set(['Regular', 'Irregular', 'Not Attending']);
const VALID_TMA = new Set(['Submitted', 'Not Submitted', 'Pending']);
const VALID_PRACTICAL = new Set(['Completed', 'Not Completed', 'Pending']);
const VALID_EXAM = new Set(['Completed', 'Not Completed', 'Partially Completed']);
const VALID_RECOVERY = new Set(['Paid', 'Partial', 'Pending', 'Overdue']);
const VALID_FEE_FOLLOWUP = new Set(['Scheduled', 'Contacted', 'Promise to Pay', 'Closed']);
const VALID_SUBMISSION = new Set(['Submitted', 'Not Submitted', 'Under Review']);
const VALID_PARTICIPATION = new Set(['High', 'Moderate', 'Low', 'Inactive']);
const VALID_ADMISSION = new Set(['Confirmed', 'Provisional', 'Pending Verification', 'Cancelled']);
const VALID_ADMISSION_FOLLOWUP = new Set(['Completed', 'Pending Follow-up', 'Document Due']);
const VALID_WORK_DEPT = new Set(['fee_recovery', 'practical', 'tma']);
const VALID_WORK_STATUS = new Set(['Active', 'Completed', 'Archived']);
const VALID_CALL_STATUS = new Set(['Pending', 'Follow-up Scheduled', 'Called - Done', 'Not Answered']);
const VALID_DEPARTMENTS = new Set(['all', 'fee_recovery', 'practical', 'tma', 'online_classes', 'admission']);

function cleanStr(val: unknown, maxLen: number, fallback = ''): string {
  const s = typeof val === 'string' ? val.trim() : val == null ? '' : String(val).trim();
  const base = s || fallback;
  return base.slice(0, maxLen);
}

function cleanMinStr(val: unknown, minLen: number, maxLen: number, fallback: string): string {
  const s = cleanStr(val, maxLen);
  if (s.length >= minLen) return s;
  return fallback.slice(0, maxLen);
}

function cleanNum(val: unknown, min: number, max: number, fallback = 0): number {
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function resolveCentreId(raw: unknown): CentreId {
  const s = String(raw || '').trim();
  if (VALID_CENTRE_IDS.has(s)) return s as CentreId;
  const lower = s.toLowerCase();
  if (lower.includes('civil') || lower.includes('cln')) return 'vp_civillines';
  if (lower.includes('varanasi') || lower.includes('vns')) return 'xis_varanasi';
  if (lower.includes('jaunpur') || lower.includes('jnp')) return 'xis_jaunpur';
  return 'vp_lookerganj';
}

function resolveValidDocId(raw: unknown, prefix: string, maxLen = 128): string {
  const cleaned = sanitizeFirestoreDocId(String(raw || ''), maxLen);
  if (cleaned.length >= 1) return cleaned;
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`.slice(0, maxLen);
}

function serializeValueForExport(value: unknown): unknown {
  if (value == null) return value;
  if (typeof value === 'object') {
    const asTs = value as { toDate?: () => Date; seconds?: number; nanoseconds?: number };
    if (typeof asTs.toDate === 'function') {
      try {
        return asTs.toDate().toISOString();
      } catch {
        return new Date().toISOString();
      }
    }
    if (Array.isArray(value)) {
      return value.map(serializeValueForExport);
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== undefined) {
        out[k] = serializeValueForExport(v);
      }
    }
    return out;
  }
  return value;
}

function normalizeCollectionArray(raw: unknown): Record<string, unknown>[] {
  if (Array.isArray(raw)) {
    return raw.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item));
  }
  if (raw && typeof raw === 'object') {
    return Object.entries(raw as Record<string, unknown>)
      .filter(([, v]) => Boolean(v) && typeof v === 'object' && !Array.isArray(v))
      .map(([k, v]) => ({ _docId: k, ...(v as Record<string, unknown>) }));
  }
  return [];
}

export function computeBackupSummary(backup: FullDatabaseBackupPayload): BackupSummaryCounts {
  const totalDocuments =
    backup.centres.length +
    backup.students.length +
    backup.fee_recovery.length +
    backup.practical_records.length +
    backup.tma_records.length +
    backup.online_class_records.length +
    backup.admission_records.length +
    backup.excel_sheet_configs.length +
    backup.work_assignments.length +
    backup.work_assignment_tasks.length +
    backup.users.length +
    backup.staff_invites.length +
    backup.employee_reports.length +
    backup.edit_requests.length +
    (backup.settings ? 1 : 0);

  return {
    centres: backup.centres.length,
    students: backup.students.length,
    fee_recovery: backup.fee_recovery.length,
    practical_records: backup.practical_records.length,
    tma_records: backup.tma_records.length,
    online_class_records: backup.online_class_records.length,
    admission_records: backup.admission_records.length,
    excel_sheet_configs: backup.excel_sheet_configs.length,
    work_assignments: backup.work_assignments.length,
    work_assignment_tasks: backup.work_assignment_tasks.length,
    users: backup.users.length,
    staff_invites: backup.staff_invites.length,
    employee_reports: backup.employee_reports.length,
    edit_requests: backup.edit_requests.length,
    hasSettings: Boolean(backup.settings),
    totalDocuments,
  };
}

export function buildFullDatabaseBackupPayload(params: {
  exportedBy: string;
  centres: Centre[];
  students: Student[];
  feeRecords: FeeRecoveryRecord[];
  practicalRecords: PracticalRecord[];
  tmaRecords: TmaRecord[];
  onlineClassRecords: OnlineClassRecord[];
  admissionRecords: AdmissionRecord[];
  sheetConfigs: ExcelSheetConfig[];
  workAssignments: WorkAssignment[];
  workAssignmentTasks: WorkAssignmentTask[];
  users: UserAccount[];
  staffInvites?: StaffInvite[];
  employeeReports?: EmployeeReport[];
  editRequests?: EditRequest[];
  settings: SystemSettings | null;
}): FullDatabaseBackupPayload {
  return {
    version: 3,
    exportedAt: new Date().toISOString(),
    exportedBy: params.exportedBy,
    centres: params.centres.map((c) => serializeValueForExport(c) as Record<string, unknown>),
    students: params.students.map((s) => serializeValueForExport(s) as Record<string, unknown>),
    fee_recovery: params.feeRecords.map((f) => serializeValueForExport(f) as Record<string, unknown>),
    practical_records: params.practicalRecords.map((p) => serializeValueForExport(p) as Record<string, unknown>),
    tma_records: params.tmaRecords.map((t) => serializeValueForExport(t) as Record<string, unknown>),
    online_class_records: params.onlineClassRecords.map((o) => serializeValueForExport(o) as Record<string, unknown>),
    admission_records: params.admissionRecords.map((a) => serializeValueForExport(a) as Record<string, unknown>),
    excel_sheet_configs: params.sheetConfigs.map(
      (cfg) => serializeValueForExport(cfg) as Record<string, unknown>,
    ),
    work_assignments: params.workAssignments.map((w) => serializeValueForExport(w) as Record<string, unknown>),
    work_assignment_tasks: params.workAssignmentTasks.map((t) => serializeValueForExport(t) as Record<string, unknown>),
    users: params.users.map((u) => serializeValueForExport(u) as Record<string, unknown>),
    staff_invites: (params.staffInvites || []).map((inv) => serializeValueForExport(inv) as Record<string, unknown>),
    employee_reports: (params.employeeReports || []).map((rep) => serializeValueForExport(rep) as Record<string, unknown>),
    edit_requests: (params.editRequests || []).map((req) => serializeValueForExport(req) as Record<string, unknown>),
    settings: params.settings ? (serializeValueForExport(params.settings) as Record<string, unknown>) : null,
  };
}

export function extractRestorableStaffProfiles(
  usersRaw: Record<string, unknown>[],
  invitesRaw: Record<string, unknown>[] = [],
): RestorableStaffProfile[] {
  const seenEmails = new Set<string>();
  const list: RestorableStaffProfile[] = [];

  const ingest = (raw: Record<string, unknown>, isInvite: boolean) => {
    const roleRaw = String(raw.role || '').trim();
    if (roleRaw !== 'centre_head' && roleRaw !== 'employee') return;
    const email = cleanStr(raw.email, 160).toLowerCase();
    if (!email || !email.includes('@') || seenEmails.has(email)) return;
    seenEmails.add(email);
    const centreId = resolveCentreId(raw.centreId);
    const deptRaw = String(raw.department || '').trim();
    const department: UserDepartment =
      roleRaw === 'centre_head'
        ? 'all'
        : VALID_DEPARTMENTS.has(deptRaw) && deptRaw !== 'all'
          ? (deptRaw as UserDepartment)
          : 'fee_recovery';
    const rawUid = !isInvite ? sanitizeFirestoreDocId(String(raw.uid || raw._docId || ''), 128) : '';

    list.push({
      legacyUid: rawUid || undefined,
      fullName: cleanMinStr(raw.fullName, 2, 100, email.split('@')[0] || 'Staff Member'),
      email,
      mobileNumber: cleanStr(raw.mobileNumber, 20),
      role: roleRaw,
      centreId,
      centreName: CENTRE_MAP[centreId].name,
      department,
      joiningDate: cleanMinStr(raw.joiningDate, 4, 30, new Date().toISOString().slice(0, 10)),
      status: raw.status === 'Inactive' ? 'Inactive' : 'Active',
    });
  };

  for (const raw of usersRaw) ingest(raw, false);
  for (const raw of invitesRaw) ingest(raw, true);
  return list;
}

export function parseBackupJson(rawText: string): ParseBackupResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return { ok: false, error: 'Invalid JSON file. Please upload a valid .json database backup file.' };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'Backup JSON root must be an object containing collection arrays.' };
  }

  const obj = parsed as Record<string, unknown>;
  const nestedCollections =
    obj.collections && typeof obj.collections === 'object' && !Array.isArray(obj.collections)
      ? (obj.collections as Record<string, unknown>)
      : obj;

  const pick = (...keys: string[]): Record<string, unknown>[] => {
    for (const k of keys) {
      if (nestedCollections[k] !== undefined) {
        return normalizeCollectionArray(nestedCollections[k]);
      }
      if (obj[k] !== undefined) {
        return normalizeCollectionArray(obj[k]);
      }
    }
    return [];
  };

  const centres = pick('centres');
  const students = pick('students');
  const fee_recovery = pick('fee_recovery', 'feeRecovery', 'feeRecords');
  const practical_records = pick('practical_records', 'practicalRecords');
  const tma_records = pick('tma_records', 'tmaRecords');
  const online_class_records = pick('online_class_records', 'onlineClassRecords');
  const admission_records = pick('admission_records', 'admissionRecords');
  const excel_sheet_configs = pick('excel_sheet_configs', 'excelSheetConfigs', 'sheetConfigs');
  const work_assignments = pick('work_assignments', 'workAssignments');
  const work_assignment_tasks = pick('work_assignment_tasks', 'workAssignmentTasks');
  const users = pick('users');
  const staff_invites = pick('staff_invites', 'staffInvites');
  const employee_reports = pick('employee_reports', 'employeeReports');
  const edit_requests = pick('edit_requests', 'editRequests');
  const settingsRaw = nestedCollections.system_settings ?? obj.settings ?? obj.systemSettings ?? null;
  let settings: Record<string, unknown> | null = null;
  if (settingsRaw && typeof settingsRaw === 'object' && !Array.isArray(settingsRaw)) {
    const sObj = settingsRaw as Record<string, unknown>;
    settings =
      sObj.global && typeof sObj.global === 'object' && !Array.isArray(sObj.global)
        ? (sObj.global as Record<string, unknown>)
        : sObj;
  }

  const backup: FullDatabaseBackupPayload = {
    version: 3,
    exportedAt: cleanStr(obj.exportedAt, 40, new Date().toISOString()),
    exportedBy: cleanStr(obj.exportedBy, 160, 'unknown'),
    centres,
    students,
    fee_recovery,
    practical_records,
    tma_records,
    online_class_records,
    admission_records,
    excel_sheet_configs,
    work_assignments,
    work_assignment_tasks,
    users,
    staff_invites,
    employee_reports,
    edit_requests,
    settings,
  };

  const summary = computeBackupSummary(backup);

  if (summary.totalDocuments === 0) {
    return {
      ok: false,
      error: 'No recognizable database collections (students, employees, centres, fee_recovery, etc.) found inside this JSON file.',
    };
  }

  return {
    ok: true,
    backup,
    summary,
    staffProfiles: extractRestorableStaffProfiles(users, staff_invites),
  };
}

function sanitizeStringRecordMap(raw: unknown, maxEntries: number, maxKeyLen = 80, maxValLen = 500): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const entries = Object.entries(raw as Record<string, unknown>).slice(0, maxEntries);
  const out: Record<string, string> = {};
  for (const [k, v] of entries) {
    const key = String(k).trim().slice(0, maxKeyLen);
    if (!key) continue;
    out[key] = v == null ? '' : String(v).slice(0, maxValLen);
  }
  return out;
}

export function sanitizeCentreForRestore(raw: Record<string, unknown>, actorUid: string): { id: CentreId; data: Record<string, unknown> } {
  const id = resolveCentreId(raw.id || raw._docId);
  const canonical = CENTRE_MAP[id];
  return {
    id,
    data: {
      id,
      name: cleanMinStr(raw.name, 3, 120, canonical.name),
      city: cleanMinStr(raw.city, 2, 60, canonical.city),
      code: cleanMinStr(raw.code, 2, 20, canonical.code),
      address: cleanStr(raw.address, 250, canonical.address),
      latitude: cleanNum(raw.latitude, -90, 90, canonical.latitude),
      longitude: cleanNum(raw.longitude, -180, 180, canonical.longitude),
      geofenceRadiusMeters: cleanNum(raw.geofenceRadiusMeters, 20, 10000, canonical.geofenceRadiusMeters),
      headUid: cleanStr(raw.headUid, 128),
      headName: cleanStr(raw.headName, 100, 'Unassigned'),
      status: raw.status === 'Inactive' ? 'Inactive' : 'Active',
      updatedBy: cleanMinStr(actorUid, 1, 128, 'system'),
    },
  };
}

export function sanitizeStudentForRestore(
  raw: Record<string, unknown>,
  actorUid: string,
  fallbackSerial: number,
): { id: string; data: Record<string, unknown> } {
  const id = resolveValidDocId(raw.studentId || raw._docId, 'STU').slice(0, 64);
  const centreId = resolveCentreId(raw.centreId);
  const today = new Date().toISOString().slice(0, 10);
  const mobile = cleanMinStr(raw.mobileNumber, 7, 20, '0000000000');

  const data: Record<string, unknown> = {
    serialNumber: Math.max(1, Math.round(cleanNum(raw.serialNumber, 1, 1000000, fallbackSerial))),
    studentId: id,
    studentName: cleanMinStr(raw.studentName, 2, 120, 'Student'),
    mobileNumber: mobile,
    subject: cleanStr(raw.subject, 200),
    tcStatus: VALID_TC.has(String(raw.tcStatus)) ? String(raw.tcStatus) : 'Not Received',
    bookStatus: VALID_BOOK.has(String(raw.bookStatus)) ? String(raw.bookStatus) : 'Pending',
    classAttendanceStatus: VALID_ATTENDANCE.has(String(raw.classAttendanceStatus))
      ? String(raw.classAttendanceStatus)
      : 'Regular',
    whyNios: cleanStr(raw.whyNios, 1000),
    currentEducationStatus: cleanStr(raw.currentEducationStatus, 1000),
    futurePlanning: cleanStr(raw.futurePlanning, 1000),
    tmaStatus: VALID_TMA.has(String(raw.tmaStatus)) ? String(raw.tmaStatus) : 'Pending',
    practicalStatus: VALID_PRACTICAL.has(String(raw.practicalStatus)) ? String(raw.practicalStatus) : 'Pending',
    examinationStatus: VALID_EXAM.has(String(raw.examinationStatus)) ? String(raw.examinationStatus) : 'Not Completed',
    centreId,
    centreName: cleanMinStr(raw.centreName, 2, 120, CENTRE_MAP[centreId].name),
    admissionDate: cleanMinStr(raw.admissionDate, 4, 30, today),
    assignedEmployeeUid: cleanStr(raw.assignedEmployeeUid, 128),
    assignedEmployeeName: cleanStr(raw.assignedEmployeeName, 100),
    additionalRemarks: cleanStr(raw.additionalRemarks, 1000),
    createdBy: cleanMinStr(raw.createdBy, 1, 128, actorUid),
    updatedBy: cleanMinStr(actorUid, 1, 128, 'system'),
  };

  if (typeof raw.employeeLocked === 'boolean') data.employeeLocked = raw.employeeLocked;
  if (typeof raw.tmaLocked === 'boolean') data.tmaLocked = raw.tmaLocked;
  if (typeof raw.practicalLocked === 'boolean') data.practicalLocked = raw.practicalLocked;
  if (typeof raw.onlineClassesLocked === 'boolean') data.onlineClassesLocked = raw.onlineClassesLocked;
  if (typeof raw.admissionLocked === 'boolean') data.admissionLocked = raw.admissionLocked;
  if (typeof raw.lockedByUid === 'string') data.lockedByUid = raw.lockedByUid.slice(0, 128);
  if (typeof raw.lockedByName === 'string') data.lockedByName = raw.lockedByName.slice(0, 100);
  if (typeof raw.superAdminAccessGranted === 'boolean') data.superAdminAccessGranted = raw.superAdminAccessGranted;
  if (raw.tmaFee !== undefined && Number.isFinite(Number(raw.tmaFee))) {
    data.tmaFee = cleanNum(raw.tmaFee, 0, 1000000, 0);
  }
  if (raw.examFee !== undefined && Number.isFinite(Number(raw.examFee))) {
    data.examFee = cleanNum(raw.examFee, 0, 1000000, 0);
  }
  const extraColumns = sanitizeStringRecordMap(raw.extraColumns, 35, 80, 500);
  if (extraColumns && Object.keys(extraColumns).length > 0) data.extraColumns = extraColumns;
  if (typeof raw.rowColor === 'string' && raw.rowColor.trim()) {
    data.rowColor = raw.rowColor.trim().slice(0, 20);
  }
  const cellColors = sanitizeStringRecordMap(raw.cellColors, 45, 80, 20);
  if (cellColors && Object.keys(cellColors).length > 0) data.cellColors = cellColors;

  return { id, data };
}

export function sanitizeFeeRecoveryForRestore(
  raw: Record<string, unknown>,
  actorUid: string,
): { id: string; data: Record<string, unknown> } {
  const id = resolveValidDocId(raw.studentId || raw._docId, 'STU').slice(0, 64);
  const centreId = resolveCentreId(raw.centreId);
  const totalFee = cleanNum(raw.totalFee, 0, 10000000, 0);
  const paidAmount = cleanNum(raw.paidAmount, 0, 10000000, 0);
  const pendingAmount = cleanNum(raw.pendingAmount, 0, 10000000, Math.max(0, totalFee - paidAmount));

  const data: Record<string, unknown> = {
    studentId: id,
    studentName: cleanMinStr(raw.studentName, 2, 120, 'Student'),
    mobileNumber: cleanMinStr(raw.mobileNumber, 7, 20, '0000000000'),
    centreId,
    recoveryStatus: VALID_RECOVERY.has(String(raw.recoveryStatus)) ? String(raw.recoveryStatus) : 'Pending',
    followUpStatus: VALID_FEE_FOLLOWUP.has(String(raw.followUpStatus)) ? String(raw.followUpStatus) : 'Scheduled',
    totalFee,
    paidAmount,
    pendingAmount,
    assignedEmployeeUid: cleanStr(raw.assignedEmployeeUid, 128),
    assignedEmployeeName: cleanStr(raw.assignedEmployeeName, 100),
    followUpNotes: cleanStr(raw.followUpNotes, 1000),
    lastContactDate: cleanStr(raw.lastContactDate, 30),
    nextFollowUpDate: cleanStr(raw.nextFollowUpDate, 30),
    createdBy: cleanMinStr(raw.createdBy, 1, 128, actorUid),
    updatedBy: cleanMinStr(actorUid, 1, 128, 'system'),
  };

  if (raw.tmaFee !== undefined && Number.isFinite(Number(raw.tmaFee))) data.tmaFee = cleanNum(raw.tmaFee, 0, 1000000, 0);
  if (raw.examFee !== undefined && Number.isFinite(Number(raw.examFee))) data.examFee = cleanNum(raw.examFee, 0, 1000000, 0);
  if (typeof raw.employeeLocked === 'boolean') data.employeeLocked = raw.employeeLocked;
  if (typeof raw.lockedByUid === 'string') data.lockedByUid = raw.lockedByUid.slice(0, 128);
  if (typeof raw.lockedByName === 'string') data.lockedByName = raw.lockedByName.slice(0, 100);

  return { id, data };
}

export function sanitizePracticalForRestore(
  raw: Record<string, unknown>,
  actorUid: string,
): { id: string; data: Record<string, unknown> } {
  const id = resolveValidDocId(raw.studentId || raw._docId, 'STU').slice(0, 64);
  const centreId = resolveCentreId(raw.centreId);
  const data: Record<string, unknown> = {
    studentId: id,
    studentName: cleanMinStr(raw.studentName, 2, 120, 'Student'),
    centreId,
    practicalStatus: VALID_PRACTICAL.has(String(raw.practicalStatus)) ? String(raw.practicalStatus) : 'Pending',
    submissionStatus: VALID_SUBMISSION.has(String(raw.submissionStatus)) ? String(raw.submissionStatus) : 'Not Submitted',
    completionPercentage: cleanNum(raw.completionPercentage, 0, 100, 0),
    assignedEmployeeUid: cleanStr(raw.assignedEmployeeUid, 128),
    assignedEmployeeName: cleanStr(raw.assignedEmployeeName, 100),
    remarks: cleanStr(raw.remarks, 1000),
    createdBy: cleanMinStr(raw.createdBy, 1, 128, actorUid),
    updatedBy: cleanMinStr(actorUid, 1, 128, 'system'),
  };
  if (typeof raw.employeeLocked === 'boolean') data.employeeLocked = raw.employeeLocked;
  if (typeof raw.lockedByUid === 'string') data.lockedByUid = raw.lockedByUid.slice(0, 128);
  if (typeof raw.lockedByName === 'string') data.lockedByName = raw.lockedByName.slice(0, 100);
  return { id, data };
}

export function sanitizeTmaForRestore(
  raw: Record<string, unknown>,
  actorUid: string,
): { id: string; data: Record<string, unknown> } {
  const id = resolveValidDocId(raw.studentId || raw._docId, 'STU').slice(0, 64);
  const centreId = resolveCentreId(raw.centreId);
  const data: Record<string, unknown> = {
    studentId: id,
    studentName: cleanMinStr(raw.studentName, 2, 120, 'Student'),
    centreId,
    tmaStatus: VALID_TMA.has(String(raw.tmaStatus)) ? String(raw.tmaStatus) : 'Pending',
    subjectsSubmittedCount: cleanNum(raw.subjectsSubmittedCount, 0, 20, 0),
    totalSubjectsCount: cleanNum(raw.totalSubjectsCount, 0, 20, 0),
    submissionDate: cleanStr(raw.submissionDate, 30),
    assignedEmployeeUid: cleanStr(raw.assignedEmployeeUid, 128),
    assignedEmployeeName: cleanStr(raw.assignedEmployeeName, 100),
    remarks: cleanStr(raw.remarks, 1000),
    createdBy: cleanMinStr(raw.createdBy, 1, 128, actorUid),
    updatedBy: cleanMinStr(actorUid, 1, 128, 'system'),
  };
  if (typeof raw.employeeLocked === 'boolean') data.employeeLocked = raw.employeeLocked;
  if (typeof raw.lockedByUid === 'string') data.lockedByUid = raw.lockedByUid.slice(0, 128);
  if (typeof raw.lockedByName === 'string') data.lockedByName = raw.lockedByName.slice(0, 100);
  return { id, data };
}

export function sanitizeOnlineClassForRestore(
  raw: Record<string, unknown>,
  actorUid: string,
): { id: string; data: Record<string, unknown> } {
  const id = resolveValidDocId(raw.studentId || raw._docId, 'STU').slice(0, 64);
  const centreId = resolveCentreId(raw.centreId);
  const data: Record<string, unknown> = {
    studentId: id,
    studentName: cleanMinStr(raw.studentName, 2, 120, 'Student'),
    centreId,
    attendanceStatus: VALID_ATTENDANCE.has(String(raw.attendanceStatus)) ? String(raw.attendanceStatus) : 'Regular',
    participationLevel: VALID_PARTICIPATION.has(String(raw.participationLevel)) ? String(raw.participationLevel) : 'Moderate',
    attendancePercentage: cleanNum(raw.attendancePercentage, 0, 100, 0),
    lastAttendanceUpdate: cleanStr(raw.lastAttendanceUpdate, 30),
    followUpNotes: cleanStr(raw.followUpNotes, 1000),
    assignedEmployeeUid: cleanStr(raw.assignedEmployeeUid, 128),
    assignedEmployeeName: cleanStr(raw.assignedEmployeeName, 100),
    createdBy: cleanMinStr(raw.createdBy, 1, 128, actorUid),
    updatedBy: cleanMinStr(actorUid, 1, 128, 'system'),
  };
  if (typeof raw.employeeLocked === 'boolean') data.employeeLocked = raw.employeeLocked;
  if (typeof raw.lockedByUid === 'string') data.lockedByUid = raw.lockedByUid.slice(0, 128);
  if (typeof raw.lockedByName === 'string') data.lockedByName = raw.lockedByName.slice(0, 100);
  return { id, data };
}

export function sanitizeAdmissionForRestore(
  raw: Record<string, unknown>,
  actorUid: string,
): { id: string; data: Record<string, unknown> } {
  const id = resolveValidDocId(raw.studentId || raw._docId, 'STU').slice(0, 64);
  const centreId = resolveCentreId(raw.centreId);
  const today = new Date().toISOString().slice(0, 10);
  const data: Record<string, unknown> = {
    studentId: id,
    studentName: cleanMinStr(raw.studentName, 2, 120, 'Student'),
    centreId,
    admissionStatus: VALID_ADMISSION.has(String(raw.admissionStatus)) ? String(raw.admissionStatus) : 'Confirmed',
    stream: cleanStr(raw.stream, 80, 'Stream 1'),
    niosPurpose: cleanStr(raw.niosPurpose, 1000),
    academicBackground: cleanStr(raw.academicBackground, 1000),
    followUpStatus: VALID_ADMISSION_FOLLOWUP.has(String(raw.followUpStatus))
      ? String(raw.followUpStatus)
      : 'Completed',
    assignedEmployeeUid: cleanStr(raw.assignedEmployeeUid, 128),
    assignedEmployeeName: cleanStr(raw.assignedEmployeeName, 100),
    remarks: cleanStr(raw.remarks, 1000),
    admissionDate: cleanMinStr(raw.admissionDate, 4, 30, today),
    createdBy: cleanMinStr(raw.createdBy, 1, 128, actorUid),
    updatedBy: cleanMinStr(actorUid, 1, 128, 'system'),
  };
  if (typeof raw.employeeLocked === 'boolean') data.employeeLocked = raw.employeeLocked;
  if (typeof raw.lockedByUid === 'string') data.lockedByUid = raw.lockedByUid.slice(0, 128);
  if (typeof raw.lockedByName === 'string') data.lockedByName = raw.lockedByName.slice(0, 100);
  return { id, data };
}

export function sanitizeExcelSheetConfigForRestore(
  raw: Record<string, unknown>,
  actorUid: string,
): { id: string; data: Record<string, unknown> } {
  const id = resolveValidDocId(raw.configId || raw._docId, 'global');
  const toStringList = (val: unknown, max: number): string[] =>
    Array.isArray(val) ? val.map((v) => String(v || '').trim()).filter(Boolean).slice(0, max) : [];
  return {
    id,
    data: {
      configId: id,
      headerLabels: sanitizeStringRecordMap(raw.headerLabels, 50, 80, 120) || {},
      customColumns: toStringList(raw.customColumns, 35),
      hiddenCoreColumns: toStringList(raw.hiddenCoreColumns, 20),
      deletedExtraColumns: toStringList(raw.deletedExtraColumns, 60),
      updatedBy: cleanMinStr(actorUid, 1, 128, 'system'),
    },
  };
}

export function sanitizeWorkAssignmentForRestore(
  raw: Record<string, unknown>,
  actorUid: string,
  actorName: string,
): { id: string; data: Record<string, unknown> } {
  const id = resolveValidDocId(raw.assignmentId || raw._docId, 'wa');
  const centreId = resolveCentreId(raw.centreId);
  const fromSerial = Math.max(1, Math.round(cleanNum(raw.fromSerial, 1, 100000, 1)));
  const toSerial = Math.max(fromSerial, Math.round(cleanNum(raw.toSerial, fromSerial, 100000, fromSerial)));
  return {
    id,
    data: {
      assignmentId: id,
      centreId,
      centreName: cleanMinStr(raw.centreName, 2, 120, CENTRE_MAP[centreId].name),
      department: VALID_WORK_DEPT.has(String(raw.department)) ? String(raw.department) : 'fee_recovery',
      staffUid: resolveValidDocId(raw.staffUid, 'staff'),
      staffName: cleanMinStr(raw.staffName, 1, 100, 'Staff Member'),
      staffEmail: cleanMinStr(raw.staffEmail, 3, 160, 'staff@visionpoint.edu'),
      assignedByUid: cleanMinStr(actorUid, 1, 128, 'system'),
      assignedByName: cleanMinStr(raw.assignedByName, 1, 100, actorName || 'Super Admin'),
      assignedDate: cleanMinStr(raw.assignedDate, 4, 30, new Date().toISOString().slice(0, 10)),
      fromSerial,
      toSerial,
      totalStudents: Math.max(1, Math.round(cleanNum(raw.totalStudents, 1, 2000, 1))),
      status: VALID_WORK_STATUS.has(String(raw.status)) ? String(raw.status) : 'Active',
      note: cleanStr(raw.note, 500),
    },
  };
}

export function sanitizeWorkAssignmentTaskForRestore(
  raw: Record<string, unknown>,
  actorUid: string,
): { id: string; data: Record<string, unknown> } {
  const id = resolveValidDocId(raw.taskId || raw._docId, 'wt');
  const centreId = resolveCentreId(raw.centreId);
  return {
    id,
    data: {
      taskId: id,
      assignmentId: resolveValidDocId(raw.assignmentId, 'wa'),
      centreId,
      department: VALID_WORK_DEPT.has(String(raw.department)) ? String(raw.department) : 'fee_recovery',
      staffUid: resolveValidDocId(raw.staffUid, 'staff'),
      staffName: cleanMinStr(raw.staffName, 1, 100, 'Staff Member'),
      studentId: resolveValidDocId(raw.studentId, 'STU').slice(0, 64),
      serialNumber: Math.max(1, Math.round(cleanNum(raw.serialNumber, 1, 100000, 1))),
      studentName: cleanMinStr(raw.studentName, 1, 120, 'Student'),
      fatherName: cleanStr(raw.fatherName, 120),
      mobileNumber: cleanStr(raw.mobileNumber, 20),
      callingNumber: cleanStr(raw.callingNumber, 20),
      subject: cleanStr(raw.subject, 200),
      pendingFee: cleanNum(raw.pendingFee, 0, 1000000, 0),
      totalFee: cleanNum(raw.totalFee, 0, 1000000, 0),
      callStatus: VALID_CALL_STATUS.has(String(raw.callStatus)) ? String(raw.callStatus) : 'Pending',
      followUpDate: cleanStr(raw.followUpDate, 30),
      followUpTime: cleanStr(raw.followUpTime, 10),
      remark: cleanStr(raw.remark, 1000),
      lastCalledAt: cleanStr(raw.lastCalledAt, 40),
      updatedBy: cleanMinStr(actorUid, 1, 128, 'system'),
    },
  };
}

export function sanitizeUserForRestore(
  raw: Record<string, unknown>,
  actorUid: string,
): { id: string; data: Record<string, unknown> } | null {
  const email = cleanStr(raw.email, 160).toLowerCase();
  if (!email || !email.includes('@') || email.length < 5) return null;
  const roleRaw = String(raw.role || '').trim();
  const role: UserRole =
    roleRaw === 'super_admin' || roleRaw === 'centre_head' || roleRaw === 'employee'
      ? roleRaw
      : 'employee';
  const centreId = resolveCentreId(raw.centreId);
  const deptRaw = String(raw.department || '').trim();
  const department: UserDepartment =
    role === 'super_admin' || role === 'centre_head'
      ? 'all'
      : VALID_DEPARTMENTS.has(deptRaw) && deptRaw !== 'all'
        ? (deptRaw as UserDepartment)
        : 'fee_recovery';

  const id = resolveValidDocId(raw.uid || raw._docId, 'staff');
  const today = new Date().toISOString().slice(0, 10);

  return {
    id,
    data: {
      uid: id,
      fullName: cleanMinStr(raw.fullName, 2, 100, email.split('@')[0] || 'Staff Member'),
      email,
      mobileNumber: cleanStr(raw.mobileNumber, 20),
      role,
      centreId,
      centreName: cleanMinStr(raw.centreName, 2, 120, CENTRE_MAP[centreId].name),
      department,
      status: raw.status === 'Inactive' ? 'Inactive' : 'Active',
      joiningDate: cleanMinStr(raw.joiningDate, 4, 30, today),
      createdBy: cleanMinStr(raw.createdBy, 1, 128, actorUid),
      updatedBy: cleanMinStr(actorUid, 1, 128, 'system'),
    },
  };
}

export function sanitizeStaffInviteForRestore(
  raw: Record<string, unknown>,
  actorUid: string,
  actorName: string,
): { id: string; data: Record<string, unknown> } | null {
  const email = cleanStr(raw.email, 160).toLowerCase();
  if (!email || !email.includes('@') || email.length < 5) return null;
  const roleRaw = String(raw.role || '').trim();
  if (roleRaw !== 'centre_head' && roleRaw !== 'employee') return null;

  const centreId = resolveCentreId(raw.centreId);
  const deptRaw = String(raw.department || '').trim();
  const department: UserDepartment =
    roleRaw === 'centre_head'
      ? 'all'
      : VALID_DEPARTMENTS.has(deptRaw) && deptRaw !== 'all'
        ? (deptRaw as UserDepartment)
        : 'fee_recovery';

  const id = resolveValidDocId(raw.inviteId || raw._docId, 'inv');
  const today = new Date().toISOString().slice(0, 10);

  // firestore.rules requires status == 'Pending' and claimedUid == '' on create
  return {
    id,
    data: {
      inviteId: id,
      fullName: cleanMinStr(raw.fullName, 2, 100, email.split('@')[0] || 'Staff Member'),
      email,
      mobileNumber: cleanStr(raw.mobileNumber, 20),
      role: roleRaw,
      centreId,
      centreName: cleanMinStr(raw.centreName, 2, 120, CENTRE_MAP[centreId].name),
      department,
      joiningDate: cleanMinStr(raw.joiningDate, 4, 30, today),
      status: 'Pending',
      claimedUid: '',
      invitedBy: cleanMinStr(actorUid, 1, 128, 'system'),
      invitedByName: cleanMinStr(raw.invitedByName, 1, 100, actorName || 'Super Admin'),
    },
  };
}

export function sanitizeEmployeeReportForRestore(
  raw: Record<string, unknown>,
  actorUid: string,
): { id: string; data: Record<string, unknown> } {
  const id = resolveValidDocId(raw.reportId || raw._docId, 'rep');
  const centreId = resolveCentreId(raw.centreId);
  const roleRaw = String(raw.role || '').trim();
  const role: UserRole =
    roleRaw === 'super_admin' || roleRaw === 'centre_head' || roleRaw === 'employee'
      ? roleRaw
      : 'employee';
  const deptRaw = String(raw.department || '').trim();
  const department: UserDepartment = VALID_DEPARTMENTS.has(deptRaw) ? (deptRaw as UserDepartment) : 'all';
  const today = new Date().toISOString().slice(0, 10);

  // firestore.rules requires employeeUid == request.auth.uid and status == 'Submitted' on create
  return {
    id,
    data: {
      reportId: id,
      employeeUid: cleanMinStr(actorUid, 1, 128, 'system'),
      employeeName: cleanMinStr(raw.employeeName, 2, 100, 'Staff Member'),
      employeeEmail: cleanMinStr(raw.employeeEmail, 5, 160, 'staff@visionpoint.edu'),
      role,
      centreId,
      centreName: cleanMinStr(raw.centreName, 2, 120, CENTRE_MAP[centreId].name),
      department,
      reportDate: cleanMinStr(raw.reportDate, 4, 30, today),
      title: cleanMinStr(raw.title, 3, 160, 'Daily Work Report'),
      summary: cleanMinStr(raw.summary, 5, 2000, 'Restored report summary'),
      tasksCompleted: Math.round(cleanNum(raw.tasksCompleted, 0, 10000, 0)),
      studentsHandled: Math.round(cleanNum(raw.studentsHandled, 0, 10000, 0)),
      pendingIssues: cleanStr(raw.pendingIssues, 1000),
      status: 'Submitted',
      reviewerName: cleanStr(raw.reviewerName, 100),
      reviewerNote: cleanStr(raw.reviewerNote, 1000),
    },
  };
}

function appendSheetWithWidths(
  wb: XLSX.WorkBook,
  sheetName: string,
  rows: Record<string, unknown>[],
): void {
  const safeName = sheetName.replace(/[\\/?*[\]:]/g, '').slice(0, 31) || 'Sheet';
  const safeRows = rows.length > 0 ? rows : [{ Info: 'No records' }];
  const ws = XLSX.utils.json_to_sheet(safeRows);
  const headers = Object.keys(safeRows[0] || {});
  ws['!cols'] = headers.map((header) => {
    let maxLen = header.length;
    for (let i = 0; i < Math.min(safeRows.length, 250); i += 1) {
      const val = safeRows[i][header];
      const len = val == null ? 0 : String(val).length;
      if (len > maxLen) maxLen = len;
    }
    return { wch: Math.min(48, Math.max(12, maxLen + 3)) };
  });
  XLSX.utils.book_append_sheet(wb, ws, safeName);
}

/**
 * Exports the entire institution (Employee Management + All Students with dynamic Excel columns +
 * all 5 Departments + Calling Work + Daily Reports + Centres) as a clean multi-sheet .xlsx workbook.
 */
export function exportFullInstitutionalWorkbookXlsx(
  backup: FullDatabaseBackupPayload,
  fileName?: string,
): void {
  const wb = XLSX.utils.book_new();

  // 1. Employee Management (Active/Inactive Accounts + Pending Invites)
  const employeeRows: Record<string, unknown>[] = [];
  for (const u of backup.users) {
    const role = String(u.role || 'employee') as UserRole;
    const dept = String(u.department || 'all') as UserDepartment;
    employeeRows.push({
      'Record Type': 'Staff Account',
      UID: u.uid ?? '',
      'Full Name': u.fullName ?? '',
      Email: u.email ?? '',
      'Mobile Number': u.mobileNumber ?? '',
      Role: ROLE_LABELS[role] || role,
      Branch: u.centreName ?? u.centreId ?? '',
      Department: DEPARTMENT_LABELS[dept] || dept,
      Status: u.status ?? 'Active',
      'Joining Date': u.joiningDate ?? '',
    });
  }
  for (const inv of backup.staff_invites) {
    const role = String(inv.role || 'employee') as UserRole;
    const dept = String(inv.department || 'all') as UserDepartment;
    employeeRows.push({
      'Record Type': 'Pending Staff Invite',
      UID: inv.inviteId ?? '',
      'Full Name': inv.fullName ?? '',
      Email: inv.email ?? '',
      'Mobile Number': inv.mobileNumber ?? '',
      Role: ROLE_LABELS[role] || role,
      Branch: inv.centreName ?? inv.centreId ?? '',
      Department: DEPARTMENT_LABELS[dept] || dept,
      Status: inv.status ?? 'Pending',
      'Joining Date': inv.joiningDate ?? '',
    });
  }
  appendSheetWithWidths(wb, 'Employee Management', employeeRows);

  // 2. All Students (with ALL dynamic Excel extraColumns!)
  const extraColumnKeys = new Set<string>();
  for (const cfg of backup.excel_sheet_configs) {
    if (Array.isArray(cfg.customColumns)) {
      for (const col of cfg.customColumns) {
        const key = String(col || '').trim();
        if (key) extraColumnKeys.add(key);
      }
    }
  }
  for (const s of backup.students) {
    if (s.extraColumns && typeof s.extraColumns === 'object' && !Array.isArray(s.extraColumns)) {
      for (const key of Object.keys(s.extraColumns as Record<string, unknown>)) {
        if (key.trim()) extraColumnKeys.add(key.trim());
      }
    }
  }
  const orderedExtraCols = Array.from(extraColumnKeys);

  const sortedStudents = [...backup.students].sort(
    (a, b) => Number(a.serialNumber || 0) - Number(b.serialNumber || 0),
  );
  const studentRows = sortedStudents.map((s) => {
    const extras =
      s.extraColumns && typeof s.extraColumns === 'object' && !Array.isArray(s.extraColumns)
        ? (s.extraColumns as Record<string, unknown>)
        : {};
    const row: Record<string, unknown> = {
      'S.No': s.serialNumber ?? '',
      'Student ID': s.studentId ?? '',
      'Student Name': s.studentName ?? '',
      'Mobile Number': s.mobileNumber ?? '',
      Branch: s.centreName ?? s.centreId ?? '',
      Subject: s.subject ?? '',
      'Admission Date': s.admissionDate ?? '',
      'TC Status': s.tcStatus ?? '',
      'Book Status': s.bookStatus ?? '',
      'Online Attendance': s.classAttendanceStatus ?? '',
      'TMA Status': s.tmaStatus ?? '',
      'Practical Status': s.practicalStatus ?? '',
      'Exam Status': s.examinationStatus ?? '',
      'TMA Fee': s.tmaFee ?? '',
      'Exam Fee': s.examFee ?? '',
      'Why NIOS': s.whyNios ?? '',
      'Current Education': s.currentEducationStatus ?? '',
      'Future Planning': s.futurePlanning ?? '',
      'Assigned Staff': s.assignedEmployeeName ?? '',
      Remarks: s.additionalRemarks ?? '',
    };
    for (const col of orderedExtraCols) {
      row[col] = extras[col] ?? '';
    }
    if (s.rowColor) row['Row Color'] = s.rowColor;
    return row;
  });
  appendSheetWithWidths(wb, 'All Students (Excel)', studentRows);

  // 3. Fee Recovery
  const feeRows = backup.fee_recovery.map((f) => ({
    'Student ID': f.studentId ?? '',
    'Student Name': f.studentName ?? '',
    'Mobile Number': f.mobileNumber ?? '',
    Branch: CENTRE_MAP[resolveCentreId(f.centreId)]?.name ?? f.centreId ?? '',
    'Total Fee': f.totalFee ?? 0,
    'Paid Amount': f.paidAmount ?? 0,
    'Pending Amount': f.pendingAmount ?? 0,
    'TMA Fee': f.tmaFee ?? 0,
    'Exam Fee': f.examFee ?? 0,
    'Recovery Status': f.recoveryStatus ?? '',
    'Follow-Up Status': f.followUpStatus ?? '',
    'Last Contact': f.lastContactDate ?? '',
    'Next Follow-Up': f.nextFollowUpDate ?? '',
    'Follow-Up Notes': f.followUpNotes ?? '',
    'Assigned Staff': f.assignedEmployeeName ?? '',
  }));
  appendSheetWithWidths(wb, 'Fee Recovery', feeRows);

  // 4. Practical
  const practicalRows = backup.practical_records.map((p) => ({
    'Student ID': p.studentId ?? '',
    'Student Name': p.studentName ?? '',
    Branch: CENTRE_MAP[resolveCentreId(p.centreId)]?.name ?? p.centreId ?? '',
    'Practical Status': p.practicalStatus ?? '',
    'Submission Status': p.submissionStatus ?? '',
    'Completion %': p.completionPercentage ?? 0,
    'Assigned Staff': p.assignedEmployeeName ?? '',
    Remarks: p.remarks ?? '',
  }));
  appendSheetWithWidths(wb, 'Practical', practicalRows);

  // 5. TMA
  const tmaRows = backup.tma_records.map((t) => ({
    'Student ID': t.studentId ?? '',
    'Student Name': t.studentName ?? '',
    Branch: CENTRE_MAP[resolveCentreId(t.centreId)]?.name ?? t.centreId ?? '',
    'TMA Status': t.tmaStatus ?? '',
    'Subjects Submitted': t.subjectsSubmittedCount ?? 0,
    'Total Subjects': t.totalSubjectsCount ?? 0,
    'Submission Date': t.submissionDate ?? '',
    'Assigned Staff': t.assignedEmployeeName ?? '',
    Remarks: t.remarks ?? '',
  }));
  appendSheetWithWidths(wb, 'TMA', tmaRows);

  // 6. Online Classes
  const onlineRows = backup.online_class_records.map((o) => ({
    'Student ID': o.studentId ?? '',
    'Student Name': o.studentName ?? '',
    Branch: CENTRE_MAP[resolveCentreId(o.centreId)]?.name ?? o.centreId ?? '',
    'Attendance Status': o.attendanceStatus ?? '',
    'Participation Level': o.participationLevel ?? '',
    'Attendance %': o.attendancePercentage ?? 0,
    'Last Update': o.lastAttendanceUpdate ?? '',
    'Assigned Staff': o.assignedEmployeeName ?? '',
    'Follow-Up Notes': o.followUpNotes ?? '',
  }));
  appendSheetWithWidths(wb, 'Online Classes', onlineRows);

  // 7. Admission
  const admissionRows = backup.admission_records.map((a) => ({
    'Student ID': a.studentId ?? '',
    'Student Name': a.studentName ?? '',
    Branch: CENTRE_MAP[resolveCentreId(a.centreId)]?.name ?? a.centreId ?? '',
    'Admission Status': a.admissionStatus ?? '',
    Stream: a.stream ?? '',
    'NIOS Purpose': a.niosPurpose ?? '',
    'Academic Background': a.academicBackground ?? '',
    'Follow-Up Status': a.followUpStatus ?? '',
    'Admission Date': a.admissionDate ?? '',
    'Assigned Staff': a.assignedEmployeeName ?? '',
    Remarks: a.remarks ?? '',
  }));
  appendSheetWithWidths(wb, 'Admission', admissionRows);

  // 8. Calling Work & Tasks
  const taskRows = backup.work_assignment_tasks.map((t) => ({
    'Batch ID': t.assignmentId ?? '',
    Branch: CENTRE_MAP[resolveCentreId(t.centreId)]?.name ?? t.centreId ?? '',
    Department: t.department ?? '',
    'Assigned Staff': t.staffName ?? '',
    'S.No': t.serialNumber ?? '',
    'Student Name': t.studentName ?? '',
    'Father Name': t.fatherName ?? '',
    'Mobile Number': t.mobileNumber ?? '',
    'Calling Number': t.callingNumber ?? '',
    Subject: t.subject ?? '',
    'Pending Fee': t.pendingFee ?? 0,
    'Total Fee': t.totalFee ?? 0,
    'Call Status': t.callStatus ?? '',
    'Follow-Up Date': t.followUpDate ?? '',
    'Follow-Up Time': t.followUpTime ?? '',
    Remark: t.remark ?? '',
    'Last Called At': t.lastCalledAt ?? '',
  }));
  appendSheetWithWidths(wb, 'Calling Work & Tasks', taskRows);

  // 9. Employee Reports
  const reportRows = backup.employee_reports.map((r) => ({
    'Report Date': r.reportDate ?? '',
    'Employee Name': r.employeeName ?? '',
    Email: r.employeeEmail ?? '',
    Role: r.role ?? '',
    Branch: r.centreName ?? r.centreId ?? '',
    Department: r.department ?? '',
    Title: r.title ?? '',
    Summary: r.summary ?? '',
    'Tasks Completed': r.tasksCompleted ?? 0,
    'Students Handled': r.studentsHandled ?? 0,
    'Pending Issues': r.pendingIssues ?? '',
    Status: r.status ?? '',
    Reviewer: r.reviewerName ?? '',
    'Reviewer Note': r.reviewerNote ?? '',
  }));
  appendSheetWithWidths(wb, 'Employee Reports', reportRows);

  // 10. Centres
  const centreRows = backup.centres.map((c) => ({
    'Centre ID': c.id ?? '',
    Name: c.name ?? '',
    Code: c.code ?? '',
    City: c.city ?? '',
    Address: c.address ?? '',
    'Centre Head': c.headName ?? '',
    Latitude: c.latitude ?? '',
    Longitude: c.longitude ?? '',
    'Geofence Radius (m)': c.geofenceRadiusMeters ?? '',
    Status: c.status ?? '',
  }));
  appendSheetWithWidths(wb, 'Centres', centreRows);

  const outName =
    fileName || `shukra-complete-data-excel-${new Date().toISOString().slice(0, 10)}.xlsx`;
  XLSX.writeFile(wb, outName);
}
