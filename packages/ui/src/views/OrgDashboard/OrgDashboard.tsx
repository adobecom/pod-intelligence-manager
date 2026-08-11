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
  Picker,
  PickerItem,
  Dialog,
  DialogTrigger,
  ButtonGroup,
  ProgressBar,
} from "@react-spectrum/s2";
import { style } from "@react-spectrum/s2/style" with { type: "macro" };
import type { OrgScopeDefinition, OrgTuning } from "@pim/shared";
import { DEFAULT_ORG_TUNING } from "@pim/shared";
import { useOrgStore } from "../../stores/orgStore";
import { PressureMeter } from "../../components/PressureMeter";
import * as api from "../../services/api";

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

type ArchiveFlow =
  | { kind: "pod"; phase: "confirm"; podId: string; podName: string }
  | { kind: "pod"; phase: "running"; podId: string; podName: string }
  | {
      kind: "pod";
      phase: "success";
      podId: string;
      podName: string;
      learnings_extracted?: number;
      candidates_submitted?: number;
    }
  | { kind: "pod"; phase: "error"; podId: string; podName: string; message: string }
  | { kind: "project"; phase: "confirm"; projectId: string; projectName: string }
  | { kind: "project"; phase: "running"; projectId: string; projectName: string }
  | { kind: "project"; phase: "success"; projectId: string; projectName: string }
  | { kind: "project"; phase: "error"; projectId: string; projectName: string; message: string };

function formatParamLabel(parameter: string): string {
  const labels: Record<string, string> = {
    "conflictScout.additiveMinConf":     "Conflict detection sensitivity",
    "conflictScout.overlapForceMinConf": "Overlap force conflict threshold",
    "pressure.normalMax":                "Normal pressure ceiling",
    "pressure.cautiousMax":              "Caution pressure ceiling",
    "pressure.degradedMax":              "Degraded pressure ceiling",
    "lint.stalenessHours":               "Staleness alert threshold (h)",
  };
  return labels[parameter] ?? parameter;
}

function formatSignalLabel(signal: string): string {
  const labels: Record<string, string> = {
    conflict_false_positive_rate: "Conflict FP rate",
    avg_final_pressure:           "Avg final pressure",
    staleness_aggression_rate:    "Staleness aggression rate",
  };
  return labels[signal] ?? signal;
}

function DriftBadge({ current, defaultVal }: { current: number; defaultVal: number }) {
  if (Math.abs(current - defaultVal) < 0.001) {
    return <Text styles={style({ font: "body-2xs", color: "neutral-subdued" })}>(default)</Text>;
  }
  const up = current > defaultVal;
  return (
    <Text styles={style({ font: "body-2xs", color: "neutral-subdued" })}>
      {up ? "↑" : "↓"} from {typeof defaultVal === "number" && defaultVal % 1 !== 0 ? defaultVal.toFixed(2) : defaultVal}
    </Text>
  );
}

export function OrgDashboard() {
  const {
    pods,
    projects,
    overlaps,
    archivedPods,
    archivedProjects,
    orgConfig,
    orgTuning,
    tuningHistory,
    loading,
    loadOrg,
    loadOrgTuning,
    resetOrgTuning,
    saveOrgConfig,
    createPod,
    createProject,
    archivePod,
    archiveProject,
  } = useOrgStore();
  const navigate = useNavigate();
  const [showTuning, setShowTuning] = useState(false);
  const [resettingTuning, setResettingTuning] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [podName, setPodName] = useState("");
  const [sprintDays, setSprintDays] = useState(5);
  const [milestoneName, setMilestoneName] = useState("Sprint Goal");
  const [linkProjectId, setLinkProjectId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [showCreateProject, setShowCreateProject] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [projectDescription, setProjectDescription] = useState("");
  const [creatingProject, setCreatingProject] = useState(false);
  const [projectCreateError, setProjectCreateError] = useState<string | null>(null);

  const [archiveFlow, setArchiveFlow] = useState<ArchiveFlow | null>(null);

  const [scopeDraft, setScopeDraft] = useState<OrgScopeDefinition[]>([]);
  const [orgConfigSaveError, setOrgConfigSaveError] = useState<string | null>(null);
  const [savingOrgConfig, setSavingOrgConfig] = useState(false);
  const [catalogConfig, setCatalogConfig] =
    useState<api.SkillCatalogConfiguration | null>(null);
  const [catalogDefaultDraft, setCatalogDefaultDraft] = useState<string | null>(
    null,
  );
  const [catalogConfigError, setCatalogConfigError] = useState<string | null>(
    null,
  );
  const [savingCatalogConfig, setSavingCatalogConfig] = useState(false);

  useEffect(() => {
    loadOrg();
    loadOrgTuning();
    let cancelled = false;
    void api
      .getSkillCatalogConfiguration()
      .then((configuration) => {
        if (cancelled) return;
        setCatalogConfig(configuration);
        setCatalogDefaultDraft(
          configuration.selection.orgDefaultSourceId,
        );
        setCatalogConfigError(null);
      })
      .catch((error) => {
        if (!cancelled) {
          setCatalogConfigError(
            error instanceof Error
              ? error.message
              : "Failed to load skill catalog configuration",
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [loadOrg, loadOrgTuning]);

  useEffect(() => {
    if (orgConfig) {
      setScopeDraft(orgConfig.scopes.map(s => ({ ...s })));
    }
  }, [orgConfig]);

  async function handleResetTuning() {
    setResettingTuning(true);
    try {
      await resetOrgTuning();
    } finally {
      setResettingTuning(false);
    }
  }

  useEffect(() => {
    if (!archiveFlow || archiveFlow.phase !== "running") return;
    let cancelled = false;
    (async () => {
      try {
        if (archiveFlow.kind === "pod") {
          const res = await archivePod(archiveFlow.podId);
          if (!cancelled) {
            setArchiveFlow({
              kind: "pod",
              phase: "success",
              podId: archiveFlow.podId,
              podName: archiveFlow.podName,
              learnings_extracted: res.learnings_extracted,
              candidates_submitted: res.canonical_memory_intake?.candidates_submitted,
            });
          }
        } else {
          await archiveProject(archiveFlow.projectId);
          if (!cancelled) {
            setArchiveFlow({
              kind: "project",
              phase: "success",
              projectId: archiveFlow.projectId,
              projectName: archiveFlow.projectName,
            });
          }
        }
      } catch (err) {
        if (!cancelled) {
          if (archiveFlow.kind === "pod") {
            setArchiveFlow({
              kind: "pod",
              phase: "error",
              podId: archiveFlow.podId,
              podName: archiveFlow.podName,
              message: err instanceof Error ? err.message : "Archive failed",
            });
          } else {
            setArchiveFlow({
              kind: "project",
              phase: "error",
              projectId: archiveFlow.projectId,
              projectName: archiveFlow.projectName,
              message: err instanceof Error ? err.message : "Archive failed",
            });
          }
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [archiveFlow, archivePod, archiveProject]);

  async function handleCreate() {
    if (!podName.trim()) return;
    setCreating(true);
    setCreateError(null);
    try {
      const pod = await createPod({
        name: podName.trim(),
        sprint_days: sprintDays,
        milestone_name: milestoneName.trim() || "Sprint Goal",
        ...(linkProjectId ? { project_id: linkProjectId } : {}),
      });
      setPodName("");
      setLinkProjectId(null);
      setShowCreate(false);
      navigate(`/pod/${pod.pod_id}`);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Failed to create pod");
    } finally {
      setCreating(false);
    }
  }

  async function handleCreateProject() {
    if (!projectName.trim()) return;
    setCreatingProject(true);
    setProjectCreateError(null);
    try {
      const project = await createProject({
        name: projectName.trim(),
        description: projectDescription.trim() || undefined,
      });
      setProjectName("");
      setProjectDescription("");
      setShowCreateProject(false);
      navigate(`/project/${project.project_id}`);
    } catch (err) {
      setProjectCreateError(err instanceof Error ? err.message : "Failed to create project");
    } finally {
      setCreatingProject(false);
    }
  }

  function openArchiveDialog(podId: string, podName: string) {
    setArchiveFlow({ kind: "pod", phase: "confirm", podId, podName });
  }

  function openArchiveProjectDialog(projectId: string, projectName: string) {
    setArchiveFlow({ kind: "project", phase: "confirm", projectId, projectName });
  }

  async function handleSaveOrgConfig() {
    setOrgConfigSaveError(null);
    setSavingOrgConfig(true);
    try {
      await saveOrgConfig({ scopes: scopeDraft });
    } catch (err) {
      setOrgConfigSaveError(err instanceof Error ? err.message : "Failed to save org config");
    } finally {
      setSavingOrgConfig(false);
    }
  }

  async function handleSaveCatalogDefault() {
    setCatalogConfigError(null);
    setSavingCatalogConfig(true);
    try {
      const configuration = await api.putOrgDefaultSkillCatalogSource(
        catalogDefaultDraft,
      );
      setCatalogConfig(configuration);
      setCatalogDefaultDraft(configuration.selection.orgDefaultSourceId);
    } catch (err) {
      setCatalogConfigError(
        err instanceof Error
          ? err.message
          : "Failed to save skill catalog configuration",
      );
    } finally {
      setSavingCatalogConfig(false);
    }
  }

  if (loading) return null;

  return (
    <div className={page}>
      <div className={column}>
        <Heading level={2} styles={style({ marginY: 0 })}>
          Organization Dashboard
        </Heading>

        {/* Projects (long-lived initiatives) */}
        <div className={sectionHeader}>
          <Heading level={3}>Projects ({projects.length})</Heading>
          <Button
            variant={showCreateProject ? "secondary" : "accent"}
            onPress={() => {
              setShowCreateProject(!showCreateProject);
              setProjectCreateError(null);
            }}
          >
            {showCreateProject ? "Cancel" : "Create Project"}
          </Button>
        </div>

        {showCreateProject && (
          <div className={createFormCard}>
            <div className={createFormContent}>
              {projectCreateError && (
                <InlineAlert variant="negative">
                  <Content>{projectCreateError}</Content>
                </InlineAlert>
              )}
              <TextField
                label="Project Name"
                value={projectName}
                onChange={setProjectName}
                isRequired
              />
              <TextField
                label="Description"
                value={projectDescription}
                onChange={setProjectDescription}
              />
              <div className={createFormActions}>
                <Button
                  variant="accent"
                  onPress={handleCreateProject}
                  isDisabled={!projectName.trim() || creatingProject}
                  isPending={creatingProject}
                >
                  Create Project
                </Button>
              </div>
            </div>
          </div>
        )}

        <div className={podGrid}>
          {projects.map((project) => (
            <div key={project.project_id} className={podCard}>
              <div className={podCardContent}>
                <div className={podCardHeader}>
                  <Text styles={style({ fontWeight: "bold", font: "body-lg" })}>
                    {project.name}
                  </Text>
                  <Badge variant="neutral">Initiative</Badge>
                </div>
                <Text styles={style({ font: "body-2xs", color: "neutral-subdued" })}>
                  {project.project_id}
                </Text>
                {project.description && (
                  <Text styles={style({ font: "body-sm" })}>{project.description}</Text>
                )}
                <div className={style({ display: "flex", gap: 8 })}>
                  <Button
                    variant="primary"
                    onPress={() => navigate(`/project/${project.project_id}`)}
                  >
                    Open Project
                  </Button>
                  <Button
                    variant="secondary"
                    onPress={() => openArchiveProjectDialog(project.project_id, project.name)}
                  >
                    Archive
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>

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
              <Picker
                label="Link to project"
                description="Optional — attach this sprint to an initiative for shared context and knowledge."
                selectedKey={linkProjectId ?? "none"}
                onSelectionChange={(key) => {
                  setLinkProjectId(key === "none" ? null : (key as string));
                }}
              >
                <PickerItem id="none">None</PickerItem>
                {projects.map((p) => (
                  <PickerItem key={p.project_id} id={p.project_id}>
                    {p.name}
                  </PickerItem>
                ))}
              </Picker>
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
                  <Button variant="secondary" onPress={() => openArchiveDialog(pod.pod_id, pod.name)}>
                    Archive pod
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

        {archivedProjects.length > 0 && (
          <>
            <Divider />
            <Heading level={3}>Archived Projects</Heading>
            <div className={archiveColumn}>
              {archivedProjects.map((p) => (
                <div key={p.project_id} className={archiveCard}>
                  <div className={archiveRow}>
                    <div className={archiveInfo}>
                      <Text styles={style({ fontWeight: "bold" })}>
                        {p.name}
                      </Text>
                      <Text styles={style({ font: "body-2xs", color: "neutral-subdued" })}>
                        Archived: {p.archived_date} · Created: {p.created_at.split("T")[0]}
                      </Text>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        <Divider />
        <div className={createFormCard}>
          <Heading level={3} styles={style({ marginY: 0 })}>
            Org configuration
          </Heading>
          <Text styles={style({ font: "body-sm", color: "neutral-subdued", marginBottom: 12 })}>
            Scopes drive pod workstreams, context updates, and internal team slots on project anatomy.
          </Text>
          {orgConfigSaveError && (
            <InlineAlert variant="negative">
              <Content>{orgConfigSaveError}</Content>
            </InlineAlert>
          )}
          <div className={style({ display: "flex", flexDirection: "column", gap: 16 })}>
            <div className={style({ display: "flex", flexDirection: "column", gap: 8 })}>
              <Text styles={style({ fontWeight: "bold", font: "body-sm" })}>
                Default skill catalog
              </Text>
              <Text styles={style({ font: "body-sm", color: "neutral-subdued" })}>
                Projects without an override use this catalog. Catalog sources are created and imported through the administrative workflow.
              </Text>
              {catalogConfigError && (
                <InlineAlert variant="negative">
                  <Content>{catalogConfigError}</Content>
                </InlineAlert>
              )}
              {catalogConfig && (
                <>
                  <div className={style({ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "end" })}>
                    <Picker
                      label="Organization default"
                      selectedKey={catalogDefaultDraft ?? "none"}
                      onSelectionChange={(key) => {
                        setCatalogDefaultDraft(
                          key === "none" ? null : String(key),
                        );
                      }}
                    >
                      <PickerItem id="none">Not configured</PickerItem>
                      {catalogConfig.sources.map((source) => (
                          <PickerItem key={source.sourceId} id={source.sourceId}>
                            {source.displayName} ({source.repository.owner}/{source.repository.repo})
                            {source.enabled ? "" : " · polling disabled"}
                          </PickerItem>
                        ))}
                    </Picker>
                    <Button
                      variant="accent"
                      onPress={handleSaveCatalogDefault}
                      isPending={savingCatalogConfig}
                      isDisabled={
                        catalogDefaultDraft ===
                        catalogConfig.selection.orgDefaultSourceId
                      }
                    >
                      Save catalog default
                    </Button>
                  </div>
                  {catalogConfig.selection.effectiveSource ? (
                    <div className={archiveCard}>
                      <div className={archiveInfo}>
                        <Text styles={style({ fontWeight: "bold" })}>
                          {catalogConfig.selection.effectiveSource.displayName}
                        </Text>
                        <Text styles={style({ font: "body-sm" })}>
                          {catalogConfig.selection.effectiveSource.repository.owner}/
                          {catalogConfig.selection.effectiveSource.repository.repo} ·{" "}
                          {catalogConfig.selection.effectiveSource.repository.defaultRef}
                        </Text>
                        <div className={style({ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" })}>
                          <Badge size="S" variant="neutral">
                            Sync: {catalogConfig.selection.effectiveSource.syncStatus}
                          </Badge>
                          {!catalogConfig.selection.effectiveSource.enabled && (
                            <Badge size="S" variant="notice">
                              Polling disabled
                            </Badge>
                          )}
                          <Text styles={style({ font: "code-sm", color: "neutral-subdued" })}>
                            Latest indexed:{" "}
                            {catalogConfig.selection.effectiveSource.latestIndexedCommitSha ?? "Not indexed"}
                          </Text>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <InlineAlert variant="notice">
                      <Content>
                        No organization default skill catalog is configured.
                      </Content>
                    </InlineAlert>
                  )}
                </>
              )}
            </div>
            <Divider size="S" />
            <div>
              <Text styles={style({ fontWeight: "bold", font: "body-sm" })}>Scopes</Text>
              <div className={style({ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 })}>
                {scopeDraft.map((row, i) => (
                  <div key={i} className={style({ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "end" })}>
                    <TextField
                      label="Id"
                      value={row.id}
                      onChange={(v) => {
                        const next = [...scopeDraft];
                        next[i] = { ...next[i], id: v };
                        setScopeDraft(next);
                      }}
                    />
                    <TextField
                      label="Label"
                      value={row.label}
                      onChange={(v) => {
                        const next = [...scopeDraft];
                        next[i] = { ...next[i], label: v };
                        setScopeDraft(next);
                      }}
                    />
                    <Button
                      variant="secondary"
                      isDisabled={scopeDraft.length <= 1}
                      onPress={() => setScopeDraft(scopeDraft.filter((_, j) => j !== i))}
                    >
                      Remove
                    </Button>
                  </div>
                ))}
                <Button
                  variant="secondary"
                  onPress={() => setScopeDraft([...scopeDraft, { id: "", label: "" }])}
                >
                  Add scope
                </Button>
              </div>
            </div>
            <div className={createFormActions}>
              <Button
                variant="accent"
                onPress={handleSaveOrgConfig}
                isPending={savingOrgConfig}
                isDisabled={scopeDraft.length < 1}
              >
                Save org configuration
              </Button>
            </div>
          </div>
        </div>

        {/* System Tuning — read-only, autonomously adjusted after pod archival */}
        <Divider />
        <div className={createFormCard}>
          <div className={style({ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 })}>
            <div>
              <Heading level={3} styles={style({ marginY: 0 })}>System tuning</Heading>
              <Text styles={style({ font: "body-sm", color: "neutral-subdued" })}>
                Thresholds auto-adjust based on your pod outcomes.
                {tuningHistory.length > 0 && (
                  <> {tuningHistory.length} adjustment{tuningHistory.length !== 1 ? "s" : ""} made
                  {tuningHistory[0] && ` (last: ${new Date(tuningHistory[0].adjusted_at).toLocaleDateString()})`}.</>
                )}
                {tuningHistory.length === 0 && " No adjustments yet — requires 3+ archived pods."}
              </Text>
            </div>
            <Button variant="secondary" onPress={() => setShowTuning(!showTuning)}>
              {showTuning ? "Hide" : "Show"}
            </Button>
          </div>

          {showTuning && orgTuning && (
            <div className={style({ display: "flex", flexDirection: "column", gap: 16 })}>
              <div>
                <Text styles={style({ fontWeight: "bold", font: "body-sm", marginBottom: 8 })}>Current effective values</Text>
                <div className={style({ display: "flex", flexDirection: "column", gap: 4 })}>
                  {([
                    ["Conflict detection sensitivity", orgTuning.conflictScout.additiveMinConf, DEFAULT_ORG_TUNING.conflictScout.additiveMinConf],
                    ["Normal pressure ceiling", orgTuning.pressure.normalMax, DEFAULT_ORG_TUNING.pressure.normalMax],
                    ["Caution pressure ceiling", orgTuning.pressure.cautiousMax, DEFAULT_ORG_TUNING.pressure.cautiousMax],
                    ["Degraded pressure ceiling", orgTuning.pressure.degradedMax, DEFAULT_ORG_TUNING.pressure.degradedMax],
                    ["Staleness alert (h)", orgTuning.lint.stalenessHours, DEFAULT_ORG_TUNING.lint.stalenessHours],
                  ] as [string, number, number][]).map(([label, current, def]) => (
                    <div key={label} className={style({ display: "flex", justifyContent: "space-between", alignItems: "center", padding: 8, backgroundColor: "layer-2", borderRadius: "default" })}>
                      <Text styles={style({ font: "body-sm" })}>{label}</Text>
                      <div className={style({ display: "flex", gap: 8, alignItems: "center" })}>
                        <Text styles={style({ font: "body-sm", fontWeight: "bold" })}>
                          {typeof current === "number" && current % 1 !== 0 ? current.toFixed(2) : current}
                        </Text>
                        <DriftBadge current={current} defaultVal={def} />
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {tuningHistory.length > 0 && (
                <div>
                  <Text styles={style({ fontWeight: "bold", font: "body-sm", marginBottom: 8 })}>Recent adjustments</Text>
                  <div className={style({ display: "flex", flexDirection: "column", gap: 8 })}>
                    {tuningHistory.slice(0, 10).map((entry) => (
                      <div key={entry.id} className={style({ display: "flex", flexDirection: "column", gap: 4 })}>
                        <Text styles={style({ font: "body-2xs", color: "neutral-subdued" })}>
                          {new Date(entry.adjusted_at).toLocaleDateString()} — {formatParamLabel(entry.parameter)}{" "}
                          {entry.new_value > entry.old_value ? "↑" : "↓"}: {formatSignalLabel(entry.signal_name)} was{" "}
                          {(entry.signal_value * 100).toFixed(0)}% over {entry.pods_analyzed} pods
                        </Text>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className={style({ display: "flex", justifyContent: "end" })}>
                <Button
                  variant="secondary"
                  onPress={handleResetTuning}
                  isPending={resettingTuning}
                >
                  Reset to defaults
                </Button>
              </div>
            </div>
          )}
        </div>

        {archiveFlow !== null && (
          <DialogTrigger
            isOpen={archiveFlow !== null}
            onOpenChange={(open) => {
              if (!open) setArchiveFlow(null);
            }}
          >
            <Button aria-label="Archive dialog anchor" UNSAFE_style={{ position: "absolute", width: 1, height: 1, opacity: 0, overflow: "hidden", pointerEvents: "none" }}>
              .
            </Button>
            <Dialog
              isDismissible={false}
              isKeyboardDismissDisabled={archiveFlow.phase === "running"}
            >
              {archiveFlow.kind === "pod" && archiveFlow.phase === "confirm" && (
                <>
                  <Heading slot="title">Archive &quot;{archiveFlow.podName}&quot;?</Heading>
                  <Content>
                    <Text>This action cannot be undone. Here&apos;s what happens:</Text>
                    <ul>
                      <li>The pod is hidden from your active list. Its record and all context data remain in the system.</li>
                      <li>Knowledge extraction runs automatically — decisions, resolved conflicts, and blockers are distilled into org-level learnings. This may take a moment.</li>
                      <li>All connected agents receive a live knowledge-updated notification.</li>
                    </ul>
                  </Content>
                  <ButtonGroup>
                    <Button variant="secondary" onPress={() => setArchiveFlow(null)}>
                      Cancel
                    </Button>
                    <Button
                      variant="negative"
                      onPress={() =>
                        setArchiveFlow({
                          kind: "pod",
                          phase: "running",
                          podId: archiveFlow.podId,
                          podName: archiveFlow.podName,
                        })
                      }
                    >
                      Archive pod
                    </Button>
                  </ButtonGroup>
                </>
              )}
              {archiveFlow.kind === "project" && archiveFlow.phase === "confirm" && (
                <>
                  <Heading slot="title">Archive &quot;{archiveFlow.projectName}&quot;?</Heading>
                  <Content>
                    <Text>This action cannot be undone. Here&apos;s what happens:</Text>
                    <ul>
                      <li><strong>All project context updates are permanently deleted</strong> — agent insights, decisions, and progress reports for this initiative are gone and cannot be recovered.</li>
                      <li>Associated pods are detached (their project link is removed) but not deleted.</li>
                      <li>No knowledge extraction runs — project-level learnings are not preserved in org memory.</li>
                    </ul>
                  </Content>
                  <ButtonGroup>
                    <Button variant="secondary" onPress={() => setArchiveFlow(null)}>
                      Cancel
                    </Button>
                    <Button
                      variant="negative"
                      onPress={() =>
                        setArchiveFlow({
                          kind: "project",
                          phase: "running",
                          projectId: archiveFlow.projectId,
                          projectName: archiveFlow.projectName,
                        })
                      }
                    >
                      Archive project
                    </Button>
                  </ButtonGroup>
                </>
              )}
              {archiveFlow.kind === "pod" && archiveFlow.phase === "running" && (
                <>
                  <Heading slot="title">Archiving pod</Heading>
                  <Content
                    styles={style({
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "start",
                      gap: 16,
                    })}
                  >
                    <Text>
                      Archiving &quot;{archiveFlow.podName}&quot; and running knowledge extraction. Please wait…
                    </Text>
                    <ProgressBar
                      isIndeterminate
                      label="Archiving"
                      size="M"
                      styles={style({ width: "full" })}
                    />
                  </Content>
                </>
              )}
              {archiveFlow.kind === "project" && archiveFlow.phase === "running" && (
                <>
                  <Heading slot="title">Archiving project</Heading>
                  <Content
                    styles={style({
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "start",
                      gap: 16,
                    })}
                  >
                    <Text>
                      Archiving &quot;{archiveFlow.projectName}&quot;…
                    </Text>
                    <ProgressBar
                      isIndeterminate
                      label="Archiving project"
                      size="M"
                      styles={style({ width: "full" })}
                    />
                  </Content>
                </>
              )}
              {archiveFlow.kind === "pod" && archiveFlow.phase === "success" && (
                <>
                  <Heading slot="title">Pod archived</Heading>
                  <Content>
                    <Text>
                      &quot;{archiveFlow.podName}&quot; was archived successfully.
                      {typeof archiveFlow.candidates_submitted === "number" ? (
                        <> {archiveFlow.candidates_submitted} learning candidate(s) were submitted for validation and review; they are not active yet.</>
                      ) : typeof archiveFlow.learnings_extracted === "number" ? (
                        <> {archiveFlow.learnings_extracted} learning(s) were added to the legacy graph.</>
                      ) : null}
                    </Text>
                  </Content>
                  <ButtonGroup>
                    <Button variant="accent" onPress={() => setArchiveFlow(null)}>
                      Close
                    </Button>
                  </ButtonGroup>
                </>
              )}
              {archiveFlow.kind === "project" && archiveFlow.phase === "success" && (
                <>
                  <Heading slot="title">Project archived</Heading>
                  <Content>
                    <Text>
                      &quot;{archiveFlow.projectName}&quot; was archived successfully.
                    </Text>
                  </Content>
                  <ButtonGroup>
                    <Button variant="accent" onPress={() => setArchiveFlow(null)}>
                      Close
                    </Button>
                  </ButtonGroup>
                </>
              )}
              {archiveFlow.kind === "pod" && archiveFlow.phase === "error" && (
                <>
                  <Heading slot="title">Archive failed</Heading>
                  <Content>
                    <InlineAlert variant="negative">
                      <Content>{archiveFlow.message}</Content>
                    </InlineAlert>
                  </Content>
                  <ButtonGroup>
                    <Button variant="secondary" onPress={() => setArchiveFlow(null)}>
                      Close
                    </Button>
                    <Button
                      variant="accent"
                      onPress={() =>
                        setArchiveFlow({
                          kind: "pod",
                          phase: "running",
                          podId: archiveFlow.podId,
                          podName: archiveFlow.podName,
                        })
                      }
                    >
                      Retry
                    </Button>
                  </ButtonGroup>
                </>
              )}
              {archiveFlow.kind === "project" && archiveFlow.phase === "error" && (
                <>
                  <Heading slot="title">Archive failed</Heading>
                  <Content>
                    <InlineAlert variant="negative">
                      <Content>{archiveFlow.message}</Content>
                    </InlineAlert>
                  </Content>
                  <ButtonGroup>
                    <Button variant="secondary" onPress={() => setArchiveFlow(null)}>
                      Close
                    </Button>
                    <Button
                      variant="accent"
                      onPress={() =>
                        setArchiveFlow({
                          kind: "project",
                          phase: "running",
                          projectId: archiveFlow.projectId,
                          projectName: archiveFlow.projectName,
                        })
                      }
                    >
                      Retry
                    </Button>
                  </ButtonGroup>
                </>
              )}
            </Dialog>
          </DialogTrigger>
        )}
      </div>
    </div>
  );
}
