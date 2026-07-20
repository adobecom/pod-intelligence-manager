import os from "node:os";
import path from "node:path";

// Server modules open SQLite at import time. Give every Vitest worker its own
// database so parallel test-file imports cannot contend while enabling WAL.
// Production never loads this setup file and keeps its configured DB_PATH.
const workerId = process.env.VITEST_WORKER_ID ?? process.env.VITEST_POOL_ID ?? "0";
process.env.DB_PATH = path.join(os.tmpdir(), `pim-server-vitest-${process.pid}-${workerId}.db`);
