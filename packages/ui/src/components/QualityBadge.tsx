import { Badge } from "@react-spectrum/s2";

function qualityVariant(score: number): "positive" | "yellow" | "negative" {
  if (score >= 0.7) return "positive";
  if (score >= 0.4) return "yellow";
  return "negative";
}

interface QualityBadgeProps {
  score: number;
}

export function QualityBadge({ score }: QualityBadgeProps) {
  const pct = Math.round(score * 100);
  return (
    <Badge variant={qualityVariant(score)}>
      Q: {pct}%
    </Badge>
  );
}
