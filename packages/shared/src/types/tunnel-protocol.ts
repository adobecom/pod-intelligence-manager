/** HTTP-over-WebSocket tunnel protocol messages. */

/** Server -> CLI: serialized HTTP request to forward to localhost. */
export interface TunnelRequest {
  type: "tunnel_request";
  requestId: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string | null; // base64-encoded, null for bodyless methods
}

/** CLI -> Server: full HTTP response (body < 256 KB). */
export interface TunnelResponse {
  type: "tunnel_response";
  requestId: string;
  statusCode: number;
  headers: Record<string, string>;
  body: string | null; // base64-encoded
}

/** CLI -> Server: chunked response for large bodies (>= 256 KB). */
export interface TunnelResponseChunk {
  type: "tunnel_response_chunk";
  requestId: string;
  statusCode?: number; // present on first chunk
  headers?: Record<string, string>; // present on first chunk
  chunk: string; // base64-encoded
  done: boolean;
}

/** CLI -> Server: WebSocket-level keepalive. */
export interface TunnelHeartbeat {
  type: "tunnel_heartbeat";
  tunnelId: string;
}

/** Server -> CLI: keepalive acknowledgement. */
export interface TunnelHeartbeatAck {
  type: "tunnel_heartbeat_ack";
}

/** Either direction: error report. */
export interface TunnelError {
  type: "tunnel_error";
  requestId?: string;
  error: string;
}

export type TunnelMessage =
  | TunnelRequest
  | TunnelResponse
  | TunnelResponseChunk
  | TunnelHeartbeat
  | TunnelHeartbeatAck
  | TunnelError;

/** Threshold in bytes above which responses are chunked. */
export const TUNNEL_CHUNK_THRESHOLD = 256 * 1024; // 256 KB

/** Timeout in ms for the server to wait for a CLI response. */
export const TUNNEL_REQUEST_TIMEOUT_MS = 30_000;

/** CLI WebSocket heartbeat interval in ms. */
export const TUNNEL_WS_HEARTBEAT_MS = 30_000;
