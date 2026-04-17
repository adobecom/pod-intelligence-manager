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
import type { LintFinding, LintPassMeta } from "../../services/api";

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
  const [lastLintMeta, setLastLintMeta] = useState<LintPassMeta | null>(null);

  const podId = pod?.pod_id;
  useEffect(() => {
    if (podId) {
      setLastLintMeta(null);
      api.getLintFindings(podId).then(setFindings);
    }
  }, [podId]);

  async function runLint() {
    if (!pod) return;
    setRunning(true);
    try {
      const result = await api.triggerLintPass(pod.pod_id);
      setFindings(result.findings);
      setLastLintMeta(result.meta);
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

      {lastLintMeta && (
        <Text styles={style({ font: "body-xs", color: "neutral-subdued" })}>
          {lastLintMeta.bedrock_configured ? (
            lastLintMeta.llm_ok ? (
              <>
                LLM supplement (fast model
                {lastLintMeta.llm_model ? `: ${lastLintMeta.llm_model}` : ""}) added{" "}
                {lastLintMeta.llm_extra_findings} finding(s).
              </>
            ) : (
              <>LLM supplement failed: {lastLintMeta.llm_error ?? "unknown error"}</>
            )
          ) : (
            <>LLM supplement skipped — set AWS_BEARER_TOKEN_BEDROCK on the server to enable the fast (Haiku) pass.</>
          )}
        </Text>
      )}

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
