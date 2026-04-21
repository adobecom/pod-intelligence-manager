import { useMemo, useState } from "react";
import {
  Heading,
  Text,
  Button,
  Badge,
  Divider,
  ActionButton,
} from "@react-spectrum/s2";
import { style } from "@react-spectrum/s2/style" with { type: "macro" };
import type { KnowledgeGraph, KnowledgeNode, CurationAction } from "@pim/shared";
import { RelativeTime } from "../RelativeTime";

interface Props {
  graph: KnowledgeGraph;
  onCurate: (nodeId: string, action: CurationAction) => void | Promise<void>;
}

const card = style({
  backgroundColor: "layer-1",
  borderRadius: "default",
  borderWidth: 1,
  borderStyle: "solid",
  borderColor: "gray-200",
  padding: 20,
  display: "flex",
  flexDirection: "column",
  gap: 16,
});

const row = style({ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 });
const item = style({
  display: "flex",
  flexDirection: "column",
  gap: 8,
  padding: 12,
  borderWidth: 1,
  borderStyle: "solid",
  borderColor: "gray-200",
  borderRadius: "default",
});
const itemHeader = style({ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" });
const itemActions = style({ display: "flex", gap: 8, justifyContent: "end" });

const INITIAL_VISIBLE = 5;

export function CurationQueue({ graph, onCurate }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [pending, setPending] = useState<Set<string>>(new Set());

  // Uncurated nodes sorted by confidence ascending — lowest confidence = most
  // in need of human review. Inferred beats extracted when scores tie.
  const queue = useMemo(() => {
    return graph.nodes
      .filter((n) => !n.curated)
      .sort((a, b) => {
        if (a.confidence_score !== b.confidence_score) {
          return a.confidence_score - b.confidence_score;
        }
        return a.confidence === b.confidence ? 0 : a.confidence === "inferred" ? -1 : 1;
      });
  }, [graph.nodes]);

  if (queue.length === 0) return null;

  const visible = expanded ? queue : queue.slice(0, INITIAL_VISIBLE);

  async function handle(node: KnowledgeNode, action: CurationAction) {
    setPending((prev) => new Set(prev).add(node.id));
    try {
      await onCurate(node.id, action);
    } finally {
      setPending((prev) => {
        const next = new Set(prev);
        next.delete(node.id);
        return next;
      });
    }
  }

  return (
    <div className={card}>
      <div className={row}>
        <div>
          <Heading level={3} styles={style({ marginY: 0 })}>
            Pending curation
          </Heading>
          <Text styles={style({ color: "gray-600", font: "body-sm" })}>
            Uncurated nodes sorted by ascending confidence — review lowest first.
          </Text>
        </div>
        <Badge size="S" variant={queue.length > 10 ? "notice" : "informative"}>
          {queue.length} pending
        </Badge>
      </div>

      <Divider size="S" />

      {visible.map((node) => {
        const isPending = pending.has(node.id);
        return (
          <div key={node.id} className={item}>
            <div className={itemHeader}>
              <Badge size="S" variant="neutral">{node.type}</Badge>
              <Badge size="S" variant={node.confidence === "inferred" ? "notice" : "informative"}>
                {node.confidence} · {node.confidence_score.toFixed(2)}
              </Badge>
              {node.source_project_name ? (
                <Badge size="S" variant="accent">{node.source_project_name}</Badge>
              ) : null}
              <Text styles={style({ font: "body-2xs", color: "gray-500" })}>
                from {node.source_pod_name} · <RelativeTime timestamp={node.created_at} />
              </Text>
            </div>
            <Text styles={style({ font: "body-sm" })}>{node.summary}</Text>
            {node.domains.length > 0 ? (
              <div className={itemHeader}>
                {node.domains.slice(0, 5).map((d) => (
                  <Badge key={d} size="S" variant="neutral">{d}</Badge>
                ))}
              </div>
            ) : null}
            <div className={itemActions}>
              <Button
                variant="secondary"
                isDisabled={isPending}
                onPress={() => handle(node, "reject")}
              >
                <Text>Reject</Text>
              </Button>
              <Button
                variant="accent"
                isDisabled={isPending}
                onPress={() => handle(node, "approve")}
              >
                <Text>Approve</Text>
              </Button>
            </div>
          </div>
        );
      })}

      {queue.length > INITIAL_VISIBLE ? (
        <ActionButton onPress={() => setExpanded((v) => !v)}>
          {expanded ? "Show fewer" : `Show all ${queue.length}`}
        </ActionButton>
      ) : null}
    </div>
  );
}
