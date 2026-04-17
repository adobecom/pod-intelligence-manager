import {
  Text,
  Badge,
  StatusLight,
  ActionButton,
} from "@react-spectrum/s2";
import { style } from "@react-spectrum/s2/style" with { type: "macro" };
import type { ContextUpdate, ProjectContextUpdate } from "@council/shared";
import { RelativeTime } from "../../components/RelativeTime";
import { QualityBadge } from "../../components/QualityBadge";

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

export type FeedItemUpdate = ContextUpdate | ProjectContextUpdate;

export function FeedItem({
  update,
  isExpanded,
  onToggle,
}: {
  update: FeedItemUpdate;
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
