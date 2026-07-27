export type SkillCatalogMetricUnit = "Count" | "Milliseconds";

export interface SkillCatalogMetric {
  name:
    | "ExactShaBuildFailures"
    | "EmbeddingBackfillDepth"
    | "EmbeddingBackfillFailures"
    | "SearchLatency"
    | "SearchResultCount"
    | "SearchUnavailable"
    | "SingleFlightQueueDepth"
    | "SnapshotBuildLatency"
    | "ValidationConflictKind"
    | "ValidationOutcome"
    | "WebhookToEntriesReadyLag";
  value: number;
  unit: SkillCatalogMetricUnit;
  timestampMs: number;
  dimensions?: Record<string, string>;
  fields?: Record<string, string | number | boolean | null>;
}

export type SkillCatalogMetricSink = (metric: SkillCatalogMetric) => void;

export interface SkillCatalogMetricLogger {
  info: (obj: unknown, msg?: string) => void;
}

const CLOUDWATCH_NAMESPACE = "PIM/SkillCatalog";

let metricSink: SkillCatalogMetricSink = () => undefined;

export function recordSkillCatalogMetric(
  metric: Omit<SkillCatalogMetric, "timestampMs"> & { timestampMs?: number },
): void {
  try {
    metricSink({
      ...metric,
      timestampMs: metric.timestampMs ?? Date.now(),
    });
  } catch {
    // Telemetry must never change catalog availability or webhook handling.
  }
}

/**
 * Emits CloudWatch Embedded Metric Format through the existing structured
 * application logger. Source and org identifiers stay as searchable log fields,
 * not CloudWatch dimensions, to avoid unbounded metric cardinality.
 */
export function createCloudWatchSkillCatalogMetricSink(
  log: SkillCatalogMetricLogger,
): SkillCatalogMetricSink {
  return (metric) => {
    const dimensions = metric.dimensions ?? {};
    log.info(
      {
        _aws: {
          Timestamp: metric.timestampMs,
          CloudWatchMetrics: [
            {
              Namespace: CLOUDWATCH_NAMESPACE,
              Dimensions: [Object.keys(dimensions)],
              Metrics: [{ Name: metric.name, Unit: metric.unit }],
            },
          ],
        },
        ...dimensions,
        ...metric.fields,
        [metric.name]: metric.value,
      },
      "Skill catalog metric",
    );
  };
}

export function setSkillCatalogMetricSink(
  sink: SkillCatalogMetricSink | null,
): void {
  metricSink = sink ?? (() => undefined);
}
