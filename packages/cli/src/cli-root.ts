import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute path to the `@pim/cli` package (directory with package.json). */
export function getCliPackageRoot(): string {
  const envRoot = process.env.PIM_CLI_ROOT?.trim();
  if (envRoot && fs.existsSync(path.join(envRoot, "package.json"))) {
    return path.resolve(envRoot);
  }

  for (const arg of process.argv.slice(1)) {
    if (!arg || arg.startsWith("-")) continue;
    try {
      const abs = path.resolve(arg);
      const base = path.basename(abs);
      if (!fs.existsSync(abs) && !base.includes("pim.bundle")) continue;

      if (base.includes("pim.bundle")) {
        const root = path.resolve(path.dirname(abs), "..");
        if (fs.existsSync(path.join(root, "package.json"))) return root;
      }
      if ((base === "index.ts" || base === "index.js") && fs.existsSync(abs)) {
        const dir = path.dirname(abs);
        const leaf = path.basename(dir);
        if (leaf === "src" || leaf === "dist") {
          const root = path.resolve(dir, "..");
          if (fs.existsSync(path.join(root, "package.json"))) return root;
        }
      }
    } catch {
      /* continue */
    }
  }

  try {
    const url = import.meta.url;
    if (typeof url === "string" && url.startsWith("file:")) {
      const here = path.dirname(fileURLToPath(url));
      for (const candidate of [path.resolve(here, ".."), path.resolve(here, "../..")]) {
        const pj = path.join(candidate, "package.json");
        if (fs.existsSync(pj)) {
          try {
            const pkg = JSON.parse(fs.readFileSync(pj, "utf-8")) as { name?: string };
            if (pkg.name === "@pim/cli") return candidate;
          } catch {
            /* ignore */
          }
        }
      }
    }
  } catch {
    /* bundled single-file CJS: import.meta.url is unreliable */
  }

  throw new Error(
    "Cannot locate @pim/cli package root. If you use the bundled CLI, run it via `bin/pim.mjs` or set PIM_CLI_ROOT to your clone's packages/cli directory.",
  );
}

/** Ensures `process.env.PIM_CLI_ROOT` is set for hook runners and init templates. */
export function ensureCliPackageRootEnv(): void {
  try {
    process.env.PIM_CLI_ROOT = getCliPackageRoot();
  } catch {
    /* lazily retried when resolving paths */
  }
}
