/**
 * User CRUD + role assignment for the dual-provider identity model.
 *
 * Lookup is always case-insensitive on email (schema has COLLATE NOCASE,
 * but we still lowercase in queries out of habit).
 */

import type { AuthType, RoleName } from '../env';

export interface UserRow {
  id: number;
  email: string;
  authType: AuthType;
  displayName: string | null;
  active: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  invitedByUserId: number | null;
}

export interface UserWithRoles extends UserRow {
  roles: RoleName[];
}

interface RawUserRow {
  id: number;
  email: string;
  auth_type: AuthType;
  display_name: string | null;
  active: number;
  created_at: string;
  last_login_at: string | null;
  invited_by_user_id: number | null;
}

function hydrateUser(row: RawUserRow): UserRow {
  return {
    id: row.id,
    email: row.email,
    authType: row.auth_type,
    displayName: row.display_name,
    active: row.active === 1,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
    invitedByUserId: row.invited_by_user_id,
  };
}

export async function findUserByEmail(
  db: D1Database,
  email: string,
  authType?: AuthType
): Promise<UserRow | null> {
  const normalized = email.trim().toLowerCase();
  const row = authType
    ? await db
        .prepare(`SELECT * FROM users WHERE email = ? AND auth_type = ?`)
        .bind(normalized, authType)
        .first<RawUserRow>()
    : await db.prepare(`SELECT * FROM users WHERE email = ?`).bind(normalized).first<RawUserRow>();
  return row ? hydrateUser(row) : null;
}

export interface InsertUserInput {
  email: string;
  authType: AuthType;
  displayName?: string;
  invitedByUserId?: number;
}

export async function insertUser(db: D1Database, input: InsertUserInput): Promise<UserRow> {
  const normalized = input.email.trim().toLowerCase();
  const res = await db
    .prepare(
      `INSERT INTO users (email, auth_type, display_name, invited_by_user_id)
       VALUES (?, ?, ?, ?)
       RETURNING *`
    )
    .bind(normalized, input.authType, input.displayName ?? null, input.invitedByUserId ?? null)
    .first<RawUserRow>();
  if (!res) throw new Error('Failed to insert user');
  return hydrateUser(res);
}

export async function deactivateUser(db: D1Database, userId: number): Promise<void> {
  await db.prepare(`UPDATE users SET active = 0 WHERE id = ?`).bind(userId).run();
}

export async function reactivateUser(db: D1Database, userId: number): Promise<void> {
  await db.prepare(`UPDATE users SET active = 1 WHERE id = ?`).bind(userId).run();
}

/** Replace the user's role set atomically. Caller provides role names; unknown names are skipped. */
export async function setUserRoles(
  db: D1Database,
  userId: number,
  roleNames: RoleName[],
  grantedByUserId: number | null
): Promise<void> {
  const unique = Array.from(new Set(roleNames));
  const roleRows = unique.length
    ? await db
        .prepare(`SELECT id, name FROM roles WHERE name IN (${unique.map(() => '?').join(',')})`)
        .bind(...unique)
        .all<{ id: number; name: RoleName }>()
    : { results: [] };

  const stmts = [db.prepare(`DELETE FROM user_roles WHERE user_id = ?`).bind(userId)];
  for (const r of roleRows.results ?? []) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO user_roles (user_id, role_id, granted_by_user_id) VALUES (?, ?, ?)`
        )
        .bind(userId, r.id, grantedByUserId)
    );
  }
  await db.batch(stmts);
}

export async function getUserRoles(db: D1Database, userId: number): Promise<RoleName[]> {
  const res = await db
    .prepare(
      `SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ?`
    )
    .bind(userId)
    .all<{ name: RoleName }>();
  return (res.results ?? []).map((r) => r.name);
}

/** Admin list view: every user with their role array. Sorted active-first, then by email. */
export async function listUsers(db: D1Database): Promise<UserWithRoles[]> {
  const users = await db
    .prepare(`SELECT * FROM users ORDER BY active DESC, email ASC`)
    .all<RawUserRow>();
  const rows = users.results ?? [];
  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id);
  const rolePairs = await db
    .prepare(
      `SELECT ur.user_id, r.name
       FROM user_roles ur JOIN roles r ON r.id = ur.role_id
       WHERE ur.user_id IN (${ids.map(() => '?').join(',')})`
    )
    .bind(...ids)
    .all<{ user_id: number; name: RoleName }>();

  const byUser = new Map<number, RoleName[]>();
  for (const p of rolePairs.results ?? []) {
    const list = byUser.get(p.user_id) ?? [];
    list.push(p.name);
    byUser.set(p.user_id, list);
  }

  return rows.map((r) => ({ ...hydrateUser(r), roles: byUser.get(r.id) ?? [] }));
}
