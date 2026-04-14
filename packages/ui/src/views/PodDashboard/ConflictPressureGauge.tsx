import { Heading } from "@react-spectrum/s2";
import { style } from "@react-spectrum/s2/style" with { type: "macro" };
import { PressureMeter } from "../../components/PressureMeter";

const well = style({
  backgroundColor: "layer-1",
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

interface ConflictPressureGaugeProps {
  pressure: number;
}

export function ConflictPressureGauge({
  pressure,
}: ConflictPressureGaugeProps) {
  return (
    <div className={well}>
      <div className={column}>
        <Heading level={4} styles={style({ marginY: 0 })}>
          Conflict Pressure
        </Heading>
        <PressureMeter value={pressure} />
      </div>
    </div>
  );
}
