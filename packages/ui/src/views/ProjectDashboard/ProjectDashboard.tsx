import { Heading, Text, Badge } from "@react-spectrum/s2";
import { style } from "@react-spectrum/s2/style" with { type: "macro" };
import { useProjectStore } from "../../stores/projectStore";

const column = style({ display: "flex", flexDirection: "column", gap: 16 });
const idRow = style({
  backgroundColor: "layer-2",
  borderRadius: "default",
  padding: 12,
  font: "code-sm",
});

export function ProjectDashboard() {
  const project = useProjectStore((s) => s.project);

  if (!project) return null;

  return (
    <div className={column}>
      <div className={style({ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" })}>
        <Heading level={2} styles={style({ marginY: 0 })}>
          {project.name}
        </Heading>
        <Badge variant="informative">Long-lived project</Badge>
      </div>

      <Text styles={style({ color: "neutral-subdued", maxWidth: "[720px]" })}>
        This initiative exists outside any single sprint pod. Context updates here are stored on the project for
        reporting when you are not bound to an active pod (for example CLI `pim report --project`).
        Sprint work, conflicts, and the living doc still live on pods linked to this project when applicable.
      </Text>

      {project.description && (
        <div className={style({ display: "flex", flexDirection: "column", gap: 4 })}>
          <Text styles={style({ fontWeight: "bold", font: "body-sm" })}>Description</Text>
          <Text>{project.description}</Text>
        </div>
      )}

      <div className={style({ display: "flex", flexDirection: "column", gap: 4 })}>
        <Text styles={style({ fontWeight: "bold", font: "body-sm" })}>Project ID</Text>
        <div className={idRow}>
          <Text styles={style({ font: "code-sm", marginY: 0 })}>{project.project_id}</Text>
        </div>
      </div>

      <Text styles={style({ font: "body-2xs", color: "neutral-subdued" })}>
        Created {project.created_at}
      </Text>
    </div>
  );
}
