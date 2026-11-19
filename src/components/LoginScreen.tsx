import {
  browserLocalPersistence,
  browserSessionPersistence,
  sendPasswordResetEmail,
  setPersistence,
  signInWithEmailAndPassword,
  signOut,
} from 'firebase/auth';
import {
  AlertTriangle,
  Check,
  ExternalLink,
  Eye,
  EyeOff,
  Loader2,
  Lock,
  LogIn,
  Mail,
  RefreshCw,
  ShieldCheck,
  X,
} from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import React, { useEffect, useState } from 'react';
import { CENTRE_MAP, isBootstrappedOwnerEmail } from '../constants/centres';
import { auth } from '../lib/firebase';
import { verifySuperAdminOwnerOnServer } from '../lib/securityClient';
import {
  claimPendingStaffInvite,
  ensureInitialPlatformSetup,
  getUserProfile,
  logActivity,
} from '../services/firestoreService';
import type { CentreId, UserAccount } from '../types/domain';
import { ShukraBackgroundRibbons } from './shukra-login/ShukraBackgroundRibbons';
import { ShukraBrandBadge, ShukraHeroScene } from './shukra-login/ShukraHeroScene';
import { ShukraShieldEmblem } from './shukra-login/ShukraShieldEmblem';

interface LoginScreenProps {
  onAuthenticated: (profile: UserAccount, activeCentre: CentreId) => void;
  onAuthFlowChange?: (inFlight: boolean) => void;
  onNotify: (title: string, description: string, variant: 'success' | 'error' | 'warning' | 'info') => void;
  externalError?: string | null;
}

const DEFAULT_ACCESS_NOTICE =
  'Access denied: Your account has not been provisioned yet. Ask your Super Admin or Centre Head to add your email first.';

const REMEMBER_EMAIL_STORAGE_KEY = 'shukra_security_remembered_email';
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export const LoginScreen: React.FC<LoginScreenProps> = ({
  onAuthenticated,
  onAuthFlowChange,
  onNotify,
  externalError,
}) => {
  const prefersReducedMotion = useReducedMotion();

  const [email, setEmail] = useState<string>(() => {
    try {
      return window.localStorage.getItem(REMEMBER_EMAIL_STORAGE_KEY) || '';
    } catch {
      return '';
    }
  });
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(true);
  const [showPassword, setShowPassword] = useState(false);
  const [emailTouched, setEmailTouched] = useState(false);
  const [passwordTouched, setPasswordTouched] = useState(false);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(externalError || null);

  const [showResetModal, setShowResetModal] = useState(false);
  const [resetEmail, setResetEmail] = useState('');
  const [resetSending, setResetSending] = useState(false);

  const [providerStatus, setProviderStatus] = useState<{
    checked: boolean;
    emailPasswordEnabled: boolean;
    projectId: string;
  }>({
    checked: false,
    emailPasswordEnabled: true,
    projectId: 'database-security-32018',
  });
  const [checkingProvider, setCheckingProvider] = useState(false);

  const emailTrimmed = email.trim();
  const emailValidationError =
    emailTouched && emailTrimmed.length > 0 && !EMAIL_PATTERN.test(emailTrimmed)
      ? 'Please enter a valid email address.'
      : null;
  const passwordValidationError =
    passwordTouched && password.length > 0 && password.length < 6
      ? 'Password must be at least 6 characters.'
      : null;

  const checkProviderStatus = async () => {
    setCheckingProvider(true);
    try {
      const res = await fetch('/api/auth/provider-status');
      if (res.ok) {
        const data = (await res.json()) as {
          emailPasswordEnabled?: boolean;
          projectId?: string;
        };
        setProviderStatus({
          checked: true,
          emailPasswordEnabled: data.emailPasswordEnabled !== false,
          projectId: data.projectId || 'database-security-32018',
        });
        if (data.emailPasswordEnabled !== false) {
          setErrorMsg(null);
        }
      }
    } catch {
      // Keep default state on network hiccup
    } finally {
      setCheckingProvider(false);
    }
  };

  useEffect(() => {
    void checkProviderStatus();
  }, []);

  useEffect(() => {
    if (externalError) {
      setErrorMsg(externalError);
    }
  }, [externalError]);

  const resolveAuthorizedProfile = async (uid: string, authEmail: string) => {
    let profile = await getUserProfile(uid);

    if (
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

    if (!profile) {
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

    const resolvedCentre: CentreId =
      profile.centreId && CENTRE_MAP[profile.centreId] ? profile.centreId : 'vp_lookerganj';

    await logActivity({
      actorUid: profile.uid,
      actorName: profile.fullName,
      actorEmail: profile.email,
      actorRole: profile.role,
      centreId: resolvedCentre,
      department: profile.department,
      action: 'LOGIN_SUCCESS',
      targetCollection: 'users',
      targetId: profile.uid,
      details: `Authenticated into ${CENTRE_MAP[resolvedCentre].name} as ${profile.role}.`,
      locationVerified: true,
    }).catch(() => {});

    onAuthenticated(profile, resolvedCentre);
  };

  const handleEmailLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setEmailTouched(true);
    setPasswordTouched(true);

    if (!emailTrimmed || !password) {
      setErrorMsg('Please enter both Email Address and Password.');
      return;
    }

    if (!EMAIL_PATTERN.test(emailTrimmed)) {
      setErrorMsg('Please enter a valid Email Address.');
      return;
    }

    if (password.length < 6) {
      setErrorMsg('Password must be at least 6 characters.');
      return;
    }

    setLoading(true);
    onAuthFlowChange?.(true);
    try {
      try {
        if (rememberMe) {
          window.localStorage.setItem(REMEMBER_EMAIL_STORAGE_KEY, emailTrimmed);
        } else {
          window.localStorage.removeItem(REMEMBER_EMAIL_STORAGE_KEY);
        }
      } catch {
        // Ignore storage restrictions in private browsing
      }

      await setPersistence(
        auth,
        rememberMe ? browserLocalPersistence : browserSessionPersistence,
      ).catch(() => {});

      const prepRes = await fetch('/api/auth/prepare-super-admin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: emailTrimmed, password }),
      }).catch(() => null);

      if (prepRes && (prepRes.headers.get('content-type') || '').toLowerCase().includes('application/json')) {
        const prepData = (await prepRes.json().catch(() => ({}))) as {
          ready?: boolean;
          providerDisabled?: boolean;
          projectId?: string;
        };
        if (prepData.providerDisabled) {
          setProviderStatus({
            checked: true,
            emailPasswordEnabled: false,
            projectId: prepData.projectId || providerStatus.projectId,
          });
          setErrorMsg(
            'Email/Password Sign-In Firebase Console mein abhi OFF hai. Upar diye Firebase Console link par jaakar Email/Password ko Enable karein, fir Login karein.',
          );
          return;
        }
      }

      const cred = await signInWithEmailAndPassword(auth, emailTrimmed, password);
      await resolveAuthorizedProfile(cred.user.uid, cred.user.email || emailTrimmed);
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code || '';
      if (code === 'auth/operation-not-allowed') {
        setProviderStatus((prev) => ({ ...prev, checked: true, emailPasswordEnabled: false }));
        setErrorMsg(
          'Email/Password Sign-In Firebase Console mein abhi OFF hai. Upar diye Firebase Console link par jaakar Email/Password ko Enable karein, fir Login karein.',
        );
      } else if (
        code === 'auth/invalid-credential' ||
        code === 'auth/wrong-password' ||
        code === 'auth/user-not-found'
      ) {
        setErrorMsg(
          "Invalid email address or password. (If your account has no password set yet, click 'Forgot Password?' below.)",
        );
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

  return (
    <div className="relative min-h-screen w-full overflow-x-hidden flex flex-col justify-center bg-white text-[#171717]">
      {/* Layer 1: Bright White & Soft Blush-Pink Flowing Crimson Ribbon Backdrop */}
      <ShukraBackgroundRibbons />

      {/* Layer 2 (Desktop 55% Left): Cinematic SHUKRA SECURITY Building + Original Portrait + HUD */}
      <ShukraHeroScene />

      {/* Top-Left Brand Pill Badge (Positioned exactly matching reference on desktop & centered/top on mobile) */}
      <header className="relative lg:fixed top-0 left-0 z-30 w-full lg:w-auto px-5 pt-5 sm:px-8 sm:pt-6 lg:px-0 lg:pt-0 lg:left-[3.5%] lg:top-[3.1%] flex justify-center lg:justify-start">
        <ShukraBrandBadge />
      </header>

      {/* Main Responsive Split Container: 55% Left Visual Stage | 45% Right Glassmorphism Login Panel */}
      <main className="relative z-20 w-full max-w-[1600px] mx-auto flex-1 flex items-center px-4 sm:px-8 lg:px-12 xl:px-16 py-6 sm:py-8">
        <div className="w-full grid grid-cols-1 lg:grid-cols-12 items-center gap-6">
          {/* Left 55% Spacer over the fixed cinematic portrait & SHUKRA SECURITY building */}
          <div className="hidden lg:block lg:col-span-6 xl:col-span-7" aria-hidden="true" />

          {/* Right 45% Floating Frosted-Glass SHUKRA SECURITY Login Card */}
          <div className="lg:col-span-6 xl:col-span-5 flex justify-center lg:justify-end">
            <motion.section
              aria-label="Shukra Security Secure Access Portal Login"
              initial={prefersReducedMotion ? { opacity: 1 } : { opacity: 0, y: 18, scale: 0.985 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={
                prefersReducedMotion
                  ? undefined
                  : { duration: 0.55, ease: [0.16, 1, 0.3, 1] }
              }
              className="relative w-full max-w-[468px] shukra-glass-card rounded-[32px] overflow-hidden px-6 py-7 sm:px-9 sm:py-9"
            >
              {/* Decorative Curved Crimson Corner Accents (Exact Reference Styling) */}
              <svg
                aria-hidden="true"
                viewBox="0 0 180 180"
                fill="none"
                className="pointer-events-none absolute -top-1 -right-1 w-32 h-32 sm:w-36 sm:h-36"
              >
                <defs>
                  <linearGradient id="cardTopRightArc" x1="15%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stopColor="#EF001B" />
                    <stop offset="55%" stopColor="#C8102E" />
                    <stop offset="100%" stopColor="#850012" />
                  </linearGradient>
                </defs>
                <path
                  d="M28 0 H180 V152 C142 104 94 52 28 0 Z"
                  fill="url(#cardTopRightArc)"
                  opacity="0.94"
                />
                <path
                  d="M72 0 H180 V106 C150 72 114 34 72 0 Z"
                  fill="#FFFFFF"
                  opacity="0.14"
                />
              </svg>

              <svg
                aria-hidden="true"
                viewBox="0 0 150 150"
                fill="none"
                className="pointer-events-none absolute -bottom-1 -left-1 w-24 h-24 sm:w-28 sm:h-28"
              >
                <defs>
                  <linearGradient id="cardBottomLeftArc" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stopColor="#EF001B" />
                    <stop offset="100%" stopColor="#9B0015" />
                  </linearGradient>
                </defs>
                <path
                  d="M0 32 C34 76 74 116 122 150 H0 V32 Z"
                  fill="url(#cardBottomLeftArc)"
                  opacity="0.92"
                />
              </svg>

              {/* Soft Top Specular Glass Reflection */}
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-x-10 top-0 h-[2px] bg-gradient-to-r from-transparent via-white to-transparent opacity-90"
              />

              {/* CARD HEADER: Shield Emblem + SHUKRA SECURITY Branding + Sub-Header */}
              <div className="relative z-10 flex flex-col items-center text-center">
                <ShukraShieldEmblem className="w-[68px] h-[74px] sm:w-[76px] sm:h-[82px]" />

                <h1 className="mt-2 font-display text-[2.15rem] sm:text-[2.55rem] font-black uppercase tracking-[0.03em] text-[#0E1118] leading-[0.95]">
                  SHUKRA
                </h1>

                <div className="mt-1.5 inline-block px-6 sm:px-8 py-1.5 rounded-[12px] shukra-security-banner -skew-x-12">
                  <span className="block skew-x-12 font-display italic text-[1.75rem] sm:text-[2.05rem] font-extrabold uppercase tracking-[0.03em] text-white leading-none drop-shadow-[0_2px_6px_rgba(0,0,0,0.28)]">
                    SECURITY
                  </span>
                </div>

                {/* SECURE ACCESS PORTAL with subtle crimson decorative dividers */}
                <div className="mt-4 w-full flex items-center justify-center gap-3">
                  <span className="h-[1.5px] flex-1 max-w-[44px] bg-gradient-to-r from-transparent to-[#C8102E]/75 rounded-full" />
                  <p className="text-[11px] sm:text-[12px] font-bold uppercase tracking-[0.22em] text-[#171717] whitespace-nowrap">
                    SECURE ACCESS PORTAL
                  </p>
                  <span className="h-[1.5px] flex-1 max-w-[44px] bg-gradient-to-l from-transparent to-[#C8102E]/75 rounded-full" />
                </div>
              </div>

              {/* One-Time Firebase Email/Password Enable Notice (Only shown if disabled in console) */}
              {providerStatus.checked && !providerStatus.emailPasswordEnabled && (
                <div className="relative z-10 mt-4 px-3.5 py-3 rounded-2xl bg-amber-50 border border-amber-300 text-xs text-amber-950 leading-snug">
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
                    <div className="flex-1 min-w-0">
                      <p className="font-bold text-amber-950">Enable Email/Password in Firebase Console</p>
                      <p className="mt-1 text-amber-900 break-words">
                        Project <span className="font-mono font-semibold">{providerStatus.projectId}</span> mein
                        Email/Password OFF hai. Console mein <strong>Enable → Save</strong> karein.
                      </p>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <a
                          href={`https://console.firebase.google.com/project/${providerStatus.projectId}/authentication/providers`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-amber-700 hover:bg-amber-800 text-white font-bold text-[11px]"
                        >
                          Open Console
                          <ExternalLink className="w-3 h-3" />
                        </a>
                        <button
                          type="button"
                          onClick={() => void checkProviderStatus()}
                          disabled={checkingProvider}
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-white border border-amber-300 text-amber-950 font-bold text-[11px] disabled:opacity-60"
                        >
                          <RefreshCw className={`w-3 h-3 ${checkingProvider ? 'animate-spin' : ''}`} />
                          {checkingProvider ? 'Checking...' : 'Check Status'}
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Animated Error Alert */}
              <AnimatePresence>
                {errorMsg && (
                  <motion.div
                    initial={prefersReducedMotion ? { opacity: 1 } : { opacity: 0, y: -6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: -6 }}
                    role="alert"
                    className="relative z-10 mt-4 px-3.5 py-2.5 rounded-xl bg-[#FFF0F3] border border-[#C8102E]/45 shadow-sm flex items-start gap-2.5 text-xs text-[#9B0015] leading-snug"
                  >
                    <AlertTriangle className="w-4 h-4 text-[#C8102E] shrink-0 mt-0.5" />
                    <span className="flex-1 min-w-0 font-medium break-words">{errorMsg}</span>
                    <button
                      type="button"
                      onClick={() => setErrorMsg(null)}
                      className="text-[#9B0015]/70 hover:text-[#9B0015] p-0.5 shrink-0"
                      aria-label="Dismiss alert"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* LOGIN FORM */}
              <form onSubmit={handleEmailLogin} noValidate className="relative z-10 mt-6 space-y-4">
                {/* EMAIL ADDRESS INPUT */}
                <div>
                  <label htmlFor="login-email" className="sr-only">
                    Email Address
                  </label>
                  <div className="relative group">
                    <Mail
                      className="z-10 w-[19px] h-[19px] text-[#171717] group-focus-within:text-[#C8102E] transition-colors absolute left-4 top-1/2 -translate-y-1/2 pointer-events-none"
                      aria-hidden="true"
                    />
                    <input
                      id="login-email"
                      type="email"
                      autoComplete="email"
                      required
                      value={email}
                      onChange={(e) => {
                        setEmail(e.target.value);
                        if (errorMsg) setErrorMsg(null);
                      }}
                      onBlur={() => setEmailTouched(true)}
                      placeholder="Email Address"
                      aria-invalid={Boolean(emailValidationError)}
                      className={`w-full pl-12 pr-4 py-3.5 text-[15px] font-medium rounded-xl bg-white/95 text-[#171717] placeholder:text-slate-500 border shadow-[0_6px_18px_-8px_rgba(15,23,42,0.14)] transition-all duration-200 focus:outline-none focus:bg-white ${
                        emailValidationError
                          ? 'border-[#EF001B] ring-4 ring-[#EF001B]/15'
                          : 'border-slate-300/95 hover:border-slate-400 focus:border-[#C8102E] focus:ring-4 focus:ring-[#C8102E]/15'
                      }`}
                    />
                  </div>
                  <AnimatePresence>
                    {emailValidationError && (
                      <motion.p
                        initial={prefersReducedMotion ? { opacity: 1 } : { opacity: 0, y: -4 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: -4 }}
                        className="mt-1.5 pl-1 text-xs font-semibold text-[#C8102E]"
                      >
                        {emailValidationError}
                      </motion.p>
                    )}
                  </AnimatePresence>
                </div>

                {/* PASSWORD INPUT */}
                <div>
                  <label htmlFor="login-password" className="sr-only">
                    Password
                  </label>
                  <div className="relative group">
                    <Lock
                      className="z-10 w-[19px] h-[19px] text-[#171717] group-focus-within:text-[#C8102E] transition-colors absolute left-4 top-1/2 -translate-y-1/2 pointer-events-none"
                      aria-hidden="true"
                    />
                    <input
                      id="login-password"
                      type={showPassword ? 'text' : 'password'}
                      autoComplete="current-password"
                      required
                      value={password}
                      onChange={(e) => {
                        setPassword(e.target.value);
                        if (errorMsg) setErrorMsg(null);
                      }}
                      onBlur={() => setPasswordTouched(true)}
                      placeholder="Password"
                      aria-invalid={Boolean(passwordValidationError)}
                      className={`w-full pl-12 pr-12 py-3.5 text-[15px] font-medium rounded-xl bg-white/95 text-[#171717] placeholder:text-slate-500 border shadow-[0_6px_18px_-8px_rgba(15,23,42,0.14)] transition-all duration-200 focus:outline-none focus:bg-white ${
                        passwordValidationError
                          ? 'border-[#EF001B] ring-4 ring-[#EF001B]/15'
                          : 'border-slate-300/95 hover:border-slate-400 focus:border-[#C8102E] focus:ring-4 focus:ring-[#C8102E]/15'
                      }`}
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((prev) => !prev)}
                      className="z-10 absolute right-3.5 top-1/2 -translate-y-1/2 p-1.5 rounded-lg text-[#171717] hover:text-[#C8102E] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#C8102E] transition-colors"
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                    >
                      {showPassword ? <EyeOff className="w-[19px] h-[19px]" /> : <Eye className="w-[19px] h-[19px]" />}
                    </button>
                  </div>
                  <AnimatePresence>
                    {passwordValidationError && (
                      <motion.p
                        initial={prefersReducedMotion ? { opacity: 1 } : { opacity: 0, y: -4 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: -4 }}
                        className="mt-1.5 pl-1 text-xs font-semibold text-[#C8102E]"
                      >
                        {passwordValidationError}
                      </motion.p>
                    )}
                  </AnimatePresence>
                </div>

                {/* REMEMBER ME & FORGOT PASSWORD ROW */}
                <div className="flex items-center justify-between gap-3 pt-0.5 px-0.5">
                  <label className="inline-flex items-center gap-2.5 cursor-pointer select-none group">
                    <span className="relative inline-flex items-center justify-center">
                      <input
                        type="checkbox"
                        checked={rememberMe}
                        onChange={(e) => setRememberMe(e.target.checked)}
                        className="peer sr-only"
                      />
                      <span
                        className={`w-[18px] h-[18px] rounded-[5px] border flex items-center justify-center transition-all peer-focus-visible:ring-2 peer-focus-visible:ring-[#C8102E] peer-focus-visible:ring-offset-1 ${
                          rememberMe
                            ? 'bg-[#C8102E] border-[#C8102E] shadow-[0_3px_10px_rgba(200,16,46,0.38)]'
                            : 'bg-white border-slate-400 group-hover:border-[#C8102E]'
                        }`}
                      >
                        {rememberMe && <Check className="w-3.5 h-3.5 text-white stroke-[3]" />}
                      </span>
                    </span>
                    <span className="text-[13px] font-semibold text-[#171717]">Remember Me</span>
                  </label>

                  <button
                    type="button"
                    onClick={() => {
                      setResetEmail(emailTrimmed);
                      setShowResetModal(true);
                    }}
                    className="text-[13px] font-semibold text-[#C8102E] hover:text-[#9B0015] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#C8102E] rounded px-1 py-0.5 transition-colors whitespace-nowrap"
                  >
                    Forgot Password?
                  </button>
                </div>

                {/* PREMIUM FULL-WIDTH CRIMSON LOGIN BUTTON */}
                <div className="pt-1.5">
                  <button
                    type="submit"
                    disabled={loading}
                    className="group relative overflow-hidden w-full py-3.5 sm:py-4 px-6 shukra-cta-btn text-white text-[16px] font-bold rounded-full transition-all duration-200 hover:-translate-y-0.5 active:scale-[0.985] disabled:opacity-65 disabled:cursor-not-allowed disabled:hover:translate-y-0 inline-flex items-center justify-center gap-2.5 tracking-wide focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[#EF001B]/35"
                  >
                    <span
                      aria-hidden="true"
                      className="pointer-events-none absolute inset-0 -translate-x-full group-hover:translate-x-full transition-transform duration-700 bg-gradient-to-r from-transparent via-white/30 to-transparent"
                    />
                    {loading ? (
                      <>
                        <Loader2 className="w-5 h-5 animate-spin relative z-10" />
                        <span className="relative z-10">Authenticating...</span>
                      </>
                    ) : (
                      <>
                        <LogIn className="w-5 h-5 relative z-10 stroke-[2.4]" />
                        <span className="relative z-10">Login to Portal</span>
                      </>
                    )}
                  </button>
                </div>
              </form>

              {/* SECURITY FOOTER */}
              <div className="relative z-10 mt-6 pt-1 flex items-center justify-center gap-2.5">
                <ShieldCheck className="w-7 h-7 text-[#C8102E] shrink-0 stroke-[2.2]" aria-hidden="true" />
                <div className="text-left leading-[1.2]">
                  <p className="text-[12.5px] font-semibold text-[#171717]">Protected by Enterprise</p>
                  <p className="text-[14.5px] font-extrabold text-[#C8102E]">Shukra Security</p>
                </div>
              </div>
            </motion.section>
          </div>
        </div>
      </main>

      {/* FORGOT PASSWORD MODAL (Light Glass Crimson Theme) */}
      <AnimatePresence>
        {showResetModal && (
          <motion.div
            initial={prefersReducedMotion ? { opacity: 1 } : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-[#171717]/45 backdrop-blur-sm p-4"
            role="dialog"
            aria-modal="true"
            aria-labelledby="reset-password-title"
          >
            <motion.div
              initial={prefersReducedMotion ? { opacity: 1 } : { opacity: 0, scale: 0.96, y: 8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: 8 }}
              className="w-full max-w-md bg-white rounded-[24px] border border-[#C8102E]/35 shadow-[0_24px_60px_-14px_rgba(200,16,46,0.28)] p-6 text-[#171717]"
            >
              <div className="flex items-start justify-between gap-3 pb-3 border-b border-rose-100">
                <div>
                  <h3 id="reset-password-title" className="text-lg font-extrabold text-[#171717]">
                    Reset Portal Password
                  </h3>
                  <p className="text-xs text-slate-600 mt-0.5">
                    Enter your registered email address to receive a password reset link.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setShowResetModal(false)}
                  aria-label="Close reset password modal"
                  className="p-1.5 rounded-lg text-slate-500 hover:text-[#C8102E] hover:bg-rose-50 transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <form onSubmit={handlePasswordReset} className="mt-4 space-y-4">
                <div>
                  <label htmlFor="reset-email-input" className="block text-xs font-bold text-[#171717] mb-1.5">
                    Authorized Email Address
                  </label>
                  <div className="relative">
                    <Mail className="w-4 h-4 text-slate-500 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                    <input
                      id="reset-email-input"
                      type="email"
                      required
                      value={resetEmail}
                      onChange={(e) => setResetEmail(e.target.value)}
                      placeholder="name@domain.com"
                      className="w-full pl-10 pr-4 py-3 text-sm rounded-xl bg-[#F5F5F7] border border-slate-300 text-[#171717] focus:outline-none focus:bg-white focus:border-[#C8102E] focus:ring-4 focus:ring-[#C8102E]/15 transition-all"
                    />
                  </div>
                </div>

                <div className="flex items-center justify-end gap-2.5 pt-2">
                  <button
                    type="button"
                    onClick={() => setShowResetModal(false)}
                    className="px-4 py-2.5 text-xs font-bold text-slate-700 bg-[#F5F5F7] hover:bg-slate-200 rounded-xl transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={resetSending}
                    className="inline-flex items-center gap-2 px-5 py-2.5 text-xs font-bold text-white shukra-cta-btn rounded-xl disabled:opacity-60 transition-all"
                  >
                    {resetSending && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                    {resetSending ? 'Sending...' : 'Send Reset Link'}
                  </button>
                </div>
              </form>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};
