import type {
  TunnelRequest,
  TunnelResponse,
  TunnelResponseChunk,
  TunnelMessage,
} from "@pim/shared";
import { TUNNEL_CHUNK_THRESHOLD, TUNNEL_WS_HEARTBEAT_MS } from "@pim/shared";

const MAX_RECONNECT_DELAY_MS = 30_000;

export class TunnelClient {
  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectDelay = 1_000;
  private closed = false;
  private connected = false;

  constructor(
    private serverWsUrl: string,
    private tunnelId: string,
    private localPort: number,
    private authToken?: string,
  ) {}

  async connect(): Promise<void> {
    this.connected = false;

    return new Promise<void>((resolve, reject) => {
      const params = new URLSearchParams({ tunnelId: this.tunnelId });
      if (this.authToken) params.set("token", this.authToken);
      const url = `${this.serverWsUrl}?${params.toString()}`;
      this.ws = new WebSocket(url);

      this.ws.onopen = () => {
        this.connected = true;
        this.reconnectDelay = 1_000;
        this.startHeartbeat();
        resolve();
      };

      this.ws.onmessage = (event) => {
        this.handleMessage(event.data as string);
      };

      this.ws.onclose = () => {
        this.stopHeartbeat();
        if (!this.connected) {
          // Connection never opened — reject the connect() promise
          reject(new Error("WebSocket connection failed"));
        } else if (!this.closed) {
          this.scheduleReconnect();
        }
        this.connected = false;
      };

      this.ws.onerror = () => {
        // Error details are intentionally limited by the spec.
        // The close event that follows will reject or trigger reconnect.
      };
    });
  }

  disconnect(): void {
    this.closed = true;
    this.stopHeartbeat();
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close(1000, "CLI shutting down");
    }
    this.ws = null;
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(
          JSON.stringify({ type: "tunnel_heartbeat", tunnelId: this.tunnelId }),
        );
      }
    }, TUNNEL_WS_HEARTBEAT_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleReconnect(): void {
    setTimeout(async () => {
      if (this.closed) return;
      try {
        await this.connect();
        process.stderr.write("[tunnel] Reconnected\n");
      } catch {
        // Will retry via onclose -> scheduleReconnect
      }
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(
      this.reconnectDelay * 2,
      MAX_RECONNECT_DELAY_MS,
    );
  }

  private handleMessage(data: string): void {
    let msg: TunnelMessage;
    try {
      msg = JSON.parse(data) as TunnelMessage;
    } catch {
      return;
    }

    switch (msg.type) {
      case "tunnel_request":
        this.forwardRequest(msg);
        break;
      case "tunnel_heartbeat_ack":
        // Server acknowledged heartbeat — nothing to do
        break;
      default:
        break;
    }
  }

  private async forwardRequest(req: TunnelRequest): Promise<void> {
    const localUrl = `http://localhost:${this.localPort}${req.path}`;

    try {
      // Build request options
      const init: RequestInit = {
        method: req.method,
        headers: req.headers,
      };

      if (req.body && !["GET", "HEAD"].includes(req.method)) {
        init.body = Buffer.from(req.body, "base64");
      }

      const res = await fetch(localUrl, init);

      // Read response body as ArrayBuffer
      const bodyBuf = Buffer.from(await res.arrayBuffer());

      // Collect response headers
      const headers: Record<string, string> = {};
      res.headers.forEach((val, key) => {
        headers[key] = val;
      });

      if (bodyBuf.length < TUNNEL_CHUNK_THRESHOLD) {
        // Single response message
        const tunnelRes: TunnelResponse = {
          type: "tunnel_response",
          requestId: req.requestId,
          statusCode: res.status,
          headers,
          body: bodyBuf.length > 0 ? bodyBuf.toString("base64") : null,
        };
        this.send(tunnelRes);
      } else {
        // Chunked response
        this.sendChunked(req.requestId, res.status, headers, bodyBuf);
      }
    } catch (err) {
      // Local server unreachable
      this.send({
        type: "tunnel_error",
        requestId: req.requestId,
        error: `Local server error: ${err instanceof Error ? err.message : "unknown"}`,
      });
    }
  }

  private sendChunked(
    requestId: string,
    statusCode: number,
    headers: Record<string, string>,
    body: Buffer,
  ): void {
    let offset = 0;
    let first = true;

    while (offset < body.length) {
      const end = Math.min(offset + TUNNEL_CHUNK_THRESHOLD, body.length);
      const chunk = body.subarray(offset, end);
      const done = end >= body.length;

      const msg: TunnelResponseChunk = {
        type: "tunnel_response_chunk",
        requestId,
        chunk: chunk.toString("base64"),
        done,
      };

      // Include headers on first chunk
      if (first) {
        msg.statusCode = statusCode;
        msg.headers = headers;
        first = false;
      }

      this.send(msg);
      offset = end;
    }
  }

  private send(msg: TunnelMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }
}
