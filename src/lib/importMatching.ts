import { CENTRE_MAP } from '../constants/centres';
import { maskMobileNumber } from './analyticsMath';
import {
  cleanMobileNumber,
  normalizeImportedStudentRow,
  normalizeStudentMatchName,
  type ExcelColumnMapping,
  type NormalizedImportStudent,
} from './csvUtils';
import type { CentreId, Student } from '../types/domain';

export function getFirstNameToken(name: string): string {
  return name.trim().toLowerCase().split(/\s+/)[0] || '';
}

export function areMobilesCompatibleForNameMatch(
  mobA: string,
  hasValidMobA: boolean,
  mobB: string,
  rawMobB: string,
): boolean {
  const cleanB = cleanMobileNumber(mobB);
  const hasValidMobB =
    cleanB.length >= 7 && rawMobB.trim().toLowerCase() !== 'not provided';
  if (hasValidMobA && hasValidMobB) {
    return mobA === cleanB;
  }
  return true;
}

export interface PreviewImportRow extends NormalizedImportStudent {
  origIndex: number;
  duplicateReason: string | null;
  matchedExisting: Student | null;
  operation: 'create' | 'update';
  raw: Record<string, string>;
}

export interface BuildImportPreviewParams {
  rawRows: ReadonlyArray<Record<string, string>>;
  rowColors?: ReadonlyArray<Record<string, string>>;
  fallbackCentre: CentreId;
  allowCentreOverride: boolean;
  isCentreLocked: boolean;
  columnMapping: ExcelColumnMapping;
  allowMissingMobile: boolean;
  allowDuplicateRowsInSheet: boolean;
  defaultTotalFee: number;
  importMode: 'upsert' | 'skip_duplicates' | 'replace_all';
  mode: 'full' | 'fee_sync' | 'academic_sync';
  isSuperAdmin: boolean;
  currentUserCentreId: CentreId;
  editedOverrides: Record<number, { studentName?: string; mobileNumber?: string }>;
  existingStudents: ReadonlyArray<Student>;
  commonExtraHeadings: string[];
}

export function buildImportPreviewRows(params: BuildImportPreviewParams): PreviewImportRow[] {
  const {
    rawRows,
    rowColors = [],
    fallbackCentre,
    allowCentreOverride,
    isCentreLocked,
    columnMapping,
    allowMissingMobile,
    allowDuplicateRowsInSheet,
    defaultTotalFee,
    importMode,
    mode,
    isSuperAdmin,
    currentUserCentreId,
    editedOverrides,
    existingStudents,
    commonExtraHeadings,
  } = params;

  const existingById = new Map<string, Student>();
  const existingByCentreNameMobile = new Map<string, Student[]>();
  const existingMobileListByCentre = new Map<string, Student[]>();
  const existingListByCentreName = new Map<string, Student[]>();
  const existingGlobalByNameMobile = new Map<string, Student[]>();
  const existingGlobalMobileList = new Map<string, Student[]>();
  const existingGlobalListByName = new Map<string, Student[]>();

  const sortedExisting = existingStudents
    .slice()
    .sort((a, b) => (a.serialNumber || 0) - (b.serialNumber || 0));

  for (const s of sortedExisting) {
    existingById.set(s.studentId.trim().toLowerCase(), s);

    const m = cleanMobileNumber(s.mobileNumber);
    const hasMob = m.length >= 7 && s.mobileNumber.toLowerCase() !== 'not provided';
    const normName = normalizeStudentMatchName(s.studentName);

    if (normName && hasMob) {
      const cmKey = `${s.centreId}::${normName}::${m}`;
      const cmList = existingByCentreNameMobile.get(cmKey) || [];
      cmList.push(s);
      existingByCentreNameMobile.set(cmKey, cmList);

      const gmKey = `${normName}::${m}`;
      const gmList = existingGlobalByNameMobile.get(gmKey) || [];
      gmList.push(s);
      existingGlobalByNameMobile.set(gmKey, gmList);
    }

    if (hasMob) {
      const cMobKey = `${s.centreId}::${m}`;
      const cMobList = existingMobileListByCentre.get(cMobKey) || [];
      cMobList.push(s);
      existingMobileListByCentre.set(cMobKey, cMobList);

      const gMobList = existingGlobalMobileList.get(m) || [];
      gMobList.push(s);
      existingGlobalMobileList.set(m, gMobList);
    }

    if (normName) {
      const cnKey = `${s.centreId}::${normName}`;
      const cnList = existingListByCentreName.get(cnKey) || [];
      cnList.push(s);
      existingListByCentreName.set(cnKey, cnList);

      const gnList = existingGlobalListByName.get(normName) || [];
      gnList.push(s);
      existingGlobalListByName.set(normName, gnList);
    }
  }

  // Pass 1: normalize rows and detect non-unique Student ID columns
  const preliminary = rawRows.map((raw, idx) => {
    const normalized = normalizeImportedStudentRow(
      raw,
      idx + 1,
      fallbackCentre,
      allowCentreOverride,
      columnMapping,
      allowMissingMobile,
      defaultTotalFee,
      rowColors[idx],
      commonExtraHeadings,
    );

    const override = editedOverrides[idx];
    if (override?.studentName !== undefined) {
      const trimmedName = override.studentName.trim().slice(0, 120);
      normalized.studentName =
        trimmedName.length === 1 && /\p{L}/u.test(trimmedName) ? `${trimmedName}.` : trimmedName;
    }
    if (override?.mobileNumber !== undefined) {
      const cleaned = cleanMobileNumber(override.mobileNumber);
      normalized.mobileNumber =
        cleaned.length >= 7 && cleaned.length <= 20
          ? cleaned
          : allowMissingMobile
            ? 'Not Provided'
            : cleaned;
    }

    if (normalized.studentName.length < 2) {
      normalized.validationError = 'Student Name (min 2 chars) required.';
    } else if (normalized.mobileNumber.length < 7 || normalized.mobileNumber.length > 20) {
      normalized.validationError = 'Mobile Number (7–15 digits) required.';
    } else {
      normalized.validationError = null;
    }

    return { normalized, raw, origIndex: idx };
  });

  // If the same Student ID appears across rows with DIFFERENT student names, it is a batch/session/placeholder
  // code rather than a unique primary key — clear it so no students are dropped.
  const idToDistinctNames = new Map<string, Set<string>>();
  preliminary.forEach(({ normalized }) => {
    const idKey = normalized.studentId.trim().toLowerCase();
    const nameKey = normalized.studentName.trim().toLowerCase();
    if (!idKey) return;
    const set = idToDistinctNames.get(idKey) || new Set<string>();
    if (nameKey) set.add(nameKey);
    idToDistinctNames.set(idKey, set);
  });

  const nonUniqueIds = new Set<string>();
  for (const [idKey, names] of idToDistinctNames.entries()) {
    if (names.size > 1) nonUniqueIds.add(idKey);
  }

  const seenIds = new Set<string>();
  const seenExactSignatures = new Set<string>();
  const seenMatchedExistingIds = new Set<string>();

  // Cross-centre matching is ONLY allowed when Super Admin is running multi-branch fee_sync
  // without locking to a single target centre and without an explicit Centre column.
  // In normal branch import (e.g. importing Civil Lines sheet), NEVER match/steal rows into other centres.
  const allowCrossCentreMatch =
    isSuperAdmin && mode === 'fee_sync' && !isCentreLocked && !columnMapping.centre;

  return preliminary.map(({ normalized, raw, origIndex }) => {
    const idColHeader = columnMapping.studentId;
    if (normalized.studentId && nonUniqueIds.has(normalized.studentId.trim().toLowerCase())) {
      if (idColHeader && raw[idColHeader]) {
        const cleanKey = idColHeader.trim().slice(0, 50);
        if (
          cleanKey &&
          normalized.extraColumns[cleanKey] === undefined &&
          Object.keys(normalized.extraColumns).length < 35
        ) {
          normalized.extraColumns[cleanKey] = String(raw[idColHeader]).trim().slice(0, 300);
        }
      }
      normalized.studentId = '';
    }

    const normNameKey = normalizeStudentMatchName(normalized.studentName);
    const normMobile = cleanMobileNumber(normalized.mobileNumber);
    const hasValidPhone =
      normMobile.length >= 7 && normalized.mobileNumber.toLowerCase() !== 'not provided';

    const pickUnclaimedCandidate = (candidates: Student[]): Student | null => {
      for (const cand of candidates) {
        if (seenMatchedExistingIds.has(cand.studentId)) continue;
        if (areMobilesCompatibleForNameMatch(normMobile, hasValidPhone, cand.mobileNumber, cand.mobileNumber)) {
          return cand;
        }
      }
      return null;
    };

    let matchedExisting: Student | null = null;
    if (importMode !== 'replace_all') {
      if (normalized.studentId) {
        const idCandidate = existingById.get(normalized.studentId.toLowerCase()) || null;
        if (idCandidate && !seenMatchedExistingIds.has(idCandidate.studentId)) {
          if (idCandidate.centreId === normalized.centreId || allowCrossCentreMatch || !isSuperAdmin) {
            matchedExisting = idCandidate;
          } else {
            // Same external enrolment/student ID exists in another branch while importing into a locked branch:
            // preserve raw ID in extraColumns and let importer allocate a fresh branch-scoped ID.
            if (idColHeader && raw[idColHeader]) {
              const cleanKey = idColHeader.trim().slice(0, 50);
              if (
                cleanKey &&
                normalized.extraColumns[cleanKey] === undefined &&
                Object.keys(normalized.extraColumns).length < 35
              ) {
                normalized.extraColumns[cleanKey] = String(raw[idColHeader]).trim().slice(0, 300);
              }
            }
            normalized.studentId = '';
          }
        }
      }

      if (!matchedExisting && hasValidPhone && normNameKey.length >= 2) {
        const exactList =
          existingByCentreNameMobile.get(`${normalized.centreId}::${normNameKey}::${normMobile}`) || [];
        matchedExisting = pickUnclaimedCandidate(exactList);
      }

      if (!matchedExisting && hasValidPhone && normNameKey.length >= 2) {
        const candidates =
          existingMobileListByCentre.get(`${normalized.centreId}::${normMobile}`) || [];
        const nameMatched = candidates.filter((cand) => {
          if (seenMatchedExistingIds.has(cand.studentId)) return false;
          const candNameKey = normalizeStudentMatchName(cand.studentName);
          const firstA = getFirstNameToken(normNameKey);
          const firstB = getFirstNameToken(candNameKey);
          return (
            (firstA.length >= 3 && firstA === firstB) ||
            normNameKey.includes(candNameKey) ||
            candNameKey.includes(normNameKey)
          );
        });
        if (nameMatched.length > 0) {
          matchedExisting = nameMatched[0];
        }
      }

      if (!matchedExisting && normNameKey.length >= 2) {
        const nameCands =
          existingListByCentreName.get(`${normalized.centreId}::${normNameKey}`) || [];
        matchedExisting = pickUnclaimedCandidate(nameCands);
      }

      if (!matchedExisting && allowCrossCentreMatch && normNameKey.length >= 2) {
        if (hasValidPhone) {
          const globalExactList =
            existingGlobalByNameMobile.get(`${normNameKey}::${normMobile}`) || [];
          matchedExisting = pickUnclaimedCandidate(globalExactList);
          if (!matchedExisting) {
            const globalCands = existingGlobalMobileList.get(normMobile) || [];
            const nameMatched = globalCands.filter((cand) => {
              if (seenMatchedExistingIds.has(cand.studentId)) return false;
              const candNameKey = normalizeStudentMatchName(cand.studentName);
              const firstA = getFirstNameToken(normNameKey);
              const firstB = getFirstNameToken(candNameKey);
              return (
                (firstA.length >= 3 && firstA === firstB) ||
                normNameKey.includes(candNameKey) ||
                candNameKey.includes(normNameKey)
              );
            });
            if (nameMatched.length > 0) {
              matchedExisting = nameMatched[0];
            }
          }
        }
        if (!matchedExisting) {
          const globalCands = existingGlobalListByName.get(normNameKey) || [];
          matchedExisting = pickUnclaimedCandidate(globalCands);
        }
      }
    }

    // Only allow matchedExisting to set centreId during cross-centre fee_sync mode
    if (matchedExisting && allowCrossCentreMatch && !columnMapping.centre) {
      normalized.centreId = matchedExisting.centreId;
      normalized.centreName = CENTRE_MAP[matchedExisting.centreId]?.name || matchedExisting.centreName;
    }

    // Never allow two rows in the same Excel sheet to update the same DB doc ID
    if (matchedExisting && seenMatchedExistingIds.has(matchedExisting.studentId)) {
      matchedExisting = null;
      normalized.studentId = '';
    }
    if (matchedExisting) {
      seenMatchedExistingIds.add(matchedExisting.studentId);
    }

    let duplicateReason: string | null = null;
    const sheetIdKey = (matchedExisting?.studentId || normalized.studentId).toLowerCase();
    if (sheetIdKey && seenIds.has(sheetIdKey)) {
      if (allowDuplicateRowsInSheet) {
        normalized.studentId = '';
      } else {
        duplicateReason = `Duplicate Student ID "${matchedExisting?.studentId || normalized.studentId}" in sheet.`;
      }
    }
    if (sheetIdKey && !duplicateReason) {
      seenIds.add(sheetIdKey);
    }

    // Only treat rows as duplicates if Name + Mobile + ID + Fee + Subject + Remarks + all extra columns are identical
    if (
      !allowDuplicateRowsInSheet &&
      !duplicateReason &&
      normalized.studentName.trim().length >= 2 &&
      normalized.mobileNumber.length >= 7 &&
      normalized.mobileNumber.toLowerCase() !== 'not provided'
    ) {
      const extraSig = Object.entries(normalized.extraColumns)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v.trim().toLowerCase()}`)
        .join('|');
      const sig = `${normalized.centreId}::${normalized.studentId.toLowerCase()}::${normalized.studentName.trim().toLowerCase()}::${normalized.mobileNumber}::${normalized.totalFee}::${normalized.paidAmount}::${normalized.subject.trim().toLowerCase()}::${normalized.additionalRemarks.trim().toLowerCase()}::${extraSig}`;
      if (seenExactSignatures.has(sig)) {
        duplicateReason = `Duplicate row "${normalized.studentName}" (${maskMobileNumber(normalized.mobileNumber)}) in sheet.`;
      }
      seenExactSignatures.add(sig);
    }

    if (!duplicateReason && matchedExisting && importMode === 'skip_duplicates') {
      duplicateReason = `Already exists (#${matchedExisting.serialNumber} ${matchedExisting.studentName}).`;
    }

    if (
      !duplicateReason &&
      matchedExisting &&
      importMode === 'upsert' &&
      !isSuperAdmin &&
      matchedExisting.centreId !== currentUserCentreId
    ) {
      duplicateReason = 'Matches student in another centre (read-only).';
    }

    const operation: 'create' | 'update' =
      matchedExisting && importMode === 'upsert' ? 'update' : 'create';

    return { ...normalized, origIndex, duplicateReason, matchedExisting, operation, raw };
  });
}
