import { AlertTriangle, Eye, EyeOff, Lock, Play, RotateCcw, ShieldAlert, Volume2, X } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import {
  DELETE_WARNING_MESSAGE,
  playDeleteWarningVoice,
  stopDeleteWarningVoice,
  verifyDeletePassword,
} from '../lib/deleteSecurity';
import { SIR_PORTRAIT_PATH } from '../lib/voiceWelcome';

interface DeleteProtectionModalProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel?: string;
  busy?: boolean;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}

export const DeleteProtectionModal: React.FC<DeleteProtectionModalProps> = ({
  open,
  title,
  description,
  confirmLabel = 'Verify & Delete',
  busy = false,
  onConfirm,
  onCancel,
}) => {
  const [passwordInput, setPasswordInput] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [passwordError, setPasswordError] = useState('');
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [autoplayBlocked, setAutoplayBlocked] = useState(false);
  const [voiceProgress, setVoiceProgress] = useState(0);

  const startVoicePlayback = (forceRestart = false) => {
    setAutoplayBlocked(false);
    if (forceRestart) setVoiceProgress(0);
    playDeleteWarningVoice(
      {
        onPlayStart: () => {
          setIsSpeaking(true);
          setAutoplayBlocked(false);
        },
        onProgress: (pct) => setVoiceProgress(pct),
        onEnded: () => {
          setIsSpeaking(false);
          setVoiceProgress(100);
        },
        onAutoplayBlocked: () => {
          setIsSpeaking(false);
          setAutoplayBlocked(true);
        },
      },
      { forceRestart },
    );
  };

  useEffect(() => {
    if (!open) {
      stopDeleteWarningVoice();
      setPasswordInput('');
      setShowPassword(false);
      setPasswordError('');
      setIsSpeaking(false);
      setAutoplayBlocked(false);
      setVoiceProgress(0);
      return;
    }

    setPasswordInput('');
    setPasswordError('');
    setShowPassword(false);
    startVoicePlayback(false);

    return () => {
      stopDeleteWarningVoice();
    };
  }, [open]);

  if (!open) return null;

  const handleClose = () => {
    if (busy) return;
    stopDeleteWarningVoice();
    onCancel();
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!verifyDeletePassword(passwordInput)) {
      setPasswordError('Galat password! Delete karne ke liye sahi security password (177177) daalein.');
      return;
    }
    setPasswordError('');
    stopDeleteWarningVoice();
    onConfirm();
  };

  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-[#040816]/85 backdrop-blur-md p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-protection-title"
    >
      <div className="bg-white rounded-2xl border-2 border-red-600/80 shadow-[0_24px_80px_rgba(185,28,28,0.45)] max-w-md w-full overflow-hidden text-slate-900">
        {/* Dramatic Voice Popup Banner */}
        <div className="bg-gradient-to-r from-[#0B1224] via-[#1B0F1A] to-[#450A0A] px-5 py-4 text-white border-b border-red-500/40">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="relative shrink-0">
                <div
                  className={`w-14 h-14 rounded-full p-0.5 bg-gradient-to-br from-[#FFC83D] via-[#FF1739] to-[#7F1D1D] ${
                    isSpeaking ? 'ring-4 ring-red-500/45 animate-pulse' : ''
                  }`}
                >
                  <img
                    src={SIR_PORTRAIT_PATH}
                    alt="Ashish Pandey Sir"
                    className="w-full h-full rounded-full object-cover object-top bg-white"
                  />
                </div>
                <span
                  className={`absolute -bottom-1 -right-1 w-5 h-5 rounded-full flex items-center justify-center border border-white/40 ${
                    isSpeaking ? 'bg-red-600 text-white' : 'bg-slate-900 text-amber-300'
                  }`}
                >
                  <Volume2 className="w-3 h-3" />
                </span>
              </div>
              <div>
                <div className="flex items-center gap-1.5">
                  <ShieldAlert className="w-4 h-4 text-[#FFC83D]" />
                  <span className="text-[11px] font-extrabold uppercase tracking-wider text-[#FFC83D]">
                    Ashish Pandey · Security Alert
                  </span>
                </div>
                <p className="mt-1 text-sm font-bold leading-snug text-white">
                  &ldquo;{DELETE_WARNING_MESSAGE}&rdquo;
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={handleClose}
              disabled={busy}
              className="text-rose-200 hover:text-white p-1 rounded-md shrink-0 disabled:opacity-40"
              aria-label="Close delete security popup"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="mt-3 flex items-center justify-between gap-3">
            <div className="flex-1 h-1.5 rounded-full bg-white/15 overflow-hidden">
              <div
                className="h-full rounded-full bg-gradient-to-r from-[#FF1739] via-[#FFC83D] to-emerald-400 transition-all duration-150"
                style={{ width: `${Math.max(isSpeaking ? 8 : 0, voiceProgress)}%` }}
              />
            </div>
            <button
              type="button"
              onClick={() => startVoicePlayback(true)}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-white/15 hover:bg-white/25 text-[11px] font-bold text-[#FFC83D] border border-white/20 shrink-0"
            >
              {autoplayBlocked ? (
                <>
                  <Play className="w-3 h-3 fill-current" />
                  Play Voice
                </>
              ) : (
                <>
                  <RotateCcw className="w-3 h-3" />
                  {isSpeaking ? 'Playing...' : 'Replay Voice'}
                </>
              )}
            </button>
          </div>
        </div>

        {/* Deletion Target + Password Form */}
        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <div className="flex items-start gap-2.5 p-3 rounded-xl bg-red-50 border border-red-200">
            <AlertTriangle className="w-5 h-5 text-red-700 shrink-0 mt-0.5" />
            <div className="min-w-0">
              <h3 id="delete-protection-title" className="text-sm font-extrabold text-red-950">
                {title}
              </h3>
              <p className="text-xs text-red-900 mt-1 leading-relaxed">{description}</p>
            </div>
          </div>

          <div>
            <label
              htmlFor="delete-security-password-input"
              className="block text-xs font-extrabold text-[#08152E] mb-1.5"
            >
              Delete Security Password Daalein *
            </label>
            <div className="relative">
              <Lock className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                id="delete-security-password-input"
                autoFocus
                type={showPassword ? 'text' : 'password'}
                inputMode="numeric"
                autoComplete="off"
                disabled={busy}
                value={passwordInput}
                onChange={(e) => {
                  setPasswordInput(e.target.value);
                  if (passwordError) setPasswordError('');
                }}
                placeholder="Enter security password..."
                className={`w-full pl-9 pr-10 py-2.5 text-sm font-mono font-bold tracking-widest bg-white text-[#08152E] placeholder:text-slate-400 placeholder:tracking-normal placeholder:font-sans border rounded-xl focus:outline-none focus:ring-2 ${
                  passwordError
                    ? 'border-red-500 focus:ring-red-500 bg-red-50/40'
                    : 'border-slate-300 focus:ring-red-700'
                }`}
              />
              <button
                type="button"
                tabIndex={-1}
                onClick={() => setShowPassword((v) => !v)}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-800 p-1"
                aria-label={showPassword ? 'Hide password' : 'Show password'}
              >
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
            {passwordError && (
              <p role="alert" className="mt-1.5 text-xs font-bold text-red-700">
                {passwordError}
              </p>
            )}
          </div>

          <div className="pt-1 flex items-center justify-end gap-2.5">
            <button
              type="button"
              onClick={handleClose}
              disabled={busy}
              className="px-4 py-2 text-xs font-bold text-slate-800 bg-slate-100 hover:bg-slate-200 border border-slate-300 rounded-xl transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy}
              className="px-4 py-2 text-xs font-extrabold text-white bg-red-700 hover:bg-red-800 rounded-xl shadow-sm transition-colors disabled:opacity-50"
            >
              {busy ? 'Deleting...' : confirmLabel}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
