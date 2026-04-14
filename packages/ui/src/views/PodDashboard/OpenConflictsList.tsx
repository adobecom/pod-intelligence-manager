import { Heading, Text, ActionButton } from "@react-spectrum/s2";
import { style } from "@react-spectrum/s2/style" with { type: "macro" };
import { useNavigate, useParams } from "react-router-dom";
import { usePodStore } from "../../stores/podStore";
import { SeverityBadge } from "../../components/SeverityBadge";
import { RelativeTime } from "../../components/RelativeTime";

const column = style({
  display: "flex",
  flexDirection: "column",
  gap: 8,
});

const card = style({
  backgroundColor: "layer-1",
  padding: 12,
  borderRadius: "default",
  borderWidth: 1,
  borderStyle: "solid",
  borderColor: "gray-300",
});

const cardRow = style({
  display: "flex",
  justifyContent: "space-between",
  alignItems: "start",
  gap: 12,
});

const cardContent = style({
  display: "flex",
  flexDirection: "column",
  gap: 4,
  flexGrow: 1,
  minWidth: 0,
});

const idRow = style({
  display: "flex",
  alignItems: "center",
  gap: 8,
});

export function OpenConflictsList() {
  const conflicts = usePodStore((s) =>
    s.conflicts.filter((c) => c.status !== "resolved"),
  );
  const navigate = useNavigate();
  const { podId } = useParams();

  return (
    <div>
      <Heading level={4}>
        Open Conflicts ({conflicts.length})
      </Heading>
      {conflicts.length === 0 ? (
        <Text styles={style({ color: "neutral-subdued" })}>
          No open conflicts
        </Text>
      ) : (
        <div className={column}>
          {conflicts.map((conflict) => (
            <div key={conflict.id} className={card}>
              <div className={cardRow}>
                <div className={cardContent}>
                  <div className={idRow}>
                    <Text styles={style({ font: "body-sm", fontWeight: "bold" })}>
                      {conflict.id}
                    </Text>
                    <SeverityBadge severity={conflict.severity} />
                  </div>
                  <Text>{conflict.summary}</Text>
                  <Text styles={style({ font: "body-2xs", color: "neutral-subdued" })}>
                    Opened <RelativeTime timestamp={conflict.created_at} />
                    {" · "}
                    {conflict.sides.map((s) => s.contributor).join(" vs ")}
                  </Text>
                </div>
                <ActionButton
                  onPress={() =>
                    navigate(`/pod/${podId}/conflict/${conflict.id}`)
                  }
                >
                  View
                </ActionButton>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
