/**
 * In-app notifications.
 *
 * Currently emits two kinds:
 *   - 'mention.comment' — someone @-mentioned you in a comment body
 *   - 'card.assigned'   — someone added you as an assignee on a card
 *
 * The bell in the page header polls /api/notifications/unread-count and
 * fetches the dropdown list on click. There's no realtime push (yet) —
 * polling at a low cadence keeps the system simple. When S6's UX feels
 * laggy we can add a push channel via the existing Durable Object or a
 * dedicated per-user DO.
 */

export type NotificationKind =
  | 'mention.comment'
  | 'card.assigned';

export interface NotificationDto {
  id: number;
  userId: number;
  kind: NotificationKind | string;
  cardId: number | null;
  commentId: number | null;
  actorUserId: number | null;
  actorDisplayName: string | null;
  metadata: Record<string, unknown> | null;
  readAt: string | null;
  createdAt: string;
}

interface RawNotificationRow {
  id: number;
  user_id: number;
  kind: string;
  card_id: number | null;
  comment_id: number | null;
  actor_user_id: number | null;
  metadata: string | null;
  read_at: string | null;
  created_at: string;
}

function parseMetadata(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function hydrateNotification(
  row: RawNotificationRow & { actor_display_name?: string | null }
): NotificationDto {
  return {
    id: row.id,
    userId: row.user_id,
    kind: row.kind,
    cardId: row.card_id,
    commentId: row.comment_id,
    actorUserId: row.actor_user_id,
    actorDisplayName: row.actor_display_name ?? null,
    metadata: parseMetadata(row.metadata),
    readAt: row.read_at,
    createdAt: row.created_at,
  };
}

export interface CreateNotificationInput {
  userId: number;
  kind: NotificationKind;
  cardId?: number | null;
  commentId?: number | null;
  actorUserId?: number | null;
  metadata?: Record<string, unknown>;
}

/**
 * Insert a single notification. Caller is responsible for filtering out
 * self-targeted notifications (the actor shouldn't be notified about
 * their own action) — service-layer enforcement would be too restrictive
 * for hypothetical "remind me later" flows.
 */
export async function createNotification(
  db: D1Database,
  input: CreateNotificationInput
): Promise<NotificationDto> {
  const metaJson = input.metadata ? JSON.stringify(input.metadata) : null;
  const row = await db
    .prepare(
      `INSERT INTO notifications
         (user_id, kind, card_id, comment_id, actor_user_id, metadata)
       VALUES (?, ?, ?, ?, ?, ?)
       RETURNING *`
    )
    .bind(
      input.userId,
      input.kind,
      input.cardId ?? null,
      input.commentId ?? null,
      input.actorUserId ?? null,
      metaJson
    )
    .first<RawNotificationRow>();
  if (!row) throw new Error('Failed to insert notification');
  return hydrateNotification(row);
}

export async function listNotifications(
  db: D1Database,
  userId: number,
  opts: { limit?: number; unreadOnly?: boolean } = {}
): Promise<NotificationDto[]> {
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
  const sql = opts.unreadOnly
    ? `SELECT n.*, u.display_name as actor_display_name
       FROM notifications n
       LEFT JOIN users u ON u.id = n.actor_user_id
       WHERE n.user_id = ? AND n.read_at IS NULL
       ORDER BY n.id DESC LIMIT ?`
    : `SELECT n.*, u.display_name as actor_display_name
       FROM notifications n
       LEFT JOIN users u ON u.id = n.actor_user_id
       WHERE n.user_id = ?
       ORDER BY n.id DESC LIMIT ?`;
  const res = await db
    .prepare(sql)
    .bind(userId, limit)
    .all<RawNotificationRow & { actor_display_name: string | null }>();
  return (res.results ?? []).map(hydrateNotification);
}

export async function countUnreadNotifications(
  db: D1Database,
  userId: number
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) as c FROM notifications WHERE user_id = ? AND read_at IS NULL`
    )
    .bind(userId)
    .first<{ c: number }>();
  return row?.c ?? 0;
}

/**
 * Mark a list of notifications as read. Owner-scoped: only marks rows
 * belonging to the caller, so a forged id from another user is harmlessly
 * a no-op. Returns the number of rows actually updated.
 */
export async function markNotificationsRead(
  db: D1Database,
  userId: number,
  ids: number[]
): Promise<number> {
  if (ids.length === 0) return 0;
  const placeholders = ids.map(() => '?').join(',');
  const res = await db
    .prepare(
      `UPDATE notifications
       SET read_at = datetime('now')
       WHERE user_id = ? AND read_at IS NULL AND id IN (${placeholders})`
    )
    .bind(userId, ...ids)
    .run();
  return res.meta?.changes ?? 0;
}

export async function markAllNotificationsRead(
  db: D1Database,
  userId: number
): Promise<number> {
  const res = await db
    .prepare(
      `UPDATE notifications SET read_at = datetime('now')
       WHERE user_id = ? AND read_at IS NULL`
    )
    .bind(userId)
    .run();
  return res.meta?.changes ?? 0;
}

// ── Mention parsing ─────────────────────────────────────────────────────
//
// Mentions are written as @<token>, where <token> is matched against the
// recipient's email local part (case-insensitive). This is the simplest
// rule that survives renames (display names change; emails rarely do) and
// avoids ambiguity from multi-word display names.
//
// Examples:
//   "Hey @lion.templin take a look"  → user with email lion.templin@…
//   "cc @john.tarbox"                → user with email john.tarbox@…
//
// Tokens may contain letters, digits, dots, underscores, hyphens.

// `g` flag required by matchAll. Pattern requires the @ to be at start of
// string or preceded by a non-token character so we don't false-match
// inside email addresses (foo@bar should not match "@bar").
const MENTION_RE = /(?:^|[^a-zA-Z0-9._-])@([a-zA-Z0-9._-]+)/g;

/**
 * Find @-mention tokens in `body` and resolve them to user ids using a
 * provided directory. Returns deduplicated user ids in order of first
 * occurrence.
 */
export function parseMentions(
  body: string,
  directory: Array<{ userId: number; email: string }>
): number[] {
  const seen = new Set<number>();
  const ordered: number[] = [];
  // Index directory by lowercased email local part for O(1) lookup.
  const byLocal = new Map<string, number>();
  for (const u of directory) {
    const at = u.email.indexOf('@');
    const local = at >= 0 ? u.email.slice(0, at).toLowerCase() : u.email.toLowerCase();
    // Prefer the first user for any given local part — duplicates would
    // mean a directory ambiguity that's the admin's problem to resolve.
    if (!byLocal.has(local)) byLocal.set(local, u.userId);
  }
  for (const match of body.matchAll(MENTION_RE)) {
    const token = (match[1] ?? '').toLowerCase();
    const uid = byLocal.get(token);
    if (uid !== undefined && !seen.has(uid)) {
      seen.add(uid);
      ordered.push(uid);
    }
  }
  return ordered;
}
