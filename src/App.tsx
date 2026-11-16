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
import { CommunicationView } from './components/CommunicationView';
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
import { WalkieOverlayBar } from './components/WalkieOverlayBar';
import { isBootstrappedOwnerEmail } from './constants/centres';
import { useWalkieComms } from './hooks/useWalkieComms';
import { auth, db, handleFirestoreError, OperationType } from './lib/firebase';
import { speakWelcomeMessage, stopWelcomeMessage } from './lib/voiceWelcome';
import {
  claimPendingStaffInvite,
  ensureInitialPlatformSetup,
  getUserProfile,
  logActivity,
} from './services/firestoreService';
import type {
  ActivityLog,
  AdmissionRecord,
  Centre,
  CentreId,
  DirectMessage,
  EditRequest,
  EmployeeReport,
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
  const [directMessages, setDirectMessages] = useState<DirectMessage[]>([]);

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

  const activeSectionRef = useRef<NavSection>(activeSection);
  activeSectionRef.current = activeSection;

  const walkieComms = useWalkieComms({
    currentUser,
    onNotify: notify,
    onIncomingChatPing: useCallback(
      ({ fromName, preview }: { fromName: string; staffUid: string; preview: string }) => {
        if (activeSectionRef.current !== 'communication') {
          notify(`New Message from ${fromName}`, preview || 'Open Sir Connect & Walkie to read.', 'info');
        }
      },
      [notify],
    ),
  });

  const triggerSirWelcome = useCallback(() => {
    if (sirAutoCloseTimerRef.current) {
      clearTimeout(sirAutoCloseTimerRef.current);
      sirAutoCloseTimerRef.current = null;
    }
    setShowSirWelcome(true);
    setSirSpeaking(true);
    setSirAudioCompleted(false);
    setSirAutoplayBlocked(false);
    setSirProgress(0);

    speakWelcomeMessage(true, {
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
    });
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
          fbUser.emailVerified &&
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
        if (!profile && fbUser.email && fbUser.emailVerified) {
          profile = await claimPendingStaffInvite({
            uid: fbUser.uid,
            email: fbUser.email,
            displayName: fbUser.displayName,
          });
        }

        if (profile && profile.status === 'Active') {
          setCurrentUser(profile);
          setSelectedCentreFilter(profile.role === 'super_admin' ? 'all' : profile.centreId);
          setActiveSection(profile.role === 'employee' ? (profile.department as NavSection) : 'overview');
        } else if (profile && profile.status !== 'Active') {
          await signOut(auth);
          setLoginError('This account has been deactivated by an administrator.');
          setCurrentUser(null);
        }
      } catch (err) {
        console.error('Auth restoration error:', err);
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

  // Real-time Firestore listeners scoped strictly by Role, Centre, and Department
  // Note: Non-super-admin queries omit .orderBy() when .where() is used and sort client-side
  // so no Firestore composite index is required for Centre Head or Employee sessions.
  useEffect(() => {
    if (!currentUser) return;
    setDataLoading(true);
    const unsubs: Unsubscribe[] = [];

    const isSuper = currentUser.role === 'super_admin';
    const isHead = currentUser.role === 'centre_head';
    const cId = currentUser.centreId;

    // 1. Centres
    const centresQuery = isSuper
      ? query(collection(db, 'centres'))
      : query(collection(db, 'centres'), where('id', '==', cId));
    unsubs.push(
      onSnapshot(
        centresQuery,
        (snap) => setCentres(snap.docs.map((d) => d.data() as Centre)),
        (err) => handleFirestoreError(err, OperationType.LIST, 'centres'),
      ),
    );

    // 2. Users (Super Admin sees all, Centre Head sees own centre, Employee sees self)
    if (isSuper || isHead) {
      const usersQuery = isSuper
        ? query(collection(db, 'users'))
        : query(collection(db, 'users'), where('centreId', '==', cId));
      unsubs.push(
        onSnapshot(
          usersQuery,
          (snap) => setUsers(snap.docs.map((d) => d.data() as UserAccount)),
          (err) => handleFirestoreError(err, OperationType.LIST, 'users'),
        ),
      );
    } else {
      setUsers([currentUser]);
    }

    // 3. Central Students Database
    const studentsQuery = isSuper
      ? query(collection(db, 'students'), orderBy('serialNumber', 'desc'))
      : query(collection(db, 'students'), where('centreId', '==', cId));
    unsubs.push(
      onSnapshot(
        studentsQuery,
        (snap) => {
          const items = snap.docs
            .map((d) => d.data() as Student)
            .sort((a, b) => (b.serialNumber || 0) - (a.serialNumber || 0));
          setStudents(items);
          setDataLoading(false);
        },
        (err) => {
          setDataLoading(false);
          handleFirestoreError(err, OperationType.LIST, 'students');
        },
      ),
    );

    // 4. Department-Specific Records (Strictly isolated by department for employees)
    const subscribeDept = <T,>(colName: string, deptKey: string, setter: (items: T[]) => void) => {
      if (!isSuper && !isHead && currentUser.department !== deptKey) {
        setter([]);
        return;
      }
      const q = isSuper
        ? query(collection(db, colName))
        : query(collection(db, colName), where('centreId', '==', cId));
      unsubs.push(
        onSnapshot(
          q,
          (snap) => setter(snap.docs.map((d) => d.data() as T)),
          (err) => handleFirestoreError(err, OperationType.LIST, colName),
        ),
      );
    };

    subscribeDept<FeeRecoveryRecord>('fee_recovery', 'fee_recovery', setFeeRecords);
    subscribeDept<PracticalRecord>('practical_records', 'practical', setPracticalRecords);
    subscribeDept<TmaRecord>('tma_records', 'tma', setTmaRecords);
    subscribeDept<OnlineClassRecord>('online_class_records', 'online_classes', setOnlineClassRecords);
    subscribeDept<AdmissionRecord>('admission_records', 'admission', setAdmissionRecords);

    // 5 & 6. Activity Logs & Location Verifications (Super Admin ONLY)
    if (isSuper) {
      const logsQuery = query(collection(db, 'activity_logs'), orderBy('createdAt', 'desc'), limit(150));
      unsubs.push(
        onSnapshot(
          logsQuery,
          (snap) => {
            const sorted = snap.docs
              .map((d) => ({ id: d.id, ...(d.data() as ActivityLog) }))
              .sort((a, b) => toMillis(b.createdAt) - toMillis(a.createdAt));
            setActivityLogs(sorted);
          },
          (err) => handleFirestoreError(err, OperationType.LIST, 'activity_logs'),
        ),
      );

      const geoQuery = query(collection(db, 'location_verifications'), orderBy('createdAt', 'desc'), limit(100));
      unsubs.push(
        onSnapshot(
          geoQuery,
          (snap) => {
            const sorted = snap.docs
              .map((d) => ({ id: d.id, ...(d.data() as LocationVerification) }))
              .sort((a, b) => toMillis(b.createdAt) - toMillis(a.createdAt));
            setLocationVerifications(sorted);
          },
          (err) => handleFirestoreError(err, OperationType.LIST, 'location_verifications'),
        ),
      );
    } else {
      setActivityLogs([]);
      setLocationVerifications([]);
    }

    // 7. System Settings
    unsubs.push(
      onSnapshot(
        doc(db, 'system_settings', 'global'),
        (snap) => {
          if (snap.exists()) setSystemSettings(snap.data() as SystemSettings);
        },
        (err) => handleFirestoreError(err, OperationType.GET, 'system_settings/global'),
      ),
    );

    // 8. Notifications
    const notifQuery = isSuper
      ? query(collection(db, 'notifications'), orderBy('createdAt', 'desc'), limit(30))
      : isHead
        ? query(collection(db, 'notifications'), where('centreId', '==', cId), limit(30))
        : query(collection(db, 'notifications'), where('recipientUid', '==', currentUser.uid), limit(25));
    unsubs.push(
      onSnapshot(
        notifQuery,
        (snap) => {
          const sorted = snap.docs
            .map((d) => ({ id: d.id, ...(d.data() as NotificationItem) }))
            .sort((a, b) => toMillis(b.createdAt) - toMillis(a.createdAt));
          setNotifications(sorted);
        },
        (err) => handleFirestoreError(err, OperationType.LIST, 'notifications'),
      ),
    );

    // 9. Staff Invites (Super Admin & Centre Head)
    if (isSuper || isHead) {
      const invitesQuery = isSuper
        ? query(collection(db, 'staff_invites'))
        : query(collection(db, 'staff_invites'), where('centreId', '==', cId));
      unsubs.push(
        onSnapshot(
          invitesQuery,
          (snap) => setStaffInvites(snap.docs.map((d) => d.data() as StaffInvite)),
          (err) => handleFirestoreError(err, OperationType.LIST, 'staff_invites'),
        ),
      );
    } else {
      setStaffInvites([]);
    }

    // 10. Employee Daily Work Reports
    const reportsQuery = isSuper
      ? query(collection(db, 'employee_reports'), orderBy('createdAt', 'desc'), limit(150))
      : isHead
        ? query(collection(db, 'employee_reports'), where('centreId', '==', cId), limit(120))
        : query(collection(db, 'employee_reports'), where('employeeUid', '==', currentUser.uid), limit(80));
    unsubs.push(
      onSnapshot(
        reportsQuery,
        (snap) => {
          const sorted = snap.docs
            .map((d) => d.data() as EmployeeReport)
            .sort((a, b) => toMillis(b.createdAt) - toMillis(a.createdAt));
          setEmployeeReports(sorted);
        },
        (err) => handleFirestoreError(err, OperationType.LIST, 'employee_reports'),
      ),
    );

    // 11. Department Edit Permission Requests
    const editReqQuery = isSuper
      ? query(collection(db, 'edit_requests'), orderBy('createdAt', 'desc'), limit(120))
      : isHead
        ? query(collection(db, 'edit_requests'), where('centreId', '==', cId), limit(120))
        : query(collection(db, 'edit_requests'), where('requesterUid', '==', currentUser.uid), limit(80));
    unsubs.push(
      onSnapshot(
        editReqQuery,
        (snap) => {
          const sorted = snap.docs
            .map((d) => d.data() as EditRequest)
            .sort((a, b) => toMillis(b.createdAt) - toMillis(a.createdAt));
          setEditRequests(sorted);
        },
        (err) => handleFirestoreError(err, OperationType.LIST, 'edit_requests'),
      ),
    );

    // 12. Direct Messages (Super Admin <-> Staff Hub-and-Spoke)
    const msgQuery = isSuper
      ? query(collection(db, 'direct_messages'), orderBy('createdAt', 'desc'), limit(400))
      : query(collection(db, 'direct_messages'), where('staffUid', '==', currentUser.uid), limit(250));
    unsubs.push(
      onSnapshot(
        msgQuery,
        (snap) => {
          const sorted = snap.docs
            .map((d) => d.data() as DirectMessage)
            .sort((a, b) => toMillis(a.createdAt) - toMillis(b.createdAt));
          setDirectMessages(sorted);
        },
        (err) => handleFirestoreError(err, OperationType.LIST, 'direct_messages'),
      ),
    );

    return () => {
      unsubs.forEach((u) => u());
    };
  }, [currentUser]);

  const handleSelectSection = (section: NavSection) => {
    if (!currentUser) return;
    if (!canUserAccessSection(currentUser, section)) {
      notify('Access Denied', 'You do not have permission to open this department.', 'error');
      return;
    }
    setActiveSection(section);
    window.location.hash = `#${section}`;
  };

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
            setSelectedCentreFilter(profile.role === 'super_admin' ? 'all' : activeCentre);
            setActiveSection(profile.role === 'employee' ? (profile.department as NavSection) : 'overview');
            triggerSirWelcome();
          }}
        />
        <ToastContainer toasts={toasts} onDismiss={dismissToast} />
      </>
    );
  }

  const safeSection: NavSection = canUserAccessSection(currentUser, activeSection)
    ? activeSection
    : 'overview';

  const unreadCommsCount = directMessages.filter((m) =>
    currentUser.role === 'super_admin'
      ? !m.readByAdmin
      : m.staffUid === currentUser.uid && !m.readByStaff,
  ).length;

  return (
    <>
      <DashboardShell
        currentUser={currentUser}
        activeSection={safeSection}
        selectedCentreFilter={selectedCentreFilter}
        globalSearch={globalSearch}
        notifications={notifications}
        unreadCommsCount={unreadCommsCount}
        isWalkieLive={Boolean(walkieComms.incomingWalkie || walkieComms.isTransmitting)}
        onSelectSection={handleSelectSection}
        onChangeCentreFilter={setSelectedCentreFilter}
        onChangeGlobalSearch={setGlobalSearch}
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
          />
        )}

        {safeSection === 'communication' && (
          <CommunicationView
            currentUser={currentUser}
            users={users}
            directMessages={directMessages}
            selectedCentreFilter={selectedCentreFilter}
            wsConnected={walkieComms.wsConnected}
            onlineStaff={walkieComms.onlineStaff}
            superAdminOnline={walkieComms.superAdminOnline}
            audioUnlocked={walkieComms.audioUnlocked}
            isTransmitting={walkieComms.isTransmitting}
            txTargetLabel={walkieComms.txTargetLabel}
            txRecipientCount={walkieComms.txRecipientCount}
            micLevel={walkieComms.micLevel}
            incomingWalkie={walkieComms.incomingWalkie}
            rxLevel={walkieComms.rxLevel}
            onUnlockSpeaker={walkieComms.unlockSpeaker}
            onStartWalkieTx={walkieComms.startWalkieTx}
            onStopWalkieTx={walkieComms.stopWalkieTx}
            onSendChatPing={walkieComms.sendChatPing}
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
            employees={users}
            editRequests={editRequests}
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
            users={users}
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
        onPlayNow={triggerSirWelcome}
        onDismiss={dismissSirWelcome}
      />
      <WalkieOverlayBar
        currentUser={currentUser}
        incomingWalkie={walkieComms.incomingWalkie}
        rxLevel={walkieComms.rxLevel}
        isTransmitting={walkieComms.isTransmitting}
        txTargetLabel={walkieComms.txTargetLabel}
        txRecipientCount={walkieComms.txRecipientCount}
        micLevel={walkieComms.micLevel}
        audioUnlocked={walkieComms.audioUnlocked}
        onUnlockSpeaker={walkieComms.unlockSpeaker}
        onStartReply={walkieComms.startWalkieTx}
        onStopTx={() => walkieComms.stopWalkieTx()}
        onOpenComms={() => handleSelectSection('communication')}
      />
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </>
  );
}
