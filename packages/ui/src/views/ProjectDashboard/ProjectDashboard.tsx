import { useState, useEffect, useRef } from "react";
import { Heading, Text, Badge, Button, Picker, PickerItem, TextField, InlineAlert, Content, SearchField, Divider } from "@react-spectrum/s2";
import { style } from "@react-spectrum/s2/style" with { type: "macro" };
import Markdown from "react-markdown";
import { Network, type Options } from "vis-network";
import { DataSet } from "vis-data";
import {
  PROJECT_SEARCH_SOURCES,
  type ProjectAnatomy,
  type ProjectMemoryCandidate,
  type ProjectResources,
  type ProjectSearchAnswerCitation,
  type ProjectSearchHit,
  type ProjectSearchMindMap,
  type ProjectSearchResponse,
  type ProjectSourceHealth,
} from "@pim/shared";
import { useProjectStore } from "../../stores/projectStore";
import { useOrgStore } from "../../stores/orgStore";
import * as api from "../../services/api";

const column = style({ display: "flex", flexDirection: "column", gap: 16 });
const idRow = style({
  backgroundColor: "layer-2",
  borderRadius: "default",
  padding: 12,
  font: "code-sm",
});
const section = style({
  backgroundColor: "layer-1",
  padding: 20,
  borderRadius: "default",
  borderWidth: 1,
  borderStyle: "solid",
  borderColor: "gray-300",
});
const row = style({ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "end" });
const compactRow = style({ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" });

const anatomyGrid = style({
  display: "grid",
  gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
  gap: 24,
  alignItems: "start",
  marginTop: 12,
});

const anatomyCol = style({
  display: "flex",
  flexDirection: "column",
  gap: 12,
  minWidth: 0,
});

const textArea = style({
  width: "full",
  minHeight: 180,
  padding: 12,
  borderWidth: 1,
  borderStyle: "solid",
  borderColor: "gray-300",
  borderRadius: "default",
  backgroundColor: "layer-1",
  font: "code-sm",
  resize: "vertical",
});

const summaryCard = style({
  backgroundColor: "layer-2",
  padding: 16,
  borderRadius: "default",
  borderWidth: 1,
  borderStyle: "solid",
  borderColor: "gray-200",
});

const hitCard = style({
  padding: 12,
  borderRadius: "default",
  borderWidth: 1,
  borderStyle: "solid",
  borderColor: "gray-200",
});

const mindMapGraph = style({
  width: "full",
  height: 360,
  minHeight: 300,
  backgroundColor: "layer-1",
  borderRadius: "default",
  borderWidth: 1,
  borderStyle: "solid",
  borderColor: "gray-200",
});

const hitMetaRow: React.CSSProperties = {
  display: "flex",
  gap: 8,
  flexWrap: "wrap",
  alignItems: "center",
  fontSize: 12,
  color: "#6b7280",
};

const listItem = style({
  display: "flex",
  flexDirection: "column",
  gap: 8,
  padding: 12,
  borderWidth: 1,
  borderStyle: "solid",
  borderColor: "gray-200",
  borderRadius: "default",
});

function healthVariant(state: ProjectSourceHealth["credential_state"]) {
  if (state === "ok" || state === "not_required") return "informative" as const;
  if (state === "missing_credentials") return "notice" as const;
  if (state === "invalid_credentials" || state === "unreachable" || state === "misconfigured") {
    return "negative" as const;
  }
  return "neutral" as const;
}

function sourceVariant(source: ProjectSearchHit["source"]) {
  if (source === "jira") return "informative" as const;
  if (source === "confluence") return "accent" as const;
  return "neutral" as const;
}

function citationSourceVariant(source: ProjectSearchAnswerCitation["source"]) {
  if (source === "kg") return "positive" as const;
  if (source === "jira") return "informative" as const;
  if (source === "confluence") return "accent" as const;
  return "neutral" as const;
}

/** Friendly label for a document's source_type (e.g. "backlog_issue" -> "Backlog"). */
function sourceTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    backlog_issue: "Backlog",
    active_issue: "In progress",
    resolved_issue: "Resolved",
    release: "Release",
    pull_request: "Pull request",
    merged_pr: "Merged PR",
    updated_pr: "Open PR",
    default_branch_commit: "Commit",
    issue: "Issue",
    commit: "Commit",
    project_update: "Update",
    pod_update: "Pod update",
  };
  return labels[type] ?? type.replace(/_/g, " ");
}

/** Strip the synthetic "release:KEY:" prefix so the human-facing ref reads cleanly. */
function hitRef(hit: ProjectSearchHit): string {
  if (hit.source_id.startsWith("release:")) return hit.source_id.split(":").slice(2).join(":");
  return hit.source_id;
}

const MIND_MAP_COLORS: Record<ProjectSearchMindMap["entities"][number]["entity_type"], string> = {
  ticket: "#2680eb",
  pr: "#9256d9",
  commit: "#e68619",
  file: "#2d9d78",
  symbol: "#0f766e",
  person: "#6b7280",
  doc: "#64748b",
  feature: "#0ea5e9",
  decision: "#7c3aed",
  risk: "#e34850",
  blocker: "#d97706",
};

const MIND_MAP_SHAPES: Record<ProjectSearchMindMap["entities"][number]["entity_type"], string> = {
  ticket: "box",
  pr: "dot",
  commit: "triangle",
  file: "square",
  symbol: "star",
  person: "dot",
  doc: "box",
  feature: "ellipse",
  decision: "diamond",
  risk: "triangleDown",
  blocker: "box",
};

function truncateLabel(label: string): string {
  return label.length > 34 ? `${label.slice(0, 31)}...` : label;
}

function ProjectMindMap({ map }: { map: ProjectSearchMindMap }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const entityIds = new Set(map.entities.map((e) => e.id));
    const nodes = new DataSet(
      map.entities.map((entity) => {
        const color = MIND_MAP_COLORS[entity.entity_type] ?? "#6b7280";
        const detail = typeof entity.metadata.path === "string"
          ? `\n${entity.metadata.path}`
          : typeof entity.metadata.name === "string"
          ? `\n${entity.metadata.name}`
          : "";
        return {
          id: entity.id,
          label: truncateLabel(entity.label),
          title: `${entity.entity_type}: ${entity.label}${detail}`,
          color: {
            background: color,
            border: color,
            highlight: { background: color, border: "#000000" },
          },
          shape: MIND_MAP_SHAPES[entity.entity_type] ?? "dot",
          size: entity.entity_type === "symbol" ? 17 : 14,
          borderWidth: 1,
          font: { size: 11, color: "#333333" },
        };
      }),
    );
    const edges = new DataSet(
      map.edges
        .filter((edge) => entityIds.has(edge.source_entity_id) && entityIds.has(edge.target_entity_id))
        .map((edge, index) => ({
          id: `edge-${index}`,
          from: edge.source_entity_id,
          to: edge.target_entity_id,
          label: edge.edge_type === "mentions" ? undefined : edge.edge_type.replace(/_/g, " "),
          arrows: "to",
          color: { color: edge.edge_type === "defines" ? "#0f766e" : "#9ca3af", opacity: 0.75 },
          width: Math.max(1, edge.confidence_score * 2.5),
          title: `${edge.edge_type.replace(/_/g, " ")} (${edge.confidence_score.toFixed(2)})`,
        })),
    );
    const options: Options = {
      edges: { smooth: { enabled: true, type: "dynamic", roundness: 0.35 }, font: { size: 9, align: "middle" } },
      physics: {
        solver: "forceAtlas2Based",
        forceAtlas2Based: { gravitationalConstant: -45, springLength: 120, springConstant: 0.06 },
        stabilization: { iterations: 120 },
      },
      interaction: { hover: true, tooltipDelay: 160, zoomView: true, dragView: true },
      layout: { improvedLayout: true },
    };
    const network = new Network(containerRef.current, { nodes, edges }, options);
    network.once("stabilizationIterationsDone", () => {
      network.fit({ animation: { duration: 360, easingFunction: "easeInOutCubic" } });
      network.setOptions({ physics: { enabled: false } });
    });
    return () => network.destroy();
  }, [map]);

  return <div ref={containerRef} className={mindMapGraph} />;
}

function HitCard({ hit }: { hit: ProjectSearchHit }) {
  const day = hit.occurred_at ? hit.occurred_at.slice(0, 10) : null;
  return (
    <div className={hitCard}>
      <div style={hitMetaRow}>
        <Badge size="S" variant={sourceVariant(hit.source)}>{hit.source}</Badge>
        <Badge size="S" variant="neutral">{sourceTypeLabel(hit.source_type)}</Badge>
        {hit.status && <Badge size="S" variant="informative">{hit.status}</Badge>}
        <span style={{ fontFamily: "monospace" }}>{hitRef(hit)}</span>
        {hit.author && <span>· {hit.author}</span>}
        {day && <span>· {day}</span>}
        {hit.matched.identifier && <Badge size="S" variant="positive">exact</Badge>}
        {hit.matched.semantic && <Badge size="S" variant="accent">semantic</Badge>}
        {hit.matched.graph && <Badge size="S" variant="notice">graph</Badge>}
        {hit.matched.in_scope_resource && <Badge size="S" variant="informative">in scope</Badge>}
        {hit.freshness === "deleted" && <span>· removed upstream</span>}
      </div>
      <div className={style({ fontWeight: "bold", marginTop: 8 })}>
        {hit.url ? (
          <a href={hit.url} target="_blank" rel="noreferrer">
            {hit.title}
          </a>
        ) : (
          hit.title
        )}
      </div>
      {hit.snippet && (
        <Text styles={style({ font: "body-sm", color: "neutral-subdued", marginTop: 8 })}>{hit.snippet}</Text>
      )}
    </div>
  );
}

export function ProjectDashboard() {
  const project = useProjectStore((s) => s.project);
  const loadProject = useProjectStore((s) => s.loadProject);
  const orgConfig = useOrgStore((s) => s.orgConfig);

  const [anatomyDraft, setAnatomyDraft] = useState<ProjectAnatomy>({ internal: [], external: [] });
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [profileDraft, setProfileDraft] = useState("{}");
  const [profileError, setProfileError] = useState<string | null>(null);
  const [profileSaving, setProfileSaving] = useState(false);
  const [sourceHealth, setSourceHealth] = useState<ProjectSourceHealth[]>([]);
  const [polling, setPolling] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResult, setSearchResult] = useState<ProjectSearchResponse | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<ProjectMemoryCandidate[]>([]);
  const [candidateBusy, setCandidateBusy] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!project) return;
    setAnatomyDraft({
      internal: project.anatomy.internal.map(i => ({ ...i })),
      external: project.anatomy.external.map(e => ({
        name: e.name,
        role: e.role,
        ...(e.notes ? { notes: e.notes } : {}),
      })),
    });
  }, [project]);

  useEffect(() => {
    if (!project) return;
    void loadProjectMemory(project.project_id);
  }, [project?.project_id]);

  if (!project) return null;

  const projectId = project.project_id;
  const firstScopeId = orgConfig?.scopes[0]?.id ?? "";

  async function handleSaveAnatomy() {
    if (!project) return;
    setSaveError(null);
    setSaving(true);
    try {
      await api.patchProject(project.project_id, { anatomy: anatomyDraft });
      await loadProject(project.project_id);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to save anatomy");
    } finally {
      setSaving(false);
    }
  }

  async function loadProjectMemory(projectId: string) {
    try {
      const [profile, health, pending] = await Promise.all([
        api.getProjectProfile(projectId),
        api.getProjectSourceHealth(projectId),
        api.getProjectMemoryCandidates(projectId, "pending"),
      ]);
      setProfileDraft(JSON.stringify(profile ?? {}, null, 2));
      setSourceHealth(health);
      setCandidates(pending);
      setProfileError(null);
    } catch (err) {
      setProfileError(err instanceof Error ? err.message : "Failed to load project memory");
    }
  }

  async function handleSaveProfile() {
    setProfileError(null);
    setProfileSaving(true);
    try {
      const parsed = JSON.parse(profileDraft) as ProjectResources;
      const saved = await api.putProjectResources(projectId, parsed);
      setProfileDraft(JSON.stringify(saved ?? {}, null, 2));
      setSourceHealth(await api.getProjectSourceHealth(projectId));
    } catch (err) {
      setProfileError(err instanceof Error ? err.message : "Failed to save profile");
    } finally {
      setProfileSaving(false);
    }
  }

  async function handlePollSources() {
    setPolling(true);
    setProfileError(null);
    try {
      const result = await api.pollProjectSources(projectId);
      setSourceHealth(result.health);
      setCandidates(await api.getProjectMemoryCandidates(projectId, "pending"));
    } catch (err) {
      setProfileError(err instanceof Error ? err.message : "Failed to poll sources");
    } finally {
      setPolling(false);
    }
  }

  async function handleSearch() {
    if (!searchQuery.trim()) return;
    setSearchLoading(true);
    setSearchError(null);
    try {
      setSearchResult(
        await api.searchProjectIndex(projectId, {
          query: searchQuery.trim(),
          synthesize: true,
          include_mind_map: true,
          max_hits: 12,
        }),
      );
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : "Search failed");
    } finally {
      setSearchLoading(false);
    }
  }

  async function handleCandidate(candidateId: string, action: "promote" | "reject") {
    setCandidateBusy((prev) => new Set(prev).add(candidateId));
    try {
      if (action === "promote") {
        await api.promoteProjectMemoryCandidate(projectId, candidateId);
      } else {
        await api.rejectProjectMemoryCandidate(projectId, candidateId);
      }
      setCandidates(await api.getProjectMemoryCandidates(projectId, "pending"));
    } finally {
      setCandidateBusy((prev) => {
        const next = new Set(prev);
        next.delete(candidateId);
        return next;
      });
    }
  }

  return (
    <div className={column}>
      <div className={style({ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" })}>
        <Heading level={2} styles={style({ marginY: 0 })}>
          {project.name}
        </Heading>
        <Badge variant="informative">Long-lived project</Badge>
      </div>

      <Text styles={style({ color: "neutral-subdued", maxWidth: "[720px]" })}>
        This initiative exists outside any single sprint pod. Context updates here are stored on the project for
        reporting when you are not bound to an active pod (for example CLI `pim report --project`).
        Sprint work, conflicts, and the living doc still live on pods linked to this project when applicable.
      </Text>

      {project.description && (
        <div className={style({ display: "flex", flexDirection: "column", gap: 4 })}>
          <Text styles={style({ fontWeight: "bold", font: "body-sm" })}>Description</Text>
          <Text>{project.description}</Text>
        </div>
      )}

      <div className={style({ display: "flex", flexDirection: "column", gap: 4 })}>
        <Text styles={style({ fontWeight: "bold", font: "body-sm" })}>Project ID</Text>
        <div className={idRow}>
          <Text styles={style({ font: "code-sm", marginY: 0 })}>{project.project_id}</Text>
        </div>
      </div>

      <Text styles={style({ font: "body-2xs", color: "neutral-subdued" })}>
        Created {project.created_at}
      </Text>

      <div className={section}>
        <Heading level={3} styles={style({ marginY: 0 })}>
          Project Search
        </Heading>
        <Text styles={style({ font: "body-sm", color: "neutral-subdued", marginBottom: 12 })}>
          Ask in plain language about this project — tickets, upcoming releases, and backlog across every connected
          source. You get a readable, cited answer plus the underlying items, with links back to the source.
        </Text>
        <div className={row}>
          <SearchField
            label="Search this project"
            value={searchQuery}
            onChange={setSearchQuery}
            onSubmit={handleSearch}
          />
          <Button variant="accent" onPress={handleSearch} isPending={searchLoading} isDisabled={!searchQuery.trim()}>
            Search
          </Button>
        </div>
        {searchError && (
          <InlineAlert variant="negative">
            <Content>{searchError}</Content>
          </InlineAlert>
        )}
        {searchResult && (
          <div className={style({ display: "flex", flexDirection: "column", gap: 16, marginTop: 16 })}>
            <div className={compactRow}>
              <Badge size="S" variant="neutral">{searchResult.retrieval_mode}</Badge>
              {searchResult.sources_used.map((s) => (
                <Badge key={s} size="S" variant="accent">{s}</Badge>
              ))}
              {PROJECT_SEARCH_SOURCES.map((s) => {
                const count = searchResult.documents_by_source[s] ?? 0;
                return (
                  <Badge key={`coverage-${s}`} size="S" variant={count > 0 ? "informative" : "neutral"}>
                    {s}: {count}
                  </Badge>
                );
              })}
              <Text styles={style({ font: "body-2xs", color: "neutral-subdued" })}>
                {searchResult.hits.length} result{searchResult.hits.length === 1 ? "" : "s"} · {searchResult.total_documents} indexed items
              </Text>
              {searchResult.detected_identifiers.length > 0 && (
                <Text styles={style({ font: "body-2xs", color: "neutral-subdued" })}>
                  · refs: {searchResult.detected_identifiers.join(", ")}
                </Text>
              )}
            </div>
            {(searchResult.documents_by_source.git ?? 0) + (searchResult.documents_by_source.github ?? 0) === 0
              && searchResult.total_documents > 0 && (
              <InlineAlert variant="notice">
                <Content>Implementation evidence is absent from this project index.</Content>
              </InlineAlert>
            )}
            {searchResult.summary_md && (
              <div className={summaryCard}>
                <Markdown>{searchResult.summary_md}</Markdown>
                {searchResult.answer_citations && searchResult.answer_citations.length > 0 && (
                  <div className={style({ display: "flex", flexDirection: "column", gap: 8, marginTop: 12 })}>
                    <Text styles={style({ fontWeight: "bold", font: "body-sm" })}>Answer evidence</Text>
                    {searchResult.answer_citations.slice(0, 8).map((citation) => (
                      <div key={`${citation.ref}-${citation.source}`} style={hitMetaRow}>
                        <Badge size="S" variant={citationSourceVariant(citation.source)}>{citation.ref}</Badge>
                        <Badge size="S" variant="neutral">{citation.source}</Badge>
                        {citation.url ? (
                          <a href={citation.url} target="_blank" rel="noreferrer">
                            {citation.title}
                          </a>
                        ) : (
                          <span>{citation.title}</span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            {searchResult.focus_feature && (
              <div className={summaryCard}>
                <div className={compactRow}>
                  <Badge size="S" variant="informative">feature</Badge>
                  <Text styles={style({ fontWeight: "bold" })}>{searchResult.focus_feature.label}</Text>
                  <Text styles={style({ font: "code-sm", color: "neutral-subdued" })}>
                    {searchResult.focus_feature.entity_key}
                  </Text>
                </div>
                {searchResult.focus_feature.members.length > 0 && (
                  <div className={style({ display: "flex", flexDirection: "column", gap: 8, marginTop: 12 })}>
                    {searchResult.focus_feature.members.slice(0, 12).map((member) => (
                      <div key={`${member.entity_id}-${member.edge_type}`} style={hitMetaRow}>
                        <Badge size="S" variant="neutral">{member.entity_type}</Badge>
                        <Badge size="S" variant="informative">{member.edge_type}</Badge>
                        <span>{member.label}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            {searchResult.mind_map && searchResult.mind_map.entities.length > 0 && (
              <>
                <Divider size="S" />
                <Text styles={style({ fontWeight: "bold", font: "body-sm" })}>Mind map</Text>
                <ProjectMindMap map={searchResult.mind_map} />
              </>
            )}
            {searchResult.hits.length > 0 && (
              <>
                <Divider size="S" />
                <Text styles={style({ fontWeight: "bold", font: "body-sm" })}>Matching items</Text>
                <div className={style({ display: "flex", flexDirection: "column", gap: 8 })}>
                  {searchResult.hits.map((hit) => (
                    <HitCard key={hit.chunk_id ?? hit.document_id} hit={hit} />
                  ))}
                </div>
              </>
            )}
            {searchResult.hits.length === 0 && (
              <Text styles={style({ color: "neutral-subdued" })}>
                No matching items. Try different wording, or check that this project has been indexed.
              </Text>
            )}
          </div>
        )}
      </div>

      <div className={section}>
        <div className={style({ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" })}>
          <Heading level={3} styles={style({ marginY: 0 })}>
            Context Profile
          </Heading>
          <Button variant="secondary" onPress={handlePollSources} isPending={polling}>
            Poll sources
          </Button>
        </div>
        <div className={compactRow}>
          {sourceHealth.map((h) => (
            <Badge key={h.source} size="S" variant={healthVariant(h.credential_state)}>
              {h.source}: {h.configured_items}
            </Badge>
          ))}
        </div>
        {profileError && (
          <InlineAlert variant="negative">
            <Content>{profileError}</Content>
          </InlineAlert>
        )}
        <textarea
          className={textArea}
          value={profileDraft}
          onChange={(e) => setProfileDraft(e.currentTarget.value)}
          aria-label="Project context profile JSON"
        />
        <div className={style({ display: "flex", justifyContent: "end" })}>
          <Button variant="accent" onPress={handleSaveProfile} isPending={profileSaving}>
            Save profile
          </Button>
        </div>
      </div>

      <div className={section}>
        <div className={style({ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 })}>
          <Heading level={3} styles={style({ marginY: 0 })}>
            Candidate Memory
          </Heading>
          <Badge size="S" variant={candidates.length > 0 ? "notice" : "neutral"}>
            {candidates.length} pending
          </Badge>
        </div>
        <div className={style({ display: "flex", flexDirection: "column", gap: 8 })}>
          {candidates.slice(0, 6).map((candidate) => {
            const busy = candidateBusy.has(candidate.id);
            return (
              <div key={candidate.id} className={listItem}>
                <div className={compactRow}>
                  <Badge size="S" variant="neutral">{candidate.type}</Badge>
                  <Badge size="S" variant="informative">{candidate.source}</Badge>
                  <Badge size="S" variant="neutral">{candidate.confidence_score.toFixed(2)}</Badge>
                </div>
                <Text>{candidate.summary}</Text>
                <div className={style({ display: "flex", gap: 8, justifyContent: "end" })}>
                  <Button variant="secondary" isDisabled={busy} onPress={() => void handleCandidate(candidate.id, "reject")}>
                    Reject
                  </Button>
                  <Button variant="accent" isDisabled={busy} onPress={() => void handleCandidate(candidate.id, "promote")}>
                    Promote
                  </Button>
                </div>
              </div>
            );
          })}
          {candidates.length === 0 && (
            <Text styles={style({ color: "neutral-subdued" })}>No pending candidates.</Text>
          )}
        </div>
      </div>

      <div className={section}>
        <Heading level={3} styles={style({ marginY: 0 })}>
          Anatomy
        </Heading>
        <Text styles={style({ font: "body-sm", color: "neutral-subdued", marginBottom: 12 })}>
          Internal slots reference org scopes. External teams use a free-text capacity or relationship label.
        </Text>
        {saveError && (
          <InlineAlert variant="negative">
            <Content>{saveError}</Content>
          </InlineAlert>
        )}
        <div className={anatomyGrid}>
          <div className={anatomyCol}>
            <Text styles={style({ fontWeight: "bold", font: "body-sm" })}>Internal</Text>
            <div className={style({ display: "flex", flexDirection: "column", gap: 8 })}>
              {anatomyDraft.internal.map((slot, i) => (
                <div key={i} className={row}>
                  <Picker
                    label="Org scope"
                    selectedKey={slot.scope_id || undefined}
                    onSelectionChange={(k) => {
                      const next = [...anatomyDraft.internal];
                      next[i] = { scope_id: k as string };
                      setAnatomyDraft({ ...anatomyDraft, internal: next });
                    }}
                  >
                    {(orgConfig?.scopes ?? []).map((s) => (
                      <PickerItem key={s.id} id={s.id}>
                        {s.label}
                      </PickerItem>
                    ))}
                  </Picker>
                  <Button variant="secondary" onPress={() => {
                    setAnatomyDraft({
                      ...anatomyDraft,
                      internal: anatomyDraft.internal.filter((_, j) => j !== i),
                    });
                  }}
                  >
                    Remove
                  </Button>
                </div>
              ))}
              <Button
                variant="secondary"
                onPress={() => {
                  const sid = firstScopeId || orgConfig?.scopes[0]?.id || "";
                  setAnatomyDraft({
                    ...anatomyDraft,
                    internal: [...anatomyDraft.internal, { scope_id: sid }],
                  });
                }}
                isDisabled={!orgConfig?.scopes.length}
              >
                Add internal slot
              </Button>
            </div>
          </div>
          <div className={anatomyCol}>
            <Text styles={style({ fontWeight: "bold", font: "body-sm" })}>External</Text>
            <div className={style({ display: "flex", flexDirection: "column", gap: 8 })}>
              {anatomyDraft.external.map((team, i) => (
                <div key={i} className={style({ display: "flex", flexDirection: "column", gap: 8, padding: 12, backgroundColor: "layer-2", borderRadius: "default" })}>
                  <div className={row}>
                    <TextField
                      label="Team / group name"
                      value={team.name}
                      onChange={(v) => {
                        const next = [...anatomyDraft.external];
                        next[i] = { ...next[i], name: v };
                        setAnatomyDraft({ ...anatomyDraft, external: next });
                      }}
                    />
                    <TextField
                      label="Role (free text)"
                      value={team.role}
                      onChange={(v) => {
                        const next = [...anatomyDraft.external];
                        next[i] = { ...next[i], role: v };
                        setAnatomyDraft({ ...anatomyDraft, external: next });
                      }}
                    />
                  </div>
                  <TextField
                    label="Notes (optional)"
                    value={team.notes ?? ""}
                    onChange={(v) => {
                      const next = [...anatomyDraft.external];
                      next[i] = { ...next[i], notes: v || undefined };
                      setAnatomyDraft({ ...anatomyDraft, external: next });
                    }}
                  />
                  <Button
                    variant="secondary"
                    onPress={() => {
                      setAnatomyDraft({
                        ...anatomyDraft,
                        external: anatomyDraft.external.filter((_, j) => j !== i),
                      });
                    }}
                  >
                    Remove external team
                  </Button>
                </div>
              ))}
              <Button
                variant="secondary"
                onPress={() => {
                  setAnatomyDraft({
                    ...anatomyDraft,
                    external: [...anatomyDraft.external, { name: "", role: "" }],
                  });
                }}
              >
                Add external team
              </Button>
            </div>
          </div>
        </div>
        <div className={style({ display: "flex", justifyContent: "end", marginTop: 20 })}>
          <Button variant="accent" onPress={handleSaveAnatomy} isPending={saving}>
            Save anatomy
          </Button>
        </div>
      </div>
    </div>
  );
}
