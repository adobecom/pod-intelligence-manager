import { useEffect, useRef, useCallback } from "react";
import { Network, type Options } from "vis-network";
import { DataSet } from "vis-data";
import type { KnowledgeGraph, KnowledgeNode, KnowledgeQueryFilters } from "@council/shared";
import { style } from "@react-spectrum/s2/style" with { type: "macro" };

const NODE_COLORS: Record<string, string> = {
  decision: "#2680eb",     // blue
  pattern: "#2d9d78",      // green
  anti_pattern: "#e34850",  // red
  resolved_conflict: "#e68619", // orange
  scope_insight: "#9256d9", // purple
};

const NODE_SHAPES: Record<string, string> = {
  decision: "diamond",
  pattern: "dot",
  anti_pattern: "triangle",
  resolved_conflict: "square",
  scope_insight: "star",
};

const EDGE_COLORS: Record<string, string> = {
  relates_to: "#999999",
  supersedes: "#2680eb",
  contradicts: "#e34850",
  builds_on: "#2d9d78",
  resolved_by: "#e68619",
};

const container = style({
  width: "full",
  backgroundColor: "layer-1",
  borderRadius: "default",
  borderWidth: 1,
  borderStyle: "solid",
  borderColor: "gray-200",
});

interface NetworkGraphProps {
  graph: KnowledgeGraph;
  filters: KnowledgeQueryFilters;
  selectedNodeId: string | null;
  onNodeClick: (nodeId: string | null) => void;
  height?: string;
}

export function NetworkGraph({
  graph,
  filters,
  selectedNodeId,
  onNodeClick,
  height = "500px",
}: NetworkGraphProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const networkRef = useRef<Network | null>(null);

  const filterNode = useCallback(
    (node: KnowledgeNode): boolean => {
      if (filters.types?.length && !filters.types.includes(node.type)) return false;
      if (filters.domains?.length) {
        const hasDomain = filters.domains.some((d) => node.domains.includes(d));
        if (!hasDomain) return false;
      }
      if (filters.confidence_min !== undefined && node.confidence_score < filters.confidence_min) return false;
      if (filters.curated_only && !node.curated) return false;
      if (filters.text_search) {
        const search = filters.text_search.toLowerCase();
        if (!node.summary.toLowerCase().includes(search)) return false;
      }
      return true;
    },
    [filters],
  );

  useEffect(() => {
    if (!containerRef.current) return;

    const filteredNodes = graph.nodes.filter(filterNode);
    const filteredNodeIds = new Set(filteredNodes.map((n) => n.id));

    const nodes = new DataSet(
      filteredNodes.map((n) => ({
        id: n.id,
        label: n.summary.length > 40 ? n.summary.slice(0, 37) + "..." : n.summary,
        title: `${n.type.replace("_", " ")} | ${n.summary}\n${n.domains.join(", ")} | ${n.source_pod_name}\nConfidence: ${(n.confidence_score * 100).toFixed(0)}%`,
        color: {
          background: NODE_COLORS[n.type] ?? "#999",
          border: selectedNodeId === n.id ? "#000000" : NODE_COLORS[n.type] ?? "#999",
          highlight: { background: NODE_COLORS[n.type] ?? "#999", border: "#000000" },
        },
        shape: NODE_SHAPES[n.type] ?? "dot",
        size: 10 + n.confidence_score * 20,
        borderWidth: selectedNodeId === n.id ? 3 : 1,
        font: { size: 11, color: "#333" },
        group: n.community_id,
      })),
    );

    const edges = new DataSet(
      graph.edges
        .filter((e) => filteredNodeIds.has(e.source) && filteredNodeIds.has(e.target))
        .map((e, i) => ({
          id: `e-${i}`,
          from: e.source,
          to: e.target,
          color: { color: EDGE_COLORS[e.type] ?? "#ccc", opacity: 0.6 },
          width: Math.max(1, e.weight * 3),
          dashes: e.type === "relates_to",
          title: `${e.type.replace("_", " ")} (weight: ${e.weight.toFixed(2)})`,
          arrows: e.type === "supersedes" || e.type === "builds_on" ? "to" : undefined,
        })),
    );

    const options: Options = {
      physics: {
        solver: "forceAtlas2Based",
        forceAtlas2Based: { gravitationalConstant: -40, springLength: 120 },
        stabilization: { iterations: 100 },
      },
      interaction: {
        hover: true,
        tooltipDelay: 200,
        zoomView: true,
        dragView: true,
      },
      layout: { improvedLayout: true },
    };

    if (networkRef.current) {
      networkRef.current.destroy();
    }

    const network = new Network(containerRef.current, { nodes, edges }, options);
    networkRef.current = network;

    network.on("click", (params) => {
      if (params.nodes.length > 0) {
        onNodeClick(params.nodes[0] as string);
      } else {
        onNodeClick(null);
      }
    });

    network.once("stabilizationIterationsDone", () => {
      network.fit({ animation: { duration: 300, easingFunction: "easeInOutQuad" } });
    });

    return () => {
      network.destroy();
      networkRef.current = null;
    };
  }, [graph, filters, selectedNodeId, filterNode, onNodeClick]);

  return (
    <div
      ref={containerRef}
      className={container}
      style={{ height, minHeight: "300px" }}
    />
  );
}
