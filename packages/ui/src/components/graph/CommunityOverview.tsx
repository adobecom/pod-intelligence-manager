import { Badge, Text } from "@react-spectrum/s2";
import { style } from "@react-spectrum/s2/style" with { type: "macro" };
import type { CommunitySummary } from "@council/shared";

const container = style({
  display: "flex",
  flexWrap: "wrap",
  gap: 12,
});

const card = style({
  padding: 16,
  backgroundColor: "layer-1",
  borderRadius: "default",
  borderWidth: 1,
  borderStyle: "solid",
  borderColor: "gray-200",
  minWidth: "[180px]",
  flex: 1,
});

const domainRow = style({
  display: "flex",
  gap: 4,
  flexWrap: "wrap",
  marginTop: 8,
});

interface CommunityOverviewProps {
  communities: CommunitySummary[];
}

export function CommunityOverview({ communities }: CommunityOverviewProps) {
  if (communities.length === 0) {
    return (
      <Text styles={style({ font: "body-2xs", color: "gray-500" })}>
        No communities detected yet.
      </Text>
    );
  }

  return (
    <div className={container}>
      {communities.map((c) => (
        <div key={c.id} className={card}>
          <Text styles={style({ fontWeight: "bold", font: "body-xs" })}>
            {c.label}
          </Text>
          <Text styles={style({ font: "body-2xs", color: "gray-600", marginTop: 4 })}>
            {c.node_count} learnings
          </Text>
          <Text styles={style({ font: "body-2xs", color: "gray-500", marginTop: 4 })}>
            {c.summary}
          </Text>
          <div className={domainRow}>
            {c.top_domains.map((d) => (
              <Badge key={d} size="S">
                {d}
              </Badge>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
