import { StatusLight } from "@react-spectrum/s2";
import type { TunnelStatus } from "@pim/shared";

const statusConfig: Record<
  TunnelStatus,
  { variant: "positive" | "notice" | "negative"; label: string }
> = {
  active: { variant: "positive", label: "Live" },
  idle: { variant: "notice", label: "Idle" },
  disconnected: { variant: "negative", label: "Disconnected" },
};

interface TunnelStatusLightProps {
  status: TunnelStatus;
}

export function TunnelStatusLight({ status }: TunnelStatusLightProps) {
  const { variant, label } = statusConfig[status];
  return <StatusLight variant={variant}>{label}</StatusLight>;
}
