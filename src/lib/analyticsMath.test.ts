import assert from 'node:assert/strict';
import test from 'node:test';
import type { AdmissionRecord, FeeRecoveryRecord, Student } from '../types/domain';
import {
  allocateExactPercentages,
  buildTelHref,
  buildWhatsAppHref,
  computeFeeSyncPlanFromStudents,
  computeInstitutionalAnalytics,
  extractFeeSignalsFromExtraColumns,
  isAutoClearedZeroFee,
  isFeeFullyPaid,
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

test('reconcileFeeNumbers never invents fake 12000 pending on blank rows and treats Nil/Clear pending as 0', () => {
  const blank = reconcileFeeNumbers({});
  assert.equal(blank.totalFee, 0);
  assert.equal(blank.paidAmount, 0);
  assert.equal(blank.pendingAmount, 0);
  assert.equal(blank.explicitFeeDetected, false);

  const nilPending = reconcileFeeNumbers({ totalFeeRaw: '12000', pendingAmountRaw: 'Nil' });
  assert.equal(nilPending.totalFee, 12000);
  assert.equal(nilPending.paidAmount, 12000);
  assert.equal(nilPending.pendingAmount, 0);
  assert.equal(nilPending.recoveryStatus, 'Paid');

  const paidOnly = reconcileFeeNumbers({ paidAmountRaw: '8000' });
  assert.equal(paidOnly.totalFee, 8000);
  assert.equal(paidOnly.paidAmount, 8000);
  assert.equal(paidOnly.pendingAmount, 0);
  assert.equal(paidOnly.recoveryStatus, 'Paid');
});

test('resolveStudentFeeSummary & computeFeeSyncPlanFromStudents repair untouched 12000 placeholders from Excel columns without touching manual edits', () => {
  const base = (id: string, extraColumns?: Record<string, string>): Student => ({
    serialNumber: 1,
    studentId: id,
    studentName: `Student ${id}`,
    mobileNumber: '9876543210',
    subject: 'Hindi, English',
    tcStatus: 'Not Received',
    bookStatus: 'Pending',
    classAttendanceStatus: 'Not Attending',
    whyNios: '',
    currentEducationStatus: '',
    futurePlanning: '',
    tmaStatus: 'Pending',
    practicalStatus: 'Pending',
    examinationStatus: 'Not Completed',
    centreId: 'vp_lookerganj',
    centreName: 'Vision Point Lookerganj',
    admissionDate: '2026-11-16',
    assignedEmployeeUid: 'u1',
    assignedEmployeeName: 'Staff',
    additionalRemarks: '',
    createdBy: 'u1',
    createdAt: '',
    updatedBy: 'u1',
    updatedAt: '',
    ...(extraColumns ? { extraColumns } : {}),
  });

  const makeRec = (id: string, note: string): FeeRecoveryRecord => ({
    studentId: id,
    studentName: `Student ${id}`,
    mobileNumber: '9876543210',
    centreId: 'vp_lookerganj',
    recoveryStatus: 'Pending',
    followUpStatus: 'Scheduled',
    totalFee: 12000,
    paidAmount: 0,
    pendingAmount: 12000,
    assignedEmployeeUid: 'u1',
    assignedEmployeeName: 'Staff',
    followUpNotes: note,
    lastContactDate: '2026-11-16',
    nextFollowUpDate: '2026-11-16',
    createdBy: 'u1',
    createdAt: '',
    updatedBy: 'u1',
    updatedAt: '',
  });

  // S1: Untouched auto-import 12000 placeholder, but Excel extraColumns has installments + Decided Fee
  const s1 = base('S1', {
    'Decided Fee': '15000',
    '1st Installment': '6000',
    '2nd Installment': '4000',
    'TMA Fees (Rs)': '500',
    'Exam Fees (Rs)': '1500',
  });
  const r1 = makeRec('S1', 'Imported via Excel Bulk Import.');

  // S2: Untouched auto-import 12000 placeholder, NO fees anywhere in Excel
  const s2 = base('S2', { Batch: 'Morning', 'Fees Remark': 'fees low' });
  const r2 = makeRec('S2', 'Imported via Excel Bulk Import.');

  // S3: Manually verified 12000 fee with custom call note (must NOT be flagged untouched default)
  const s3 = base('S3');
  const r3 = makeRec('S3', 'Called parent, promised to pay 12000 next Monday.');

  // S4: Missing fee_recovery doc and no fees -> 0 (not 12000)
  const s4 = base('S4');

  const resolved1 = resolveStudentFeeSummary(s1, r1);
  assert.equal(resolved1.totalFee, 15000);
  assert.equal(resolved1.paidAmount, 10000);
  assert.equal(resolved1.pendingAmount, 5000);
  assert.equal(resolved1.tmaFee, 500);
  assert.equal(resolved1.examFee, 1500);
  assert.equal(resolved1.recoveryStatus, 'Partial');

  const resolved4 = resolveStudentFeeSummary(s4, undefined);
  assert.equal(resolved4.totalFee, 0);
  assert.equal(resolved4.pendingAmount, 0);
  assert.equal(resolved4.hasFeeData, false);

  const planKeep12k = computeFeeSyncPlanFromStudents([s1, s2, s3, s4], [r1, r2, r3]);
  assert.equal(planKeep12k.excelSyncCount, 1);
  assert.equal(planKeep12k.missingRecordCount, 1);
  assert.equal(planKeep12k.untouched12kCount, 1); // Only S2 (S3 has manual note, S1 matched Excel columns)

  const planReset12k = computeFeeSyncPlanFromStudents([s1, s2, s3, s4], [r1, r2, r3], {
    resetUntouched12000Defaults: true,
  });
  const s2Item = planReset12k.items.find((i) => i.student.studentId === 'S2');
  const s3Item = planReset12k.items.find((i) => i.student.studentId === 'S3');
  assert.equal(s2Item?.totalFee, 0);
  assert.equal(s2Item?.pendingAmount, 0);
  assert.equal(s2Item?.reason, 'reset_12k_default');
  assert.equal(s3Item, undefined);
});

test('computeFeeSyncPlanFromStudents cleans all historical auto-generated 12000 notes when resetUntouched12000Defaults is enabled', () => {
  const historicalNotes = [
    'Synced with updated Excel sheet (no fee due)',
    'Initialized fee record from student sheet',
    'Fees synced from student Excel columns',
    'Fees updated from uploaded Excel',
    '',
  ];
  const stuList: Student[] = historicalNotes.map((_, idx) => ({
    serialNumber: idx + 1,
    studentId: `H${idx}`,
    studentName: `Historical ${idx}`,
    mobileNumber: '9876543210',
    subject: 'Hindi',
    tcStatus: 'Not Received',
    bookStatus: 'Pending',
    classAttendanceStatus: 'Not Attending',
    whyNios: '',
    currentEducationStatus: '',
    futurePlanning: '',
    tmaStatus: 'Pending',
    practicalStatus: 'Pending',
    examinationStatus: 'Not Completed',
    centreId: 'vp_lookerganj',
    centreName: 'Vision Point Lookerganj',
    admissionDate: '2026-11-16',
    assignedEmployeeUid: 'u1',
    assignedEmployeeName: 'Staff',
    additionalRemarks: '',
    createdBy: 'u1',
    createdAt: '',
    updatedBy: 'u1',
    updatedAt: '',
  }));

  const recs: FeeRecoveryRecord[] = historicalNotes.map((note, idx) => ({
    studentId: `H${idx}`,
    studentName: `Historical ${idx}`,
    mobileNumber: '9876543210',
    centreId: 'vp_lookerganj',
    recoveryStatus: 'Pending',
    followUpStatus: 'Scheduled',
    totalFee: 12000,
    paidAmount: 0,
    pendingAmount: 12000,
    assignedEmployeeUid: 'u1',
    assignedEmployeeName: 'Staff',
    followUpNotes: note,
    lastContactDate: '2026-11-16',
    nextFollowUpDate: '2026-11-16',
    createdBy: 'u1',
    createdAt: '',
    updatedBy: 'u1',
    updatedAt: '',
  }));

  const plan = computeFeeSyncPlanFromStudents(stuList, recs, {
    resetUntouched12000Defaults: true,
  });
  assert.equal(plan.untouched12kCount, historicalNotes.length);
  assert.equal(plan.items.length, historicalNotes.length);
  assert.ok(plan.items.every((i) => i.totalFee === 0 && i.pendingAmount === 0));
});

test('isAutoClearedZeroFee rescues fee signals from extraColumns including Kist installments without overriding manual scholarship zero records', () => {
  const autoClearedRec: FeeRecoveryRecord = {
    studentId: 'Z1',
    studentName: 'Ayush Shukla',
    mobileNumber: '8412345678',
    centreId: 'vp_lookerganj',
    recoveryStatus: 'Pending',
    followUpStatus: 'Scheduled',
    totalFee: 0,
    paidAmount: 0,
    pendingAmount: 0,
    assignedEmployeeUid: 'u1',
    assignedEmployeeName: 'Staff',
    followUpNotes: 'Cleared untouched default ₹12,000 placeholder to ₹0.',
    lastContactDate: '2026-11-16',
    nextFollowUpDate: '2026-11-16',
    createdBy: 'u1',
    createdAt: '',
    updatedBy: 'u1',
    updatedAt: '',
  };

  const manualZeroRec: FeeRecoveryRecord = {
    ...autoClearedRec,
    studentId: 'Z2',
    studentName: 'Manual Scholarship',
    followUpNotes: 'Full scholarship approved by principal',
  };

  assert.equal(isAutoClearedZeroFee(autoClearedRec), true);
  assert.equal(isAutoClearedZeroFee(manualZeroRec), false);

  const studentWithKist: Student = {
    serialNumber: 63,
    studentId: 'Z1',
    studentName: 'Ayush Shukla',
    mobileNumber: '8412345678',
    subject: 'Hindi, English',
    tcStatus: 'Not Received',
    bookStatus: 'Pending',
    classAttendanceStatus: 'Not Attending',
    whyNios: '',
    currentEducationStatus: '',
    futurePlanning: '',
    tmaStatus: 'Pending',
    practicalStatus: 'Pending',
    examinationStatus: 'Not Completed',
    centreId: 'vp_lookerganj',
    centreName: 'Vision Point Lookerganj',
    admissionDate: '2026-11-16',
    assignedEmployeeUid: 'u1',
    assignedEmployeeName: 'Staff',
    additionalRemarks: '',
    createdBy: 'u1',
    createdAt: '',
    updatedBy: 'u1',
    updatedAt: '',
    extraColumns: {
      'Total Fee': '15000',
      '1st Kist': '5000',
      '2nd Kist': '3000',
    },
  };

  const studentManualZero: Student = {
    ...studentWithKist,
    studentId: 'Z2',
    studentName: 'Manual Scholarship',
  };

  const signals = extractFeeSignalsFromExtraColumns(studentWithKist.extraColumns);
  assert.equal(signals.totalFeeRaw, '15000');
  assert.equal(signals.paidAmountRaw, '8000');
  assert.equal(signals.hasMainFeeSignals, true);

  const resolvedAutoZero = resolveStudentFeeSummary(studentWithKist, autoClearedRec);
  assert.equal(resolvedAutoZero.totalFee, 15000);
  assert.equal(resolvedAutoZero.paidAmount, 8000);
  assert.equal(resolvedAutoZero.pendingAmount, 7000);
  assert.equal(resolvedAutoZero.recoveryStatus, 'Partial');

  const resolvedManualZero = resolveStudentFeeSummary(studentManualZero, manualZeroRec);
  assert.equal(resolvedManualZero.totalFee, 0);
  assert.equal(resolvedManualZero.paidAmount, 0);
  assert.equal(resolvedManualZero.pendingAmount, 0);

  const syncPlan = computeFeeSyncPlanFromStudents(
    [studentWithKist, studentManualZero],
    [autoClearedRec, manualZeroRec],
  );
  assert.equal(syncPlan.excelSyncCount, 1);
  assert.equal(syncPlan.items.length, 1);
  assert.equal(syncPlan.items[0].student.studentId, 'Z1');
  assert.equal(syncPlan.items[0].operation, 'update');
  assert.equal(syncPlan.items[0].pendingAmount, 7000);
});

test('isFeeFullyPaid & reconcileFeeNumbers classify Paid vs Unpaid cleanly across numbers, text words, and ₹0 resets', () => {
  // Total=15000, Paid="Paid" text -> Paid
  const textPaid = reconcileFeeNumbers({ totalFeeRaw: '15000', paidAmountRaw: 'Paid' });
  assert.equal(textPaid.totalFee, 15000);
  assert.equal(textPaid.paidAmount, 15000);
  assert.equal(textPaid.pendingAmount, 0);
  assert.equal(isFeeFullyPaid(textPaid), true);

  // Only Pending="Nil" -> Paid
  const nilPendingOnly = reconcileFeeNumbers({ pendingAmountRaw: 'Nil' });
  assert.equal(nilPendingOnly.recoveryStatus, 'Paid');
  assert.equal(isFeeFullyPaid(nilPendingOnly), true);

  // Partial payment (Total=15000, Paid=8000, Pending=7000) -> Unpaid
  const halfPaid = reconcileFeeNumbers({ totalFeeRaw: '15000', paidAmountRaw: '8000' });
  assert.equal(halfPaid.recoveryStatus, 'Partial');
  assert.equal(halfPaid.pendingAmount, 7000);
  assert.equal(isFeeFullyPaid(halfPaid), false);

  // Explicit reset to ₹0 must stay ₹0 and classify as Unpaid even if old extraColumns existed
  const resetRec: FeeRecoveryRecord = {
    studentId: 'R0',
    studentName: 'Reset Student',
    mobileNumber: '9876543210',
    centreId: 'vp_lookerganj',
    recoveryStatus: 'Pending',
    followUpStatus: 'Scheduled',
    totalFee: 0,
    paidAmount: 0,
    pendingAmount: 0,
    tmaFee: 0,
    examFee: 0,
    assignedEmployeeUid: 'u1',
    assignedEmployeeName: 'Staff',
    followUpNotes: 'Fees reset to ₹0 — ready for Excel upload.',
    lastContactDate: '2026-11-17',
    nextFollowUpDate: '2026-11-17',
    createdBy: 'u1',
    createdAt: '',
    updatedBy: 'u1',
    updatedAt: '',
  };
  assert.equal(isAutoClearedZeroFee(resetRec), false);
  const resolvedReset = resolveStudentFeeSummary(
    { tmaFee: 500, examFee: 1500, extraColumns: { 'Total Fee': '12000', 'Paid': '5000' } },
    resetRec,
  );
  assert.equal(resolvedReset.totalFee, 0);
  assert.equal(resolvedReset.paidAmount, 0);
  assert.equal(resolvedReset.pendingAmount, 0);
  assert.equal(isFeeFullyPaid(resolvedReset), false);
});

test('extractFeeSignalsFromExtraColumns treats Left Fees as pendingAmountRaw (unpaid) and never as totalFeeRaw', () => {
  const leftSignals = extractFeeSignalsFromExtraColumns({
    Paid: '7500',
    'Left Fees': '4500',
  });
  assert.equal(leftSignals.totalFeeRaw, '');
  assert.equal(leftSignals.paidAmountRaw, '7500');
  assert.equal(leftSignals.pendingAmountRaw, '4500');

  const resolved = resolveStudentFeeSummary({ extraColumns: { Paid: '7500', 'Left Fees': '4500' } }, undefined);
  assert.equal(resolved.totalFee, 12000);
  assert.equal(resolved.paidAmount, 7500);
  assert.equal(resolved.pendingAmount, 4500);
  assert.equal(isFeeFullyPaid(resolved), false);
});
