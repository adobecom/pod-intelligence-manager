import { StatusLight } from "@react-spectrum/s2";
import type { AreaStatus } from "@pim/shared";

const statusConfig: Record<
  AreaStatus,
  { variant: "positive" | "notice" | "neutral" | "negative"; label: string }
> = {
  done: { variant: "positive", label: "Done" },
  in_progress: { variant: "notice", label: "In Progress" },
  waiting: { variant: "neutral", label: "Waiting" },
  blocked: { variant: "negative", label: "Blocked" },
};

interface StatusIndicatorProps {
  status: AreaStatus;
}

export function StatusIndicator({ status }: StatusIndicatorProps) {
  const { variant, label } = statusConfig[status];
  return <StatusLight variant={variant}>{label}</StatusLight>;
}
