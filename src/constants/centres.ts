import type { Centre, CentreId, DepartmentId, NavSection } from '../types/domain';

export const BOOTSTRAPPED_OWNER_EMAIL = 'niosvisionpoint9@gmail.com';
export const BOOTSTRAPPED_OWNER_EMAILS = [
  'niosvisionpoint9@gmail.com',
  'krishnasharma011981@gmail.com',
] as const;

export function isBootstrappedOwnerEmail(email?: string | null): boolean {
  if (!email) return false;
  return (BOOTSTRAPPED_OWNER_EMAILS as readonly string[]).includes(email.trim().toLowerCase());
}

export const CANONICAL_CENTRES: Array<Omit<Centre, 'createdAt' | 'updatedAt' | 'updatedBy'>> = [
  {
    id: 'vp_lookerganj',
    name: 'Vision Point Lookerganj, Prayagraj',
    city: 'Prayagraj',
    code: 'VP-LKG',
    address: 'Lookerganj Main Road, Prayagraj, Uttar Pradesh',
    latitude: 25.4358,
    longitude: 81.8256,
    geofenceRadiusMeters: 300,
    headUid: '',
    headName: 'Unassigned',
    status: 'Active',
  },
  {
    id: 'vp_civillines',
    name: 'Vision Point Civil Lines, Prayagraj',
    city: 'Prayagraj',
    code: 'VP-CLN',
    address: 'Mahatma Gandhi Marg, Civil Lines, Prayagraj, Uttar Pradesh',
    latitude: 25.4530,
    longitude: 81.8358,
    geofenceRadiusMeters: 300,
    headUid: '',
    headName: 'Unassigned',
    status: 'Active',
  },
  {
    id: 'xis_varanasi',
    name: 'Axis Academy, Varanasi',
    city: 'Varanasi',
    code: 'AXIS-VNS',
    address: 'Sigra Coaching Complex, Varanasi, Uttar Pradesh',
    latitude: 25.3176,
    longitude: 82.9739,
    geofenceRadiusMeters: 300,
    headUid: '',
    headName: 'Unassigned',
    status: 'Active',
  },
  {
    id: 'xis_jaunpur',
    name: 'Axis Academy, Jaunpur',
    city: 'Jaunpur',
    code: 'AXIS-JNP',
    address: 'Civil Lines Road, Jaunpur, Uttar Pradesh',
    latitude: 25.7464,
    longitude: 82.6837,
    geofenceRadiusMeters: 300,
    headUid: '',
    headName: 'Unassigned',
    status: 'Active',
  },
];

export const CENTRE_MAP: Record<CentreId, Omit<Centre, 'createdAt' | 'updatedAt' | 'updatedBy'>> = {
  vp_lookerganj: CANONICAL_CENTRES[0],
  vp_civillines: CANONICAL_CENTRES[1],
  xis_varanasi: CANONICAL_CENTRES[2],
  xis_jaunpur: CANONICAL_CENTRES[3],
};

export const DEPARTMENTS: Array<{
  id: DepartmentId;
  label: string;
  shortLabel: string;
  description: string;
}> = [
  {
    id: 'fee_recovery',
    label: 'Fee Recovery',
    shortLabel: 'Fee Recovery',
    description: 'Pending fee collection, follow-up schedules, and recovery tracking.',
  },
  {
    id: 'practical',
    label: 'Practical',
    shortLabel: 'Practical',
    description: 'Practical file submission, lab completion tracking, and assessment remarks.',
  },
  {
    id: 'tma',
    label: 'TMA',
    shortLabel: 'TMA',
    description: 'Tutor Marked Assignment submission progress and pending verification.',
  },
  {
    id: 'online_classes',
    label: 'Online Classes',
    shortLabel: 'Online Classes',
    description: 'Live session attendance, participation ratings, and irregular student follow-ups.',
  },
  {
    id: 'admission',
    label: 'Admission',
    shortLabel: 'Admission',
    description: 'New student registration, NIOS admission purpose, and document verification.',
  },
];

export const DEPARTMENT_LABELS: Record<string, string> = {
  all: 'All Departments',
  fee_recovery: 'Fee Recovery',
  practical: 'Practical',
  tma: 'TMA',
  online_classes: 'Online Classes',
  admission: 'Admission',
};

export const ROLE_LABELS: Record<string, string> = {
  super_admin: 'Super Admin',
  centre_head: 'Centre Head',
  employee: 'Department Employee',
};

export const SIDEBAR_ITEMS: Array<{
  id: NavSection;
  label: string;
  department?: DepartmentId;
}> = [
  { id: 'overview', label: 'Overview' },
  { id: 'communication', label: 'Sir Connect & Walkie' },
  { id: 'centre_management', label: 'Centre Management' },
  { id: 'student_database', label: 'Student Database' },
  { id: 'fee_recovery', label: 'Fee Recovery', department: 'fee_recovery' },
  { id: 'practical', label: 'Practical', department: 'practical' },
  { id: 'tma', label: 'TMA', department: 'tma' },
  { id: 'online_classes', label: 'Online Classes', department: 'online_classes' },
  { id: 'admission', label: 'Admission', department: 'admission' },
  { id: 'employee_management', label: 'Employee Management' },
  { id: 'reports', label: 'Reports' },
  { id: 'settings', label: 'Settings' },
  { id: 'activity_logs', label: 'Activity Logs' },
];
