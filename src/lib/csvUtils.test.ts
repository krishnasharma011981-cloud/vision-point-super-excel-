import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import * as XLSX from 'xlsx';
import {
  alignHeaderToCommonSchema,
  buildContextualSerialMap,
  cleanMobileNumber,
  computeAddExtraColumnDefaultUpdates,
  computeDeleteExtraColumnStudentUpdates,
  computeInsertRowSerialPlan,
  computeRenameExtraColumnStudentUpdates,
  computeShuffledStudentOrderUpdates,
  computeStudentReorderUpdates,
  extractBlankAndSparseSheetHeadings,
  extractCellFillHex,
  extractCommonBranchExtraHeaders,
  extractJaunpurHeadingAndBlankColumns,
  fuzzyDetectColumnMapping,
  getReadableTextColor,
  isExcelSummaryRow,
  mergeExtraColumnsWithConfig,
  normalizeImportedStudentRow,
  parseCsvText,
  parseSpreadsheetFile,
  sanitizeImportedStudentId,
} from './csvUtils';

const requireCjs = createRequire(import.meta.url);

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

test('fuzzyDetectColumnMapping separates TMA/Exam status from TMA Fee and Exam Fee', () => {
  const headers = [
    'Student Name',
    'Mobile No',
    'TMA',
    'Examination',
    'Course Fee',
    'Fees Jama',
    'Baki Fee',
    'TMA Fee',
    'Exam Fees',
  ];
  const mapping = fuzzyDetectColumnMapping(headers);
  assert.equal(mapping.tmaStatus, 'TMA');
  assert.equal(mapping.examinationStatus, 'Examination');
  assert.equal(mapping.totalFee, 'Course Fee');
  assert.equal(mapping.paidAmount, 'Fees Jama');
  assert.equal(mapping.pendingAmount, 'Baki Fee');
  assert.equal(mapping.tmaFee, 'TMA Fee');
  assert.equal(mapping.examFee, 'Exam Fees');
});

test('normalizeImportedStudentRow parses TMA Fee and Exam Fee cleanly without corrupting Course Fee', () => {
  const rawRow: Record<string, string> = {
    'Student Name': 'Ananya Tiwari',
    'Mobile No': '9611223344',
    'Course Fee': '12000',
    'Fees Jama': '7000',
    'TMA Fee': 'Rs. 1,500/-',
    'Exam Fee': '₹ 2,200',
  };
  const normalized = normalizeImportedStudentRow(rawRow, 2, 'vp_lookerganj', false);
  assert.equal(normalized.validationError, null);
  assert.equal(normalized.totalFee, 12000);
  assert.equal(normalized.paidAmount, 7000);
  assert.equal(normalized.pendingAmount, 5000);
  assert.equal(normalized.tmaFee, 1500);
  assert.equal(normalized.examFee, 2200);
  assert.equal(normalized.explicitTmaFeeDetected, true);
  assert.equal(normalized.explicitExamFeeDetected, true);
});

test('cleanMobileNumber extracts valid phone from multi-number cells', () => {
  assert.equal(cleanMobileNumber('9876543210 / 9123456789'), '9876543210');
  assert.equal(cleanMobileNumber('+91 96543-21098, 8800112233'), '9654321098');
});

test('extractCellFillHex resolves RGB, ARGB, theme === 0, tinted theme, and indexed fills', () => {
  const rgbCell = { t: 's', v: 'OK', s: { fgColor: { rgb: 'FFDCFCE7' } } } as unknown as XLSX.CellObject;
  assert.equal(extractCellFillHex(rgbCell), '#DCFCE7');

  const indexedCell = { t: 's', v: 'Warn', s: { fill: { patternType: 'solid', fgColor: { indexed: 43 } } } } as unknown as XLSX.CellObject;
  assert.equal(extractCellFillHex(indexedCell), '#FFFF99');

  const themeZeroTintedCell = {
    t: 's',
    v: 'Soft',
    s: { fill: { fgColor: { theme: 0, tint: -0.15 } } },
  } as unknown as XLSX.CellObject;
  const resolved = extractCellFillHex(themeZeroTintedCell);
  assert.match(resolved, /^#[0-9A-F]{6}$/);
  assert.notEqual(resolved, '#FFFFFF');
});

test('getReadableTextColor returns light or dark ink for contrast', () => {
  assert.equal(getReadableTextColor('#FFFF99'), '#08152E');
  assert.equal(getReadableTextColor('#1E3A8A'), '#FFFFFF');
});

test('isExcelSummaryRow detects footer TOTAL rows without dropping genuine students', () => {
  assert.equal(isExcelSummaryRow({ 'S.No': '', 'Student Name': 'TOTAL', 'Fees Jama': '45000' }), true);
  assert.equal(isExcelSummaryRow({ 'S.No': '', 'Student Name': 'Grand Total:', 'Total Fee': '120000' }), true);
  assert.equal(
    isExcelSummaryRow({ 'S.No': '1', 'Student Name': 'Total Khan', 'Mobile No': '9876543210', 'Fees Jama': '5000' }),
    false,
  );
});

test('explicitFeeDetected stays false when only TMA Fee or Exam Fee columns exist', () => {
  const row = normalizeImportedStudentRow(
    { 'Student Name': 'Karan Johar', 'Mobile No': '9811223344', 'TMA Fee': '500', 'Exam Fee': '1500' },
    1,
    'vp_lookerganj',
    false,
  );
  assert.equal(row.explicitFeeDetected, false);
  assert.equal(row.explicitTmaFeeDetected, true);
  assert.equal(row.explicitExamFeeDetected, true);
  assert.equal(row.tmaFee, 500);
  assert.equal(row.examFee, 1500);
});

test('parseSpreadsheetFile reads XLSX binary with styles and excludes footer summary row', async () => {
  const cjsXlsx = requireCjs('xlsx') as typeof XLSX;
  const wb = cjsXlsx.utils.book_new();
  const ws = cjsXlsx.utils.aoa_to_sheet([
    ['S.No', 'Student Name', 'Mobile No', 'Total Fee', 'Paid (Jama)'],
    ['1', 'Asha Devi', '9876543210', 12000, 12000],
    ['2', 'Riya Gupta', '9876543210', 12000, 6000],
    ['', 'Grand Total', '', 24000, 18000],
  ]);
  cjsXlsx.utils.book_append_sheet(wb, ws, 'Batch1');
  const rawBuf = cjsXlsx.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  const zip = cjsXlsx.CFB.read(rawBuf, { type: 'buffer' });
  const stylesEntry = cjsXlsx.CFB.find(zip, '/xl/styles.xml');
  const sheetEntry = cjsXlsx.CFB.find(zip, '/xl/worksheets/sheet1.xml');
  assert.ok(stylesEntry && sheetEntry);

  let stylesXml = Buffer.from(stylesEntry.content).toString('utf8');
  let sheetXml = Buffer.from(sheetEntry.content).toString('utf8');
  stylesXml = stylesXml
    .replace(/<fills count="\d+">/, '<fills count="4">')
    .replace(
      '</fills>',
      '<fill><patternFill patternType="solid"><fgColor rgb="FFFEF08A"/></patternFill></fill>' +
        '<fill><patternFill patternType="solid"><fgColor rgb="FFBBF7D0"/></patternFill></fill></fills>',
    )
    .replace(/<cellXfs count="\d+">/, '<cellXfs count="3">')
    .replace(
      '</cellXfs>',
      '<xf numFmtId="0" fontId="0" fillId="2" borderId="0" applyFill="1"/>' +
        '<xf numFmtId="0" fontId="0" fillId="3" borderId="0" applyFill="1"/></cellXfs>',
    );
  sheetXml = sheetXml
    .replace('<c r="A2"', '<c r="A2" s="1"')
    .replace('<c r="B2"', '<c r="B2" s="1"')
    .replace('<c r="C2"', '<c r="C2" s="1"')
    .replace('<c r="E3"', '<c r="E3" s="2"');
  stylesEntry.content = Buffer.from(stylesXml, 'utf8');
  sheetEntry.content = Buffer.from(sheetXml, 'utf8');

  const styledBytes = cjsXlsx.CFB.write(zip, { type: 'buffer', fileType: 'zip' }) as Buffer;
  const mockFile = {
    name: 'students.xlsx',
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    arrayBuffer: async () =>
      styledBytes.buffer.slice(styledBytes.byteOffset, styledBytes.byteOffset + styledBytes.byteLength),
  } as unknown as File;

  const parsed = await parseSpreadsheetFile(mockFile);
  assert.deepEqual(parsed.sheetNames, ['Batch1']);
  assert.equal(parsed.sheets.Batch1.length, 2);
  assert.equal(parsed.summaryRowsFilteredBySheet?.Batch1, 1);

  const first = normalizeImportedStudentRow(
    parsed.sheets.Batch1[0],
    1,
    'vp_lookerganj',
    false,
    undefined,
    true,
    12000,
    parsed.rowColorsBySheet?.Batch1?.[0],
  );
  assert.equal(first.rowColor, '#FEF08A');
  assert.equal(first.cellColors.studentName, '#FEF08A');

  const second = normalizeImportedStudentRow(
    parsed.sheets.Batch1[1],
    2,
    'vp_lookerganj',
    false,
    undefined,
    true,
    12000,
    parsed.rowColorsBySheet?.Batch1?.[1],
  );
  assert.equal(second.cellColors.paidAmount, '#BBF7D0');
});

test('sanitizeImportedStudentId rejects placeholders and keeps raw value in extraColumns', () => {
  for (const placeholder of ['Pending', 'N/A', 'NA', 'New', '-', '0', 'Applied', 'Not Allotted']) {
    assert.equal(sanitizeImportedStudentId(placeholder), '');
  }
  assert.equal(sanitizeImportedStudentId('NIOS-2026-0042'), 'NIOS-2026-0042');

  const row = normalizeImportedStudentRow(
    {
      'Enrolment No': 'Pending',
      'Student Name': 'Aarav Mishra',
      'Mobile No': '9876501234',
      'Total Fee': '12000',
      Paid: '6000',
    },
    1,
    'vp_lookerganj',
    false,
  );
  assert.equal(row.studentId, '');
  assert.equal(row.extraColumns['Enrolment No'], 'Pending');
  assert.equal(row.validationError, null);
});

test('isExcelSummaryRow preserves dotted-initial and Unicode names while flagging unlabeled totals', () => {
  assert.equal(
    isExcelSummaryRow({ 'S.No': '15', 'Student Name': 'R. K.', 'Fees Jama': '5000' }),
    false,
  );
  assert.equal(
    isExcelSummaryRow({ 'S.No': '16', 'Student Name': 'आरव', 'Fees Jama': '5000' }),
    false,
  );
  assert.equal(
    isExcelSummaryRow({ 'S.No': '', 'Student Name': '', 'Total Fee': '3912000', 'Paid': '3462875' }),
    true,
  );
});

test('parseSpreadsheetFile extracts all 326 student rows even with 70 Pending IDs + 1 footer total row', async () => {
  const cjsXlsx = requireCjs('xlsx') as typeof XLSX;
  const aoa: Array<Array<string | number>> = [
    ['S.No', 'Enrolment No', 'Student Name', 'Mobile No', 'Course Fee', 'Paid (Jama)'],
  ];
  for (let i = 1; i <= 326; i++) {
    aoa.push([
      i,
      i <= 70 ? 'Pending' : `EN2026${String(i).padStart(4, '0')}`,
      `Student ${i}`,
      `98${String(10000000 + i)}`,
      12000,
      i % 2 === 0 ? 12000 : 6000,
    ]);
  }
  aoa.push(['', '', 'Grand Total', '', 326 * 12000, 163 * 12000 + 163 * 6000]);

  const wb = cjsXlsx.utils.book_new();
  const ws = cjsXlsx.utils.aoa_to_sheet(aoa);
  cjsXlsx.utils.book_append_sheet(wb, ws, 'Sheet1');
  const buf = cjsXlsx.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  const mockFile = {
    name: 'Book look.xlsx',
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  } as unknown as File;

  const parsed = await parseSpreadsheetFile(mockFile);
  assert.equal(parsed.sheets.Sheet1.length, 326);
  assert.equal(parsed.summaryRowsFilteredBySheet?.Sheet1, 1);
  assert.equal(parsed.excludedSummaryRowsBySheet?.Sheet1?.length, 1);
});

test('1-letter student name is padded cleanly and numbered S.No row is never treated as footer total', () => {
  assert.equal(
    isExcelSummaryRow({ 'S.No': '326', 'Student Name': 'K', 'Course Fee': '12000', 'Paid': '12000' }),
    false,
  );
  assert.equal(
    isExcelSummaryRow({ 'S.No': '326', 'Student Name': 'Total Khan', 'Course Fee': '12000' }),
    false,
  );
  const singleLetter = normalizeImportedStudentRow(
    { 'S.No': '10', 'Student Name': 'K', 'Mobile No': '9811223344', 'Total Fee': '12000' },
    10,
    'vp_lookerganj',
    false,
  );
  assert.equal(singleLetter.validationError, null);
  assert.equal(singleLetter.studentName, 'K.');
});

test('headerless 446-row Civil Lines workbook keeps ALL 446 rows and auto-detects fields & math fees without confusing A1126307633 or "fees low"', async () => {
  const cjsXlsx = requireCjs('xlsx') as typeof XLSX;
  const names = [
    'RUDRANSH PANDEY',
    'BUSHRA KAYNAT',
    'ANKIT SAHU',
    'ALIZA NAAZ',
    'ANCHAL',
    'SHUBH CHAURASIYA',
    'SHIVANSH TIWARI',
    'ADITI VERMA',
    'ANSHU YADAV',
  ];
  const aoa: Array<Array<string | number>> = [];
  for (let i = 0; i < 446; i++) {
    const first = String.fromCharCode(65 + (i % 26));
    const second = String.fromCharCode(65 + (Math.floor(i / 26) % 26));
    const name = i < names.length ? names[i] : `SHARMA ${first}${second} VERMA`;
    const enrolId = i === 8 ? 'A1126307633' : `A112630${String(7625 + i).padStart(4, '0')}`;
    const phone = `98${String(10000000 + i)}`;
    const total = 15000;
    const paid = i % 2 === 0 ? 10000 : 15000;
    const pending = total - paid;
    const remark = i === 8 ? 'fees low' : i % 3 === 0 ? 'fees low' : 'regular batch';
    aoa.push([i + 1, enrolId, name, phone, total, paid, pending, remark]);
  }

  const wb = cjsXlsx.utils.book_new();
  const ws = cjsXlsx.utils.aoa_to_sheet(aoa);
  cjsXlsx.utils.book_append_sheet(wb, ws, 'CivilLines');
  const buf = cjsXlsx.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  const mockFile = {
    name: 'civil_lines_446.xlsx',
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  } as unknown as File;

  const parsed = await parseSpreadsheetFile(mockFile);
  const rows = parsed.sheets.CivilLines;
  const headers = parsed.headersBySheet.CivilLines;
  assert.equal(rows.length, 446);
  assert.equal(rows[0][headers[2]], 'RUDRANSH PANDEY');
  assert.equal(rows[8][headers[2]], 'ANSHU YADAV');

  const mapping = fuzzyDetectColumnMapping(headers, rows);
  assert.equal(mapping.studentId, 'Column_2');
  assert.equal(mapping.studentName, 'Column_3');
  assert.equal(mapping.mobileNumber, 'Column_4');
  assert.equal(mapping.totalFee, 'Column_5');
  assert.equal(mapping.paidAmount, 'Column_6');
  assert.equal(mapping.pendingAmount, 'Column_7');
  assert.equal(mapping.additionalRemarks, 'Column_8');

  const ninth = normalizeImportedStudentRow(rows[8], 9, 'vp_civillines', false, mapping);
  assert.equal(ninth.studentName, 'ANSHU YADAV');
  assert.equal(ninth.studentId, 'A1126307633');
  assert.equal(ninth.mobileNumber, '9810000008');
  assert.equal(ninth.totalFee, 15000);
  assert.equal(ninth.paidAmount, 10000);
  assert.equal(ninth.pendingAmount, 5000);
  assert.equal(ninth.additionalRemarks, 'fees low');
});

test('headerless 2-column fee auto-detection derives pending mathematically without headers', () => {
  const csv = [
    '1,Rohan Singh,9876543210,14000,9000',
    '2,Priya Patel,9811223344,12000,12000',
    '3,Amit Verma,9722334455,15000,5000',
    '4,Sneha Gupta,9633445566,12000,0',
  ].join('\n');
  const rows = parseCsvText(csv);
  assert.equal(rows.length, 4);
  const mapping = fuzzyDetectColumnMapping(Object.keys(rows[0]), rows);
  assert.equal(mapping.studentName, 'Column_2');
  assert.equal(mapping.mobileNumber, 'Column_3');
  assert.equal(mapping.totalFee, 'Column_4');
  assert.equal(mapping.paidAmount, 'Column_5');

  const third = normalizeImportedStudentRow(rows[2], 3, 'vp_civillines', false, mapping);
  assert.equal(third.totalFee, 15000);
  assert.equal(third.paidAmount, 5000);
  assert.equal(third.pendingAmount, 10000);
  assert.equal(third.recoveryStatus, 'Partial');
});

test('extractCommonBranchExtraHeaders & alignHeaderToCommonSchema unify all centres onto Lookerganj headings', () => {
  const sampleStudents: Array<{
    centreId: 'vp_lookerganj' | 'vp_civillines';
    extraColumns: Record<string, string>;
  }> = [
    {
      centreId: 'vp_civillines',
      extraColumns: { "Father's Name": 'Rameshwar', 'Batch Timing': 'Evening', 'Roll Code': 'CLN-9' },
    },
    {
      centreId: 'vp_lookerganj',
      extraColumns: { 'Father Name': 'Suresh', 'Batch Timing': 'Morning', Medium: 'Hindi' },
    },
  ];
  const common = extractCommonBranchExtraHeaders(sampleStudents);
  // Lookerganj headings come first and canonicalize duplicates like Father's Name -> Father Name
  assert.deepEqual(common, ['Father Name', 'Batch Timing', 'Medium', 'Roll Code']);
  assert.equal(alignHeaderToCommonSchema("Father's Name", common), 'Father Name');

  const clnNormalized = normalizeImportedStudentRow(
    {
      'Student Name': 'Karan Yadav',
      'Mobile No': '9876543211',
      "Father's Name": 'Mahesh Yadav',
      'Batch-Timing': '10 AM',
      'Total Fee': '12000',
    },
    1,
    'vp_civillines',
    false,
    undefined,
    true,
    12000,
    undefined,
    common,
  );
  assert.equal(clnNormalized.extraColumns['Father Name'], 'Mahesh Yadav');
  assert.equal(clnNormalized.extraColumns['Batch Timing'], '10 AM');
});

test('computeStudentReorderUpdates moves rows cleanly into middle with minimal serial diffs', () => {
  const rows = [
    { studentId: 'S1', serialNumber: 1, studentName: 'Aarav', centreId: 'vp_lookerganj' as const },
    { studentId: 'S2', serialNumber: 2, studentName: 'Bhavna', centreId: 'vp_lookerganj' as const },
    { studentId: 'S3', serialNumber: 3, studentName: 'Chetan', centreId: 'vp_lookerganj' as const },
    { studentId: 'S4', serialNumber: 4, studentName: 'Diya', centreId: 'vp_lookerganj' as const },
    { studentId: 'S5', serialNumber: 5, studentName: 'Esha', centreId: 'vp_lookerganj' as const },
  ];

  // Drag row #5 (Esha) into middle position #2 (index 1)
  const updates = computeStudentReorderUpdates(rows, 4, 1);
  assert.deepEqual(updates, [
    { studentId: 'S5', serialNumber: 2 },
    { studentId: 'S2', serialNumber: 3 },
    { studentId: 'S3', serialNumber: 4 },
    { studentId: 'S4', serialNumber: 5 },
  ]);

  // Apply updates and verify buildContextualSerialMap matches exact visual order: S1, S5, S2, S3, S4
  const mapById = new Map(updates.map((u) => [u.studentId, u.serialNumber]));
  const updated = rows.map((r) => ({ ...r, serialNumber: mapById.get(r.studentId) ?? r.serialNumber }));
  const serialMap = buildContextualSerialMap(updated, 'vp_lookerganj');
  assert.equal(serialMap.get('S1'), 1);
  assert.equal(serialMap.get('S5'), 2);
  assert.equal(serialMap.get('S2'), 3);
  assert.equal(serialMap.get('S3'), 4);
  assert.equal(serialMap.get('S4'), 5);

  // Moving adjacent rows #1 -> #2 updates only 2 docs
  const adjacent = computeStudentReorderUpdates(rows, 0, 1);
  assert.equal(adjacent.length, 2);
});

test('computeShuffledStudentOrderUpdates preserves unique ascending slots and changes order', () => {
  const rows = [
    { studentId: 'A', serialNumber: 10 },
    { studentId: 'B', serialNumber: 20 },
    { studentId: 'C', serialNumber: 30 },
    { studentId: 'D', serialNumber: 40 },
  ];
  const updates = computeShuffledStudentOrderUpdates(rows);
  assert.ok(updates.length >= 2);
  const finalMap = new Map(rows.map((r) => [r.studentId, r.serialNumber]));
  updates.forEach((u) => finalMap.set(u.studentId, u.serialNumber));
  const serialValues = Array.from(finalMap.values()).sort((x, y) => x - y);
  assert.deepEqual(serialValues, [10, 20, 30, 40]);
});

test('computeInsertRowSerialPlan inserts at top, middle, and bottom without serial collisions', () => {
  const scopedRows = [
    { studentId: 'L1', serialNumber: 1, studentName: 'Ananya', centreId: 'vp_lookerganj' as const },
    { studentId: 'L2', serialNumber: 2, studentName: 'Bilal', centreId: 'vp_lookerganj' as const },
    { studentId: 'L3', serialNumber: 3, studentName: 'Chirag', centreId: 'vp_lookerganj' as const },
    { studentId: 'L4', serialNumber: 8, studentName: 'Dev', centreId: 'vp_lookerganj' as const },
  ];

  // Middle insert before L3 (index 2): newSerialNumber = 3, shifts L3 -> 4, stops before L4 (8 >= 5!)
  const midPlan = computeInsertRowSerialPlan(scopedRows, 2);
  assert.equal(midPlan.newSerialNumber, 3);
  assert.deepEqual(midPlan.shiftUpdates, [{ studentId: 'L3', serialNumber: 4 }]);

  // Insert at index 0 when slot[0] === 1: newSerialNumber = 1, shifts L1..L3 by +1, stops before L4(8)
  const topPlan = computeInsertRowSerialPlan(scopedRows, 0);
  assert.equal(topPlan.newSerialNumber, 1);
  assert.deepEqual(topPlan.shiftUpdates, [
    { studentId: 'L1', serialNumber: 2 },
    { studentId: 'L2', serialNumber: 3 },
    { studentId: 'L3', serialNumber: 4 },
  ]);

  // Append at end with allStudents containing another centre's higher serial (e.g. 500)
  const endPlan = computeInsertRowSerialPlan(scopedRows, scopedRows.length, [
    ...scopedRows,
    { studentId: 'CL1', serialNumber: 500, studentName: 'Zoya', centreId: 'vp_lookerganj' as const },
  ]);
  assert.equal(endPlan.newSerialNumber, 501);
  assert.deepEqual(endPlan.shiftUpdates, []);
});

test('mergeExtraColumnsWithConfig combines customColumns, filters deleted columns, and deduplicates canonically', () => {
  const merged = mergeExtraColumnsWithConfig(['Father Name', 'Old Col', 'Roll Code', 'Batch-Timing'], {
    customColumns: ['Batch Timing', 'Mentor'],
    deletedExtraColumns: ['Old Col'],
  });
  assert.deepEqual(merged, ['Batch Timing', 'Mentor', 'Father Name', 'Roll Code']);
});

test('computeRenameExtraColumnStudentUpdates migrates extraColumns and cellColors accurately', () => {
  const rows: Array<{
    studentId: string;
    extraColumns?: Record<string, string>;
    cellColors?: Record<string, string>;
  }> = [
    {
      studentId: 'S1',
      extraColumns: { 'Batch Timing': 'Morning', Medium: 'Hindi' },
      cellColors: { 'extra:Batch Timing': '#FEF08A', studentName: '#BBF7D0' },
    },
    {
      studentId: 'S2',
      extraColumns: { Medium: 'English' },
      cellColors: { studentName: '#BBF7D0' },
    },
  ];
  const updates = computeRenameExtraColumnStudentUpdates(rows, 'Batch Timing', 'Batch Slot');
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0], {
    studentId: 'S1',
    extraColumns: { 'Batch Slot': 'Morning', Medium: 'Hindi' },
    cellColors: { 'extra:Batch Slot': '#FEF08A', studentName: '#BBF7D0' },
  });
});

test('computeDeleteExtraColumnStudentUpdates strips only deleted extra column & cell color', () => {
  const rows: Array<{
    studentId: string;
    extraColumns?: Record<string, string>;
    cellColors?: Record<string, string>;
  }> = [
    {
      studentId: 'S1',
      extraColumns: { Remarks2: 'Fee Soon', Medium: 'Hindi' },
      cellColors: { 'extra:Remarks2': '#FEE2E2', paidAmount: '#DCFCE7' },
    },
    {
      studentId: 'S2',
      extraColumns: { Medium: 'English' },
    },
  ];
  const updates = computeDeleteExtraColumnStudentUpdates(rows, 'Remarks2');
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0], {
    studentId: 'S1',
    extraColumns: { Medium: 'Hindi' },
    cellColors: { paidAmount: '#DCFCE7' },
  });
});

test('computeAddExtraColumnDefaultUpdates backfills default values safely within 35-key rule limit', () => {
  const maxedExtras: Record<string, string> = {};
  for (let i = 1; i <= 35; i++) maxedExtras[`C${i}`] = `V${i}`;

  const rows: Array<{
    studentId: string;
    extraColumns?: Record<string, string>;
  }> = [
    { studentId: 'S1', extraColumns: {} },
    { studentId: 'S2', extraColumns: { Mentor: 'Already Assigned' } },
    { studentId: 'S3', extraColumns: maxedExtras },
  ];
  const updates = computeAddExtraColumnDefaultUpdates(rows, 'Mentor', 'Unassigned');
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0], {
    studentId: 'S1',
    extraColumns: { Mentor: 'Unassigned' },
  });
});

test('normalizeImportedStudentRow defaults missing or blank attendance to Not Attending so online attendance starts at 0%', () => {
  const blankAtt = normalizeImportedStudentRow(
    { 'Student Name': 'Priya Tiwari', 'Mobile No': '9812345678' },
    1,
    'vp_lookerganj',
    false,
  );
  assert.equal(blankAtt.classAttendanceStatus, 'Not Attending');

  const explicitReg = normalizeImportedStudentRow(
    { 'Student Name': 'Rohit Verma', 'Mobile No': '9812345678', Attendance: 'Regular' },
    2,
    'vp_lookerganj',
    false,
  );
  assert.equal(explicitReg.classAttendanceStatus, 'Regular');

  const explicitIrreg = normalizeImportedStudentRow(
    { 'Student Name': 'Neha Singh', 'Mobile No': '9812345678', Attendance: 'Irregular' },
    3,
    'vp_lookerganj',
    false,
  );
  assert.equal(explicitIrreg.classAttendanceStatus, 'Irregular');

  const explicitYes = normalizeImportedStudentRow(
    { 'Student Name': 'Amit Kumar', 'Mobile No': '9812345678', Attendance: 'Yes' },
    4,
    'vp_lookerganj',
    false,
  );
  assert.equal(explicitYes.classAttendanceStatus, 'Regular');
});

test('extractJaunpurHeadingAndBlankColumns shares Jaunpur heading-only/blank columns without pulling Lookerganj 35 raw columns', () => {
  const lkgExtra: Record<string, string> = {};
  for (let i = 1; i <= 35; i++) lkgExtra[`LookerganjCol_${i}`] = `Val_${i}`;

  const students: Array<{
    centreId: 'vp_lookerganj' | 'xis_jaunpur';
    extraColumns: Record<string, string>;
  }> = [
    { centreId: 'vp_lookerganj', extraColumns: lkgExtra },
    {
      centreId: 'xis_jaunpur',
      extraColumns: { 'Form Status': '', 'Remark Note': 'Pending call', '__EMPTY_1': 'x' },
    },
    {
      centreId: 'xis_jaunpur',
      extraColumns: { 'Form Status': '', 'Documents Verified': '' },
    },
  ];

  const configs = [
    {
      configId: 'xis_jaunpur',
      customColumns: ['Jaunpur Blank Heading', 'Removed Col'],
      deletedExtraColumns: [],
    },
    {
      configId: 'global',
      customColumns: [],
      deletedExtraColumns: ['Removed Col'],
    },
  ];

  const shared = extractJaunpurHeadingAndBlankColumns(students, configs);
  assert.deepEqual(shared, [
    'Jaunpur Blank Heading',
    'Form Status',
    'Remark Note',
    'Documents Verified',
  ]);
  assert.equal(shared.some((k) => k.startsWith('LookerganjCol_')), false);
});

test('extractBlankAndSparseSheetHeadings captures 100%-blank uploaded headings and ignores mapped or placeholder columns', () => {
  const headers = [
    'S.No',
    'Student Name',
    'Mobile No',
    'Total Fee',
    'Verification Blank Col',
    'Parent Sign',
    '__EMPTY',
    'col_2',
  ];
  const mapping = fuzzyDetectColumnMapping(headers);
  const rawRows = [
    {
      'S.No': '1',
      'Student Name': 'Rohan',
      'Mobile No': '9876543210',
      'Total Fee': '12000',
      'Verification Blank Col': '',
      'Parent Sign': '',
      __EMPTY: '',
      col_2: '',
    },
    {
      'S.No': '2',
      'Student Name': 'Priya',
      'Mobile No': '9876543211',
      'Total Fee': '12000',
      'Verification Blank Col': '',
      'Parent Sign': '',
      __EMPTY: '',
      col_2: '',
    },
  ];

  const blankHeadings = extractBlankAndSparseSheetHeadings(headers, mapping, rawRows, 'vp_lookerganj');
  assert.deepEqual(blankHeadings, ['Verification Blank Col', 'Parent Sign']);
});
