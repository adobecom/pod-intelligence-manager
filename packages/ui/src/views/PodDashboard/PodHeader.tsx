import { Heading, Text, Badge, Button } from "@react-spectrum/s2";
import { style } from "@react-spectrum/s2/style" with { type: "macro" };
import { useNavigate } from "react-router-dom";
import type { Pod } from "@council/shared";

const row = style({
  display: "flex",
  alignItems: "baseline",
  gap: 12,
  flexWrap: "wrap",
});

interface PodHeaderProps {
  pod: Pod;
}

export function PodHeader({ pod }: PodHeaderProps) {
  const navigate = useNavigate();

  return (
    <div className={row}>
      <Heading level={2} styles={style({ marginY: 0 })}>
        {pod.name}
      </Heading>
      <Badge variant="informative">
        Day {pod.day_number} of {pod.total_days}
      </Badge>
      <Text styles={style({ color: "neutral-subdued" })}>
        Sprint: {pod.sprint_start} — {pod.sprint_end}
      </Text>
      {pod.project_id && (
        <Button variant="secondary" onPress={() => navigate(`/project/${pod.project_id}`)}>
          View project
        </Button>
      )}
    </div>
  );
}
