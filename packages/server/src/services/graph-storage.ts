/**
 * Graph Storage Service — versioned JSON persistence for the knowledge graph.
 *
 * Local filesystem is authoritative at runtime (in-memory graph is rebuilt from it on startup).
 * When KG_S3_BUCKET is set, saves are mirrored to S3 as a durability layer, and an
 * initial restore from S3 runs if the local directory is empty.
 *
 * Config:
 *   KG_DATA_DIR    — base directory (default: <cwd>/.data/knowledge-graph; prod: /data/knowledge-graph)
 *   KG_S3_BUCKET   — optional S3 bucket for writethrough + restore
 *   KG_S3_PREFIX   — key prefix in the bucket (default: "knowledge-graph")
 *   AWS_REGION     — region for the S3 client
 */

import fs from "node:fs";
import path from "node:path";
import type { KnowledgeGraph } from "@pim/shared";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  CopyObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";

const DATA_ROOT = process.env.KG_DATA_DIR
  ? path.resolve(process.env.KG_DATA_DIR)
  : path.resolve(process.cwd(), ".data", "knowledge-graph");

const S3_BUCKET = process.env.KG_S3_BUCKET;
const S3_PREFIX = process.env.KG_S3_PREFIX ?? "knowledge-graph";

let s3: S3Client | null = null;
function getS3(): S3Client {
  if (!s3) s3 = new S3Client({ region: process.env.AWS_REGION });
  return s3;
}

function orgDir(orgId: string): string {
  return path.join(DATA_ROOT, orgId);
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function latestPath(orgId: string): string {
  return path.join(orgDir(orgId), "graph-latest.json");
}

function versionPath(orgId: string, version: number): string {
  return path.join(orgDir(orgId), `graph-v${version}.json`);
}

const KEEP_VERSIONS = 10;
const VERSION_FILE_RE = /^graph-v(\d+)\.json$/;

/** Keep only the most recent KEEP_VERSIONS versioned snapshots; delete older ones. */
function pruneOldVersions(dir: string): void {
  try {
    const versioned: { version: number; file: string }[] = [];
    for (const file of fs.readdirSync(dir)) {
      const match = file.match(VERSION_FILE_RE);
      if (!match) continue;
      versioned.push({ version: Number(match[1]), file });
    }
    if (versioned.length <= KEEP_VERSIONS) return;
    versioned.sort((a, b) => b.version - a.version);
    for (const { file } of versioned.slice(KEEP_VERSIONS)) {
      try {
        fs.unlinkSync(path.join(dir, file));
      } catch (err) {
        console.warn(`[graph-storage] Failed to prune ${file}:`, err);
      }
    }
  } catch (err) {
    console.warn(`[graph-storage] Version pruning skipped for ${dir}:`, err);
  }
}

function s3LatestKey(orgId: string): string {
  return `${S3_PREFIX}/${orgId}/graph-latest.json`;
}

function s3VersionKey(orgId: string, version: number): string {
  return `${S3_PREFIX}/${orgId}/graph-v${version}.json`;
}

export function loadGraph(orgId: string): KnowledgeGraph | null {
  const filePath = latestPath(orgId);
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(raw) as KnowledgeGraph;
}

export function saveGraph(orgId: string, graph: KnowledgeGraph): void {
  const dir = orgDir(orgId);
  ensureDir(dir);

  const data = JSON.stringify(graph, null, 2);

  if (data.length > 10 * 1024 * 1024) {
    console.warn(
      `[graph-storage] Graph for org ${orgId} exceeds 10MB (${(data.length / 1024 / 1024).toFixed(1)}MB)`,
    );
  }

  const vPath = versionPath(orgId, graph.version);
  fs.writeFileSync(vPath, data, "utf-8");

  // Atomic write: tmp file must live in the same directory (and thus same
  // filesystem) as the destination, otherwise rename() fails with EXDEV when
  // /tmp and /data are separate volumes (as in the EC2 Docker deploy).
  const tmpPath = path.join(dir, `.graph-latest-${Date.now()}.tmp`);
  fs.writeFileSync(tmpPath, data, "utf-8");
  fs.renameSync(tmpPath, latestPath(orgId));

  pruneOldVersions(dir);

  if (S3_BUCKET) {
    void writeThroughToS3(orgId, graph.version, data).catch((err) => {
      console.error(`[graph-storage] S3 writethrough failed for org ${orgId}:`, err);
    });
  }
}

/** Destructive scrub helper: remove local historical graph snapshots after a
 * canonical rewrite. `graph-latest.json` is retained as the sanitized active
 * graph; remote mirrors/backups are handled by the deployment runbook. */
export function purgeLocalGraphHistory(orgId: string): number {
  const dir = orgDir(orgId);
  if (!fs.existsSync(dir)) return 0;
  let removed = 0;
  for (const file of fs.readdirSync(dir)) {
    if (!VERSION_FILE_RE.test(file)) continue;
    fs.unlinkSync(path.join(dir, file));
    removed++;
  }
  return removed;
}

export function getGraphVersion(orgId: string): number {
  const graph = loadGraph(orgId);
  return graph?.version ?? 0;
}

async function writeThroughToS3(orgId: string, version: number, body: string): Promise<void> {
  if (!S3_BUCKET) return;
  const client = getS3();
  await Promise.all([
    client.send(
      new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: s3VersionKey(orgId, version),
        Body: body,
        ContentType: "application/json",
      }),
    ),
    client.send(
      new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: s3LatestKey(orgId),
        Body: body,
        ContentType: "application/json",
      }),
    ),
  ]);
}

/**
 * One-shot migration: move the pre-multi-tenant `default/` graph slot into a
 * specific org's slot. Runs idempotently — exits if the target org's slot
 * already exists, so it is safe to leave the env var set across redeploys
 * until the legacy directory has been verified gone.
 *
 * Migrates both local filesystem and (when KG_S3_BUCKET is set) S3, including
 * versioned snapshots. The in-JSON `org_id` field of the latest graph is
 * rewritten to match the target org so query metadata stays consistent.
 *
 * Triggered by env var `PIM_LEGACY_DEFAULT_GRAPH_ORG_ID=<org_id>` — set this on
 * the first deploy that ships the multi-tenant refactor; remove it afterwards.
 */
const LEGACY_ORG_ID = "default";
export async function migrateLegacyDefaultGraph(targetOrgId: string): Promise<void> {
  if (!targetOrgId || targetOrgId === LEGACY_ORG_ID) return;

  const legacyDir = orgDir(LEGACY_ORG_ID);
  const targetDir = orgDir(targetOrgId);
  const legacyExists = fs.existsSync(legacyDir);
  const targetExists = fs.existsSync(targetDir);

  if (!legacyExists && !S3_BUCKET) {
    return; // nothing to migrate, nowhere to look
  }
  if (targetExists && (!S3_BUCKET || (await s3HasOrgPrefix(targetOrgId)))) {
    // Already migrated — leave things alone.
    return;
  }

  console.log(
    `[graph-storage] Migrating legacy "default" graph → org "${targetOrgId}" (local=${legacyExists}, s3=${Boolean(S3_BUCKET)})`,
  );

  if (legacyExists && !targetExists) {
    ensureDir(path.dirname(targetDir));
    fs.renameSync(legacyDir, targetDir);
    // Rewrite the latest graph's in-JSON org_id so reads see the new owner.
    const latest = latestPath(targetOrgId);
    if (fs.existsSync(latest)) {
      try {
        const raw = fs.readFileSync(latest, "utf-8");
        const obj = JSON.parse(raw) as KnowledgeGraph;
        if (obj.org_id !== targetOrgId) {
          obj.org_id = targetOrgId;
          fs.writeFileSync(latest, JSON.stringify(obj, null, 2), "utf-8");
        }
      } catch (err) {
        console.warn(`[graph-storage] Failed to rewrite org_id on migrated graph:`, err);
      }
    }
  }

  if (S3_BUCKET) {
    await migrateS3Prefix(LEGACY_ORG_ID, targetOrgId);
  }
}

async function s3HasOrgPrefix(orgId: string): Promise<boolean> {
  if (!S3_BUCKET) return true;
  const client = getS3();
  const res = await client.send(
    new ListObjectsV2Command({
      Bucket: S3_BUCKET,
      Prefix: `${S3_PREFIX}/${orgId}/`,
      MaxKeys: 1,
    }),
  );
  return Boolean(res.Contents && res.Contents.length > 0);
}

async function migrateS3Prefix(fromOrgId: string, toOrgId: string): Promise<void> {
  if (!S3_BUCKET) return;
  const client = getS3();
  const fromPrefix = `${S3_PREFIX}/${fromOrgId}/`;
  const toPrefix = `${S3_PREFIX}/${toOrgId}/`;

  const listRes = await client.send(
    new ListObjectsV2Command({ Bucket: S3_BUCKET, Prefix: fromPrefix }),
  );
  const objects = listRes.Contents ?? [];
  if (objects.length === 0) return;

  for (const obj of objects) {
    if (!obj.Key) continue;
    const newKey = toPrefix + obj.Key.slice(fromPrefix.length);
    const isLatest = obj.Key.endsWith("graph-latest.json");

    let body: string | undefined;
    if (isLatest) {
      // Rewrite org_id in the latest snapshot's body so query metadata reflects the new owner.
      const get = await client.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: obj.Key }));
      const raw = await get.Body?.transformToString();
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as KnowledgeGraph;
          parsed.org_id = toOrgId;
          body = JSON.stringify(parsed, null, 2);
        } catch {
          body = raw;
        }
      }
    }

    if (body !== undefined) {
      await client.send(
        new PutObjectCommand({
          Bucket: S3_BUCKET,
          Key: newKey,
          Body: body,
          ContentType: "application/json",
        }),
      );
    } else {
      await client.send(
        new CopyObjectCommand({
          Bucket: S3_BUCKET,
          CopySource: encodeURIComponent(`${S3_BUCKET}/${obj.Key}`),
          Key: newKey,
        }),
      );
    }

    await client.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: obj.Key }));
  }

  console.log(`[graph-storage] Migrated ${objects.length} S3 object(s) from "${fromOrgId}/" to "${toOrgId}/"`);
}

/**
 * If S3 is configured and local storage for this org is empty, restore graph-latest.json
 * from S3 so the in-memory initializer can hydrate from it. No-op otherwise.
 * Call this once during server startup, before initializeKnowledgeGraph().
 */
export async function restoreGraphFromS3IfEmpty(orgId: string): Promise<void> {
  if (!S3_BUCKET) return;
  if (fs.existsSync(latestPath(orgId))) return;

  const client = getS3();
  try {
    const head = await client.send(
      new ListObjectsV2Command({
        Bucket: S3_BUCKET,
        Prefix: `${S3_PREFIX}/${orgId}/graph-latest.json`,
        MaxKeys: 1,
      }),
    );
    if (!head.Contents || head.Contents.length === 0) return;

    const obj = await client.send(
      new GetObjectCommand({ Bucket: S3_BUCKET, Key: s3LatestKey(orgId) }),
    );
    const body = await obj.Body?.transformToString();
    if (!body) return;

    ensureDir(orgDir(orgId));
    fs.writeFileSync(latestPath(orgId), body, "utf-8");
    console.log(`[graph-storage] Restored graph for org ${orgId} from s3://${S3_BUCKET}/${s3LatestKey(orgId)}`);
  } catch (err) {
    console.error(`[graph-storage] S3 restore check failed for org ${orgId}:`, err);
  }
}
