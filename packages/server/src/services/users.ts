import { randomUUID } from "crypto";
import db from "../db/connection.js";

export interface UserRecord {
  user_id: string;
  ims_user_id: string | null;
  email: string;
  display_name: string | null;
  is_service: number;
  created_at: string;
  last_login_at: string | null;
}

function row(r: unknown): UserRecord | null {
  if (!r) return null;
  const x = r as UserRecord;
  return {
    user_id: x.user_id,
    ims_user_id: x.ims_user_id,
    email: x.email,
    display_name: x.display_name,
    is_service: Number(x.is_service ?? 0),
    created_at: x.created_at,
    last_login_at: x.last_login_at,
  };
}

export function findUserByImsId(imsUserId: string): UserRecord | null {
  return row(
    db.prepare("SELECT * FROM users WHERE ims_user_id = ?").get(imsUserId),
  );
}

export function findUserByEmail(email: string): UserRecord | null {
  return row(
    db.prepare("SELECT * FROM users WHERE lower(email) = lower(?) AND is_service = 0").get(email),
  );
}

export function findUserById(userId: string): UserRecord | null {
  return row(db.prepare("SELECT * FROM users WHERE user_id = ?").get(userId));
}

export interface UpsertUserInput {
  ims_user_id?: string | null;
  email: string;
  display_name?: string | null;
}

export function upsertUserByIms(input: UpsertUserInput): UserRecord {
  const now = new Date().toISOString();

  if (input.ims_user_id) {
    const existing = findUserByImsId(input.ims_user_id);
    if (existing) {
      db.prepare(
        "UPDATE users SET email = ?, display_name = COALESCE(?, display_name), last_login_at = ? WHERE user_id = ?",
      ).run(input.email, input.display_name ?? null, now, existing.user_id);
      return { ...existing, email: input.email, last_login_at: now };
    }
  }

  // Fallback: match by email (e.g. trust mode, or IMS-less user upgrading)
  const byEmail = findUserByEmail(input.email);
  if (byEmail) {
    if (input.ims_user_id && !byEmail.ims_user_id) {
      db.prepare("UPDATE users SET ims_user_id = ?, last_login_at = ? WHERE user_id = ?").run(
        input.ims_user_id,
        now,
        byEmail.user_id,
      );
      return { ...byEmail, ims_user_id: input.ims_user_id, last_login_at: now };
    }
    db.prepare("UPDATE users SET last_login_at = ? WHERE user_id = ?").run(now, byEmail.user_id);
    return { ...byEmail, last_login_at: now };
  }

  const userId = `user_${randomUUID()}`;
  db.prepare(
    "INSERT INTO users (user_id, ims_user_id, email, display_name, is_service, created_at, last_login_at) VALUES (?, ?, ?, ?, 0, ?, ?)",
  ).run(userId, input.ims_user_id ?? null, input.email, input.display_name ?? null, now, now);

  return {
    user_id: userId,
    ims_user_id: input.ims_user_id ?? null,
    email: input.email,
    display_name: input.display_name ?? null,
    is_service: 0,
    created_at: now,
    last_login_at: now,
  };
}
