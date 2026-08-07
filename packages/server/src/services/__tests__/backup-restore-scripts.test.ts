import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const backupScript = path.join(packageRoot, "scripts/backup.sh");
const restoreScript = path.join(packageRoot, "scripts/restore-db.sh");
const shellToolsAvailable = ["sqlite3", "gzip", "sha256sum"].every(
  (command) => !spawnSync(command, ["--version"], { stdio: "ignore" }).error,
);
const shellIt = shellToolsAvailable ? it : it.skip;

function filesBelow(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const child = path.join(root, entry.name);
    return entry.isDirectory() ? filesBelow(child) : [child];
  });
}

let tempDir = "";

describe("portable core backup and restore scripts", () => {
  afterEach(() => {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = "";
  });

  shellIt("omits derived search rows, verifies a sidecar, and requests a rebuild", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pim-backup-restore-"));
    const sourceDbPath = path.join(tempDir, "source.db");
    const restoredDbPath = path.join(tempDir, "restored.db");
    const fakeS3Root = path.join(tempDir, "s3");
    const fakeBin = path.join(tempDir, "bin");
    fs.mkdirSync(fakeBin, { recursive: true });

    const sourceDb = new DatabaseSync(sourceDbPath);
    sourceDb.exec(`
      CREATE TABLE orgs (org_id TEXT PRIMARY KEY);
      CREATE TABLE project_evidence_items (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE sequence_source (id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT NOT NULL);
      CREATE TABLE project_search_documents (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE repository_scope (org_id TEXT NOT NULL, repository_id TEXT NOT NULL);
      CREATE UNIQUE INDEX idx_repository_scope_identity
        ON repository_scope(org_id, repository_id);
      CREATE TABLE scoped_finding (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        repository_id TEXT NOT NULL,
        FOREIGN KEY (org_id, repository_id)
          REFERENCES repository_scope(org_id, repository_id)
      );
      CREATE TABLE finding_audit (finding_id TEXT NOT NULL);
      CREATE TRIGGER trg_scoped_finding_audit
        AFTER INSERT ON scoped_finding
        BEGIN
          INSERT INTO finding_audit (finding_id) VALUES (NEW.id);
        END;
      INSERT INTO orgs VALUES ('org-1');
      INSERT INTO project_evidence_items VALUES ('evidence-1', 'authoritative evidence');
      INSERT INTO sequence_source (value) VALUES ('keep sequence');
      INSERT INTO project_search_documents VALUES ('derived-1', 'large derived search row');
      INSERT INTO repository_scope VALUES ('org-1', 'github.com/example/repo');
      INSERT INTO scoped_finding VALUES ('finding-1', 'org-1', 'github.com/example/repo');
    `);
    sourceDb.close();

    const fakeAws = path.join(fakeBin, "aws");
    fs.writeFileSync(
      fakeAws,
      `#!/bin/sh
set -eu
[ "\${1:-}" = "s3" ] && [ "\${2:-}" = "cp" ] || exit 2
src="$3"
dst="$4"
case "$src" in
  s3://*)
    relative="\${src#s3://}"
    cp "$FAKE_S3_ROOT/$relative" "$dst"
    ;;
  *)
    relative="\${dst#s3://}"
    target="$FAKE_S3_ROOT/$relative"
    mkdir -p "$(dirname "$target")"
    cp "$src" "$target"
    ;;
esac
`,
      { mode: 0o755 },
    );

    const commonEnv = {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      FAKE_S3_ROOT: fakeS3Root,
      PIM_BACKUPS_BUCKET: "test-bucket",
      AWS_REGION: "us-west-2",
    };
    execFileSync("/bin/sh", [backupScript], {
      env: {
        ...commonEnv,
        DB_PATH: sourceDbPath,
        PIM_BACKUP_LOCK_DIR: path.join(tempDir, "backup.lock"),
      },
    });

    const bucketRoot = path.join(fakeS3Root, "test-bucket");
    const archives = filesBelow(path.join(bucketRoot, "backups/hourly")).filter((file) =>
      file.endsWith(".sql.gz"),
    );
    expect(archives).toHaveLength(1);
    expect(fs.existsSync(`${archives[0]}.sha256`)).toBe(true);
    const restoreKey = path.relative(bucketRoot, archives[0]);

    execFileSync("/bin/sh", [restoreScript], {
      env: {
        ...commonEnv,
        DB_PATH: restoredDbPath,
        PIM_REQUIRE_RESTORE: "true",
        PIM_RESTORE_KEY: restoreKey,
      },
    });

    const restoredDb = new DatabaseSync(restoredDbPath);
    expect(restoredDb.prepare("SELECT count(*) AS n FROM orgs").get()).toEqual({ n: 1 });
    expect(
      restoredDb.prepare("SELECT body FROM project_evidence_items WHERE id = ?").get("evidence-1"),
    ).toEqual({ body: "authoritative evidence" });
    expect(
      restoredDb
        .prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name GLOB 'project_search_*'")
        .get(),
    ).toEqual({ n: 0 });
    expect(restoredDb.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    expect(restoredDb.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(
      restoredDb
        .prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name = 'idx_repository_scope_identity'")
        .get(),
    ).toEqual({ n: 1 });
    expect(
      restoredDb
        .prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name = 'trg_scoped_finding_audit'")
        .get(),
    ).toEqual({ n: 1 });
    restoredDb
      .prepare("INSERT INTO scoped_finding VALUES (?, ?, ?)")
      .run("finding-2", "org-1", "github.com/example/repo");
    expect(restoredDb.prepare("SELECT COUNT(*) AS n FROM finding_audit").get()).toEqual({ n: 2 });
    restoredDb.close();

    expect(fs.existsSync(`${restoredDbPath}.project-search-rebuild-required`)).toBe(true);
  }, 20_000);
});
