import { useState, useMemo, useCallback, useEffect } from "react";
import { flushSync } from "react-dom";
import Markdown from "react-markdown";
import {
  Button,
  Heading,
  SearchField,
  Text,
  ProgressCircle,
  Badge,
  InlineAlert,
  Content,
  NumberField,
  Link,
  Disclosure,
  DisclosureTitle,
  DisclosurePanel,
} from "@react-spectrum/s2";
import { TagGroup, Tag } from "@react-spectrum/s2";
import { Tabs, TabList, Tab, TabPanel } from "@react-spectrum/s2";
import { style } from "@react-spectrum/s2/style" with { type: "macro" };
import { CONTEXT_SOURCES } from "@pim/shared";
import type { ContextSource, ContextSearchHit } from "@pim/shared";
import { useSearchStore } from "../../stores/searchStore";
import { parseSummary } from "./citations";
import type { ParsedSummary } from "./citations";

// ─── Styles ──────────────────────────────────────────────────────────────────

const page = style({ padding: 24, maxWidth: "[1100px]", marginX: "auto" });

const header = style({ display: "flex", flexDirection: "column", gap: 8, marginBottom: 24 });

const searchRow = style({ display: "flex", gap: 12, alignItems: "end", marginBottom: 16 });

const filtersRow = style({
  display: "flex",
  gap: 24,
  flexWrap: "wrap",
  alignItems: "start",
  paddingTop: 8,
  paddingBottom: 4,
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
  padding: 16,
  borderRadius: "default",
  borderWidth: 1,
  borderStyle: "solid",
  borderColor: "gray-200",
  backgroundColor: "layer-1",
});

const hitsMeta = style({
  display: "flex",
  gap: 8,
  flexWrap: "wrap",
  alignItems: "center",
  marginBottom: 4,
});

const loadingContainer = style({
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 48,
});

const tabHitsList = style({
  display: "flex",
  flexDirection: "column",
  gap: 12,
  paddingTop: 16,
});

// ─── Constants ───────────────────────────────────────────────────────────────

const SOURCE_LABELS: Record<ContextSource, string> = {
  kg: "Knowledge Graph",
  slack: "Slack",
  fluffyjaws: "Fluffyjaws",
  jira: "Jira",
  confluence: "Confluence",
  github: "GitHub",
  git: "Git",
};

// ─── Main Component ───────────────────────────────────────────────────────────

export function ContextSearch() {
  const {
    query,
    sources,
    timeWindowDays,
    result,
    loading,
    error,
    setQuery,
    toggleSource,
    setTimeWindowDays,
    run,
  } = useSearchStore();

  const [liveQuery, setLiveQuery] = useState(query);
  const [activeTab, setActiveTab] = useState<string>("all");
  const [highlightedHitIndex, setHighlightedHitIndex] = useState<number | null>(null);

  // Clear highlight after 2s
  useEffect(() => {
    if (highlightedHitIndex === null) return;
    const t = setTimeout(() => setHighlightedHitIndex(null), 2000);
    return () => clearTimeout(t);
  }, [highlightedHitIndex]);

  function onSubmit() {
    setQuery(liveQuery);
    setActiveTab("all");
    void run({ query: liveQuery });
  }

  // Reconcile TagGroup multi-selection with the store's toggleSource API
  const onSourceSelectionChange = useCallback(
    (keys: Set<string | number> | "all") => {
      const newSet =
        keys === "all"
          ? new Set(CONTEXT_SOURCES)
          : new Set(Array.from(keys) as ContextSource[]);
      CONTEXT_SOURCES.forEach((s) => {
        const was = sources.includes(s);
        const will = newSet.has(s);
        if (was !== will) toggleSource(s);
      });
    },
    [sources, toggleSource],
  );

  // Scroll to a hit card (used by citation links for URL-less hits).
  // flushSync forces the tab-switch state update to flush synchronously so the
  // DOM element exists before scrollIntoView runs, eliminating the timing race.
  const scrollToHit = useCallback((index: number) => {
    flushSync(() => {
      setActiveTab("all");
      setHighlightedHitIndex(index);
    });
    document.getElementById(`hit-${index}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, []);

  // Parse the synthesized summary, strip the ## Sources block, linkify citations
  const parsedSummary = useMemo<ParsedSummary | null>(() => {
    if (!result?.summary_md) return null;
    return parseSummary(result.summary_md, result.hits);
  }, [result]);

  // Group hits by source for tabs, preserving server rank order
  const tabItems = useMemo(() => {
    if (!result) return [];

    const all = result.hits.map((hit, i) => ({ hit, globalIndex: i }));

    // Collect sources in first-appearance order
    const sourcesInOrder: ContextSource[] = [];
    const seen = new Set<ContextSource>();
    result.hits.forEach((h) => {
      if (!seen.has(h.source)) {
        seen.add(h.source);
        sourcesInOrder.push(h.source);
      }
    });

    const items = [
      {
        key: "all",
        label: `All (${result.hits.length})`,
        hits: all,
      },
      ...sourcesInOrder.map((source) => {
        const hits = all.filter(({ hit }) => hit.source === source);
        return {
          key: source,
          label: `${SOURCE_LABELS[source]} (${hits.length})`,
          hits,
        };
      }),
    ];

    return items;
  }, [result]);

  // Custom react-markdown renderer: handles pim-cite: links (citations) and
  // renders all other hrefs as proper external links
  const markdownComponents = useMemo(
    () => ({
      a: ({
        href,
        children,
      }: {
        href?: string;
        children?: React.ReactNode;
      }) => {
        if (href?.startsWith("pim-cite:") && parsedSummary) {
          const token = decodeURIComponent(href.replace("pim-cite:", ""));
          const citation = parsedSummary.citations.get(token);

          if (!citation || citation.hitIndex === -1) {
            // Unresolved citation — render as plain text
            return <>{children}</>;
          }

          if (citation.url) {
            // Has a URL — open the source directly in a new tab
            return (
              <Link href={citation.url} target="_blank" rel="noreferrer" isStandalone>
                {children}
              </Link>
            );
          } else {
            // No URL — scroll to the hit card on the All tab
            return (
              <Link isStandalone onPress={() => scrollToHit(citation.hitIndex)}>
                {children}
              </Link>
            );
          }
        }

        // Regular external link in the markdown
        return (
          <Link href={href} target="_blank" rel="noreferrer" isStandalone>
            {children}
          </Link>
        );
      },
    }),
    [parsedSummary, scrollToHit],
  );

  return (
    <div className={page}>
      {/* Header */}
      <div className={header}>
        <Heading level={1}>Context Search</Heading>
        <Text styles={style({ color: "gray-600" })}>
          Cross-source lookup across Slack, Fluffyjaws, Jira, Confluence, GitHub, and local git.
        </Text>
      </div>

      {/* Search bar */}
      <div className={searchRow}>
        <SearchField
          aria-label="Search query"
          placeholder="Search across Slack, Jira, GitHub, Confluence, and more…"
          size="XL"
          value={liveQuery}
          onChange={setLiveQuery}
          onSubmit={onSubmit}
          styles={style({ flexGrow: 1 })}
        />
        <Button
          variant="accent"
          onPress={onSubmit}
          isDisabled={loading || !liveQuery.trim()}
        >
          Search
        </Button>
      </div>

      {/* Filters — collapsible */}
      <Disclosure defaultExpanded isQuiet styles={style({ marginBottom: 20 })}>
        <DisclosureTitle>Filters</DisclosureTitle>
        <DisclosurePanel>
          <div className={filtersRow}>
            <TagGroup
              label="Sources"
              selectionMode="multiple"
              selectedKeys={new Set(sources)}
              onSelectionChange={onSourceSelectionChange}
            >
              {CONTEXT_SOURCES.map((s) => (
                <Tag key={s} id={s}>
                  {SOURCE_LABELS[s]}
                </Tag>
              ))}
            </TagGroup>
            <NumberField
              label="Days back"
              minValue={1}
              maxValue={3650}
              value={timeWindowDays}
              onChange={setTimeWindowDays}
              styles={style({ width: "[120px]" })}
            />
          </div>
        </DisclosurePanel>
      </Disclosure>

      {/* Error state */}
      {error && (
        <InlineAlert variant="negative" styles={style({ marginBottom: 16 })}>
          <Heading>Search failed</Heading>
          <Content>{error}</Content>
        </InlineAlert>
      )}

      {/* Loading state */}
      {loading && (
        <div className={loadingContainer}>
          <ProgressCircle aria-label="Searching…" isIndeterminate />
        </div>
      )}

      {/* Results */}
      {!loading && result && (
        <div className={column}>
          {/* Result meta */}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <Text styles={style({ font: "body-sm", color: "gray-500" })}>
              {result.sources_used.length === 0
                ? "No sources used"
                : `Sources: ${result.sources_used.join(", ")}`}
            </Text>
            <Text styles={style({ font: "body-sm", color: "gray-500" })}>·</Text>
            <Text styles={style({ font: "body-sm", color: "gray-500" })}>
              {result.hits.length} {result.hits.length === 1 ? "hit" : "hits"}
            </Text>
            <Text styles={style({ font: "body-sm", color: "gray-500" })}>·</Text>
            <Text styles={style({ font: "body-sm", color: "gray-500" })}>
              {result.from_cache ? `cached ${result.cached_at?.slice(0, 10) ?? ""}` : "fresh"}
            </Text>
          </div>

          {/* Synthesized summary */}
          {parsedSummary && (
            <div className={summaryCard}>
              <Heading level={2} styles={style({ marginBottom: 12 })}>
                Summary
              </Heading>
              <Markdown components={markdownComponents}>{parsedSummary.body}</Markdown>
            </div>
          )}

          {/* Skipped / missing sources */}
          {result.missing_sources.length > 0 && (
            <InlineAlert variant="informative">
              <Heading>Sources skipped</Heading>
              <Content>
                {result.missing_sources.map((m) => (
                  <div key={m.source}>
                    <strong>{SOURCE_LABELS[m.source]}</strong>: {m.reason}
                  </div>
                ))}
              </Content>
            </InlineAlert>
          )}

          {/* Hits — no results */}
          {result.hits.length === 0 && (
            <Text styles={style({ color: "gray-500" })}>No hits found.</Text>
          )}

          {/* Hits — tabs by source */}
          {result.hits.length > 0 && (
            <Tabs
              selectedKey={activeTab}
              onSelectionChange={(key) => setActiveTab(String(key))}
            >
              <TabList>
                {tabItems.map((item) => (
                  <Tab key={item.key} id={item.key}>
                    {item.label}
                  </Tab>
                ))}
              </TabList>

              {tabItems.map((item) => (
                <TabPanel key={item.key} id={item.key}>
                  <div className={tabHitsList}>
                    {item.hits.map(({ hit, globalIndex }) => (
                      <HitView
                        key={globalIndex}
                        hit={hit}
                        globalIndex={globalIndex}
                        isHighlighted={highlightedHitIndex === globalIndex}
                      />
                    ))}
                  </div>
                </TabPanel>
              ))}
            </Tabs>
          )}
        </div>
      )}
    </div>
  );
}

// ─── HitView ─────────────────────────────────────────────────────────────────

interface HitViewProps {
  hit: ContextSearchHit;
  globalIndex: number;
  isHighlighted: boolean;
}

function HitView({ hit, globalIndex, isHighlighted }: HitViewProps) {
  const isLowTrust = Boolean(hit.metadata?.low_trust);

  return (
    <div
      id={`hit-${globalIndex}`}
      className={hitCard}
      style={
        isHighlighted
          ? {
              outline: "2px solid var(--spectrum-blue-900, #0070f3)",
              outlineOffset: "2px",
              transition: "outline 0.15s ease",
            }
          : undefined
      }
    >
      {/* Source badge + metadata */}
      <div className={hitsMeta}>
        <Badge variant={isLowTrust ? "neutral" : "accent"} size="S">
          {SOURCE_LABELS[hit.source]}
        </Badge>
        {hit.author && (
          <Text styles={style({ font: "body-sm", color: "gray-600" })}>{hit.author}</Text>
        )}
        {hit.timestamp && (
          <Text styles={style({ font: "body-sm", color: "gray-600" })}>
            {hit.timestamp.slice(0, 10)}
          </Text>
        )}
        {isLowTrust && (
          <Badge variant="neutral" size="S">
            low trust
          </Badge>
        )}
      </div>

      {/* Title — Link when url exists, plain bold text when not */}
      <div style={{ marginTop: 4 }}>
        {hit.url ? (
          <Link href={hit.url} target="_blank" rel="noreferrer" isStandalone variant="secondary">
            {hit.title}
          </Link>
        ) : (
          <span style={{ fontWeight: 600 }}>{hit.title}</span>
        )}
      </div>

      {/* Snippet — clamped to 3 lines */}
      <div
        style={{
          marginTop: 8,
          fontSize: 13,
          color: "#555",
          display: "-webkit-box",
          WebkitLineClamp: 3,
          WebkitBoxOrient: "vertical",
          overflow: "hidden",
        }}
      >
        {hit.snippet}
      </div>
    </div>
  );
}
