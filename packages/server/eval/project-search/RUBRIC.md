# Project Search Candidate Judgment Rubric

Fixture version: 2026-07-19.v1

This is a synthetic, stable evaluation fixture for deterministic offline retrieval tests. It is designed to resemble an Acme project that binds Jira project ACME, GitHub repository acme/search, Slack channels C-eng-search and C-release, and Confluence space SRCH.

Every query and relevance judgment is labelled candidate_requires_human_review. The fixture has not been human-verified and must not be represented as a gold set until a reviewer explicitly adjudicates it.

## Query strata

The 25 queries are evenly divided across five retrieval behaviors:

- exact_identifier: Direct lookups for a Jira key, pull request, commit, Slack thread, or Confluence page.
- paraphrase: Natural-language wording that does not simply copy a document title.
- current_status: Questions whose answer must reflect the frozen project snapshot, including blockers, progress, deployment state, or measured latency.
- slack_thread: Questions that specifically seek a decision or discussion captured in a bound Slack thread.
- confluence_doc: Questions that specifically seek a design, policy, evaluation, or operational page in the bound Confluence space.

Reviewers should preserve this balance. If a query moves strata, replace or reclassify another query so each stratum remains represented.

## Relevance grades

The qrels contain only positively relevant artifacts. Unlisted corpus artifacts are treated as relevance 0 for that query.

| Grade | Meaning | Judgment test |
| --- | --- | --- |
| 3 | Directly relevant | The artifact answers the stated intent or is the exact artifact requested, with evidence in its title, body, or comments. |
| 2 | Substantially useful | The artifact supplies material supporting context, corroboration, or implementation detail, but is not the primary requested record. |
| 1 | Topically related | The artifact can orient a reader or points to the answer, but does not itself satisfy the full intent. |
| 0 | Not relevant | The artifact is unrelated, merely shares generic terms, or would distract a user from answering the intent. |

A generic title-only match cannot receive a grade above 1 unless the query explicitly asks for that exact title or identifier. For current-status questions, a superseded status should not receive grade 3 when a later artifact in the frozen snapshot provides the current state.

## Exact identifiers

An exact-identifier query receives grade 3 only for the canonical artifact with the requested native identifier. Documents that merely mention the identifier may be useful for another intent, but are unlisted and therefore grade 0 for the direct lookup unless a reviewer identifies a concrete reason to add them.

## Slack and Confluence intent

Source intent matters:

- When a query asks where a Slack decision was made, the matching Slack thread is grade 3. A ticket, commit, or project update that repeats the decision may be grade 1 or 2.
- When a query asks for a Confluence page or document, the matching page is grade 3. An implementation artifact may be grade 1 or 2.
- A document from the requested source should not receive grade 3 merely because it contains the same keywords; its content must satisfy the stated intent.

## Citation correctness

For a retrieved relevant artifact, the citation is correct only when both of these values match the corpus entry:

1. The returned source_id equals the judged source_id.
2. The returned source URL equals the corpus source_url for that source_id.

Redirects, guessed URLs, title-only references, and citations to a different artifact that mentions the answer are not exact citation matches. Evaluation code may report missed relevant artifacts separately from malformed citations, but it must not count an unreturned judgment as a correct citation.

For this runner, citation correctness is the exact-URL fraction among retrieved relevant artifacts. When a query has relevant judgments but retrieves none, it receives zero rather than a vacuous pass; recall separately measures how much judged evidence was retrieved.

## Human review procedure

At least one reviewer familiar with project-search behavior should:

1. Read each query's intent without looking at the current ranking.
2. Inspect the complete 25-document corpus, not only the proposed qrels.
3. Confirm, remove, add, or re-grade judgments using the definitions above.
4. Check that rationales describe evidence in the artifact rather than expected rank.
5. Confirm all source identifiers and source URLs resolve to the intended synthetic corpus entries.
6. Record adjudication provenance outside this fixture before changing any review_status value.

If reviewers disagree, retain candidate_requires_human_review until the disagreement is adjudicated. Do not tune judgments to improve a particular implementation's score, and do not infer human verification from a passing automated validation.

## Stability rules

- Corpus dates are fixed in January 2024 so recency boosts expire uniformly.
- URLs use the reserved eval.invalid host and must never trigger live connector access.
- Source identifiers are globally unique within the corpus.
- Fixture, query, and qrel versions must change together when meaningfully edited.
- Automated validators should require exactly 25 queries, five queries per stratum, at least one qrel per query, relevance values from 1 through 3, and qrel source identifiers that exist in the corpus.
