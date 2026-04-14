import { InlineAlert, Heading, Content } from "@react-spectrum/s2";
import { getPressureLevel } from "@council/shared";

interface HealthBannerProps {
  pressure: number;
  openConflicts: number;
}

export function HealthBanner({ pressure, openConflicts }: HealthBannerProps) {
  const level = getPressureLevel(pressure);

  if (level === "normal" || level === "cautious") return null;

  const isCritical = level === "critical";

  return (
    <InlineAlert variant={isCritical ? "negative" : "notice"}>
      <Heading>
        Council Health: {isCritical ? "Critical" : "Degraded"}
      </Heading>
      <Content>
        {isCritical
          ? `${openConflicts} open conflict(s). Ingestion is paused for contested areas. Resolve blocking conflicts immediately.`
          : `${openConflicts} open conflict(s). Contested updates are being held in a pending queue.`}
      </Content>
    </InlineAlert>
  );
}
