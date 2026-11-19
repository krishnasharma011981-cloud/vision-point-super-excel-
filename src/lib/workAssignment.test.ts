import assert from 'node:assert/strict';
import test from 'node:test';
import type { Student, WorkAssignmentTask } from '../types/domain';
import {
  buildLatestTaskByStudentMap,
  buildQuickFollowUpPreset,
  buildTaskCallLink,
  buildTaskWhatsAppLink,
  canAssignDepartmentWork,
  canManageAssignmentForCentre,
  computeAssignmentProgress,
  extractStudentCallingNumber,
  extractStudentFatherName,
  formatFollowUpSchedule,
  formatStoredFollowUpDateTime,
  formatTime12Hour,
  mapCallStatusToFeeFollowUp,
  sanitizeFirestoreDocId,
  selectStudentsForAssignmentRange,
} from './workAssignment';

const makeStudent = (overrides: Partial<Student>): Student => ({
  serialNumber: 1,
  studentId: 'VP-2026-0001',
  studentName: 'Aarav Sharma',
  mobileNumber: '9876543210',
  subject: 'Hindi, English',
  tcStatus: 'Received',
  bookStatus: 'Received',
  classAttendanceStatus: 'Regular',
  whyNios: '',
  currentEducationStatus: '',
  futurePlanning: '',
  tmaStatus: 'Pending',
  practicalStatus: 'Pending',
  examinationStatus: 'Not Completed',
  centreId: 'vp_lookerganj',
  centreName: 'Vision Point Lookerganj, Prayagraj',
  admissionDate: '2026-01-10',
  assignedEmployeeUid: '',
  assignedEmployeeName: '',
  additionalRemarks: '',
  createdBy: 'admin',
  createdAt: '',
  updatedBy: 'admin',
  updatedAt: '',
  ...overrides,
});

test('canAssignDepartmentWork restricts work assignment strictly to Active Super Admin and Centre Head', () => {
  assert.equal(canAssignDepartmentWork({ role: 'super_admin', status: 'Active' }), true);
  assert.equal(canAssignDepartmentWork({ role: 'centre_head', status: 'Active' }), true);
  assert.equal(canAssignDepartmentWork({ role: 'employee', status: 'Active' }), false);
  assert.equal(canAssignDepartmentWork({ role: 'centre_head', status: 'Inactive' }), false);
  assert.equal(canAssignDepartmentWork(null), false);
});

test('canManageAssignmentForCentre isolates Centre Head to their own branch', () => {
  assert.equal(
    canManageAssignmentForCentre({ role: 'super_admin', status: 'Active', centreId: 'vp_lookerganj' }, 'xis_jaunpur'),
    true,
  );
  assert.equal(
    canManageAssignmentForCentre({ role: 'centre_head', status: 'Active', centreId: 'vp_lookerganj' }, 'vp_lookerganj'),
    true,
  );
  assert.equal(
    canManageAssignmentForCentre({ role: 'centre_head', status: 'Active', centreId: 'vp_lookerganj' }, 'vp_civillines'),
    false,
  );
  assert.equal(
    canManageAssignmentForCentre({ role: 'employee', status: 'Active', centreId: 'vp_lookerganj' }, 'vp_lookerganj'),
    false,
  );
});

test('extractStudentFatherName finds father name from Excel extraColumns and ignores father phone columns', () => {
  const s1 = makeStudent({
    extraColumns: {
      'FATHER MOBILE NO': '9999988888',
      'FATHERS NAME': 'Rajesh Kumar Sharma',
    },
  });
  assert.equal(extractStudentFatherName(s1), 'Rajesh Kumar Sharma');

  const s2 = makeStudent({
    extraColumns: {
      "Father's Name": 'Suresh Singh',
    },
  });
  assert.equal(extractStudentFatherName(s2), 'Suresh Singh');

  const s3 = makeStudent({
    extraColumns: {
      'FATHER PHONE': '9811122233',
      'COURSE': '12th',
    },
  });
  assert.equal(extractStudentFatherName(s3), '');
});

test('extractStudentCallingNumber falls back to CALLING NO extraColumn when primary mobile is blank', () => {
  const s1 = makeStudent({ mobileNumber: '9876543210', extraColumns: { 'CALLING NO': '9111122222' } });
  assert.equal(extractStudentCallingNumber(s1), '9876543210');

  const s2 = makeStudent({
    mobileNumber: 'Not Provided',
    extraColumns: { 'WHATSAPP NO': '9222233333', 'CALLING NO': '9111122222' },
  });
  assert.equal(extractStudentCallingNumber(s2), '9111122222');
});

test('selectStudentsForAssignmentRange selects inclusive 1-50 serial range sorted ascending', () => {
  const students = Array.from({ length: 65 }, (_, i) =>
    makeStudent({
      serialNumber: i + 1,
      studentId: `VP-2026-${String(i + 1).padStart(4, '0')}`,
      studentName: `Student ${i + 1}`,
    }),
  );
  const serialMap = new Map<string, number>();
  students.forEach((s, idx) => serialMap.set(s.studentId, idx + 1));

  const batch1To50 = selectStudentsForAssignmentRange(students, serialMap, 1, 50);
  assert.equal(batch1To50.length, 50);
  assert.equal(batch1To50[0].displaySerial, 1);
  assert.equal(batch1To50[49].displaySerial, 50);

  const batch51To60 = selectStudentsForAssignmentRange(students, serialMap, 51, 60);
  assert.equal(batch51To60.length, 10);
  assert.equal(batch51To60[0].displaySerial, 51);
  assert.equal(batch51To60[9].displaySerial, 60);
});

test('buildQuickFollowUpPreset and formatFollowUpSchedule handle "Kal 4:00 PM" accurately', () => {
  const fixedNow = new Date(2026, 10, 18, 10, 30, 0); // 18 Nov 2026, 10:30 AM
  const tomorrow4pm = buildQuickFollowUpPreset('tomorrow_4pm', fixedNow);
  assert.equal(tomorrow4pm.date, '2026-11-19');
  assert.equal(tomorrow4pm.time, '16:00');
  assert.equal(formatTime12Hour('16:00'), '4:00 PM');

  const schedule = formatFollowUpSchedule(tomorrow4pm.date, tomorrow4pm.time, fixedNow);
  assert.equal(schedule.hasSchedule, true);
  assert.equal(schedule.label, 'Tomorrow, 4:00 PM');
  assert.equal(schedule.isOverdue, false);
  assert.equal(schedule.isDueToday, false);

  const overdueSched = formatFollowUpSchedule('2026-11-18', '09:00', fixedNow);
  assert.equal(overdueSched.label, 'Today, 9:00 AM');
  assert.equal(overdueSched.isDueToday, true);
  assert.equal(overdueSched.isOverdue, true);
});

test('computeAssignmentProgress counts Completed, Follow-up Scheduled, Not Answered, Pending, and Due Now', () => {
  const fixedNow = new Date(2026, 10, 18, 14, 0, 0);
  const sampleTasks: Array<Pick<WorkAssignmentTask, 'callStatus' | 'followUpDate' | 'followUpTime'>> = [
    { callStatus: 'Called - Done', followUpDate: '', followUpTime: '' },
    { callStatus: 'Called - Done', followUpDate: '', followUpTime: '' },
    { callStatus: 'Follow-up Scheduled', followUpDate: '2026-11-18', followUpTime: '16:00' },
    { callStatus: 'Follow-up Scheduled', followUpDate: '2026-11-19', followUpTime: '16:00' },
    { callStatus: 'Not Answered', followUpDate: '', followUpTime: '' },
    { callStatus: 'Pending', followUpDate: '', followUpTime: '' },
  ];

  const stats = computeAssignmentProgress(sampleTasks, fixedNow);
  assert.equal(stats.total, 6);
  assert.equal(stats.completed, 2);
  assert.equal(stats.followUpScheduled, 2);
  assert.equal(stats.notAnswered, 1);
  assert.equal(stats.pending, 1);
  assert.equal(stats.dueNowCount, 1);
  assert.equal(stats.percentDone, 33);
});

test('buildTaskCallLink and buildTaskWhatsAppLink generate valid tel and wa.me links per department', () => {
  const tel = buildTaskCallLink({ callingNumber: '9876543210', mobileNumber: '' });
  assert.equal(tel, 'tel:+919876543210');

  const waFee = buildTaskWhatsAppLink({
    department: 'fee_recovery',
    callingNumber: '9876543210',
    mobileNumber: '',
    studentName: 'Rohan Verma',
    pendingFee: 4500,
    subject: '',
  });
  assert.ok(waFee?.startsWith('https://wa.me/919876543210?text='));
  assert.ok(waFee?.includes('4%2C500') || waFee?.includes('4500'));

  const waPractical = buildTaskWhatsAppLink({
    department: 'practical',
    callingNumber: '9876543210',
    mobileNumber: '',
    studentName: 'Rohan Verma',
    pendingFee: 0,
    subject: 'Physics, Chemistry',
  });
  assert.ok(waPractical?.includes('Practical'));
});

test('sanitizeFirestoreDocId produces safe alphanumeric/underscore/hyphen IDs', () => {
  assert.equal(sanitizeFirestoreDocId('WA_fee/recovery: 123!!'), 'WA_fee_recovery_123');
});

test('formatStoredFollowUpDateTime and mapCallStatusToFeeFollowUp produce compact Firestore-safe values', () => {
  assert.equal(formatStoredFollowUpDateTime('2026-11-20', '16:00'), '2026-11-20 4:00 PM');
  assert.equal(formatStoredFollowUpDateTime('2026-11-20', ''), '2026-11-20');
  assert.equal(formatStoredFollowUpDateTime('', '16:00'), '');
  assert.equal(mapCallStatusToFeeFollowUp('Follow-up Scheduled'), 'Scheduled');
  assert.equal(mapCallStatusToFeeFollowUp('Called - Done'), 'Contacted');
});

test('buildLatestTaskByStudentMap picks the latest called remark & follow-up per student for the department', () => {
  const older: WorkAssignmentTask = {
    taskId: 't1',
    assignmentId: 'a1',
    centreId: 'vp_lookerganj',
    department: 'fee_recovery',
    staffUid: 's1',
    staffName: 'Reena Patel',
    studentId: 'STU_1',
    serialNumber: 1,
    studentName: 'Mohd Faraz Ansari',
    fatherName: 'Mohd Altaf',
    mobileNumber: '7860399509',
    callingNumber: '7860399509',
    subject: '',
    pendingFee: 7700,
    totalFee: 22700,
    callStatus: 'Not Answered',
    followUpDate: '2026-11-19',
    followUpTime: '11:00',
    remark: 'Phone nahi uthaya',
    lastCalledAt: '2026-11-19T05:00:00.000Z',
    updatedBy: 's1',
    createdAt: '2026-11-19T04:00:00.000Z',
    updatedAt: '2026-11-19T05:00:00.000Z',
  };
  const newer: WorkAssignmentTask = {
    ...older,
    taskId: 't2',
    callStatus: 'Follow-up Scheduled',
    followUpDate: '2026-11-20',
    followUpTime: '16:00',
    remark: 'Papa bole kal 4 baje call karna fees jama kar denge',
    lastCalledAt: '2026-11-19T08:30:00.000Z',
  };
  const untouched: WorkAssignmentTask = {
    ...older,
    taskId: 't3',
    studentId: 'STU_2',
    callStatus: 'Pending',
    followUpDate: '',
    followUpTime: '',
    remark: '',
    lastCalledAt: '',
  };

  const map = buildLatestTaskByStudentMap([older, newer, untouched], 'fee_recovery');
  assert.equal(map.size, 1);
  assert.equal(map.get('STU_1')?.remark, 'Papa bole kal 4 baje call karna fees jama kar denge');
  assert.equal(map.get('STU_1')?.followUpTime, '16:00');
  assert.equal(map.has('STU_2'), false);
});

