import { useEffect, useCallback, lazy, Suspense } from "react";
import { Heading, Text, ProgressCircle, Badge, Divider } from "@react-spectrum/s2";
import { style } from "@react-spectrum/s2/style" with { type: "macro" };
import { useKnowledgeStore } from "../../stores/knowledgeStore";
import { GraphLegend } from "../../components/graph/GraphLegend";
import { GraphControls } from "../../components/graph/GraphControls";
import { NodeDetailPanel } from "../../components/graph/NodeDetailPanel";
import { CommunityOverview } from "../../components/graph/CommunityOverview";

// Lazy-load vis-network heavy component
const NetworkGraph = lazy(() =>
  import("../../components/graph/NetworkGraph").then((m) => ({
    default: m.NetworkGraph,
  })),
);

const page = style({ padding: 24 });
const column = style({ display: "flex", flexDirection: "column", gap: 32 });

const statsBar = style({
  display: "flex",
  gap: 12,
  flexWrap: "wrap",
  alignItems: "center",
});

const mainLayout = style({
  display: "flex",
  gap: 24,
});

const graphArea = style({
  flexGrow: 1,
  minWidth: 0,
});

const sidePanel = style({
  width: "[320px]",
  flexShrink: 0,
});

const loadingContainer = style({
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  height: "[400px]",
});

const emptyState = style({
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  height: "[400px]",
  gap: 16,
  backgroundColor: "layer-1",
  borderRadius: "default",
  borderWidth: 1,
  borderStyle: "solid",
  borderColor: "gray-200",
  padding: 32,
});

const controlsCard = style({
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

const sectionHeader = style({
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
});

export function KnowledgeGraphView() {
  const graph = useKnowledgeStore((s) => s.graph);
  const stats = useKnowledgeStore((s) => s.stats);
  const loading = useKnowledgeStore((s) => s.loading);
  const selectedNodeId = useKnowledgeStore((s) => s.selectedNodeId);
  const filters = useKnowledgeStore((s) => s.filters);
  const loadGraph = useKnowledgeStore((s) => s.loadGraph);
  const selectNode = useKnowledgeStore((s) => s.selectNode);
  const setFilters = useKnowledgeStore((s) => s.setFilters);
  const curateNode = useKnowledgeStore((s) => s.curateNode);

  useEffect(() => {
    loadGraph();
  }, [loadGraph]);

  const handleNodeClick = useCallback(
    (nodeId: string | null) => selectNode(nodeId),
    [selectNode],
  );

  const selectedNode =
    selectedNodeId && graph
      ? graph.nodes.find((n) => n.id === selectedNodeId) ?? null
      : null;

  if (loading) {
    return (
      <div className={loadingContainer}>
        <ProgressCircle aria-label="Loading knowledge graph..." isIndeterminate />
      </div>
    );
  }

  const isEmpty = !graph || graph.nodes.length === 0;

  return (
    <div className={page}>
      <div className={column}>
        {/* Header */}
        <div>
          <Heading level={2} styles={style({ marginY: 0 })}>
            Knowledge Graph
          </Heading>
          <Text styles={style({ font: "body", color: "gray-600", marginTop: 4 })}>
            Organizational memory accumulated from archived pods
          </Text>
        </div>

        {/* Stats bar */}
        {stats && (
          <div className={statsBar}>
            <Badge size="S">{stats.total_nodes} nodes</Badge>
            <Badge size="S">{stats.total_edges} edges</Badge>
            <Badge size="S">{stats.total_communities} communities</Badge>
            <Divider orientation="vertical" size="S" />
            <Badge size="S" variant="informative">
              {stats.nodes_by_confidence.extracted ?? 0} extracted
            </Badge>
            <Badge size="S" variant="informative">
              {stats.nodes_by_confidence.inferred ?? 0} inferred
            </Badge>
            {stats.updated_at && (
              <Text styles={style({ font: "body-2xs", color: "gray-500" })}>
                Updated: {new Date(stats.updated_at).toLocaleString()}
              </Text>
            )}
          </div>
        )}

        {isEmpty ? (
          <div className={emptyState}>
            <Heading level={3} styles={style({ marginY: 0 })}>
              No knowledge yet
            </Heading>
            <Text styles={style({ color: "gray-600", textAlign: "center", maxWidth: "[400px]" })}>
              Archive a pod to extract learnings into the knowledge graph.
              The graph accumulates organizational memory across all pod lifecycles.
            </Text>
          </div>
        ) : (
          <>
            {/* Controls + Legend card */}
            <div className={controlsCard}>
              <GraphControls filters={filters} onChange={setFilters} />
              <Divider size="S" />
              <GraphLegend />
            </div>

            {/* Graph + detail panel */}
            <div className={mainLayout}>
              <div className={graphArea}>
                <Suspense
                  fallback={
                    <div className={loadingContainer}>
                      <ProgressCircle aria-label="Loading graph visualization..." isIndeterminate />
                    </div>
                  }
                >
                  <NetworkGraph
                    graph={graph}
                    filters={filters}
                    selectedNodeId={selectedNodeId}
                    onNodeClick={handleNodeClick}
                    height="550px"
                  />
                </Suspense>
              </div>

              {selectedNode && (
                <div className={sidePanel}>
                  <NodeDetailPanel
                    node={selectedNode}
                    graph={graph}
                    onCurate={(action) => curateNode(selectedNode.id, action)}
                    onClose={() => selectNode(null)}
                  />
                </div>
              )}
            </div>

            {/* Communities */}
            {graph.communities.length > 0 && (
              <div>
                <div className={sectionHeader}>
                  <Heading level={3} styles={style({ marginY: 0 })}>
                    Communities
                  </Heading>
                  <Text styles={style({ font: "body-2xs", color: "gray-500" })}>
                    {graph.communities.length} clusters detected
                  </Text>
                </div>
                <div style={{ marginTop: "12px" }}>
                  <CommunityOverview communities={graph.communities} />
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
