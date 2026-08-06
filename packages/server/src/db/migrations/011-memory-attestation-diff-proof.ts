export const MEMORY_ATTESTATION_DIFF_PROOF_MIGRATION_SQL = `
  ALTER TABLE memory_attestations
    ADD COLUMN authoritative_diff_digest TEXT;
`;
