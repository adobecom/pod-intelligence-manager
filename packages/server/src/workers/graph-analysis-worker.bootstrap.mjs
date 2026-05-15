// Worker bootstrap: registers tsx's ESM loader inline (independent of any
// --import / --loader flags from the parent process) and then loads the
// TypeScript worker entry. This makes the worker reliable across:
//   - `tsx watch src/index.ts` (dev)
//   - `node --import tsx src/index.ts` (prod via Dockerfile)
//   - `vitest run` (tests, where the parent loader is vite/esbuild — not tsx)
// All three end up with tsx active for the worker's import chain.

import { register } from "tsx/esm/api";

register();

await import("./graph-analysis-worker.ts");
