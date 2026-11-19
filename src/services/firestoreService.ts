import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore';
import {
  BOOTSTRAPPED_OWNER_EMAIL,
  CANONICAL_CENTRES,
  CENTRE_MAP,
  DEPARTMENT_LABELS,
  isBootstrappedOwnerEmail,
} from '../constants/centres';
import { computeFeeSyncPlanFromStudents, isUntouchedAutoImportDefaultFee } from '../lib/analyticsMath';
import { countStudentSubjects, isMockSubjectValue, sanitizeRealSubject } from '../lib/csvUtils';
import { db, handleFirestoreError, OperationType } from '../lib/firebase';
import type {
  ActivityLog,
  AdmissionRecord,
  Centre,
  CentreId,
  DepartmentId,
  DirectMessage,
  DirectMessageType,
  EditRequest,
  EmployeeReport,
  EmployeeReportStatus,
  ExcelSheetConfig,
  FeeFollowUpStatus,
  FeeRecoveryRecord,
  LocationVerification,
  NotificationItem,
  OnlineClassRecord,
  PracticalRecord,
  RecoveryStatus,
  StaffInvite,
  Student,
  SystemSettings,
  TmaRecord,
  UserAccount,
  UserDepartment,
  UserRole,
  CallTaskStatus,
  WorkAssignment,
  WorkAssignmentDepartment,
  WorkAssignmentStatus,
  WorkAssignmentTask,
} from '../types/domain';
import {
  canManageAssignmentForCentre,
  extractStudentCallingNumber,
  extractStudentFatherName,
  formatLocalDateIso,
  formatStoredFollowUpDateTime,
  getStudentsAssignedTodayMap,
  mapCallStatusToFeeFollowUp,
  sanitizeFirestoreDocId,
  WORK_ASSIGNMENT_DEPARTMENT_LABELS,
} from '../lib/workAssignment';
import {
  type FullDatabaseBackupPayload,
  sanitizeAdmissionForRestore,
  sanitizeCentreForRestore,
  sanitizeExcelSheetConfigForRestore,
  sanitizeFeeRecoveryForRestore,
  sanitizeOnlineClassForRestore,
  sanitizePracticalForRestore,
  sanitizeStudentForRestore,
  sanitizeTmaForRestore,
  sanitizeWorkAssignmentForRestore,
  sanitizeWorkAssignmentTaskForRestore,
} from '../lib/databaseBackup';

export function getStudentDeptLockField(
  department: DepartmentId | UserDepartment,
): 'tmaLocked' | 'practicalLocked' | 'onlineClassesLocked' | 'admissionLocked' | null {
  switch (department) {
    case 'tma':
      return 'tmaLocked';
    case 'practical':
      return 'practicalLocked';
    case 'online_classes':
      return 'onlineClassesLocked';
    case 'admission':
      return 'admissionLocked';
    default:
      return null;
  }
}

export function isStudentDeptLockedForEmployee(
  student: Student,
  department: DepartmentId | UserDepartment,
): boolean {
  const field = getStudentDeptLockField(department);
  if (!field) return true;
  return Boolean(student[field]);
}

const DEPT_COLLECTION_MAP: Partial<Record<DepartmentId, string>> = {
  fee_recovery: 'fee_recovery',
  practical: 'practical_records',
  tma: 'tma_records',
  online_classes: 'online_class_records',
  admission: 'admission_records',
};

function clampFeeValue(val: unknown): number {
  const n = Number(val);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(1000000, Math.round(n));
}

export async function logActivity(entry: Omit<ActivityLog, 'createdAt' | 'id'>): Promise<void> {
  const path = 'activity_logs';
  try {
    await addDoc(collection(db, path), {
      ...entry,
      createdAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, path);
  }
}

export async function createNotification(entry: Omit<NotificationItem, 'createdAt' | 'id'>): Promise<void> {
  const path = 'notifications';
  try {
    await addDoc(collection(db, path), {
      ...entry,
      createdAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, path);
  }
}

export async function markNotificationRead(id: string): Promise<void> {
  const path = `notifications/${id}`;
  try {
    await updateDoc(doc(db, 'notifications', id), { read: true });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}

export async function getUserProfile(uid: string): Promise<UserAccount | null> {
  const path = `users/${uid}`;
  try {
    const snap = await getDoc(doc(db, 'users', uid));
    return snap.exists() ? (snap.data() as UserAccount) : null;
  } catch (err) {
    handleFirestoreError(err, OperationType.GET, path);
  }
}

export async function ensureInitialPlatformSetup(params: {
  uid: string;
  email: string;
  fullName: string;
  mobileNumber?: string;
}): Promise<UserAccount> {
  const { uid, email, fullName, mobileNumber = '' } = params;
  const lookerganj = CENTRE_MAP.vp_lookerganj;

  // 1. Create or confirm Super Admin user document
  const userRef = doc(db, 'users', uid);
  const existingUser = await getDoc(userRef).catch((e) =>
    handleFirestoreError(e, OperationType.GET, `users/${uid}`),
  );

  let profile: UserAccount;
  if (!existingUser.exists()) {
    const newProfile = {
      uid,
      fullName: fullName.slice(0, 100),
      email: email.slice(0, 160),
      mobileNumber: mobileNumber.slice(0, 20),
      role: 'super_admin' as UserRole,
      centreId: 'vp_lookerganj' as CentreId,
      centreName: lookerganj.name,
      department: 'all' as UserDepartment,
      status: 'Active' as const,
      joiningDate: new Date().toISOString().slice(0, 10),
      createdBy: uid,
      createdAt: serverTimestamp(),
      updatedBy: uid,
      updatedAt: serverTimestamp(),
    };
    try {
      await setDoc(userRef, newProfile);
    } catch (e) {
      handleFirestoreError(e, OperationType.CREATE, `users/${uid}`);
    }
    profile = newProfile as unknown as UserAccount;
  } else {
    profile = existingUser.data() as UserAccount;
    if (
      isBootstrappedOwnerEmail(email) &&
      (profile.role !== 'super_admin' || profile.department !== 'all' || profile.status !== 'Active')
    ) {
      try {
        await updateDoc(userRef, {
          role: 'super_admin',
          department: 'all',
          status: 'Active',
          updatedBy: uid,
          updatedAt: serverTimestamp(),
        });
        profile = {
          ...profile,
          role: 'super_admin',
          department: 'all',
          status: 'Active',
        };
      } catch (e) {
        handleFirestoreError(e, OperationType.UPDATE, `users/${uid}`);
      }
    }
  }

  // 2. Initialize or synchronize all 4 canonical centres (e.g. XIS -> Axis Academy rename)
  for (const c of CANONICAL_CENTRES) {
    const cRef = doc(db, 'centres', c.id);
    const cSnap = await getDoc(cRef).catch(() => null);
    if (!cSnap || !cSnap.exists()) {
      try {
        await setDoc(cRef, {
          ...c,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
          updatedBy: uid,
        });
      } catch (e) {
        handleFirestoreError(e, OperationType.CREATE, `centres/${c.id}`);
      }
    } else {
      const existingData = cSnap.data() as Centre;
      if (existingData.name !== c.name || existingData.code !== c.code) {
        await updateDoc(cRef, {
          name: c.name,
          code: c.code,
          updatedAt: serverTimestamp(),
          updatedBy: uid,
        }).catch(() => {});
      }
    }
  }

  // 3. Initialize or sync global system settings for Super Admin
  const settingsRef = doc(db, 'system_settings', 'global');
  const settingsSnap = await getDoc(settingsRef).catch(() => null);
  if (!settingsSnap || !settingsSnap.exists()) {
    try {
      await setDoc(settingsRef, {
        superAdminEmail: email,
        superAdminUid: uid,
        geofenceEnabled: true,
        emergencyOverrideActive: false,
        sessionTimeoutMinutes: 60,
        maxGpsAccuracyMeters: 500,
        updatedAt: serverTimestamp(),
        updatedBy: uid,
      });
    } catch (e) {
      handleFirestoreError(e, OperationType.CREATE, 'system_settings/global');
    }
  } else {
    const existingSettings = settingsSnap.data() as SystemSettings;
    if (
      email.trim().toLowerCase() === BOOTSTRAPPED_OWNER_EMAIL &&
      (existingSettings.superAdminEmail?.toLowerCase() !== email.trim().toLowerCase() ||
        existingSettings.superAdminUid !== uid)
    ) {
      await updateDoc(settingsRef, {
        superAdminEmail: email.trim().toLowerCase(),
        superAdminUid: uid,
        updatedAt: serverTimestamp(),
        updatedBy: uid,
      }).catch(() => {});
    }
  }

  await logActivity({
    actorUid: uid,
    actorName: profile.fullName,
    actorEmail: email,
    actorRole: 'super_admin',
    centreId: 'vp_lookerganj',
    department: 'all',
    action: 'INITIAL_SUPER_ADMIN_SETUP',
    targetCollection: 'system_settings',
    targetId: 'global',
    details: `Super Admin initialized platform and verified 4 branch centres.`,
    locationVerified: true,
  });

  return profile;
}

export async function updateCentreConfig(
  centreId: CentreId,
  updates: Partial<Pick<Centre, 'address' | 'latitude' | 'longitude' | 'geofenceRadiusMeters' | 'status' | 'headUid' | 'headName'>>,
  actor: UserAccount,
): Promise<void> {
  const path = `centres/${centreId}`;
  try {
    await updateDoc(doc(db, 'centres', centreId), {
      ...updates,
      updatedAt: serverTimestamp(),
      updatedBy: actor.uid,
    });
    await logActivity({
      actorUid: actor.uid,
      actorName: actor.fullName,
      actorEmail: actor.email,
      actorRole: actor.role,
      centreId,
      department: actor.department,
      action: 'CENTRE_UPDATED',
      targetCollection: 'centres',
      targetId: centreId,
      details: `Updated centre configuration (${Object.keys(updates).join(', ')}).`,
      locationVerified: true,
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}

export async function assignCentreHead(
  centreId: CentreId,
  headUser: UserAccount,
  actor: UserAccount,
): Promise<void> {
  const centreInfo = CENTRE_MAP[centreId];
  const batch = writeBatch(db);

  // Update target user's role & centre
  batch.update(doc(db, 'users', headUser.uid), {
    role: 'centre_head',
    centreId,
    centreName: centreInfo.name,
    department: 'all',
    updatedBy: actor.uid,
    updatedAt: serverTimestamp(),
  });

  // Update centre head fields
  batch.update(doc(db, 'centres', centreId), {
    headUid: headUser.uid,
    headName: headUser.fullName,
    updatedBy: actor.uid,
    updatedAt: serverTimestamp(),
  });

  // Record assignment doc (preserve createdAt if updating an existing centre assignment)
  const centreAssignRef = doc(db, 'centre_assignments', centreId);
  const existingCentreAssign = await getDoc(centreAssignRef).catch(() => null);
  if (existingCentreAssign && existingCentreAssign.exists()) {
    batch.update(centreAssignRef, {
      centreName: centreInfo.name,
      headUid: headUser.uid,
      headName: headUser.fullName,
      headEmail: headUser.email,
      assignedBy: actor.uid,
      updatedAt: serverTimestamp(),
    });
  } else {
    batch.set(centreAssignRef, {
      centreId,
      centreName: centreInfo.name,
      headUid: headUser.uid,
      headName: headUser.fullName,
      headEmail: headUser.email,
      assignedBy: actor.uid,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  }

  try {
    await batch.commit();
    await logActivity({
      actorUid: actor.uid,
      actorName: actor.fullName,
      actorEmail: actor.email,
      actorRole: actor.role,
      centreId,
      department: 'all',
      action: 'CENTRE_HEAD_ASSIGNED',
      targetCollection: 'centre_assignments',
      targetId: centreId,
      details: `Assigned ${headUser.fullName} (${headUser.email}) as Centre Head of ${centreInfo.name}.`,
      locationVerified: true,
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, `centre_assignments/${centreId}`);
  }
}

export async function saveUserAccountDoc(
  userData: Omit<UserAccount, 'createdAt' | 'updatedAt'>,
  actor: UserAccount,
): Promise<void> {
  const path = `users/${userData.uid}`;
  try {
    await setDoc(doc(db, 'users', userData.uid), {
      ...userData,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    if (userData.role === 'employee' && userData.department !== 'all') {
      await setDoc(doc(db, 'employee_assignments', userData.uid), {
        uid: userData.uid,
        employeeName: userData.fullName,
        centreId: userData.centreId,
        department: userData.department,
        assignedBy: actor.uid,
        status: userData.status,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }
    if (userData.role === 'centre_head') {
      await assignCentreHead(userData.centreId, userData as UserAccount, actor);
    }
    await logActivity({
      actorUid: actor.uid,
      actorName: actor.fullName,
      actorEmail: actor.email,
      actorRole: actor.role,
      centreId: userData.centreId,
      department: userData.department,
      action: 'USER_CREATED',
      targetCollection: 'users',
      targetId: userData.uid,
      details: `Created ${userData.role} account for ${userData.fullName} (${userData.email}) in ${userData.department}.`,
      locationVerified: true,
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, path);
  }
}

export async function updateUserAccount(
  uid: string,
  updates: Partial<Pick<UserAccount, 'fullName' | 'mobileNumber' | 'department' | 'status' | 'role' | 'centreId' | 'centreName'>>,
  actor: UserAccount,
  targetCentreId: string,
): Promise<void> {
  const path = `users/${uid}`;
  try {
    await updateDoc(doc(db, 'users', uid), {
      ...updates,
      updatedBy: actor.uid,
      updatedAt: serverTimestamp(),
    });
    await logActivity({
      actorUid: actor.uid,
      actorName: actor.fullName,
      actorEmail: actor.email,
      actorRole: actor.role,
      centreId: targetCentreId,
      department: updates.department || actor.department,
      action: 'USER_UPDATED',
      targetCollection: 'users',
      targetId: uid,
      details: `Updated user account (${Object.keys(updates).join(', ')}).`,
      locationVerified: true,
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}

export async function deleteStaffMember(
  targetUser: UserAccount,
  actor: UserAccount,
): Promise<void> {
  if (targetUser.uid === actor.uid) {
    throw new Error('You cannot delete your own active account.');
  }
  if (targetUser.role === 'super_admin') {
    throw new Error('Protected Super Admin accounts cannot be deleted.');
  }

  const path = `users/${targetUser.uid}`;
  const batch = writeBatch(db);

  batch.delete(doc(db, 'users', targetUser.uid));

  const empAssignRef = doc(db, 'employee_assignments', targetUser.uid);
  const empAssignSnap = await getDoc(empAssignRef).catch(() => null);
  if (empAssignSnap && empAssignSnap.exists()) {
    batch.delete(empAssignRef);
  }

  if (targetUser.role === 'centre_head') {
    const centreRef = doc(db, 'centres', targetUser.centreId);
    const centreSnap = await getDoc(centreRef).catch(() => null);
    if (centreSnap && centreSnap.exists() && centreSnap.data()?.headUid === targetUser.uid) {
      batch.update(centreRef, {
        headUid: '',
        headName: '',
        updatedBy: actor.uid,
        updatedAt: serverTimestamp(),
      });
    }

    const centreAssignRef = doc(db, 'centre_assignments', targetUser.centreId);
    const centreAssignSnap = await getDoc(centreAssignRef).catch(() => null);
    if (centreAssignSnap && centreAssignSnap.exists() && centreAssignSnap.data()?.headUid === targetUser.uid) {
      batch.delete(centreAssignRef);
    }
  }

  const cleanEmail = targetUser.email.trim().toLowerCase();
  if (cleanEmail) {
    const inviteId = await emailToInviteId(cleanEmail);
    const invRef = doc(db, 'staff_invites', inviteId);
    const invSnap = await getDoc(invRef).catch(() => null);
    if (invSnap && invSnap.exists()) {
      const invData = invSnap.data() as StaffInvite;
      if (actor.role === 'super_admin' || (invData.role === 'employee' && invData.centreId === actor.centreId)) {
        batch.delete(invRef);
      }
    }
  }

  try {
    await batch.commit();
    await logActivity({
      actorUid: actor.uid,
      actorName: actor.fullName,
      actorEmail: actor.email,
      actorRole: actor.role,
      centreId: targetUser.centreId,
      department: targetUser.department,
      action: 'USER_DELETED',
      targetCollection: 'users',
      targetId: targetUser.uid,
      details: `Permanently removed ${targetUser.role} (${targetUser.fullName} · ${targetUser.email}) from ${targetUser.centreName}.`,
      locationVerified: true,
    }).catch(() => {});
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, path);
  }
}

export async function updateSystemSettings(
  updates: Partial<Omit<SystemSettings, 'updatedAt' | 'updatedBy'>>,
  actor: UserAccount,
): Promise<void> {
  const path = 'system_settings/global';
  try {
    await updateDoc(doc(db, 'system_settings', 'global'), {
      ...updates,
      updatedAt: serverTimestamp(),
      updatedBy: actor.uid,
    });
    await logActivity({
      actorUid: actor.uid,
      actorName: actor.fullName,
      actorEmail: actor.email,
      actorRole: actor.role,
      centreId: actor.centreId,
      department: 'all',
      action: 'SYSTEM_SETTINGS_UPDATED',
      targetCollection: 'system_settings',
      targetId: 'global',
      details: `Updated global security settings (${Object.keys(updates).join(', ')}).`,
      locationVerified: true,
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}

export async function checkDuplicateStudent(studentId: string, mobileNumber: string, centreId: CentreId): Promise<string | null> {
  const cleanId = studentId.trim();
  const idSnap = await getDoc(doc(db, 'students', cleanId)).catch(() => null);
  if (idSnap && idSnap.exists()) {
    return `A student with Student ID "${cleanId}" already exists.`;
  }
  const cleanMobile = mobileNumber.trim();
  if (cleanMobile.length >= 7) {
    const q = query(
      collection(db, 'students'),
      where('centreId', '==', centreId),
      where('mobileNumber', '==', cleanMobile),
    );
    const snap = await getDocs(q).catch(() => null);
    if (snap && !snap.empty) {
      const existing = snap.docs[0].data() as Student;
      return `Potential duplicate detected: ${existing.studentName} (${existing.studentId}) already uses mobile number ${cleanMobile} in this centre.`;
    }
  }
  return null;
}

export async function getNextSerialNumber(existingStudents: Student[]): Promise<number> {
  if (existingStudents.length === 0) return 1;
  return Math.max(...existingStudents.map((s) => Number(s.serialNumber || 0))) + 1;
}

export async function createStudentRecord(
  studentInput: Omit<Student, 'createdBy' | 'createdAt' | 'updatedBy' | 'updatedAt'>,
  actor: UserAccount,
  locationVerified: boolean,
  options?: {
    totalFee?: number;
    paidAmount?: number;
    tmaFee?: number;
    examFee?: number;
    stream?: string;
    createDepartmentSkeletons?: boolean;
  },
): Promise<void> {
  const sid = studentInput.studentId.trim();
  const path = `students/${sid}`;
  const resolvedTmaFee =
    options?.tmaFee !== undefined
      ? clampFeeValue(options.tmaFee)
      : studentInput.tmaFee !== undefined
        ? clampFeeValue(studentInput.tmaFee)
        : undefined;
  const resolvedExamFee =
    options?.examFee !== undefined
      ? clampFeeValue(options.examFee)
      : studentInput.examFee !== undefined
        ? clampFeeValue(studentInput.examFee)
        : undefined;

  try {
    const isEmployeeActor = actor.role === 'employee';
    const studentDocPayload: Record<string, unknown> = {
      ...studentInput,
      studentId: sid,
      employeeLocked: isEmployeeActor ? false : Boolean(studentInput.employeeLocked ?? false),
      tmaLocked: isEmployeeActor ? false : Boolean(studentInput.tmaLocked ?? false),
      practicalLocked: isEmployeeActor ? false : Boolean(studentInput.practicalLocked ?? false),
      onlineClassesLocked: isEmployeeActor ? false : Boolean(studentInput.onlineClassesLocked ?? false),
      admissionLocked: isEmployeeActor ? true : Boolean(studentInput.admissionLocked ?? false),
      lockedByUid: isEmployeeActor ? actor.uid : (studentInput.lockedByUid ?? ''),
      lockedByName: isEmployeeActor ? actor.fullName.slice(0, 100) : (studentInput.lockedByName ?? ''),
      superAdminAccessGranted: studentInput.superAdminAccessGranted ?? true,
      createdBy: actor.uid,
      createdAt: serverTimestamp(),
      updatedBy: actor.uid,
      updatedAt: serverTimestamp(),
    };
    if (resolvedTmaFee !== undefined) studentDocPayload.tmaFee = resolvedTmaFee;
    else delete studentDocPayload.tmaFee;
    if (resolvedExamFee !== undefined) studentDocPayload.examFee = resolvedExamFee;
    else delete studentDocPayload.examFee;

    await setDoc(doc(db, 'students', sid), studentDocPayload);

    // If Super Admin, Centre Head, or Admission Employee, initialize admission record;
    // Super Admin and Centre Head can also initialize linked department records.
    if (actor.role === 'super_admin' || actor.role === 'centre_head' || actor.department === 'admission') {
      await setDoc(doc(db, 'admission_records', sid), {
        studentId: sid,
        studentName: studentInput.studentName,
        centreId: studentInput.centreId,
        admissionStatus: 'Confirmed',
        stream: (
          options?.stream || sanitizeRealSubject(studentInput.subject, { stripLegacyDefaultList: false })
        ).slice(0, 80),
        niosPurpose: studentInput.whyNios,
        academicBackground: studentInput.currentEducationStatus,
        followUpStatus: 'Completed',
        assignedEmployeeUid: studentInput.assignedEmployeeUid,
        assignedEmployeeName: studentInput.assignedEmployeeName,
        remarks: studentInput.additionalRemarks,
        admissionDate: studentInput.admissionDate,
        ...(isEmployeeActor
          ? {
              employeeLocked: true,
              lockedByUid: actor.uid,
              lockedByName: actor.fullName.slice(0, 100),
            }
          : {}),
        createdBy: actor.uid,
        createdAt: serverTimestamp(),
        updatedBy: actor.uid,
        updatedAt: serverTimestamp(),
      });
    }

    if (options?.createDepartmentSkeletons && (actor.role === 'super_admin' || actor.role === 'centre_head')) {
      const paidAmount = Math.max(0, Math.round(Number(options.paidAmount ?? 0)));
      const totalFee = Math.max(paidAmount, Math.round(Number(options.totalFee ?? 0)));
      const pendingAmount = Math.max(0, totalFee - paidAmount);
      const batch = writeBatch(db);
      batch.set(doc(db, 'fee_recovery', sid), {
        studentId: sid,
        studentName: studentInput.studentName,
        mobileNumber: studentInput.mobileNumber,
        centreId: studentInput.centreId,
        recoveryStatus:
          totalFee > 0 && pendingAmount === 0
            ? 'Paid'
            : paidAmount > 0 && pendingAmount > 0
              ? 'Partial'
              : 'Pending',
        followUpStatus: totalFee > 0 && pendingAmount === 0 ? 'Closed' : 'Scheduled',
        totalFee,
        paidAmount,
        pendingAmount,
        ...(resolvedTmaFee !== undefined ? { tmaFee: resolvedTmaFee } : {}),
        ...(resolvedExamFee !== undefined ? { examFee: resolvedExamFee } : {}),
        assignedEmployeeUid: studentInput.assignedEmployeeUid,
        assignedEmployeeName: studentInput.assignedEmployeeName,
        followUpNotes: 'Initial fee schedule created on admission.',
        lastContactDate: studentInput.admissionDate,
        nextFollowUpDate: studentInput.admissionDate,
        createdBy: actor.uid,
        createdAt: serverTimestamp(),
        updatedBy: actor.uid,
        updatedAt: serverTimestamp(),
      });
      batch.set(doc(db, 'practical_records', sid), {
        studentId: sid,
        studentName: studentInput.studentName,
        centreId: studentInput.centreId,
        practicalStatus: studentInput.practicalStatus,
        submissionStatus: studentInput.practicalStatus === 'Completed' ? 'Submitted' : 'Not Submitted',
        completionPercentage: studentInput.practicalStatus === 'Completed' ? 100 : 0,
        assignedEmployeeUid: studentInput.assignedEmployeeUid,
        assignedEmployeeName: studentInput.assignedEmployeeName,
        remarks: '',
        createdBy: actor.uid,
        createdAt: serverTimestamp(),
        updatedBy: actor.uid,
        updatedAt: serverTimestamp(),
      });
      const realSubCount = countStudentSubjects(studentInput.subject);
      batch.set(doc(db, 'tma_records', sid), {
        studentId: sid,
        studentName: studentInput.studentName,
        centreId: studentInput.centreId,
        tmaStatus: studentInput.tmaStatus,
        subjectsSubmittedCount: studentInput.tmaStatus === 'Submitted' ? realSubCount : 0,
        totalSubjectsCount: realSubCount,
        submissionDate: studentInput.tmaStatus === 'Submitted' ? studentInput.admissionDate : '',
        assignedEmployeeUid: studentInput.assignedEmployeeUid,
        assignedEmployeeName: studentInput.assignedEmployeeName,
        remarks: '',
        createdBy: actor.uid,
        createdAt: serverTimestamp(),
        updatedBy: actor.uid,
        updatedAt: serverTimestamp(),
      });
      batch.set(doc(db, 'online_class_records', sid), {
        studentId: sid,
        studentName: studentInput.studentName,
        centreId: studentInput.centreId,
        attendanceStatus: studentInput.classAttendanceStatus,
        participationLevel:
          studentInput.classAttendanceStatus === 'Regular'
            ? 'High'
            : studentInput.classAttendanceStatus === 'Irregular'
              ? 'Moderate'
              : 'Inactive',
        attendancePercentage:
          studentInput.classAttendanceStatus === 'Regular'
            ? 90
            : studentInput.classAttendanceStatus === 'Irregular'
              ? 50
              : 0,
        lastAttendanceUpdate: studentInput.admissionDate,
        followUpNotes: '',
        assignedEmployeeUid: studentInput.assignedEmployeeUid,
        assignedEmployeeName: studentInput.assignedEmployeeName,
        createdBy: actor.uid,
        createdAt: serverTimestamp(),
        updatedBy: actor.uid,
        updatedAt: serverTimestamp(),
      });
      await batch.commit();
    }

    await logActivity({
      actorUid: actor.uid,
      actorName: actor.fullName,
      actorEmail: actor.email,
      actorRole: actor.role,
      centreId: studentInput.centreId,
      department: actor.department,
      action: 'STUDENT_CREATED',
      targetCollection: 'students',
      targetId: sid,
      details: `Registered student ${studentInput.studentName} (${sid}) in ${studentInput.centreName}.`,
      locationVerified,
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, path);
  }
}

export interface BulkImportRowPayload {
  operation?: 'create' | 'update';
  serialNumber: number;
  studentId: string;
  studentName: string;
  mobileNumber: string;
  subject: string;
  tcStatus: Student['tcStatus'];
  bookStatus: Student['bookStatus'];
  classAttendanceStatus: Student['classAttendanceStatus'];
  whyNios: string;
  currentEducationStatus: string;
  futurePlanning: string;
  tmaStatus: Student['tmaStatus'];
  practicalStatus: Student['practicalStatus'];
  examinationStatus: Student['examinationStatus'];
  centreId: CentreId;
  centreName: string;
  admissionDate: string;
  additionalRemarks: string;
  totalFee: number;
  paidAmount: number;
  pendingAmount?: number;
  tmaFee?: number;
  examFee?: number;
  recoveryStatus?: RecoveryStatus;
  followUpStatus?: FeeFollowUpStatus;
  explicitFeeDetected?: boolean;
  explicitTmaFeeDetected?: boolean;
  explicitExamFeeDetected?: boolean;
  explicitSubjectDetected?: boolean;
  explicitTmaDetected?: boolean;
  explicitPracticalDetected?: boolean;
  extraColumns?: Record<string, string>;
  rowColor?: string;
  cellColors?: Record<string, string>;
}

export interface BulkImportExecutionResult {
  importedCount: number;
  updatedCount: number;
  feeSyncedCount: number;
  failedRows: Array<{ studentName: string; studentId: string; error: string }>;
}

function sanitizeExtraColumns(extra?: Record<string, string>): Record<string, string> | undefined {
  if (!extra) return undefined;
  const cleaned: Record<string, string> = {};
  for (const [k, v] of Object.entries(extra)) {
    const key = String(k ?? '').trim().slice(0, 50);
    const val = String(v ?? '').trim().slice(0, 300);
    if (key && val && Object.keys(cleaned).length < 35) {
      cleaned[key] = val;
    }
  }
  return Object.keys(cleaned).length > 0 ? cleaned : undefined;
}

function sanitizeRowColor(color?: string): string {
  const clean = String(color ?? '').trim().toUpperCase();
  return /^#[0-9A-F]{6}$/.test(clean) ? clean : '';
}

function sanitizeCellColors(colors?: Record<string, string>): Record<string, string> {
  if (!colors) return {};
  const cleaned: Record<string, string> = {};
  for (const [k, v] of Object.entries(colors)) {
    const key = String(k ?? '').trim().slice(0, 60);
    const val = String(v ?? '').trim().toUpperCase();
    if (key && /^#[0-9A-F]{6}$/.test(val) && Object.keys(cleaned).length < 45) {
      cleaned[key] = val;
    }
  }
  return cleaned;
}

export async function bulkImportStudentsBatch(
  rows: BulkImportRowPayload[],
  actor: UserAccount,
  locationVerified: boolean,
  options?: {
    onProgress?: (done: number, total: number) => void;
    feeSyncOnly?: boolean;
    academicSyncOnly?: boolean;
    forceSyncFees?: boolean;
  },
): Promise<BulkImportExecutionResult> {
  if (rows.length === 0) return { importedCount: 0, updatedCount: 0, feeSyncedCount: 0, failedRows: [] };

  // Guarantee canonical centres exist so Firestore rules `exists(/centres/{centreId})` never blocks Super Admin
  if (actor.role === 'super_admin') {
    const neededCentres = new Set(rows.map((r) => r.centreId));
    for (const cId of neededCentres) {
      const canonical = CANONICAL_CENTRES.find((c) => c.id === cId);
      if (!canonical) continue;
      const cRef = doc(db, 'centres', cId);
      const snap = await getDoc(cRef).catch(() => null);
      if (!snap || !snap.exists()) {
        await setDoc(cRef, {
          ...canonical,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
          updatedBy: actor.uid,
        }).catch(() => {});
      }
    }
  }

  const actorName = (actor.fullName || 'Staff').trim().slice(0, 100) || 'Staff';
  const canCreateSkeletons = actor.role === 'super_admin' || actor.role === 'centre_head';
  const feeSyncOnly = Boolean(options?.feeSyncOnly);
  const academicSyncOnly = Boolean(options?.academicSyncOnly) && !feeSyncOnly;
  const failedRows: Array<{ studentName: string; studentId: string; error: string }> = [];
  let importedCount = 0;
  let updatedCount = 0;
  let feeSyncedCount = 0;
  const seenIdsInRun = new Set<string>();
  const year = new Date().getFullYear();

  const pauseMs = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  const isTransientFirestoreError = (err: unknown): boolean => {
    const code = String((err as { code?: string })?.code ?? '').toLowerCase();
    const msg = String((err as { message?: string })?.message ?? err ?? '').toLowerCase();
    return (
      code.includes('unavailable') ||
      code.includes('aborted') ||
      code.includes('deadline-exceeded') ||
      code.includes('resource-exhausted') ||
      code.includes('internal') ||
      msg.includes('unavailable') ||
      msg.includes('aborted') ||
      msg.includes('deadline') ||
      msg.includes('resource-exhausted') ||
      msg.includes('network')
    );
  };

  const commitWithRetry = async (commitFn: () => Promise<void>, maxRetries = 2): Promise<void> => {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        await commitFn();
        return;
      } catch (err) {
        lastErr = err;
        if (attempt < maxRetries && isTransientFirestoreError(err)) {
          await pauseMs(250 * (attempt + 1));
          continue;
        }
        throw err;
      }
    }
    throw lastErr;
  };

  const getSafeMobile = (mobile?: string): string => {
    const trimmed = String(mobile ?? '').trim().slice(0, 20);
    return trimmed.length >= 7 ? trimmed : 'Not Provided';
  };

  const getSafeName = (name?: string): string => {
    const trimmed = String(name ?? '').trim().slice(0, 120);
    return trimmed.length >= 2 ? trimmed : 'Student';
  };

  const getSafeSubject = (subject?: string): string => {
    return sanitizeRealSubject(subject, { stripLegacyDefaultList: false }).slice(0, 200);
  };

  const getSafeAdmissionDate = (dateStr?: string): string => {
    const fallback = new Date().toISOString().slice(0, 10);
    const trimmed = String(dateStr ?? '').trim().slice(0, 30);
    return trimmed.length >= 4 ? trimmed : fallback;
  };

  const getSafeCentreName = (centreName: string | undefined, centreId: CentreId): string => {
    const trimmed = String(centreName ?? CENTRE_MAP[centreId]?.name ?? 'Vision Point')
      .trim()
      .slice(0, 120);
    return trimmed.length >= 2 ? trimmed : 'Vision Point';
  };

  const getSafeSerialNumber = (serial?: number): number => {
    const n = Number(serial);
    return Number.isFinite(n) && n >= 1 ? Math.round(n) : 1;
  };

  const makeUniqueCollisionFreeId = (r: BulkImportRowPayload): string => {
    const code = CENTRE_MAP[r.centreId]?.code || 'VP';
    const sn = String(getSafeSerialNumber(r.serialNumber)).padStart(4, '0');
    let candidate = `${code}-${year}-${sn}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    while (seenIdsInRun.has(candidate.toLowerCase())) {
      candidate = `${code}-${year}-${sn}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
    }
    return candidate.slice(0, 128);
  };

  const getSafeStudentId = (r: BulkImportRowPayload): string => {
    const raw = String(r.studentId ?? '').trim().slice(0, 128);
    if (/^[a-zA-Z0-9_-]{1,128}$/.test(raw)) return raw;
    return makeUniqueCollisionFreeId(r);
  };

  const computeFeeFields = (r: BulkImportRowPayload) => {
    const paidAmount = clampFeeValue(r.paidAmount ?? 0);
    const totalFee = Math.max(paidAmount, clampFeeValue(r.totalFee ?? 0));
    const pendingAmount =
      r.pendingAmount !== undefined
        ? clampFeeValue(r.pendingAmount)
        : Math.max(0, totalFee - paidAmount);
    const recoveryStatus: RecoveryStatus =
      r.recoveryStatus ||
      (totalFee > 0 && pendingAmount === 0
        ? 'Paid'
        : paidAmount > 0 && pendingAmount > 0
          ? 'Partial'
          : 'Pending');
    const followUpStatus: FeeFollowUpStatus =
      r.followUpStatus || (recoveryStatus === 'Paid' ? 'Closed' : recoveryStatus === 'Partial' ? 'Promise to Pay' : 'Scheduled');
    return { totalFee, paidAmount, pendingAmount, recoveryStatus, followUpStatus };
  };

  const buildStudentCreateDoc = (r: BulkImportRowPayload) => {
    const cleanExtras = sanitizeExtraColumns(r.extraColumns);
    const cleanRowColor = sanitizeRowColor(r.rowColor);
    const cleanCellColors = sanitizeCellColors(r.cellColors);
    const safeSubject = getSafeSubject(r.subject);
    return {
      serialNumber: getSafeSerialNumber(r.serialNumber),
      studentId: r.studentId,
      studentName: getSafeName(r.studentName),
      mobileNumber: getSafeMobile(r.mobileNumber),
      subject: safeSubject,
      tcStatus: r.tcStatus,
      bookStatus: r.bookStatus,
      classAttendanceStatus: r.classAttendanceStatus,
      whyNios: (r.whyNios || '').slice(0, 1000),
      currentEducationStatus: (r.currentEducationStatus || '').slice(0, 1000),
      futurePlanning: (r.futurePlanning || '').slice(0, 1000),
      tmaStatus: r.tmaStatus,
      practicalStatus: r.practicalStatus,
      examinationStatus: r.examinationStatus,
      centreId: r.centreId,
      centreName: getSafeCentreName(r.centreName, r.centreId),
      admissionDate: getSafeAdmissionDate(r.admissionDate),
      assignedEmployeeUid: actor.uid,
      assignedEmployeeName: actorName,
      additionalRemarks: (r.additionalRemarks || 'Excel Bulk Import').slice(0, 1000),
      employeeLocked: false,
      tmaLocked: false,
      practicalLocked: false,
      onlineClassesLocked: false,
      admissionLocked: false,
      lockedByUid: '',
      lockedByName: '',
      superAdminAccessGranted: true,
      ...(r.explicitTmaFeeDetected || (r.tmaFee !== undefined && r.tmaFee > 0)
        ? { tmaFee: clampFeeValue(r.tmaFee) }
        : {}),
      ...(r.explicitExamFeeDetected || (r.examFee !== undefined && r.examFee > 0)
        ? { examFee: clampFeeValue(r.examFee) }
        : {}),
      ...(cleanExtras ? { extraColumns: cleanExtras } : {}),
      ...(cleanRowColor ? { rowColor: cleanRowColor } : {}),
      ...(Object.keys(cleanCellColors).length > 0 ? { cellColors: cleanCellColors } : {}),
      createdBy: actor.uid,
      createdAt: serverTimestamp(),
      updatedBy: actor.uid,
      updatedAt: serverTimestamp(),
    };
  };

  const buildStudentUpdateDoc = (r: BulkImportRowPayload) => {
    const cleanExtras = sanitizeExtraColumns(r.extraColumns);
    const cleanRowColor = sanitizeRowColor(r.rowColor);
    const cleanCellColors = sanitizeCellColors(r.cellColors);
    const safeSubject = getSafeSubject(r.subject);
    return {
      studentName: getSafeName(r.studentName),
      mobileNumber: getSafeMobile(r.mobileNumber),
      subject: safeSubject,
      tcStatus: r.tcStatus,
      bookStatus: r.bookStatus,
      classAttendanceStatus: r.classAttendanceStatus,
      whyNios: (r.whyNios || '').slice(0, 1000),
      currentEducationStatus: (r.currentEducationStatus || '').slice(0, 1000),
      futurePlanning: (r.futurePlanning || '').slice(0, 1000),
      tmaStatus: r.tmaStatus,
      practicalStatus: r.practicalStatus,
      examinationStatus: r.examinationStatus,
      ...(actor.role === 'super_admin'
        ? {
            centreId: r.centreId,
            centreName: getSafeCentreName(r.centreName, r.centreId),
          }
        : {}),
      admissionDate: getSafeAdmissionDate(r.admissionDate),
      additionalRemarks: (r.additionalRemarks || 'Excel Sheet Updated').slice(0, 1000),
      ...(r.explicitTmaFeeDetected ? { tmaFee: clampFeeValue(r.tmaFee) } : {}),
      ...(r.explicitExamFeeDetected ? { examFee: clampFeeValue(r.examFee) } : {}),
      ...(cleanExtras ? { extraColumns: cleanExtras } : {}),
      rowColor: cleanRowColor,
      cellColors: cleanCellColors,
      updatedBy: actor.uid,
      updatedAt: serverTimestamp(),
    };
  };

  const buildSkeletonPayloads = (r: BulkImportRowPayload) => {
    const sid = r.studentId;
    const safeName = getSafeName(r.studentName);
    const safeMobile = getSafeMobile(r.mobileNumber);
    const safeDate = getSafeAdmissionDate(r.admissionDate);
    const safeSubject = getSafeSubject(r.subject);
    const { totalFee, paidAmount, pendingAmount, recoveryStatus, followUpStatus } = computeFeeFields(r);

    const admissionCreate = {
      studentId: sid,
      studentName: safeName,
      centreId: r.centreId,
      admissionStatus: 'Confirmed' as const,
      stream: safeSubject.slice(0, 80),
      niosPurpose: (r.whyNios || '').slice(0, 1000),
      academicBackground: (r.currentEducationStatus || '').slice(0, 1000),
      followUpStatus: 'Completed' as const,
      assignedEmployeeUid: actor.uid,
      assignedEmployeeName: actorName,
      remarks: (r.additionalRemarks || '').slice(0, 1000),
      admissionDate: safeDate,
      createdBy: actor.uid,
      createdAt: serverTimestamp(),
      updatedBy: actor.uid,
      updatedAt: serverTimestamp(),
    };
    const admissionUpdate = {
      studentName: safeName,
      ...(actor.role === 'super_admin' ? { centreId: r.centreId } : {}),
      stream: admissionCreate.stream,
      niosPurpose: admissionCreate.niosPurpose,
      academicBackground: admissionCreate.academicBackground,
      remarks: admissionCreate.remarks,
      admissionDate: safeDate,
      updatedBy: actor.uid,
      updatedAt: serverTimestamp(),
    };

    const feeCreate = {
      studentId: sid,
      studentName: safeName,
      mobileNumber: safeMobile,
      centreId: r.centreId,
      recoveryStatus,
      followUpStatus,
      totalFee,
      paidAmount,
      pendingAmount,
      ...(r.explicitTmaFeeDetected || (r.tmaFee !== undefined && r.tmaFee > 0)
        ? { tmaFee: clampFeeValue(r.tmaFee) }
        : {}),
      ...(r.explicitExamFeeDetected || (r.examFee !== undefined && r.examFee > 0)
        ? { examFee: clampFeeValue(r.examFee) }
        : {}),
      assignedEmployeeUid: actor.uid,
      assignedEmployeeName: actorName,
      followUpNotes: 'Imported via Excel Bulk Import.',
      lastContactDate: safeDate,
      nextFollowUpDate: safeDate,
      createdBy: actor.uid,
      createdAt: serverTimestamp(),
      updatedBy: actor.uid,
      updatedAt: serverTimestamp(),
    };
    const feeUpdate = {
      studentName: safeName,
      mobileNumber: safeMobile,
      ...(actor.role === 'super_admin' ? { centreId: r.centreId } : {}),
      recoveryStatus,
      followUpStatus,
      totalFee,
      paidAmount,
      pendingAmount,
      ...(r.explicitTmaFeeDetected || (r.tmaFee !== undefined && r.tmaFee > 0)
        ? { tmaFee: clampFeeValue(r.tmaFee) }
        : {}),
      ...(r.explicitExamFeeDetected || (r.examFee !== undefined && r.examFee > 0)
        ? { examFee: clampFeeValue(r.examFee) }
        : {}),
      updatedBy: actor.uid,
      updatedAt: serverTimestamp(),
    };

    const practicalCreate = {
      studentId: sid,
      studentName: safeName,
      centreId: r.centreId,
      practicalStatus: r.practicalStatus,
      submissionStatus: r.practicalStatus === 'Completed' ? 'Submitted' : 'Not Submitted',
      completionPercentage: r.practicalStatus === 'Completed' ? 100 : 0,
      assignedEmployeeUid: actor.uid,
      assignedEmployeeName: actorName,
      remarks: '',
      createdBy: actor.uid,
      createdAt: serverTimestamp(),
      updatedBy: actor.uid,
      updatedAt: serverTimestamp(),
    };
    const practicalUpdate = {
      studentName: safeName,
      ...(actor.role === 'super_admin' ? { centreId: r.centreId } : {}),
      practicalStatus: r.practicalStatus,
      submissionStatus: practicalCreate.submissionStatus,
      completionPercentage: practicalCreate.completionPercentage,
      updatedBy: actor.uid,
      updatedAt: serverTimestamp(),
    };

    const realSubCount = countStudentSubjects(safeSubject);
    const tmaCreate = {
      studentId: sid,
      studentName: safeName,
      centreId: r.centreId,
      tmaStatus: r.tmaStatus,
      subjectsSubmittedCount: r.tmaStatus === 'Submitted' ? realSubCount : 0,
      totalSubjectsCount: realSubCount,
      submissionDate: r.tmaStatus === 'Submitted' ? safeDate : '',
      assignedEmployeeUid: actor.uid,
      assignedEmployeeName: actorName,
      remarks: '',
      createdBy: actor.uid,
      createdAt: serverTimestamp(),
      updatedBy: actor.uid,
      updatedAt: serverTimestamp(),
    };
    const tmaUpdate = {
      studentName: safeName,
      ...(actor.role === 'super_admin' ? { centreId: r.centreId } : {}),
      tmaStatus: r.tmaStatus,
      subjectsSubmittedCount: tmaCreate.subjectsSubmittedCount,
      totalSubjectsCount: realSubCount,
      submissionDate: tmaCreate.submissionDate,
      updatedBy: actor.uid,
      updatedAt: serverTimestamp(),
    };

    const onlineCreate = {
      studentId: sid,
      studentName: safeName,
      centreId: r.centreId,
      attendanceStatus: r.classAttendanceStatus,
      participationLevel:
        r.classAttendanceStatus === 'Regular'
          ? 'High'
          : r.classAttendanceStatus === 'Irregular'
            ? 'Moderate'
            : 'Inactive',
      attendancePercentage:
        r.classAttendanceStatus === 'Regular' ? 90 : r.classAttendanceStatus === 'Irregular' ? 50 : 0,
      lastAttendanceUpdate: safeDate,
      followUpNotes: '',
      assignedEmployeeUid: actor.uid,
      assignedEmployeeName: actorName,
      createdBy: actor.uid,
      createdAt: serverTimestamp(),
      updatedBy: actor.uid,
      updatedAt: serverTimestamp(),
    };
    const onlineUpdate = {
      studentName: safeName,
      ...(actor.role === 'super_admin' ? { centreId: r.centreId } : {}),
      attendanceStatus: r.classAttendanceStatus,
      participationLevel: onlineCreate.participationLevel,
      attendancePercentage: onlineCreate.attendancePercentage,
      lastAttendanceUpdate: safeDate,
      updatedBy: actor.uid,
      updatedAt: serverTimestamp(),
    };

    return [
      { col: 'admission_records', create: admissionCreate, update: admissionUpdate },
      { col: 'fee_recovery', create: feeCreate, update: feeUpdate },
      { col: 'practical_records', create: practicalCreate, update: practicalUpdate },
      { col: 'tma_records', create: tmaCreate, update: tmaUpdate },
      { col: 'online_class_records', create: onlineCreate, update: onlineUpdate },
    ] as const;
  };

  const addSkeletonCreates = (batch: ReturnType<typeof writeBatch>, r: BulkImportRowPayload) => {
    const specs = buildSkeletonPayloads(r);
    for (const spec of specs) {
      batch.set(doc(db, spec.col, r.studentId), spec.create);
    }
  };

  const upsertSkeletonsIdempotentForRow = async (r: BulkImportRowPayload) => {
    const specs = buildSkeletonPayloads(r);
    for (const spec of specs) {
      const ref = doc(db, spec.col, r.studentId);
      try {
        await setDoc(ref, spec.create);
      } catch {
        await updateDoc(ref, spec.update);
      }
    }
  };

  // Helper to fetch document snapshots with bounded concurrency so Firestore isn't overwhelmed
  const fetchSnapsThrottled = async (colName: string, ids: string[]) => {
    const snapMap = new Map<string, Record<string, unknown> | null>();
    const readBatchSize = 15;
    for (let j = 0; j < ids.length; j += readBatchSize) {
      const slice = ids.slice(j, j + readBatchSize);
      const snaps = await Promise.all(
        slice.map(async (id) => {
          try {
            const s = await getDoc(doc(db, colName, id));
            return [id, s.exists() ? (s.data() as Record<string, unknown>) : null] as const;
          } catch {
            return [id, null] as const;
          }
        }),
      );
      snaps.forEach(([id, data]) => snapMap.set(id, data));
    }
    return snapMap;
  };

  const syncFeeUpdatesChunkBatched = async (targetRows: BulkImportRowPayload[]) => {
    if (targetRows.length === 0) return;
    const ids = targetRows.map((r) => r.studentId);
    const feeSnapMap = await fetchSnapsThrottled('fee_recovery', ids);

    const feeWriteOps: Array<{
      row: BulkImportRowPayload;
      type: 'update' | 'set';
      payload: Record<string, unknown>;
      feeChanged: boolean;
    }> = [];

    for (const r of targetRows) {
      const sid = r.studentId;
      const safeName = getSafeName(r.studentName);
      const safeMobile = getSafeMobile(r.mobileNumber);
      const safeDate = getSafeAdmissionDate(r.admissionDate);
      const { totalFee, paidAmount, pendingAmount, recoveryStatus, followUpStatus } = computeFeeFields(r);
      const existingData = feeSnapMap.get(sid) as FeeRecoveryRecord | null | undefined;

      if (existingData) {
        const shouldSyncFees =
          Boolean(r.explicitFeeDetected) ||
          (Boolean(options?.forceSyncFees) && feeSyncOnly) ||
          isUntouchedAutoImportDefaultFee(existingData);

        const preservedMobile =
          r.mobileNumber &&
          r.mobileNumber.trim().length >= 7 &&
          r.mobileNumber.trim().toLowerCase() !== 'not provided'
            ? safeMobile
            : existingData.mobileNumber && String(existingData.mobileNumber).trim().length >= 7
              ? String(existingData.mobileNumber).trim().slice(0, 20)
              : safeMobile;

        feeWriteOps.push({
          row: r,
          type: 'update',
          feeChanged: Boolean(shouldSyncFees || r.explicitTmaFeeDetected || r.explicitExamFeeDetected),
          payload: {
            studentName: safeName,
            mobileNumber: preservedMobile,
            ...(actor.role === 'super_admin' ? { centreId: r.centreId } : {}),
            ...(typeof existingData.assignedEmployeeUid !== 'string'
              ? { assignedEmployeeUid: actor.uid }
              : {}),
            ...(typeof existingData.assignedEmployeeName !== 'string'
              ? { assignedEmployeeName: actorName }
              : {}),
            ...(typeof existingData.lastContactDate !== 'string' ? { lastContactDate: safeDate } : {}),
            ...(typeof existingData.nextFollowUpDate !== 'string' ? { nextFollowUpDate: safeDate } : {}),
            ...(typeof existingData.followUpNotes !== 'string' ? { followUpNotes: '' } : {}),
            ...(shouldSyncFees
              ? {
                  recoveryStatus,
                  followUpStatus,
                  totalFee,
                  paidAmount,
                  pendingAmount,
                  followUpNotes: r.explicitFeeDetected
                    ? 'Fees synced from updated Excel sheet.'
                    : 'Synced with updated Excel sheet (no fee due).',
                }
              : {}),
            ...(r.explicitTmaFeeDetected ? { tmaFee: clampFeeValue(r.tmaFee) } : {}),
            ...(r.explicitExamFeeDetected ? { examFee: clampFeeValue(r.examFee) } : {}),
            updatedBy: actor.uid,
            updatedAt: serverTimestamp(),
          },
        });
      } else {
        feeWriteOps.push({
          row: r,
          type: 'set',
          feeChanged: true,
          payload: {
            studentId: sid,
            studentName: safeName,
            mobileNumber: safeMobile,
            centreId: r.centreId,
            recoveryStatus,
            followUpStatus,
            totalFee,
            paidAmount,
            pendingAmount,
            ...(r.explicitTmaFeeDetected || (r.tmaFee !== undefined && r.tmaFee > 0)
              ? { tmaFee: clampFeeValue(r.tmaFee) }
              : {}),
            ...(r.explicitExamFeeDetected || (r.examFee !== undefined && r.examFee > 0)
              ? { examFee: clampFeeValue(r.examFee) }
              : {}),
            assignedEmployeeUid: actor.uid,
            assignedEmployeeName: actorName,
            followUpNotes: r.explicitFeeDetected ? 'Fees synced from updated Excel sheet.' : 'Created from updated Excel sheet.',
            lastContactDate: safeDate,
            nextFollowUpDate: safeDate,
            createdBy: actor.uid,
            createdAt: serverTimestamp(),
            updatedBy: actor.uid,
            updatedAt: serverTimestamp(),
          },
        });
      }
    }

    try {
      await commitWithRetry(async () => {
        const feeBatch = writeBatch(db);
        for (const op of feeWriteOps) {
          const ref = doc(db, 'fee_recovery', op.row.studentId);
          if (op.type === 'update') feeBatch.update(ref, op.payload);
          else feeBatch.set(ref, op.payload);
        }
        await feeBatch.commit();
      });
      feeSyncedCount += feeWriteOps.filter((op) => op.feeChanged).length;
    } catch {
      for (const op of feeWriteOps) {
        try {
          const ref = doc(db, 'fee_recovery', op.row.studentId);
          if (op.type === 'update') {
            await updateDoc(ref, op.payload);
          } else {
            try {
              await setDoc(ref, op.payload);
            } catch {
              const fallbackSpec = buildSkeletonPayloads(op.row).find((s) => s.col === 'fee_recovery');
              if (fallbackSpec) {
                await updateDoc(ref, fallbackSpec.update);
              } else {
                throw new Error('Fee update fallback unavailable');
              }
            }
          }
          if (op.feeChanged) feeSyncedCount += 1;
        } catch (feeErr) {
          failedRows.push({
            studentName: op.row.studentName,
            studentId: op.row.studentId,
            error: `Fee sync rejected: ${feeErr instanceof Error ? feeErr.message : 'Firestore rules denied write.'}`,
          });
        }
      }
    }
  };

  const syncAcademicDeptsChunkBatched = async (targetRows: BulkImportRowPayload[]) => {
    if (targetRows.length === 0) return;
    const ids = targetRows.map((r) => r.studentId);
    const [tmaMap, pracMap, clsMap] = await Promise.all([
      fetchSnapsThrottled('tma_records', ids),
      fetchSnapsThrottled('practical_records', ids),
      fetchSnapsThrottled('online_class_records', ids),
    ]);

    const deptBatch = writeBatch(db);
    let ops = 0;
    for (const r of targetRows) {
      const sid = r.studentId;
      const safeName = getSafeName(r.studentName);
      const safeSubject = getSafeSubject(r.subject);
      const realSubCount = countStudentSubjects(safeSubject);
      const safeDate = getSafeAdmissionDate(r.admissionDate);

      const existingTma = tmaMap.get(sid) as Partial<TmaRecord> | null | undefined;
      if (existingTma) {
        const shouldUpdateTmaStatus = !academicSyncOnly || Boolean(r.explicitTmaDetected);
        const resolvedTmaStatus = shouldUpdateTmaStatus
          ? r.tmaStatus
          : (existingTma.tmaStatus || r.tmaStatus);
        const resolvedTotalSub =
          r.explicitSubjectDetected || realSubCount > 0
            ? realSubCount
            : academicSyncOnly
              ? Number(existingTma.totalSubjectsCount ?? 0)
              : 0;
        const resolvedSubSubmitted =
          resolvedTmaStatus === 'Submitted'
            ? resolvedTotalSub
            : academicSyncOnly && !r.explicitTmaDetected
              ? Math.min(resolvedTotalSub, Number(existingTma.subjectsSubmittedCount ?? 0))
              : 0;
        deptBatch.update(doc(db, 'tma_records', sid), {
          studentName: safeName,
          tmaStatus: resolvedTmaStatus,
          totalSubjectsCount: resolvedTotalSub,
          subjectsSubmittedCount: resolvedSubSubmitted,
          ...(shouldUpdateTmaStatus && resolvedTmaStatus === 'Submitted' && !existingTma.submissionDate
            ? { submissionDate: safeDate }
            : {}),
          updatedBy: actor.uid,
          updatedAt: serverTimestamp(),
        });
        ops++;
      } else if (academicSyncOnly) {
        deptBatch.set(doc(db, 'tma_records', sid), {
          studentId: sid,
          studentName: safeName,
          centreId: r.centreId,
          tmaStatus: r.tmaStatus,
          subjectsSubmittedCount: r.tmaStatus === 'Submitted' ? realSubCount : 0,
          totalSubjectsCount: realSubCount,
          submissionDate: r.tmaStatus === 'Submitted' ? safeDate : '',
          assignedEmployeeUid: actor.uid,
          assignedEmployeeName: actorName,
          remarks: '',
          createdBy: actor.uid,
          createdAt: serverTimestamp(),
          updatedBy: actor.uid,
          updatedAt: serverTimestamp(),
        });
        ops++;
      }

      const existingPrac = pracMap.get(sid) as Partial<PracticalRecord> | null | undefined;
      if (existingPrac) {
        const shouldUpdatePracStatus = !academicSyncOnly || Boolean(r.explicitPracticalDetected);
        if (shouldUpdatePracStatus) {
          deptBatch.update(doc(db, 'practical_records', sid), {
            studentName: safeName,
            practicalStatus: r.practicalStatus,
            submissionStatus: r.practicalStatus === 'Completed' ? 'Submitted' : 'Not Submitted',
            completionPercentage: r.practicalStatus === 'Completed' ? 100 : 0,
            updatedBy: actor.uid,
            updatedAt: serverTimestamp(),
          });
          ops++;
        }
      } else if (academicSyncOnly) {
        deptBatch.set(doc(db, 'practical_records', sid), {
          studentId: sid,
          studentName: safeName,
          centreId: r.centreId,
          practicalStatus: r.practicalStatus,
          submissionStatus: r.practicalStatus === 'Completed' ? 'Submitted' : 'Not Submitted',
          completionPercentage: r.practicalStatus === 'Completed' ? 100 : 0,
          assignedEmployeeUid: actor.uid,
          assignedEmployeeName: actorName,
          remarks: '',
          createdBy: actor.uid,
          createdAt: serverTimestamp(),
          updatedBy: actor.uid,
          updatedAt: serverTimestamp(),
        });
        ops++;
      }

      if (!academicSyncOnly && clsMap.get(sid)) {
        deptBatch.update(doc(db, 'online_class_records', sid), {
          studentName: safeName,
          attendanceStatus: r.classAttendanceStatus,
          participationLevel:
            r.classAttendanceStatus === 'Regular'
              ? 'High'
              : r.classAttendanceStatus === 'Irregular'
                ? 'Moderate'
                : 'Inactive',
          attendancePercentage:
            r.classAttendanceStatus === 'Regular' ? 90 : r.classAttendanceStatus === 'Irregular' ? 50 : 0,
          updatedBy: actor.uid,
          updatedAt: serverTimestamp(),
        });
        ops++;
      }
    }
    if (ops > 0) {
      await commitWithRetry(() => deptBatch.commit()).catch(() => {});
    }
  };

  // Chunk size 15 => Phase A <= 15 student writes, Phase B <= 75 dept writes (stays fast, avoids Firestore contention on 446+ row uploads)
  const chunkSize = 15;
  for (let i = 0; i < rows.length; i += chunkSize) {
    // Normalize & deduplicate studentId within this import run before sending to Firestore
    const rawChunk = rows.slice(i, i + chunkSize);
    const chunk: BulkImportRowPayload[] = rawChunk.map((rawRow) => {
      let sid = getSafeStudentId(rawRow);
      if (rawRow.operation !== 'update' && seenIdsInRun.has(sid.toLowerCase())) {
        sid = makeUniqueCollisionFreeId(rawRow);
      }
      seenIdsInRun.add(sid.toLowerCase());
      return { ...rawRow, studentId: sid };
    });

    // For super_admin, pre-check create IDs against Firestore to avoid overwriting/failing on pre-existing student IDs
    if (actor.role === 'super_admin') {
      const createCandidateIds = chunk
        .filter((r) => r.operation !== 'update')
        .map((r) => r.studentId);
      if (createCandidateIds.length > 0) {
        const existingStudentMap = await fetchSnapsThrottled('students', createCandidateIds);
        for (let idx = 0; idx < chunk.length; idx++) {
          const r = chunk[idx];
          if (r.operation === 'update') continue;
          const existingSnap = existingStudentMap.get(r.studentId);
          if (existingSnap) {
            if (existingSnap.centreId === r.centreId) {
              chunk[idx] = { ...r, operation: 'update' };
            } else {
              const freshId = makeUniqueCollisionFreeId(r);
              seenIdsInRun.add(freshId.toLowerCase());
              chunk[idx] = { ...r, studentId: freshId, operation: 'create' };
            }
          }
        }
      }
    }

    const committedCreates: BulkImportRowPayload[] = [];
    const committedUpdates: BulkImportRowPayload[] = [];

    if (feeSyncOnly) {
      const createsInChunk = chunk.filter((r) => r.operation !== 'update');
      const updatesInChunk = chunk.filter((r) => r.operation === 'update');

      if (createsInChunk.length > 0) {
        try {
          await commitWithRetry(async () => {
            const createBatch = writeBatch(db);
            for (const r of createsInChunk) {
              createBatch.set(doc(db, 'students', r.studentId), buildStudentCreateDoc(r));
            }
            await createBatch.commit();
          });
          committedCreates.push(...createsInChunk);
        } catch {
          for (const r of createsInChunk) {
            try {
              await setDoc(doc(db, 'students', r.studentId), buildStudentCreateDoc(r));
              committedCreates.push(r);
            } catch {
              try {
                await updateDoc(doc(db, 'students', r.studentId), buildStudentUpdateDoc(r));
                committedUpdates.push({ ...r, operation: 'update' });
              } catch {
                const freshId = makeUniqueCollisionFreeId(r);
                seenIdsInRun.add(freshId.toLowerCase());
                const remapped = { ...r, studentId: freshId, operation: 'create' as const };
                try {
                  await setDoc(doc(db, 'students', freshId), buildStudentCreateDoc(remapped));
                  committedCreates.push(remapped);
                } catch (rowErr) {
                  failedRows.push({
                    studentName: r.studentName,
                    studentId: r.studentId,
                    error: rowErr instanceof Error ? rowErr.message : 'Write rejected by Firestore rules.',
                  });
                }
              }
            }
          }
        }
      }

      // For existing students in feeSyncOnly mode: preserve academic & extraColumns fields; only patch tmaFee/examFee if explicitly present
      const feeMetaUpdates = updatesInChunk.filter(
        (r) => r.explicitTmaFeeDetected || r.explicitExamFeeDetected,
      );
      if (feeMetaUpdates.length > 0) {
        const metaBatch = writeBatch(db);
        for (const r of feeMetaUpdates) {
          metaBatch.update(doc(db, 'students', r.studentId), {
            ...(r.explicitTmaFeeDetected ? { tmaFee: clampFeeValue(r.tmaFee) } : {}),
            ...(r.explicitExamFeeDetected ? { examFee: clampFeeValue(r.examFee) } : {}),
            updatedBy: actor.uid,
            updatedAt: serverTimestamp(),
          });
        }
        await commitWithRetry(() => metaBatch.commit()).catch(() => {});
      }
      committedUpdates.push(...updatesInChunk);
    } else if (academicSyncOnly) {
      const createsInChunk = chunk.filter((r) => r.operation !== 'update');
      const updatesInChunk = chunk.filter((r) => r.operation === 'update');

      if (createsInChunk.length > 0) {
        try {
          await commitWithRetry(async () => {
            const createBatch = writeBatch(db);
            for (const r of createsInChunk) {
              createBatch.set(doc(db, 'students', r.studentId), buildStudentCreateDoc(r));
            }
            await createBatch.commit();
          });
          committedCreates.push(...createsInChunk);
        } catch {
          for (const r of createsInChunk) {
            try {
              await setDoc(doc(db, 'students', r.studentId), buildStudentCreateDoc(r));
              committedCreates.push(r);
            } catch (rowErr) {
              failedRows.push({
                studentName: r.studentName,
                studentId: r.studentId,
                error: rowErr instanceof Error ? rowErr.message : 'Write rejected by Firestore rules.',
              });
            }
          }
        }
      }

      if (updatesInChunk.length > 0) {
        const buildAcademicStudentPatch = (r: BulkImportRowPayload) => ({
          studentName: getSafeName(r.studentName),
          ...(r.explicitSubjectDetected ? { subject: getSafeSubject(r.subject) } : {}),
          ...(r.explicitTmaDetected ? { tmaStatus: r.tmaStatus } : {}),
          ...(r.explicitPracticalDetected ? { practicalStatus: r.practicalStatus } : {}),
          updatedBy: actor.uid,
          updatedAt: serverTimestamp(),
        });
        try {
          await commitWithRetry(async () => {
            const updBatch = writeBatch(db);
            for (const r of updatesInChunk) {
              updBatch.update(doc(db, 'students', r.studentId), buildAcademicStudentPatch(r));
            }
            await updBatch.commit();
          });
          committedUpdates.push(...updatesInChunk);
        } catch {
          for (const r of updatesInChunk) {
            try {
              await updateDoc(doc(db, 'students', r.studentId), buildAcademicStudentPatch(r));
              committedUpdates.push(r);
            } catch (rowErr) {
              failedRows.push({
                studentName: r.studentName,
                studentId: r.studentId,
                error: rowErr instanceof Error ? rowErr.message : 'Write rejected by Firestore rules.',
              });
            }
          }
        }
      }
    } else {
      try {
        await commitWithRetry(async () => {
          const studentBatch = writeBatch(db);
          for (const r of chunk) {
            const ref = doc(db, 'students', r.studentId);
            if (r.operation === 'update') {
              studentBatch.update(ref, buildStudentUpdateDoc(r));
            } else {
              studentBatch.set(ref, buildStudentCreateDoc(r));
            }
          }
          await studentBatch.commit();
        });
        for (const r of chunk) {
          if (r.operation === 'update') committedUpdates.push(r);
          else committedCreates.push(r);
        }
      } catch {
        // Fall back to individual student writes + collision recovery so every valid row succeeds
        for (const r of chunk) {
          const ref = doc(db, 'students', r.studentId);
          if (r.operation === 'update') {
            try {
              await updateDoc(ref, buildStudentUpdateDoc(r));
              committedUpdates.push(r);
            } catch (rowErr) {
              failedRows.push({
                studentName: r.studentName,
                studentId: r.studentId,
                error: rowErr instanceof Error ? rowErr.message : 'Write rejected by Firestore rules.',
              });
            }
          } else {
            try {
              await setDoc(ref, buildStudentCreateDoc(r));
              committedCreates.push(r);
            } catch {
              try {
                await updateDoc(ref, buildStudentUpdateDoc(r));
                committedUpdates.push({ ...r, operation: 'update' });
              } catch {
                const freshId = makeUniqueCollisionFreeId(r);
                seenIdsInRun.add(freshId.toLowerCase());
                const remapped = { ...r, studentId: freshId, operation: 'create' as const };
                try {
                  await setDoc(doc(db, 'students', freshId), buildStudentCreateDoc(remapped));
                  committedCreates.push(remapped);
                } catch (rowErr) {
                  failedRows.push({
                    studentName: r.studentName,
                    studentId: r.studentId,
                    error: rowErr instanceof Error ? rowErr.message : 'Write rejected by Firestore rules.',
                  });
                }
              }
            }
          }
        }
      }
    }

    if (canCreateSkeletons && committedCreates.length > 0) {
      try {
        await commitWithRetry(async () => {
          const deptBatch = writeBatch(db);
          for (const r of committedCreates) {
            addSkeletonCreates(deptBatch, r);
          }
          await deptBatch.commit();
        });
        feeSyncedCount += committedCreates.length;
      } catch {
        for (const r of committedCreates) {
          try {
            await upsertSkeletonsIdempotentForRow(r);
            feeSyncedCount += 1;
          } catch (skelErr) {
            failedRows.push({
              studentName: r.studentName,
              studentId: r.studentId,
              error: `Fee skeleton failed: ${skelErr instanceof Error ? skelErr.message : 'Write denied.'}`,
            });
          }
        }
      }
    }

    if (canCreateSkeletons && committedUpdates.length > 0) {
      if (!academicSyncOnly) {
        await syncFeeUpdatesChunkBatched(committedUpdates);
      }
      if (!feeSyncOnly) {
        await syncAcademicDeptsChunkBatched(committedUpdates);
      }
    }

    importedCount += committedCreates.length;
    updatedCount += committedUpdates.length;
    options?.onProgress?.(Math.min(i + chunk.length, rows.length), rows.length);

    if (i + chunkSize < rows.length) {
      await pauseMs(25);
    }
  }

  if (importedCount > 0 || updatedCount > 0 || feeSyncedCount > 0) {
    await logActivity({
      actorUid: actor.uid,
      actorName: actor.fullName,
      actorEmail: actor.email,
      actorRole: actor.role,
      centreId: actor.role === 'super_admin' ? 'all' : actor.centreId,
      department: feeSyncOnly ? 'fee_recovery' : actor.department,
      action: feeSyncOnly ? 'FEE_EXCEL_RECONCILED' : 'BULK_STUDENT_IMPORT',
      targetCollection: feeSyncOnly ? 'fee_recovery' : 'students',
      targetId: actor.role === 'super_admin' ? 'multi_centre' : actor.centreId,
      details: `${feeSyncOnly ? 'Fee Excel sync' : 'Excel sync'} complete: ${importedCount} new added, ${updatedCount} existing updated, ${feeSyncedCount} fee records synced (${failedRows.length} failed).`,
      locationVerified,
    });
  }

  return { importedCount, updatedCount, feeSyncedCount, failedRows };
}

export async function updateStudentRecord(
  studentId: string,
  updates: Partial<Student>,
  actor: UserAccount,
  centreId: string,
  locationVerified: boolean,
): Promise<void> {
  const path = `students/${studentId}`;
  try {
    let scopedUpdates: Record<string, unknown> = { ...updates };

    if (actor.role === 'employee') {
      const lockMeta = {
        lockedByUid: actor.uid,
        lockedByName: actor.fullName.slice(0, 100),
      };

      if (actor.department === 'tma') {
        scopedUpdates = {
          ...(updates.tmaStatus !== undefined ? { tmaStatus: updates.tmaStatus } : {}),
          tmaLocked: true,
          ...lockMeta,
        };
      } else if (actor.department === 'practical') {
        scopedUpdates = {
          ...(updates.practicalStatus !== undefined ? { practicalStatus: updates.practicalStatus } : {}),
          practicalLocked: true,
          ...lockMeta,
        };
      } else if (actor.department === 'online_classes') {
        scopedUpdates = {
          ...(updates.classAttendanceStatus !== undefined
            ? { classAttendanceStatus: updates.classAttendanceStatus }
            : {}),
          onlineClassesLocked: true,
          ...lockMeta,
        };
      } else if (actor.department === 'admission') {
        const allowedAdmissionKeys: Array<keyof Student> = [
          'studentName',
          'mobileNumber',
          'subject',
          'tcStatus',
          'bookStatus',
          'whyNios',
          'currentEducationStatus',
          'futurePlanning',
          'examinationStatus',
          'admissionDate',
          'assignedEmployeeUid',
          'assignedEmployeeName',
          'additionalRemarks',
          'tmaFee',
          'examFee',
        ];
        const filtered: Record<string, unknown> = {};
        for (const key of allowedAdmissionKeys) {
          if (updates[key] !== undefined) {
            filtered[key] =
              key === 'tmaFee' || key === 'examFee' ? clampFeeValue(updates[key]) : updates[key];
          }
        }
        scopedUpdates = {
          ...filtered,
          admissionLocked: true,
          ...lockMeta,
        };
      } else {
        throw new Error('Your department does not have direct edit permission on central student rows.');
      }
    }

    if (scopedUpdates.tmaFee !== undefined) {
      scopedUpdates.tmaFee = clampFeeValue(scopedUpdates.tmaFee);
    }
    if (scopedUpdates.examFee !== undefined) {
      scopedUpdates.examFee = clampFeeValue(scopedUpdates.examFee);
    }

    await updateDoc(doc(db, 'students', studentId), {
      ...scopedUpdates,
      updatedBy: actor.uid,
      updatedAt: serverTimestamp(),
    });
    if (scopedUpdates.classAttendanceStatus !== undefined) {
      const nextAtt = scopedUpdates.classAttendanceStatus as Student['classAttendanceStatus'];
      const clsRef = doc(db, 'online_class_records', studentId);
      const clsSnap = await getDoc(clsRef).catch(() => null);
      if (clsSnap && clsSnap.exists()) {
        await updateDoc(clsRef, {
          attendanceStatus: nextAtt,
          participationLevel:
            nextAtt === 'Regular' ? 'High' : nextAtt === 'Irregular' ? 'Moderate' : 'Inactive',
          attendancePercentage: nextAtt === 'Regular' ? 90 : nextAtt === 'Irregular' ? 50 : 0,
          updatedBy: actor.uid,
          updatedAt: serverTimestamp(),
        }).catch(() => {});
      }
    }
    await logActivity({
      actorUid: actor.uid,
      actorName: actor.fullName,
      actorEmail: actor.email,
      actorRole: actor.role,
      centreId,
      department: actor.department,
      action: updates.centreId ? 'STUDENT_TRANSFERRED' : 'STUDENT_UPDATED',
      targetCollection: 'students',
      targetId: studentId,
      details: `Updated student ${studentId} (${Object.keys(scopedUpdates).join(', ')}).`,
      locationVerified,
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}

export async function updateStudentsSerialOrderBatch(
  updates: Array<{ studentId: string; serialNumber: number }>,
  actor: UserAccount,
  actionReason = 'Reordered Excel student rows',
): Promise<number> {
  if (updates.length === 0) return 0;
  if (actor.role !== 'super_admin' && actor.role !== 'centre_head') {
    throw new Error('Only Super Admin or Centre Head can reorder or shuffle Excel rows.');
  }

  const sanitized = updates
    .map((u) => ({
      studentId: String(u.studentId || '').trim(),
      serialNumber: Math.max(1, Math.round(Number(u.serialNumber || 1))),
    }))
    .filter((u) => u.studentId.length > 0 && Number.isFinite(u.serialNumber) && u.serialNumber >= 1);

  if (sanitized.length === 0) return 0;

  let committedCount = 0;
  try {
    const chunkSize = 400;
    for (let i = 0; i < sanitized.length; i += chunkSize) {
      const chunk = sanitized.slice(i, i + chunkSize);
      const batch = writeBatch(db);
      for (const item of chunk) {
        batch.update(doc(db, 'students', item.studentId), {
          serialNumber: item.serialNumber,
          updatedBy: actor.uid,
          updatedAt: serverTimestamp(),
        });
      }
      await batch.commit();
      committedCount += chunk.length;
    }

    await logActivity({
      actorUid: actor.uid,
      actorName: actor.fullName,
      actorEmail: actor.email,
      actorRole: actor.role,
      centreId: actor.role === 'super_admin' ? 'all' : actor.centreId,
      department: actor.department,
      action: 'ROWS_REORDERED',
      targetCollection: 'students',
      targetId: actor.role === 'super_admin' ? 'multi_centre' : actor.centreId,
      details: `${actionReason} (${committedCount} row serial positions updated).`,
      locationVerified: true,
    });
    return committedCount;
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, 'students');
    return committedCount;
  }
}

export async function saveExcelSheetConfig(
  configId: string,
  config: Omit<ExcelSheetConfig, 'configId' | 'updatedBy' | 'updatedAt'>,
  actor: UserAccount,
  actionReason = 'Updated Excel columns & headings',
): Promise<void> {
  const cleanId = String(configId || 'global').trim();
  const path = `excel_sheet_configs/${cleanId}`;
  if (actor.role !== 'super_admin' && !(actor.role === 'centre_head' && actor.centreId === cleanId)) {
    throw new Error('Only Super Admin or Centre Head can modify Excel columns and headings.');
  }

  const sanitizedHeaderLabels: Record<string, string> = {};
  for (const [k, v] of Object.entries(config.headerLabels || {})) {
    const key = String(k ?? '').trim().slice(0, 60);
    const val = String(v ?? '').trim().slice(0, 60);
    if (key && val && Object.keys(sanitizedHeaderLabels).length < 50) {
      sanitizedHeaderLabels[key] = val;
    }
  }

  const sanitizeList = (arr: string[], limitCount: number, maxLen: number) => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const item of arr || []) {
      const clean = String(item ?? '').trim().slice(0, maxLen);
      if (clean && !seen.has(clean) && out.length < limitCount) {
        seen.add(clean);
        out.push(clean);
      }
    }
    return out;
  };

  const payload = {
    configId: cleanId,
    headerLabels: sanitizedHeaderLabels,
    customColumns: sanitizeList(config.customColumns, 35, 50),
    hiddenCoreColumns: sanitizeList(config.hiddenCoreColumns, 20, 50),
    deletedExtraColumns: sanitizeList(config.deletedExtraColumns, 60, 50),
    updatedBy: actor.uid,
    updatedAt: serverTimestamp(),
  };

  try {
    const ref = doc(db, 'excel_sheet_configs', cleanId);
    const existing = await getDoc(ref).catch(() => null);
    if (existing && existing.exists()) {
      await updateDoc(ref, payload);
    } else {
      await setDoc(ref, payload);
    }
    await logActivity({
      actorUid: actor.uid,
      actorName: actor.fullName,
      actorEmail: actor.email,
      actorRole: actor.role,
      centreId: cleanId === 'global' ? 'all' : cleanId,
      department: actor.department,
      action: 'EXCEL_COLUMNS_UPDATED',
      targetCollection: 'excel_sheet_configs',
      targetId: cleanId,
      details: actionReason,
      locationVerified: true,
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, path);
  }
}

export async function mergeCustomColumnsIntoSharedConfig(
  headings: string[],
  actor: UserAccount,
  actionReason = 'Synced blank/heading-only Excel columns across centres',
): Promise<string[]> {
  if (actor.role !== 'super_admin' && actor.role !== 'centre_head') return [];
  const cleanInputs = headings.map((h) => String(h ?? '').trim().slice(0, 50)).filter(Boolean);
  if (cleanInputs.length === 0) return [];

  const targetConfigId = actor.role === 'super_admin' ? 'global' : actor.centreId;
  const ref = doc(db, 'excel_sheet_configs', targetConfigId);
  const snap = await getDoc(ref).catch(() => null);
  const existing = snap && snap.exists() ? (snap.data() as ExcelSheetConfig) : null;

  const existingCustom = [...(existing?.customColumns || [])];
  const deletedSet = new Set((existing?.deletedExtraColumns || []).map((k) => k.trim().toLowerCase()));
  const seen = new Set(existingCustom.map((k) => k.trim().toLowerCase()));
  const added: string[] = [];

  for (const h of cleanInputs) {
    const low = h.toLowerCase();
    if (!deletedSet.has(low) && !seen.has(low) && existingCustom.length < 35) {
      seen.add(low);
      existingCustom.push(h);
      added.push(h);
    }
  }

  if (added.length === 0) return [];

  await saveExcelSheetConfig(
    targetConfigId,
    {
      headerLabels: { ...(existing?.headerLabels || {}) },
      customColumns: existingCustom,
      hiddenCoreColumns: [...(existing?.hiddenCoreColumns || [])],
      deletedExtraColumns: [...(existing?.deletedExtraColumns || [])],
    },
    actor,
    `${actionReason}: ${added.join(', ')}`,
  );
  return added;
}

export async function batchUpdateStudentExtraColumns(
  updates: Array<{
    studentId: string;
    extraColumns: Record<string, string>;
    cellColors?: Record<string, string>;
  }>,
  actor: UserAccount,
  actionReason = 'Updated extra columns across Excel rows',
): Promise<number> {
  if (updates.length === 0) return 0;
  if (actor.role !== 'super_admin' && actor.role !== 'centre_head') {
    throw new Error('Only Super Admin or Centre Head can rename or delete columns across rows.');
  }

  let committed = 0;
  try {
    const chunkSize = 400;
    for (let i = 0; i < updates.length; i += chunkSize) {
      const chunk = updates.slice(i, i + chunkSize);
      const batch = writeBatch(db);
      for (const item of chunk) {
        const cleanExtras = sanitizeExtraColumns(item.extraColumns) || {};
        const patch: Record<string, unknown> = {
          extraColumns: cleanExtras,
          updatedBy: actor.uid,
          updatedAt: serverTimestamp(),
        };
        if (item.cellColors !== undefined) {
          patch.cellColors = sanitizeCellColors(item.cellColors);
        }
        batch.update(doc(db, 'students', item.studentId), patch);
      }
      await batch.commit();
      committed += chunk.length;
    }

    await logActivity({
      actorUid: actor.uid,
      actorName: actor.fullName,
      actorEmail: actor.email,
      actorRole: actor.role,
      centreId: actor.role === 'super_admin' ? 'all' : actor.centreId,
      department: actor.department,
      action: 'EXCEL_COLUMN_DATA_MIGRATED',
      targetCollection: 'students',
      targetId: actor.role === 'super_admin' ? 'multi_centre' : actor.centreId,
      details: `${actionReason} (${committed} student rows updated).`,
      locationVerified: true,
    });
    return committed;
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, 'students');
    return committed;
  }
}

export async function toggleStudentSuperAdminAccess(
  student: Student,
  granted: boolean,
  actor: UserAccount,
): Promise<void> {
  const path = `students/${student.studentId}`;
  try {
    await updateDoc(doc(db, 'students', student.studentId), {
      superAdminAccessGranted: granted,
      updatedBy: actor.uid,
      updatedAt: serverTimestamp(),
    });
    await logActivity({
      actorUid: actor.uid,
      actorName: actor.fullName,
      actorEmail: actor.email,
      actorRole: actor.role,
      centreId: student.centreId,
      department: 'all',
      action: granted ? 'STUDENT_SUPER_ADMIN_GRANTED' : 'STUDENT_SUPER_ADMIN_RESTRICTED',
      targetCollection: 'students',
      targetId: student.studentId,
      details: `${actor.fullName} ${granted ? 'granted' : 'restricted'} Super Admin edit access for ${student.studentName}.`,
      locationVerified: true,
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}

export async function toggleStudentEmployeeLock(
  student: Student,
  locked: boolean,
  actor: UserAccount,
): Promise<void> {
  const path = `students/${student.studentId}`;
  try {
    const batch = writeBatch(db);
    batch.update(doc(db, 'students', student.studentId), {
      employeeLocked: locked,
      tmaLocked: locked,
      practicalLocked: locked,
      onlineClassesLocked: locked,
      admissionLocked: locked,
      lockedByUid: locked ? (student.lockedByUid || actor.uid) : '',
      lockedByName: locked ? (student.lockedByName || actor.fullName.slice(0, 100)) : '',
      updatedBy: actor.uid,
      updatedAt: serverTimestamp(),
    });

    const deptCols = ['fee_recovery', 'practical_records', 'tma_records', 'online_class_records', 'admission_records'];
    for (const colName of deptCols) {
      const deptRef = doc(db, colName, student.studentId);
      const snap = await getDoc(deptRef).catch(() => null);
      if (snap && snap.exists()) {
        batch.update(deptRef, {
          employeeLocked: locked,
          lockedByUid: locked ? (student.lockedByUid || actor.uid) : '',
          lockedByName: locked ? (student.lockedByName || actor.fullName.slice(0, 100)) : '',
          updatedBy: actor.uid,
          updatedAt: serverTimestamp(),
        });
      }
    }

    await batch.commit();

    await logActivity({
      actorUid: actor.uid,
      actorName: actor.fullName,
      actorEmail: actor.email,
      actorRole: actor.role,
      centreId: student.centreId,
      department: 'all',
      action: locked ? 'STUDENT_ROW_LOCKED' : 'STUDENT_ROW_UNLOCKED',
      targetCollection: 'students',
      targetId: student.studentId,
      details: `${actor.fullName} ${locked ? 'locked' : 'unlocked'} all department fields for ${student.studentName}.`,
      locationVerified: true,
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}

export async function bulkSetStudentSuperAdminAccess(
  targetStudents: Student[],
  granted: boolean,
  actor: UserAccount,
): Promise<number> {
  if (targetStudents.length === 0) return 0;
  try {
    const chunkSize = 400;
    let updatedCount = 0;
    for (let i = 0; i < targetStudents.length; i += chunkSize) {
      const slice = targetStudents.slice(i, i + chunkSize);
      const batch = writeBatch(db);
      for (const s of slice) {
        batch.update(doc(db, 'students', s.studentId), {
          superAdminAccessGranted: granted,
          updatedBy: actor.uid,
          updatedAt: serverTimestamp(),
        });
        updatedCount++;
      }
      await batch.commit();
    }
    await logActivity({
      actorUid: actor.uid,
      actorName: actor.fullName,
      actorEmail: actor.email,
      actorRole: actor.role,
      centreId: actor.centreId,
      department: 'all',
      action: granted ? 'BULK_SUPER_ADMIN_ACCESS_GRANTED' : 'BULK_SUPER_ADMIN_ACCESS_RESTRICTED',
      targetCollection: 'students',
      targetId: actor.centreId,
      details: `${actor.fullName} ${granted ? 'granted' : 'restricted'} Super Admin edit access on ${updatedCount} branch student records.`,
      locationVerified: true,
    });
    return updatedCount;
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, 'students');
  }
}

export async function deleteStudentRecord(
  studentId: string,
  studentName: string,
  centreId: string,
  actor: UserAccount,
): Promise<void> {
  const path = `students/${studentId}`;
  try {
    await deleteDoc(doc(db, 'students', studentId));
    // Clean up department records if Super Admin
    const deptCols = ['fee_recovery', 'practical_records', 'tma_records', 'online_class_records', 'admission_records'];
    for (const colName of deptCols) {
      await deleteDoc(doc(db, colName, studentId)).catch(() => {});
    }
    await logActivity({
      actorUid: actor.uid,
      actorName: actor.fullName,
      actorEmail: actor.email,
      actorRole: actor.role,
      centreId,
      department: 'all',
      action: 'STUDENT_DELETED',
      targetCollection: 'students',
      targetId: studentId,
      details: `Deleted student ${studentName} (${studentId}) and linked department records.`,
      locationVerified: true,
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, path);
  }
}

export async function deleteStudentsBatch(
  targetStudents: Array<Pick<Student, 'studentId' | 'studentName' | 'centreId'>>,
  actor: UserAccount,
  options?: {
    editRequestIds?: string[];
    onProgress?: (deleted: number, total: number) => void;
  },
): Promise<{ deletedCount: number; failedIds: string[] }> {
  if (actor.role !== 'super_admin') {
    throw new Error('Only Super Admin can bulk-delete student records.');
  }
  if (targetStudents.length === 0) {
    return { deletedCount: 0, failedIds: [] };
  }

  const deptCols = [
    'fee_recovery',
    'practical_records',
    'tma_records',
    'online_class_records',
    'admission_records',
  ];
  const failedIds: string[] = [];
  let deletedCount = 0;
  const total = targetStudents.length;

  // 70 students * 6 docs = 420 batch ops (< 500 Firestore batch limit)
  const chunkSize = 70;
  for (let i = 0; i < targetStudents.length; i += chunkSize) {
    const chunk = targetStudents.slice(i, i + chunkSize);
    try {
      const batch = writeBatch(db);
      for (const s of chunk) {
        batch.delete(doc(db, 'students', s.studentId));
        for (const colName of deptCols) {
          batch.delete(doc(db, colName, s.studentId));
        }
      }
      await batch.commit();
      deletedCount += chunk.length;
      options?.onProgress?.(deletedCount, total);
    } catch {
      // Fallback row-by-row if any single document failed validation/permissions
      for (const s of chunk) {
        try {
          await deleteDoc(doc(db, 'students', s.studentId));
          for (const colName of deptCols) {
            await deleteDoc(doc(db, colName, s.studentId)).catch(() => {});
          }
          deletedCount += 1;
        } catch {
          failedIds.push(s.studentId);
        }
        options?.onProgress?.(deletedCount, total);
      }
    }
  }

  // Also clean up any linked edit_requests for deleted students
  const reqIds = options?.editRequestIds || [];
  for (let i = 0; i < reqIds.length; i += 400) {
    const slice = reqIds.slice(i, i + 400);
    const reqBatch = writeBatch(db);
    for (const rid of slice) {
      reqBatch.delete(doc(db, 'edit_requests', rid));
    }
    await reqBatch.commit().catch(() => {});
  }

  if (deletedCount > 0) {
    await logActivity({
      actorUid: actor.uid,
      actorName: actor.fullName,
      actorEmail: actor.email,
      actorRole: actor.role,
      centreId: 'all',
      department: 'all',
      action: 'BULK_STUDENT_DELETED',
      targetCollection: 'students',
      targetId: 'bulk_clear',
      details: `Bulk-deleted ${deletedCount} student records and linked department records${failedIds.length > 0 ? ` (${failedIds.length} failed)` : ''}.`,
      locationVerified: true,
    }).catch(() => {});
  }

  return { deletedCount, failedIds };
}

export async function upsertFeeRecoveryRecord(
  record: Omit<FeeRecoveryRecord, 'createdBy' | 'createdAt' | 'updatedBy' | 'updatedAt'>,
  actor: UserAccount,
  locationVerified: boolean,
): Promise<void> {
  const path = `fee_recovery/${record.studentId}`;
  try {
    const ref = doc(db, 'fee_recovery', record.studentId);
    const snap = await getDoc(ref);
    const empLockMeta =
      actor.role === 'employee'
        ? {
            employeeLocked: true,
            lockedByUid: actor.uid,
            lockedByName: actor.fullName.slice(0, 100),
          }
        : {};
    const sanitizedRecord: Record<string, unknown> = {
      ...record,
      totalFee: clampFeeValue(record.totalFee),
      paidAmount: clampFeeValue(record.paidAmount),
      pendingAmount: clampFeeValue(record.pendingAmount),
    };
    if (record.tmaFee !== undefined) sanitizedRecord.tmaFee = clampFeeValue(record.tmaFee);
    else delete sanitizedRecord.tmaFee;
    if (record.examFee !== undefined) sanitizedRecord.examFee = clampFeeValue(record.examFee);
    else delete sanitizedRecord.examFee;

    if (snap.exists()) {
      await updateDoc(ref, {
        ...sanitizedRecord,
        ...empLockMeta,
        updatedBy: actor.uid,
        updatedAt: serverTimestamp(),
      });
    } else {
      await setDoc(ref, {
        ...sanitizedRecord,
        ...empLockMeta,
        createdBy: actor.uid,
        createdAt: serverTimestamp(),
        updatedBy: actor.uid,
        updatedAt: serverTimestamp(),
      });
    }
    if (
      (actor.role === 'super_admin' || actor.role === 'centre_head') &&
      (record.tmaFee !== undefined || record.examFee !== undefined)
    ) {
      await updateDoc(doc(db, 'students', record.studentId), {
        ...(record.tmaFee !== undefined ? { tmaFee: clampFeeValue(record.tmaFee) } : {}),
        ...(record.examFee !== undefined ? { examFee: clampFeeValue(record.examFee) } : {}),
        updatedBy: actor.uid,
        updatedAt: serverTimestamp(),
      }).catch(() => {});
    }
    await logActivity({
      actorUid: actor.uid,
      actorName: actor.fullName,
      actorEmail: actor.email,
      actorRole: actor.role,
      centreId: record.centreId,
      department: 'fee_recovery',
      action: 'FEE_RECOVERY_UPDATED',
      targetCollection: 'fee_recovery',
      targetId: record.studentId,
      details: `Updated Fee Recovery for ${record.studentName}: ${record.recoveryStatus} (Pending ₹${record.pendingAmount}).`,
      locationVerified,
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, path);
  }
}

export async function syncFeeRecordsBatchFromExcelData(
  students: Student[],
  feeRecords: FeeRecoveryRecord[],
  actor: UserAccount,
  options?: { resetUntouched12000Defaults?: boolean; locationVerified?: boolean },
): Promise<{ updatedCount: number; createdCount: number; untouched12kRemaining: number }> {
  if (actor.role !== 'super_admin' && actor.role !== 'centre_head') {
    throw new Error('Only Super Admin or Centre Head can batch-sync fee records.');
  }

  const scopedStudents =
    actor.role === 'super_admin'
      ? students
      : students.filter((s) => s.centreId === actor.centreId);
  const scopedFees =
    actor.role === 'super_admin'
      ? feeRecords
      : feeRecords.filter((f) => f.centreId === actor.centreId);

  const plan = computeFeeSyncPlanFromStudents(scopedStudents, scopedFees, {
    resetUntouched12000Defaults: options?.resetUntouched12000Defaults,
  });

  if (plan.items.length === 0) {
    return {
      updatedCount: 0,
      createdCount: 0,
      untouched12kRemaining: plan.untouched12kCount,
    };
  }

  const todayIso = new Date().toISOString().slice(0, 10);
  const actorName = actor.fullName.slice(0, 100);
  let createdCount = 0;
  let updatedCount = 0;

  try {
    // Up to 2 writes per item => chunk size 180 <= 360 ops (< 500 batch limit)
    const chunkSize = 180;
    for (let i = 0; i < plan.items.length; i += chunkSize) {
      const chunk = plan.items.slice(i, i + chunkSize);
      const batch = writeBatch(db);
      for (const item of chunk) {
        const s = item.student;
        const safeMobile =
          s.mobileNumber && s.mobileNumber.trim().length >= 7
            ? s.mobileNumber.trim().slice(0, 20)
            : 'Not Provided';
        const feeRef = doc(db, 'fee_recovery', s.studentId);

        if (item.operation === 'create') {
          batch.set(feeRef, {
            studentId: s.studentId,
            studentName: s.studentName.slice(0, 120),
            mobileNumber: safeMobile,
            centreId: s.centreId,
            recoveryStatus: item.recoveryStatus,
            followUpStatus: item.followUpStatus,
            totalFee: clampFeeValue(item.totalFee),
            paidAmount: clampFeeValue(item.paidAmount),
            pendingAmount: clampFeeValue(item.pendingAmount),
            ...(item.tmaFee > 0 ? { tmaFee: clampFeeValue(item.tmaFee) } : {}),
            ...(item.examFee > 0 ? { examFee: clampFeeValue(item.examFee) } : {}),
            assignedEmployeeUid: s.assignedEmployeeUid || actor.uid,
            assignedEmployeeName: (s.assignedEmployeeName || actorName).slice(0, 100),
            followUpNotes:
              item.reason === 'excel_columns'
                ? 'Synced from student Excel columns.'
                : 'Initialized fee record from student sheet.',
            lastContactDate: s.admissionDate.slice(0, 30) || todayIso,
            nextFollowUpDate: s.admissionDate.slice(0, 30) || todayIso,
            createdBy: actor.uid,
            createdAt: serverTimestamp(),
            updatedBy: actor.uid,
            updatedAt: serverTimestamp(),
          });
          createdCount += 1;
        } else {
          batch.update(feeRef, {
            recoveryStatus: item.recoveryStatus,
            followUpStatus: item.followUpStatus,
            totalFee: clampFeeValue(item.totalFee),
            paidAmount: clampFeeValue(item.paidAmount),
            pendingAmount: clampFeeValue(item.pendingAmount),
            ...(item.tmaFee > 0 ? { tmaFee: clampFeeValue(item.tmaFee) } : {}),
            ...(item.examFee > 0 ? { examFee: clampFeeValue(item.examFee) } : {}),
            followUpNotes:
              item.reason === 'reset_12k_default'
                ? 'Cleared untouched default ₹12,000 placeholder to ₹0.'
                : 'Fees synced from student Excel columns.',
            updatedBy: actor.uid,
            updatedAt: serverTimestamp(),
          });
          updatedCount += 1;
        }

        const curStuTma = clampFeeValue(s.tmaFee ?? 0);
        const curStuExam = clampFeeValue(s.examFee ?? 0);
        if (
          (item.tmaFee > 0 && curStuTma !== item.tmaFee) ||
          (item.examFee > 0 && curStuExam !== item.examFee)
        ) {
          batch.update(doc(db, 'students', s.studentId), {
            ...(item.tmaFee > 0 ? { tmaFee: clampFeeValue(item.tmaFee) } : {}),
            ...(item.examFee > 0 ? { examFee: clampFeeValue(item.examFee) } : {}),
            updatedBy: actor.uid,
            updatedAt: serverTimestamp(),
          });
        }
      }
      await batch.commit();
    }

    await logActivity({
      actorUid: actor.uid,
      actorName: actor.fullName,
      actorEmail: actor.email,
      actorRole: actor.role,
      centreId: actor.role === 'super_admin' ? 'all' : actor.centreId,
      department: 'fee_recovery',
      action: 'FEE_EXCEL_RECONCILED',
      targetCollection: 'fee_recovery',
      targetId: actor.role === 'super_admin' ? 'multi_centre' : actor.centreId,
      details: `Reconciled fees from Excel data: ${updatedCount} updated, ${createdCount} created.`,
      locationVerified: Boolean(options?.locationVerified ?? true),
    });

    return {
      updatedCount,
      createdCount,
      untouched12kRemaining: options?.resetUntouched12000Defaults ? 0 : plan.untouched12kCount,
    };
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, 'fee_recovery');
    return {
      updatedCount,
      createdCount,
      untouched12kRemaining: plan.untouched12kCount,
    };
  }
}

export async function resetAllFeeRecordsToZero(
  students: Student[],
  feeRecords: FeeRecoveryRecord[],
  actor: UserAccount,
  options?: { locationVerified?: boolean; onProgress?: (done: number, total: number) => void },
): Promise<{ resetCount: number; createdCount: number }> {
  if (actor.role !== 'super_admin' && actor.role !== 'centre_head') {
    throw new Error('Only Super Admin or Centre Head can reset all fees to ₹0.');
  }

  const scopedStudents =
    actor.role === 'super_admin'
      ? students
      : students.filter((s) => s.centreId === actor.centreId);
  const scopedFees =
    actor.role === 'super_admin'
      ? feeRecords
      : feeRecords.filter((f) => f.centreId === actor.centreId);

  const feeByStudent = new Map<string, FeeRecoveryRecord>();
  scopedFees.forEach((f) => feeByStudent.set(f.studentId, f));

  const todayIso = new Date().toISOString().slice(0, 10);
  const actorName = actor.fullName.slice(0, 100);
  const RESET_NOTE = 'Fees reset to ₹0 — ready for Excel upload.';

  type ResetOp =
    | { kind: 'set_fee'; student: Student }
    | { kind: 'update_fee'; studentId: string; rec: FeeRecoveryRecord }
    | { kind: 'zero_student_fees'; studentId: string };

  const ops: ResetOp[] = [];
  let resetCount = 0;
  let createdCount = 0;

  for (const s of scopedStudents) {
    const rec = feeByStudent.get(s.studentId);
    if (!rec) {
      ops.push({ kind: 'set_fee', student: s });
      createdCount += 1;
    } else if (
      rec.totalFee !== 0 ||
      rec.paidAmount !== 0 ||
      rec.pendingAmount !== 0 ||
      (rec.tmaFee ?? 0) !== 0 ||
      (rec.examFee ?? 0) !== 0 ||
      rec.recoveryStatus !== 'Pending' ||
      rec.followUpStatus !== 'Scheduled' ||
      rec.followUpNotes !== RESET_NOTE
    ) {
      ops.push({ kind: 'update_fee', studentId: s.studentId, rec });
      resetCount += 1;
    }

    if ((s.tmaFee ?? 0) > 0 || (s.examFee ?? 0) > 0) {
      ops.push({ kind: 'zero_student_fees', studentId: s.studentId });
    }
  }

  // Also reset any orphan fee_recovery docs within scope
  const studentIdSet = new Set(scopedStudents.map((s) => s.studentId));
  for (const rec of scopedFees) {
    if (studentIdSet.has(rec.studentId)) continue;
    if (
      rec.totalFee !== 0 ||
      rec.paidAmount !== 0 ||
      rec.pendingAmount !== 0 ||
      (rec.tmaFee ?? 0) !== 0 ||
      (rec.examFee ?? 0) !== 0 ||
      rec.recoveryStatus !== 'Pending' ||
      rec.followUpNotes !== RESET_NOTE
    ) {
      ops.push({ kind: 'update_fee', studentId: rec.studentId, rec });
      resetCount += 1;
    }
  }

  if (ops.length === 0) {
    return { resetCount: 0, createdCount: 0 };
  }

  try {
    const chunkSize = 200;
    for (let i = 0; i < ops.length; i += chunkSize) {
      const chunk = ops.slice(i, i + chunkSize);
      const batch = writeBatch(db);
      for (const op of chunk) {
        if (op.kind === 'set_fee') {
          const s = op.student;
          const safeMobile =
            s.mobileNumber && s.mobileNumber.trim().length >= 7
              ? s.mobileNumber.trim().slice(0, 20)
              : 'Not Provided';
          batch.set(doc(db, 'fee_recovery', s.studentId), {
            studentId: s.studentId,
            studentName: s.studentName.slice(0, 120) || 'Student',
            mobileNumber: safeMobile,
            centreId: s.centreId,
            recoveryStatus: 'Pending',
            followUpStatus: 'Scheduled',
            totalFee: 0,
            paidAmount: 0,
            pendingAmount: 0,
            tmaFee: 0,
            examFee: 0,
            assignedEmployeeUid: s.assignedEmployeeUid || actor.uid,
            assignedEmployeeName: (s.assignedEmployeeName || actorName).slice(0, 100),
            followUpNotes: RESET_NOTE,
            lastContactDate: s.admissionDate?.slice(0, 30) || todayIso,
            nextFollowUpDate: s.admissionDate?.slice(0, 30) || todayIso,
            createdBy: actor.uid,
            createdAt: serverTimestamp(),
            updatedBy: actor.uid,
            updatedAt: serverTimestamp(),
          });
        } else if (op.kind === 'update_fee') {
          const rec = op.rec;
          batch.update(doc(db, 'fee_recovery', op.studentId), {
            recoveryStatus: 'Pending',
            followUpStatus: 'Scheduled',
            totalFee: 0,
            paidAmount: 0,
            pendingAmount: 0,
            tmaFee: 0,
            examFee: 0,
            followUpNotes: RESET_NOTE,
            ...(typeof rec.assignedEmployeeUid !== 'string' ? { assignedEmployeeUid: actor.uid } : {}),
            ...(typeof rec.assignedEmployeeName !== 'string' ? { assignedEmployeeName: actorName } : {}),
            ...(typeof rec.lastContactDate !== 'string' ? { lastContactDate: todayIso } : {}),
            ...(typeof rec.nextFollowUpDate !== 'string' ? { nextFollowUpDate: todayIso } : {}),
            updatedBy: actor.uid,
            updatedAt: serverTimestamp(),
          });
        } else {
          batch.update(doc(db, 'students', op.studentId), {
            tmaFee: 0,
            examFee: 0,
            updatedBy: actor.uid,
            updatedAt: serverTimestamp(),
          });
        }
      }
      await batch.commit();
      options?.onProgress?.(Math.min(i + chunk.length, ops.length), ops.length);
    }

    await logActivity({
      actorUid: actor.uid,
      actorName: actor.fullName,
      actorEmail: actor.email,
      actorRole: actor.role,
      centreId: actor.role === 'super_admin' ? 'all' : actor.centreId,
      department: 'fee_recovery',
      action: 'FEE_RESET_TO_ZERO',
      targetCollection: 'fee_recovery',
      targetId: actor.role === 'super_admin' ? 'multi_centre' : actor.centreId,
      details: `Reset all fee records to ₹0 (${resetCount} reset, ${createdCount} initialized) ready for real Excel upload.`,
      locationVerified: Boolean(options?.locationVerified ?? true),
    });

    return { resetCount, createdCount };
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, 'fee_recovery');
    return { resetCount, createdCount };
  }
}

export async function deleteFeeRecoveryRecordsBatch(
  targetFeeRecords: ReadonlyArray<Pick<FeeRecoveryRecord, 'studentId' | 'studentName' | 'centreId'>>,
  scopedStudents: ReadonlyArray<Pick<Student, 'studentId' | 'tmaFee' | 'examFee'>>,
  actor: UserAccount,
  options?: {
    onProgress?: (deleted: number, total: number) => void;
    locationVerified?: boolean;
  },
): Promise<{ deletedCount: number; failedIds: string[] }> {
  if (actor.role !== 'super_admin') {
    throw new Error('Only Super Admin can bulk-delete fee recovery records.');
  }

  const feeIds = Array.from(new Set(targetFeeRecords.map((r) => r.studentId).filter(Boolean)));
  const studentsWithExtras = scopedStudents.filter((s) => (s.tmaFee ?? 0) > 0 || (s.examFee ?? 0) > 0);

  if (feeIds.length === 0 && studentsWithExtras.length === 0) {
    return { deletedCount: 0, failedIds: [] };
  }

  const failedIds: string[] = [];
  let deletedCount = 0;
  const total = feeIds.length;

  // Chunk <= 350 ops (< 500 Firestore batch limit)
  const chunkSize = 350;
  for (let i = 0; i < feeIds.length; i += chunkSize) {
    const chunk = feeIds.slice(i, i + chunkSize);
    try {
      const batch = writeBatch(db);
      for (const sid of chunk) {
        batch.delete(doc(db, 'fee_recovery', sid));
      }
      await batch.commit();
      deletedCount += chunk.length;
      options?.onProgress?.(deletedCount, total);
    } catch {
      for (const sid of chunk) {
        try {
          await deleteDoc(doc(db, 'fee_recovery', sid));
          deletedCount += 1;
        } catch {
          failedIds.push(sid);
        }
        options?.onProgress?.(deletedCount, total);
      }
    }
  }

  // Zero out student-level TMA/Exam fee fields in scope so Fee Recovery clears cleanly
  for (let i = 0; i < studentsWithExtras.length; i += chunkSize) {
    const chunk = studentsWithExtras.slice(i, i + chunkSize);
    try {
      const batch = writeBatch(db);
      for (const s of chunk) {
        batch.update(doc(db, 'students', s.studentId), {
          tmaFee: 0,
          examFee: 0,
          updatedBy: actor.uid,
          updatedAt: serverTimestamp(),
        });
      }
      await batch.commit();
    } catch {
      // Non-blocking fallback
    }
  }

  if (deletedCount > 0 || studentsWithExtras.length > 0) {
    await logActivity({
      actorUid: actor.uid,
      actorName: actor.fullName,
      actorEmail: actor.email,
      actorRole: actor.role,
      centreId: 'all',
      department: 'fee_recovery',
      action: 'BULK_FEE_RECOVERY_DELETED',
      targetCollection: 'fee_recovery',
      targetId: 'bulk_clear',
      details: `Bulk-deleted ${deletedCount} fee recovery records${
        studentsWithExtras.length > 0 ? ` and cleared TMA/Exam fees on ${studentsWithExtras.length} students` : ''
      }${failedIds.length > 0 ? ` (${failedIds.length} failed)` : ''}.`,
      locationVerified: Boolean(options?.locationVerified ?? true),
    }).catch(() => {});
  }

  return { deletedCount, failedIds };
}

export async function upsertPracticalRecord(
  record: Omit<PracticalRecord, 'createdBy' | 'createdAt' | 'updatedBy' | 'updatedAt'>,
  actor: UserAccount,
  locationVerified: boolean,
): Promise<void> {
  const path = `practical_records/${record.studentId}`;
  try {
    const ref = doc(db, 'practical_records', record.studentId);
    const snap = await getDoc(ref);
    const empLockMeta =
      actor.role === 'employee'
        ? {
            employeeLocked: true,
            lockedByUid: actor.uid,
            lockedByName: actor.fullName.slice(0, 100),
          }
        : {};
    if (snap.exists()) {
      await updateDoc(ref, {
        ...record,
        ...empLockMeta,
        updatedBy: actor.uid,
        updatedAt: serverTimestamp(),
      });
    } else {
      await setDoc(ref, {
        ...record,
        ...empLockMeta,
        createdBy: actor.uid,
        createdAt: serverTimestamp(),
        updatedBy: actor.uid,
        updatedAt: serverTimestamp(),
      });
    }
    // Sync central student practicalStatus + per-department lock for employees
    await updateDoc(doc(db, 'students', record.studentId), {
      practicalStatus: record.practicalStatus,
      ...(actor.role === 'employee'
        ? {
            practicalLocked: true,
            lockedByUid: actor.uid,
            lockedByName: actor.fullName.slice(0, 100),
          }
        : {}),
      updatedBy: actor.uid,
      updatedAt: serverTimestamp(),
    }).catch(() => {});
    await logActivity({
      actorUid: actor.uid,
      actorName: actor.fullName,
      actorEmail: actor.email,
      actorRole: actor.role,
      centreId: record.centreId,
      department: 'practical',
      action: 'PRACTICAL_UPDATED',
      targetCollection: 'practical_records',
      targetId: record.studentId,
      details: `Updated Practical for ${record.studentName}: ${record.practicalStatus} (${record.completionPercentage}%).`,
      locationVerified,
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, path);
  }
}

export async function upsertTmaRecord(
  record: Omit<TmaRecord, 'createdBy' | 'createdAt' | 'updatedBy' | 'updatedAt'>,
  actor: UserAccount,
  locationVerified: boolean,
): Promise<void> {
  const path = `tma_records/${record.studentId}`;
  try {
    const ref = doc(db, 'tma_records', record.studentId);
    const snap = await getDoc(ref);
    const empLockMeta =
      actor.role === 'employee'
        ? {
            employeeLocked: true,
            lockedByUid: actor.uid,
            lockedByName: actor.fullName.slice(0, 100),
          }
        : {};
    if (snap.exists()) {
      await updateDoc(ref, {
        ...record,
        ...empLockMeta,
        updatedBy: actor.uid,
        updatedAt: serverTimestamp(),
      });
    } else {
      await setDoc(ref, {
        ...record,
        ...empLockMeta,
        createdBy: actor.uid,
        createdAt: serverTimestamp(),
        updatedBy: actor.uid,
        updatedAt: serverTimestamp(),
      });
    }
    await updateDoc(doc(db, 'students', record.studentId), {
      tmaStatus: record.tmaStatus,
      ...(actor.role === 'employee'
        ? {
            tmaLocked: true,
            lockedByUid: actor.uid,
            lockedByName: actor.fullName.slice(0, 100),
          }
        : {}),
      updatedBy: actor.uid,
      updatedAt: serverTimestamp(),
    }).catch(() => {});
    await logActivity({
      actorUid: actor.uid,
      actorName: actor.fullName,
      actorEmail: actor.email,
      actorRole: actor.role,
      centreId: record.centreId,
      department: 'tma',
      action: 'TMA_UPDATED',
      targetCollection: 'tma_records',
      targetId: record.studentId,
      details: `Updated TMA for ${record.studentName}: ${record.tmaStatus} (${record.subjectsSubmittedCount}/${record.totalSubjectsCount}).`,
      locationVerified,
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, path);
  }
}

export async function upsertOnlineClassRecord(
  record: Omit<OnlineClassRecord, 'createdBy' | 'createdAt' | 'updatedBy' | 'updatedAt'>,
  actor: UserAccount,
  locationVerified: boolean,
): Promise<void> {
  const path = `online_class_records/${record.studentId}`;
  try {
    const ref = doc(db, 'online_class_records', record.studentId);
    const snap = await getDoc(ref);
    const empLockMeta =
      actor.role === 'employee'
        ? {
            employeeLocked: true,
            lockedByUid: actor.uid,
            lockedByName: actor.fullName.slice(0, 100),
          }
        : {};
    if (snap.exists()) {
      await updateDoc(ref, {
        ...record,
        ...empLockMeta,
        updatedBy: actor.uid,
        updatedAt: serverTimestamp(),
      });
    } else {
      await setDoc(ref, {
        ...record,
        ...empLockMeta,
        createdBy: actor.uid,
        createdAt: serverTimestamp(),
        updatedBy: actor.uid,
        updatedAt: serverTimestamp(),
      });
    }
    await updateDoc(doc(db, 'students', record.studentId), {
      classAttendanceStatus: record.attendanceStatus,
      ...(actor.role === 'employee'
        ? {
            onlineClassesLocked: true,
            lockedByUid: actor.uid,
            lockedByName: actor.fullName.slice(0, 100),
          }
        : {}),
      updatedBy: actor.uid,
      updatedAt: serverTimestamp(),
    }).catch(() => {});
    await logActivity({
      actorUid: actor.uid,
      actorName: actor.fullName,
      actorEmail: actor.email,
      actorRole: actor.role,
      centreId: record.centreId,
      department: 'online_classes',
      action: 'ONLINE_CLASS_UPDATED',
      targetCollection: 'online_class_records',
      targetId: record.studentId,
      details: `Updated Online Class Attendance for ${record.studentName}: ${record.attendanceStatus} (${record.attendancePercentage}%).`,
      locationVerified,
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, path);
  }
}

export async function resetOnlineAttendanceToZeroBatch(
  students: Student[],
  onlineClassRecords: OnlineClassRecord[],
  actor: UserAccount,
  actionReason = 'Reset online class attendance to 0%',
): Promise<{ studentsUpdated: number; recordsUpdated: number }> {
  if (actor.role !== 'super_admin' && actor.role !== 'centre_head') {
    throw new Error('Only Super Admin or Centre Head can reset online attendance.');
  }

  const scopedStudents =
    actor.role === 'super_admin'
      ? students
      : students.filter((s) => s.centreId === actor.centreId);
  const scopedRecords =
    actor.role === 'super_admin'
      ? onlineClassRecords
      : onlineClassRecords.filter((r) => r.centreId === actor.centreId);

  const studentsToReset = scopedStudents.filter((s) => s.classAttendanceStatus !== 'Not Attending');
  const recordsToReset = scopedRecords.filter(
    (r) =>
      r.attendanceStatus !== 'Not Attending' ||
      Number(r.attendancePercentage ?? 0) !== 0 ||
      r.participationLevel !== 'Inactive',
  );

  let studentsUpdated = 0;
  let recordsUpdated = 0;

  try {
    const chunkSize = 350;

    for (let i = 0; i < studentsToReset.length; i += chunkSize) {
      const chunk = studentsToReset.slice(i, i + chunkSize);
      try {
        const batch = writeBatch(db);
        for (const s of chunk) {
          batch.update(doc(db, 'students', s.studentId), {
            classAttendanceStatus: 'Not Attending',
            updatedBy: actor.uid,
            updatedAt: serverTimestamp(),
          });
        }
        await batch.commit();
        studentsUpdated += chunk.length;
      } catch {
        for (const s of chunk) {
          try {
            await updateDoc(doc(db, 'students', s.studentId), {
              classAttendanceStatus: 'Not Attending',
              updatedBy: actor.uid,
              updatedAt: serverTimestamp(),
            });
            studentsUpdated += 1;
          } catch {
            // Skip any orphaned/deleted doc
          }
        }
      }
    }

    for (let i = 0; i < recordsToReset.length; i += chunkSize) {
      const chunk = recordsToReset.slice(i, i + chunkSize);
      try {
        const batch = writeBatch(db);
        for (const r of chunk) {
          batch.update(doc(db, 'online_class_records', r.studentId), {
            attendanceStatus: 'Not Attending',
            participationLevel: 'Inactive',
            attendancePercentage: 0,
            updatedBy: actor.uid,
            updatedAt: serverTimestamp(),
          });
        }
        await batch.commit();
        recordsUpdated += chunk.length;
      } catch {
        for (const r of chunk) {
          try {
            await updateDoc(doc(db, 'online_class_records', r.studentId), {
              attendanceStatus: 'Not Attending',
              participationLevel: 'Inactive',
              attendancePercentage: 0,
              updatedBy: actor.uid,
              updatedAt: serverTimestamp(),
            });
            recordsUpdated += 1;
          } catch {
            // Skip any orphaned/deleted doc
          }
        }
      }
    }

    if (studentsUpdated > 0 || recordsUpdated > 0) {
      await logActivity({
        actorUid: actor.uid,
        actorName: actor.fullName,
        actorEmail: actor.email,
        actorRole: actor.role,
        centreId: actor.role === 'super_admin' ? 'all' : actor.centreId,
        department: 'online_classes',
        action: 'ONLINE_ATTENDANCE_RESET_ZERO',
        targetCollection: 'online_class_records',
        targetId: actor.role === 'super_admin' ? 'all' : actor.centreId,
        details: `${actionReason} (${studentsUpdated} student rows, ${recordsUpdated} online class records set to 0% / Not Attending).`,
        locationVerified: true,
      }).catch(() => {});
    }

    return { studentsUpdated, recordsUpdated };
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, 'online_class_records');
    return { studentsUpdated, recordsUpdated };
  }
}

export async function upsertAdmissionRecord(
  record: Omit<AdmissionRecord, 'createdBy' | 'createdAt' | 'updatedBy' | 'updatedAt'>,
  actor: UserAccount,
  locationVerified: boolean,
): Promise<void> {
  const path = `admission_records/${record.studentId}`;
  try {
    const ref = doc(db, 'admission_records', record.studentId);
    const snap = await getDoc(ref);
    const empLockMeta =
      actor.role === 'employee'
        ? {
            employeeLocked: true,
            lockedByUid: actor.uid,
            lockedByName: actor.fullName.slice(0, 100),
          }
        : {};
    if (snap.exists()) {
      await updateDoc(ref, {
        ...record,
        ...empLockMeta,
        updatedBy: actor.uid,
        updatedAt: serverTimestamp(),
      });
    } else {
      await setDoc(ref, {
        ...record,
        ...empLockMeta,
        createdBy: actor.uid,
        createdAt: serverTimestamp(),
        updatedBy: actor.uid,
        updatedAt: serverTimestamp(),
      });
    }
    if (actor.role === 'employee') {
      await updateDoc(doc(db, 'students', record.studentId), {
        whyNios: record.niosPurpose,
        currentEducationStatus: record.academicBackground,
        additionalRemarks: record.remarks,
        admissionLocked: true,
        lockedByUid: actor.uid,
        lockedByName: actor.fullName.slice(0, 100),
        updatedBy: actor.uid,
        updatedAt: serverTimestamp(),
      }).catch(() => {});
    }
    await logActivity({
      actorUid: actor.uid,
      actorName: actor.fullName,
      actorEmail: actor.email,
      actorRole: actor.role,
      centreId: record.centreId,
      department: 'admission',
      action: 'ADMISSION_RECORD_UPDATED',
      targetCollection: 'admission_records',
      targetId: record.studentId,
      details: `Updated Admission record for ${record.studentName}: ${record.admissionStatus} (${record.followUpStatus}).`,
      locationVerified,
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, path);
  }
}

export async function fetchLocationVerifications(user: UserAccount): Promise<LocationVerification[]> {
  const path = 'location_verifications';
  try {
    const q =
      user.role === 'super_admin'
        ? query(collection(db, path), orderBy('createdAt', 'desc'))
        : user.role === 'centre_head'
          ? query(collection(db, path), where('centreId', '==', user.centreId), orderBy('createdAt', 'desc'))
          : query(collection(db, path), where('uid', '==', user.uid), orderBy('createdAt', 'desc'));
    const snap = await getDocs(q);
    return snap.docs.map((d) => ({ id: d.id, ...(d.data() as LocationVerification) }));
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, path);
  }
}

export async function emailToInviteId(email: string): Promise<string> {
  const normalized = email.trim().toLowerCase();
  const data = new TextEncoder().encode(normalized);
  const digest = await crypto.subtle.digest('SHA-256', data);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `inv_${hex.slice(0, 40)}`;
}

export async function createStaffInvite(
  params: {
    fullName: string;
    email: string;
    mobileNumber: string;
    role: 'centre_head' | 'employee';
    centreId: CentreId;
    department: UserDepartment;
    joiningDate: string;
  },
  actor: UserAccount,
): Promise<StaffInvite> {
  const cleanEmail = params.email.trim().toLowerCase();
  const inviteId = await emailToInviteId(cleanEmail);
  const centreName = CENTRE_MAP[params.centreId].name;
  const inviteDoc = {
    inviteId,
    fullName: params.fullName.trim().slice(0, 100),
    email: cleanEmail.slice(0, 160),
    mobileNumber: params.mobileNumber.trim().slice(0, 20),
    role: params.role,
    centreId: params.centreId,
    centreName,
    department: params.role === 'employee' ? (params.department === 'all' ? 'admission' : params.department) : 'all',
    joiningDate: params.joiningDate,
    status: 'Pending' as const,
    claimedUid: '',
    invitedBy: actor.uid,
    invitedByName: actor.fullName.slice(0, 100),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };

  try {
    const invRef = doc(db, 'staff_invites', inviteId);
    const existingSnap = await getDoc(invRef).catch(() => null);
    if (existingSnap && existingSnap.exists()) {
      await updateDoc(invRef, {
        fullName: inviteDoc.fullName,
        mobileNumber: inviteDoc.mobileNumber,
        role: inviteDoc.role,
        centreId: inviteDoc.centreId,
        centreName: inviteDoc.centreName,
        department: inviteDoc.department,
        joiningDate: inviteDoc.joiningDate,
        status: 'Pending',
        claimedUid: '',
        invitedBy: inviteDoc.invitedBy,
        invitedByName: inviteDoc.invitedByName,
        updatedAt: serverTimestamp(),
      });
    } else {
      await setDoc(invRef, inviteDoc);
    }
    await logActivity({
      actorUid: actor.uid,
      actorName: actor.fullName,
      actorEmail: actor.email,
      actorRole: actor.role,
      centreId: params.centreId,
      department: inviteDoc.department,
      action: 'STAFF_INVITE_CREATED',
      targetCollection: 'staff_invites',
      targetId: inviteId,
      details: `Pre-authorized ${params.role} (${params.fullName.trim()} · ${cleanEmail}) for ${centreName} (pending activation).`,
      locationVerified: true,
    });
    return inviteDoc as unknown as StaffInvite;
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, `staff_invites/${inviteId}`);
  }
}

export async function deleteStaffInvite(
  inviteId: string,
  email: string,
  centreId: CentreId,
  actor: UserAccount,
): Promise<void> {
  const path = `staff_invites/${inviteId}`;
  try {
    await deleteDoc(doc(db, 'staff_invites', inviteId));
    await logActivity({
      actorUid: actor.uid,
      actorName: actor.fullName,
      actorEmail: actor.email,
      actorRole: actor.role,
      centreId,
      department: 'all',
      action: 'STAFF_INVITE_REVOKED',
      targetCollection: 'staff_invites',
      targetId: inviteId,
      details: `Revoked pre-authorized staff invitation for ${email}.`,
      locationVerified: true,
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, path);
  }
}

const inFlightInviteClaims = new Map<string, Promise<UserAccount | null>>();

export function claimPendingStaffInvite(authUser: {
  uid: string;
  email: string;
  displayName?: string | null;
}): Promise<UserAccount | null> {
  const existingPromise = inFlightInviteClaims.get(authUser.uid);
  if (existingPromise) {
    return existingPromise;
  }

  const run = (async (): Promise<UserAccount | null> => {
    const existingProfile = await getUserProfile(authUser.uid).catch(() => null);
    if (existingProfile) return existingProfile;

    const cleanEmail = authUser.email.trim().toLowerCase();
    const inviteId = await emailToInviteId(cleanEmail);
    const inviteRef = doc(db, 'staff_invites', inviteId);
    let snap;
    try {
      snap = await getDoc(inviteRef);
    } catch {
      return null;
    }
    if (!snap.exists()) return null;

    const invite = snap.data() as StaffInvite;
    if (invite.status !== 'Pending') {
      return await getUserProfile(authUser.uid).catch(() => null);
    }

    const centreInfo = CENTRE_MAP[invite.centreId];
    const fullName = invite.fullName || authUser.displayName || cleanEmail.split('@')[0];

    const userProfile = {
      uid: authUser.uid,
      fullName: fullName.slice(0, 100),
      email: cleanEmail.slice(0, 160),
      mobileNumber: (invite.mobileNumber || '').slice(0, 20),
      role: invite.role as UserRole,
      centreId: invite.centreId,
      centreName: centreInfo.name,
      department: invite.department,
      status: 'Active' as const,
      joiningDate: invite.joiningDate || new Date().toISOString().slice(0, 10),
      createdBy: inviteId,
      createdAt: serverTimestamp(),
      updatedBy: authUser.uid,
      updatedAt: serverTimestamp(),
    };

    const batch = writeBatch(db);
    batch.set(doc(db, 'users', authUser.uid), userProfile);
    batch.update(inviteRef, {
      status: 'Claimed',
      claimedUid: authUser.uid,
      updatedAt: serverTimestamp(),
    });

    if (invite.role === 'employee' && invite.department !== 'all') {
      batch.set(doc(db, 'employee_assignments', authUser.uid), {
        uid: authUser.uid,
        employeeName: fullName.slice(0, 100),
        centreId: invite.centreId,
        department: invite.department,
        assignedBy: invite.invitedBy,
        status: 'Active',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else if (invite.role === 'centre_head') {
      batch.update(doc(db, 'centres', invite.centreId), {
        headUid: authUser.uid,
        headName: fullName.slice(0, 100),
        updatedBy: authUser.uid,
        updatedAt: serverTimestamp(),
      });

      const centreAssignRef = doc(db, 'centre_assignments', invite.centreId);
      const existingAssign = await getDoc(centreAssignRef).catch(() => null);
      if (existingAssign && existingAssign.exists()) {
        batch.update(centreAssignRef, {
          centreName: centreInfo.name,
          headUid: authUser.uid,
          headName: fullName.slice(0, 100),
          headEmail: cleanEmail,
          assignedBy: invite.invitedBy,
          updatedAt: serverTimestamp(),
        });
      } else {
        batch.set(centreAssignRef, {
          centreId: invite.centreId,
          centreName: centreInfo.name,
          headUid: authUser.uid,
          headName: fullName.slice(0, 100),
          headEmail: cleanEmail,
          assignedBy: invite.invitedBy,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }
    }

    try {
      await batch.commit();
      await logActivity({
        actorUid: authUser.uid,
        actorName: fullName,
        actorEmail: cleanEmail,
        actorRole: invite.role,
        centreId: invite.centreId,
        department: invite.department,
        action: 'STAFF_INVITE_CLAIMED',
        targetCollection: 'users',
        targetId: authUser.uid,
        details: `${fullName} activated ${invite.role} account at ${centreInfo.name} on login.`,
        locationVerified: true,
      }).catch(() => {});
      return userProfile as unknown as UserAccount;
    } catch (err) {
      // If another listener finished claiming simultaneously, return the created profile
      const fallback = await getUserProfile(authUser.uid).catch(() => null);
      if (fallback) return fallback;
      handleFirestoreError(err, OperationType.WRITE, `staff_invites/${inviteId}`);
    }
  })().finally(() => {
    inFlightInviteClaims.delete(authUser.uid);
  });

  inFlightInviteClaims.set(authUser.uid, run);
  return run;
}

export async function submitEmployeeReport(
  params: {
    reportDate: string;
    title: string;
    summary: string;
    tasksCompleted: number;
    studentsHandled: number;
    pendingIssues: string;
  },
  actor: UserAccount,
): Promise<void> {
  const reportId = `rep_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const path = `employee_reports/${reportId}`;
  try {
    await setDoc(doc(db, 'employee_reports', reportId), {
      reportId,
      employeeUid: actor.uid,
      employeeName: actor.fullName.slice(0, 100),
      employeeEmail: actor.email.slice(0, 160),
      role: actor.role,
      centreId: actor.centreId,
      centreName: actor.centreName.slice(0, 120),
      department: actor.department,
      reportDate: params.reportDate.slice(0, 30),
      title: params.title.trim().slice(0, 160),
      summary: params.summary.trim().slice(0, 2000),
      tasksCompleted: Math.max(0, Math.min(10000, Math.round(params.tasksCompleted))),
      studentsHandled: Math.max(0, Math.min(10000, Math.round(params.studentsHandled))),
      pendingIssues: params.pendingIssues.trim().slice(0, 1000),
      status: 'Submitted',
      reviewerName: '',
      reviewerNote: '',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    await createNotification({
      recipientUid: actor.uid,
      centreId: actor.centreId,
      title: `Work Report Submitted (${actor.department})`,
      message: `${actor.fullName} submitted "${params.title.trim()}" (${params.studentsHandled} students handled).`,
      type: 'info',
      read: false,
    }).catch(() => {});

    await logActivity({
      actorUid: actor.uid,
      actorName: actor.fullName,
      actorEmail: actor.email,
      actorRole: actor.role,
      centreId: actor.centreId,
      department: actor.department,
      action: 'EMPLOYEE_REPORT_SUBMITTED',
      targetCollection: 'employee_reports',
      targetId: reportId,
      details: `Submitted report "${params.title.trim()}" (${params.tasksCompleted} tasks, ${params.studentsHandled} students).`,
      locationVerified: true,
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, path);
  }
}

export async function reviewEmployeeReport(
  reportId: string,
  status: EmployeeReportStatus,
  reviewerNote: string,
  actor: UserAccount,
  centreId: CentreId,
): Promise<void> {
  const path = `employee_reports/${reportId}`;
  try {
    await updateDoc(doc(db, 'employee_reports', reportId), {
      status,
      reviewerName: actor.fullName.slice(0, 100),
      reviewerNote: reviewerNote.trim().slice(0, 1000),
      updatedAt: serverTimestamp(),
    });
    await logActivity({
      actorUid: actor.uid,
      actorName: actor.fullName,
      actorEmail: actor.email,
      actorRole: actor.role,
      centreId,
      department: actor.department,
      action: 'EMPLOYEE_REPORT_REVIEWED',
      targetCollection: 'employee_reports',
      targetId: reportId,
      details: `Marked report ${reportId} as ${status}.`,
      locationVerified: true,
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}

export async function createEditRequest(
  params: {
    student: Student;
    department: DepartmentId;
    reason: string;
  },
  actor: UserAccount,
): Promise<EditRequest> {
  const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const path = `edit_requests/${requestId}`;
  const cleanReason = params.reason.trim().slice(0, 500);
  if (cleanReason.length < 3) {
    throw new Error('Please enter a valid reason (at least 3 characters) for the Centre Head.');
  }

  const payload = {
    requestId,
    studentId: params.student.studentId,
    studentName: params.student.studentName.slice(0, 120),
    serialNumber: Math.max(1, Number(params.student.serialNumber || 1)),
    centreId: params.student.centreId,
    department: params.department,
    requesterUid: actor.uid,
    requesterName: actor.fullName.slice(0, 100),
    requesterEmail: actor.email.slice(0, 160),
    reason: cleanReason,
    status: 'Pending' as const,
    reviewedByUid: '',
    reviewedByName: '',
    reviewerNote: '',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };

  try {
    await setDoc(doc(db, 'edit_requests', requestId), payload);

    const deptLabel = DEPARTMENT_LABELS[params.department] || params.department;
    await createNotification({
      recipientUid: actor.uid,
      centreId: params.student.centreId,
      title: `Edit Permission Request (${deptLabel})`,
      message: `${actor.fullName} requested 1-time edit permission for ${params.student.studentName} (#${params.student.serialNumber}): "${cleanReason}"`,
      type: 'warning',
      read: false,
    }).catch(() => {});

    await logActivity({
      actorUid: actor.uid,
      actorName: actor.fullName,
      actorEmail: actor.email,
      actorRole: actor.role,
      centreId: params.student.centreId,
      department: params.department,
      action: 'EDIT_PERMISSION_REQUESTED',
      targetCollection: 'edit_requests',
      targetId: requestId,
      details: `${actor.fullName} requested ${deptLabel} correction access for ${params.student.studentName} (#${params.student.serialNumber}): ${cleanReason}`,
      locationVerified: true,
    });

    return payload as unknown as EditRequest;
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, path);
  }
}

export async function reviewEditRequest(
  request: EditRequest,
  decision: 'Approved' | 'Rejected',
  reviewerNote: string,
  actor: UserAccount,
): Promise<void> {
  const path = `edit_requests/${request.requestId}`;
  try {
    const cleanNote = reviewerNote.trim().slice(0, 500);
    const batch = writeBatch(db);

    batch.update(doc(db, 'edit_requests', request.requestId), {
      status: decision,
      reviewedByUid: actor.uid,
      reviewedByName: actor.fullName.slice(0, 100),
      reviewerNote: cleanNote,
      updatedAt: serverTimestamp(),
    });

    if (decision === 'Approved') {
      const lockField = getStudentDeptLockField(request.department);
      if (lockField) {
        batch.update(doc(db, 'students', request.studentId), {
          [lockField]: false,
          updatedBy: actor.uid,
          updatedAt: serverTimestamp(),
        });
      }
      const deptCol = DEPT_COLLECTION_MAP[request.department];
      if (deptCol) {
        const deptRef = doc(db, deptCol, request.studentId);
        const deptSnap = await getDoc(deptRef).catch(() => null);
        if (deptSnap && deptSnap.exists()) {
          batch.update(deptRef, {
            employeeLocked: false,
            updatedBy: actor.uid,
            updatedAt: serverTimestamp(),
          });
        }
      }
    }

    await batch.commit();

    const deptLabel = DEPARTMENT_LABELS[request.department] || request.department;
    await createNotification({
      recipientUid: request.requesterUid,
      centreId: request.centreId,
      title: `Edit Request ${decision} (${deptLabel})`,
      message:
        decision === 'Approved'
          ? `${actor.fullName} unlocked ${deptLabel} for 1 correction edit on ${request.studentName} (#${request.serialNumber}).${cleanNote ? ` Note: ${cleanNote}` : ''}`
          : `${actor.fullName} rejected your ${deptLabel} edit request for ${request.studentName} (#${request.serialNumber}).${cleanNote ? ` Note: ${cleanNote}` : ''}`,
      type: decision === 'Approved' ? 'info' : 'warning',
      read: false,
    }).catch(() => {});

    await logActivity({
      actorUid: actor.uid,
      actorName: actor.fullName,
      actorEmail: actor.email,
      actorRole: actor.role,
      centreId: request.centreId,
      department: request.department,
      action: decision === 'Approved' ? 'EDIT_PERMISSION_APPROVED' : 'EDIT_PERMISSION_REJECTED',
      targetCollection: 'edit_requests',
      targetId: request.requestId,
      details: `${actor.fullName} ${decision.toLowerCase()} ${request.requesterName}'s ${deptLabel} edit request for ${request.studentName} (#${request.serialNumber}).`,
      locationVerified: true,
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, path);
  }
}

export async function sendDirectMessage(
  params: {
    targetStaff?: UserAccount;
    text: string;
    messageType?: DirectMessageType;
  },
  actor: UserAccount,
): Promise<string> {
  const cleanText = params.text.trim().slice(0, 1500);
  if (!cleanText) {
    throw new Error('Message cannot be empty.');
  }

  const isAdmin = actor.role === 'super_admin';
  const staff = isAdmin ? params.targetStaff : actor;
  if (!staff || staff.role === 'super_admin') {
    throw new Error('A valid staff recipient is required.');
  }

  const messageId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const path = `direct_messages/${messageId}`;
  const payload = {
    messageId,
    staffUid: staff.uid,
    staffName: staff.fullName.slice(0, 100),
    staffEmail: staff.email.slice(0, 160),
    staffRole: staff.role === 'centre_head' ? 'centre_head' : 'employee',
    centreId: staff.centreId,
    department: staff.department,
    senderUid: actor.uid,
    senderName: actor.fullName.slice(0, 100),
    senderRole: actor.role,
    messageType: params.messageType || 'text',
    text: cleanText,
    readByStaff: !isAdmin,
    readByAdmin: isAdmin,
    createdAt: serverTimestamp(),
  };

  try {
    await setDoc(doc(db, 'direct_messages', messageId), payload);
    return messageId;
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, path);
  }
}

export async function broadcastDirectMessage(
  targets: UserAccount[],
  text: string,
  actor: UserAccount,
): Promise<number> {
  if (actor.role !== 'super_admin') {
    throw new Error('Only Super Admin can broadcast messages to staff.');
  }
  const cleanText = text.trim().slice(0, 1500);
  if (!cleanText) {
    throw new Error('Broadcast message cannot be empty.');
  }

  const eligible = targets.filter((u) => u.role !== 'super_admin' && u.status === 'Active');
  if (eligible.length === 0) {
    throw new Error('No active staff members found in the selected scope.');
  }

  const chunkSize = 400;
  try {
    for (let i = 0; i < eligible.length; i += chunkSize) {
      const chunk = eligible.slice(i, i + chunkSize);
      const batch = writeBatch(db);
      for (const staff of chunk) {
        const messageId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        batch.set(doc(db, 'direct_messages', messageId), {
          messageId,
          staffUid: staff.uid,
          staffName: staff.fullName.slice(0, 100),
          staffEmail: staff.email.slice(0, 160),
          staffRole: staff.role === 'centre_head' ? 'centre_head' : 'employee',
          centreId: staff.centreId,
          department: staff.department,
          senderUid: actor.uid,
          senderName: actor.fullName.slice(0, 100),
          senderRole: 'super_admin',
          messageType: 'text',
          text: cleanText,
          readByStaff: false,
          readByAdmin: true,
          createdAt: serverTimestamp(),
        });
      }
      await batch.commit();
    }
    return eligible.length;
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, 'direct_messages');
  }
}

export async function markDirectMessagesRead(
  messages: DirectMessage[],
  actor: UserAccount,
): Promise<void> {
  const isAdmin = actor.role === 'super_admin';
  const unread = messages.filter((m) =>
    isAdmin ? !m.readByAdmin : m.staffUid === actor.uid && !m.readByStaff,
  );
  if (unread.length === 0) return;

  try {
    const chunkSize = 400;
    for (let i = 0; i < unread.length; i += chunkSize) {
      const batch = writeBatch(db);
      for (const msg of unread.slice(i, i + chunkSize)) {
        batch.update(
          doc(db, 'direct_messages', msg.messageId),
          isAdmin ? { readByAdmin: true } : { readByStaff: true },
        );
      }
      await batch.commit();
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, 'direct_messages');
  }
}

export async function clearMockSubjectsFromStudents(
  students: Student[],
  actor: UserAccount,
  options?: { locationVerified?: boolean; onProgress?: (done: number, total: number) => void },
): Promise<{ clearedCount: number }> {
  if (actor.role !== 'super_admin' && actor.role !== 'centre_head') {
    throw new Error('Only Super Admin or Centre Head can clear mock subjects.');
  }

  const scopedStudents =
    actor.role === 'super_admin'
      ? students
      : students.filter((s) => s.centreId === actor.centreId);
  const targets = scopedStudents.filter((s) => isMockSubjectValue(s.subject));
  if (targets.length === 0) {
    return { clearedCount: 0 };
  }

  const readSnap = async (colName: string, id: string) => {
    try {
      const snap = await getDoc(doc(db, colName, id));
      return snap.exists() ? (snap.data() as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };

  let clearedCount = 0;
  try {
    const chunkSize = 50;
    for (let i = 0; i < targets.length; i += chunkSize) {
      const chunk = targets.slice(i, i + chunkSize);
      const [tmaSnaps, admSnaps] = await Promise.all([
        Promise.all(chunk.map((s) => readSnap('tma_records', s.studentId))),
        Promise.all(chunk.map((s) => readSnap('admission_records', s.studentId))),
      ]);

      const batch = writeBatch(db);
      chunk.forEach((s, idx) => {
        batch.update(doc(db, 'students', s.studentId), {
          subject: '',
          updatedBy: actor.uid,
          updatedAt: serverTimestamp(),
        });

        const tmaDoc = tmaSnaps[idx];
        if (tmaDoc && Number(tmaDoc.totalSubjectsCount ?? 0) === 5) {
          batch.update(doc(db, 'tma_records', s.studentId), {
            totalSubjectsCount: 0,
            subjectsSubmittedCount: 0,
            updatedBy: actor.uid,
            updatedAt: serverTimestamp(),
          });
        }

        const admDoc = admSnaps[idx];
        if (admDoc && isMockSubjectValue(String(admDoc.stream ?? ''))) {
          batch.update(doc(db, 'admission_records', s.studentId), {
            stream: '',
            updatedBy: actor.uid,
            updatedAt: serverTimestamp(),
          });
        }
      });

      await batch.commit();
      clearedCount += chunk.length;
      options?.onProgress?.(clearedCount, targets.length);
    }

    if (clearedCount > 0) {
      await logActivity({
        actorUid: actor.uid,
        actorName: actor.fullName,
        actorEmail: actor.email,
        actorRole: actor.role,
        centreId: actor.role === 'super_admin' ? 'all' : actor.centreId,
        department: 'tma',
        action: 'MOCK_SUBJECTS_CLEARED',
        targetCollection: 'students',
        targetId: actor.role === 'super_admin' ? 'multi_centre' : actor.centreId,
        details: `Cleared mock/default subjects on ${clearedCount} student record(s) — ready for Excel subject update.`,
        locationVerified: Boolean(options?.locationVerified ?? true),
      }).catch(() => {});
    }

    return { clearedCount };
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, 'students');
    return { clearedCount };
  }
}

export interface CreateWorkAssignmentTaskInput {
  student: Student;
  displaySerial: number;
  subject?: string;
  pendingFee?: number;
  totalFee?: number;
}

export async function createWorkAssignmentBatch(params: {
  centreId: CentreId;
  department: WorkAssignmentDepartment;
  staff: UserAccount;
  fromSerial: number;
  toSerial: number;
  items: CreateWorkAssignmentTaskInput[];
  replaceExistingActive: boolean;
  existingAssignments: WorkAssignment[];
  existingTasks?: WorkAssignmentTask[];
  note?: string;
  actor: UserAccount;
}): Promise<{ assignmentId: string; taskCount: number }> {
  const {
    centreId,
    department,
    staff,
    fromSerial,
    toSerial,
    items,
    replaceExistingActive,
    existingAssignments,
    existingTasks = [],
    note = '',
    actor,
  } = params;

  if (!canManageAssignmentForCentre(actor, centreId)) {
    throw new Error('Only Super Admin or the Centre Head of this branch can assign staff work.');
  }
  if (items.length === 0) {
    throw new Error('Please select at least 1 student from the Excel list to assign.');
  }
  if (items.length > 2000) {
    throw new Error('Please assign up to 2000 students in a single batch.');
  }

  const centreInfo = CENTRE_MAP[centreId];
  const now = new Date();
  const assignedDate = formatLocalDateIso(now);

  // Enforce same-day duplicate assignment lock: students assigned today cannot be assigned again today
  const assignedTodayMap = getStudentsAssignedTodayMap(
    existingAssignments,
    existingTasks,
    centreId,
    department,
    assignedDate,
  );
  const eligibleItems = items.filter((item) => !assignedTodayMap.has(item.student.studentId));
  if (eligibleItems.length === 0) {
    throw new Error(
      'Selected students are already assigned today. They will automatically unlock tomorrow for reassignment.',
    );
  }

  const randomSuffix = Math.random().toString(36).slice(2, 7).toUpperCase();
  const assignmentId = sanitizeFirestoreDocId(`WA_${department}_${centreId}_${Date.now()}_${randomSuffix}`, 100);
  const safeFrom = Math.max(1, Math.floor(fromSerial));
  const safeTo = Math.max(safeFrom, Math.floor(toSerial));
  const safeNote = String(note || '').trim().slice(0, 500);
  const safeStaffName = (staff.fullName || 'Staff').trim().slice(0, 100) || 'Staff';
  const safeActorName = (actor.fullName || 'Admin').trim().slice(0, 100) || 'Admin';

  try {
    // 1. Optionally archive previous active batches for the same staff + department so they only see today's active batch
    if (replaceExistingActive) {
      const toArchive = existingAssignments.filter(
        (a) =>
          a.staffUid === staff.uid &&
          a.department === department &&
          a.centreId === centreId &&
          a.status === 'Active',
      );
      if (toArchive.length > 0) {
        const archiveBatch = writeBatch(db);
        toArchive.forEach((oldBatch) => {
          archiveBatch.update(doc(db, 'work_assignments', oldBatch.assignmentId), {
            status: 'Archived',
            updatedAt: serverTimestamp(),
          });
        });
        await archiveBatch.commit();
      }
    }

    // 2. Create parent assignment document
    await setDoc(doc(db, 'work_assignments', assignmentId), {
      assignmentId,
      centreId,
      centreName: (centreInfo?.name || 'Vision Point').slice(0, 120),
      department,
      staffUid: staff.uid,
      staffName: safeStaffName,
      staffEmail: (staff.email || '').trim().slice(0, 160),
      assignedByUid: actor.uid,
      assignedByName: safeActorName,
      assignedDate,
      fromSerial: safeFrom,
      toSerial: safeTo,
      totalStudents: eligibleItems.length,
      status: 'Active',
      note: safeNote,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    // 3. Write task cards in safe chunks (<= 350 per batch)
    const chunkSize = 350;
    for (let i = 0; i < eligibleItems.length; i += chunkSize) {
      const chunk = eligibleItems.slice(i, i + chunkSize);
      const batch = writeBatch(db);
      chunk.forEach((item) => {
        const taskId = sanitizeFirestoreDocId(`${assignmentId}__${item.student.studentId}`, 128);
        const fatherName = extractStudentFatherName(item.student);
        const callingNumber = extractStudentCallingNumber(item.student);
        const safeSubject = String(item.subject ?? item.student.subject ?? '').trim().slice(0, 200);
        const safePendingFee = clampFeeValue(item.pendingFee ?? 0);
        const safeTotalFee = clampFeeValue(item.totalFee ?? 0);

        batch.set(doc(db, 'work_assignment_tasks', taskId), {
          taskId,
          assignmentId,
          centreId,
          department,
          staffUid: staff.uid,
          staffName: safeStaffName,
          studentId: item.student.studentId,
          serialNumber: Math.max(1, Math.round(item.displaySerial || item.student.serialNumber || 1)),
          studentName: (item.student.studentName || 'Student').trim().slice(0, 120) || 'Student',
          fatherName: fatherName.slice(0, 120),
          mobileNumber: String(item.student.mobileNumber || '').trim().slice(0, 20),
          callingNumber: callingNumber.slice(0, 20),
          subject: safeSubject,
          pendingFee: safePendingFee,
          totalFee: safeTotalFee,
          callStatus: 'Pending',
          followUpDate: '',
          followUpTime: '',
          remark: '',
          lastCalledAt: '',
          updatedBy: actor.uid,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      });
      await batch.commit();
    }

    // 4. Notify staff & log audit trail
    const deptLabel = WORK_ASSIGNMENT_DEPARTMENT_LABELS[department];
    await createNotification({
      recipientUid: staff.uid,
      centreId,
      title: `New ${deptLabel} Work Assigned`,
      message: `${safeActorName} assigned ${eligibleItems.length} students (S.No #${safeFrom} to #${safeTo}) for ${deptLabel}.`,
      type: 'info',
      read: false,
    }).catch(() => {});

    await logActivity({
      actorUid: actor.uid,
      actorName: safeActorName,
      actorEmail: actor.email,
      actorRole: actor.role,
      centreId,
      department,
      action: 'WORK_ASSIGNMENT_CREATED',
      targetCollection: 'work_assignments',
      targetId: assignmentId,
      details: `Assigned ${eligibleItems.length} students (S.No #${safeFrom}-#${safeTo}) in ${deptLabel} to ${safeStaffName}.`,
      locationVerified: true,
    }).catch(() => {});

    return { assignmentId, taskCount: eligibleItems.length };
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, `work_assignments/${assignmentId}`);
    return { assignmentId, taskCount: 0 };
  }
}

export async function updateWorkAssignmentTask(
  task: WorkAssignmentTask,
  updates: {
    callStatus: CallTaskStatus;
    followUpDate: string;
    followUpTime: string;
    remark: string;
    markCalledNow?: boolean;
  },
  actor: UserAccount,
): Promise<void> {
  const path = `work_assignment_tasks/${task.taskId}`;
  try {
    const cleanDate = String(updates.followUpDate || '').trim().slice(0, 30);
    const cleanTime = String(updates.followUpTime || '').trim().slice(0, 10);
    const cleanRemark = String(updates.remark || '').trim().slice(0, 1000);
    const lastCalledAt = updates.markCalledNow
      ? new Date().toISOString().slice(0, 35)
      : (task.lastCalledAt || new Date().toISOString().slice(0, 35));

    await updateDoc(doc(db, 'work_assignment_tasks', task.taskId), {
      callStatus: updates.callStatus,
      followUpDate: cleanDate,
      followUpTime: cleanTime,
      remark: cleanRemark,
      lastCalledAt,
      updatedBy: actor.uid,
      updatedAt: serverTimestamp(),
    });

    // Live-sync calling remark & next follow-up schedule into the student's department table document
    const formattedNextFollowUp = formatStoredFollowUpDateTime(cleanDate, cleanTime);
    const todayIso = formatLocalDateIso(new Date());

    if (task.department === 'fee_recovery') {
      const feeRef = doc(db, 'fee_recovery', task.studentId);
      try {
        const feeSnap = await getDoc(feeRef);
        const mappedFollowUp = mapCallStatusToFeeFollowUp(
          updates.callStatus,
          feeSnap.exists() ? (feeSnap.data().followUpStatus as FeeFollowUpStatus | undefined) : undefined,
        );
        if (feeSnap.exists()) {
          await updateDoc(feeRef, {
            followUpNotes: cleanRemark,
            nextFollowUpDate: formattedNextFollowUp || String(feeSnap.data().nextFollowUpDate || ''),
            lastContactDate: todayIso,
            followUpStatus: mappedFollowUp,
            updatedBy: actor.uid,
            updatedAt: serverTimestamp(),
          });
        } else {
          const totalFee = clampFeeValue(task.totalFee);
          const pendingAmount = clampFeeValue(task.pendingFee);
          const paidAmount = Math.max(0, totalFee - pendingAmount);
          const safeMobile = (task.mobileNumber || task.callingNumber || '0000000000').slice(0, 20);
          await setDoc(feeRef, {
            studentId: task.studentId,
            studentName: (task.studentName || 'Student').slice(0, 120),
            mobileNumber: safeMobile.length >= 7 ? safeMobile : '0000000000',
            centreId: task.centreId,
            recoveryStatus: pendingAmount === 0 && totalFee > 0 ? 'Paid' : paidAmount > 0 ? 'Partial' : 'Pending',
            followUpStatus: mappedFollowUp,
            totalFee,
            paidAmount,
            pendingAmount,
            assignedEmployeeUid: actor.uid,
            assignedEmployeeName: (actor.fullName || task.staffName || 'Staff').slice(0, 100),
            followUpNotes: cleanRemark,
            lastContactDate: todayIso,
            nextFollowUpDate: formattedNextFollowUp || todayIso,
            ...(actor.role === 'employee'
              ? { employeeLocked: true, lockedByUid: actor.uid, lockedByName: actor.fullName }
              : {}),
            createdBy: actor.uid,
            createdAt: serverTimestamp(),
            updatedBy: actor.uid,
            updatedAt: serverTimestamp(),
          });
        }
      } catch {
        // Non-blocking: task update already succeeded and UI also reads live from work_assignment_tasks
      }
    } else if (task.department === 'practical' || task.department === 'tma') {
      const colName = task.department === 'practical' ? 'practical_records' : 'tma_records';
      const combinedRemark = formattedNextFollowUp
        ? `[Next Call: ${formattedNextFollowUp}] ${cleanRemark}`.trim().slice(0, 1000)
        : cleanRemark;
      if (combinedRemark) {
        try {
          const deptRef = doc(db, colName, task.studentId);
          const deptSnap = await getDoc(deptRef);
          if (deptSnap.exists()) {
            await updateDoc(deptRef, {
              remarks: combinedRemark,
              updatedBy: actor.uid,
              updatedAt: serverTimestamp(),
            });
          }
        } catch {
          // Non-blocking fallback
        }
      }
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}

export async function updateWorkAssignmentStatus(
  assignment: WorkAssignment,
  status: WorkAssignmentStatus,
  actor: UserAccount,
): Promise<void> {
  if (!canManageAssignmentForCentre(actor, assignment.centreId)) {
    throw new Error('Only Super Admin or the Centre Head of this branch can update work assignment status.');
  }
  const path = `work_assignments/${assignment.assignmentId}`;
  try {
    await updateDoc(doc(db, 'work_assignments', assignment.assignmentId), {
      status,
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}

export async function deleteWorkAssignmentBatch(
  assignment: WorkAssignment,
  tasks: WorkAssignmentTask[],
  actor: UserAccount,
): Promise<void> {
  if (!canManageAssignmentForCentre(actor, assignment.centreId)) {
    throw new Error('Only Super Admin or the Centre Head of this branch can delete work assignments.');
  }
  const path = `work_assignments/${assignment.assignmentId}`;
  try {
    const relatedTasks = tasks.filter((t) => t.assignmentId === assignment.assignmentId);
    const chunkSize = 350;
    for (let i = 0; i < relatedTasks.length; i += chunkSize) {
      const chunk = relatedTasks.slice(i, i + chunkSize);
      const batch = writeBatch(db);
      chunk.forEach((t) => {
        batch.delete(doc(db, 'work_assignment_tasks', t.taskId));
      });
      await batch.commit();
    }
    await deleteDoc(doc(db, 'work_assignments', assignment.assignmentId));

    await logActivity({
      actorUid: actor.uid,
      actorName: actor.fullName,
      actorEmail: actor.email,
      actorRole: actor.role,
      centreId: assignment.centreId,
      department: assignment.department,
      action: 'WORK_ASSIGNMENT_DELETED',
      targetCollection: 'work_assignments',
      targetId: assignment.assignmentId,
      details: `Removed work assignment S.No #${assignment.fromSerial}-#${assignment.toSerial} (${assignment.staffName}).`,
      locationVerified: true,
    }).catch(() => {});
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, path);
  }
}

export interface RestoreProgressState {
  stage: string;
  processed: number;
  total: number;
}

export interface RestoreDatabaseResult {
  restoredCounts: Record<string, number>;
  skippedCount: number;
  failedCount: number;
  totalRestored: number;
}

export async function restoreFullDatabaseBackup(
  backup: FullDatabaseBackupPayload,
  actor: UserAccount,
  onProgress?: (progress: RestoreProgressState) => void,
): Promise<RestoreDatabaseResult> {
  if (actor.role !== 'super_admin') {
    throw new Error('Only Super Admin can restore a full institutional database backup.');
  }

  const totalDocs = Math.max(
    1,
    backup.centres.length +
      backup.excel_sheet_configs.length +
      backup.students.length +
      backup.fee_recovery.length +
      backup.practical_records.length +
      backup.tma_records.length +
      backup.online_class_records.length +
      backup.admission_records.length +
      backup.work_assignments.length +
      backup.work_assignment_tasks.length +
      (backup.settings ? 1 : 0),
  );

  let processed = 0;
  let skippedCount = 0;
  let failedCount = 0;
  const restoredCounts: Record<string, number> = {};

  const emitProgress = (stage: string) => {
    onProgress?.({ stage, processed, total: totalDocs });
  };

  const writeCollectionChunked = async (
    colName: string,
    label: string,
    items: Array<{ id: string; data: Record<string, unknown> }>,
    options: { hasCreatedAt: boolean; hasCreatedBy: boolean },
  ): Promise<Set<string>> => {
    const writtenIds = new Set<string>();
    if (items.length === 0) {
      restoredCounts[colName] = 0;
      return writtenIds;
    }

    emitProgress(`Checking existing ${label}...`);
    const existingMap = new Map<string, { createdAt?: unknown; createdBy?: unknown }>();
    try {
      const existingSnap = await getDocs(collection(db, colName));
      existingSnap.forEach((d) => {
        const raw = d.data();
        existingMap.set(d.id, { createdAt: raw.createdAt, createdBy: raw.createdBy });
        writtenIds.add(d.id);
      });
    } catch {
      // Proceed with create payloads if target collection is empty/unreadable
    }

    const chunkSize = 180;
    let restoredInCol = 0;
    for (let i = 0; i < items.length; i += chunkSize) {
      const chunk = items.slice(i, i + chunkSize);
      emitProgress(`Restoring ${label} (${Math.min(i + chunk.length, items.length)} / ${items.length})...`);

      const prepared = chunk.map((item) => {
        const existing = existingMap.get(item.id);
        const payload: Record<string, unknown> = { ...item.data, updatedAt: serverTimestamp() };
        if (options.hasCreatedAt) {
          payload.createdAt = existing?.createdAt ?? serverTimestamp();
        }
        if (options.hasCreatedBy && existing?.createdBy && typeof existing.createdBy === 'string') {
          payload.createdBy = existing.createdBy;
        }
        return { id: item.id, payload };
      });

      try {
        const batch = writeBatch(db);
        for (const row of prepared) {
          batch.set(doc(db, colName, row.id), row.payload);
        }
        await batch.commit();
        for (const row of prepared) {
          writtenIds.add(row.id);
        }
        restoredInCol += prepared.length;
      } catch {
        // Fallback per-document so one bad legacy doc never blocks the remaining records
        for (const row of prepared) {
          try {
            await setDoc(doc(db, colName, row.id), row.payload);
            writtenIds.add(row.id);
            restoredInCol += 1;
          } catch {
            failedCount += 1;
          }
        }
      }

      processed += chunk.length;
      emitProgress(`Restored ${label}...`);
    }

    restoredCounts[colName] = restoredInCol;
    return writtenIds;
  };

  // 1. Centres (prerequisite for students)
  const centreItems = backup.centres.map((raw) => sanitizeCentreForRestore(raw, actor.uid));
  await writeCollectionChunked('centres', 'Centres', centreItems, { hasCreatedAt: true, hasCreatedBy: false });

  // 2. Excel Sheet Configs (column headings, custom columns, deleted columns)
  const configItems = backup.excel_sheet_configs.map((raw) => sanitizeExcelSheetConfigForRestore(raw, actor.uid));
  await writeCollectionChunked('excel_sheet_configs', 'Excel Sheet Configs', configItems, {
    hasCreatedAt: false,
    hasCreatedBy: false,
  });

  // 3. Students (prerequisite for all 5 department collections)
  const studentItems = backup.students.map((raw, idx) => sanitizeStudentForRestore(raw, actor.uid, idx + 1));
  const validStudentIds = await writeCollectionChunked('students', 'Students', studentItems, {
    hasCreatedAt: true,
    hasCreatedBy: true,
  });

  const filterByExistingStudent = (items: Array<{ id: string; data: Record<string, unknown> }>) => {
    const valid: Array<{ id: string; data: Record<string, unknown> }> = [];
    for (const item of items) {
      if (validStudentIds.has(item.id)) {
        valid.push(item);
      } else {
        skippedCount += 1;
        processed += 1;
      }
    }
    return valid;
  };

  // 4. Department Records (requires studentId existence per firestore.rules)
  await writeCollectionChunked(
    'fee_recovery',
    'Fee Recovery Records',
    filterByExistingStudent(backup.fee_recovery.map((raw) => sanitizeFeeRecoveryForRestore(raw, actor.uid))),
    { hasCreatedAt: true, hasCreatedBy: true },
  );

  await writeCollectionChunked(
    'practical_records',
    'Practical Records',
    filterByExistingStudent(backup.practical_records.map((raw) => sanitizePracticalForRestore(raw, actor.uid))),
    { hasCreatedAt: true, hasCreatedBy: true },
  );

  await writeCollectionChunked(
    'tma_records',
    'TMA Records',
    filterByExistingStudent(backup.tma_records.map((raw) => sanitizeTmaForRestore(raw, actor.uid))),
    { hasCreatedAt: true, hasCreatedBy: true },
  );

  await writeCollectionChunked(
    'online_class_records',
    'Online Classes Records',
    filterByExistingStudent(backup.online_class_records.map((raw) => sanitizeOnlineClassForRestore(raw, actor.uid))),
    { hasCreatedAt: true, hasCreatedBy: true },
  );

  await writeCollectionChunked(
    'admission_records',
    'Admission Records',
    filterByExistingStudent(backup.admission_records.map((raw) => sanitizeAdmissionForRestore(raw, actor.uid))),
    { hasCreatedAt: true, hasCreatedBy: true },
  );

  // 5. Work Assignments & Tasks
  await writeCollectionChunked(
    'work_assignments',
    'Staff Work Assignments',
    backup.work_assignments.map((raw) => sanitizeWorkAssignmentForRestore(raw, actor.uid, actor.fullName)),
    { hasCreatedAt: true, hasCreatedBy: false },
  );

  await writeCollectionChunked(
    'work_assignment_tasks',
    'Staff Calling Tasks',
    backup.work_assignment_tasks.map((raw) => sanitizeWorkAssignmentTaskForRestore(raw, actor.uid)),
    { hasCreatedAt: true, hasCreatedBy: false },
  );

  // 6. Global System Settings
  if (backup.settings) {
    emitProgress('Restoring System Settings...');
    try {
      await setDoc(doc(db, 'system_settings', 'global'), {
        superAdminEmail: actor.email,
        superAdminUid: actor.uid,
        geofenceEnabled: backup.settings.geofenceEnabled !== false,
        emergencyOverrideActive: backup.settings.emergencyOverrideActive === true,
        sessionTimeoutMinutes: Math.min(1440, Math.max(5, Number(backup.settings.sessionTimeoutMinutes) || 60)),
        maxGpsAccuracyMeters: Math.min(5000, Math.max(20, Number(backup.settings.maxGpsAccuracyMeters) || 500)),
        updatedAt: serverTimestamp(),
        updatedBy: actor.uid,
      });
      restoredCounts.system_settings = 1;
    } catch {
      failedCount += 1;
    }
    processed += 1;
  }

  const totalRestored = Object.values(restoredCounts).reduce((sum, n) => sum + n, 0);
  emitProgress('Restore complete!');

  await logActivity({
    actorUid: actor.uid,
    actorName: actor.fullName,
    actorEmail: actor.email,
    actorRole: actor.role,
    centreId: actor.centreId,
    department: actor.department,
    action: 'DATABASE_BACKUP_RESTORED',
    targetCollection: 'system_settings',
    targetId: 'global',
    details: `Restored ${totalRestored} records from backup JSON (students: ${restoredCounts.students || 0}, fees: ${restoredCounts.fee_recovery || 0}, skipped: ${skippedCount}, failed: ${failedCount}).`,
    locationVerified: true,
  }).catch(() => {});

  return { restoredCounts, skippedCount, failedCount, totalRestored };
}





