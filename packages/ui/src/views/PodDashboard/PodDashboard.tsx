import { style } from "@react-spectrum/s2/style" with { type: "macro" };
import { usePodStore } from "../../stores/podStore";
import { useOrgStore } from "../../stores/orgStore";
import { PodHeader } from "./PodHeader";
import { PodProjectAssociation } from "./PodProjectAssociation";
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
  const orgTuning = useOrgStore((s) => s.orgTuning);
  const pressureThresholds = orgTuning
    ? { cautiousMax: orgTuning.pressure.cautiousMax, degradedMax: orgTuning.pressure.degradedMax }
    : undefined;

  if (!pod) return null;

  return (
    <div className={column}>
      <HealthBanner
        pressure={pod.conflict_pressure}
        openConflicts={openConflictCount}
        thresholds={pressureThresholds}
      />
      <PodHeader pod={pod} />

      <PodProjectAssociation />

      <div className={row}>
        <div className={halfPanel}>
          <ConflictPressureGauge pressure={pod.conflict_pressure} thresholds={pressureThresholds} />
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
