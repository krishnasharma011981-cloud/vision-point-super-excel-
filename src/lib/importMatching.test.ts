import test from 'node:test';
import assert from 'node:assert/strict';
import { buildImportPreviewRows } from './importMatching';
import { sanitizeImportedStudentId } from './csvUtils';
import type { Student } from '../types/domain';

function makeExistingStudent(overrides: Partial<Student> & Pick<Student, 'studentId' | 'studentName' | 'mobileNumber' | 'centreId' | 'centreName' | 'serialNumber'>): Student {
  return {
    subject: '',
    tcStatus: 'Not Received',
    bookStatus: 'Pending',
    classAttendanceStatus: 'Not Attending',
    whyNios: '',
    currentEducationStatus: '',
    futurePlanning: '',
    tmaStatus: 'Pending',
    practicalStatus: 'Pending',
    examinationStatus: 'Not Completed',
    admissionDate: '2026-04-01',
    assignedEmployeeUid: 'emp-1',
    assignedEmployeeName: 'Staff',
    additionalRemarks: '',
    createdBy: 'admin-1',
    createdAt: '',
    updatedBy: 'admin-1',
    updatedAt: '',
    ...overrides,
  };
}

test('446 Civil Lines rows stay in vp_civillines even when Lookerganj/Varanasi share same names or IDs', () => {
  const existingOtherBranches: Student[] = [
    makeExistingStudent({
      studentId: 'VP-LKG-2026-0001',
      serialNumber: 1,
      studentName: 'POOJA',
      mobileNumber: '9000000001',
      centreId: 'vp_lookerganj',
      centreName: 'Vision Point Lookerganj, Prayagraj',
    }),
    makeExistingStudent({
      studentId: 'VP-LKG-2026-0002',
      serialNumber: 2,
      studentName: 'ANJALI',
      mobileNumber: '9000000002',
      centreId: 'vp_lookerganj',
      centreName: 'Vision Point Lookerganj, Prayagraj',
    }),
    makeExistingStudent({
      studentId: 'A1126307633',
      serialNumber: 3,
      studentName: 'AYUSH SHUKLA',
      mobileNumber: '9000000003',
      centreId: 'xis_varanasi',
      centreName: 'XIS Varanasi',
    }),
  ];

  // Build 446 Civil Lines rows including overlapping names ("POOJA", "ANJALI") and placeholder/overlapping IDs
  const rawRows: Array<Record<string, string>> = Array.from({ length: 446 }, (_, i) => {
    const idx = i + 1;
    const name =
      idx === 1
        ? 'POOJA'
        : idx === 2
          ? 'ANJALI'
          : idx === 3
            ? 'AYUSH SHUKLA'
            : `Civil Line Student ${idx}`;
    const enroll =
      idx === 3
        ? 'A1126307633'
        : idx <= 15
          ? 'Applied'
          : `CLN-${String(idx).padStart(4, '0')}`;
    return {
      'S.No': String(idx),
      'Enrollment No': enroll,
      'Student Name': name,
      'Mobile No': String(9800000000 + idx),
      Total: '12000',
      Paid: String((idx % 5) * 2000),
    };
  });

  const preview = buildImportPreviewRows({
    rawRows,
    fallbackCentre: 'vp_civillines',
    allowCentreOverride: false,
    isCentreLocked: true,
    columnMapping: {
      studentId: 'Enrollment No',
      studentName: 'Student Name',
      mobileNumber: 'Mobile No',
      totalFee: 'Total',
      paidAmount: 'Paid',
    },
    allowMissingMobile: true,
    allowDuplicateRowsInSheet: false,
    defaultTotalFee: 0,
    importMode: 'upsert',
    mode: 'full',
    isSuperAdmin: true,
    currentUserCentreId: 'vp_lookerganj',
    editedOverrides: {},
    existingStudents: existingOtherBranches,
    commonExtraHeadings: [],
  });

  const ready = preview.filter((r) => !r.validationError && !r.duplicateReason);
  assert.equal(ready.length, 446, 'All 446 rows must remain ready');
  assert.equal(
    ready.filter((r) => r.centreId === 'vp_civillines').length,
    446,
    'Every single one of the 446 rows must stay in vp_civillines (no cross-centre stealing)',
  );
  assert.equal(
    ready.filter((r) => r.operation === 'create').length,
    446,
    'None should steal Lookerganj/Varanasi docs',
  );
});

test('Same-centre students with same name but different real mobiles do not overwrite each other', () => {
  const existingCivil: Student[] = [
    makeExistingStudent({
      studentId: 'VP-CLN-2026-0010',
      serialNumber: 10,
      studentName: 'Anjali Verma',
      mobileNumber: '9811111111',
      centreId: 'vp_civillines',
      centreName: 'Vision Point Civil Lines, Prayagraj',
    }),
  ];

  const preview = buildImportPreviewRows({
    rawRows: [
      { 'Student Name': 'Anjali Verma', 'Mobile No': '9922222222', Total: '8000', Paid: '4000' },
      { 'Student Name': 'Anjali Verma', 'Mobile No': '9811111111', Total: '8000', Paid: '8000' },
    ],
    fallbackCentre: 'vp_civillines',
    allowCentreOverride: false,
    isCentreLocked: true,
    columnMapping: {
      studentName: 'Student Name',
      mobileNumber: 'Mobile No',
      totalFee: 'Total',
      paidAmount: 'Paid',
    },
    allowMissingMobile: true,
    allowDuplicateRowsInSheet: false,
    defaultTotalFee: 0,
    importMode: 'upsert',
    mode: 'full',
    isSuperAdmin: true,
    currentUserCentreId: 'vp_lookerganj',
    editedOverrides: {},
    existingStudents: existingCivil,
    commonExtraHeadings: [],
  });

  assert.equal(preview.length, 2);
  assert.equal(preview[0].operation, 'create');
  assert.equal(preview[0].matchedExisting, null);
  assert.equal(preview[1].operation, 'update');
  assert.equal(preview[1].matchedExisting?.studentId, 'VP-CLN-2026-0010');
});

test('Shared placeholder student IDs sanitize to empty string so no duplicate ID drops occur', () => {
  for (const token of ['Applied', 'Process', 'Under Process', 'Not Done', 'Not Received', '--', 'No ID', 'Blank']) {
    assert.equal(sanitizeImportedStudentId(token), '', `Expected placeholder "${token}" to sanitize to empty`);
  }
  assert.equal(sanitizeImportedStudentId('A1126307633'), 'A1126307633');
});

test('Multi-branch fee_sync matches across centres when unlocked and mobile+name agree', () => {
  const existing: Student[] = [
    makeExistingStudent({
      studentId: 'VP-CLN-2026-0001',
      serialNumber: 1,
      studentName: 'Rohan Yadav',
      mobileNumber: '9876543210',
      centreId: 'vp_civillines',
      centreName: 'Vision Point Civil Lines, Prayagraj',
    }),
    makeExistingStudent({
      studentId: 'VP-LKG-2026-0001',
      serialNumber: 2,
      studentName: 'Rohan Yadav',
      mobileNumber: '9123456789',
      centreId: 'vp_lookerganj',
      centreName: 'Vision Point Lookerganj, Prayagraj',
    }),
  ];

  const preview = buildImportPreviewRows({
    rawRows: [{ 'Student Name': 'Rohan Yadav', 'Mobile No': '9876543210', Paid: '5000', Total: '10000' }],
    fallbackCentre: 'vp_lookerganj',
    allowCentreOverride: true,
    isCentreLocked: false,
    columnMapping: {
      studentName: 'Student Name',
      mobileNumber: 'Mobile No',
      paidAmount: 'Paid',
      totalFee: 'Total',
    },
    allowMissingMobile: true,
    allowDuplicateRowsInSheet: false,
    defaultTotalFee: 0,
    importMode: 'upsert',
    mode: 'fee_sync',
    isSuperAdmin: true,
    currentUserCentreId: 'vp_lookerganj',
    editedOverrides: {},
    existingStudents: existing,
    commonExtraHeadings: [],
  });

  assert.equal(preview.length, 1);
  assert.equal(preview[0].operation, 'update');
  assert.equal(preview[0].centreId, 'vp_civillines');
  assert.equal(preview[0].matchedExisting?.studentId, 'VP-CLN-2026-0001');
});

test('academic_sync mode matches existing students to update Subjects, TMA, and Practical without overwriting missing fields', () => {
  const existing: Student[] = [
    makeExistingStudent({
      studentId: 'VP-LKG-2026-0012',
      serialNumber: 12,
      studentName: 'Kiran Gupta',
      mobileNumber: '9800112233',
      subject: '',
      centreId: 'vp_lookerganj',
      centreName: 'Vision Point Lookerganj, Prayagraj',
    }),
  ];

  const preview = buildImportPreviewRows({
    rawRows: [
      {
        'Student Name': 'Kiran Gupta',
        'Mobile No': '9800112233',
        Subjects: 'English, Data Entry, Painting, Home Science',
        TMA: 'Uploaded',
        Practical: 'File Ready',
      },
    ],
    fallbackCentre: 'vp_lookerganj',
    allowCentreOverride: false,
    isCentreLocked: true,
    columnMapping: {
      studentName: 'Student Name',
      mobileNumber: 'Mobile No',
      subject: 'Subjects',
      tmaStatus: 'TMA',
      practicalStatus: 'Practical',
    },
    allowMissingMobile: true,
    allowDuplicateRowsInSheet: false,
    defaultTotalFee: 0,
    importMode: 'upsert',
    mode: 'academic_sync',
    isSuperAdmin: true,
    currentUserCentreId: 'vp_lookerganj',
    editedOverrides: {},
    existingStudents: existing,
    commonExtraHeadings: [],
  });

  assert.equal(preview.length, 1);
  assert.equal(preview[0].operation, 'update');
  assert.equal(preview[0].matchedExisting?.studentId, 'VP-LKG-2026-0012');
  assert.equal(preview[0].explicitSubjectDetected, true);
  assert.equal(preview[0].explicitTmaDetected, true);
  assert.equal(preview[0].explicitPracticalDetected, true);
  assert.equal(preview[0].subject, 'English, Data Entry, Painting, Home Science');
});

