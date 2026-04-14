import { Heading, Text, ActionButton } from "@react-spectrum/s2";
import { style } from "@react-spectrum/s2/style" with { type: "macro" };
import { useNavigate, useParams } from "react-router-dom";
import { usePodStore } from "../../stores/podStore";
import { RelativeTime } from "../../components/RelativeTime";

const headerRow = style({
  display: "flex",
  alignItems: "baseline",
  justifyContent: "space-between",
});

const column = style({
  display: "flex",
  flexDirection: "column",
  gap: 4,
});

const activityRow = style({
  display: "flex",
  gap: 8,
  alignItems: "baseline",
  paddingX: 12,
  paddingY: 8,
  borderRadius: "default",
  backgroundColor: "layer-1",
});

export function RecentActivity() {
  const contextUpdates = usePodStore((s) => s.contextUpdates);
  const navigate = useNavigate();
  const { podId } = useParams();

  const recent = [...contextUpdates]
    .sort(
      (a, b) =>
        new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
    )
    .slice(0, 5);

  return (
    <div>
      <div className={headerRow}>
        <Heading level={4}>Recent Activity</Heading>
        <ActionButton onPress={() => navigate(`/pod/${podId}/feed`)}>
          View full feed
        </ActionButton>
      </div>
      <div className={column}>
        {recent.map((update) => (
          <div key={update.id} className={activityRow}>
            <Text styles={style({ font: "body-2xs", color: "neutral-subdued", whiteSpace: "nowrap" })}>
              <RelativeTime timestamp={update.timestamp} />
            </Text>
            <Text styles={style({ font: "body-xs", fontWeight: "bold" })}>
              {update.agent_id}:
            </Text>
            <Text styles={style({ font: "body-xs" })}>
              {update.summary}
            </Text>
          </div>
        ))}
      </div>
    </div>
  );
}
