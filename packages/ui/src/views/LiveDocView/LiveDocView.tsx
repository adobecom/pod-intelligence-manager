import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { Badge, Heading, ProgressCircle, Text } from "@react-spectrum/s2";
import { style } from "@react-spectrum/s2/style" with { type: "macro" };
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import * as api from "../../services/api";
import type { LivingDocStats } from "../../services/api";
import { useWebSocket } from "../../hooks/useWebSocket";
import { RelativeTime } from "../../components/RelativeTime";

const column = style({ display: "flex", flexDirection: "column", gap: 16 });

const headerRow = style({
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  flexWrap: "wrap",
  gap: 12,
});

const readersRow = style({
  display: "flex",
  alignItems: "center",
  gap: 8,
  flexWrap: "wrap",
});

const loadingContainer = style({
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  height: 240,
});

const subdued = style({ color: "neutral-subdued", font: "body-2xs" });

const VIEW_DEBOUNCE_MS = 10_000;

export function LiveDocView() {
  const { podId } = useParams<{ podId: string }>();
  const [doc, setDoc] = useState<string | null>(null);
  const [stats, setStats] = useState<LivingDocStats | null>(null);
  const lastViewRecorded = useRef(0);

  function recordView() {
    if (!podId) return;
    const now = Date.now();
    if (now - lastViewRecorded.current < VIEW_DEBOUNCE_MS) return;
    lastViewRecorded.current = now;
    api.recordLivingDocView(podId, "human-user");
  }

  const lastStatsRefresh = useRef(0);
  const STATS_THROTTLE_MS = 10_000;

  function refreshStats() {
    if (!podId) return;
    const now = Date.now();
    if (now - lastStatsRefresh.current < STATS_THROTTLE_MS) return;
    lastStatsRefresh.current = now;
    api.getLivingDocStats(podId).then(setStats).catch(() => {});
  }

  useEffect(() => {
    if (podId) {
      api.getLivingDoc(podId).then(setDoc).catch(() => {});
      refreshStats();
      recordView();
    }
  }, [podId]);

  const handleWSEvent = useCallback((event: { type: string; payload?: unknown }) => {
    if (event.type === "living_doc_updated") {
      const payload = event.payload as { markdown: string };
      setDoc(payload.markdown);
      refreshStats();
    }
    if (event.type === "living_doc_viewed") {
      refreshStats();
    }
  }, [podId]);

  useWebSocket(podId, handleWSEvent);

  if (doc === null) {
    return (
      <div className={loadingContainer}>
        <ProgressCircle aria-label="Loading..." isIndeterminate />
      </div>
    );
  }

  return (
    <div className={column}>
      <div className={headerRow}>
        <Heading level={2} styles={style({ marginY: 0 })}>
          Living Doc
        </Heading>
        <div className={readersRow}>
          {stats?.last_regenerated_at && (
            <Text styles={subdued}>
              Regenerated <RelativeTime timestamp={stats.last_regenerated_at} />
            </Text>
          )}
          {stats && stats.viewers.length > 0 && (
            <>
              <Text styles={subdued}>Readers:</Text>
              {stats.viewers.map(v => (
                <Badge
                  key={v.viewer_id}
                  variant={v.regens_since_last_view === 0 ? "positive" : "neutral"}
                >
                  {v.viewer_id} ({v.view_count})
                </Badge>
              ))}
            </>
          )}
        </div>
      </div>
      <div
        className="living-doc"
        style={{
          maxWidth: 720,
          lineHeight: 1.6,
          fontSize: 14,
        }}
      >
        <Markdown remarkPlugins={[remarkGfm]}>{doc}</Markdown>
      </div>
    </div>
  );
}
