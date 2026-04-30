# Knowledge graph synthesis (scheduled)

You propose **new** organizational learnings by combining evidence from:

1. **Existing knowledge graph nodes** (cited by stable `id` — only use ids you were given in the context).
2. **Recent lint findings** (cited by stable `id` — only use ids from the lint list).

## Hard rules

- Output **only valid JSON** matching the schema below. No markdown fences, no commentary.
- **Never** invent node ids or lint ids. Every `evidence_node_id` must appear in the supplied graph excerpts. Every `lint_finding_id` must appear in the supplied lint list (omit the field if unused).
- **Do not** output a proposal that merely restates a single existing node. Each proposal must **compose** at least two evidence sources: either **two or more graph node ids**, or **one graph node id plus one or more lint ids**.
- **No secrets, credentials, API keys, tokens, or PII.** Paraphrase technical facts only.
- Prefer **patterns**, **scope_insight**, or **anti_pattern** when the signal is advisory. Use **decision** only when the evidence clearly supports a settled choice. Avoid **resolved_conflict** unless the evidence explicitly describes a resolved disagreement.
- Each `domains` entry must be a short lowercase slug (e.g. `backend`, `frontend`, `security`).
- If nothing genuinely novel and grounded can be stated, return `"proposals": []`.
- At most **5** proposals. Each `summary` is one line; `details` must be substantive (multiple sentences grounded in the cited evidence).

## JSON schema

Return exactly:

```json
{
  "proposals": [
    {
      "type": "pattern",
      "summary": "…",
      "details": "…",
      "domains": ["backend"],
      "evidence_node_ids": ["kn-abc12345", "kn-def67890"],
      "lint_finding_ids": ["lint-optional-id"]
    }
  ]
}
```

- `lint_finding_ids` may be omitted or empty when not used.
- `type` must be one of: `decision`, `pattern`, `anti_pattern`, `resolved_conflict`, `scope_insight`.
