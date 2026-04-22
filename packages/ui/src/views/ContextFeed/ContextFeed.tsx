import { useState, useEffect } from "react";
import {
  Heading,
  Picker,
  PickerItem,
  SearchField,
  Text,
  Button,
  TextField,
  InlineAlert,
  Content,
} from "@react-spectrum/s2";
import { style } from "@react-spectrum/s2/style" with { type: "macro" };
import { usePodStore } from "../../stores/podStore";
import { useOrgStore } from "../../stores/orgStore";
import { FeedItem } from "./FeedItem";
import { MarkdownDetailsEditor } from "../../components/MarkdownDetailsEditor";

const column = style({ display: "flex", flexDirection: "column", gap: 20 });
const headerRow = style({ display: "flex", alignItems: "center", justifyContent: "space-between" });
const filterRow = style({ display: "flex", gap: 12, alignItems: "end", flexWrap: "wrap" });
const feedColumn = style({ display: "flex", flexDirection: "column", gap: 8 });
const formCard = style({
  backgroundColor: "layer-1",
  padding: 20,
  borderRadius: "default",
  borderWidth: 1,
  borderStyle: "solid",
  borderColor: "gray-300",
});
const formGrid = style({ display: "flex", flexDirection: "column", gap: 12 });
const formRow = style({ display: "flex", gap: 12, flexWrap: "wrap" });
const formActions = style({ display: "flex", gap: 12, justifyContent: "end" });

export function ContextFeed() {
  const contextUpdates = usePodStore((s) => s.contextUpdates);
  const submitContextUpdate = usePodStore((s) => s.submitContextUpdate);
  const retractContextUpdate = usePodStore((s) => s.retractContextUpdate);
  const orgConfig = useOrgStore((s) => s.orgConfig);
  const [scopeFilter, setScopeFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showForm, setShowForm] = useState(false);
  const [formType, setFormType] = useState<string>("progress");
  const [formScope, setFormScope] = useState<string>("");
  const [formSummary, setFormSummary] = useState("");
  const [formDetails, setFormDetails] = useState("");
  const [formStatus, setFormStatus] = useState<string>("in_progress");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    const first = orgConfig?.scopes[0]?.id;
    if (first && !formScope) {
      setFormScope(first);
    }
  }, [orgConfig, formScope]);

  async function handleSubmit() {
    if (!formSummary.trim()) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await submitContextUpdate({
        type: formType as "progress" | "blocker" | "spec_change" | "question" | "decision",
        scope: formScope,
        summary: formSummary,
        details: formDetails,
        status: formStatus as "completed" | "in_progress" | "blocked",
      });
      setFormSummary("");
      setFormDetails("");
      setShowForm(false);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Submission failed");
    } finally {
      setSubmitting(false);
    }
  }

  const sorted = [...contextUpdates].sort(
    (a, b) =>
      new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  );

  const filtered = sorted.filter((u) => {
    if (scopeFilter !== "all" && u.scope !== scopeFilter) return false;
    if (typeFilter !== "all" && u.type !== typeFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      const inSummary = u.summary.toLowerCase().includes(q);
      const inAgent = u.agent_id.toLowerCase().includes(q);
      const inDetails = (u.details ?? "").toLowerCase().includes(q);
      if (!inSummary && !inAgent && !inDetails) return false;
    }
    return true;
  });

  function toggleExpand(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className={column}>
      <div className={headerRow}>
        <Heading level={2} styles={style({ marginY: 0 })}>
          Context Feed
        </Heading>
        <Button
          variant={showForm ? "secondary" : "accent"}
          onPress={() => { setShowForm(!showForm); setSubmitError(null); }}
        >
          {showForm ? "Cancel" : "New Update"}
        </Button>
      </div>

      {showForm && (
        <div className={formCard}>
          <div className={formGrid}>
            {submitError && (
              <InlineAlert variant="negative">
                <Content>{submitError}</Content>
              </InlineAlert>
            )}
            <div className={formRow}>
              <Picker
                label="Type"
                selectedKey={formType}
                onSelectionChange={(k) => setFormType(k as string)}
              >
                <PickerItem id="progress">Progress</PickerItem>
                <PickerItem id="blocker">Blocker</PickerItem>
                <PickerItem id="spec_change">Spec Change</PickerItem>
                <PickerItem id="question">Question</PickerItem>
                <PickerItem id="decision">Decision</PickerItem>
              </Picker>
              <Picker
                label="Scope"
                selectedKey={formScope || undefined}
                onSelectionChange={(k) => setFormScope(k as string)}
              >
                {(orgConfig?.scopes ?? []).map((s) => (
                  <PickerItem key={s.id} id={s.id}>
                    {s.label}
                  </PickerItem>
                ))}
              </Picker>
              <Picker
                label="Status"
                selectedKey={formStatus}
                onSelectionChange={(k) => setFormStatus(k as string)}
              >
                <PickerItem id="in_progress">In Progress</PickerItem>
                <PickerItem id="completed">Completed</PickerItem>
                <PickerItem id="blocked">Blocked</PickerItem>
              </Picker>
            </div>
            <TextField
              label="Summary"
              value={formSummary}
              onChange={setFormSummary}
              isRequired
            />
            <MarkdownDetailsEditor
              label="Details"
              value={formDetails}
              onChange={setFormDetails}
            />
            <div className={formActions}>
              <Button
                variant="accent"
                onPress={handleSubmit}
                isDisabled={!formSummary.trim() || !formScope || submitting}
                isPending={submitting}
              >
                Submit Update
              </Button>
            </div>
          </div>
        </div>
      )}

      <div className={filterRow}>
        <Picker
          label="Scope"
          selectedKey={scopeFilter}
          onSelectionChange={(k) => setScopeFilter(k as string)}
        >
          <PickerItem id="all">All Scopes</PickerItem>
          {(orgConfig?.scopes ?? []).map((s) => (
            <PickerItem key={s.id} id={s.id}>
              {s.label}
            </PickerItem>
          ))}
        </Picker>
        <Picker
          label="Type"
          selectedKey={typeFilter}
          onSelectionChange={(k) => setTypeFilter(k as string)}
        >
          <PickerItem id="all">All Types</PickerItem>
          <PickerItem id="progress">Progress</PickerItem>
          <PickerItem id="blocker">Blocker</PickerItem>
          <PickerItem id="spec_change">Spec Change</PickerItem>
          <PickerItem id="question">Question</PickerItem>
          <PickerItem id="decision">Decision</PickerItem>
        </Picker>
        <SearchField
          label="Search"
          value={search}
          onChange={setSearch}
        />
      </div>

      <div className={feedColumn}>
        {filtered.map((update) => (
          <FeedItem
            key={update.id}
            update={update}
            isExpanded={expanded.has(update.id)}
            onToggle={() => toggleExpand(update.id)}
            onRetract={() => retractContextUpdate(update.id)}
          />
        ))}
        {filtered.length === 0 && (
          <Text styles={style({ color: "neutral-subdued" })}>
            No updates match your filters.
          </Text>
        )}
      </div>
    </div>
  );
}
