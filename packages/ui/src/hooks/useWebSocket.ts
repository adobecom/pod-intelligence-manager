import { useEffect, useRef } from "react";

interface WSEvent {
  type: string;
  podId: string;
  payload: unknown;
}

export function useWebSocket(
  podId: string | undefined,
  onEvent: (event: WSEvent) => void,
) {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (!podId) return;

    let closed = false;

    function connect() {
      if (closed) return;

      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${protocol}//${window.location.host}/ws?podId=${podId}`);
      wsRef.current = ws;

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as WSEvent;
          onEvent(data);
        } catch {
          // ignore malformed messages
        }
      };

      ws.onclose = () => {
        if (!closed) {
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
      clearTimeout(reconnectTimeout.current);
      wsRef.current?.close();
    };
  }, [podId, onEvent]);
}
