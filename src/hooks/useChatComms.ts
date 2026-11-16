import { useCallback, useEffect, useRef, useState } from 'react';
import { auth } from '../lib/firebase';
import type { OnlineUserPresence, UserAccount } from '../types/domain';

interface UseChatCommsOptions {
  currentUser: UserAccount | null;
  onIncomingChatPing?: (payload: { fromName: string; staffUid: string; preview: string }) => void;
}

export function useChatComms({ currentUser, onIncomingChatPing }: UseChatCommsOptions) {
  const [wsConnected, setWsConnected] = useState(false);
  const [onlineStaff, setOnlineStaff] = useState<OnlineUserPresence[]>([]);
  const [superAdminOnline, setSuperAdminOnline] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const onIncomingChatPingRef = useRef(onIncomingChatPing);
  onIncomingChatPingRef.current = onIncomingChatPing;

  useEffect(() => {
    if (!currentUser) {
      setWsConnected(false);
      setOnlineStaff([]);
      setSuperAdminOnline(false);
      return;
    }

    let disposed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let pingTimer: ReturnType<typeof setInterval> | null = null;
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

        if (msgType === 'chat:incoming') {
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
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [currentUser?.uid]);

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
    sendChatPing,
  };
}
