/**
 * Graph Storage Service — S3-compatible filesystem abstraction.
 *
 * Stores the knowledge graph as versioned JSON files.
 * Local path: .data/knowledge-graph/{org_id}/
 *
 * To migrate to S3: re-implement loadGraph, saveGraph, getGraphVersion
 * using @aws-sdk/client-s3 PutObjectCommand/GetObjectCommand.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { KnowledgeGraph } from "@council/shared";

const DATA_ROOT = path.resolve(process.cwd(), ".data", "knowledge-graph");

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

  // Warn if graph is getting large (>10MB)
  if (data.length > 10 * 1024 * 1024) {
    console.warn(
      `[graph-storage] Graph for org ${orgId} exceeds 10MB (${(data.length / 1024 / 1024).toFixed(1)}MB)`,
    );
  }

  // Save versioned snapshot
  const vPath = versionPath(orgId, graph.version);
  fs.writeFileSync(vPath, data, "utf-8");

  // Atomic write for latest: write to temp file, then rename
  const tmpPath = path.join(os.tmpdir(), `graph-latest-${orgId}-${Date.now()}.json`);
  fs.writeFileSync(tmpPath, data, "utf-8");
  fs.renameSync(tmpPath, latestPath(orgId));
}

export function getGraphVersion(orgId: string): number {
  const graph = loadGraph(orgId);
  return graph?.version ?? 0;
}
