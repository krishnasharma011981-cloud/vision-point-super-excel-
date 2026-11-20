import { onAuthStateChanged, signOut } from 'firebase/auth';
import {
  collection,
  doc,
  limit,
  onSnapshot,
  orderBy,
  query,
  where,
  type Unsubscribe,
} from 'firebase/firestore';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityLogsView } from './components/ActivityLogsView';
import { CentreManagementView } from './components/CentreManagementView';
import { canUserAccessSection, DashboardShell } from './components/DashboardShell';
import { AdmissionView } from './components/departments/AdmissionView';
import { FeeRecoveryView } from './components/departments/FeeRecoveryView';
import { OnlineClassesView } from './components/departments/OnlineClassesView';
import { PracticalView } from './components/departments/PracticalView';
import { TmaView } from './components/departments/TmaView';
import { EmployeeManagementView } from './components/EmployeeManagementView';
import { LoginScreen } from './components/LoginScreen';
import { OverviewDashboard } from './components/OverviewDashboard';
import { ReportsAnalyticsView } from './components/ReportsAnalyticsView';
import { SettingsView } from './components/SettingsView';
import { SirWelcomeOverlay } from './components/SirWelcomeOverlay';
import { StudentDatabaseView } from './components/StudentDatabaseView';
import { ToastContainer, type ToastMessage } from './components/Toast';
import { CENTRE_MAP, isBootstrappedOwnerEmail } from './constants/centres';
import { extractJaunpurHeadingAndBlankColumns } from './lib/csvUtils';
import {
  auth,
  db,
  formatFirestoreUserError,
  handleFirestoreError,
  isFirestoreQuotaError,
  OperationType,
} from './lib/firebase';
import {
  CACHE_TTL_MS,
  clearAllFirestoreCache,
  fetchCollectionCached,
  fetchDocumentCached,
  invalidateCacheForCollections,
  subscribeCacheInvalidation,
} from './lib/firestoreCache';
import { speakWelcomeMessage, stopWelcomeMessage } from './lib/voiceWelcome';
import {
  claimPendingStaffInvite,
  clearMockSubjectsFromStudents,
  ensureInitialPlatformSetup,
  getUserProfile,
  logActivity,
  mergeCustomColumnsIntoSharedConfig,
  resetAllFeeRecordsToZero,
  resetOnlineAttendanceToZeroBatch,
  saveExcelSheetConfig,
} from './services/firestoreService';
import type {
  ActivityLog,
  AdmissionRecord,
  Centre,
  CentreId,
  EditRequest,
  EmployeeReport,
  ExcelSheetConfig,
  FeeRecoveryRecord,
  LocationVerification,
  NavSection,
  NotificationItem,
  OnlineClassRecord,
  PracticalRecord,
  StaffInvite,
  Student,
  SystemSettings,
  TmaRecord,
  UserAccount,
  WorkAssignment,
  WorkAssignmentDepartment,
  WorkAssignmentTask,
} from './types/domain';

const toMillis = (val: unknown): number => {
  if (!val) return 0;
  if (typeof val === 'number') return val;
  if (typeof val === 'string') return Date.parse(val) || 0;
  if (typeof val === 'object' && val !== null && 'toMillis' in val && typeof (val as { toMillis: () => number }).toMillis === 'function') {
    return (val as { toMillis: () => number }).toMillis();
  }
  return 0;
};

export default function App() {
  const [authChecking, setAuthChecking] = useState(true);
  const [currentUser, setCurrentUser] = useState<UserAccount | null>(null);
  const [loginError, setLoginError] = useState<string | null>(null);

  const [activeSection, setActiveSection] = useState<NavSection>('overview');
  const [selectedCentreFilter, setSelectedCentreFilter] = useState<CentreId | 'all'>('all');
  const [globalSearch, setGlobalSearch] = useState('');
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [showSirWelcome, setShowSirWelcome] = useState(false);
  const [sirSpeaking, setSirSpeaking] = useState(false);
  const [sirAudioCompleted, setSirAudioCompleted] = useState(false);
  const [sirAutoplayBlocked, setSirAutoplayBlocked] = useState(false);
  const [sirProgress, setSirProgress] = useState(0);
  const manualAuthInFlightRef = useRef(false);
  const sirAutoCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Live Firestore State
  const [dataLoading, setDataLoading] = useState(true);
  const [centres, setCentres] = useState<Centre[]>([]);
  const [users, setUsers] = useState<UserAccount[]>([]);
  const [students, setStudents] = useState<Student[]>([]);
  const [feeRecords, setFeeRecords] = useState<FeeRecoveryRecord[]>([]);
  const [practicalRecords, setPracticalRecords] = useState<PracticalRecord[]>([]);
  const [tmaRecords, setTmaRecords] = useState<TmaRecord[]>([]);
  const [onlineClassRecords, setOnlineClassRecords] = useState<OnlineClassRecord[]>([]);
  const [admissionRecords, setAdmissionRecords] = useState<AdmissionRecord[]>([]);
  const [activityLogs, setActivityLogs] = useState<ActivityLog[]>([]);
  const [locationVerifications, setLocationVerifications] = useState<LocationVerification[]>([]);
  const [systemSettings, setSystemSettings] = useState<SystemSettings | null>(null);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [staffInvites, setStaffInvites] = useState<StaffInvite[]>([]);
  const [employeeReports, setEmployeeReports] = useState<EmployeeReport[]>([]);
  const [editRequests, setEditRequests] = useState<EditRequest[]>([]);
  const [sheetConfigs, setSheetConfigs] = useState<ExcelSheetConfig[]>([]);
  const [workAssignments, setWorkAssignments] = useState<WorkAssignment[]>([]);
  const [workAssignmentTasks, setWorkAssignmentTasks] = useState<WorkAssignmentTask[]>([]);
  const [sheetConfigsLoaded, setSheetConfigsLoaded] = useState(false);
  const [onlineClassRecordsLoaded, setOnlineClassRecordsLoaded] = useState(false);
  const [feeRecordsLoaded, setFeeRecordsLoaded] = useState(false);
  const [manualSyncing, setManualSyncing] = useState(false);
  const [cacheVersion, setCacheVersion] = useState(0);
  const attendanceZeroMigrationRanRef = useRef(false);
  const jaunpurColsSharedMigrationRef = useRef(false);
  const fee12kCleanupMigrationRanRef = useRef(false);
  const subjectMockCleanupRanRef = useRef(false);
  const quotaToastShownRef = useRef(false);
  const lastInvalidatedCollectionsRef = useRef<Set<string> | null>(null);

  const notify = useCallback(
    (title: string, description: string, variant: ToastMessage['variant'] = 'info') => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      setToasts((prev) => [...prev, { id, title, description, variant }]);
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, 6000);
    },
    [],
  );

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const triggerSirWelcome = useCallback((userProfile?: UserAccount | null) => {
    if (sirAutoCloseTimerRef.current) {
      clearTimeout(sirAutoCloseTimerRef.current);
      sirAutoCloseTimerRef.current = null;
    }
    setShowSirWelcome(true);
    setSirSpeaking(true);
    setSirAudioCompleted(false);
    setSirAutoplayBlocked(false);
    setSirProgress(0);

    speakWelcomeMessage(
      true,
      {
        onProgress: (pct) => setSirProgress(pct),
        onAutoplayBlocked: () => {
          setSirSpeaking(false);
          setSirAutoplayBlocked(true);
        },
        onEnded: () => {
          setSirSpeaking(false);
          setSirAutoplayBlocked(false);
          setSirProgress(100);
          setSirAudioCompleted(true);
          sirAutoCloseTimerRef.current = setTimeout(() => {
            setShowSirWelcome(false);
          }, 900);
        },
      },
      userProfile,
    );
  }, []);

  const dismissSirWelcome = useCallback(() => {
    if (sirAutoCloseTimerRef.current) {
      clearTimeout(sirAutoCloseTimerRef.current);
      sirAutoCloseTimerRef.current = null;
    }
    stopWelcomeMessage();
    setSirSpeaking(false);
    setSirAudioCompleted(false);
    setSirAutoplayBlocked(false);
    setSirProgress(0);
    setShowSirWelcome(false);
  }, []);

  const handleLogout = useCallback(async () => {
    dismissSirWelcome();
    if (currentUser) {
      await logActivity({
        actorUid: currentUser.uid,
        actorName: currentUser.fullName,
        actorEmail: currentUser.email,
        actorRole: currentUser.role,
        centreId: currentUser.centreId,
        department: currentUser.department,
        action: 'LOGOUT',
        targetCollection: 'users',
        targetId: currentUser.uid,
        details: 'User signed out cleanly.',
        locationVerified: true,
      }).catch(() => {});
    }
    await signOut(auth);
    clearAllFirestoreCache();
    setCurrentUser(null);
    setActiveSection('overview');
    setSelectedCentreFilter('all');
    setGlobalSearch('');
  }, [currentUser, dismissSirWelcome]);

  // Restore active verified session on boot (respects active LoginScreen sign-in flow)
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (fbUser) => {
      if (manualAuthInFlightRef.current) {
        return;
      }

      if (!fbUser) {
        setCurrentUser(null);
        setAuthChecking(false);
        return;
      }

      try {
        let profile = await getUserProfile(fbUser.uid);
        if (
          fbUser.email &&
          isBootstrappedOwnerEmail(fbUser.email) &&
          (!profile ||
            profile.role !== 'super_admin' ||
            profile.department !== 'all' ||
            profile.status !== 'Active')
        ) {
          profile = await ensureInitialPlatformSetup({
            uid: fbUser.uid,
            email: fbUser.email,
            fullName: fbUser.displayName || profile?.fullName || 'Super Admin',
          });
        }
        if (!profile && fbUser.email) {
          profile = await claimPendingStaffInvite({
            uid: fbUser.uid,
            email: fbUser.email,
            displayName: fbUser.displayName,
          });
        }

        if (profile && profile.status === 'Active') {
          setCurrentUser(profile);
          let resolvedCentre: CentreId | 'all' = profile.centreId;
          if (profile.role === 'super_admin') {
            try {
              const saved = localStorage.getItem(`ds_super_admin_centre_${profile.uid}`);
              if (saved === 'all' || (saved && saved in CENTRE_MAP)) {
                resolvedCentre = saved as CentreId | 'all';
              } else {
                resolvedCentre = 'vp_lookerganj';
              }
            } catch {
              resolvedCentre = 'vp_lookerganj';
            }
          }
          setSelectedCentreFilter(resolvedCentre);
          setActiveSection(profile.role === 'employee' ? (profile.department as NavSection) : 'overview');
        } else if (profile && profile.status !== 'Active') {
          await signOut(auth);
          setLoginError('This account has been deactivated by an administrator.');
          setCurrentUser(null);
        }
      } catch (err) {
        if (isFirestoreQuotaError(err)) {
          setLoginError(formatFirestoreUserError(err));
        } else {
          console.error('Auth restoration error:', err);
        }
      } finally {
        setAuthChecking(false);
      }
    });

    return () => unsub();
  }, []);

  // Hash-based URL tampering guard for department isolation
  useEffect(() => {
    const onHashChange = () => {
      if (!currentUser) return;
      const hashSection = window.location.hash.replace('#', '') as NavSection;
      if (!hashSection) return;
      if (!canUserAccessSection(currentUser, hashSection)) {
        window.location.hash = `#${activeSection}`;
        notify(
          'Access Denied',
          `Department isolation: You are not authorized to access "${hashSection}".`,
          'error',
        );
        logActivity({
          actorUid: currentUser.uid,
          actorName: currentUser.fullName,
          actorEmail: currentUser.email,
          actorRole: currentUser.role,
          centreId: currentUser.centreId,
          department: currentUser.department,
          action: 'UNAUTHORIZED_SECTION_ATTEMPT',
          targetCollection: 'navigation',
          targetId: hashSection,
          details: `Blocked URL navigation attempt to ${hashSection}.`,
          locationVerified: false,
        }).catch(() => {});
      }
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, [currentUser, activeSection, notify]);

  // Session inactivity timeout enforcement
  useEffect(() => {
    if (!currentUser) return;
    const timeoutMs = (systemSettings?.sessionTimeoutMinutes || 60) * 60_000;
    let timer = setTimeout(() => {
      notify('Session Expired', 'You have been signed out due to inactivity.', 'warning');
      handleLogout();
    }, timeoutMs);

    const resetTimer = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        notify('Session Expired', 'You have been signed out due to inactivity.', 'warning');
        handleLogout();
      }, timeoutMs);
    };

    window.addEventListener('mousemove', resetTimer);
    window.addEventListener('keydown', resetTimer);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('mousemove', resetTimer);
      window.removeEventListener('keydown', resetTimer);
    };
  }, [currentUser, systemSettings?.sessionTimeoutMinutes, handleLogout, notify]);

  const handleDataFetchError = useCallback(
    (err: unknown, op: OperationType, path: string) => {
      if (isFirestoreQuotaError(err)) {
        if (!quotaToastShownRef.current) {
          quotaToastShownRef.current = true;
          notify(
            'Firebase Daily Read Quota Reached',
            formatFirestoreUserError(err),
            'warning',
          );
        }
        return;
      }
      handleFirestoreError(err, op, path);
    },
    [notify],
  );

  const activeAssignedDepartments: WorkAssignmentDepartment[] = currentUser
    ? Array.from(
        new Set(
          workAssignments
            .filter((a) => a.staffUid === currentUser.uid && a.status === 'Active')
            .map((a) => a.department),
        ),
      )
    : [];

  const resolvedActiveSection: NavSection = currentUser
    ? canUserAccessSection(currentUser, activeSection, activeAssignedDepartments)
      ? activeSection
      : 'overview'
    : 'overview';

  const userUid = currentUser?.uid || '';
  const userRole = currentUser?.role || null;
  const userCentreId = currentUser?.centreId || null;
  const userDepartment = currentUser?.department || null;
  const userEmail = currentUser?.email || '';

  // Subscribe to write-through invalidation events from firestoreService so local edits
  // immediately refresh ONLY the mutated collection(s) while keeping all other tabs cached (0 reads).
  useEffect(() => {
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const pending = new Set<string>();
    const unsub = subscribeCacheInvalidation((mutatedCols) => {
      mutatedCols.forEach((c) => pending.add(c));
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        lastInvalidatedCollectionsRef.current = new Set(pending);
        pending.clear();
        setCacheVersion((v) => v + 1);
      }, 160);
    });
    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      unsub();
    };
  }, []);

  // 1. Core lightweight cached bootstrap (static configs = 6h TTL, operational = 10m TTL)
  // Plus ONLY 2 tiny live onSnapshot listeners for Employees (~25 calling tasks total)
  useEffect(() => {
    if (!userUid || !userRole || !userCentreId) {
      setSheetConfigsLoaded(false);
      setOnlineClassRecordsLoaded(false);
      setFeeRecordsLoaded(false);
      attendanceZeroMigrationRanRef.current = false;
      jaunpurColsSharedMigrationRef.current = false;
      fee12kCleanupMigrationRanRef.current = false;
      subjectMockCleanupRanRef.current = false;
      quotaToastShownRef.current = false;
      return;
    }

    let cancelled = false;
    const unsubs: Unsubscribe[] = [];
    const isSuper = userRole === 'super_admin';
    const isHead = userRole === 'centre_head';
    const cId = userCentreId;

    const loadCore = async () => {
      const jobs: Array<Promise<void>> = [];

      // Centres (max 4 docs — 24h cache + delta sync)
      jobs.push(
        fetchCollectionCached<Centre>(
          'centres',
          isSuper ? 'all' : cId,
          isSuper ? query(collection(db, 'centres')) : query(collection(db, 'centres'), where('id', '==', cId)),
          CACHE_TTL_MS.STATIC,
          { deltaSyncField: 'updatedAt' },
        )
          .then((items) => {
            if (!cancelled) setCentres(items);
          })
          .catch((err) => handleDataFetchError(err, OperationType.LIST, 'centres')),
      );

      // Self status verification (cached 4h so page reloads cost 0 reads)
      jobs.push(
        fetchDocumentCached<UserAccount>(
          'users',
          `profile:${userUid}`,
          doc(db, 'users', userUid),
          CACHE_TTL_MS.PROFILE,
        )
          .then((latest) => {
            if (cancelled) return;
            if ((!latest || latest.status !== 'Active') && !isBootstrappedOwnerEmail(userEmail)) {
              void signOut(auth).catch(() => {});
              clearAllFirestoreCache();
              setCurrentUser(null);
              setLoginError('Access denied: Your staff account has been removed or deactivated by an administrator.');
            }
          })
          .catch(() => {
            // Ignore transient revocation check error
          }),
      );

      // Staff directory (Super Admin / Centre Head — 24h cache + delta sync)
      if (isSuper || isHead) {
        jobs.push(
          fetchCollectionCached<UserAccount>(
            'users',
            isSuper ? 'all' : cId,
            isSuper ? query(collection(db, 'users')) : query(collection(db, 'users'), where('centreId', '==', cId)),
            CACHE_TTL_MS.STATIC,
            { deltaSyncField: 'updatedAt' },
          )
            .then((items) => {
              if (!cancelled) setUsers(items);
            })
            .catch((err) => handleDataFetchError(err, OperationType.LIST, 'users')),
        );
      } else if (currentUser) {
        setUsers([currentUser]);
      }

      // System Settings (1 doc — 6h cache)
      jobs.push(
        fetchDocumentCached<SystemSettings>(
          'system_settings',
          'global',
          doc(db, 'system_settings', 'global'),
          CACHE_TTL_MS.STATIC,
        )
          .then((settings) => {
            if (!cancelled && settings) setSystemSettings(settings);
          })
          .catch((err) => handleDataFetchError(err, OperationType.GET, 'system_settings/global')),
      );

      // Notifications (capped 15 docs — 10m cache)
      const notifQuery = isSuper
        ? query(collection(db, 'notifications'), orderBy('createdAt', 'desc'), limit(15))
        : isHead
          ? query(collection(db, 'notifications'), where('centreId', '==', cId), limit(15))
          : query(collection(db, 'notifications'), where('recipientUid', '==', userUid), limit(12));
      jobs.push(
        fetchCollectionCached<NotificationItem>(
          'notifications',
          isSuper ? 'all' : isHead ? cId : userUid,
          notifQuery,
          CACHE_TTL_MS.OPERATIONAL,
          { includeDocId: true },
        )
          .then((items) => {
            if (!cancelled) {
              setNotifications([...items].sort((a, b) => toMillis(b.createdAt) - toMillis(a.createdAt)));
            }
          })
          .catch((err) => handleDataFetchError(err, OperationType.LIST, 'notifications')),
      );

      // Shared Excel Sheet Column & Heading Configs (~6 docs — 24h cache + delta sync)
      jobs.push(
        fetchCollectionCached<ExcelSheetConfig>(
          'excel_sheet_configs',
          'all',
          query(collection(db, 'excel_sheet_configs')),
          CACHE_TTL_MS.STATIC,
          { deltaSyncField: 'updatedAt' },
        )
          .then((items) => {
            if (!cancelled) {
              setSheetConfigs(items);
              setSheetConfigsLoaded(true);
            }
          })
          .catch((err) => {
            if (!cancelled) setSheetConfigsLoaded(true);
            handleDataFetchError(err, OperationType.LIST, 'excel_sheet_configs');
          }),
      );

      // Work Assignments:
      // - For Admins/Centre Heads: cache-first (30m TTL + delta sync)
      if (isSuper || isHead) {
        const waQuery = isSuper
          ? query(collection(db, 'work_assignments'))
          : query(collection(db, 'work_assignments'), where('centreId', '==', cId));
        jobs.push(
          fetchCollectionCached<WorkAssignment>(
            'work_assignments',
            isSuper ? 'all' : cId,
            waQuery,
            CACHE_TTL_MS.OPERATIONAL,
            { deltaSyncField: 'updatedAt' },
          )
            .then((items) => {
              if (!cancelled) {
                setWorkAssignments([...items].sort((a, b) => toMillis(b.createdAt) - toMillis(a.createdAt)));
              }
            })
            .catch((err) => handleDataFetchError(err, OperationType.LIST, 'work_assignments')),
        );
      }

      await Promise.all(jobs);
    };

    void loadCore();

    return () => {
      cancelled = true;
      unsubs.forEach((u) => u());
    };
  }, [userUid, userRole, userCentreId, userEmail, cacheVersion, handleDataFetchError]);

  // Dedicated Employee Calling Box Listener — attaches ONCE per login (NEVER re-subscribes on cacheVersion bumps!)
  useEffect(() => {
    if (!userUid || !userRole || userRole === 'super_admin' || userRole === 'centre_head') {
      return;
    }
    const unsubWa = onSnapshot(
      query(collection(db, 'work_assignments'), where('staffUid', '==', userUid)),
      (snap) => {
        const sorted = snap.docs
          .map((d) => d.data() as WorkAssignment)
          .sort((a, b) => toMillis(b.createdAt) - toMillis(a.createdAt));
        setWorkAssignments(sorted);
      },
      (err) => handleDataFetchError(err, OperationType.LIST, 'work_assignments'),
    );
    const unsubTasks = onSnapshot(
      query(collection(db, 'work_assignment_tasks'), where('staffUid', '==', userUid)),
      (snap) => {
        setWorkAssignmentTasks(snap.docs.map((d) => d.data() as WorkAssignmentTask));
      },
      (err) => handleDataFetchError(err, OperationType.LIST, 'work_assignment_tasks'),
    );
    return () => {
      unsubWa();
      unsubTasks();
    };
  }, [userUid, userRole, handleDataFetchError]);

  // 2. Ultra-Low-Read Section-Aware & Branch-Scoped Cache-First Loader:
  // - Zero bulk onSnapshot listeners! Tab switches = 0 reads (in-memory cache), F5 refresh = 0 reads (IndexedDB cache).
  // - Overview loads ONLY students + fee_recovery for the active branch (skips Practical/TMA/Online/Admission/Logs).
  // - Employees inside their Calling Box skip loading branch-wide students/fees entirely.
  const isEmployeeInCallingBox =
    userRole === 'employee' &&
    (resolvedActiveSection === 'fee_recovery' ||
      resolvedActiveSection === 'practical' ||
      resolvedActiveSection === 'tma') &&
    activeAssignedDepartments.includes(resolvedActiveSection as WorkAssignmentDepartment);

  useEffect(() => {
    if (!userUid || !userRole || !userCentreId || !userDepartment) return;

    let cancelled = false;
    const isSuper = userRole === 'super_admin';
    const isHead = userRole === 'centre_head';
    const needsAllCentres =
      isSuper &&
      (selectedCentreFilter === 'all' ||
        resolvedActiveSection === 'centre_management' ||
        resolvedActiveSection === 'settings');
    const scopedCentre: CentreId | 'all' = isSuper
      ? needsAllCentres
        ? 'all'
        : selectedCentreFilter
      : userCentreId;

    const scopedQuery = (colName: string) =>
      scopedCentre === 'all'
        ? query(collection(db, colName))
        : query(collection(db, colName), where('centreId', '==', scopedCentre));

    const sectionNeedsStudents =
      !isEmployeeInCallingBox &&
      resolvedActiveSection !== 'employee_management' &&
      resolvedActiveSection !== 'activity_logs';

    const sectionNeedsFee =
      !isEmployeeInCallingBox &&
      (resolvedActiveSection === 'overview' ||
        resolvedActiveSection === 'centre_management' ||
        resolvedActiveSection === 'student_database' ||
        resolvedActiveSection === 'fee_recovery' ||
        resolvedActiveSection === 'reports' ||
        resolvedActiveSection === 'settings');

    // Practical, TMA, Online Classes, Admission are NOT fetched on Overview — only when actually opened!
    const sectionNeedsPractical =
      !isEmployeeInCallingBox &&
      (resolvedActiveSection === 'centre_management' ||
        resolvedActiveSection === 'practical' ||
        resolvedActiveSection === 'reports' ||
        resolvedActiveSection === 'settings');

    const sectionNeedsTma =
      !isEmployeeInCallingBox &&
      (resolvedActiveSection === 'centre_management' ||
        resolvedActiveSection === 'tma' ||
        resolvedActiveSection === 'reports' ||
        resolvedActiveSection === 'settings');

    const sectionNeedsOnline =
      resolvedActiveSection === 'centre_management' ||
      resolvedActiveSection === 'online_classes' ||
      resolvedActiveSection === 'reports' ||
      resolvedActiveSection === 'settings';

    const sectionNeedsAdmission =
      resolvedActiveSection === 'centre_management' ||
      resolvedActiveSection === 'admission' ||
      resolvedActiveSection === 'reports' ||
      resolvedActiveSection === 'settings';

    const sectionNeedsAdminTasks =
      (isSuper || isHead) &&
      (resolvedActiveSection === 'fee_recovery' ||
        resolvedActiveSection === 'practical' ||
        resolvedActiveSection === 'tma' ||
        resolvedActiveSection === 'settings');

    const sectionNeedsActivityLogs =
      isSuper &&
      (resolvedActiveSection === 'centre_management' ||
        resolvedActiveSection === 'activity_logs');

    const sectionNeedsGeoLogs = isSuper && resolvedActiveSection === 'activity_logs';
    const sectionNeedsInvites =
      (isSuper || isHead) &&
      (resolvedActiveSection === 'employee_management' || (isSuper && resolvedActiveSection === 'settings'));
    const sectionNeedsReports =
      resolvedActiveSection === 'reports' || (isSuper && resolvedActiveSection === 'settings');
    const sectionNeedsEditRequests =
      resolvedActiveSection === 'student_database' ||
      resolvedActiveSection === 'fee_recovery' ||
      resolvedActiveSection === 'practical' ||
      resolvedActiveSection === 'tma' ||
      resolvedActiveSection === 'online_classes' ||
      resolvedActiveSection === 'admission' ||
      resolvedActiveSection === 'employee_management' ||
      (isSuper && resolvedActiveSection === 'settings');

    const loadSectionData = async () => {
      const jobs: Array<Promise<void>> = [];

      // 1. Students (12h indexed cache + Incremental Delta Sync — 0 reads on repeat visits & local edits!)
      if (sectionNeedsStudents) {
        if (students.length === 0) setDataLoading(true);
        jobs.push(
          fetchCollectionCached<Student>(
            'students',
            scopedCentre,
            scopedQuery('students'),
            CACHE_TTL_MS.BULK_DATA,
            { deltaSyncField: 'updatedAt' },
          )
            .then((items) => {
              if (!cancelled) {
                setStudents([...items].sort((a, b) => (b.serialNumber || 0) - (a.serialNumber || 0)));
                setDataLoading(false);
              }
            })
            .catch((err) => {
              if (!cancelled) setDataLoading(false);
              handleDataFetchError(err, OperationType.LIST, 'students');
            }),
        );
      } else {
        setDataLoading(false);
      }

      // 2. Department collections (12h indexed cache + Incremental Delta Sync, strictly on-demand)
      const loadDeptIfNeeded = <T,>(
        needed: boolean,
        colName: string,
        deptKey: string,
        setter: (items: T[]) => void,
        onFirstLoad?: () => void,
      ) => {
        if (!needed) return;
        if (!isSuper && !isHead && userDepartment !== deptKey) {
          setter([]);
          onFirstLoad?.();
          return;
        }
        jobs.push(
          fetchCollectionCached<T>(
            colName,
            scopedCentre,
            scopedQuery(colName),
            CACHE_TTL_MS.BULK_DATA,
            { deltaSyncField: 'updatedAt' },
          )
            .then((items) => {
              if (!cancelled) {
                setter(items);
                onFirstLoad?.();
              }
            })
            .catch((err) => {
              if (!cancelled) onFirstLoad?.();
              handleDataFetchError(err, OperationType.LIST, colName);
            }),
        );
      };

      loadDeptIfNeeded<FeeRecoveryRecord>(
        sectionNeedsFee,
        'fee_recovery',
        'fee_recovery',
        setFeeRecords,
        () => setFeeRecordsLoaded(true),
      );
      loadDeptIfNeeded<PracticalRecord>(
        sectionNeedsPractical,
        'practical_records',
        'practical',
        setPracticalRecords,
      );
      loadDeptIfNeeded<TmaRecord>(
        sectionNeedsTma,
        'tma_records',
        'tma',
        setTmaRecords,
      );
      loadDeptIfNeeded<OnlineClassRecord>(
        sectionNeedsOnline,
        'online_class_records',
        'online_classes',
        setOnlineClassRecords,
        () => setOnlineClassRecordsLoaded(true),
      );
      loadDeptIfNeeded<AdmissionRecord>(
        sectionNeedsAdmission,
        'admission_records',
        'admission',
        setAdmissionRecords,
      );

      // 3. Admin/Centre Head Calling Tasks (30m indexed cache + delta sync, branch-scoped)
      if (sectionNeedsAdminTasks) {
        jobs.push(
          fetchCollectionCached<WorkAssignmentTask>(
            'work_assignment_tasks',
            scopedCentre,
            scopedQuery('work_assignment_tasks'),
            CACHE_TTL_MS.OPERATIONAL,
            { deltaSyncField: 'updatedAt' },
          )
            .then((items) => {
              if (!cancelled) setWorkAssignmentTasks(items);
            })
            .catch((err) => handleDataFetchError(err, OperationType.LIST, 'work_assignment_tasks')),
        );
      }

      // 4. Activity Logs (only on Activity Logs / Centre Management, capped to 50)
      if (sectionNeedsActivityLogs) {
        const logCap = resolvedActiveSection === 'activity_logs' ? 60 : 20;
        jobs.push(
          fetchCollectionCached<ActivityLog>(
            'activity_logs',
            `cap_${logCap}`,
            query(collection(db, 'activity_logs'), orderBy('createdAt', 'desc'), limit(logCap)),
            CACHE_TTL_MS.OPERATIONAL,
            { includeDocId: true },
          )
            .then((items) => {
              if (!cancelled) {
                setActivityLogs([...items].sort((a, b) => toMillis(b.createdAt) - toMillis(a.createdAt)));
              }
            })
            .catch((err) => handleDataFetchError(err, OperationType.LIST, 'activity_logs')),
        );
      }

      // 5. Location Verifications (only on Activity Logs tab, capped to 40)
      if (sectionNeedsGeoLogs) {
        jobs.push(
          fetchCollectionCached<LocationVerification>(
            'location_verifications',
            'cap_40',
            query(collection(db, 'location_verifications'), orderBy('createdAt', 'desc'), limit(40)),
            CACHE_TTL_MS.OPERATIONAL,
            { includeDocId: true },
          )
            .then((items) => {
              if (!cancelled) {
                setLocationVerifications([...items].sort((a, b) => toMillis(b.createdAt) - toMillis(a.createdAt)));
              }
            })
            .catch((err) => handleDataFetchError(err, OperationType.LIST, 'location_verifications')),
        );
      }

      // 6. Staff Invites (only on Employee Management tab)
      if (sectionNeedsInvites) {
        const invitesQuery = isSuper
          ? query(collection(db, 'staff_invites'))
          : query(collection(db, 'staff_invites'), where('centreId', '==', userCentreId));
        jobs.push(
          fetchCollectionCached<StaffInvite>(
            'staff_invites',
            isSuper ? 'all' : userCentreId,
            invitesQuery,
            CACHE_TTL_MS.OPERATIONAL,
          )
            .then((items) => {
              if (!cancelled) setStaffInvites(items);
            })
            .catch((err) => handleDataFetchError(err, OperationType.LIST, 'staff_invites')),
        );
      }

      // 7. Employee Daily Work Reports (only on Reports tab)
      if (sectionNeedsReports) {
        const reportsQuery = isSuper
          ? query(collection(db, 'employee_reports'), orderBy('createdAt', 'desc'), limit(60))
          : isHead
            ? query(collection(db, 'employee_reports'), where('centreId', '==', userCentreId), limit(50))
            : query(collection(db, 'employee_reports'), where('employeeUid', '==', userUid), limit(30));
        jobs.push(
          fetchCollectionCached<EmployeeReport>(
            'employee_reports',
            isSuper ? 'all' : isHead ? userCentreId : userUid,
            reportsQuery,
            CACHE_TTL_MS.OPERATIONAL,
          )
            .then((items) => {
              if (!cancelled) {
                setEmployeeReports([...items].sort((a, b) => toMillis(b.createdAt) - toMillis(a.createdAt)));
              }
            })
            .catch((err) => handleDataFetchError(err, OperationType.LIST, 'employee_reports')),
        );
      }

      // 8. Edit Requests (only on department / database / employee tabs, capped to 30)
      if (sectionNeedsEditRequests) {
        const editReqQuery = isSuper
          ? query(collection(db, 'edit_requests'), orderBy('createdAt', 'desc'), limit(30))
          : isHead
            ? query(collection(db, 'edit_requests'), where('centreId', '==', userCentreId), limit(30))
            : query(collection(db, 'edit_requests'), where('requesterUid', '==', userUid), limit(20));
        jobs.push(
          fetchCollectionCached<EditRequest>(
            'edit_requests',
            isSuper ? 'all' : isHead ? userCentreId : userUid,
            editReqQuery,
            CACHE_TTL_MS.OPERATIONAL,
          )
            .then((items) => {
              if (!cancelled) {
                setEditRequests([...items].sort((a, b) => toMillis(b.createdAt) - toMillis(a.createdAt)));
              }
            })
            .catch((err) => handleDataFetchError(err, OperationType.LIST, 'edit_requests')),
        );
      }

      await Promise.all(jobs);
      if (!cancelled) {
        setManualSyncing(false);
      }
    };

    void loadSectionData();

    return () => {
      cancelled = true;
    };
  }, [
    userUid,
    userRole,
    userCentreId,
    userDepartment,
    selectedCentreFilter,
    resolvedActiveSection,
    isEmployeeInCallingBox,
    cacheVersion,
    handleDataFetchError,
  ]);

  // Manual 1-click Sync: refreshes ONLY the active tab's collections fresh from Firestore
  const handleManualSync = useCallback(() => {
    setManualSyncing(true);
    const colsToRefresh: string[] = ['notifications'];
    switch (resolvedActiveSection) {
      case 'overview':
        colsToRefresh.push('students', 'fee_recovery');
        break;
      case 'student_database':
        colsToRefresh.push('students', 'fee_recovery', 'excel_sheet_configs', 'edit_requests');
        break;
      case 'fee_recovery':
        colsToRefresh.push('students', 'fee_recovery', 'work_assignments', 'work_assignment_tasks', 'edit_requests');
        break;
      case 'practical':
        colsToRefresh.push('students', 'practical_records', 'work_assignments', 'work_assignment_tasks', 'edit_requests');
        break;
      case 'tma':
        colsToRefresh.push('students', 'tma_records', 'work_assignments', 'work_assignment_tasks', 'edit_requests');
        break;
      case 'online_classes':
        colsToRefresh.push('students', 'online_class_records', 'edit_requests');
        break;
      case 'admission':
        colsToRefresh.push('students', 'admission_records', 'edit_requests');
        break;
      case 'employee_management':
        colsToRefresh.push('users', 'staff_invites', 'edit_requests');
        break;
      case 'reports':
        colsToRefresh.push('students', 'fee_recovery', 'practical_records', 'tma_records', 'online_class_records', 'admission_records', 'employee_reports');
        break;
      case 'centre_management':
        colsToRefresh.push('centres', 'users', 'students', 'fee_recovery', 'activity_logs');
        break;
      case 'activity_logs':
        colsToRefresh.push('activity_logs', 'location_verifications');
        break;
      case 'settings':
        colsToRefresh.push('system_settings', 'centres', 'excel_sheet_configs', 'users', 'staff_invites', 'employee_reports');
        break;
      default:
        colsToRefresh.push('students');
    }
    // Use Incremental Delta Sync on manual Sync so only newly modified docs are fetched from Firestore!
    invalidateCacheForCollections(colsToRefresh, { preserveDeltaBaseline: true });
    setCacheVersion((v) => v + 1);
  }, [resolvedActiveSection]);

  // One-time baseline reset: sets existing Online Attendance (100% default from earlier imports) to 0%
  // while leaving any future attendance updates completely untouched.
  useEffect(() => {
    if (
      !currentUser ||
      currentUser.role !== 'super_admin' ||
      dataLoading ||
      !sheetConfigsLoaded ||
      !onlineClassRecordsLoaded ||
      attendanceZeroMigrationRanRef.current
    ) {
      return;
    }

    const alreadyBaselineZeroed = sheetConfigs.some((c) => c.configId === 'online_attendance_zero_v1');
    if (alreadyBaselineZeroed) {
      attendanceZeroMigrationRanRef.current = true;
      return;
    }

    attendanceZeroMigrationRanRef.current = true;
    (async () => {
      try {
        const res = await resetOnlineAttendanceToZeroBatch(
          students,
          onlineClassRecords,
          currentUser,
          'Initial baseline: Online Attendance set to 0% until updated',
        );
        await saveExcelSheetConfig(
          'online_attendance_zero_v1',
          {
            headerLabels: {},
            customColumns: [],
            hiddenCoreColumns: [],
            deletedExtraColumns: [],
          },
          currentUser,
          'Recorded Online Attendance 0% baseline marker',
        );
        if (res.studentsUpdated > 0 || res.recordsUpdated > 0) {
          notify(
            'Online Attendance Set to 0%',
            `Updated ${res.studentsUpdated} student rows to Not Attending (0%). You can update attendance anytime later.`,
            'info',
          );
        }
      } catch {
        attendanceZeroMigrationRanRef.current = false;
      }
    })();
  }, [
    currentUser,
    dataLoading,
    sheetConfigsLoaded,
    onlineClassRecordsLoaded,
    sheetConfigs,
    students,
    onlineClassRecords,
    notify,
  ]);

  // One-time sync: share Jaunpur heading-only / blank extra columns across all centres via global config
  useEffect(() => {
    if (
      !currentUser ||
      currentUser.role !== 'super_admin' ||
      dataLoading ||
      !sheetConfigsLoaded ||
      jaunpurColsSharedMigrationRef.current
    ) {
      return;
    }

    const alreadyShared = sheetConfigs.some((c) => c.configId === 'jaunpur_cols_shared_v1');
    if (alreadyShared) {
      jaunpurColsSharedMigrationRef.current = true;
      return;
    }

    jaunpurColsSharedMigrationRef.current = true;
    (async () => {
      try {
        const jaunpurHeadings = extractJaunpurHeadingAndBlankColumns(students, sheetConfigs);
        const added =
          jaunpurHeadings.length > 0
            ? await mergeCustomColumnsIntoSharedConfig(
                jaunpurHeadings,
                currentUser,
                'Synced Jaunpur heading-only / blank extra columns across all centres',
              )
            : [];
        await saveExcelSheetConfig(
          'jaunpur_cols_shared_v1',
          {
            headerLabels: {},
            customColumns: [],
            hiddenCoreColumns: [],
            deletedExtraColumns: [],
          },
          currentUser,
          'Recorded Jaunpur shared extra columns baseline',
        );
        if (added.length > 0) {
          notify(
            'Jaunpur Columns Synced Across Centres',
            `Added ${added.length} Jaunpur extra heading${added.length > 1 ? 's' : ''} (${added.join(', ')}) to all centres.`,
            'info',
          );
        }
      } catch {
        jaunpurColsSharedMigrationRef.current = false;
      }
    })();
  }, [currentUser, dataLoading, sheetConfigsLoaded, sheetConfigs, students, notify]);

  // One-time cleanup: clear all stale/mock fees to ₹0 so only real uploaded Excel fee data remains
  useEffect(() => {
    if (
      !currentUser ||
      currentUser.role !== 'super_admin' ||
      dataLoading ||
      !sheetConfigsLoaded ||
      !feeRecordsLoaded ||
      fee12kCleanupMigrationRanRef.current
    ) {
      return;
    }

    const alreadyReset = sheetConfigs.some((c) => c.configId === 'fee_reset_to_zero_v2');
    if (alreadyReset) {
      fee12kCleanupMigrationRanRef.current = true;
      return;
    }

    fee12kCleanupMigrationRanRef.current = true;
    (async () => {
      try {
        const res = await resetAllFeeRecordsToZero(students, feeRecords, currentUser, {
          locationVerified: true,
        });
        await saveExcelSheetConfig(
          'fee_reset_to_zero_v2',
          {
            headerLabels: {},
            customColumns: [],
            hiddenCoreColumns: [],
            deletedExtraColumns: [],
          },
          currentUser,
          'Reset all mock/stale fee records to ₹0 — ready for real Excel upload',
        );
        if (res.resetCount > 0 || res.createdCount > 0) {
          notify(
            'Fee Section Reset to ₹0',
            `Cleared ${res.resetCount + res.createdCount} student fee records to ₹0. Upload your Excel sheet via "Update Fees from Excel" to populate real Paid & Unpaid fees.`,
            'info',
          );
        }
      } catch {
        fee12kCleanupMigrationRanRef.current = false;
      }
    })();
  }, [
    currentUser,
    dataLoading,
    sheetConfigsLoaded,
    feeRecordsLoaded,
    sheetConfigs,
    students,
    feeRecords,
    notify,
  ]);

  // One-time cleanup: clear legacy mock/placeholder subjects so TMA & Practical subjects stay blank until updated from Excel
  useEffect(() => {
    if (
      !currentUser ||
      currentUser.role !== 'super_admin' ||
      dataLoading ||
      !sheetConfigsLoaded ||
      subjectMockCleanupRanRef.current
    ) {
      return;
    }

    const alreadyCleaned = sheetConfigs.some((c) => c.configId === 'subject_mock_cleanup_v1');
    if (alreadyCleaned) {
      subjectMockCleanupRanRef.current = true;
      return;
    }

    subjectMockCleanupRanRef.current = true;
    (async () => {
      try {
        const res = await clearMockSubjectsFromStudents(students, currentUser, {
          locationVerified: true,
        });
        await saveExcelSheetConfig(
          'subject_mock_cleanup_v1',
          {
            headerLabels: {},
            customColumns: [],
            hiddenCoreColumns: [],
            deletedExtraColumns: [],
          },
          currentUser,
          'Cleared legacy mock subjects from students, TMA, and admission records',
        );
        if (res.clearedCount > 0) {
          notify(
            'Mock Subjects Cleared',
            `Removed mock subjects from ${res.clearedCount} student record${res.clearedCount === 1 ? '' : 's'}. Upload your Excel sheet in TMA or Practical to populate real subjects.`,
            'info',
          );
        }
      } catch {
        subjectMockCleanupRanRef.current = false;
      }
    })();
  }, [currentUser, dataLoading, sheetConfigsLoaded, sheetConfigs, students, notify]);

  const handleSelectSection = (section: NavSection) => {
    if (!currentUser) return;
    if (!canUserAccessSection(currentUser, section, activeAssignedDepartments)) {
      notify('Access Denied', 'You do not have permission to open this department.', 'error');
      return;
    }
    setActiveSection(section);
    window.location.hash = `#${section}`;
  };

  const handleChangeCentreFilter = useCallback(
    (nextCentre: CentreId | 'all') => {
      setSelectedCentreFilter(nextCentre);
      if (currentUser?.role === 'super_admin') {
        try {
          localStorage.setItem(`ds_super_admin_centre_${currentUser.uid}`, nextCentre);
        } catch {
          // ignore storage quota errors
        }
      }
    },
    [currentUser],
  );

  if (authChecking) {
    return (
      <div className="min-h-screen flex items-center justify-center cosmic-blue-bg text-white p-6">
        <div className="glass-login-card rounded-3xl text-center space-y-5 px-8 py-10 max-w-md w-full">
          <div className="w-11 h-11 border-4 border-[#EF4444] border-t-transparent rounded-full animate-spin mx-auto" />
          <div>
            <p className="text-sm font-extrabold italic tracking-widest uppercase text-white">DATABASE SECURITY</p>
            <p className="text-xs text-slate-300 mt-1">Initializing Ashish Pandey&apos;s Database Security...</p>
          </div>
          <div className="inline-flex flex-col items-center bg-white text-[#0F172A] px-6 py-3.5 rounded-2xl border border-rose-200/70 shadow-xl">
            <span className="text-[10px] font-extrabold uppercase tracking-[0.18em] text-[#B91C1C]">Powered by</span>
            <img
              src="/assets/aistudio/Chat-GPT-Image-Sep-16-2026-06-23-59-PM_a9ff6c17.png"
              alt="Shukra Infotech"
              referrerPolicy="no-referrer"
              className="h-11 w-auto object-contain mt-1"
            />
          </div>
        </div>
      </div>
    );
  }

  if (!currentUser) {
    return (
      <>
        <LoginScreen
          externalError={loginError}
          onAuthFlowChange={(inFlight) => {
            manualAuthInFlightRef.current = inFlight;
          }}
          onNotify={notify}
          onAuthenticated={(profile, activeCentre) => {
            setLoginError(null);
            setCurrentUser(profile);
            const resolvedCentre = profile.role === 'super_admin' ? activeCentre : profile.centreId;
            setSelectedCentreFilter(resolvedCentre);
            if (profile.role === 'super_admin') {
              try {
                localStorage.setItem(`ds_super_admin_centre_${profile.uid}`, activeCentre);
              } catch {
                // ignore storage quota errors
              }
            }
            setActiveSection(profile.role === 'employee' ? (profile.department as NavSection) : 'overview');
            triggerSirWelcome(profile);
          }}
        />
        <ToastContainer toasts={toasts} onDismiss={dismissToast} />
      </>
    );
  }

  const safeSection: NavSection = canUserAccessSection(currentUser, activeSection, activeAssignedDepartments)
    ? activeSection
    : 'overview';

  return (
    <>
      <DashboardShell
        currentUser={currentUser}
        activeSection={safeSection}
        selectedCentreFilter={selectedCentreFilter}
        globalSearch={globalSearch}
        notifications={notifications}
        assignedDepartments={activeAssignedDepartments}
        onSelectSection={handleSelectSection}
        onChangeCentreFilter={handleChangeCentreFilter}
        onChangeGlobalSearch={setGlobalSearch}
        onSync={handleManualSync}
        syncing={manualSyncing}
        onLogout={handleLogout}
      >
        {safeSection === 'overview' && (
          <OverviewDashboard
            currentUser={currentUser}
            centres={centres}
            users={users}
            students={students}
            feeRecords={feeRecords}
            practicalRecords={practicalRecords}
            tmaRecords={tmaRecords}
            onlineClassRecords={onlineClassRecords}
            admissionRecords={admissionRecords}
            activityLogs={activityLogs}
            selectedCentreFilter={selectedCentreFilter}
            onNavigate={handleSelectSection}
            onNotify={notify}
          />
        )}

        {safeSection === 'centre_management' && (
          <CentreManagementView
            currentUser={currentUser}
            centres={centres}
            users={users}
            students={students}
            feeRecords={feeRecords}
            practicalRecords={practicalRecords}
            tmaRecords={tmaRecords}
            onlineClassRecords={onlineClassRecords}
            admissionRecords={admissionRecords}
            activityLogs={activityLogs}
            onNotify={notify}
          />
        )}

        {safeSection === 'student_database' && (
          <StudentDatabaseView
            students={students}
            feeRecords={feeRecords}
            employees={users}
            editRequests={editRequests}
            sheetConfigs={sheetConfigs}
            currentUser={currentUser}
            selectedCentreFilter={selectedCentreFilter}
            globalSearch={globalSearch}
            loading={dataLoading}
            onNotify={notify}
          />
        )}

        {safeSection === 'fee_recovery' && (
          <FeeRecoveryView
            students={students}
            feeRecords={feeRecords}
            employees={users}
            editRequests={editRequests}
            workAssignments={workAssignments}
            workAssignmentTasks={workAssignmentTasks}
            currentUser={currentUser}
            selectedCentreFilter={selectedCentreFilter}
            globalSearch={globalSearch}
            onNotify={notify}
          />
        )}

        {safeSection === 'practical' && (
          <PracticalView
            students={students}
            practicalRecords={practicalRecords}
            employees={users}
            editRequests={editRequests}
            sheetConfigs={sheetConfigs}
            workAssignments={workAssignments}
            workAssignmentTasks={workAssignmentTasks}
            currentUser={currentUser}
            selectedCentreFilter={selectedCentreFilter}
            globalSearch={globalSearch}
            onNotify={notify}
          />
        )}

        {safeSection === 'tma' && (
          <TmaView
            students={students}
            tmaRecords={tmaRecords}
            employees={users}
            editRequests={editRequests}
            sheetConfigs={sheetConfigs}
            workAssignments={workAssignments}
            workAssignmentTasks={workAssignmentTasks}
            currentUser={currentUser}
            selectedCentreFilter={selectedCentreFilter}
            globalSearch={globalSearch}
            onNotify={notify}
          />
        )}

        {safeSection === 'online_classes' && (
          <OnlineClassesView
            students={students}
            onlineClassRecords={onlineClassRecords}
            employees={users}
            editRequests={editRequests}
            currentUser={currentUser}
            selectedCentreFilter={selectedCentreFilter}
            globalSearch={globalSearch}
            onNotify={notify}
          />
        )}

        {safeSection === 'admission' && (
          <AdmissionView
            students={students}
            admissionRecords={admissionRecords}
            employees={users}
            editRequests={editRequests}
            currentUser={currentUser}
            selectedCentreFilter={selectedCentreFilter}
            globalSearch={globalSearch}
            onNotify={notify}
          />
        )}

        {safeSection === 'employee_management' && (
          <EmployeeManagementView
            currentUser={currentUser}
            users={users}
            staffInvites={staffInvites}
            selectedCentreFilter={selectedCentreFilter}
            onNotify={notify}
          />
        )}

        {safeSection === 'reports' && (
          <ReportsAnalyticsView
            currentUser={currentUser}
            students={students}
            users={users}
            feeRecords={feeRecords}
            practicalRecords={practicalRecords}
            tmaRecords={tmaRecords}
            onlineClassRecords={onlineClassRecords}
            admissionRecords={admissionRecords}
            employeeReports={employeeReports}
            selectedCentreFilter={selectedCentreFilter}
            onNotify={notify}
          />
        )}

        {safeSection === 'settings' && (
          <SettingsView
            currentUser={currentUser}
            settings={systemSettings}
            centres={centres}
            students={students}
            feeRecords={feeRecords}
            practicalRecords={practicalRecords}
            tmaRecords={tmaRecords}
            onlineClassRecords={onlineClassRecords}
            admissionRecords={admissionRecords}
            sheetConfigs={sheetConfigs}
            workAssignments={workAssignments}
            workAssignmentTasks={workAssignmentTasks}
            users={users}
            staffInvites={staffInvites}
            employeeReports={employeeReports}
            editRequests={editRequests}
            onNotify={notify}
          />
        )}

        {safeSection === 'activity_logs' && currentUser.role === 'super_admin' && (
          <ActivityLogsView
            currentUser={currentUser}
            activityLogs={activityLogs}
            locationVerifications={locationVerifications}
            selectedCentreFilter={selectedCentreFilter}
          />
        )}
      </DashboardShell>
      <SirWelcomeOverlay
        visible={showSirWelcome}
        isSpeaking={sirSpeaking}
        audioCompleted={sirAudioCompleted}
        autoplayBlocked={sirAutoplayBlocked}
        progress={sirProgress}
        onPlayNow={() => triggerSirWelcome(currentUser)}
        onDismiss={dismissSirWelcome}
      />
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </>
  );
}
