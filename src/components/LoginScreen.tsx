import {
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
} from 'firebase/auth';
import {
  AlertTriangle,
  Building2,
  Check,
  ChevronDown,
  ExternalLink,
  Eye,
  EyeOff,
  Flame,
  GraduationCap,
  Layers,
  Lock,
  LogIn,
  Mail,
  MapPin,
  Monitor,
  RefreshCw,
  ShieldCheck,
  Users,
  X,
} from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import React, { useEffect, useRef, useState } from 'react';
import firebaseConfig from '../../firebase-applet-config.json';
import { CANONICAL_CENTRES, CENTRE_MAP, isBootstrappedOwnerEmail } from '../constants/centres';
import { auth, googleProvider } from '../lib/firebase';
import { verifySuperAdminOwnerOnServer } from '../lib/securityClient';
import { speakWelcomeMessage } from '../lib/voiceWelcome';
import {
  claimPendingStaffInvite,
  ensureInitialPlatformSetup,
  getUserProfile,
  logActivity,
} from '../services/firestoreService';
import type { CentreId, UserAccount } from '../types/domain';
import { CampusTwilightArtwork } from './CampusTwilightArtwork';

interface LoginScreenProps {
  onAuthenticated: (profile: UserAccount, activeCentre: CentreId) => void;
  onAuthFlowChange?: (inFlight: boolean) => void;
  onNotify: (title: string, description: string, variant: 'success' | 'error' | 'warning' | 'info') => void;
  externalError?: string | null;
}

const DEFAULT_ACCESS_NOTICE =
  'Access denied: Your account has not been provisioned yet. Ask your Super Admin or Centre Head to add your email first.';

const CENTRE_STYLES: Record<
  CentreId,
  {
    colorHex: string;
    bgIdle: string;
    bgActive: string;
    borderIdle: string;
    borderActive: string;
    glowIdle: string;
    glowActive: string;
    iconRing: string;
  }
> = {
  vp_lookerganj: {
    colorHex: '#FF1739',
    bgIdle: 'bg-[#1a0d1c]/70 hover:bg-[#2a0f22]/80',
    bgActive: 'bg-gradient-to-r from-[#9A001B]/80 via-[#6b0c22]/75 to-[#161938]/75',
    borderIdle: 'border-[#FF1739]/60 hover:border-[#FF1739]',
    borderActive: 'border-[#FF1739]',
    glowIdle: 'shadow-[0_0_18px_rgba(255,23,57,0.22)] hover:shadow-[0_0_26px_rgba(255,23,57,0.45)]',
    glowActive: 'shadow-[0_0_30px_rgba(255,23,57,0.58),inset_0_1px_1px_rgba(255,255,255,0.32)]',
    iconRing: 'text-white border-[#FF1739]/70 bg-[#FF1739]/25',
  },
  vp_civillines: {
    colorHex: '#41A9FF',
    bgIdle: 'bg-[#0c1934]/70 hover:bg-[#11244a]/80',
    bgActive: 'bg-gradient-to-r from-[#164b8a]/80 via-[#102e5e]/75 to-[#0d1b3b]/75',
    borderIdle: 'border-[#41A9FF]/55 hover:border-[#41A9FF]',
    borderActive: 'border-[#41A9FF]',
    glowIdle: 'shadow-[0_0_18px_rgba(65,169,255,0.2)] hover:shadow-[0_0_26px_rgba(65,169,255,0.45)]',
    glowActive: 'shadow-[0_0_30px_rgba(65,169,255,0.55),inset_0_1px_1px_rgba(255,255,255,0.32)]',
    iconRing: 'text-[#89CCFF] border-[#41A9FF]/60 bg-[#41A9FF]/20',
  },
  xis_varanasi: {
    colorHex: '#BD54FF',
    bgIdle: 'bg-[#151232]/70 hover:bg-[#22174a]/80',
    bgActive: 'bg-gradient-to-r from-[#5b2192]/80 via-[#381868]/75 to-[#16153a]/75',
    borderIdle: 'border-[#BD54FF]/55 hover:border-[#BD54FF]',
    borderActive: 'border-[#BD54FF]',
    glowIdle: 'shadow-[0_0_18px_rgba(189,84,255,0.2)] hover:shadow-[0_0_26px_rgba(189,84,255,0.45)]',
    glowActive: 'shadow-[0_0_30px_rgba(189,84,255,0.55),inset_0_1px_1px_rgba(255,255,255,0.32)]',
    iconRing: 'text-[#DDB0FF] border-[#BD54FF]/60 bg-[#BD54FF]/20',
  },
  xis_jaunpur: {
    colorHex: '#00D9FF',
    bgIdle: 'bg-[#091c34]/70 hover:bg-[#0d2b4c]/80',
    bgActive: 'bg-gradient-to-r from-[#007a9c]/80 via-[#09476b]/75 to-[#0b1f3d]/75',
    borderIdle: 'border-[#00D9FF]/55 hover:border-[#00D9FF]',
    borderActive: 'border-[#00D9FF]',
    glowIdle: 'shadow-[0_0_18px_rgba(0,217,255,0.2)] hover:shadow-[0_0_26px_rgba(0,217,255,0.45)]',
    glowActive: 'shadow-[0_0_30px_rgba(0,217,255,0.55),inset_0_1px_1px_rgba(255,255,255,0.32)]',
    iconRing: 'text-[#84EFFF] border-[#00D9FF]/60 bg-[#00D9FF]/20',
  },
};

/** Glossy black graduation cap with golden tassel matching the hero centerpiece */
const HeroGraduationCapSvg: React.FC<{ className?: string }> = ({ className }) => (
  <svg viewBox="0 0 120 92" fill="none" className={className} aria-hidden="true">
    <defs>
      <linearGradient id="capTopGrad" x1="14" y1="12" x2="104" y2="54" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stopColor="#3B4256" />
        <stop offset="45%" stopColor="#171C28" />
        <stop offset="100%" stopColor="#070910" />
      </linearGradient>
      <linearGradient id="capBaseGrad" x1="30" y1="45" x2="88" y2="75" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stopColor="#262C3D" />
        <stop offset="100%" stopColor="#090C14" />
      </linearGradient>
      <linearGradient id="tasselGold" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stopColor="#FFE58F" />
        <stop offset="50%" stopColor="#FFC83D" />
        <stop offset="100%" stopColor="#D97706" />
      </linearGradient>
      <filter id="capDropShadow" x="-15%" y="-15%" width="135%" height="145%">
        <feDropShadow dx="0" dy="8" stdDeviation="6" floodColor="#000000" floodOpacity="0.6" />
      </filter>
    </defs>
    <g filter="url(#capDropShadow)">
      {/* Lower skull cap dome */}
      <path
        d="M31 44 L31 64 C31 73 44 79 60 79 C76 79 89 73 89 64 L89 44 Z"
        fill="url(#capBaseGrad)"
        stroke="#475569"
        strokeWidth="1"
      />
      {/* Top Mortarboard Diamond */}
      <path
        d="M60 10 L114 33 L60 55 L6 33 Z"
        fill="url(#capTopGrad)"
        stroke="#94A3B8"
        strokeOpacity="0.45"
        strokeWidth="1.2"
      />
      {/* Subtle bevel highlight */}
      <path d="M60 11 L110 33 L60 52" stroke="rgba(255,255,255,0.22)" strokeWidth="1" />
      {/* Gold centre button */}
      <ellipse cx="60" cy="31" rx="4.5" ry="2.8" fill="url(#tasselGold)" />
      {/* Hanging golden cord & tassel */}
      <path d="M60 31 C76 34 90 42 93 56" stroke="url(#tasselGold)" strokeWidth="2.4" strokeLinecap="round" />
      <circle cx="93" cy="58" r="3" fill="url(#tasselGold)" />
      <path d="M90 60 L96 60 L99 84 L87 84 Z" fill="url(#tasselGold)" />
    </g>
  </svg>
);

export const LoginScreen: React.FC<LoginScreenProps> = ({
  onAuthenticated,
  onAuthFlowChange,
  onNotify,
  externalError,
}) => {
  const prefersReducedMotion = useReducedMotion();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [selectedCentreId, setSelectedCentreId] = useState<CentreId>('vp_lookerganj');
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(externalError || null);
  const [providerDisabledHelp, setProviderDisabledHelp] = useState(false);
  const [emailPasswordEnabled, setEmailPasswordEnabled] = useState<boolean | null>(null);
  const [showEmailFormWhenDisabled, setShowEmailFormWhenDisabled] = useState(false);
  const [checkingProviders, setCheckingProviders] = useState(false);
  const [popupBlockedHelp, setPopupBlockedHelp] = useState(false);

  const [showResetModal, setShowResetModal] = useState(false);
  const [resetEmail, setResetEmail] = useState('');
  const [resetSending, setResetSending] = useState(false);

  const dropdownRef = useRef<HTMLDivElement>(null);

  const checkProviderStatus = async (manual = false) => {
    if (manual) setCheckingProviders(true);
    try {
      const res = await fetch('/api/auth/provider-status');
      const data = (await res.json().catch(() => ({}))) as { emailPasswordEnabled?: boolean };
      if (typeof data.emailPasswordEnabled === 'boolean') {
        setEmailPasswordEnabled(data.emailPasswordEnabled);
        if (data.emailPasswordEnabled) {
          setProviderDisabledHelp(false);
          setShowEmailFormWhenDisabled(true);
          if (manual) {
            onNotify(
              'Email/Password Enabled',
              'Email/Password Sign-In is now active in Firebase! You can log in directly.',
              'success',
            );
          }
        } else if (manual) {
          onNotify(
            'Still Disabled in Firebase',
            'Enable Email/Password in Firebase Console -> Authentication -> Sign-in method, or click Sign in with Google above.',
            'warning',
          );
        }
      }
    } catch {
      // ignore probe failure
    } finally {
      if (manual) setCheckingProviders(false);
    }
  };

  useEffect(() => {
    void checkProviderStatus(false);
  }, []);

  useEffect(() => {
    if (externalError) {
      setErrorMsg(externalError);
    }
  }, [externalError]);

  useEffect(() => {
    const handleOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDropdownOpen(false);
    };
    document.addEventListener('mousedown', handleOutside);
    document.addEventListener('keydown', handleEsc);
    return () => {
      document.removeEventListener('mousedown', handleOutside);
      document.removeEventListener('keydown', handleEsc);
    };
  }, []);

  const validateCentreAndComplete = async (uid: string, authEmail: string, emailVerified: boolean) => {
    let profile = await getUserProfile(uid);

    if (
      emailVerified &&
      isBootstrappedOwnerEmail(authEmail) &&
      (!profile || profile.role !== 'super_admin' || profile.department !== 'all' || profile.status !== 'Active')
    ) {
      const serverCheck = await verifySuperAdminOwnerOnServer(authEmail);
      if (serverCheck.allowed) {
        profile = await ensureInitialPlatformSetup({
          uid,
          email: authEmail,
          fullName: auth.currentUser?.displayName || profile?.fullName || 'Ashish Pandey',
        });
      }
    }

    if (!profile && emailVerified) {
      profile = await claimPendingStaffInvite({
        uid,
        email: authEmail,
        displayName: auth.currentUser?.displayName,
      });
    }

    if (!profile) {
      await signOut(auth);
      setErrorMsg(DEFAULT_ACCESS_NOTICE);
      return;
    }

    if (profile.status !== 'Active') {
      await signOut(auth);
      setErrorMsg('Access denied: This account has been deactivated. Contact your administrator.');
      return;
    }

    if (profile.role !== 'super_admin' && profile.centreId !== selectedCentreId) {
      await logActivity({
        actorUid: profile.uid,
        actorName: profile.fullName,
        actorEmail: profile.email,
        actorRole: profile.role,
        centreId: profile.centreId,
        department: profile.department,
        action: 'LOGIN_DENIED_CENTRE_MISMATCH',
        targetCollection: 'users',
        targetId: profile.uid,
        details: `Denied login: selected ${CENTRE_MAP[selectedCentreId].name}, authorized for ${profile.centreName}.`,
        locationVerified: false,
      }).catch(() => {});

      await signOut(auth);
      setErrorMsg(
        `ACCESS DENIED: Selected centre (${CENTRE_MAP[selectedCentreId].name}) does not match your authorized centre (${profile.centreName}). Please select "${profile.centreName}" above.`,
      );
      return;
    }

    await logActivity({
      actorUid: profile.uid,
      actorName: profile.fullName,
      actorEmail: profile.email,
      actorRole: profile.role,
      centreId: profile.role === 'super_admin' ? selectedCentreId : profile.centreId,
      department: profile.department,
      action: 'LOGIN_SUCCESS',
      targetCollection: 'users',
      targetId: profile.uid,
      details: `Authenticated into ${CENTRE_MAP[selectedCentreId].name} as ${profile.role}.`,
      locationVerified: true,
    }).catch(() => {});

    onAuthenticated(profile, profile.role === 'super_admin' ? selectedCentreId : profile.centreId);
  };

  const handleEmailLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setProviderDisabledHelp(false);

    if (!email.trim() || !password) {
      setErrorMsg('Please enter both Email Address and Password.');
      return;
    }

    setLoading(true);
    onAuthFlowChange?.(true);
    try {
      const prepRes = await fetch('/api/auth/prepare-super-admin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), password }),
      });
      const prepData = (await prepRes.json().catch(() => ({}))) as {
        ready?: boolean;
        providerDisabled?: boolean;
      };
      if (prepData.providerDisabled) {
        setEmailPasswordEnabled(false);
        setProviderDisabledHelp(true);
        return;
      }

      const cred = await signInWithEmailAndPassword(auth, email.trim(), password);
      await validateCentreAndComplete(cred.user.uid, cred.user.email || email.trim(), cred.user.emailVerified);
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code || '';
      if (code === 'auth/operation-not-allowed') {
        setEmailPasswordEnabled(false);
        setProviderDisabledHelp(true);
      } else if (code === 'auth/invalid-credential' || code === 'auth/wrong-password' || code === 'auth/user-not-found') {
        setErrorMsg('Invalid email address or password.');
      } else if (code === 'auth/too-many-requests') {
        setErrorMsg('Too many failed attempts. Please wait a few minutes or reset your password.');
      } else {
        setErrorMsg(err instanceof Error ? err.message : 'Authentication failed.');
      }
    } finally {
      onAuthFlowChange?.(false);
      setLoading(false);
    }
  };

  const handleGoogleLogin = async () => {
    setErrorMsg(null);
    setProviderDisabledHelp(false);
    setPopupBlockedHelp(false);
    setLoading(true);
    onAuthFlowChange?.(true);
    try {
      const cred = await signInWithPopup(auth, googleProvider);
      await validateCentreAndComplete(cred.user.uid, cred.user.email || '', cred.user.emailVerified);
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code || '';
      if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
        return;
      }
      if (code === 'auth/popup-blocked') {
        setPopupBlockedHelp(true);
        setErrorMsg(
          'Google Sign-In popup was blocked by your browser inside this embedded frame. Click "Open App in New Tab" below or allow popups and try again.',
        );
      } else if (code === 'auth/unauthorized-domain') {
        const host = typeof window !== 'undefined' ? window.location.hostname : 'this domain';
        setErrorMsg(
          `Google Sign-In domain (${host}) is not authorized in Firebase Console -> Authentication -> Settings -> Authorized domains.`,
        );
      } else if (code === 'auth/operation-not-allowed') {
        setErrorMsg('Google Sign-In provider is not enabled in Firebase Console -> Authentication -> Sign-in method.');
      } else {
        setErrorMsg(err instanceof Error ? err.message : 'Google authentication failed.');
      }
    } finally {
      onAuthFlowChange?.(false);
      setLoading(false);
    }
  };

  const handlePasswordReset = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!resetEmail.trim()) return;
    setResetSending(true);
    try {
      await sendPasswordResetEmail(auth, resetEmail.trim());
      onNotify('Password Reset Sent', `Reset instructions sent to ${resetEmail.trim()}.`, 'success');
      setShowResetModal(false);
      setResetEmail('');
    } catch (err) {
      onNotify('Reset Failed', err instanceof Error ? err.message : 'Could not send reset link.', 'error');
    } finally {
      setResetSending(false);
    }
  };

  const entranceProps = prefersReducedMotion
    ? {}
    : {
        initial: { opacity: 0, y: 14 },
        animate: { opacity: 1, y: 0 },
        transition: { duration: 0.45, ease: [0.16, 1, 0.3, 1] as const },
      };

  return (
    <div className="relative min-h-screen w-full overflow-x-hidden flex flex-col justify-between text-white">
      {/* Full-Viewport Photorealistic Sunset Educational Campus Backdrop */}
      <CampusTwilightArtwork variant="login" />

      {/* Main Container spanning desktop 1440px+ cleanly with compact top & bottom bars */}
      <div className="relative z-10 w-full max-w-[1440px] mx-auto px-4 sm:px-8 lg:px-10 flex-1 flex flex-col justify-between py-4 sm:py-5 lg:py-6 gap-4">
        {/* TOP BAR: Compact Shukra Infotech White Card (Left) + Encrypted Security Capsule (Upper Center) */}
        <header className="w-full flex flex-wrap items-center justify-between gap-3">
          {/* Top-Left Company Branding Floating White Rectangle */}
          <div className="inline-flex items-center gap-2.5 bg-white text-[#071329] px-4 py-2 rounded-2xl border border-white shadow-[0_12px_32px_rgba(0,0,0,0.48)]">
            <div className="w-7 h-7 rounded-lg bg-[#FF1739]/12 flex items-center justify-center shrink-0">
              <Flame className="w-5 h-5 text-[#FF1739] fill-[#FF1739]/85" />
            </div>
            <div className="leading-tight">
              <span className="block text-[9px] font-bold uppercase tracking-[0.18em] text-slate-600">
                Powered By
              </span>
              <span className="block text-sm font-extrabold tracking-tight text-[#071329]">
                SHUKRA INFOTECH<span className="text-[#FFC83D]">.</span>
              </span>
            </div>
          </div>

          {/* Upper-Center Dark-Glass Capsule Security Badge */}
          <div className="mx-auto lg:mx-0 inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-[#0f182f]/75 backdrop-blur-md border border-[#FF1739] shadow-[0_0_22px_rgba(255,23,57,0.48)] text-xs font-bold tracking-[0.12em] text-white whitespace-nowrap">
            <Lock className="w-3.5 h-3.5 text-white shrink-0" />
            <span className="uppercase text-[11px]">ENCRYPTED MULTI-CENTRE MODE</span>
          </div>

          {/* Right-side spacer on desktop to anchor capsule in upper-center */}
          <div className="hidden lg:block w-48" aria-hidden="true" />
        </header>

        {/* TWO-COLUMN SPLIT: Desktop Left 60% / Right 40% (Mobile stacks Sign In prominently above lower cards) */}
        <main className="grid grid-cols-1 lg:grid-cols-12 gap-6 lg:gap-8 items-center my-auto">
          {/* LEFT 60% HERO + CENTRES + STATS */}
          <motion.section
            {...entranceProps}
            className="lg:col-span-7 flex flex-col justify-center space-y-5 order-1"
          >
            {/* Hero Typography Block */}
            <div>
              <div className="inline-flex items-center gap-2.5 text-xs sm:text-sm font-bold tracking-[0.18em] uppercase">
                <span className="w-[3px] h-4 bg-[#FF1739] -skew-x-12 rounded-full shadow-[0_0_10px_#FF1739]" />
                <span className="text-white/95">
                  WELCOME TO <span className="text-[#FFC83D]">ASHISH PANDEY&apos;S</span> DATABASE SECURITY
                </span>
              </div>

              <div className="mt-2.5 relative max-w-[600px]">
                <div className="flex items-end gap-2">
                  <h1 className="hero-silver-title font-display text-[2.45rem] sm:text-5xl xl:text-[3.65rem] font-extrabold italic uppercase tracking-tight leading-[0.95] pr-2">
                    DATABASE
                  </h1>
                  <HeroGraduationCapSvg className="w-14 h-11 sm:w-20 sm:h-16 -ml-4 -mb-1 shrink-0 pointer-events-none select-none" />
                </div>

                {/* Glossy Slanted Crimson SECURITY Banner */}
                <div className="mt-1.5 inline-block px-5 sm:px-6 py-1.5 rounded-xl super-excel-ribbon -skew-x-12">
                  <span className="block skew-x-12 font-display text-[2.2rem] sm:text-5xl xl:text-[3.35rem] font-extrabold italic uppercase tracking-tight text-white leading-[0.98] drop-shadow-[0_4px_12px_rgba(0,0,0,0.45)]">
                    SECURITY
                  </span>
                </div>
              </div>

              <p className="mt-4 text-xs sm:text-[14px] text-slate-100/95 leading-relaxed max-w-[495px] font-medium drop-shadow-[0_2px_8px_rgba(0,0,0,0.7)]">
                One Platform. Four Centres. Complete Control. Centralized multi-branch student governance, department
                telemetry, geofenced location verification, and real-time staff reporting.
              </p>
              <div className="mt-2.5 w-14 h-[3px] rounded-full bg-[#FF1739] shadow-[0_0_12px_#FF1739]" />
            </div>

            {/* Desktop Centre Grid & Stats (Shown cleanly here on lg+ and duplicated below form on <lg mobile layout per spec) */}
            <div className="hidden lg:block space-y-4">
              {/* Authorized Educational Centres */}
              <div>
                <div className="flex items-center gap-2.5 mb-2.5">
                  <Building2 className="w-4 h-4 text-[#FF1739] shrink-0" />
                  <h2 className="text-xs font-extrabold uppercase tracking-[0.14em] text-white whitespace-nowrap">
                    AUTHORIZED <span className="text-[#FFC83D]">EDUCATIONAL CENTRES</span>
                  </h2>
                  <div className="h-[1.5px] flex-1 bg-gradient-to-r from-[#FFC83D]/80 via-[#FFC83D]/30 to-transparent" />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  {CANONICAL_CENTRES.map((centre) => {
                    const isSelected = selectedCentreId === centre.id;
                    const theme = CENTRE_STYLES[centre.id];
                    return (
                      <button
                        key={centre.id}
                        type="button"
                        onClick={() => setSelectedCentreId(centre.id)}
                        className={`text-left px-3.5 py-3 rounded-2xl border backdrop-blur-xl transition-all duration-200 hover:-translate-y-0.5 flex items-center justify-between gap-2.5 ${
                          isSelected
                            ? `${theme.bgActive} ${theme.borderActive} ${theme.glowActive}`
                            : `${theme.bgIdle} ${theme.borderIdle} ${theme.glowIdle}`
                        }`}
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <div
                            className={`w-9 h-9 rounded-xl border flex items-center justify-center shrink-0 ${theme.iconRing}`}
                          >
                            <GraduationCap className="w-4 h-4" />
                          </div>
                          <div className="min-w-0">
                            <p className="text-xs font-extrabold tracking-wide text-white">{centre.code}</p>
                            <p className="text-[11px] font-medium text-slate-200/95 truncate mt-0.5">{centre.name}</p>
                          </div>
                        </div>
                        <MapPin
                          className="w-4 h-4 shrink-0"
                          style={{ color: isSelected ? '#FFC83D' : '#E2E8F0' }}
                        />
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* 4 Bottom Luminous Statistics Glass Cards */}
              <div className="grid grid-cols-4 gap-3 pt-1">
                <div className="px-3.5 py-2.5 rounded-2xl bg-[#161036]/68 backdrop-blur-xl border border-[#BD54FF]/70 shadow-[0_0_20px_rgba(189,84,255,0.28),inset_0_1px_0_rgba(255,255,255,0.2)] flex items-center gap-2.5">
                  <Building2 className="w-6 h-6 text-[#BD54FF] shrink-0 drop-shadow-[0_0_8px_rgba(189,84,255,0.75)]" />
                  <div className="leading-tight">
                    <p className="text-base font-extrabold font-mono text-white tabular-nums">04</p>
                    <p className="text-[11px] font-semibold text-slate-200">Centres</p>
                  </div>
                </div>

                <div className="px-3.5 py-2.5 rounded-2xl bg-[#14103a]/68 backdrop-blur-xl border border-[#9E4BFF]/70 shadow-[0_0_20px_rgba(158,75,255,0.28),inset_0_1px_0_rgba(255,255,255,0.2)] flex items-center gap-2.5">
                  <Users className="w-6 h-6 text-[#A855F7] shrink-0 drop-shadow-[0_0_8px_rgba(168,85,247,0.75)]" />
                  <div className="leading-tight">
                    <p className="text-base font-extrabold font-mono text-white tabular-nums">05</p>
                    <p className="text-[11px] font-semibold text-slate-200">Depts</p>
                  </div>
                </div>

                <div className="px-3.5 py-2.5 rounded-2xl bg-gradient-to-br from-[#3a260a]/75 to-[#1f160a]/75 backdrop-blur-xl border border-[#FFC83D]/75 shadow-[0_0_22px_rgba(255,200,61,0.32),inset_0_1px_0_rgba(255,255,255,0.24)] flex items-center gap-2.5">
                  <ShieldCheck className="w-6 h-6 text-[#FFC83D] shrink-0 drop-shadow-[0_0_8px_rgba(255,200,61,0.75)]" />
                  <div className="leading-tight">
                    <p className="text-xs font-extrabold text-white">GPS</p>
                    <p className="text-xs font-extrabold text-[#FFC83D]">Verified</p>
                  </div>
                </div>

                <div className="px-3.5 py-2.5 rounded-2xl bg-[#0a223a]/68 backdrop-blur-xl border border-[#00D9FF]/70 shadow-[0_0_20px_rgba(0,217,255,0.28),inset_0_1px_0_rgba(255,255,255,0.2)] flex items-center gap-2.5">
                  <Layers className="w-6 h-6 text-[#00D9FF] shrink-0 drop-shadow-[0_0_8px_rgba(0,217,255,0.75)]" />
                  <div className="leading-tight">
                    <p className="text-xs font-extrabold text-white">3-Tier</p>
                    <p className="text-xs font-extrabold text-white">RBAC</p>
                  </div>
                </div>
              </div>
            </div>
          </motion.section>

          {/* RIGHT 40% ENORMOUS FLOATING LIQUID-GLASS SIGN-IN PANEL */}
          <motion.section
            {...entranceProps}
            transition={prefersReducedMotion ? undefined : { duration: 0.5, delay: 0.06, ease: [0.16, 1, 0.3, 1] }}
            className="lg:col-span-5 flex justify-center lg:justify-end order-2"
          >
            <div className="w-full max-w-[465px] liquid-glass-portal rounded-[34px] p-5 sm:p-7 text-white relative">
              {/* Top Specular Edge Reflection */}
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-x-8 top-0 h-[1.5px] bg-gradient-to-r from-transparent via-white/80 to-transparent"
              />

              {/* Panel Header + Floating 3D Red Security Shield Emblem */}
              <div className="flex items-start justify-between gap-3 mb-4">
                <div className="min-w-0">
                  <div className="inline-flex items-center gap-2 pb-1 border-b border-white/25">
                    <span className="w-[3px] h-3 bg-[#FF1739] -skew-x-12 rounded-full" />
                    <p className="text-[10.5px] font-extrabold uppercase tracking-[0.14em] text-white/95">
                      AUTHORIZED PORTAL ACCESS
                    </p>
                  </div>
                  <h2 className="text-[1.85rem] font-extrabold text-white tracking-tight mt-1.5 leading-none">
                    Sign In
                  </h2>
                  <p className="text-xs text-slate-200/90 mt-1.5 leading-relaxed">
                    Securely access Database Security with your authorized credentials.
                  </p>
                </div>

                {/* Floating Red Security Shield over Soft Luminous Rings */}
                <motion.div
                  aria-hidden="true"
                  animate={prefersReducedMotion ? undefined : { y: [-2.5, 2.5, -2.5] }}
                  transition={
                    prefersReducedMotion
                      ? undefined
                      : { duration: 4.2, repeat: Infinity, ease: 'easeInOut' }
                  }
                  className="relative flex flex-col items-center justify-center shrink-0 pt-0.5 pr-1"
                >
                  {/* Shield Silhouette */}
                  <div className="relative z-10 w-16 h-16 flex items-center justify-center drop-shadow-[0_0_18px_rgba(255,23,57,0.85)]">
                    <svg viewBox="0 0 64 72" className="w-16 h-16" fill="none">
                      <defs>
                        <linearGradient id="shieldGlassFill" x1="10" y1="4" x2="54" y2="66" gradientUnits="userSpaceOnUse">
                          <stop offset="0%" stopColor="#FF526D" />
                          <stop offset="45%" stopColor="#FF1739" />
                          <stop offset="100%" stopColor="#9A001B" />
                        </linearGradient>
                      </defs>
                      <path
                        d="M32 3 L58 13 V33 C58 49.5 46.8 63 32 69 C17.2 63 6 49.5 6 33 V13 L32 3 Z"
                        fill="url(#shieldGlassFill)"
                        stroke="#FFE4E8"
                        strokeWidth="2"
                      />
                      <path
                        d="M32 8 L53 16.5 V33 C53 46.5 44 57.5 32 63"
                        stroke="rgba(255,255,255,0.35)"
                        strokeWidth="1.2"
                      />
                    </svg>
                    <Lock className="w-6 h-6 text-white absolute mb-1 drop-shadow-[0_2px_6px_rgba(0,0,0,0.45)]" />
                  </div>
                  {/* Luminous Crimson Ring Pedestal beneath Shield */}
                  <div className="-mt-2 w-20 h-4 rounded-full border border-[#FF1739]/90 bg-[#FF1739]/25 shadow-[0_0_18px_rgba(255,23,57,0.85)] flex items-center justify-center">
                    <div className="w-12 h-1.5 rounded-full border border-white/75" />
                  </div>
                </motion.div>
              </div>

              {/* Account Access Warning Banner */}
              {errorMsg && (
                <div className="mb-3.5 px-3.5 py-2.5 rounded-2xl bg-[#9A001B]/45 backdrop-blur-md border border-[#FF1739]/85 shadow-[0_0_20px_rgba(255,23,57,0.28)] space-y-2 text-xs text-white leading-snug">
                  <div className="flex items-start gap-2.5">
                    <AlertTriangle className="w-4 h-4 text-white shrink-0 mt-0.5" />
                    <span className="flex-1">{errorMsg}</span>
                    <button
                      type="button"
                      onClick={() => {
                        setErrorMsg(null);
                        setPopupBlockedHelp(false);
                      }}
                      className="text-white/70 hover:text-white p-0.5 shrink-0"
                      aria-label="Dismiss alert"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  {popupBlockedHelp && typeof window !== 'undefined' && (
                    <div className="pt-1">
                      <a
                        href={window.location.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white text-[#071329] font-bold hover:bg-slate-100"
                      >
                        Open App in New Tab
                        <ExternalLink className="w-3.5 h-3.5" />
                      </a>
                    </div>
                  )}
                </div>
              )}

              {/* Custom Animated Dark-Glass Select Centre Dropdown (Shared by Google & Email login) */}
              <div ref={dropdownRef} className="relative mb-3">
                <label
                  htmlFor="centre-dropdown-trigger"
                  className="flex items-center gap-1.5 text-xs font-bold text-white mb-1"
                >
                  <Building2 className="w-3.5 h-3.5 text-slate-300" />
                  Select Centre
                </label>
                <button
                  id="centre-dropdown-trigger"
                  type="button"
                  aria-haspopup="listbox"
                  aria-expanded={dropdownOpen}
                  onClick={() => setDropdownOpen((o) => !o)}
                  className="w-full px-3.5 py-2.5 rounded-xl bg-[#0b1630]/65 backdrop-blur-md border border-white/25 hover:border-[#41A9FF]/70 focus:outline-none focus:ring-2 focus:ring-[#41A9FF]/60 focus:border-[#FF1739]/70 text-left flex items-center justify-between gap-2 transition-all shadow-inner"
                >
                  <span className="flex items-center gap-2.5 min-w-0">
                    <Building2 className="w-4 h-4 text-[#FF9C45] shrink-0" />
                    <span className="text-sm font-semibold text-white truncate">
                      {CENTRE_MAP[selectedCentreId].name}
                    </span>
                  </span>
                  <ChevronDown
                    className={`w-4 h-4 text-slate-200 shrink-0 transition-transform duration-200 ${
                      dropdownOpen ? 'rotate-180' : ''
                    }`}
                  />
                </button>

                <AnimatePresence>
                  {dropdownOpen && (
                    <motion.ul
                      role="listbox"
                      initial={prefersReducedMotion ? { opacity: 1 } : { opacity: 0, y: -6, scale: 0.98 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: -6, scale: 0.98 }}
                      transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
                      className="absolute z-40 mt-1.5 w-full rounded-xl bg-[#071329]/95 backdrop-blur-xl border border-[#41A9FF]/45 shadow-[0_16px_38px_rgba(0,0,0,0.65)] py-1.5 overflow-hidden"
                    >
                      {CANONICAL_CENTRES.map((centre) => {
                        const active = centre.id === selectedCentreId;
                        return (
                          <li key={centre.id}>
                            <button
                              type="button"
                              role="option"
                              aria-selected={active}
                              onClick={() => {
                                setSelectedCentreId(centre.id);
                                setDropdownOpen(false);
                              }}
                              className={`w-full px-3.5 py-2 text-left text-xs sm:text-sm flex items-center justify-between gap-2 transition-colors ${
                                active
                                  ? 'bg-[#FF1739]/25 text-white font-bold'
                                  : 'text-slate-200 hover:bg-white/10 font-medium'
                              }`}
                            >
                              <span className="truncate">{centre.name}</span>
                              {active && <Check className="w-4 h-4 text-[#FFC83D] shrink-0" />}
                            </button>
                          </li>
                        );
                      })}
                    </motion.ul>
                  )}
                </AnimatePresence>
              </div>

              {/* When Email/Password is disabled in Firebase Console, promote 1-Click Google Sign-In directly */}
              {emailPasswordEnabled === false && (
                <div className="space-y-3 mb-3">
                  <button
                    type="button"
                    onClick={handleGoogleLogin}
                    disabled={loading}
                    className="group relative overflow-hidden w-full py-3 px-5 btn-crimson-gloss text-white text-sm font-extrabold rounded-full transition-all duration-200 hover:-translate-y-0.5 disabled:opacity-50 inline-flex items-center justify-center gap-2.5 tracking-wide"
                  >
                    <svg className="w-4 h-4 shrink-0 bg-white rounded-full p-0.5" viewBox="0 0 24 24" aria-hidden="true">
                      <path
                        fill="#4285F4"
                        d="M23.745 12.27c0-.7-.06-1.4-.19-2.07H12v4.51h6.6c-.29 1.52-1.14 2.82-2.4 3.68v3.05h3.88c2.27-2.09 3.665-5.17 3.665-9.17Z"
                      />
                      <path
                        fill="#34A853"
                        d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.88-3.05c-1.08.72-2.45 1.16-4.05 1.16-3.12 0-5.77-2.11-6.72-4.96H1.29v3.14C3.26 21.3 7.31 24 12 24Z"
                      />
                      <path
                        fill="#FBBC05"
                        d="M5.28 14.24c-.24-.72-.38-1.49-.38-2.24s.14-1.52.38-2.24V6.62H1.29C.47 8.24 0 10.06 0 12s.47 3.76 1.29 5.38l3.99-3.14Z"
                      />
                      <path
                        fill="#EA4335"
                        d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.99 3.14c.95-2.85 3.6-4.96 6.72-4.96Z"
                      />
                    </svg>
                    <span>{loading ? 'Signing in with Google...' : 'Sign in with Google (Instant Login)'}</span>
                  </button>

                  <div className="p-3.5 rounded-2xl bg-[#0b1630]/80 border border-[#FFC83D]/55 text-xs text-slate-100 space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <p className="font-bold text-[#FFC83D]">Email/Password Login Is Off in Firebase</p>
                      <button
                        type="button"
                        onClick={() => void checkProviderStatus(true)}
                        disabled={checkingProviders}
                        className="inline-flex items-center gap-1 text-[11px] font-bold text-sky-300 hover:text-white disabled:opacity-50"
                      >
                        <RefreshCw className={`w-3 h-3 ${checkingProviders ? 'animate-spin' : ''}`} />
                        {checkingProviders ? 'Checking...' : 'Re-check'}
                      </button>
                    </div>
                    <p className="text-[11px] leading-relaxed text-slate-200">
                      Use <strong>Sign in with Google</strong> above for immediate login. If you also want Email &amp; Password login:
                      open <strong>Firebase Console → Authentication → Sign-in method → Email/Password → Enable → Save</strong>.
                    </p>
                    <div className="flex flex-wrap gap-2 pt-0.5">
                      <a
                        href={`https://console.firebase.google.com/project/${firebaseConfig.projectId}/authentication/providers`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-amber-300/45 bg-amber-900/50 text-white hover:bg-amber-800/60 font-semibold text-[11px]"
                      >
                        Open Firebase Console
                        <ExternalLink className="w-3 h-3" />
                      </a>
                      <button
                        type="button"
                        onClick={() => setShowEmailFormWhenDisabled((v) => !v)}
                        className="px-2.5 py-1.5 rounded-lg border border-white/20 bg-white/10 text-slate-200 hover:bg-white/20 font-semibold text-[11px]"
                      >
                        {showEmailFormWhenDisabled ? 'Hide Email Form' : 'Use Email/Password Anyway'}
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {providerDisabledHelp && emailPasswordEnabled !== false && (
                <div className="mb-3.5 p-3.5 rounded-2xl bg-amber-950/70 border border-[#FFC83D]/70 text-xs text-amber-50 space-y-2">
                  <p className="font-bold text-[#FFC83D]">Email/Password Sign-In Is Disabled in Firebase Console</p>
                  <p className="leading-relaxed text-amber-100/90">
                    Google Sign-In is ready immediately, or enable Email/Password in Firebase Console:
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={handleGoogleLogin}
                      disabled={loading}
                      className="px-3 py-1.5 rounded-lg bg-white text-[#071329] font-bold hover:bg-slate-100"
                    >
                      Sign in with Google Now
                    </button>
                    <a
                      href={`https://console.firebase.google.com/project/${firebaseConfig.projectId}/authentication/providers`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-amber-300/40 bg-amber-900/50 text-white hover:bg-amber-800/60 font-semibold"
                    >
                      Firebase Console
                      <ExternalLink className="w-3.5 h-3.5" />
                    </a>
                  </div>
                </div>
              )}

              {(emailPasswordEnabled !== false || showEmailFormWhenDisabled) && (
                <form onSubmit={handleEmailLogin} className="space-y-3">
                  {/* Email Address Field */}
                  <div>
                    <label htmlFor="login-email" className="flex items-center gap-1.5 text-xs font-bold text-white mb-1">
                      <Mail className="w-3.5 h-3.5 text-slate-300" />
                      Email Address
                    </label>
                    <div className="relative">
                      <Mail className="w-4 h-4 text-slate-300 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                      <input
                        id="login-email"
                        type="email"
                        autoComplete="email"
                        required
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        placeholder="name@visionpoint.edu"
                        className="w-full pl-10 pr-4 py-2.5 text-sm rounded-xl bg-[#0b1630]/65 backdrop-blur-md border border-white/25 text-white placeholder:text-slate-300/75 shadow-inner focus:outline-none focus:ring-2 focus:ring-[#41A9FF]/60 focus:border-[#FF1739]/80 transition-all"
                      />
                    </div>
                  </div>

                  {/* Password Field */}
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label htmlFor="login-password" className="flex items-center gap-1.5 text-xs font-bold text-white">
                        <Lock className="w-3.5 h-3.5 text-slate-300" />
                        Password
                      </label>
                      <button
                        type="button"
                        onClick={() => {
                          setResetEmail(email);
                          setShowResetModal(true);
                        }}
                        className="text-xs font-bold text-[#FFC83D] hover:text-amber-200 hover:underline transition-colors"
                      >
                        Forgot password?
                      </button>
                    </div>
                    <div className="relative">
                      <Lock className="w-4 h-4 text-slate-300 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                      <input
                        id="login-password"
                        type={showPassword ? 'text' : 'password'}
                        autoComplete="current-password"
                        required
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder="Enter your password"
                        className="w-full pl-10 pr-11 py-2.5 text-sm rounded-xl bg-[#0b1630]/65 backdrop-blur-md border border-white/25 text-white placeholder:text-slate-300/75 shadow-inner focus:outline-none focus:ring-2 focus:ring-[#41A9FF]/60 focus:border-[#FF1739]/80 transition-all"
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword((prev) => !prev)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-300 hover:text-white p-1"
                        aria-label={showPassword ? 'Hide password' : 'Show password'}
                      >
                        {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    </div>
                  </div>

                  {/* Primary Glowing Crimson Pill CTA */}
                  <button
                    type="submit"
                    disabled={loading}
                    className="group relative overflow-hidden w-full py-3 px-5 mt-1 btn-crimson-gloss text-white text-sm font-extrabold rounded-full transition-all duration-200 hover:-translate-y-0.5 disabled:opacity-50 inline-flex items-center justify-center gap-2 tracking-wide"
                  >
                    <span
                      aria-hidden="true"
                      className="pointer-events-none absolute inset-0 -translate-x-full group-hover:translate-x-full transition-transform duration-700 bg-gradient-to-r from-transparent via-white/25 to-transparent"
                    />
                    <LogIn className="w-4 h-4 relative z-10" />
                    <span className="relative z-10">
                      {loading ? 'Authenticating Session...' : 'Login to Portal'}
                    </span>
                  </button>
                </form>
              )}

              {emailPasswordEnabled !== false && (
                <>
                  {/* OR Divider */}
                  <div className="my-3.5 flex items-center gap-3">
                    <div className="h-px flex-1 bg-white/30" />
                    <span className="text-[11px] text-white font-bold tracking-widest">OR</span>
                    <div className="h-px flex-1 bg-white/30" />
                  </div>

                  {/* Rounded-Pill Google Sign-In Button */}
                  <button
                    type="button"
                    onClick={handleGoogleLogin}
                    disabled={loading}
                    className="w-full py-2.5 px-5 bg-gradient-to-b from-white to-slate-100 hover:to-white text-[#071329] text-sm font-bold rounded-full border border-white transition-all duration-200 hover:-translate-y-0.5 flex items-center justify-center gap-2.5 disabled:opacity-50 shadow-[0_8px_24px_rgba(0,0,0,0.35)]"
                  >
                    <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" aria-hidden="true">
                      <path
                        fill="#4285F4"
                        d="M23.745 12.27c0-.7-.06-1.4-.19-2.07H12v4.51h6.6c-.29 1.52-1.14 2.82-2.4 3.68v3.05h3.88c2.27-2.09 3.665-5.17 3.665-9.17Z"
                      />
                      <path
                        fill="#34A853"
                        d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.88-3.05c-1.08.72-2.45 1.16-4.05 1.16-3.12 0-5.77-2.11-6.72-4.96H1.29v3.14C3.26 21.3 7.31 24 12 24Z"
                      />
                      <path
                        fill="#FBBC05"
                        d="M5.28 14.24c-.24-.72-.38-1.49-.38-2.24s.14-1.52.38-2.24V6.62H1.29C.47 8.24 0 10.06 0 12s.47 3.76 1.29 5.38l3.99-3.14Z"
                      />
                      <path
                        fill="#EA4335"
                        d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.99 3.14c.95-2.85 3.6-4.96 6.72-4.96Z"
                      />
                    </svg>
                    <span>Sign in with Google</span>
                  </button>
                </>
              )}

              <p className="mt-3 text-[11px] text-center text-slate-200/95 leading-relaxed">
                For Super Admin, Centre Heads, and Staff members: select your assigned branch above and log in directly with{' '}
                {emailPasswordEnabled === false ? (
                  <strong className="text-[#FFC83D]">Sign in with Google</strong>
                ) : (
                  <>
                    <strong className="text-white">Email &amp; Password</strong> or{' '}
                    <strong className="text-[#FFC83D]">Sign in with Google</strong>
                  </>
                )}
                .
              </p>
            </div>
          </motion.section>

          {/* MOBILE & TABLET ONLY (<lg): Centre Cards & Stats ordered directly below Sign-In form */}
          <section className="lg:hidden order-3 space-y-4">
            <div>
              <div className="flex items-center gap-2.5 mb-2.5">
                <Building2 className="w-4 h-4 text-[#FF1739] shrink-0" />
                <h2 className="text-xs font-extrabold uppercase tracking-[0.14em] text-white whitespace-nowrap">
                  AUTHORIZED <span className="text-[#FFC83D]">EDUCATIONAL CENTRES</span>
                </h2>
                <div className="h-[1.5px] flex-1 bg-gradient-to-r from-[#FFC83D]/80 to-transparent" />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                {CANONICAL_CENTRES.map((centre) => {
                  const isSelected = selectedCentreId === centre.id;
                  const theme = CENTRE_STYLES[centre.id];
                  return (
                    <button
                      key={centre.id}
                      type="button"
                      onClick={() => setSelectedCentreId(centre.id)}
                      className={`text-left px-3.5 py-3 rounded-2xl border backdrop-blur-xl transition-all flex items-center justify-between gap-2.5 ${
                        isSelected
                          ? `${theme.bgActive} ${theme.borderActive} ${theme.glowActive}`
                          : `${theme.bgIdle} ${theme.borderIdle} ${theme.glowIdle}`
                      }`}
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div
                          className={`w-9 h-9 rounded-xl border flex items-center justify-center shrink-0 ${theme.iconRing}`}
                        >
                          <GraduationCap className="w-4 h-4" />
                        </div>
                        <div className="min-w-0">
                          <p className="text-xs font-extrabold text-white">{centre.code}</p>
                          <p className="text-[11px] font-medium text-slate-200/95 truncate">{centre.name}</p>
                        </div>
                      </div>
                      <MapPin className="w-4 h-4 shrink-0" style={{ color: isSelected ? '#FFC83D' : '#E2E8F0' }} />
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
              <div className="px-3.5 py-2.5 rounded-2xl bg-[#161036]/75 backdrop-blur-xl border border-[#BD54FF]/70 flex items-center gap-2.5">
                <Building2 className="w-5 h-5 text-[#BD54FF] shrink-0" />
                <div>
                  <p className="text-sm font-extrabold font-mono text-white tabular-nums">04</p>
                  <p className="text-[11px] text-slate-200">Centres</p>
                </div>
              </div>
              <div className="px-3.5 py-2.5 rounded-2xl bg-[#14103a]/75 backdrop-blur-xl border border-[#9E4BFF]/70 flex items-center gap-2.5">
                <Users className="w-5 h-5 text-[#A855F7] shrink-0" />
                <div>
                  <p className="text-sm font-extrabold font-mono text-white tabular-nums">05</p>
                  <p className="text-[11px] text-slate-200">Depts</p>
                </div>
              </div>
              <div className="px-3.5 py-2.5 rounded-2xl bg-[#3a260a]/75 backdrop-blur-xl border border-[#FFC83D]/75 flex items-center gap-2.5">
                <ShieldCheck className="w-5 h-5 text-[#FFC83D] shrink-0" />
                <div>
                  <p className="text-xs font-extrabold text-white">GPS</p>
                  <p className="text-xs font-extrabold text-[#FFC83D]">Verified</p>
                </div>
              </div>
              <div className="px-3.5 py-2.5 rounded-2xl bg-[#0a223a]/75 backdrop-blur-xl border border-[#00D9FF]/70 flex items-center gap-2.5">
                <Layers className="w-5 h-5 text-[#00D9FF] shrink-0" />
                <div>
                  <p className="text-xs font-extrabold text-white">3-Tier</p>
                  <p className="text-xs font-extrabold text-white">RBAC</p>
                </div>
              </div>
            </div>
          </section>
        </main>

        {/* BOTTOM FOOTER BAR */}
        <footer className="w-full pt-3 border-t border-white/15 flex flex-wrap items-center justify-between gap-3 text-xs text-slate-200">
          <div className="flex flex-wrap items-center gap-2.5">
            <div className="w-6 h-6 rounded-md bg-white/10 border border-white/20 flex items-center justify-center shrink-0">
              <Monitor className="w-3.5 h-3.5 text-white" />
            </div>
            <span className="font-medium text-white/95">
              Enterprise Multi-Branch Student Management Platform
            </span>
            <span className="text-[#FFC83D] font-extrabold px-1" aria-hidden="true">
              /
            </span>
            <span className="font-bold text-white">
              Powered by <span className="text-[#FFC83D]">SHUKRA INFOTECH</span>
            </span>
          </div>

          <span className="text-[11px] font-mono text-slate-300/85 hidden sm:inline">
            VP-LKG · VP-CLN · AXIS-VNS · AXIS-JNP
          </span>
        </footer>
      </div>

      {/* Password Reset Modal */}
      {showResetModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#050C1D]/85 backdrop-blur-md p-4">
          <div className="liquid-glass-portal text-white rounded-3xl max-w-md w-full p-6">
            <h3 className="text-lg font-bold text-white">Reset Institutional Password</h3>
            <p className="text-xs text-slate-200/85 mt-1">
              Enter your registered email address to receive a Firebase password reset link.
            </p>
            <form onSubmit={handlePasswordReset} className="mt-4 space-y-4">
              <input
                type="email"
                required
                value={resetEmail}
                onChange={(e) => setResetEmail(e.target.value)}
                placeholder="name@visionpoint.edu"
                className="w-full px-3.5 py-2.5 text-sm bg-[#0b1630]/80 border border-white/25 rounded-xl text-white placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[#41A9FF]"
              />
              <div className="flex justify-end gap-2.5">
                <button
                  type="button"
                  onClick={() => setShowResetModal(false)}
                  className="px-4 py-2 text-xs font-semibold text-white bg-white/10 border border-white/25 rounded-full hover:bg-white/20"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={resetSending}
                  className="px-5 py-2 text-xs font-bold text-white btn-crimson-gloss rounded-full disabled:opacity-50"
                >
                  {resetSending ? 'Sending...' : 'Send Reset Link'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
