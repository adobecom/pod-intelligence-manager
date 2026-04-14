import { useEffect, useState } from "react";
import {
  Heading,
  Text,
  InlineAlert,
  Content,
  ActionButton,
  Badge,
} from "@react-spectrum/s2";
import { style } from "@react-spectrum/s2/style" with { type: "macro" };
import { usePodStore } from "../../stores/podStore";
import * as api from "../../services/api";
import type { LintFinding } from "../../services/api";

const column = style({ display: "flex", flexDirection: "column", gap: 8 });
const headerRow = style({ display: "flex", alignItems: "center", justifyContent: "space-between" });

const severityVariant: Record<string, "informative" | "notice" | "negative"> = {
  info: "informative",
  warning: "notice",
  critical: "negative",
};

export function LintFindings() {
  const pod = usePodStore((s) => s.pod);
  const [findings, setFindings] = useState<LintFinding[]>([]);
  const [running, setRunning] = useState(false);

  const podId = pod?.pod_id;
  useEffect(() => {
    if (podId) {
      api.getLintFindings(podId).then(setFindings);
    }
  }, [podId]);

  async function runLint() {
    if (!pod) return;
    setRunning(true);
    try {
      const result = await api.triggerLintPass(pod.pod_id);
      setFindings(result.findings);
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className={column}>
      <div className={headerRow}>
        <div className={style({ display: "flex", alignItems: "center", gap: 8 })}>
          <Heading level={3} styles={style({ marginY: 0 })}>
            Lint Findings
          </Heading>
          {findings.length > 0 && (
            <Badge variant="notice">
              {findings.length}
            </Badge>
          )}
        </div>
        <ActionButton onPress={runLint} isDisabled={running}>
          {running ? "Running..." : "Run Lint"}
        </ActionButton>
      </div>

      {findings.length === 0 ? (
        <Text styles={style({ color: "neutral-subdued" })}>
          No lint findings. Run a lint pass to check for issues.
        </Text>
      ) : (
        findings.map((f) => (
          <InlineAlert key={f.id} variant={severityVariant[f.severity] ?? "informative"}>
            <Heading>{f.type.replace("_", " ")}{f.area ? ` (${f.area})` : ""}</Heading>
            <Content>
              <Text>{f.summary}</Text>
              {f.suggestion && (
                <Text styles={style({ display: "block", font: "body-2xs", color: "neutral-subdued", marginTop: 4 })}>
                  Suggestion: {f.suggestion}
                </Text>
              )}
            </Content>
          </InlineAlert>
        ))
      )}
    </div>
  );
}
