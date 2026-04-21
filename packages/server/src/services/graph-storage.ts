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
import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";

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

  if (S3_BUCKET) {
    void writeThroughToS3(orgId, graph.version, data).catch((err) => {
      console.error(`[graph-storage] S3 writethrough failed for org ${orgId}:`, err);
    });
  }
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
