export interface Tunnel {
  tunnel_id: string;
  pod_id: string;
  dev_name: string;
  branch: string;
  url: string;
  status: TunnelStatus;
  last_activity: string;
}

export type TunnelStatus = "active" | "idle" | "disconnected";
