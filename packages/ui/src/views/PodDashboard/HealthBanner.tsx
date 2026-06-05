import { InlineAlert, Heading, Content } from "@react-spectrum/s2";
import { getPressureLevel } from "@pim/shared";

interface HealthBannerProps {
  pressure: number;
  openConflicts: number;
  thresholds?: { cautiousMax?: number; degradedMax?: number };
}

export function HealthBanner({ pressure, openConflicts, thresholds }: HealthBannerProps) {
  const level = getPressureLevel(pressure, thresholds);

  if (level === "normal" || level === "cautious") return null;

  const isCritical = level === "critical";

  return (
    <InlineAlert variant={isCritical ? "negative" : "notice"}>
      <Heading>
        PIM Health: {isCritical ? "Critical" : "Degraded"}
      </Heading>
      <Content>
        {isCritical
          ? `${openConflicts} open conflict(s). New updates are queued (202) until pressure drops — orchestration is deferred. Resolve blocking conflicts immediately.`
          : `${openConflicts} open conflict(s). Updates in scopes tied to open conflicts are held with merge notes until resolved.`}
      </Content>
    </InlineAlert>
  );
}
