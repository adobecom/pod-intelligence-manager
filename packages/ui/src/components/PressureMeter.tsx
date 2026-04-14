import { Meter, Text } from "@react-spectrum/s2";
import { style } from "@react-spectrum/s2/style" with { type: "macro" };
import {
  getPressureLevel,
  getPressureLabel,
  type PressureLevel,
} from "@council/shared";

function meterVariant(
  level: PressureLevel,
): "positive" | "notice" | "negative" {
  switch (level) {
    case "normal":
      return "positive";
    case "cautious":
      return "notice";
    case "degraded":
    case "critical":
      return "negative";
  }
}

const container = style({
  display: "flex",
  flexDirection: "column",
  gap: 4,
});

const labelText = style({
  font: "body-2xs",
  color: "gray-600",
});

interface PressureMeterProps {
  value: number;
  size?: "S" | "L";
  showLabel?: boolean;
}

export function PressureMeter({
  value,
  size = "L",
  showLabel = true,
}: PressureMeterProps) {
  const level = getPressureLevel(value);
  const label = getPressureLabel(level);
  const displayValue = Math.round(value * 100);

  return (
    <div className={container}>
      <Meter
        label="Conflict Pressure"
        value={displayValue}
        variant={meterVariant(level)}
        size={size}
      />
      {showLabel && (
        <Text styles={labelText}>
          {value.toFixed(2)} — {label}
        </Text>
      )}
    </div>
  );
}
