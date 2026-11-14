import { Mic, MicOff, Radio, Volume2, VolumeX } from 'lucide-react';
import React from 'react';
import { CENTRE_MAP, DEPARTMENT_LABELS, ROLE_LABELS } from '../constants/centres';
import type { CentreId, IncomingWalkieState, UserAccount, WalkieTargetMode } from '../types/domain';

interface WalkieOverlayBarProps {
  currentUser: UserAccount;
  incomingWalkie: IncomingWalkieState | null;
  rxLevel: number;
  isTransmitting: boolean;
  txTargetLabel: string;
  txRecipientCount: number | null;
  micLevel: number;
  audioUnlocked: boolean;
  onUnlockSpeaker: () => Promise<boolean>;
  onStartReply: (params: {
    targetMode: WalkieTargetMode;
    targetUid?: string;
    targetCentreId?: CentreId;
    label: string;
  }) => Promise<void>;
  onStopTx: () => void;
  onOpenComms: () => void;
}

export const WalkieOverlayBar: React.FC<WalkieOverlayBarProps> = ({
  currentUser,
  incomingWalkie,
  rxLevel,
  isTransmitting,
  txTargetLabel,
  txRecipientCount,
  micLevel,
  audioUnlocked,
  onUnlockSpeaker,
  onStartReply,
  onStopTx,
  onOpenComms,
}) => {
  if (!incomingWalkie && !isTransmitting) return null;

  const isAdmin = currentUser.role === 'super_admin';
  const activeLevel = isTransmitting ? micLevel : rxLevel;
  const barCount = 12;

  const handleQuickReplyToggle = async () => {
    if (isTransmitting) {
      onStopTx();
      return;
    }
    if (!incomingWalkie) return;
    if (isAdmin) {
      await onStartReply({
        targetMode: 'staff',
        targetUid: incomingWalkie.fromUid,
        label: incomingWalkie.fromName,
      });
    } else {
      await onStartReply({
        targetMode: 'super_admin',
        label: 'Super Admin (Sir)',
      });
    }
  };

  return (
    <div className="fixed bottom-5 right-5 z-50 w-[min(92vw,390px)] rounded-2xl bg-[#0F172A] text-white border border-slate-700/90 shadow-2xl p-4 no-print">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div
            className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${
              isTransmitting
                ? 'bg-[#DC2626] text-white'
                : 'bg-emerald-600 text-white'
            }`}
          >
            {isTransmitting ? <Mic className="w-5 h-5" /> : <Radio className="w-5 h-5" />}
          </div>
          <div className="min-w-0">
            <p className="text-[11px] font-bold uppercase tracking-wider text-amber-400">
              {isTransmitting ? 'Transmitting Live Voice' : 'Incoming Walkie-Talkie'}
            </p>
            <p className="text-sm font-bold text-white truncate">
              {isTransmitting
                ? `To: ${txTargetLabel}`
                : `${incomingWalkie?.fromName || 'Super Admin'}`}
            </p>
            <p className="text-[11px] text-slate-300 truncate">
              {isTransmitting
                ? txRecipientCount === null
                  ? 'Connecting...'
                  : txRecipientCount > 0
                    ? `${txRecipientCount} listener${txRecipientCount > 1 ? 's' : ''} hearing live`
                    : 'Target user currently offline'
                : `${ROLE_LABELS[incomingWalkie?.fromRole || 'super_admin']} · ${
                    incomingWalkie?.fromRole === 'super_admin'
                      ? incomingWalkie.targetMode === 'all'
                        ? 'All Centres Broadcast'
                        : incomingWalkie.targetMode === 'centre' && incomingWalkie.targetCentreId
                          ? `${CENTRE_MAP[incomingWalkie.targetCentreId]?.code || ''} Broadcast`
                          : 'Direct Call'
                      : `${DEPARTMENT_LABELS[incomingWalkie?.fromDepartment || 'all']} · ${
                          CENTRE_MAP[incomingWalkie?.fromCentreId || 'vp_lookerganj']?.code || ''
                        }`
                  }`}
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={onOpenComms}
          className="text-xs font-semibold text-slate-300 hover:text-white underline whitespace-nowrap shrink-0"
        >
          Open Chat
        </button>
      </div>

      {/* Live audio meter */}
      <div className="mt-3 flex items-center gap-1 h-4" aria-hidden="true">
        {Array.from({ length: barCount }).map((_, idx) => {
          const threshold = (idx + 1) / barCount;
          const lit = activeLevel >= threshold * 0.72;
          return (
            <div
              key={idx}
              className={`flex-1 rounded-xs transition-all duration-75 ${
                lit
                  ? isTransmitting
                    ? 'bg-[#EF4444] h-3.5'
                    : 'bg-emerald-400 h-3.5'
                  : 'bg-slate-700 h-1.5'
              }`}
            />
          );
        })}
      </div>

      <div className="mt-3 flex items-center justify-between gap-2">
        {!audioUnlocked && incomingWalkie && !isTransmitting ? (
          <button
            type="button"
            onClick={onUnlockSpeaker}
            className="flex-1 inline-flex items-center justify-center gap-2 px-3.5 py-2 text-xs font-bold text-[#0F172A] bg-amber-400 hover:bg-amber-300 rounded-xl whitespace-nowrap"
          >
            <VolumeX className="w-4 h-4 shrink-0" />
            Tap to Hear Live Voice
          </button>
        ) : (
          <div className="inline-flex items-center gap-1.5 text-[11px] text-slate-300">
            <Volume2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
            <span>{isTransmitting ? 'Mic Live' : 'Speaker Active'}</span>
          </div>
        )}

        {isTransmitting ? (
          <button
            type="button"
            onClick={onStopTx}
            className="inline-flex items-center justify-center gap-1.5 px-4 py-2 text-xs font-bold text-white bg-[#DC2626] hover:bg-[#B91C1C] rounded-xl whitespace-nowrap shrink-0"
          >
            <MicOff className="w-3.5 h-3.5" />
            Turn Mic Off
          </button>
        ) : incomingWalkie ? (
          <button
            type="button"
            onClick={handleQuickReplyToggle}
            className="inline-flex items-center justify-center gap-1.5 px-4 py-2 text-xs font-bold text-white bg-[#DC2626] hover:bg-[#B91C1C] rounded-xl whitespace-nowrap shrink-0"
          >
            <Mic className="w-3.5 h-3.5" />
            Reply via Mic
          </button>
        ) : null}
      </div>
    </div>
  );
};
