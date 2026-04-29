# npm / Artifactory (internal packages)

This monorepo publishes **`ado-pim`**, **`@pim/shared`**, **`@pim/sdk`**, and **`@pim/mcp-server`** to Adobe Artifactory using the **`npm-adobe-release`** repository.

## Registry URL (authoritative)

Use the URL from **Artifactory → npm-adobe-release → Set me up**. It should match:

`https://artifactory-uw2.adobeitc.com/artifactory/api/npm/npm-adobe-release/`

Root **`.npmrc`** in git sets **`@pim:registry=…`** only (no secrets). **`ado-pim`** uses **`publishConfig.registry`** in `packages/cli/package.json`.

## Authentication (never commit tokens)

1. Prefer **browser login** (per Artifactory UI):

   ```bash
   npm login --registry=https://artifactory-uw2.adobeitc.com/artifactory/api/npm/npm-adobe-release/ --auth-type=web --scope=@pim
   ```

2. Or put the **scoped** snippet in your **user** **`~/.npmrc`**, not the repo:

   ```ini
   @pim:registry=https://artifactory-uw2.adobeitc.com/artifactory/api/npm/npm-adobe-release/
   //artifactory-uw2.adobeitc.com/artifactory/api/npm/npm-adobe-release/:_authToken=<token>
   //artifactory-uw2.adobeitc.com/artifactory/api/npm/npm-adobe-release/:email=you@adobe.com
   //artifactory-uw2.adobeitc.com/artifactory/api/npm/npm-adobe-release/:always-auth=true
   ```

3. Verify:

   ```bash
   npm whoami --registry=https://artifactory-uw2.adobeitc.com/artifactory/api/npm/npm-adobe-release/
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
