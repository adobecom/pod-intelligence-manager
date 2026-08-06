# Project search corpus scrub

This command is destructive. It rewrites eligible project evidence through the current canonical redactor, deletes evidence that fails normalization or visibility admission, discards old candidates and project-search derivatives, rebuilds the sanitized index without embeddings, clears the context-search disk cache, enables SQLite secure deletion, vacuums the database, and truncates the WAL.

Use the repository-required Node 24 runtime. Stop all other PIM processes and take an approved incident snapshot only if policy requires one. That snapshot remains sensitive and must not become an application rollback path.

Run the fail-closed scrub for the whole database:

```sh
pnpm --filter @pim/server scrub-project-search -- --yes
```

Or limit it to one project:

```sh
pnpm --filter @pim/server scrub-project-search -- --yes --project PROJECT_ID
```

Legacy rows have `visibility=unknown` and are deleted by default. Only after independently proving that every legacy row is visible to the entire PIM project audience may an operator retain them with:

```sh
pnpm --filter @pim/server scrub-project-search -- --yes --admit-legacy-project-visible
```

Afterward, run connector reconciliation and embedding backfill. Rotate or expire external database backups, EBS/volume snapshots, replicas, log archives, and any copied `.data/context-search-cache` directories according to the deployment security-retention procedure. The command cannot modify those external systems.
