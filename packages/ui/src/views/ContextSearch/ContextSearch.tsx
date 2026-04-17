import { useState } from "react";
import Markdown from "react-markdown";
import {
  Button,
  Heading,
  SearchField,
  Text,
  ProgressCircle,
  Badge,
  Divider,
  InlineAlert,
  Content,
} from "@react-spectrum/s2";
import { style } from "@react-spectrum/s2/style" with { type: "macro" };
import { CONTEXT_SOURCES } from "@council/shared";
import type { ContextSource, ContextSearchHit } from "@council/shared";
import { useSearchStore } from "../../stores/searchStore";

const page = style({ padding: 24, maxWidth: "[980px]", marginX: "auto" });
const header = style({ display: "flex", flexDirection: "column", gap: 8, marginBottom: 20 });
const searchBar = style({ display: "flex", gap: 12, alignItems: "end", marginBottom: 16 });
const filtersRow = style({
  display: "flex",
  flexWrap: "wrap",
  gap: 12,
  alignItems: "center",
  marginBottom: 24,
});
const column = style({ display: "flex", flexDirection: "column", gap: 16 });
const summaryCard = style({
  backgroundColor: "layer-1",
  padding: 20,
  borderRadius: "default",
  borderWidth: 1,
  borderStyle: "solid",
  borderColor: "gray-200",
});
const hitCard = style({
  padding: 12,
  borderRadius: "default",
  borderWidth: 1,
  borderStyle: "solid",
  borderColor: "gray-200",
});
const metaRow: React.CSSProperties = {
  display: "flex",
  gap: 8,
  flexWrap: "wrap",
  alignItems: "center",
  fontSize: 12,
  color: "#6b7280",
};
const loadingContainer = style({
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 48,
});

const SOURCE_LABELS: Record<ContextSource, string> = {
  slack: "Slack",
  fluffyjaws: "Fluffyjaws",
  jira: "Jira",
  confluence: "Confluence",
  github: "GitHub",
  git: "Git",
};

export function ContextSearch() {
  const { query, sources, timeWindowDays, result, loading, error, setQuery, toggleSource, setTimeWindowDays, run } =
    useSearchStore();

  const [liveQuery, setLiveQuery] = useState(query);

  function onSubmit() {
    setQuery(liveQuery);
    void run({ query: liveQuery });
  }

  return (
    <div className={page}>
      <div className={header}>
        <Heading level={1}>Context Search</Heading>
        <Text>Cross-source lookup across Slack, Fluffyjaws, Jira, Confluence, GitHub, and local git.</Text>
      </div>

      <div className={searchBar}>
        <div style={{ flexGrow: 1 }}>
          <SearchField
            label="Query"
            value={liveQuery}
            onChange={(v) => setLiveQuery(v)}
            onSubmit={onSubmit}
          />
        </div>
        <Button variant="accent" onPress={onSubmit} isDisabled={loading || !liveQuery.trim()}>
          Search
        </Button>
      </div>

      <div className={filtersRow}>
        {CONTEXT_SOURCES.map((s) => {
          const selected = sources.includes(s);
          return (
            <label
              key={s}
              style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, cursor: "pointer" }}
            >
              <input type="checkbox" checked={selected} onChange={() => toggleSource(s)} />
              {SOURCE_LABELS[s]}
            </label>
          );
        })}
        <span style={{ marginLeft: 12 }} />
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
          Days:
          <input
            type="number"
            min={1}
            max={3650}
            value={timeWindowDays}
            onChange={(e) => setTimeWindowDays(Math.max(1, Number(e.target.value) || 90))}
            style={{ width: 72 }}
          />
        </label>
      </div>

      {error && (
        <InlineAlert variant="negative">
          <Heading>Search failed</Heading>
          <Content>{error}</Content>
        </InlineAlert>
      )}

      {loading && (
        <div className={loadingContainer}>
          <ProgressCircle aria-label="Searching" isIndeterminate />
        </div>
      )}

      {!loading && result && (
        <div className={column}>
          <div style={metaRow}>
            <span>Sources used: {result.sources_used.length === 0 ? "none" : result.sources_used.join(", ")}</span>
            <span>·</span>
            <span>{result.hits.length} hits</span>
            <span>·</span>
            <span>{result.from_cache ? "cached" : "fresh"}</span>
          </div>

          {result.summary_md && (
            <div className={summaryCard}>
              <Heading level={2}>Summary</Heading>
              <Markdown>{result.summary_md}</Markdown>
            </div>
          )}

          {result.missing_sources.length > 0 && (
            <InlineAlert variant="informative">
              <Heading>Sources skipped</Heading>
              <Content>
                {result.missing_sources.map((m) => (
                  <div key={m.source}>
                    <strong>{m.source}</strong>: {m.reason}
                  </div>
                ))}
              </Content>
            </InlineAlert>
          )}

          <Heading level={2}>Hits</Heading>
          <Divider size="S" />
          {result.hits.map((hit, i) => (
            <HitView key={i} hit={hit} />
          ))}
          {result.hits.length === 0 && <Text>No hits.</Text>}
        </div>
      )}
    </div>
  );
}

function HitView({ hit }: { hit: ContextSearchHit }) {
  return (
    <div className={hitCard}>
      <div style={metaRow}>
        <Badge variant={hit.metadata?.low_trust ? "neutral" : "accent"} size="S">
          {hit.source}
        </Badge>
        {hit.author && <span>{hit.author}</span>}
        {hit.timestamp && <span>{hit.timestamp.slice(0, 10)}</span>}
        {Boolean(hit.metadata?.low_trust) && <span>· low trust</span>}
      </div>
      <div style={{ marginTop: 6, fontWeight: 600 }}>
        {hit.url ? (
          <a href={hit.url} target="_blank" rel="noreferrer">
            {hit.title}
          </a>
        ) : (
          hit.title
        )}
      </div>
      <div style={{ marginTop: 6, fontSize: 13, color: "#555" }}>{hit.snippet}</div>
    </div>
  );
}
