import { ArrowRight, Play, Volume2 } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import React, { useEffect, useState } from 'react';
import { SIR_PORTRAIT_PATH } from '../lib/voiceWelcome';

interface SirWelcomeOverlayProps {
  visible: boolean;
  isSpeaking: boolean;
  audioCompleted: boolean;
  autoplayBlocked: boolean;
  progress: number;
  onPlayNow: () => void;
  onDismiss: () => void;
}

export const SirWelcomeOverlay: React.FC<SirWelcomeOverlayProps> = ({
  visible,
  isSpeaking,
  audioCompleted,
  autoplayBlocked,
  progress,
  onPlayNow,
  onDismiss,
}) => {
  const [pulseTick, setPulseTick] = useState(0);

  useEffect(() => {
    if (!visible || !isSpeaking) return;
    const interval = setInterval(() => {
      setPulseTick((t) => (t + 1) % 4);
    }, 220);
    return () => clearInterval(interval);
  }, [visible, isSpeaking]);

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.25 }}
          className="fixed inset-0 z-[80] flex items-center justify-center bg-[#040816]/92 backdrop-blur-lg p-4 select-none"
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.9, y: 18 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.94, y: 10 }}
            transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
            className="relative w-full max-w-md rounded-3xl bg-gradient-to-b from-[#161024] via-[#101327] to-[#090d1b] border border-[#FF1739]/60 shadow-[0_28px_90px_rgba(255,23,57,0.42)] text-white overflow-hidden px-6 py-8 sm:px-8 sm:py-9"
          >
            {/* Top specular sheen */}
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-10 top-0 h-[1.5px] bg-gradient-to-r from-transparent via-[#FFC83D]/85 to-transparent"
            />

            <div className="flex flex-col items-center text-center">
              {/* Large Prominent Portrait of Ashish Pandey Sir (cropped cleanly above watermark) */}
              <div className="relative flex items-center justify-center mb-6">
                {isSpeaking && (
                  <>
                    <motion.div
                      aria-hidden="true"
                      animate={{ scale: [1, 1.12, 1], opacity: [0.7, 0.15, 0.7] }}
                      transition={{ duration: 1.3, repeat: Infinity, ease: 'easeInOut' }}
                      className="absolute -inset-3 rounded-full border-2 border-[#FF1739]"
                    />
                    <motion.div
                      aria-hidden="true"
                      animate={{ scale: [1, 1.2, 1], opacity: [0.4, 0.05, 0.4] }}
                      transition={{ duration: 1.8, repeat: Infinity, ease: 'easeInOut' }}
                      className="absolute -inset-5 rounded-full border border-[#FFC83D]/70"
                    />
                  </>
                )}
                <div className="relative w-56 h-56 sm:w-64 sm:h-64 rounded-full p-1.5 bg-gradient-to-br from-[#FFC83D] via-[#FF1739] to-[#7F1D1D] shadow-[0_0_48px_rgba(255,23,57,0.55)]">
                  <div className="w-full h-full rounded-full overflow-hidden bg-[#0b1326]">
                    <img
                      src={SIR_PORTRAIT_PATH}
                      alt="Ashish Pandey Sir"
                      className="w-full h-full object-cover object-[50%_18%] scale-[1.15]"
                    />
                  </div>
                </div>

                {/* Equalizer Indicator Badge */}
                <div className="absolute -bottom-3 px-4 py-1.5 rounded-full bg-[#090d1b] border border-[#FFC83D]/80 shadow-lg flex items-center gap-2">
                  <Volume2 className={`w-4 h-4 ${isSpeaking ? 'text-[#FFC83D]' : 'text-slate-400'}`} />
                  <div className="flex items-end gap-1 h-3.5">
                    {[0, 1, 2, 3].map((idx) => (
                      <span
                        key={idx}
                        className={`w-1 rounded-full transition-all duration-150 ${
                          isSpeaking
                            ? idx === pulseTick || (idx + 1) % 4 === pulseTick
                              ? 'h-3.5 bg-[#FF1739]'
                              : 'h-2 bg-[#FFC83D]'
                            : audioCompleted
                              ? 'h-2.5 bg-emerald-400'
                              : 'h-1 bg-slate-500'
                        }`}
                      />
                    ))}
                  </div>
                </div>
              </div>

              <h3 className="text-2xl font-extrabold tracking-tight text-white mt-1">Ashish Pandey</h3>
              <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#FFC83D] mt-1">
                DATABASE SECURITY
              </p>

              {/* Slim Audio Progress Bar */}
              <div className="mt-5 w-full max-w-xs">
                <div className="h-2 w-full rounded-full bg-white/10 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-[#FF1739] via-[#FFC83D] to-emerald-400 transition-all duration-150"
                    style={{ width: `${Math.max(autoplayBlocked ? 0 : 4, progress)}%` }}
                  />
                </div>
              </div>

              {/* Action Control — No close/cut button, only Play if browser blocked or Start Work after complete */}
              {autoplayBlocked && (
                <button
                  type="button"
                  onClick={onPlayNow}
                  className="mt-5 w-full max-w-xs inline-flex items-center justify-center gap-2 px-5 py-3 text-xs font-extrabold text-white btn-crimson-gloss rounded-xl transition-all"
                >
                  <Play className="w-4 h-4 fill-current" />
                  <span>Play Voice</span>
                </button>
              )}

              {!autoplayBlocked && audioCompleted && (
                <button
                  type="button"
                  onClick={onDismiss}
                  className="mt-5 w-full max-w-xs inline-flex items-center justify-center gap-2 px-5 py-3 text-xs font-extrabold text-white btn-crimson-gloss rounded-xl transition-all"
                >
                  <span>Start Work</span>
                  <ArrowRight className="w-4 h-4" />
                </button>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
