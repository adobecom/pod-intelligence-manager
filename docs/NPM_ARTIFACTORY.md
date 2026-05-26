# npm / Artifactory (internal packages)

This monorepo publishes **`ado-pim`**, **`@pim/shared`**, **`@pim/sdk`**, and **`@pim/mcp-server`** to Adobe Artifactory using the **`npm-adobe-pim-release`** repository.

## Registry URL (authoritative)

`https://artifactory-uw2.adobeitc.com/artifactory/api/npm/npm-adobe-pim-release/`

Root **`.npmrc`** in git sets **`@pim:registry=…`** to this URL (no secrets). **`ado-pim`** and all `@pim/*` packages use **`publishConfig.registry`** in their `package.json` as well.

> **Common mistake:** `~/.npmrc` may have `@pim:registry` pointing to `npm-adobe-release` (the broader Adobe registry). The `@pim` packages live on `npm-adobe-pim-release` — ensure your user config matches the repo `.npmrc`.

## Authentication (never commit tokens)

1. Prefer **browser login** (per Artifactory UI):

   ```bash
   npm login --registry=https://artifactory-uw2.adobeitc.com/artifactory/api/npm/npm-adobe-pim-release/ --auth-type=web --scope=@pim
   ```

2. Or put the **scoped** snippet in your **user** **`~/.npmrc`**, not the repo:

   ```ini
   @pim:registry=https://artifactory-uw2.adobeitc.com/artifactory/api/npm/npm-adobe-pim-release/
   //artifactory-uw2.adobeitc.com/artifactory/api/npm/npm-adobe-pim-release/:_authToken=<token>
   //artifactory-uw2.adobeitc.com/artifactory/api/npm/npm-adobe-pim-release/:email=you@adobe.com
   ```

   Omit **`//.../:always-auth`** — Artifactory’s “Set me up” snippet often includes it, but **npm 11+** treats per-registry **`always-auth`** as an unknown key and will drop it in a future major. A **`_authToken`** for that host is enough for Artifactory in practice.

3. Verify:

   ```bash
   npm whoami --registry=https://artifactory-uw2.adobeitc.com/artifactory/api/npm/npm-adobe-pim-release/
   ```

If a token was ever pasted into the **repo** `.npmrc`, **revoke it** in Artifactory and create a new one.

## Publish (from repo root)

After manager approval and a non-colliding version (consider a prerelease for smoke tests):

```bash
pnpm publish -r --filter @pim/shared --filter @pim/sdk --filter @pim/mcp-server --filter ado-pim --no-git-checks
```

Or publish one package at a time. Ensure **`pnpm build`** has run so **`dist/`** exists (**`prepublishOnly`** runs **`build`** where configured).

## CI

GitHub Actions does **not** store Artifactory tokens in this repo. To publish from CI, use a protected secret and generate **`~/.npmrc`** in the workflow (out of scope here).
