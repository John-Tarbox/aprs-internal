/**
 * Server-side session storage in D1. One row per live session. The cookie
 * carries only the opaque `id` (HMAC-signed via cookie.service). Every
 * request does one indexed lookup joining users + user_roles + roles.
 *
 * Soft-deletion: `revoked_at` is set on logout or when an admin invalidates
 * a user. Expired sessions are filtered at query time; cleanup is a later
 * cron concern (row size is ~100 bytes, not worth a scheduled job yet).
 */

import type { AuthType, AuthUser, RoleName } from '../env';

export interface CreateSessionInput {
  userId: number;
  ttlSeconds: number;
  userAgent?: string;
  ip?: string;
}

function generateSessionId(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function createSession(db: D1Database, input: CreateSessionInput): Promise<string> {
  const id = generateSessionId();
  const expiresAt = new Date(Date.now() + input.ttlSeconds * 1000).toISOString();
  await db
    .prepare(
      `INSERT INTO sessions (id, user_id, expires_at, user_agent, ip)
       VALUES (?, ?, ?, ?, ?)`
    )
    .bind(id, input.userId, expiresAt, input.userAgent ?? null, input.ip ?? null)
    .run();
  return id;
}

export interface ResolvedSession {
  sessionId: string;
  user: AuthUser;
}

/**
 * Look up a session by id, return the attached user with roles, or null
 * if the session is missing, revoked, expired, or belongs to an inactive user.
 *
 * NOTE: we do NOT return sessions for `users.active = 0`. This is what makes
 * admin deactivation effective on the next request — the cookie still
 * decodes fine, but this query returns null and the middleware kicks them
 * back to /login.
 */
export async function resolveSession(db: D1Database, sessionId: string): Promise<ResolvedSession | null> {
  const row = await db
    .prepare(
      `SELECT u.id as user_id, u.email, u.auth_type, u.display_name
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.id = ?
         AND s.revoked_at IS NULL
         AND datetime(s.expires_at) > datetime('now')
         AND u.active = 1`
    )
    .bind(sessionId)
    .first<{ user_id: number; email: string; auth_type: AuthType; display_name: string | null }>();

  if (!row) return null;

  const roleRows = await db
    .prepare(
      `SELECT r.name FROM user_roles ur
       JOIN roles r ON r.id = ur.role_id
       WHERE ur.user_id = ?`
    )
    .bind(row.user_id)
    .all<{ name: RoleName }>();

  const roles = (roleRows.results ?? []).map((r) => r.name);

  return {
    sessionId,
    user: {
      id: row.user_id,
      email: row.email,
      authType: row.auth_type,
      displayName: row.display_name,
      roles,
    },
  };
}

export async function revokeSession(db: D1Database, sessionId: string): Promise<void> {
  await db
    .prepare(`UPDATE sessions SET revoked_at = datetime('now') WHERE id = ? AND revoked_at IS NULL`)
    .bind(sessionId)
    .run();
}

/** Revoke every live session for a user. Used when an admin deactivates someone. */
export async function revokeAllForUser(db: D1Database, userId: number): Promise<void> {
  await db
    .prepare(`UPDATE sessions SET revoked_at = datetime('now') WHERE user_id = ? AND revoked_at IS NULL`)
    .bind(userId)
    .run();
}

export async function touchLastLogin(db: D1Database, userId: number): Promise<void> {
  await db
    .prepare(`UPDATE users SET last_login_at = datetime('now') WHERE id = ?`)
    .bind(userId)
    .run();
}
