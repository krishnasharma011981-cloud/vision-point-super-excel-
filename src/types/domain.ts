export type UserRole = 'super_admin' | 'centre_head' | 'employee';

export type DepartmentId =
  | 'fee_recovery'
  | 'practical'
  | 'tma'
  | 'online_classes'
  | 'admission';

export type UserDepartment = 'all' | DepartmentId;

export type CentreId =
  | 'vp_lookerganj'
  | 'vp_civillines'
  | 'xis_varanasi'
  | 'xis_jaunpur';

export type AccountStatus = 'Active' | 'Inactive';

export type TcStatus = 'Received' | 'Not Received' | 'Not Applicable';
export type BookStatus = 'Received' | 'Not Received' | 'Pending';
export type ClassAttendanceStatus = 'Regular' | 'Irregular' | 'Not Attending';
export type TmaStatus = 'Submitted' | 'Not Submitted' | 'Pending';
export type PracticalStatus = 'Completed' | 'Not Completed' | 'Pending';
export type ExaminationStatus = 'Completed' | 'Not Completed' | 'Partially Completed';

export type RecoveryStatus = 'Paid' | 'Partial' | 'Pending' | 'Overdue';
export type FeeFollowUpStatus = 'Scheduled' | 'Contacted' | 'Promise to Pay' | 'Closed';
export type PracticalSubmissionStatus = 'Submitted' | 'Not Submitted' | 'Under Review';
export type ParticipationLevel = 'High' | 'Moderate' | 'Low' | 'Inactive';
export type AdmissionStatus = 'Confirmed' | 'Provisional' | 'Pending Verification' | 'Cancelled';
export type AdmissionFollowUpStatus = 'Completed' | 'Pending Follow-up' | 'Document Due';

export interface Centre {
  id: CentreId;
  name: string;
  city: string;
  code: string;
  address: string;
  latitude: number;
  longitude: number;
  geofenceRadiusMeters: number;
  headUid: string;
  headName: string;
  status: AccountStatus;
  createdAt: unknown;
  updatedAt: unknown;
  updatedBy: string;
}

export interface UserAccount {
  uid: string;
  fullName: string;
  email: string;
  mobileNumber: string;
  role: UserRole;
  centreId: CentreId;
  centreName: string;
  department: UserDepartment;
  status: AccountStatus;
  joiningDate: string;
  createdBy: string;
  createdAt: unknown;
  updatedBy: string;
  updatedAt: unknown;
}

export interface Student {
  serialNumber: number;
  studentId: string;
  studentName: string;
  mobileNumber: string;
  subject: string;
  tcStatus: TcStatus;
  bookStatus: BookStatus;
  classAttendanceStatus: ClassAttendanceStatus;
  whyNios: string;
  currentEducationStatus: string;
  futurePlanning: string;
  tmaStatus: TmaStatus;
  practicalStatus: PracticalStatus;
  examinationStatus: ExaminationStatus;
  centreId: CentreId;
  centreName: string;
  admissionDate: string;
  assignedEmployeeUid: string;
  assignedEmployeeName: string;
  additionalRemarks: string;
  employeeLocked?: boolean;
  tmaLocked?: boolean;
  practicalLocked?: boolean;
  onlineClassesLocked?: boolean;
  admissionLocked?: boolean;
  lockedByUid?: string;
  lockedByName?: string;
  superAdminAccessGranted?: boolean;
  tmaFee?: number;
  examFee?: number;
  extraColumns?: Record<string, string>;
  rowColor?: string;
  cellColors?: Record<string, string>;
  createdBy: string;
  createdAt: unknown;
  updatedBy: string;
  updatedAt: unknown;
}

export interface ExcelSheetConfig {
  configId: string;
  headerLabels: Record<string, string>;
  customColumns: string[];
  hiddenCoreColumns: string[];
  deletedExtraColumns: string[];
  updatedBy: string;
  updatedAt: unknown;
}

export interface FeeRecoveryRecord {
  studentId: string;
  studentName: string;
  mobileNumber: string;
  centreId: CentreId;
  recoveryStatus: RecoveryStatus;
  followUpStatus: FeeFollowUpStatus;
  totalFee: number;
  paidAmount: number;
  pendingAmount: number;
  tmaFee?: number;
  examFee?: number;
  assignedEmployeeUid: string;
  assignedEmployeeName: string;
  followUpNotes: string;
  lastContactDate: string;
  nextFollowUpDate: string;
  employeeLocked?: boolean;
  lockedByUid?: string;
  lockedByName?: string;
  createdBy: string;
  createdAt: unknown;
  updatedBy: string;
  updatedAt: unknown;
}

export interface PracticalRecord {
  studentId: string;
  studentName: string;
  centreId: CentreId;
  practicalStatus: PracticalStatus;
  submissionStatus: PracticalSubmissionStatus;
  completionPercentage: number;
  assignedEmployeeUid: string;
  assignedEmployeeName: string;
  remarks: string;
  employeeLocked?: boolean;
  lockedByUid?: string;
  lockedByName?: string;
  createdBy: string;
  createdAt: unknown;
  updatedBy: string;
  updatedAt: unknown;
}

export interface TmaRecord {
  studentId: string;
  studentName: string;
  centreId: CentreId;
  tmaStatus: TmaStatus;
  subjectsSubmittedCount: number;
  totalSubjectsCount: number;
  submissionDate: string;
  assignedEmployeeUid: string;
  assignedEmployeeName: string;
  remarks: string;
  employeeLocked?: boolean;
  lockedByUid?: string;
  lockedByName?: string;
  createdBy: string;
  createdAt: unknown;
  updatedBy: string;
  updatedAt: unknown;
}

export interface OnlineClassRecord {
  studentId: string;
  studentName: string;
  centreId: CentreId;
  attendanceStatus: ClassAttendanceStatus;
  participationLevel: ParticipationLevel;
  attendancePercentage: number;
  lastAttendanceUpdate: string;
  followUpNotes: string;
  assignedEmployeeUid: string;
  assignedEmployeeName: string;
  employeeLocked?: boolean;
  lockedByUid?: string;
  lockedByName?: string;
  createdBy: string;
  createdAt: unknown;
  updatedBy: string;
  updatedAt: unknown;
}

export interface AdmissionRecord {
  studentId: string;
  studentName: string;
  centreId: CentreId;
  admissionStatus: AdmissionStatus;
  stream: string;
  niosPurpose: string;
  academicBackground: string;
  followUpStatus: AdmissionFollowUpStatus;
  assignedEmployeeUid: string;
  assignedEmployeeName: string;
  remarks: string;
  admissionDate: string;
  employeeLocked?: boolean;
  lockedByUid?: string;
  lockedByName?: string;
  createdBy: string;
  createdAt: unknown;
  updatedBy: string;
  updatedAt: unknown;
}

export interface ActivityLog {
  id?: string;
  actorUid: string;
  actorName: string;
  actorEmail: string;
  actorRole: UserRole;
  centreId: string;
  department: string;
  action: string;
  targetCollection: string;
  targetId: string;
  details: string;
  locationVerified: boolean;
  createdAt: unknown;
}

export interface LocationVerification {
  id?: string;
  uid: string;
  userEmail: string;
  role: UserRole;
  centreId: CentreId;
  latitude: number;
  longitude: number;
  accuracyMeters: number;
  distanceMeters: number;
  radiusMeters: number;
  verified: boolean;
  overrideApplied: boolean;
  operation: string;
  nonce: string;
  createdAt: unknown;
}

export interface SystemSettings {
  superAdminEmail: string;
  superAdminUid: string;
  geofenceEnabled: boolean;
  emergencyOverrideActive: boolean;
  sessionTimeoutMinutes: number;
  maxGpsAccuracyMeters: number;
  updatedAt: unknown;
  updatedBy: string;
}

export interface NotificationItem {
  id?: string;
  recipientUid: string;
  centreId: string;
  title: string;
  message: string;
  type: 'info' | 'warning' | 'security';
  read: boolean;
  createdAt: unknown;
}

export interface StaffInvite {
  inviteId: string;
  fullName: string;
  email: string;
  mobileNumber: string;
  role: 'centre_head' | 'employee';
  centreId: CentreId;
  centreName: string;
  department: UserDepartment;
  joiningDate: string;
  status: 'Pending' | 'Claimed';
  claimedUid: string;
  invitedBy: string;
  invitedByName: string;
  createdAt: unknown;
  updatedAt: unknown;
}

export type EmployeeReportStatus = 'Submitted' | 'Reviewed' | 'Approved';

export interface EmployeeReport {
  reportId: string;
  employeeUid: string;
  employeeName: string;
  employeeEmail: string;
  role: UserRole;
  centreId: CentreId;
  centreName: string;
  department: UserDepartment;
  reportDate: string;
  title: string;
  summary: string;
  tasksCompleted: number;
  studentsHandled: number;
  pendingIssues: string;
  status: EmployeeReportStatus;
  reviewerName: string;
  reviewerNote: string;
  createdAt: unknown;
  updatedAt: unknown;
}

export type EditRequestStatus = 'Pending' | 'Approved' | 'Rejected';

export interface EditRequest {
  requestId: string;
  studentId: string;
  studentName: string;
  serialNumber: number;
  centreId: CentreId;
  department: DepartmentId;
  requesterUid: string;
  requesterName: string;
  requesterEmail: string;
  reason: string;
  status: EditRequestStatus;
  reviewedByUid: string;
  reviewedByName: string;
  reviewerNote: string;
  createdAt: unknown;
  updatedAt: unknown;
}

export type DirectMessageType = 'text' | 'walkie_log';

export interface DirectMessage {
  messageId: string;
  staffUid: string;
  staffName: string;
  staffEmail: string;
  staffRole: 'centre_head' | 'employee';
  centreId: CentreId;
  department: UserDepartment;
  senderUid: string;
  senderName: string;
  senderRole: UserRole;
  messageType: DirectMessageType;
  text: string;
  readByStaff: boolean;
  readByAdmin: boolean;
  createdAt: unknown;
}

export type WalkieTargetMode = 'staff' | 'centre' | 'all' | 'super_admin';

export interface OnlineUserPresence {
  uid: string;
  fullName: string;
  role: UserRole;
  centreId: CentreId;
  department: UserDepartment;
}

export interface IncomingWalkieState {
  sessionId: string;
  fromUid: string;
  fromName: string;
  fromRole: UserRole;
  fromCentreId: CentreId;
  fromDepartment: UserDepartment;
  targetMode: WalkieTargetMode;
  targetCentreId?: CentreId;
  startedAt: number;
}

export type WorkAssignmentDepartment = 'fee_recovery' | 'practical' | 'tma';

export type WorkAssignmentStatus = 'Active' | 'Completed' | 'Archived';

export type CallTaskStatus = 'Pending' | 'Follow-up Scheduled' | 'Called - Done' | 'Not Answered';

export interface WorkAssignment {
  assignmentId: string;
  centreId: CentreId;
  centreName: string;
  department: WorkAssignmentDepartment;
  staffUid: string;
  staffName: string;
  staffEmail: string;
  assignedByUid: string;
  assignedByName: string;
  assignedDate: string;
  fromSerial: number;
  toSerial: number;
  totalStudents: number;
  status: WorkAssignmentStatus;
  note: string;
  createdAt: unknown;
  updatedAt: unknown;
}

export interface WorkAssignmentTask {
  taskId: string;
  assignmentId: string;
  centreId: CentreId;
  department: WorkAssignmentDepartment;
  staffUid: string;
  staffName: string;
  studentId: string;
  serialNumber: number;
  studentName: string;
  fatherName: string;
  mobileNumber: string;
  callingNumber: string;
  subject: string;
  pendingFee: number;
  totalFee: number;
  callStatus: CallTaskStatus;
  followUpDate: string;
  followUpTime: string;
  remark: string;
  lastCalledAt: string;
  updatedBy: string;
  createdAt: unknown;
  updatedAt: unknown;
}

export type NavSection =
  | 'overview'
  | 'centre_management'
  | 'student_database'
  | 'fee_recovery'
  | 'practical'
  | 'tma'
  | 'online_classes'
  | 'admission'
  | 'employee_management'
  | 'reports'
  | 'settings'
  | 'activity_logs';
