import { readFileSync, writeFileSync, existsSync, unlinkSync, chmodSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import os from "node:os";

export interface Credentials {
  access_token: string;
  refresh_token?: string;
  expires_at: number;
  email?: string;
  ims_user_id?: string;
  client_id: string;
  ims_env: "stg1" | "prod";
}

function credentialsDir(): string {
  return path.join(os.homedir(), ".pim");
}

function credentialsPath(): string {
  return path.join(credentialsDir(), "credentials.json");
}

export function loadCredentials(): Credentials | null {
  const p = credentialsPath();
  if (!existsSync(p)) return null;
  try {
    const raw = readFileSync(p, "utf-8");
    return JSON.parse(raw) as Credentials;
  } catch {
    return null;
  }
}

export function saveCredentials(creds: Credentials): void {
  const dir = credentialsDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o700);
  }
  const p = credentialsPath();
  writeFileSync(p, JSON.stringify(creds, null, 2), "utf-8");
  chmodSync(p, 0o600);
}

export function clearCredentials(): boolean {
  const p = credentialsPath();
  if (!existsSync(p)) return false;
  unlinkSync(p);
  return true;
}

/** Returns true if the stored token expires within the next 60 seconds. */
export function isExpired(creds: Credentials): boolean {
  return Date.now() >= creds.expires_at - 60_000;
}

export function getCredentialsPath(): string {
  return credentialsPath();
}

/** Warn if the credentials file has world/group read bits — defense in depth. */
export function assertSecurePermissions(): void {
  const p = credentialsPath();
  if (!existsSync(p)) return;
  try {
    const s = statSync(p);
    if ((s.mode & 0o077) !== 0) {
      chmodSync(p, 0o600);
    }
  } catch {
    // ignore stat failures on platforms without POSIX perms
  }
}
