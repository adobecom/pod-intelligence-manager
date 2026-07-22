# Project Search Offline Evaluation

This directory freezes a small, self-contained retrieval baseline for the production `searchProject` read path. The 25-document corpus and all URLs are synthetic; `eval.invalid` cannot route to a real connector.

The query and qrel labels are **candidates that require human review**. They have not been human-adjudicated and are not a gold set. Follow [RUBRIC.md](./RUBRIC.md) before changing `review_status` or using the scores for broad quality claims.

## Run and compare

From the repository root:

```sh
pnpm --filter @pim/server project-search-eval -- \
  --compare packages/server/eval/project-search/baseline.json \
  --fail-on-regression \
  --output /tmp/project-search-eval.json
```

The command seeds a new temporary SQLite database, indexes the frozen corpus with the production indexer, runs the production `searchProject` function, prints a complete report, and removes the database. Compare mode emits aggregate deltas and a diff for every query: metric deltas, top-10 additions/removals, and rank changes. `--fail-on-regression` exits `2` if any aggregate or per-query quality metric declines; rank-only changes and latency changes are informational.

Run without `--compare` to inspect a fresh report. After an intentional, reviewed baseline change, freeze a compact ranked-output snapshot with:

```sh
pnpm --filter @pim/server project-search-eval -- \
  --freeze packages/server/eval/project-search/baseline.json
```

Baseline JSON follows [baseline.schema.json](./baseline.schema.json). Its top-10 array order is the rank; it intentionally excludes unstable database document IDs and runtime-only score details.

Focused verification commands are:

```sh
pnpm --filter @pim/server test:project-search-eval
pnpm --filter @pim/server typecheck:project-search-eval
```

The repository requires Node 24 or newer.

## Deterministic execution boundary

The runner fixes the following capabilities before importing the search service:

- embeddings, synthesis, KG overlay, graph expansion, and live connector fallback are off;
- ingestion and indexed reads are independently enabled for the bounded fixture (`PROJECT_*_INGESTION_ENABLED=1` and `PROJECT_*_SEARCH_ENABLED=1`);
- `CONFLUENCE_BASE_URL=https://eval.invalid` pins the current source instance, and Confluence fixture documents are indexed under the matching `eval.invalid` instance;
- the FTS5 table is removed so every host exercises the production lexical `LIKE` fallback, regardless of its bundled SQLite extensions;
- `CONFLUENCE_PROJECT_VISIBLE_SPACE_KEYS=SRCH` is set explicitly, making the fixture space an operator-approved project-wide visibility boundary rather than treating resource binding as permission;
- `CONFLUENCE_PROJECT_VISIBLE_PAGE_IDS` is cleared;
- all artifacts have fixed January 2024 timestamps, stable native IDs, and unique `eval.invalid` citation URLs.

This baseline measures deterministic indexed retrieval, not semantic quality or synthesized-answer faithfulness. Latency is measured after one warm-up query and reported as nearest-rank p50/p95. It is useful for local characterization, but is not a portable load gate.

## Metric definitions

- **Recall@10:** unique judged artifacts with relevance greater than zero retrieved in the top 10, divided by all judged relevant artifacts.
- **NDCG@10:** graded gain `2^relevance - 1`, logarithmically discounted and normalized against the ideal top 10.
- **MRR@10:** reciprocal rank of the first judged relevant artifact.
- **Citation correctness@10:** among retrieved relevant artifacts, the fraction whose returned URL exactly matches the frozen corpus URL for that source ID. A query with relevant qrels but no retrieved relevant artifact scores zero; a judgment-free query would be vacuously correct.
- **p50/p95 latency:** nearest-rank percentiles over the 25 measured production-search calls.

Metrics are macro-averaged across queries overall and within each of the five strata.

## Frozen baseline and known gates

The checked-in baseline was captured with the explicit SRCH visibility policy and contains:

| Stratum | Recall@10 | NDCG@10 | MRR@10 | Citation correctness@10 |
| --- | ---: | ---: | ---: | ---: |
| Overall | 0.750000 | 0.633430 | 0.681159 | 0.960000 |
| Exact identifier | 1.000000 | 1.000000 | 1.000000 | 1.000000 |
| Paraphrase | 0.683333 | 0.564063 | 0.575000 | 1.000000 |
| Current status | 0.566667 | 0.452766 | 0.568571 | 1.000000 |
| Slack thread | 0.600000 | 0.259503 | 0.362222 | 0.800000 |
| Confluence document | 0.900000 | 0.890820 | 0.900000 | 1.000000 |

Measured fixture latency was p50 `1.975 ms` and p95 `2.980 ms`; treat those values as descriptive only.

The plan's exact-identifier MRR@10 gate of `1.0` passes, and overall citation correctness is `0.96`, clearing the `0.95` candidate-set gate. The Slack stratum still exposes a severe candidate-query miss: `q-slack-02` retrieves none of its judged relevant evidence, producing zero Recall/NDCG/MRR/citation correctness for that query. There is no per-class release threshold at this sample size, but the miss should be explained or fixed before claiming Slack retrieval quality. These are baseline observations, not accepted relevance claims, until the candidate labels are human-reviewed.

Security and integrity cases such as wrong-project leakage, private/restricted evidence, unbind/delete, prompt injection, and secret redaction deliberately remain in deterministic service tests rather than being mixed into these relevance qrels.

## Files

- `corpus.json`: frozen project profile and 25 source artifacts.
- `queries.json`: 25 candidates, five per requested stratum.
- `qrels.json`: graded candidate judgments and evidence rationales.
- `RUBRIC.md`: adjudication and fixture-stability rules.
- `baseline.json`: compact current top-10 output and metrics.
- `baseline.schema.json`: versioned baseline interchange format.
- `metrics.ts` / `metrics.test.ts`: metric implementation and focused unit coverage.
