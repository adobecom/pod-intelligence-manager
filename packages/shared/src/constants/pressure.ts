export const PRESSURE_THRESHOLDS = {
  NORMAL_MAX: 0.3,
  CAUTIOUS_MAX: 0.6,
  DEGRADED_MAX: 0.8,
} as const;

export type PressureLevel = "normal" | "cautious" | "degraded" | "critical";

export function getPressureLevel(pressure: number): PressureLevel {
  if (pressure <= PRESSURE_THRESHOLDS.NORMAL_MAX) return "normal";
  if (pressure <= PRESSURE_THRESHOLDS.CAUTIOUS_MAX) return "cautious";
  if (pressure <= PRESSURE_THRESHOLDS.DEGRADED_MAX) return "degraded";
  return "critical";
}

export function getPressureLabel(level: PressureLevel): string {
  switch (level) {
    case "normal":
      return "Normal";
    case "cautious":
      return "Cautious";
    case "degraded":
      return "Degraded";
    case "critical":
      return "Critical";
  }
}
