import { Heading, ProgressBar, Text } from "@react-spectrum/s2";
import { style } from "@react-spectrum/s2/style" with { type: "macro" };
import type { Milestone } from "@council/shared";

const well = style({
  backgroundColor: "gray-75",
  borderRadius: "default",
  padding: 16,
  borderWidth: 1,
  borderStyle: "solid",
  borderColor: "gray-200",
});

const column = style({
  display: "flex",
  flexDirection: "column",
  gap: 8,
});

interface MilestoneProgressProps {
  milestone: Milestone;
}

export function MilestoneProgress({ milestone }: MilestoneProgressProps) {
  return (
    <div className={well}>
      <div className={column}>
        <Heading level={4} styles={style({ marginY: 0 })}>
          Active Milestone
        </Heading>
        <ProgressBar
          label={milestone.name}
          value={milestone.percent_complete}
        />
        <Text styles={style({ font: "body-2xs", color: "gray-600" })}>
          Target: {milestone.target_date}
        </Text>
      </div>
    </div>
  );
}
