import { Button, Badge, InlineAlert, Heading } from "@react-spectrum/s2";
import { style } from "@react-spectrum/s2/style" with { type: "macro" };
import type { KnowledgeGraph, KnowledgeNode } from "@pim/shared";

const panel = style({
  padding: 16,
  backgroundColor: "layer-1",
  borderRadius: "default",
  borderWidth: 1,
  borderStyle: "solid",
  borderColor: "gray-200",
});

const section = style({
  marginTop: 12,
});

const edgeList = style({
  listStyleType: "none",
  paddingStart: 0,
  marginY: 4,
  font: "body-2xs",
});

const metaRow = style({
  display: "flex",
  gap: 8,
  flexWrap: "wrap",
  marginTop: 8,
});

const TYPE_LABELS: Record<string, string> = {
  decision: "Decision",
  pattern: "Pattern",
  anti_pattern: "Anti-Pattern",
  resolved_conflict: "Resolved Conflict",
  scope_insight: "Scope Insight",
};

const EDGE_TYPE_LABELS: Record<string, string> = {
  relates_to: "relates to",
  supersedes: "supersedes",
  contradicts: "contradicts",
  builds_on: "builds on",
  resolved_by: "resolved by",
};

interface NodeDetailPanelProps {
  node: KnowledgeNode;
  graph: KnowledgeGraph;
  onCurate: (action: "approve" | "reject") => void;
  onClose: () => void;
}

export function NodeDetailPanel({ node, graph, onCurate, onClose }: NodeDetailPanelProps) {
  // Find connected edges and nodes
  const connectedEdges = graph.edges.filter(
    (e) => e.source === node.id || e.target === node.id,
  );
  const connectedNodeIds = new Set(
    connectedEdges.flatMap((e) => [e.source, e.target]).filter((id) => id !== node.id),
  );
  const connectedNodes = graph.nodes.filter((n) => connectedNodeIds.has(n.id));

  const confidencePercent = (node.confidence_score * 100).toFixed(0);

  return (
    <div className={panel}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "start" }}>
        <Heading level={4} styles={style({ marginY: 0 })}>
          {TYPE_LABELS[node.type] ?? node.type}
        </Heading>
        <Button variant="secondary" size="S" onPress={onClose}>
          Close
        </Button>
      </div>

      <p style={{ margin: "8px 0", fontSize: "14px", fontWeight: 600 }}>{node.summary}</p>

      {node.details && (
        <p style={{ margin: "4px 0", fontSize: "13px", color: "#666" }}>{node.details}</p>
      )}

      <div className={metaRow}>
        <Badge size="S">{node.confidence === "extracted" ? "Extracted" : "Inferred"}</Badge>
        <Badge size="S">{confidencePercent}% confidence</Badge>
        {node.curated && <Badge size="S">Curated</Badge>}
        <Badge size="S">{node.source_pod_name}</Badge>
      </div>

      <div className={metaRow}>
        {node.domains.map((d) => (
          <Badge key={d} size="S" variant="informative">
            {d}
          </Badge>
        ))}
      </div>

      {connectedEdges.length > 0 && (
        <div className={section}>
          <div style={{ fontWeight: 600, fontSize: "12px", marginBottom: "4px" }}>
            Connections ({connectedEdges.length})
          </div>
          <ul className={edgeList}>
            {connectedEdges.map((edge, i) => {
              const otherId = edge.source === node.id ? edge.target : edge.source;
              const otherNode = connectedNodes.find((n) => n.id === otherId);
              const direction = edge.source === node.id ? "to" : "from";
              return (
                <li key={i} style={{ padding: "2px 0" }}>
                  {EDGE_TYPE_LABELS[edge.type] ?? edge.type} ({direction}){" "}
                  <strong title={otherNode?.summary ?? otherId}>
                    {otherNode?.summary
                      ? otherNode.summary.length > 50
                        ? otherNode.summary.slice(0, 47) + "..."
                        : otherNode.summary
                      : otherId}
                  </strong>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {!node.curated && (
        <div className={section}>
          <InlineAlert variant="informative">
            This learning has not been reviewed by a human yet.
          </InlineAlert>
          <div style={{ display: "flex", gap: "8px", marginTop: "8px" }}>
            <Button variant="accent" size="S" onPress={() => onCurate("approve")}>
              Approve
            </Button>
            <Button variant="negative" size="S" onPress={() => onCurate("reject")}>
              Reject
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
