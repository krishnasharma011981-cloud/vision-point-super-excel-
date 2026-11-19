import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseBackupJson,
  sanitizeCentreForRestore,
  sanitizeExcelSheetConfigForRestore,
  sanitizeFeeRecoveryForRestore,
  sanitizeStudentForRestore,
  sanitizeWorkAssignmentForRestore,
  sanitizeWorkAssignmentTaskForRestore,
} from './databaseBackup';

test('parseBackupJson parses both v1 legacy backups and v2 full multi-collection backups', () => {
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

  const v2 = JSON.stringify({
    version: 2,
    exportedAt: '2026-11-18T10:00:00.000Z',
    exportedBy: 'niosvisionpoint9@gmail.com',
    students: { STU_99: { studentName: 'Ananya Verma', mobileNumber: '9988776655', centreId: 'xis_varanasi' } },
    fee_recovery: [{ studentId: 'STU_99', totalFee: 15000, paidAmount: 5000, pendingAmount: 10000, centreId: 'xis_varanasi' }],
    work_assignments: [{ assignmentId: 'wa_1', centreId: 'xis_varanasi', department: 'fee_recovery', staffUid: 'emp_1', staffName: 'Riya', staffEmail: 'riya@vp.edu', fromSerial: 1, toSerial: 50, totalStudents: 50 }],
  });

  const r2 = parseBackupJson(v2);
  assert.equal(r2.ok, true);
  if (!r2.ok) return;
  assert.equal(r2.summary.students, 1);
  assert.equal(r2.summary.fee_recovery, 1);
  assert.equal(r2.summary.work_assignments, 1);
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

test('sanitizeFeeRecovery, Centre, ExcelSheetConfig, WorkAssignment & Task enforce Firestore rule schemas', () => {
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
});
