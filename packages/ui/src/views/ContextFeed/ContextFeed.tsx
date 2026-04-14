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
} from "@react-spectrum/s2";
import { style } from "@react-spectrum/s2/style" with { type: "macro" };
import type { ContextUpdate } from "@council/shared";
import { usePodStore } from "../../stores/podStore";
import { RelativeTime } from "../../components/RelativeTime";

const column = style({ display: "flex", flexDirection: "column", gap: 20 });
const filterRow = style({ display: "flex", gap: 12, alignItems: "end", flexWrap: "wrap" });
const feedColumn = style({ display: "flex", flexDirection: "column", gap: 8 });

const card = style({
  backgroundColor: "gray-75",
  padding: 16,
  borderRadius: "default",
  borderWidth: 1,
  borderStyle: "solid",
  borderColor: "gray-300",
});
const cardContent = style({ display: "flex", flexDirection: "column", gap: 8 });
const tagRow = style({ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" });
const detailWell = style({
  backgroundColor: "gray-100",
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
  const [scopeFilter, setScopeFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

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
      <Heading level={2} styles={style({ marginY: 0 })}>
        Context Feed
      </Heading>

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
          <Text styles={style({ color: "gray-600" })}>
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
              <Text styles={style({ font: "body-2xs" })} UNSAFE_style={{ marginTop: 8 }}>
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
