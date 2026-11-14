import {
  Building2,
  CheckCheck,
  Lock,
  Megaphone,
  MessageSquare,
  Mic,
  MicOff,
  Radio,
  Search,
  Send,
  ShieldCheck,
  User as UserIcon,
  Volume2,
  VolumeX,
  Wifi,
  WifiOff,
} from 'lucide-react';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { CANONICAL_CENTRES, CENTRE_MAP, DEPARTMENT_LABELS, ROLE_LABELS } from '../constants/centres';
import {
  broadcastDirectMessage,
  markDirectMessagesRead,
  sendDirectMessage,
} from '../services/firestoreService';
import type {
  CentreId,
  DirectMessage,
  IncomingWalkieState,
  OnlineUserPresence,
  UserAccount,
  WalkieTargetMode,
} from '../types/domain';

interface CommunicationViewProps {
  currentUser: UserAccount;
  users: UserAccount[];
  directMessages: DirectMessage[];
  selectedCentreFilter: CentreId | 'all';
  wsConnected: boolean;
  onlineStaff: OnlineUserPresence[];
  superAdminOnline: boolean;
  audioUnlocked: boolean;
  isTransmitting: boolean;
  txTargetLabel: string;
  txRecipientCount: number | null;
  micLevel: number;
  incomingWalkie: IncomingWalkieState | null;
  rxLevel: number;
  onUnlockSpeaker: () => Promise<boolean>;
  onStartWalkieTx: (params: {
    targetMode: WalkieTargetMode;
    targetUid?: string;
    targetCentreId?: CentreId;
    label: string;
  }) => Promise<void>;
  onStopWalkieTx: (onFinished?: (durationSec: number) => void) => void;
  onSendChatPing: (staffUid: string, preview: string) => void;
  onNotify: (title: string, description: string, variant: 'success' | 'error' | 'warning' | 'info') => void;
}

const formatTime = (val: unknown): string => {
  if (!val) return '';
  let ms = 0;
  if (typeof val === 'number') ms = val;
  else if (typeof val === 'string') ms = Date.parse(val) || 0;
  else if (typeof val === 'object' && val !== null && 'toMillis' in val && typeof (val as { toMillis: () => number }).toMillis === 'function') {
    ms = (val as { toMillis: () => number }).toMillis();
  }
  if (!ms) return '';
  return new Date(ms).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
};

export const CommunicationView: React.FC<CommunicationViewProps> = ({
  currentUser,
  users,
  directMessages,
  selectedCentreFilter,
  wsConnected,
  onlineStaff,
  superAdminOnline,
  audioUnlocked,
  isTransmitting,
  txTargetLabel,
  txRecipientCount,
  micLevel,
  incomingWalkie,
  rxLevel,
  onUnlockSpeaker,
  onStartWalkieTx,
  onStopWalkieTx,
  onSendChatPing,
  onNotify,
}) => {
  const isSuperAdmin = currentUser.role === 'super_admin';

  // Super Admin target mode: 'staff' (1-on-1), 'centre' (broadcast to 1 branch), or 'all' (broadcast all 4 centres)
  const [adminChannelMode, setAdminChannelMode] = useState<'staff' | 'centre' | 'all'>('staff');
  const [rosterCentreTab, setRosterCentreTab] = useState<CentreId | 'all'>(selectedCentreFilter);
  const [broadcastCentreId, setBroadcastCentreId] = useState<CentreId>(
    selectedCentreFilter === 'all' ? 'vp_lookerganj' : selectedCentreFilter,
  );
  const [staffSearch, setStaffSearch] = useState('');
  const [selectedStaffUid, setSelectedStaffUid] = useState<string>('');
  const [messageInput, setMessageInput] = useState('');
  const [sending, setSending] = useState(false);

  const threadEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setRosterCentreTab(selectedCentreFilter);
    if (selectedCentreFilter !== 'all') {
      setBroadcastCentreId(selectedCentreFilter);
    }
  }, [selectedCentreFilter]);

  const onlineUidSet = useMemo(() => new Set(onlineStaff.map((u) => u.uid)), [onlineStaff]);

  const eligibleStaff = useMemo(() => {
    if (!isSuperAdmin) return [];
    const term = staffSearch.trim().toLowerCase();
    return users
      .filter((u) => u.role !== 'super_admin' && u.status === 'Active')
      .filter((u) => rosterCentreTab === 'all' || u.centreId === rosterCentreTab)
      .filter((u) => {
        if (!term) return true;
        return (
          u.fullName.toLowerCase().includes(term) ||
          u.email.toLowerCase().includes(term) ||
          (DEPARTMENT_LABELS[u.department] || '').toLowerCase().includes(term) ||
          (CENTRE_MAP[u.centreId]?.name || '').toLowerCase().includes(term)
        );
      })
      .sort((a, b) => {
        const aOnline = onlineUidSet.has(a.uid) ? 1 : 0;
        const bOnline = onlineUidSet.has(b.uid) ? 1 : 0;
        if (aOnline !== bOnline) return bOnline - aOnline;
        return a.fullName.localeCompare(b.fullName);
      });
  }, [isSuperAdmin, users, rosterCentreTab, staffSearch, onlineUidSet]);

  useEffect(() => {
    if (!isSuperAdmin) return;
    if (eligibleStaff.length > 0 && !eligibleStaff.some((u) => u.uid === selectedStaffUid)) {
      setSelectedStaffUid(eligibleStaff[0].uid);
    }
  }, [isSuperAdmin, eligibleStaff, selectedStaffUid]);

  const selectedStaff = useMemo(
    () => users.find((u) => u.uid === selectedStaffUid && u.role !== 'super_admin') || null,
    [users, selectedStaffUid],
  );

  // Thread messages: isolated strictly to Sir <-> selectedStaff (for admin) or Sir <-> currentUser (for staff)
  const activeThreadUid = isSuperAdmin ? selectedStaff?.uid || '' : currentUser.uid;
  const threadMessages = useMemo(() => {
    if (!activeThreadUid) return [];
    return directMessages.filter((m) => m.staffUid === activeThreadUid);
  }, [directMessages, activeThreadUid]);

  // Unread counts per staff member for Super Admin roster
  const unreadByStaffUid = useMemo(() => {
    const counts = new Map<string, number>();
    for (const m of directMessages) {
      if (isSuperAdmin && !m.readByAdmin) {
        counts.set(m.staffUid, (counts.get(m.staffUid) || 0) + 1);
      }
    }
    return counts;
  }, [directMessages, isSuperAdmin]);

  const lastMessageByStaffUid = useMemo(() => {
    const map = new Map<string, DirectMessage>();
    for (const m of directMessages) {
      map.set(m.staffUid, m);
    }
    return map;
  }, [directMessages]);

  // Auto-mark visible thread messages as read
  useEffect(() => {
    if (adminChannelMode !== 'staff' && isSuperAdmin) return;
    if (threadMessages.length > 0) {
      markDirectMessagesRead(threadMessages, currentUser).catch(() => {});
    }
  }, [threadMessages, currentUser, adminChannelMode, isSuperAdmin]);

  // Scroll to bottom when active thread receives a new message
  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [threadMessages.length, activeThreadUid]);

  const handleSendText = async (e: React.FormEvent) => {
    e.preventDefault();
    const clean = messageInput.trim();
    if (!clean || sending) return;

    setSending(true);
    try {
      if (isSuperAdmin && adminChannelMode === 'centre') {
        const branchStaff = users.filter(
          (u) => u.role !== 'super_admin' && u.status === 'Active' && u.centreId === broadcastCentreId,
        );
        const sentCount = await broadcastDirectMessage(branchStaff, clean, currentUser);
        for (const s of branchStaff) {
          onSendChatPing(s.uid, clean);
        }
        onNotify(
          'Centre Broadcast Sent',
          `Delivered announcement privately to ${sentCount} staff member${sentCount > 1 ? 's' : ''} at ${CENTRE_MAP[broadcastCentreId].name}.`,
          'success',
        );
      } else if (isSuperAdmin && adminChannelMode === 'all') {
        const allStaff = users.filter((u) => u.role !== 'super_admin' && u.status === 'Active');
        const sentCount = await broadcastDirectMessage(allStaff, clean, currentUser);
        for (const s of allStaff) {
          onSendChatPing(s.uid, clean);
        }
        onNotify(
          'All-Centre Broadcast Sent',
          `Delivered announcement privately to ${sentCount} staff members across all 4 centres.`,
          'success',
        );
      } else {
        if (isSuperAdmin && !selectedStaff) {
          onNotify('Select Staff', 'Please select a staff member or Centre Head to message.', 'warning');
          return;
        }
        await sendDirectMessage(
          {
            targetStaff: isSuperAdmin ? selectedStaff || undefined : undefined,
            text: clean,
            messageType: 'text',
          },
          currentUser,
        );
        onSendChatPing(isSuperAdmin ? selectedStaff!.uid : currentUser.uid, clean);
      }
      setMessageInput('');
    } catch (err) {
      onNotify('Send Failed', err instanceof Error ? err.message : 'Could not send message.', 'error');
    } finally {
      setSending(false);
    }
  };

  // Walkie-Talkie PTT & Mic Toggle controls
  const currentWalkieParams = useMemo(() => {
    if (!isSuperAdmin) {
      return {
        targetMode: 'super_admin' as WalkieTargetMode,
        label: 'Super Admin (Sir)',
        staffRecordTarget: currentUser,
      };
    }
    if (adminChannelMode === 'centre') {
      return {
        targetMode: 'centre' as WalkieTargetMode,
        targetCentreId: broadcastCentreId,
        label: `${CENTRE_MAP[broadcastCentreId].code} All Staff`,
        staffRecordTarget: null,
      };
    }
    if (adminChannelMode === 'all') {
      return {
        targetMode: 'all' as WalkieTargetMode,
        label: 'All 4 Centres Broadcast',
        staffRecordTarget: null,
      };
    }
    return {
      targetMode: 'staff' as WalkieTargetMode,
      targetUid: selectedStaff?.uid,
      label: selectedStaff ? `${selectedStaff.fullName} (${CENTRE_MAP[selectedStaff.centreId]?.code})` : 'Select Staff',
      staffRecordTarget: selectedStaff,
    };
  }, [isSuperAdmin, adminChannelMode, broadcastCentreId, selectedStaff, currentUser]);

  const handleToggleMic = async () => {
    if (isTransmitting) {
      const targetForLog = currentWalkieParams.staffRecordTarget;
      onStopWalkieTx((durationSec) => {
        if (targetForLog && durationSec >= 1) {
          sendDirectMessage(
            {
              targetStaff: isSuperAdmin ? targetForLog : undefined,
              text: `Walkie-Talkie live voice call (${durationSec}s)`,
              messageType: 'walkie_log',
            },
            currentUser,
          ).catch(() => {});
        }
      });
      return;
    }

    if (isSuperAdmin && adminChannelMode === 'staff' && !selectedStaff) {
      onNotify('Select Staff First', 'Choose a staff member or Centre Head from the list to speak to.', 'warning');
      return;
    }

    await onStartWalkieTx({
      targetMode: currentWalkieParams.targetMode,
      targetUid: currentWalkieParams.targetUid,
      targetCentreId: currentWalkieParams.targetCentreId,
      label: currentWalkieParams.label,
    });
  };

  const handlePttDown = async () => {
    if (isTransmitting) return;
    if (isSuperAdmin && adminChannelMode === 'staff' && !selectedStaff) {
      onNotify('Select Staff First', 'Choose a staff member or Centre Head from the list to speak to.', 'warning');
      return;
    }
    await onStartWalkieTx({
      targetMode: currentWalkieParams.targetMode,
      targetUid: currentWalkieParams.targetUid,
      targetCentreId: currentWalkieParams.targetCentreId,
      label: currentWalkieParams.label,
    });
  };

  const handlePttUp = () => {
    if (!isTransmitting) return;
    const targetForLog = currentWalkieParams.staffRecordTarget;
    onStopWalkieTx((durationSec) => {
      if (targetForLog && durationSec >= 1) {
        sendDirectMessage(
          {
            targetStaff: isSuperAdmin ? targetForLog : undefined,
            text: `Walkie-Talkie live voice call (${durationSec}s)`,
            messageType: 'walkie_log',
          },
          currentUser,
        ).catch(() => {});
      }
    });
  };

  const broadcastTargetCount = useMemo(() => {
    if (!isSuperAdmin) return 0;
    if (adminChannelMode === 'centre') {
      return users.filter(
        (u) => u.role !== 'super_admin' && u.status === 'Active' && u.centreId === broadcastCentreId,
      ).length;
    }
    if (adminChannelMode === 'all') {
      return users.filter((u) => u.role !== 'super_admin' && u.status === 'Active').length;
    }
    return 1;
  }, [isSuperAdmin, adminChannelMode, users, broadcastCentreId]);

  const broadcastOnlineCount = useMemo(() => {
    if (!isSuperAdmin) return 0;
    if (adminChannelMode === 'centre') {
      return onlineStaff.filter((u) => u.centreId === broadcastCentreId).length;
    }
    if (adminChannelMode === 'all') {
      return onlineStaff.length;
    }
    return selectedStaff && onlineUidSet.has(selectedStaff.uid) ? 1 : 0;
  }, [isSuperAdmin, adminChannelMode, onlineStaff, broadcastCentreId, selectedStaff, onlineUidSet]);

  const activeVuLevel = isTransmitting ? micLevel : incomingWalkie ? rxLevel : 0;

  return (
    <div className="space-y-4">
      {/* Header Strip */}
      <div className="bg-white rounded-2xl border border-slate-200 p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <Radio className="w-5 h-5 text-[#DC2626] shrink-0" />
            <h1 className="text-lg font-extrabold text-[#0F172A] tracking-tight">
              {isSuperAdmin ? 'Command Comms & Live Walkie-Talkie' : 'Direct Channel with Super Admin'}
            </h1>
          </div>
          <p className="text-xs text-slate-600 mt-1">
            {isSuperAdmin
              ? 'Message or open live Walkie-Talkie voice with any staff member or Centre Head across all 4 centres.'
              : 'Private 1-on-1 line with Super Admin. Staff-to-staff chat and walkie-talkie are strictly disabled.'}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 shrink-0">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-xl border border-slate-200 bg-slate-50 text-xs font-semibold text-slate-800 whitespace-nowrap">
            {wsConnected ? (
              <Wifi className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
            ) : (
              <WifiOff className="w-3.5 h-3.5 text-amber-600 shrink-0" />
            )}
            <span>{wsConnected ? 'Walkie Radio Connected' : 'Connecting Radio...'}</span>
          </div>

          <button
            type="button"
            onClick={onUnlockSpeaker}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border text-xs font-bold whitespace-nowrap transition-colors ${
              audioUnlocked
                ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                : 'bg-amber-50 border-amber-300 text-amber-900 hover:bg-amber-100'
            }`}
          >
            {audioUnlocked ? <Volume2 className="w-3.5 h-3.5" /> : <VolumeX className="w-3.5 h-3.5" />}
            <span>{audioUnlocked ? 'Speaker Ready' : 'Enable Speaker'}</span>
          </button>
        </div>
      </div>

      {/* Main Split Workspace */}
      <div className={`grid grid-cols-1 ${isSuperAdmin ? 'lg:grid-cols-12' : ''} gap-4 items-stretch`}>
        {/* LEFT ROSTER PANEL: SUPER ADMIN ONLY */}
        {isSuperAdmin && (
          <aside className="lg:col-span-4 bg-white rounded-2xl border border-slate-200 flex flex-col overflow-hidden min-h-[540px] max-h-[760px]">
            {/* Channel Mode Segmented Control */}
            <div className="p-3 border-b border-slate-200 bg-slate-50/70 space-y-2.5">
              <div className="grid grid-cols-3 gap-1 p-1 bg-slate-200/70 rounded-xl">
                <button
                  type="button"
                  onClick={() => setAdminChannelMode('staff')}
                  className={`px-2 py-1.5 text-xs font-bold rounded-lg transition-colors whitespace-nowrap ${
                    adminChannelMode === 'staff'
                      ? 'bg-white text-[#0F172A] shadow-2xs'
                      : 'text-slate-600 hover:text-[#0F172A]'
                  }`}
                >
                  1-on-1 Staff
                </button>
                <button
                  type="button"
                  onClick={() => setAdminChannelMode('centre')}
                  className={`px-2 py-1.5 text-xs font-bold rounded-lg transition-colors whitespace-nowrap ${
                    adminChannelMode === 'centre'
                      ? 'bg-white text-[#0F172A] shadow-2xs'
                      : 'text-slate-600 hover:text-[#0F172A]'
                  }`}
                >
                  Centre Mic
                </button>
                <button
                  type="button"
                  onClick={() => setAdminChannelMode('all')}
                  className={`px-2 py-1.5 text-xs font-bold rounded-lg transition-colors whitespace-nowrap ${
                    adminChannelMode === 'all'
                      ? 'bg-white text-[#0F172A] shadow-2xs'
                      : 'text-slate-600 hover:text-[#0F172A]'
                  }`}
                >
                  All 4 Centres
                </button>
              </div>

              {adminChannelMode === 'staff' && (
                <>
                  <div className="relative">
                    <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                    <input
                      type="text"
                      value={staffSearch}
                      onChange={(e) => setStaffSearch(e.target.value)}
                      placeholder="Search staff by name or dept..."
                      className="w-full pl-8 pr-3 py-2 text-xs bg-white border border-slate-200 rounded-xl text-[#0F172A] placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[#DC2626]/25 focus:border-[#DC2626]"
                    />
                  </div>
                  <div className="flex items-center gap-1 overflow-x-auto pb-0.5">
                    <button
                      type="button"
                      onClick={() => setRosterCentreTab('all')}
                      className={`px-2.5 py-1 text-[11px] font-bold rounded-lg whitespace-nowrap shrink-0 ${
                        rosterCentreTab === 'all'
                          ? 'bg-[#0F172A] text-white'
                          : 'bg-white border border-slate-200 text-slate-700 hover:bg-slate-100'
                      }`}
                    >
                      All
                    </button>
                    {CANONICAL_CENTRES.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => setRosterCentreTab(c.id)}
                        className={`px-2.5 py-1 text-[11px] font-bold rounded-lg whitespace-nowrap shrink-0 ${
                          rosterCentreTab === c.id
                            ? 'bg-[#DC2626] text-white'
                            : 'bg-white border border-slate-200 text-slate-700 hover:bg-slate-100'
                        }`}
                      >
                        {c.code}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>

            {/* Staff List or Broadcast Summary */}
            {adminChannelMode === 'staff' ? (
              <div className="flex-1 overflow-y-auto divide-y divide-slate-100">
                {eligibleStaff.length === 0 ? (
                  <div className="p-8 text-center text-xs text-slate-500">
                    No active staff members found in this filter.
                  </div>
                ) : (
                  eligibleStaff.map((staff) => {
                    const isOnline = onlineUidSet.has(staff.uid);
                    const unread = unreadByStaffUid.get(staff.uid) || 0;
                    const lastMsg = lastMessageByStaffUid.get(staff.uid);
                    const selected = selectedStaff?.uid === staff.uid;
                    return (
                      <button
                        key={staff.uid}
                        type="button"
                        onClick={() => setSelectedStaffUid(staff.uid)}
                        className={`w-full text-left px-4 py-3 transition-colors flex items-start justify-between gap-3 ${
                          selected ? 'bg-rose-50/85' : 'hover:bg-slate-50'
                        }`}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-bold text-[#0F172A] truncate">{staff.fullName}</span>
                            <span
                              className={`text-[10px] font-bold font-mono uppercase ${
                                isOnline ? 'text-emerald-700' : 'text-slate-400'
                              }`}
                            >
                              {isOnline ? 'Live' : 'Offline'}
                            </span>
                          </div>
                          <p className="text-[11px] text-slate-600 truncate mt-0.5">
                            {ROLE_LABELS[staff.role]} · {DEPARTMENT_LABELS[staff.department]} ·{' '}
                            {CENTRE_MAP[staff.centreId]?.code}
                          </p>
                          {lastMsg && (
                            <p className="text-[11px] text-slate-500 truncate mt-1">
                              {lastMsg.senderRole === 'super_admin' ? 'You: ' : ''}
                              {lastMsg.text}
                            </p>
                          )}
                        </div>
                        {unread > 0 && (
                          <span className="px-2 py-0.5 rounded-md bg-[#DC2626] text-white text-[10px] font-extrabold font-mono tabular-nums shrink-0">
                            {unread}
                          </span>
                        )}
                      </button>
                    );
                  })
                )}
              </div>
            ) : (
              <div className="p-4 space-y-4 flex-1">
                {adminChannelMode === 'centre' && (
                  <div>
                    <label className="block text-xs font-bold text-[#0F172A] mb-1.5">
                      Target Educational Centre
                    </label>
                    <select
                      value={broadcastCentreId}
                      onChange={(e) => setBroadcastCentreId(e.target.value as CentreId)}
                      className="w-full px-3 py-2 text-xs font-semibold bg-white border border-slate-300 rounded-xl text-[#0F172A] focus:outline-none focus:ring-2 focus:ring-[#DC2626]/25"
                    >
                      {CANONICAL_CENTRES.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name} ({c.code})
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                <div className="p-4 rounded-xl border border-slate-200 bg-slate-50 space-y-2">
                  <div className="flex items-center gap-2 text-xs font-bold text-[#0F172A]">
                    <Megaphone className="w-4 h-4 text-[#DC2626]" />
                    <span>
                      {adminChannelMode === 'centre'
                        ? `${CENTRE_MAP[broadcastCentreId].name} Broadcast`
                        : 'All-Centre Command Broadcast'}
                    </span>
                  </div>
                  <p className="text-xs text-slate-600 leading-relaxed">
                    Speak live on Walkie-Talkie or send an announcement. Every active staff member receives it
                    privately and can only reply back to you.
                  </p>
                  <div className="pt-2 border-t border-slate-200 flex items-center justify-between text-xs font-mono tabular-nums">
                    <span className="text-slate-600">Assigned Staff: {broadcastTargetCount}</span>
                    <span className="font-bold text-emerald-700">Live Now: {broadcastOnlineCount}</span>
                  </div>
                </div>
              </div>
            )}
          </aside>
        )}

        {/* RIGHT CONSOLE: WALKIE-TALKIE TRANSCEIVER + CHAT THREAD */}
        <section
          className={`${
            isSuperAdmin ? 'lg:col-span-8' : 'w-full'
          } bg-white rounded-2xl border border-slate-200 flex flex-col overflow-hidden min-h-[540px] max-h-[760px]`}
        >
          {/* Walkie-Talkie Hardware Transceiver Deck */}
          <div className="bg-[#0F172A] text-white p-4 sm:p-5 border-b border-slate-800">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
              <div className="min-w-0 space-y-1">
                <div className="flex items-center gap-2 text-xs font-bold text-amber-400">
                  <Radio className="w-4 h-4 shrink-0" />
                  <span>
                    {isSuperAdmin ? 'Walkie-Talkie Direct Transceiver' : 'Walkie-Talkie Line · Super Admin'}
                  </span>
                </div>
                <h2 className="text-base font-extrabold text-white truncate">
                  {isSuperAdmin
                    ? adminChannelMode === 'staff'
                      ? selectedStaff
                        ? `${selectedStaff.fullName}`
                        : 'Select a staff member'
                      : adminChannelMode === 'centre'
                        ? `${CENTRE_MAP[broadcastCentreId].name}`
                        : 'All 4 Centres (Command Broadcast)'
                    : 'Super Admin (Sir)'}
                </h2>
                <p className="text-xs text-slate-300 truncate">
                  {isSuperAdmin
                    ? adminChannelMode === 'staff' && selectedStaff
                      ? `${ROLE_LABELS[selectedStaff.role]} · ${DEPARTMENT_LABELS[selectedStaff.department]} · ${
                          CENTRE_MAP[selectedStaff.centreId]?.name
                        } · ${onlineUidSet.has(selectedStaff.uid) ? 'Online Now' : 'Currently Offline'}`
                      : `${broadcastOnlineCount} of ${broadcastTargetCount} staff online right now`
                    : `${superAdminOnline ? 'Super Admin is Online' : 'Super Admin Offline'} · Private Sir ↔ Staff channel`}
                </p>
              </div>

              {/* Dual Mic Controls: Toggle ON/OFF + Hold-to-Talk */}
              <div className="flex flex-wrap items-center gap-2.5 shrink-0">
                <button
                  type="button"
                  onMouseDown={handlePttDown}
                  onMouseUp={handlePttUp}
                  onMouseLeave={handlePttUp}
                  onTouchStart={(e) => {
                    e.preventDefault();
                    handlePttDown();
                  }}
                  onTouchEnd={handlePttUp}
                  disabled={!wsConnected || (isSuperAdmin && adminChannelMode === 'staff' && !selectedStaff)}
                  className={`inline-flex items-center gap-2 px-4 py-2.5 text-xs font-bold rounded-xl border transition-all whitespace-nowrap select-none disabled:opacity-45 ${
                    isTransmitting
                      ? 'bg-[#DC2626] border-red-400 text-white shadow-lg'
                      : 'bg-slate-800 hover:bg-slate-700 border-slate-600 text-white'
                  }`}
                >
                  <Mic className="w-4 h-4" />
                  <span>Hold to Speak</span>
                </button>

                <button
                  type="button"
                  onClick={handleToggleMic}
                  disabled={!wsConnected || (isSuperAdmin && adminChannelMode === 'staff' && !selectedStaff)}
                  className={`inline-flex items-center gap-2 px-4 py-2.5 text-xs font-bold rounded-xl transition-all whitespace-nowrap disabled:opacity-45 ${
                    isTransmitting
                      ? 'bg-white text-[#B91C1C] hover:bg-slate-100'
                      : 'bg-[#DC2626] hover:bg-[#B91C1C] text-white'
                  }`}
                >
                  {isTransmitting ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
                  <span>{isTransmitting ? 'Mic Off' : 'Mic On (Hands-Free)'}</span>
                </button>
              </div>
            </div>

            {/* Live Signal & Audio Meter Strip */}
            <div className="mt-3.5 pt-3 border-t border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="flex items-center gap-3 flex-1 min-w-0">
                <span className="text-[11px] font-mono text-slate-300 whitespace-nowrap">
                  {isTransmitting
                    ? `TX LIVE -> ${txTargetLabel}${
                        txRecipientCount !== null ? ` (${txRecipientCount} listening)` : ''
                      }`
                    : incomingWalkie
                      ? `RX LIVE <- ${incomingWalkie.fromName}`
                      : 'STANDBY'}
                </span>
                <div className="flex items-center gap-1 flex-1 max-w-[200px] h-3" aria-hidden="true">
                  {Array.from({ length: 14 }).map((_, i) => {
                    const lit = activeVuLevel >= ((i + 1) / 14) * 0.72;
                    return (
                      <div
                        key={i}
                        className={`flex-1 rounded-xs transition-all duration-75 ${
                          lit
                            ? isTransmitting
                              ? 'bg-red-400 h-3'
                              : 'bg-emerald-400 h-3'
                            : 'bg-slate-800 h-1.5'
                        }`}
                      />
                    );
                  })}
                </div>
              </div>

              {!isSuperAdmin && (
                <div className="inline-flex items-center gap-1.5 text-[11px] text-slate-300 whitespace-nowrap">
                  <Lock className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                  <span>Peer staff chat disabled</span>
                </div>
              )}
            </div>
          </div>

          {/* Chat Thread */}
          <div className="flex-1 overflow-y-auto p-4 sm:p-5 space-y-3 bg-slate-50/70">
            {isSuperAdmin && adminChannelMode !== 'staff' ? (
              <div className="h-full flex flex-col items-center justify-center text-center max-w-md mx-auto py-8 space-y-3">
                <div className="w-12 h-12 rounded-2xl bg-rose-50 border border-rose-200 flex items-center justify-center text-[#DC2626]">
                  <Megaphone className="w-6 h-6" />
                </div>
                <h3 className="text-sm font-bold text-[#0F172A]">
                  {adminChannelMode === 'centre'
                    ? `Broadcast to ${CENTRE_MAP[broadcastCentreId].name}`
                    : 'Broadcast Across All 4 Centres'}
                </h3>
                <p className="text-xs text-slate-600 leading-relaxed">
                  Type an official directive below to deliver it privately to all {broadcastTargetCount} active staff
                  members, or click <strong>Mic On</strong> above to speak live to everyone connected right now.
                </p>
              </div>
            ) : !activeThreadUid ? (
              <div className="h-full flex flex-col items-center justify-center text-center py-10 text-slate-500 space-y-2">
                <UserIcon className="w-8 h-8 text-slate-400" />
                <p className="text-xs font-semibold">Select a staff member or Centre Head to start messaging.</p>
              </div>
            ) : threadMessages.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-center max-w-sm mx-auto py-10 space-y-2.5">
                <div className="w-11 h-11 rounded-2xl bg-white border border-slate-200 flex items-center justify-center text-slate-500">
                  <MessageSquare className="w-5 h-5" />
                </div>
                <p className="text-sm font-bold text-[#0F172A]">No messages yet</p>
                <p className="text-xs text-slate-600 leading-relaxed">
                  {isSuperAdmin
                    ? `Send a direct message or use Walkie-Talkie Mic On to talk live with ${selectedStaff?.fullName}.`
                    : 'Your private channel with Super Admin is ready. You can reply to Sir here or speak live using Walkie-Talkie.'}
                </p>
              </div>
            ) : (
              threadMessages.map((msg) => {
                const isMine = msg.senderUid === currentUser.uid;
                const isWalkieLog = msg.messageType === 'walkie_log';
                const isRead = isSuperAdmin
                  ? msg.senderRole === 'super_admin'
                    ? msg.readByStaff
                    : msg.readByAdmin
                  : msg.readByStaff;

                if (isWalkieLog) {
                  return (
                    <div key={msg.messageId} className="flex justify-center">
                      <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-xl bg-slate-200/75 text-slate-700 text-[11px] font-medium">
                        <Radio className="w-3.5 h-3.5 text-[#DC2626] shrink-0" />
                        <span>
                          {msg.senderName} · {msg.text}
                        </span>
                        <span className="font-mono tabular-nums text-slate-500">{formatTime(msg.createdAt)}</span>
                      </div>
                    </div>
                  );
                }

                return (
                  <div key={msg.messageId} className={`flex ${isMine ? 'justify-end' : 'justify-start'}`}>
                    <div
                      className={`max-w-[82%] sm:max-w-[70%] rounded-2xl px-4 py-2.5 text-xs ${
                        isMine
                          ? 'bg-[#0F172A] text-white'
                          : 'bg-white border border-slate-200 text-[#0F172A]'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-3 mb-1">
                        <span className={`font-bold ${isMine ? 'text-amber-300' : 'text-[#DC2626]'}`}>
                          {msg.senderRole === 'super_admin' ? `${msg.senderName} (Super Admin)` : msg.senderName}
                        </span>
                        <span className={`font-mono tabular-nums text-[10px] ${isMine ? 'text-slate-300' : 'text-slate-500'}`}>
                          {formatTime(msg.createdAt)}
                        </span>
                      </div>
                      <p className="whitespace-pre-wrap leading-relaxed text-[13px]">{msg.text}</p>
                      {isMine && (
                        <div className="mt-1 flex items-center justify-end gap-1 text-[10px] text-slate-300">
                          <CheckCheck className={`w-3 h-3 ${isRead ? 'text-emerald-400' : 'text-slate-400'}`} />
                          <span>{isRead ? 'Seen' : 'Sent'}</span>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })
            )}
            <div ref={threadEndRef} />
          </div>

          {/* Message Input Bar */}
          <form onSubmit={handleSendText} className="p-3.5 bg-white border-t border-slate-200 flex items-center gap-2.5">
            <div className="hidden sm:flex items-center gap-1.5 text-[11px] font-semibold text-slate-500 px-2 whitespace-nowrap">
              {isSuperAdmin ? (
                <Building2 className="w-3.5 h-3.5 text-slate-500" />
              ) : (
                <ShieldCheck className="w-3.5 h-3.5 text-emerald-600" />
              )}
              <span>
                {isSuperAdmin
                  ? adminChannelMode === 'staff'
                    ? selectedStaff
                      ? `To ${selectedStaff.fullName}`
                      : 'Select Staff'
                    : adminChannelMode === 'centre'
                      ? `To ${CENTRE_MAP[broadcastCentreId].code}`
                      : 'To All Centres'
                  : 'Reply to Sir'}
              </span>
            </div>

            <input
              type="text"
              value={messageInput}
              onChange={(e) => setMessageInput(e.target.value)}
              maxLength={1500}
              disabled={isSuperAdmin && adminChannelMode === 'staff' && !selectedStaff}
              placeholder={
                isSuperAdmin
                  ? adminChannelMode === 'staff'
                    ? selectedStaff
                      ? `Write a direct message to ${selectedStaff.fullName}...`
                      : 'Select a staff member on the left...'
                    : 'Write broadcast announcement for staff...'
                  : 'Type your reply to Super Admin (Sir)...'
              }
              className="flex-1 px-3.5 py-2.5 text-sm bg-slate-50 border border-slate-200 rounded-xl text-[#0F172A] placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[#DC2626]/25 focus:border-[#DC2626] disabled:opacity-50"
            />

            <button
              type="submit"
              disabled={
                sending ||
                !messageInput.trim() ||
                (isSuperAdmin && adminChannelMode === 'staff' && !selectedStaff)
              }
              className="inline-flex items-center gap-1.5 px-4 py-2.5 text-xs font-bold text-white bg-[#DC2626] hover:bg-[#B91C1C] rounded-xl transition-colors disabled:opacity-45 whitespace-nowrap shrink-0"
            >
              <Send className="w-3.5 h-3.5" />
              <span>{sending ? 'Sending...' : adminChannelMode !== 'staff' && isSuperAdmin ? 'Broadcast' : 'Send'}</span>
            </button>
          </form>
        </section>
      </div>
    </div>
  );
};
