/**
 * CLI-only Adobe IMS OAuth helpers re-exported for CLI callers.
 * Implementations live in @pim/shared/auth so the MCP server can share them.
 */

export type { PkcePair } from "@pim/shared/auth";
export {
  generatePkce,
  generateState,
  exchangeCodeForToken,
  getImsEndpoints,
  type ImsEnv,
  type TokenResponse,
} from "@pim/shared/auth";

// CLI historically called this fetchProfile — keep the name for login.ts.
export { fetchImsProfile as fetchProfile } from "@pim/shared/auth";
