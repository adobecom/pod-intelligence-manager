import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Heading,
  Text,
  Button,
  Badge,
  InlineAlert,
  Content,
  Divider,
  TextField,
  NumberField,
} from "@react-spectrum/s2";
import { style } from "@react-spectrum/s2/style" with { type: "macro" };
import { useOrgStore } from "../../stores/orgStore";
import { PressureMeter } from "../../components/PressureMeter";

const page = style({ padding: 24 });
const column = style({ display: "flex", flexDirection: "column", gap: 32 });
const podGrid = style({ display: "flex", gap: 16, flexWrap: "wrap" });

const podCard = style({
  width: "[320px]",
  backgroundColor: "layer-1",
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
  backgroundColor: "layer-1",
  borderRadius: "default",
  padding: 16,
  borderWidth: 1,
  borderStyle: "solid",
  borderColor: "gray-200",
});

const archiveRow = style({ display: "flex", justifyContent: "space-between", alignItems: "center" });
const archiveInfo = style({ display: "flex", flexDirection: "column", gap: 4 });
const createFormCard = style({
  backgroundColor: "layer-1",
  padding: 20,
  borderRadius: "default",
  borderWidth: 1,
  borderStyle: "solid",
  borderColor: "gray-300",
});
const createFormContent = style({ display: "flex", flexDirection: "column", gap: 12 });
const createFormActions = style({ display: "flex", gap: 12, justifyContent: "end" });
const sectionHeader = style({ display: "flex", alignItems: "center", justifyContent: "space-between" });

export function OrgDashboard() {
  const { pods, overlaps, archivedPods, loading, loadOrg, createPod, archivePod } = useOrgStore();
  const navigate = useNavigate();
  const [showCreate, setShowCreate] = useState(false);
  const [podName, setPodName] = useState("");
  const [sprintDays, setSprintDays] = useState(5);
  const [milestoneName, setMilestoneName] = useState("Sprint Goal");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  useEffect(() => {
    loadOrg();
  }, [loadOrg]);

  async function handleCreate() {
    if (!podName.trim()) return;
    setCreating(true);
    setCreateError(null);
    try {
      const pod = await createPod({
        name: podName.trim(),
        sprint_days: sprintDays,
        milestone_name: milestoneName.trim() || "Sprint Goal",
      });
      setPodName("");
      setShowCreate(false);
      navigate(`/pod/${pod.pod_id}`);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Failed to create pod");
    } finally {
      setCreating(false);
    }
  }

  async function handleArchive(podId: string, podName: string) {
    if (!confirm(`Archive pod "${podName}"? This cannot be undone.`)) return;
    try {
      await archivePod(podId);
    } catch {
      // Org data will be refreshed anyway
    }
  }

  if (loading) return null;

  return (
    <div className={page}>
      <div className={column}>
        <Heading level={2} styles={style({ marginY: 0 })}>
          Organization Dashboard
        </Heading>

        {/* Active Pods */}
        <div className={sectionHeader}>
          <Heading level={3}>Active Pods ({pods.length})</Heading>
          <Button
            variant={showCreate ? "secondary" : "accent"}
            onPress={() => { setShowCreate(!showCreate); setCreateError(null); }}
          >
            {showCreate ? "Cancel" : "Create Pod"}
          </Button>
        </div>

        {showCreate && (
          <div className={createFormCard}>
            <div className={createFormContent}>
              {createError && (
                <InlineAlert variant="negative">
                  <Content>{createError}</Content>
                </InlineAlert>
              )}
              <TextField
                label="Pod Name"
                value={podName}
                onChange={setPodName}
                isRequired
              />
              <NumberField
                label="Sprint Duration (days)"
                value={sprintDays}
                onChange={setSprintDays}
                minValue={1}
                maxValue={30}
              />
              <TextField
                label="Milestone Name"
                value={milestoneName}
                onChange={setMilestoneName}
              />
              <div className={createFormActions}>
                <Button
                  variant="accent"
                  onPress={handleCreate}
                  isDisabled={!podName.trim() || creating}
                  isPending={creating}
                >
                  Create Pod
                </Button>
              </div>
            </div>
          </div>
        )}

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

                <div className={style({ display: "flex", gap: 8 })}>
                  <Button
                    variant="primary"
                    onPress={() => navigate(`/pod/${pod.pod_id}`)}
                  >
                    Open Pod
                  </Button>
                  <Button
                    variant="secondary"
                    onPress={() => handleArchive(pod.pod_id, pod.name)}
                  >
                    Archive
                  </Button>
                </div>
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
                      <Text styles={style({ font: "body-2xs", color: "neutral-subdued" })}>
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
