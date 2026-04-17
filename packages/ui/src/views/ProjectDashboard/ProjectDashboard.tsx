import { useState, useEffect } from "react";
import { Heading, Text, Badge, Button, Picker, PickerItem, TextField, InlineAlert, Content } from "@react-spectrum/s2";
import { style } from "@react-spectrum/s2/style" with { type: "macro" };
import type { ProjectAnatomy } from "@pim/shared";
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

export function ProjectDashboard() {
  const project = useProjectStore((s) => s.project);
  const loadProject = useProjectStore((s) => s.loadProject);
  const orgConfig = useOrgStore((s) => s.orgConfig);

  const [anatomyDraft, setAnatomyDraft] = useState<ProjectAnatomy>({ internal: [], external: [] });
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

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

  if (!project) return null;

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
