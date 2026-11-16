import assert from 'node:assert/strict';
import test from 'node:test';
import {
  fuzzyDetectColumnMapping,
  normalizeImportedStudentRow,
  parseCsvText,
} from './csvUtils';

test('fuzzyDetectColumnMapping detects Indian & English fee columns accurately', () => {
  const headers = [
    'S.No',
    'Student Name',
    'Mobile No',
    'Course Fee',
    'Fees Jama',
    'Baki Fee',
    'Fee Status',
    'Batch Timing',
  ];
  const mapping = fuzzyDetectColumnMapping(headers);
  assert.equal(mapping.studentName, 'Student Name');
  assert.equal(mapping.mobileNumber, 'Mobile No');
  assert.equal(mapping.totalFee, 'Course Fee');
  assert.equal(mapping.paidAmount, 'Fees Jama');
  assert.equal(mapping.pendingAmount, 'Baki Fee');
  assert.equal(mapping.feeStatus, 'Fee Status');
});

test('normalizeImportedStudentRow reconciles fees accurately and preserves up to 35 extra columns', () => {
  const rawRow: Record<string, string> = {
    'Student Name': 'Rohan Verma',
    'Mobile No': '+91 96543 21098',
    'Course Fee': 'Rs. 14,500/-',
    'Fees Jama': '₹ 8,500',
    'Fee Status': 'Partial',
    Subjects: 'Hindi, English, Maths',
  };
  for (let i = 1; i <= 35; i++) {
    rawRow[`CustomCol_${i}`] = `Value_${i}`;
  }

  const normalized = normalizeImportedStudentRow(rawRow, 1, 'vp_lookerganj', false);
  assert.equal(normalized.validationError, null);
  assert.equal(normalized.studentName, 'Rohan Verma');
  assert.equal(normalized.mobileNumber, '9654321098');
  assert.equal(normalized.totalFee, 14500);
  assert.equal(normalized.paidAmount, 8500);
  assert.equal(normalized.pendingAmount, 6000);
  assert.equal(normalized.recoveryStatus, 'Partial');
  assert.equal(Object.keys(normalized.extraColumns).length, 35);
});

test('parseCsvText handles multi-row title preamble before actual header row', () => {
  const csv = [
    'VISION POINT COACHING - STUDENTS',
    'Generated 2026',
    'Name,Phone,Total Fee,Jama,Baki',
    'Priya Singh,9876543210,12000,12000,0',
    'Amit Kumar,9612345678,15000,5000,10000',
  ].join('\n');

  const rows = parseCsvText(csv);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].Name, 'Priya Singh');
  assert.equal(rows[1].Jama, '5000');
  assert.equal(rows[1].Baki, '10000');
});
