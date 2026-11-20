import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseBackupJson,
  sanitizeCentreForRestore,
  sanitizeEmployeeReportForRestore,
  sanitizeExcelSheetConfigForRestore,
  sanitizeFeeRecoveryForRestore,
  sanitizeStaffInviteForRestore,
  sanitizeStudentForRestore,
  sanitizeUserForRestore,
  sanitizeWorkAssignmentForRestore,
  sanitizeWorkAssignmentTaskForRestore,
} from './databaseBackup';

test('parseBackupJson parses v1, v2, and v3 full multi-collection backups including Employee Management', () => {
  const v1 = JSON.stringify({
    exportedAt: '2026-10-10T10:00:00.000Z',
    exportedBy: 'niosvisionpoint9@gmail.com',
    centres: [{ id: 'vp_lookerganj', name: 'Vision Point Lookerganj' }],
    students: [{ studentId: 'STU_1', studentName: 'Rahul Sharma', mobileNumber: '9876543210', centreId: 'vp_lookerganj' }],
    users: [
      { uid: 'u1', fullName: 'Ashish Pandey', email: 'niosvisionpoint9@gmail.com', role: 'super_admin', centreId: 'vp_lookerganj', department: 'all' },
      { uid: 'u2', fullName: 'Nancy Gupta', email: 'visionpointcivillines@gmail.com', role: 'centre_head', centreId: 'vp_civillines', department: 'all', mobileNumber: '7518400602' },
    ],
    settings: { geofenceEnabled: true, emergencyOverrideActive: false, sessionTimeoutMinutes: 60, maxGpsAccuracyMeters: 500 },
  });

  const r1 = parseBackupJson(v1);
  assert.equal(r1.ok, true);
  if (!r1.ok) return;
  assert.equal(r1.summary.centres, 1);
  assert.equal(r1.summary.students, 1);
  assert.equal(r1.summary.users, 2);
  assert.equal(r1.summary.hasSettings, true);
  assert.equal(r1.staffProfiles.length, 1);
  assert.equal(r1.staffProfiles[0].email, 'visionpointcivillines@gmail.com');
  assert.equal(r1.staffProfiles[0].role, 'centre_head');
  assert.equal(r1.staffProfiles[0].legacyUid, 'u2');

  const v3 = JSON.stringify({
    version: 3,
    exportedAt: '2026-11-19T10:00:00.000Z',
    exportedBy: 'niosvisionpoint9@gmail.com',
    students: { STU_99: { studentName: 'Ananya Verma', mobileNumber: '9988776655', centreId: 'xis_varanasi' } },
    fee_recovery: [{ studentId: 'STU_99', totalFee: 15000, paidAmount: 5000, pendingAmount: 10000, centreId: 'xis_varanasi' }],
    work_assignments: [{ assignmentId: 'wa_1', centreId: 'xis_varanasi', department: 'fee_recovery', staffUid: 'emp_1', staffName: 'Riya', staffEmail: 'riya@vp.edu', fromSerial: 1, toSerial: 50, totalStudents: 50 }],
    users: [{ uid: 'emp_1', fullName: 'Riya Patel', email: 'riya@vp.edu', role: 'employee', centreId: 'xis_varanasi', department: 'fee_recovery' }],
    staff_invites: [{ inviteId: 'inv_1', fullName: 'Karan Verma', email: 'karan@vp.edu', role: 'employee', centreId: 'vp_lookerganj', department: 'practical', status: 'Pending' }],
    employee_reports: [{ reportId: 'rep_1', employeeName: 'Riya Patel', employeeEmail: 'riya@vp.edu', centreId: 'xis_varanasi', department: 'fee_recovery', title: 'Daily Calls', summary: 'Completed 25 calls' }],
  });

  const r3 = parseBackupJson(v3);
  assert.equal(r3.ok, true);
  if (!r3.ok) return;
  assert.equal(r3.summary.students, 1);
  assert.equal(r3.summary.fee_recovery, 1);
  assert.equal(r3.summary.work_assignments, 1);
  assert.equal(r3.summary.users, 1);
  assert.equal(r3.summary.staff_invites, 1);
  assert.equal(r3.summary.employee_reports, 1);
  assert.equal(r3.staffProfiles.length, 2);
  assert.equal(r3.staffProfiles[1].email, 'karan@vp.edu');
});

test('parseBackupJson rejects malformed or empty JSON cleanly', () => {
  assert.equal(parseBackupJson('{broken').ok, false);
  assert.equal(parseBackupJson('{}').ok, false);
  assert.equal(parseBackupJson('[]').ok, false);
});

test('sanitizeStudentForRestore preserves extraColumns, colors, fees and strictly enforces Firestore rule fields', () => {
  const { id, data } = sanitizeStudentForRestore(
    {
      studentId: 'STU 001/A',
      serialNumber: 14,
      studentName: 'Amit Kumar',
      mobileNumber: '9876543210',
      subject: 'Hindi, English, Maths',
      centreId: 'vp_civillines',
      tmaFee: 1200,
      examFee: 2500,
      rowColor: '#FFF9C4',
      extraColumns: { 'FATHER NAME': 'Suresh Kumar', BATCH: '2026' },
      cellColors: { studentName: '#E3F2FD' },
      unknownLegacyField: 'must-be-dropped',
    },
    'admin_uid',
    1,
  );

  assert.match(id, /^[a-zA-Z0-9_-]+$/);
  assert.equal(data.studentId, id);
  assert.equal(data.serialNumber, 14);
  assert.equal(data.centreId, 'vp_civillines');
  assert.equal(data.tmaFee, 1200);
  assert.equal(data.examFee, 2500);
  assert.equal(data.rowColor, '#FFF9C4');
  assert.deepEqual(data.extraColumns, { 'FATHER NAME': 'Suresh Kumar', BATCH: '2026' });
  assert.deepEqual(data.cellColors, { studentName: '#E3F2FD' });
  assert.equal('unknownLegacyField' in data, false);
});

test('sanitizeFeeRecovery, Centre, ExcelSheetConfig, WorkAssignment, Task & Employee Management enforce Firestore rule schemas', () => {
  const fee = sanitizeFeeRecoveryForRestore(
    { studentId: 'STU_1', studentName: 'Amit Kumar', mobileNumber: '9876543210', centreId: 'vp_lookerganj', totalFee: 18000, paidAmount: 6000 },
    'admin_uid',
  );
  assert.equal(fee.data.pendingAmount, 12000);
  assert.equal(fee.data.recoveryStatus, 'Pending');

  const centre = sanitizeCentreForRestore({ id: 'vp_lookerganj', name: 'Vision Point Lookerganj' }, 'admin_uid');
  assert.equal(centre.id, 'vp_lookerganj');
  assert.equal(centre.data.status, 'Active');

  const cfg = sanitizeExcelSheetConfigForRestore(
    { configId: 'vp_civillines', headerLabels: { studentName: 'Name' }, customColumns: ['FATHER NAME'] },
    'admin_uid',
  );
  assert.equal(cfg.id, 'vp_civillines');
  assert.deepEqual(cfg.data.customColumns, ['FATHER NAME']);

  const wa = sanitizeWorkAssignmentForRestore(
    { assignmentId: 'wa_1', centreId: 'vp_lookerganj', department: 'practical', staffUid: 'u_1', staffName: 'Riya', staffEmail: 'riya@vp.edu', fromSerial: 1, toSerial: 50, totalStudents: 50 },
    'admin_uid',
    'Ashish Pandey',
  );
  assert.equal(wa.data.assignedByUid, 'admin_uid');
  assert.equal(wa.data.department, 'practical');

  const wt = sanitizeWorkAssignmentTaskForRestore(
    { taskId: 'wt_1', assignmentId: 'wa_1', centreId: 'vp_lookerganj', department: 'practical', staffUid: 'u_1', staffName: 'Riya', studentId: 'STU_1', serialNumber: 1, studentName: 'Amit', fatherName: 'Suresh', callStatus: 'Follow-up Scheduled', followUpDate: '2026-11-20', followUpTime: '16:00', remark: 'Kal 4 baje call karna' },
    'admin_uid',
  );
  assert.equal(wt.data.followUpTime, '16:00');
  assert.equal(wt.data.remark, 'Kal 4 baje call karna');

  const usr = sanitizeUserForRestore(
    { uid: 'emp_99', fullName: 'Reena Patel', email: 'REENA@VP.EDU', mobileNumber: '9988776655', role: 'employee', centreId: 'vp_lookerganj', department: 'fee_recovery', status: 'Active' },
    'admin_uid',
  );
  assert.ok(usr);
  assert.equal(usr.id, 'emp_99');
  assert.equal(usr.data.email, 'reena@vp.edu');
  assert.equal(usr.data.department, 'fee_recovery');

  const inv = sanitizeStaffInviteForRestore(
    { inviteId: 'inv_55', fullName: 'Karan Verma', email: 'KARAN@VP.EDU', role: 'centre_head', centreId: 'xis_jaunpur', status: 'Claimed', claimedUid: 'old_uid' },
    'admin_uid',
    'Ashish Pandey',
  );
  assert.ok(inv);
  assert.equal(inv.data.status, 'Pending');
  assert.equal(inv.data.claimedUid, '');
  assert.equal(inv.data.department, 'all');

  const rep = sanitizeEmployeeReportForRestore(
    { reportId: 'rep_77', employeeUid: 'old_uid', employeeName: 'Reena Patel', employeeEmail: 'reena@vp.edu', centreId: 'vp_lookerganj', department: 'fee_recovery', title: 'Fee Calls', summary: 'Called 20 students', tasksCompleted: 20, studentsHandled: 20, status: 'Approved' },
    'admin_uid',
  );
  assert.equal(rep.data.employeeUid, 'admin_uid');
  assert.equal(rep.data.status, 'Submitted');
  assert.equal(rep.data.employeeName, 'Reena Patel');
});
