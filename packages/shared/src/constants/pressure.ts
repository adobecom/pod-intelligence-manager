export const PRESSURE_THRESHOLDS = {
  NORMAL_MAX: 0.3,
  CAUTIOUS_MAX: 0.6,
  DEGRADED_MAX: 0.8,
} as const;

export type PressureLevel = "normal" | "cautious" | "degraded" | "critical";

export function getPressureLevel(
  pressure: number,
  thresholds?: { cautiousMax?: number; degradedMax?: number },
): PressureLevel {
  const normalMax = PRESSURE_THRESHOLDS.NORMAL_MAX;
  const cautiousMax = thresholds?.cautiousMax ?? PRESSURE_THRESHOLDS.CAUTIOUS_MAX;
  const degradedMax = thresholds?.degradedMax ?? PRESSURE_THRESHOLDS.DEGRADED_MAX;
  if (pressure <= normalMax) return "normal";
  if (pressure <= cautiousMax) return "cautious";
  if (pressure <= degradedMax) return "degraded";
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
