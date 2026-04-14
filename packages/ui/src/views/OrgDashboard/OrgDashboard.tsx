import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import {
  Heading,
  Text,
  Button,
  Badge,
  InlineAlert,
  Content,
  Divider,
} from "@react-spectrum/s2";
import { style } from "@react-spectrum/s2/style" with { type: "macro" };
import { useOrgStore } from "../../stores/orgStore";
import { PressureMeter } from "../../components/PressureMeter";

const page = style({ padding: 24 });
const column = style({ display: "flex", flexDirection: "column", gap: 32 });
const podGrid = style({ display: "flex", gap: 16, flexWrap: "wrap" });

const podCard = style({
  width: "[320px]",
  backgroundColor: "gray-75",
  padding: 20,
  borderRadius: "default",
  borderWidth: 1,
  borderStyle: "solid",
  borderColor: "gray-300",
});

const podCardContent = style({ display: "flex", flexDirection: "column", gap: 12 });
const podCardHeader = style({ display: "flex", justifyContent: "space-between", alignItems: "center" });
const statsRow = style({ display: "flex", gap: 16, flexWrap: "wrap" });
const overlapColumn = style({ display: "flex", flexDirection: "column", gap: 12 });
const archiveColumn = style({ display: "flex", flexDirection: "column", gap: 8 });

const archiveCard = style({
  backgroundColor: "gray-75",
  borderRadius: "default",
  padding: 16,
  borderWidth: 1,
  borderStyle: "solid",
  borderColor: "gray-200",
});

const archiveRow = style({ display: "flex", justifyContent: "space-between", alignItems: "center" });
const archiveInfo = style({ display: "flex", flexDirection: "column", gap: 4 });

export function OrgDashboard() {
  const { pods, overlaps, archivedPods, loading, loadOrg } = useOrgStore();
  const navigate = useNavigate();

  useEffect(() => {
    loadOrg();
  }, [loadOrg]);

  if (loading) return null;

  return (
    <div className={page}>
      <div className={column}>
        <Heading level={2} styles={style({ marginY: 0 })}>
          Organization Dashboard
        </Heading>

        {/* Active Pods */}
        <Heading level={3}>Active Pods ({pods.length})</Heading>
        <div className={podGrid}>
          {pods.map((pod) => (
            <div key={pod.pod_id} className={podCard}>
              <div className={podCardContent}>
                <div className={podCardHeader}>
                  <Text styles={style({ fontWeight: "bold", font: "body-lg" })}>
                    {pod.name}
                  </Text>
                  <Badge variant="informative">
                    Day {pod.day_number}/{pod.total_days}
                  </Badge>
                </div>

                <PressureMeter value={pod.conflict_pressure} size="S" />

                <div className={statsRow}>
                  <Text styles={style({ font: "body-2xs" })}>
                    Conflicts: {pod.open_conflicts}
                  </Text>
                  <Text styles={style({ font: "body-2xs" })}>
                    Tunnels: {pod.active_tunnels}
                  </Text>
                  <Text styles={style({ font: "body-2xs" })}>
                    Agents: {pod.agent_count}
                  </Text>
                </div>

                <Button
                  variant="primary"
                  onPress={() => navigate(`/pod/${pod.pod_id}`)}
                >
                  Open Pod
                </Button>
              </div>
            </div>
          ))}
        </div>

        {/* Cross-Pod Overlaps */}
        {overlaps.length > 0 && (
          <>
            <Heading level={3}>Cross-Pod Overlaps</Heading>
            <div className={overlapColumn}>
              {overlaps.map((overlap) => (
                <InlineAlert key={overlap.id} variant="notice">
                  <Heading>
                    {overlap.pod_a} ↔ {overlap.pod_b}: {overlap.description}
                  </Heading>
                  <Content>{overlap.advisory}</Content>
                </InlineAlert>
              ))}
            </div>
          </>
        )}

        {/* Archived Pods */}
        {archivedPods.length > 0 && (
          <>
            <Divider />
            <Heading level={3}>Archived Pods</Heading>
            <div className={archiveColumn}>
              {archivedPods.map((pod) => (
                <div key={pod.pod_id} className={archiveCard}>
                  <div className={archiveRow}>
                    <div className={archiveInfo}>
                      <Text styles={style({ fontWeight: "bold" })}>
                        {pod.name}
                      </Text>
                      <Text styles={style({ font: "body-2xs", color: "gray-600" })}>
                        Completed: {pod.completed_date} · {pod.duration_days}{" "}
                        days · Final pressure: {pod.final_pressure.toFixed(2)}
                      </Text>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
