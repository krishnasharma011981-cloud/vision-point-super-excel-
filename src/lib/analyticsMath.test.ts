import assert from 'node:assert/strict';
import test from 'node:test';
import type { AdmissionRecord, FeeRecoveryRecord, Student } from '../types/domain';
import {
  allocateExactPercentages,
  buildTelHref,
  buildWhatsAppHref,
  computeInstitutionalAnalytics,
  maskMobileNumber,
  parseFeeNumberNullable,
  reconcileFeeNumbers,
  resolveStudentFeeSummary,
} from './analyticsMath';

test('maskMobileNumber hides full digits in 96******* style', () => {
  assert.equal(maskMobileNumber('9612345678'), '96********');
  assert.equal(maskMobileNumber('+91 96123 45678'), '96********');
  assert.equal(maskMobileNumber('09876543210'), '98********');
  assert.equal(maskMobileNumber('Not Provided'), 'Not Provided');
  assert.equal(maskMobileNumber(''), 'Not Provided');
  assert.equal(maskMobileNumber('9612345678').includes('12345678'), false);
});

test('buildTelHref & buildWhatsAppHref build valid direct dial and WhatsApp links', () => {
  assert.equal(buildTelHref('9612345678'), 'tel:+919612345678');
  assert.equal(buildTelHref('09612345678'), 'tel:+919612345678');
  assert.equal(buildTelHref('Not Provided'), null);

  const wa = buildWhatsAppHref('9612345678', 'Aarav Sharma');
  assert.ok(wa?.startsWith('https://wa.me/919612345678?text='));
  assert.ok(wa?.includes('Aarav%20Sharma'));

  const waPractical = buildWhatsAppHref('9612345678', 'Aarav Sharma', 'Practical file aur submission follow-up');
  assert.ok(waPractical?.includes('Practical%20file'));
});

test('parseFeeNumberNullable fixes currency prefix dot bug and handles Indian formats', () => {
  assert.equal(parseFeeNumberNullable('Rs. 5,000/-'), 5000);
  assert.equal(parseFeeNumberNullable('Rs.12000'), 12000);
  assert.equal(parseFeeNumberNullable('₹ 14,500.00'), 14500);
  assert.equal(parseFeeNumberNullable('INR 8500'), 8500);
  assert.equal(parseFeeNumberNullable('5000 + 2500'), 7500);
  assert.equal(parseFeeNumberNullable('12k'), 12000);
  assert.equal(parseFeeNumberNullable('0'), 0);
  assert.equal(parseFeeNumberNullable('NIL'), null);
  assert.equal(parseFeeNumberNullable(''), null);
});

test('reconcileFeeNumbers derives paid, pending, total, and status mathematically', () => {
  // Case 1: Total + Paid present
  const c1 = reconcileFeeNumbers({ totalFeeRaw: '₹ 15,000', paidAmountRaw: 'Rs. 10,000/-' });
  assert.equal(c1.totalFee, 15000);
  assert.equal(c1.paidAmount, 10000);
  assert.equal(c1.pendingAmount, 5000);
  assert.equal(c1.recoveryStatus, 'Partial');

  // Case 2: Total + Pending present (Excel update only has Due/Baki column)
  const c2 = reconcileFeeNumbers({ totalFeeRaw: 12000, pendingAmountRaw: 3000 });
  assert.equal(c2.totalFee, 12000);
  assert.equal(c2.paidAmount, 9000);
  assert.equal(c2.pendingAmount, 3000);
  assert.equal(c2.recoveryStatus, 'Partial');

  // Case 3: Paid + Pending present without Total Fee
  const c3 = reconcileFeeNumbers({ paidAmountRaw: '8000', pendingAmountRaw: '4000' });
  assert.equal(c3.totalFee, 12000);
  assert.equal(c3.paidAmount, 8000);
  assert.equal(c3.pendingAmount, 4000);
  assert.equal(c3.recoveryStatus, 'Partial');

  // Case 4: Paid > default 12000 without Total Fee column (must NOT truncate down to 12000!)
  const c4 = reconcileFeeNumbers({ paidAmountRaw: '16500', feeStatusRaw: 'Full Paid' });
  assert.equal(c4.totalFee, 16500);
  assert.equal(c4.paidAmount, 16500);
  assert.equal(c4.pendingAmount, 0);
  assert.equal(c4.recoveryStatus, 'Paid');

  // Case 5: Fee status "Paid" with Total Fee present
  const c5 = reconcileFeeNumbers({ totalFeeRaw: 14000, feeStatusRaw: 'Paid' });
  assert.equal(c5.totalFee, 14000);
  assert.equal(c5.paidAmount, 14000);
  assert.equal(c5.pendingAmount, 0);
  assert.equal(c5.recoveryStatus, 'Paid');
});

test('allocateExactPercentages sums strictly to 100 when non-empty and 0 when empty', () => {
  const sum = (arr: number[]) => arr.reduce((a, b) => a + b, 0);
  assert.equal(sum(allocateExactPercentages([1, 1, 1, 0])), 100);
  assert.equal(sum(allocateExactPercentages([7, 3, 2, 1])), 100);
  assert.deepEqual(allocateExactPercentages([0, 0, 0, 0]), [0, 0, 0, 0]);
});

test('computeInstitutionalAnalytics computes exact fee totals, TMA/Exam fees, branch shares, and reasoning insights', () => {
  const baseStudent = (id: string, centreId: Student['centreId'], tma: Student['tmaStatus']): Student => ({
    serialNumber: 1,
    studentId: id,
    studentName: `Student ${id}`,
    mobileNumber: '9612345678',
    subject: 'Maths, Science',
    tcStatus: 'Received',
    bookStatus: 'Received',
    classAttendanceStatus: 'Regular',
    whyNios: '',
    currentEducationStatus: '',
    futurePlanning: '',
    tmaStatus: tma,
    practicalStatus: 'Completed',
    examinationStatus: 'Not Completed',
    centreId,
    centreName: 'Vision Point',
    admissionDate: '2026-01-01',
    assignedEmployeeUid: 'u1',
    assignedEmployeeName: 'Staff',
    additionalRemarks: '',
    createdBy: 'u1',
    createdAt: '',
    updatedBy: 'u1',
    updatedAt: '',
  });

  const students: Student[] = [
    { ...baseStudent('S1', 'vp_lookerganj', 'Submitted'), tmaFee: 1000, examFee: 2000 },
    { ...baseStudent('S2', 'vp_lookerganj', 'Pending'), tmaFee: 1500, examFee: 2500 },
    {
      ...baseStudent('S3', 'vp_civillines', 'Pending'),
      extraColumns: { 'TMA Fee': 'Rs. 1,200', 'Exam Fee': '₹ 1,800', 'Total Fee': '16000' },
    },
  ];

  const fees: FeeRecoveryRecord[] = [
    {
      studentId: 'S1',
      studentName: 'Student S1',
      mobileNumber: '9612345678',
      centreId: 'vp_lookerganj',
      recoveryStatus: 'Paid',
      followUpStatus: 'Closed',
      totalFee: 12000,
      paidAmount: 12000,
      pendingAmount: 0,
      tmaFee: 1000,
      examFee: 2000,
      assignedEmployeeUid: 'u1',
      assignedEmployeeName: 'Staff',
      followUpNotes: '',
      lastContactDate: '2026-01-01',
      nextFollowUpDate: '2026-01-01',
      createdBy: 'u1',
      createdAt: '',
      updatedBy: 'u1',
      updatedAt: '',
    },
    {
      studentId: 'S2',
      studentName: 'Student S2',
      mobileNumber: '9612345678',
      centreId: 'vp_lookerganj',
      recoveryStatus: 'Partial',
      followUpStatus: 'Promise to Pay',
      totalFee: 12000,
      paidAmount: 6000,
      pendingAmount: 6000,
      tmaFee: 1500,
      examFee: 2500,
      assignedEmployeeUid: 'u1',
      assignedEmployeeName: 'Staff',
      followUpNotes: '',
      lastContactDate: '2026-01-01',
      nextFollowUpDate: '2026-01-01',
      createdBy: 'u1',
      createdAt: '',
      updatedBy: 'u1',
      updatedAt: '',
    },
    {
      studentId: 'S3',
      studentName: 'Student S3',
      mobileNumber: '9612345678',
      centreId: 'vp_civillines',
      recoveryStatus: 'Pending',
      followUpStatus: 'Scheduled',
      totalFee: 16000,
      paidAmount: 0,
      pendingAmount: 16000,
      assignedEmployeeUid: 'u1',
      assignedEmployeeName: 'Staff',
      followUpNotes: '',
      lastContactDate: '2026-01-01',
      nextFollowUpDate: '2026-01-01',
      createdBy: 'u1',
      createdAt: '',
      updatedBy: 'u1',
      updatedAt: '',
    },
  ];

  const s3Summary = resolveStudentFeeSummary(students[2], fees[2]);
  assert.equal(s3Summary.tmaFee, 1200);
  assert.equal(s3Summary.examFee, 1800);
  assert.equal(s3Summary.totalFee, 16000);

  const admissions: AdmissionRecord[] = [];
  const res = computeInstitutionalAnalytics(students, fees, admissions, 'all');

  assert.equal(res.totalStudents, 3);
  assert.equal(res.totalFeeBilled, 40000);
  assert.equal(res.totalFeePaid, 18000);
  assert.equal(res.totalFeePending, 22000);
  assert.equal(res.totalTmaFee, 3700);
  assert.equal(res.totalExamFee, 6300);
  assert.equal(res.collectionRatePct, 45);
  assert.equal(res.paidCount, 1);
  assert.equal(res.partialCount, 1);
  assert.equal(res.pendingCount, 1);
  assert.equal(res.tmaRatePct, 33);
  assert.equal(
    res.branchMetrics.reduce((a, b) => a + b.percentage, 0),
    100,
  );
  assert.ok(res.reasoningInsights.some((i) => i.id === 'pending_concentration' && i.metric.includes('CLN')));
  assert.ok(res.reasoningInsights.some((i) => i.id === 'dual_risk' && i.metric.includes('2 Students')));
});

test('computeInstitutionalAnalytics returns 0% attendance when all students are Not Attending and scales on update', () => {
  const makeStu = (id: string, status: Student['classAttendanceStatus']): Student => ({
    serialNumber: 1,
    studentId: id,
    studentName: `Student ${id}`,
    mobileNumber: '9612345678',
    subject: 'Hindi',
    tcStatus: 'Not Received',
    bookStatus: 'Pending',
    classAttendanceStatus: status,
    whyNios: '',
    currentEducationStatus: '',
    futurePlanning: '',
    tmaStatus: 'Pending',
    practicalStatus: 'Pending',
    examinationStatus: 'Not Completed',
    centreId: 'vp_lookerganj',
    centreName: 'Vision Point Lookerganj',
    admissionDate: '2026-01-01',
    assignedEmployeeUid: 'u1',
    assignedEmployeeName: 'Staff',
    additionalRemarks: '',
    createdBy: 'u1',
    createdAt: '',
    updatedBy: 'u1',
    updatedAt: '',
  });

  const allZero = computeInstitutionalAnalytics(
    [makeStu('A1', 'Not Attending'), makeStu('A2', 'Not Attending')],
    [],
    [],
    'vp_lookerganj',
  );
  assert.equal(allZero.attendanceRatePct, 0);
  assert.equal(allZero.regularAttendanceCount, 0);

  const halfUpdated = computeInstitutionalAnalytics(
    [makeStu('A1', 'Regular'), makeStu('A2', 'Not Attending')],
    [],
    [],
    'vp_lookerganj',
  );
  assert.equal(halfUpdated.attendanceRatePct, 50);
  assert.equal(halfUpdated.regularAttendanceCount, 1);
});

