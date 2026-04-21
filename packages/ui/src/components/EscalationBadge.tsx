import { Badge } from "@react-spectrum/s2";

interface EscalationBadgeProps {
  level: number;
  compact?: boolean;
}

export function EscalationBadge({ level, compact = false }: EscalationBadgeProps) {
  if (!level || level <= 0) return null;
  return (
    <Badge variant={level >= 3 ? "negative" : "notice"}>
      {compact ? `L${level}` : `Escalation L${level}`}
    </Badge>
  );
}
