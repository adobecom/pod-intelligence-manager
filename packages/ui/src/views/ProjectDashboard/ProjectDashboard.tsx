import { useState, useEffect } from "react";
import { Heading, Text, Badge, Button, Picker, PickerItem, TextField, InlineAlert, Content, SearchField, Divider } from "@react-spectrum/s2";
import { style } from "@react-spectrum/s2/style" with { type: "macro" };
import Markdown from "react-markdown";
import type {
  ProjectAnatomy,
  ProjectAnswerResponse,
  ProjectMemoryCandidate,
  ProjectResources,
  ProjectSourceHealth,
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

const twoColumnGrid = style({
  display: "grid",
  gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
  gap: 20,
  alignItems: "start",
});

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
  const [answerQuery, setAnswerQuery] = useState("");
  const [answer, setAnswer] = useState<ProjectAnswerResponse | null>(null);
  const [answerLoading, setAnswerLoading] = useState(false);
  const [answerError, setAnswerError] = useState<string | null>(null);
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

  async function handleAsk() {
    if (!answerQuery.trim()) return;
    setAnswerLoading(true);
    setAnswerError(null);
    try {
      setAnswer(await api.answerProjectQuestion(projectId, answerQuery.trim()));
    } catch (err) {
      setAnswerError(err instanceof Error ? err.message : "Failed to answer");
    } finally {
      setAnswerLoading(false);
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

      <div className={twoColumnGrid}>
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
          <Heading level={3} styles={style({ marginY: 0 })}>
            Project Answers
          </Heading>
          <div className={row}>
            <SearchField
              label="Ask"
              value={answerQuery}
              onChange={setAnswerQuery}
              onSubmit={handleAsk}
            />
            <Button variant="accent" onPress={handleAsk} isPending={answerLoading} isDisabled={!answerQuery.trim()}>
              Ask
            </Button>
          </div>
          {answerError && (
            <InlineAlert variant="negative">
              <Content>{answerError}</Content>
            </InlineAlert>
          )}
          {answer && (
            <div className={style({ display: "flex", flexDirection: "column", gap: 12 })}>
              <div className={compactRow}>
                <Badge size="S" variant="informative">{answer.intent}</Badge>
                <Badge size="S" variant="neutral">{answer.confidence.toFixed(2)}</Badge>
                {answer.sources_used.map((s) => (
                  <Badge key={s} size="S" variant="accent">{s}</Badge>
                ))}
              </div>
              <Markdown>{answer.answer_markdown}</Markdown>
              {answer.citations.length > 0 && (
                <>
                  <Divider size="S" />
                  <div className={style({ display: "flex", flexDirection: "column", gap: 8 })}>
                    {answer.citations.map((c, i) => (
                      <Text key={`${c.source}-${c.id}`} styles={style({ font: "body-xs", color: "neutral-subdued" })}>
                        [{i + 1}] {c.title}
                      </Text>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
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
