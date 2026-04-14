import { style } from "@react-spectrum/s2/style" with { type: "macro" };
import { usePodStore } from "../../stores/podStore";
import { PodHeader } from "./PodHeader";
import { HealthBanner } from "./HealthBanner";
import { ConflictPressureGauge } from "./ConflictPressureGauge";
import { MilestoneProgress } from "./MilestoneProgress";
import { StatusByArea } from "./StatusByArea";
import { OpenConflictsList } from "./OpenConflictsList";
import { ActiveTunnelsSummary } from "./ActiveTunnelsSummary";
import { RecentActivity } from "./RecentActivity";
import { LintFindings } from "./LintFindings";

const column = style({
  display: "flex",
  flexDirection: "column",
  gap: 20,
});

const row = style({
  display: "flex",
  gap: 20,
  flexWrap: "wrap",
});

const halfPanel = style({
  flexGrow: 1,
  flexBasis: "[280px]",
  minWidth: 0,
});

export function PodDashboard() {
  const pod = usePodStore((s) => s.pod);
  const openConflictCount = usePodStore(
    (s) => s.conflicts.filter((c) => c.status !== "resolved").length,
  );

  if (!pod) return null;

  return (
    <div className={column}>
      <HealthBanner
        pressure={pod.conflict_pressure}
        openConflicts={openConflictCount}
      />
      <PodHeader pod={pod} />

      <div className={row}>
        <div className={halfPanel}>
          <ConflictPressureGauge pressure={pod.conflict_pressure} />
        </div>
        <div className={halfPanel}>
          <MilestoneProgress milestone={pod.milestone} />
        </div>
      </div>

      <StatusByArea areas={pod.areas} />

      <div className={row}>
        <div className={halfPanel}>
          <OpenConflictsList />
        </div>
        <div className={halfPanel}>
          <ActiveTunnelsSummary />
        </div>
      </div>

      <RecentActivity />

      <LintFindings />
    </div>
  );
}
