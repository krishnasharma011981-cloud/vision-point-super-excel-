import { useCallback, useEffect, useRef, useState } from 'react';
import { auth } from '../lib/firebase';
import {
  enqueuePcmAudioChunk,
  isSpeakerUnlocked,
  playWalkieChirp,
  resetPlaybackBuffer,
  startMicCapture,
  unlockSpeaker,
} from '../lib/walkieAudio';
import type {
  CentreId,
  IncomingWalkieState,
  OnlineUserPresence,
  UserAccount,
  UserDepartment,
  UserRole,
  WalkieTargetMode,
} from '../types/domain';

interface UseWalkieCommsOptions {
  currentUser: UserAccount | null;
  onNotify: (title: string, description: string, variant: 'success' | 'error' | 'warning' | 'info') => void;
  onIncomingChatPing?: (payload: { fromName: string; staffUid: string; preview: string }) => void;
}

export function useWalkieComms({ currentUser, onNotify, onIncomingChatPing }: UseWalkieCommsOptions) {
  const [wsConnected, setWsConnected] = useState(false);
  const [onlineStaff, setOnlineStaff] = useState<OnlineUserPresence[]>([]);
  const [superAdminOnline, setSuperAdminOnline] = useState(false);
  const [audioUnlocked, setAudioUnlocked] = useState(false);

  const [isTransmitting, setIsTransmitting] = useState(false);
  const [txTargetLabel, setTxTargetLabel] = useState('');
  const [txRecipientCount, setTxRecipientCount] = useState<number | null>(null);
  const [micLevel, setMicLevel] = useState(0);

  const [incomingWalkie, setIncomingWalkie] = useState<IncomingWalkieState | null>(null);
  const [rxLevel, setRxLevel] = useState(0);

  const wsRef = useRef<WebSocket | null>(null);
  const stopMicRef = useRef<(() => void) | null>(null);
  const activeTxSessionRef = useRef<string | null>(null);
  const pendingTxChunksRef = useRef<Array<{ pcmBase64: string; sampleRate: number }>>([]);
  const txStartedAtRef = useRef<number>(0);
  const onIncomingChatPingRef = useRef(onIncomingChatPing);
  onIncomingChatPingRef.current = onIncomingChatPing;

  // Automatically unlock Web Audio playback on first user gesture anywhere in dashboard
  useEffect(() => {
    if (!currentUser) return;
    const handleGesture = () => {
      unlockSpeaker().then((ok) => {
        if (ok) setAudioUnlocked(true);
      });
    };
    window.addEventListener('pointerdown', handleGesture, { passive: true });
    window.addEventListener('keydown', handleGesture, { passive: true });
    return () => {
      window.removeEventListener('pointerdown', handleGesture);
      window.removeEventListener('keydown', handleGesture);
    };
  }, [currentUser]);

  const handleUnlockSpeaker = useCallback(async () => {
    const ok = await unlockSpeaker();
    setAudioUnlocked(ok);
    if (ok) {
      playWalkieChirp('message');
    }
    return ok;
  }, []);

  // Connect & maintain authenticated WebSocket connection to /ws/comms
  useEffect(() => {
    if (!currentUser) {
      setWsConnected(false);
      setOnlineStaff([]);
      setSuperAdminOnline(false);
      setIncomingWalkie(null);
      return;
    }

    let disposed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let pingTimer: ReturnType<typeof setInterval> | null = null;
    let rxFadeTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    const connect = async () => {
      if (disposed || !auth.currentUser) return;
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}/ws/comms`;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = async () => {
        attempt = 0;
        try {
          const token = await auth.currentUser?.getIdToken();
          if (token && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'auth', token }));
          }
        } catch {
          ws.close();
        }
      };

      ws.onmessage = (event) => {
        let data: Record<string, unknown>;
        try {
          data = JSON.parse(String(event.data || '{}')) as Record<string, unknown>;
        } catch {
          return;
        }

        const msgType = String(data.type || '');
        if (msgType === 'auth:ok') {
          setWsConnected(true);
          if (pingTimer) clearInterval(pingTimer);
          pingTimer = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'ping' }));
            }
          }, 25_000);
          return;
        }

        if (msgType === 'presence:update') {
          const list = Array.isArray(data.onlineUsers) ? (data.onlineUsers as OnlineUserPresence[]) : [];
          setOnlineStaff(list);
          return;
        }

        if (msgType === 'presence:admin') {
          setSuperAdminOnline(Boolean(data.superAdminOnline));
          return;
        }

        if (msgType === 'wt:ack') {
          const sid = String(data.sessionId || '');
          const count = Number(data.recipientCount || 0);
          activeTxSessionRef.current = sid;
          setTxRecipientCount(count);
          while (pendingTxChunksRef.current.length > 0 && ws.readyState === WebSocket.OPEN) {
            const next = pendingTxChunksRef.current.shift()!;
            ws.send(
              JSON.stringify({
                type: 'wt:audio',
                sessionId: sid,
                sampleRate: next.sampleRate,
                pcmBase64: next.pcmBase64,
              }),
            );
          }
          return;
        }

        if (msgType === 'wt:error') {
          onNotify('Walkie-Talkie Blocked', String(data.error || 'Transmission denied.'), 'error');
          return;
        }

        if (msgType === 'wt:start') {
          resetPlaybackBuffer();
          playWalkieChirp('start');
          setIncomingWalkie({
            sessionId: String(data.sessionId || ''),
            fromUid: String(data.fromUid || ''),
            fromName: String(data.fromName || 'Super Admin'),
            fromRole: (data.fromRole as UserRole) || 'super_admin',
            fromCentreId: (data.fromCentreId as CentreId) || 'vp_lookerganj',
            fromDepartment: (data.fromDepartment as UserDepartment) || 'all',
            targetMode: (data.targetMode as WalkieTargetMode) || 'staff',
            targetCentreId: data.targetCentreId as CentreId | undefined,
            startedAt: Date.now(),
          });
          setAudioUnlocked(isSpeakerUnlocked());
          return;
        }

        if (msgType === 'wt:audio') {
          const res = enqueuePcmAudioChunk(String(data.pcmBase64 || ''), Number(data.sampleRate || 16000));
          setAudioUnlocked(res.unlocked);
          setRxLevel(res.level);
          if (rxFadeTimer) clearTimeout(rxFadeTimer);
          rxFadeTimer = setTimeout(() => setRxLevel(0), 220);
          return;
        }

        if (msgType === 'wt:end') {
          playWalkieChirp('end');
          resetPlaybackBuffer();
          setRxLevel(0);
          setIncomingWalkie((prev) =>
            prev && prev.sessionId === String(data.sessionId || '') ? null : prev,
          );
          return;
        }

        if (msgType === 'chat:incoming') {
          playWalkieChirp('message');
          onIncomingChatPingRef.current?.({
            fromName: String(data.fromName || 'Message'),
            staffUid: String(data.staffUid || ''),
            preview: String(data.preview || ''),
          });
        }
      };

      ws.onclose = () => {
        setWsConnected(false);
        if (pingTimer) clearInterval(pingTimer);
        if (wsRef.current === ws) wsRef.current = null;
        if (!disposed) {
          const delay = Math.min(8000, 1000 * Math.pow(1.6, attempt));
          attempt += 1;
          reconnectTimer = setTimeout(connect, delay);
        }
      };

      ws.onerror = () => {
        ws.close();
      };
    };

    connect();

    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (pingTimer) clearInterval(pingTimer);
      if (rxFadeTimer) clearTimeout(rxFadeTimer);
      if (stopMicRef.current) {
        stopMicRef.current();
        stopMicRef.current = null;
      }
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [currentUser?.uid, onNotify]);

  const stopWalkieTx = useCallback(
    (onFinished?: (durationSec: number) => void) => {
      if (stopMicRef.current) {
        stopMicRef.current();
        stopMicRef.current = null;
      }
      pendingTxChunksRef.current = [];
      const ws = wsRef.current;
      const sid = activeTxSessionRef.current;
      if (ws && ws.readyState === WebSocket.OPEN && sid) {
        ws.send(JSON.stringify({ type: 'wt:end', sessionId: sid }));
      }
      const durationSec = txStartedAtRef.current
        ? Math.max(1, Math.round((Date.now() - txStartedAtRef.current) / 1000))
        : 0;
      activeTxSessionRef.current = null;
      txStartedAtRef.current = 0;
      setIsTransmitting(false);
      setTxRecipientCount(null);
      setMicLevel(0);
      playWalkieChirp('end');
      if (durationSec > 0 && onFinished) {
        onFinished(durationSec);
      }
    },
    [],
  );

  const startWalkieTx = useCallback(
    async (params: {
      targetMode: WalkieTargetMode;
      targetUid?: string;
      targetCentreId?: CentreId;
      label: string;
    }) => {
      if (!currentUser) return;
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        onNotify('Connection Reconnecting', 'Walkie-Talkie server is reconnecting. Try again in a moment.', 'warning');
        return;
      }

      if (currentUser.role !== 'super_admin' && params.targetMode !== 'super_admin') {
        onNotify('Restricted Channel', 'Staff can only talk directly to Super Admin.', 'error');
        return;
      }

      if (stopMicRef.current) {
        stopWalkieTx();
      }

      try {
        await unlockSpeaker();
        setAudioUnlocked(isSpeakerUnlocked());
        pendingTxChunksRef.current = [];
        activeTxSessionRef.current = null;

        const stopCapture = await startMicCapture((pcmBase64, sampleRate, level) => {
          setMicLevel(level);
          const socket = wsRef.current;
          if (!socket || socket.readyState !== WebSocket.OPEN) return;
          const sid = activeTxSessionRef.current;
          if (!sid) {
            if (pendingTxChunksRef.current.length < 15) {
              pendingTxChunksRef.current.push({ pcmBase64, sampleRate });
            }
            return;
          }
          socket.send(
            JSON.stringify({
              type: 'wt:audio',
              sessionId: sid,
              sampleRate,
              pcmBase64,
            }),
          );
        });

        stopMicRef.current = stopCapture;
        txStartedAtRef.current = Date.now();
        setTxTargetLabel(params.label);
        setIsTransmitting(true);
        playWalkieChirp('start');

        ws.send(
          JSON.stringify({
            type: 'wt:start',
            targetMode: currentUser.role === 'super_admin' ? params.targetMode : 'super_admin',
            targetUid: params.targetUid,
            targetCentreId: params.targetCentreId,
          }),
        );
      } catch (err) {
        onNotify(
          'Microphone Unavailable',
          err instanceof Error ? err.message : 'Unable to activate Walkie-Talkie microphone.',
          'error',
        );
      }
    },
    [currentUser, onNotify, stopWalkieTx],
  );

  const sendChatPing = useCallback((staffUid: string, preview: string) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'chat:ping', staffUid, preview }));
    }
  }, []);

  return {
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
    unlockSpeaker: handleUnlockSpeaker,
    startWalkieTx,
    stopWalkieTx,
    sendChatPing,
  };
}
