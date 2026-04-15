import { useState } from "react";
import {
  Heading,
  Picker,
  PickerItem,
  SearchField,
  Text,
  Badge,
  StatusLight,
  ActionButton,
  Button,
  TextField,
  TextArea,
  InlineAlert,
  Content,
} from "@react-spectrum/s2";
import { style } from "@react-spectrum/s2/style" with { type: "macro" };
import type { ContextUpdate } from "@council/shared";
import { usePodStore } from "../../stores/podStore";
import { RelativeTime } from "../../components/RelativeTime";
import { QualityBadge } from "../../components/QualityBadge";

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

const card = style({
  backgroundColor: "layer-1",
  padding: 16,
  borderRadius: "default",
  borderWidth: 1,
  borderStyle: "solid",
  borderColor: "gray-300",
});
const cardContent = style({ display: "flex", flexDirection: "column", gap: 8 });
const tagRow = style({ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" });
const detailWell = style({
  backgroundColor: "layer-2",
  borderRadius: "default",
  padding: 12,
  marginTop: 4,
});
const detailColumn = style({ display: "flex", flexDirection: "column", gap: 4 });

const typeBadgeVariant: Record<string, "positive" | "negative" | "informative" | "neutral" | "purple" | "seafoam"> = {
  progress: "positive",
  blocker: "negative",
  spec_change: "informative",
  question: "purple",
  decision: "seafoam",
};

const statusVariant: Record<string, "positive" | "notice" | "negative"> = {
  completed: "positive",
  in_progress: "notice",
  blocked: "negative",
};

export function ContextFeed() {
  const contextUpdates = usePodStore((s) => s.contextUpdates);
  const submitContextUpdate = usePodStore((s) => s.submitContextUpdate);
  const [scopeFilter, setScopeFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showForm, setShowForm] = useState(false);
  const [formType, setFormType] = useState<string>("progress");
  const [formScope, setFormScope] = useState<string>("frontend");
  const [formSummary, setFormSummary] = useState("");
  const [formDetails, setFormDetails] = useState("");
  const [formStatus, setFormStatus] = useState<string>("in_progress");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  async function handleSubmit() {
    if (!formSummary.trim()) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await submitContextUpdate({
        type: formType as "progress" | "blocker" | "spec_change" | "question" | "decision",
        scope: formScope as "frontend" | "backend" | "design" | "qa" | "infra" | "pm",
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
    if (
      search &&
      !u.summary.toLowerCase().includes(search.toLowerCase()) &&
      !u.agent_id.toLowerCase().includes(search.toLowerCase())
    )
      return false;
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
                selectedKey={formScope}
                onSelectionChange={(k) => setFormScope(k as string)}
              >
                <PickerItem id="frontend">Frontend</PickerItem>
                <PickerItem id="backend">Backend</PickerItem>
                <PickerItem id="design">Design</PickerItem>
                <PickerItem id="qa">QA</PickerItem>
                <PickerItem id="infra">Infra</PickerItem>
                <PickerItem id="pm">PM</PickerItem>
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
            <TextArea
              label="Details"
              value={formDetails}
              onChange={setFormDetails}
            />
            <div className={formActions}>
              <Button
                variant="accent"
                onPress={handleSubmit}
                isDisabled={!formSummary.trim() || submitting}
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
          <PickerItem id="frontend">Frontend</PickerItem>
          <PickerItem id="backend">Backend</PickerItem>
          <PickerItem id="design">Design</PickerItem>
          <PickerItem id="qa">QA</PickerItem>
          <PickerItem id="infra">Infra</PickerItem>
          <PickerItem id="pm">PM</PickerItem>
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

function FeedItem({
  update,
  isExpanded,
  onToggle,
}: {
  update: ContextUpdate;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div className={card}>
      <div className={cardContent}>
        <div className={tagRow}>
          <RelativeTime timestamp={update.timestamp} />
          <Text styles={style({ fontWeight: "bold" })}>{update.agent_id}</Text>
          <Badge variant={typeBadgeVariant[update.type] ?? "neutral"}>
            {update.type.replace("_", " ")}
          </Badge>
          <Badge variant="neutral">{update.scope}</Badge>
          {update.quality_score != null && update.quality_score > 0 && (
            <QualityBadge score={update.quality_score} />
          )}
          <StatusLight variant={statusVariant[update.status] ?? "neutral"}>
            {update.status.replace("_", " ")}
          </StatusLight>
        </div>

        <Text>{update.summary}</Text>

        {(update.details || update.artifacts.length > 0) && (
          <ActionButton onPress={onToggle}>
            {isExpanded ? "Collapse" : "Expand"}
          </ActionButton>
        )}

        {isExpanded && (
          <div className={detailWell}>
            {update.details && <Text>{update.details}</Text>}
            {update.artifacts.length > 0 && (
              <div className={detailColumn} style={{ marginTop: 8 }}>
                <Text styles={style({ fontWeight: "bold", font: "body-2xs" })}>
                  Artifacts:
                </Text>
                {update.artifacts.map((a, i) => (
                  <Text key={i} styles={style({ font: "body-2xs" })}>
                    [{a.type}] {a.path || a.url}
                  </Text>
                ))}
              </div>
            )}
            {update.blocked_by.length > 0 && (
              <Text styles={style({ font: "body-2xs", marginTop: 8 })}>
                Blocked by: {update.blocked_by.join(", ")}
              </Text>
            )}
            {update.needs_input_from.length > 0 && (
              <div className={detailColumn} style={{ marginTop: 8 }}>
                <Text styles={style({ fontWeight: "bold", font: "body-2xs" })}>
                  Needs input from:
                </Text>
                {update.needs_input_from.map((req, i) => (
                  <Text key={i} styles={style({ font: "body-2xs" })}>
                    {req.role}: {req.question}
                  </Text>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
