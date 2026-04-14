import { Badge } from "@react-spectrum/s2";
import type { ConflictSeverity } from "@council/shared";

interface SeverityBadgeProps {
  severity: ConflictSeverity;
}

export function SeverityBadge({ severity }: SeverityBadgeProps) {
  return (
    <Badge variant={severity === "blocking" ? "negative" : "neutral"}>
      {severity === "blocking" ? "Blocking" : "Non-blocking"}
    </Badge>
  );
}
