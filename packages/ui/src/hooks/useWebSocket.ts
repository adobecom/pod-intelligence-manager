import { useEffect, useRef, useState } from "react";

interface WSEvent {
  type: string;
  podId?: string;
  payload?: unknown;
}

export type WSStatus = "connecting" | "connected" | "disconnected";

/**
 * Subscribe to real-time council events. The server multiplexes rooms by `podId` query param;
 * use roomId `"global"` for org-wide broadcasts (e.g. project context updates).
 */
export function useWebSocket(
  roomId: string | undefined,
  onEvent: (event: WSEvent) => void,
): WSStatus {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  const [status, setStatus] = useState<WSStatus>("disconnected");

  useEffect(() => {
    if (!roomId) {
      setStatus("disconnected");
      return;
    }

    const stableRoomId = roomId;
    let closed = false;

    function connect() {
      if (closed) return;

      setStatus("connecting");
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${protocol}//${window.location.host}/ws?podId=${encodeURIComponent(stableRoomId)}`);
      wsRef.current = ws;

      ws.onopen = () => {
        if (!closed) setStatus("connected");
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as WSEvent;
          onEventRef.current(data);
        } catch {
          // ignore malformed messages
        }
      };

      ws.onclose = () => {
        if (!closed) {
          setStatus("disconnected");
          // Reconnect with backoff
          reconnectTimeout.current = setTimeout(connect, 2000);
        }
      };

      ws.onerror = () => {
        ws.close();
      };
    }

    connect();

    return () => {
      closed = true;
      setStatus("disconnected");
      clearTimeout(reconnectTimeout.current);
      wsRef.current?.close();
    };
  }, [roomId]);

  return status;
}
