import { style } from "@react-spectrum/s2/style" with { type: "macro" };

const legendContainer = style({
  display: "flex",
  flexWrap: "wrap",
  gap: 12,
  paddingY: 8,
});

const NODE_ITEMS = [
  { color: "#2680eb", label: "Decision", shape: "diamond" },
  { color: "#2d9d78", label: "Pattern", shape: "circle" },
  { color: "#e34850", label: "Anti-Pattern", shape: "triangle" },
  { color: "#e68619", label: "Resolved Conflict", shape: "square" },
  { color: "#9256d9", label: "Scope Insight", shape: "star" },
];

const EDGE_ITEMS = [
  { color: "#2d9d78", label: "Builds On", dashed: false },
  { color: "#e34850", label: "Contradicts", dashed: false },
  { color: "#2680eb", label: "Supersedes", dashed: false },
  { color: "#e68619", label: "Resolved By", dashed: false },
  { color: "#999999", label: "Relates To", dashed: true },
];

function ShapeIcon({ color, shape }: { color: string; shape: string }) {
  const size = 12;
  if (shape === "diamond") {
    return (
      <svg width={size} height={size} viewBox="0 0 12 12">
        <polygon points="6,0 12,6 6,12 0,6" fill={color} />
      </svg>
    );
  }
  if (shape === "triangle") {
    return (
      <svg width={size} height={size} viewBox="0 0 12 12">
        <polygon points="6,0 12,12 0,12" fill={color} />
      </svg>
    );
  }
  if (shape === "square") {
    return (
      <svg width={size} height={size} viewBox="0 0 12 12">
        <rect width="12" height="12" fill={color} />
      </svg>
    );
  }
  if (shape === "star") {
    return (
      <svg width={size} height={size} viewBox="0 0 12 12">
        <polygon points="6,0 7.5,4 12,4.5 8.5,7.5 9.5,12 6,9.5 2.5,12 3.5,7.5 0,4.5 4.5,4" fill={color} />
      </svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 12 12">
      <circle cx="6" cy="6" r="6" fill={color} />
    </svg>
  );
}

export function GraphLegend() {
  return (
    <div>
      <div style={{ fontWeight: 600, fontSize: "12px", marginBottom: "4px" }}>Nodes</div>
      <div className={legendContainer}>
        {NODE_ITEMS.map((item) => (
          <span key={item.label} style={{ display: "flex", alignItems: "center", gap: "4px", fontSize: "12px" }}>
            <ShapeIcon color={item.color} shape={item.shape} />
            {item.label}
          </span>
        ))}
      </div>
      <div style={{ fontWeight: 600, fontSize: "12px", marginTop: "8px", marginBottom: "4px" }}>Edges</div>
      <div className={legendContainer}>
        {EDGE_ITEMS.map((item) => (
          <span key={item.label} style={{ display: "flex", alignItems: "center", gap: "4px", fontSize: "12px" }}>
            <svg width="20" height="4" viewBox="0 0 20 4">
              <line
                x1="0" y1="2" x2="20" y2="2"
                stroke={item.color}
                strokeWidth="2"
                strokeDasharray={item.dashed ? "4,3" : undefined}
              />
            </svg>
            {item.label}
          </span>
        ))}
      </div>
    </div>
  );
}
