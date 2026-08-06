import { createTables } from "../db/schema.js";
import { seedMemoryReadFixture } from "../services/memory-seed.js";

const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the allowlisted memory seed import`);
  return value;
};

createTables();

const result = seedMemoryReadFixture({
  orgId: required("PIM_MEMORY_SEED_ORG_ID"),
  projectId: required("PIM_MEMORY_SEED_PROJECT_ID"),
  repositoryId: required("PIM_MEMORY_SEED_REPOSITORY_ID"),
  displaySlug: required("PIM_MEMORY_SEED_DISPLAY_SLUG"),
  providerRepositoryId: required("PIM_MEMORY_SEED_PROVIDER_REPOSITORY_ID"),
});

console.log(JSON.stringify({
  record_id: result.record.record_id,
  record_version: result.record.record_version,
  repository_id: result.repositoryId,
}));

