import { useState } from "react";
import { Picker, PickerItem } from "@react-spectrum/s2";
import { style } from "@react-spectrum/s2/style" with { type: "macro" };
import { useOrgStore } from "../../stores/orgStore";
import { usePodStore } from "../../stores/podStore";

const row = style({
  maxWidth: "[420px]",
});

/**
 * Retrospectively link this pod to a project (PATCH /api/pods/:podId).
 */
export function PodProjectAssociation() {
  const pod = usePodStore((s) => s.pod);
  const projects = useOrgStore((s) => s.projects);
  const updatePodProject = usePodStore((s) => s.updatePodProject);
  const [pending, setPending] = useState(false);

  if (!pod) return null;

  return (
    <div className={row}>
      <Picker
        label="Linked project"
        labelPosition="side"
        description="Associate this sprint with a long-lived initiative. You can change or clear this anytime."
        selectedKey={pod.project_id ?? "none"}
        onSelectionChange={async (key) => {
          const id = key === "none" ? null : (key as string);
          setPending(true);
          try {
            await updatePodProject(id);
          } finally {
            setPending(false);
          }
        }}
        isDisabled={pending || projects.length === 0}
      >
        <PickerItem id="none">None</PickerItem>
        {projects.map((p) => (
          <PickerItem key={p.project_id} id={p.project_id} textValue={p.name}>
            {p.name}
          </PickerItem>
        ))}
      </Picker>
    </div>
  );
}
