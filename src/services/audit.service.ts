/**
 * Append-only audit log in D1. Used for sign-ins (both paths), denied
 * Google attempts, invites, role changes, deactivations, and logouts.
 *
 * `user_id` is nullable because denied Google sign-ins have no matching
 * user — we still want the row with the attempted email in metadata.
 */

export type AuditAction =
  | 'login.okta'
  | 'login.okta.denied'
  | 'login.okta.failed'
  | 'login.google'
  | 'login.google.denied'
  | 'login.google.failed'
  | 'logout'
  | 'user.invited'
  | 'user.deactivated'
  | 'user.reactivated'
  | 'user.roles_changed';

export interface WriteAuditInput {
  userId?: number | null;
  action: AuditAction;
  metadata?: Record<string, unknown>;
  ip?: string | null;
}

export async function writeAudit(db: D1Database, input: WriteAuditInput): Promise<void> {
  await db
    .prepare(
      `INSERT INTO audit_log (user_id, action, metadata, ip) VALUES (?, ?, ?, ?)`
    )
    .bind(
      input.userId ?? null,
      input.action,
      input.metadata ? JSON.stringify(input.metadata) : null,
      input.ip ?? null
    )
    .run();
}
