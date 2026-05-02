/**
 * Kanban persistence. Multiple boards; each card belongs to exactly one
 * board via board_id. Columns are a fixed enum, and card order within a
 * (board, column) pair is a dense integer `position`.
 *
 * Concurrency model: every card carries a `version` column. Updates/moves/
 * deletes are gated on the caller's expected version, so conflicting writes
 * from two editors return a signalled failure (null / false) that the caller
 * turns into a WebSocket `nack { reason: 'version_conflict' }`.
 *
 * Atomicity: move/delete reshape positions across multiple rows. Those are
 * issued as a single `db.batch([...])` so partial application is impossible.
 * Cross-request races are prevented by the KanbanBoardDO isolate, which
 * serializes every webSocketMessage call — and there is one DO instance
 * per board, so serialization is also per-board.
 */
/**
 * Default column set seeded onto every new board (S12 made columns
 * per-board configurable, but these six remain the canonical defaults
 * so pre-S12 boards keep their familiar layout). Pages that need a
 * human-friendly label for a known key use legacyColumnLabel below;
 * everything else falls back to the raw key.
 */
export const KANBAN_COLUMNS = [
  'not_started',
  'started',
  'blocked',
  'ready',
  'approval',
  'done',
] as const;

const LEGACY_COLUMN_LABELS: Record<string, string> = {
  not_started: 'Not Started',
  started: 'Started',
  blocked: 'Blocked',
  ready: 'Ready',
  approval: 'Approval',
  done: 'Done',
};

/** Best-effort label for a column key — known defaults map to titles,
 *  custom keys fall back to a humanized form of the key itself. */
export function legacyColumnLabel(key: string): string {
  return LEGACY_COLUMN_LABELS[key] ?? key
    .split(/[_-]/)
    .map((p) => (p ? p[0].toUpperCase() + p.slice(1) : p))
    .join(' ');
}

// Post-S12 ColumnName is just a string — validation happens against
// kanban_board_columns at service-mutation time, not at the type level.
export type ColumnName = string;

export function isColumnName(v: unknown): v is ColumnName {
  return typeof v === 'string' && v.length > 0 && v.length <= 64;
}

/** Caller-provided column key sanity check. Lower-cased, slug-safe.
 *  Empty / overlong / shape-bad → null. */
export function normalizeColumnKey(input: string): string | null {
  const s = input
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return s.length > 0 && s.length <= 64 ? s : null;
}

// ── Board DTO + CRUD ────────────────────────────────────────────────────

export interface BoardDto {
  id: number;
  name: string;
  slug: string;
  createdByUserId: number | null;
  createdAt: string;
  updatedAt: string;
}

interface RawBoardRow {
  id: number;
  name: string;
  slug: string;
  created_by_user_id: number | null;
  created_at: string;
  updated_at: string;
}

function hydrateBoard(row: RawBoardRow): BoardDto {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listBoards(db: D1Database): Promise<BoardDto[]> {
  const res = await db
    .prepare(`SELECT * FROM kanban_boards ORDER BY id ASC`)
    .all<RawBoardRow>();
  return (res.results ?? []).map(hydrateBoard);
}

export async function getBoardById(
  db: D1Database,
  id: number
): Promise<BoardDto | null> {
  const row = await db
    .prepare(`SELECT * FROM kanban_boards WHERE id = ?`)
    .bind(id)
    .first<RawBoardRow>();
  return row ? hydrateBoard(row) : null;
}

export async function getBoardBySlug(
  db: D1Database,
  slug: string
): Promise<BoardDto | null> {
  const row = await db
    .prepare(`SELECT * FROM kanban_boards WHERE slug = ? COLLATE NOCASE`)
    .bind(slug)
    .first<RawBoardRow>();
  return row ? hydrateBoard(row) : null;
}

/** Produce a URL-safe slug from a name. Returns null for empty/ungenerable. */
export function slugify(input: string): string | null {
  const s = input
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s.length > 0 ? s.slice(0, 60) : null;
}

export interface CreateBoardInput {
  name: string;
  slug?: string;
}

export async function createBoard(
  db: D1Database,
  input: CreateBoardInput,
  userId: number | null
): Promise<BoardDto> {
  const name = input.name.trim();
  if (!name) throw new Error('Board name is required');
  const slug = (input.slug ? slugify(input.slug) : null) ?? slugify(name);
  if (!slug) throw new Error('Could not derive a valid slug from the name');

  const row = await db
    .prepare(
      `INSERT INTO kanban_boards (name, slug, created_by_user_id)
       VALUES (?, ?, ?)
       RETURNING *`
    )
    .bind(name, slug, userId)
    .first<RawBoardRow>();
  if (!row) throw new Error('Failed to insert board');

  // Seed the canonical 6-column config so the UI has WIP-limit slots to
  // render against. The column list mirrors KANBAN_COLUMNS above.
  await db.batch(
    [
      ['not_started', 'Not Started', 0],
      ['started', 'Started', 1],
      ['blocked', 'Blocked', 2],
      ['ready', 'Ready', 3],
      ['approval', 'Approval', 4],
      ['done', 'Done', 5],
    ].map(([name, label, pos]) =>
      db
        .prepare(
          `INSERT OR IGNORE INTO kanban_board_columns
             (board_id, column_name, label, position) VALUES (?, ?, ?, ?)`
        )
        .bind(row.id, name, label, pos)
    )
  );

  return hydrateBoard(row);
}

export async function renameBoard(
  db: D1Database,
  id: number,
  newName: string
): Promise<BoardDto | null> {
  const name = newName.trim();
  if (!name) throw new Error('Board name is required');
  const row = await db
    .prepare(
      `UPDATE kanban_boards SET name = ?, updated_at = datetime('now')
       WHERE id = ? RETURNING *`
    )
    .bind(name, id)
    .first<RawBoardRow>();
  return row ? hydrateBoard(row) : null;
}

export async function deleteBoard(db: D1Database, id: number): Promise<boolean> {
  const res = await db
    .prepare(`DELETE FROM kanban_boards WHERE id = ?`)
    .bind(id)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

// ── Card DTO ────────────────────────────────────────────────────────────

/** Lightweight assignee — display info only, no role/email-domain detail. */
export interface AssigneeDto {
  userId: number;
  displayName: string | null;
  email: string;
}

/** Card group/label with optional per-board color. Color is null until
 *  someone (staff) explicitly sets one via setGroupColor; the UI then
 *  tints chips with `tintFromHex`. */
export interface GroupDto {
  name: string;
  color: string | null;
}

export interface CardDto {
  id: number;
  boardId: number;
  column: ColumnName;
  position: number;
  title: string;
  /** Zero or more group labels with optional per-board colors. Always
   *  an array; empty when unset. (Pre-color schema returned `string[]`;
   *  we kept the order semantics and just added the color field.) */
  groups: GroupDto[];
  /** Multi-assignee FK list (S5). Empty when nobody is assigned. */
  assignees: AssigneeDto[];
  /** Legacy free-text assigned field (pre-S5). Retained alongside assignees. */
  assigned: string | null;
  notes: string | null;
  /** YYYY-MM-DD or null. Paired with dueDate to enable Timeline view. */
  startDate: string | null;
  dueDate: string | null;
  /** HH:MM (24h) or null. When set, due_date carries an explicit time. */
  dueTime: string | null;
  /** Optional per-card cover color (#aabbcc). Null = no cover. */
  coverColor: string | null;
  /** ISO timestamp when the card was archived (soft-deleted); null when active. */
  archivedAt: string | null;
  version: number;
  createdByUserId: number | null;
  updatedByUserId: number | null;
  createdAt: string;
  updatedAt: string;
  /** True when there is at least one comment from another user that the
   *  caller (the userId passed to listCards) hasn't yet viewed. Omitted
   *  when listCards was called without a userId. */
  hasUnreadComments?: boolean;
}

interface RawCardRow {
  id: number;
  board_id: number;
  column_name: ColumnName;
  position: number;
  title: string;
  assigned: string | null;
  notes: string | null;
  start_date: string | null;
  due_date: string | null;
  due_time: string | null;
  cover_color: string | null;
  archived_at: string | null;
  version: number;
  created_by_user_id: number | null;
  updated_by_user_id: number | null;
  created_at: string;
  updated_at: string;
}

function hydrateCard(
  row: RawCardRow,
  groups: GroupDto[],
  assignees: AssigneeDto[],
  hasUnreadComments?: boolean
): CardDto {
  const out: CardDto = {
    id: row.id,
    boardId: row.board_id,
    column: row.column_name,
    position: row.position,
    title: row.title,
    groups,
    assignees,
    assigned: row.assigned,
    notes: row.notes,
    startDate: row.start_date,
    dueDate: row.due_date,
    dueTime: row.due_time,
    coverColor: row.cover_color,
    archivedAt: row.archived_at,
    version: row.version,
    createdByUserId: row.created_by_user_id,
    updatedByUserId: row.updated_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (hasUnreadComments !== undefined) out.hasUnreadComments = hasUnreadComments;
  return out;
}

/** Fetch groups (with per-board colors) for a set of card ids in one
 *  query. Joins kanban_groups via the card's board_id so colors set on
 *  one board don't bleed into another's same-named group. */
async function loadGroupsForCards(
  db: D1Database,
  cardIds: number[]
): Promise<Map<number, GroupDto[]>> {
  const map = new Map<number, GroupDto[]>();
  if (cardIds.length === 0) return map;
  const placeholders = cardIds.map(() => '?').join(',');
  const res = await db
    .prepare(
      `SELECT cg.card_id, cg.group_name, kg.color
       FROM kanban_card_groups cg
       JOIN kanban_cards c ON c.id = cg.card_id
       LEFT JOIN kanban_groups kg
         ON kg.board_id = c.board_id AND kg.name = cg.group_name
       WHERE cg.card_id IN (${placeholders})
       ORDER BY cg.card_id ASC, cg.group_name ASC`
    )
    .bind(...cardIds)
    .all<{ card_id: number; group_name: string; color: string | null }>();
  for (const row of res.results ?? []) {
    const dto: GroupDto = { name: row.group_name, color: row.color };
    const list = map.get(row.card_id);
    if (list) list.push(dto);
    else map.set(row.card_id, [dto]);
  }
  return map;
}

async function loadGroupsForCard(db: D1Database, cardId: number): Promise<GroupDto[]> {
  const map = await loadGroupsForCards(db, [cardId]);
  return map.get(cardId) ?? [];
}

/** Bulk-fetch assignees for a set of cards. Returns map cardId -> AssigneeDto[]. */
async function loadAssigneesForCards(
  db: D1Database,
  cardIds: number[]
): Promise<Map<number, AssigneeDto[]>> {
  const map = new Map<number, AssigneeDto[]>();
  if (cardIds.length === 0) return map;
  const placeholders = cardIds.map(() => '?').join(',');
  const res = await db
    .prepare(
      `SELECT a.card_id, a.user_id, u.display_name, u.email
       FROM kanban_card_assignees a
       JOIN users u ON u.id = a.user_id
       WHERE a.card_id IN (${placeholders})
       ORDER BY a.card_id ASC, u.display_name ASC, u.email ASC`
    )
    .bind(...cardIds)
    .all<{ card_id: number; user_id: number; display_name: string | null; email: string }>();
  for (const row of res.results ?? []) {
    const dto: AssigneeDto = {
      userId: row.user_id,
      displayName: row.display_name,
      email: row.email,
    };
    const list = map.get(row.card_id);
    if (list) list.push(dto);
    else map.set(row.card_id, [dto]);
  }
  return map;
}

async function loadAssigneesForCard(
  db: D1Database,
  cardId: number
): Promise<AssigneeDto[]> {
  const map = await loadAssigneesForCards(db, [cardId]);
  return map.get(cardId) ?? [];
}

/**
 * Replace a card's assignee set atomically. Filters userIds to active users
 * only — silently drops invalid/inactive ids rather than failing the whole
 * operation, matching how `setUserRoles` handles unknown role names.
 */
async function setCardAssignees(
  db: D1Database,
  cardId: number,
  userIds: number[]
): Promise<void> {
  const unique = Array.from(new Set(userIds.filter((n) => Number.isFinite(n) && n > 0)));
  // Validate ids against active users in one round-trip.
  let validIds: number[] = [];
  if (unique.length > 0) {
    const res = await db
      .prepare(
        `SELECT id FROM users WHERE active = 1 AND id IN (${unique.map(() => '?').join(',')})`
      )
      .bind(...unique)
      .all<{ id: number }>();
    validIds = (res.results ?? []).map((r) => r.id);
  }
  const stmts = [
    db.prepare(`DELETE FROM kanban_card_assignees WHERE card_id = ?`).bind(cardId),
    ...validIds.map((uid) =>
      db
        .prepare(
          `INSERT OR IGNORE INTO kanban_card_assignees (card_id, user_id) VALUES (?, ?)`
        )
        .bind(cardId, uid)
    ),
  ];
  await db.batch(stmts);
}

/**
 * Active-user directory for the assignee picker. Lightweight projection —
 * the picker only needs id, display name, and email. Sorted display-name
 * first so the dropdown reads naturally.
 */
// ── Board column config (S9 — WIP limits; S12 will extend) ─────────────

export interface BoardColumnConfigDto {
  columnName: ColumnName;
  label: string;
  position: number;
  /** Null = no limit. UI shows "(N/limit)" badge when set, red when N > limit. */
  wipLimit: number | null;
  /** Optional explicit color override. Null = use legacy default for the
   *  six canonical keys, fallback gray for custom keys. */
  color: string | null;
}

/**
 * Quick lookup: does (boardId, columnName) exist in kanban_board_columns?
 * Used by createCard / moveCard to validate the destination column.
 */
async function columnExists(
  db: D1Database,
  boardId: number,
  columnName: string
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 as ok FROM kanban_board_columns
       WHERE board_id = ? AND column_name = ? LIMIT 1`
    )
    .bind(boardId, columnName)
    .first<{ ok: number }>();
  return !!row;
}

export async function listBoardColumns(
  db: D1Database,
  boardId: number
): Promise<BoardColumnConfigDto[]> {
  const res = await db
    .prepare(
      `SELECT column_name, label, position, wip_limit, color
       FROM kanban_board_columns
       WHERE board_id = ?
       ORDER BY position ASC`
    )
    .bind(boardId)
    .all<{ column_name: ColumnName; label: string; position: number; wip_limit: number | null; color: string | null }>();
  return (res.results ?? []).map((r) => ({
    columnName: r.column_name,
    label: r.label,
    position: r.position,
    wipLimit: r.wip_limit,
    color: r.color,
  }));
}

/**
 * Set (or clear) a column's WIP limit. Idempotent. Returns the updated
 * config row, or null if the (board, column) pair doesn't exist (likely
 * a board that pre-dates the seed and is missing rows).
 */
export async function setColumnWipLimit(
  db: D1Database,
  boardId: number,
  columnName: ColumnName,
  wipLimit: number | null
): Promise<BoardColumnConfigDto | null> {
  const limit = wipLimit !== null && wipLimit > 0 ? Math.floor(wipLimit) : null;
  const row = await db
    .prepare(
      `UPDATE kanban_board_columns
       SET wip_limit = ?
       WHERE board_id = ? AND column_name = ?
       RETURNING column_name, label, position, wip_limit, color`
    )
    .bind(limit, boardId, columnName)
    .first<{ column_name: ColumnName; label: string; position: number; wip_limit: number | null; color: string | null }>();
  if (!row) return null;
  return {
    columnName: row.column_name,
    label: row.label,
    position: row.position,
    wipLimit: row.wip_limit,
    color: row.color,
  };
}

/** Set (or clear with null) a column's color. Caller must pre-validate
 *  the hex via normalizeHexColor; we just write it through. */
export async function setColumnColor(
  db: D1Database,
  boardId: number,
  columnName: ColumnName,
  color: string | null
): Promise<BoardColumnConfigDto | null> {
  const row = await db
    .prepare(
      `UPDATE kanban_board_columns SET color = ?
       WHERE board_id = ? AND column_name = ?
       RETURNING column_name, label, position, wip_limit, color`
    )
    .bind(color, boardId, columnName)
    .first<{ column_name: ColumnName; label: string; position: number; wip_limit: number | null; color: string | null }>();
  if (!row) return null;
  return {
    columnName: row.column_name,
    label: row.label,
    position: row.position,
    wipLimit: row.wip_limit,
    color: row.color,
  };
}

// ── Group color metadata (per board) ────────────────────────────────────

export async function listGroupsForBoard(
  db: D1Database,
  boardId: number
): Promise<GroupDto[]> {
  const res = await db
    .prepare(
      `SELECT name, color FROM kanban_groups
       WHERE board_id = ?
       ORDER BY name ASC`
    )
    .bind(boardId)
    .all<{ name: string; color: string | null }>();
  return (res.results ?? []).map((r) => ({ name: r.name, color: r.color }));
}

/** Upsert: if the group doesn't exist for this board (rare — usually
 *  it's created when a card uses it for the first time), create it.
 *  Then set color (null clears). Returns the resulting row. */
export async function setGroupColor(
  db: D1Database,
  boardId: number,
  name: string,
  color: string | null
): Promise<GroupDto | null> {
  const trimmed = name.trim();
  if (!trimmed) return null;
  await db
    .prepare(`INSERT OR IGNORE INTO kanban_groups (board_id, name) VALUES (?, ?)`)
    .bind(boardId, trimmed)
    .run();
  const row = await db
    .prepare(
      `UPDATE kanban_groups SET color = ?
       WHERE board_id = ? AND name = ?
       RETURNING name, color`
    )
    .bind(color, boardId, trimmed)
    .first<{ name: string; color: string | null }>();
  return row ? { name: row.name, color: row.color } : null;
}

/**
 * Create a label on a board, idempotently. Case-insensitive collision: if
 * a label with the same name (any casing) already exists for this board,
 * return that existing row instead of creating a duplicate. The unique
 * NOCASE index from migration 0019 enforces this at the DB level too.
 */
export async function createGroup(
  db: D1Database,
  boardId: number,
  name: string,
  color: string | null = null
): Promise<GroupDto | null> {
  const trimmed = name.trim().slice(0, 64);
  if (!trimmed) return null;
  const existing = await db
    .prepare(
      `SELECT name, color FROM kanban_groups
       WHERE board_id = ? AND name = ? COLLATE NOCASE
       LIMIT 1`
    )
    .bind(boardId, trimmed)
    .first<{ name: string; color: string | null }>();
  if (existing) return { name: existing.name, color: existing.color };
  await db
    .prepare(`INSERT INTO kanban_groups (board_id, name, color) VALUES (?, ?, ?)`)
    .bind(boardId, trimmed, color)
    .run();
  return { name: trimmed, color };
}

/**
 * Rename a label everywhere it appears on this board. Atomic: a single
 * D1 batch updates the junction (only for cards on this board, since
 * kanban_card_groups has no board_id column), inserts the new
 * kanban_groups definition row carrying the old color forward, and
 * removes the old definition row.
 *
 * Returns null on validation failure (empty / no-op rename / missing
 * source / NOCASE collision with a *different* existing label on this
 * board). Returns { old, group } on success.
 */
export async function renameGroup(
  db: D1Database,
  boardId: number,
  oldName: string,
  newName: string
): Promise<{ old: string; group: GroupDto; affectedCardIds: number[] } | null> {
  const oldTrimmed = oldName.trim();
  const newTrimmed = newName.trim().slice(0, 64);
  if (!oldTrimmed || !newTrimmed) return null;
  if (oldTrimmed === newTrimmed) return null;
  const src = await db
    .prepare(
      `SELECT name, color FROM kanban_groups WHERE board_id = ? AND name = ? LIMIT 1`
    )
    .bind(boardId, oldTrimmed)
    .first<{ name: string; color: string | null }>();
  if (!src) return null;
  // Block rename if the new name collides with a *different* existing
  // label on this board (case-insensitive). Renaming "Urgent" → "urgent"
  // (same row, different case) is allowed because src.name === oldTrimmed
  // and a NOCASE match on the same row is fine.
  const collision = await db
    .prepare(
      `SELECT name FROM kanban_groups
       WHERE board_id = ? AND name = ? COLLATE NOCASE AND name <> ?
       LIMIT 1`
    )
    .bind(boardId, newTrimmed, oldTrimmed)
    .first<{ name: string }>();
  if (collision) return null;
  // Capture the card IDs the rename will touch so the DO can fan out
  // per-card audit events. Runs before the batch — the batch's UPDATE
  // would otherwise have already changed group_name when we read it.
  const affected = await db
    .prepare(
      `SELECT card_id FROM kanban_card_groups
       WHERE group_name = ?
         AND card_id IN (SELECT id FROM kanban_cards WHERE board_id = ?)`
    )
    .bind(oldTrimmed, boardId)
    .all<{ card_id: number }>();
  const affectedCardIds = (affected.results ?? []).map((r) => r.card_id);
  await db.batch([
    db
      .prepare(
        `UPDATE kanban_card_groups SET group_name = ?
         WHERE group_name = ?
           AND card_id IN (SELECT id FROM kanban_cards WHERE board_id = ?)`
      )
      .bind(newTrimmed, oldTrimmed, boardId),
    db
      .prepare(
        `INSERT OR IGNORE INTO kanban_groups (board_id, name, color)
         VALUES (?, ?, ?)`
      )
      .bind(boardId, newTrimmed, src.color),
    db
      .prepare(`DELETE FROM kanban_groups WHERE board_id = ? AND name = ?`)
      .bind(boardId, oldTrimmed),
  ]);
  return { old: oldTrimmed, group: { name: newTrimmed, color: src.color }, affectedCardIds };
}

/**
 * Delete a label from a board: detaches it from every card on this board
 * (junction rows scoped via the board's cards) and removes its definition
 * row. Returns true on success, false if the label didn't exist on this
 * board.
 */
export async function deleteGroup(
  db: D1Database,
  boardId: number,
  name: string
): Promise<{ ok: boolean; affectedCardIds: number[] }> {
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, affectedCardIds: [] };
  const exists = await db
    .prepare(`SELECT 1 as ok FROM kanban_groups WHERE board_id = ? AND name = ? LIMIT 1`)
    .bind(boardId, trimmed)
    .first<{ ok: number }>();
  if (!exists) return { ok: false, affectedCardIds: [] };
  // Capture card IDs before the DELETE so the DO can emit per-card
  // audit events for each card that just lost the label.
  const affected = await db
    .prepare(
      `SELECT card_id FROM kanban_card_groups
       WHERE group_name = ?
         AND card_id IN (SELECT id FROM kanban_cards WHERE board_id = ?)`
    )
    .bind(trimmed, boardId)
    .all<{ card_id: number }>();
  const affectedCardIds = (affected.results ?? []).map((r) => r.card_id);
  await db.batch([
    db
      .prepare(
        `DELETE FROM kanban_card_groups
         WHERE group_name = ?
           AND card_id IN (SELECT id FROM kanban_cards WHERE board_id = ?)`
      )
      .bind(trimmed, boardId),
    db
      .prepare(`DELETE FROM kanban_groups WHERE board_id = ? AND name = ?`)
      .bind(boardId, trimmed),
  ]);
  return { ok: true, affectedCardIds };
}

/**
 * How many cards on this board reference each named label. Used by the
 * label-manager UI to warn on delete ("This will remove the label from N
 * cards"). Skips the bulk-load path because the manager hits this only
 * when its modal is opened.
 */
export async function countCardsPerGroup(
  db: D1Database,
  boardId: number
): Promise<Record<string, number>> {
  const res = await db
    .prepare(
      `SELECT g.group_name AS name, COUNT(*) AS cnt
       FROM kanban_card_groups g
       JOIN kanban_cards c ON c.id = g.card_id
       WHERE c.board_id = ? AND c.archived_at IS NULL
       GROUP BY g.group_name`
    )
    .bind(boardId)
    .all<{ name: string; cnt: number }>();
  const out: Record<string, number> = {};
  for (const r of res.results ?? []) out[r.name] = r.cnt;
  return out;
}

// ── Table view (S15) — flat queryable list of active cards ──────────────

export interface TableCardRow {
  id: number;
  boardId: number;
  boardSlug: string;
  boardName: string;
  column: ColumnName;
  columnLabel: string;
  position: number;
  title: string;
  assignees: AssigneeDto[];
  groups: GroupDto[];
  assigned: string | null;
  startDate: string | null;
  dueDate: string | null;
  dueTime: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TableQueryOpts {
  boardId?: number;
  assigneeUserId?: number;
  column?: string;
}

/**
 * Active (non-archived) cards across every board, with denormalized
 * board name / column label for table display. Filters applied via
 * optional `opts`. Returns full assignee + group lists per row using
 * the same bulk-fetch pattern as listCards. Sorted by board then column
 * position then card position.
 */
export async function listAllActiveCardsForTable(
  db: D1Database,
  opts: TableQueryOpts = {}
): Promise<TableCardRow[]> {
  const where: string[] = ['c.archived_at IS NULL'];
  const binds: Array<string | number> = [];
  if (opts.boardId !== undefined) {
    where.push('c.board_id = ?');
    binds.push(opts.boardId);
  }
  if (opts.column) {
    where.push('c.column_name = ?');
    binds.push(opts.column);
  }
  if (opts.assigneeUserId !== undefined) {
    where.push('EXISTS (SELECT 1 FROM kanban_card_assignees a WHERE a.card_id = c.id AND a.user_id = ?)');
    binds.push(opts.assigneeUserId);
  }
  const sql =
    `SELECT c.id, c.board_id, c.column_name, c.position, c.title,
            c.assigned, c.start_date, c.due_date, c.due_time,
            c.created_at, c.updated_at,
            b.slug as board_slug, b.name as board_name,
            bc.label as column_label
     FROM kanban_cards c
     JOIN kanban_boards b ON b.id = c.board_id
     LEFT JOIN kanban_board_columns bc
       ON bc.board_id = c.board_id AND bc.column_name = c.column_name
     WHERE ${where.join(' AND ')}
     ORDER BY b.name ASC, COALESCE(bc.position, 99) ASC, c.position ASC, c.id ASC`;
  const res = await db
    .prepare(sql)
    .bind(...binds)
    .all<{
      id: number;
      board_id: number;
      column_name: ColumnName;
      position: number;
      title: string;
      assigned: string | null;
      start_date: string | null;
      due_date: string | null;
      due_time: string | null;
      created_at: string;
      updated_at: string;
      board_slug: string;
      board_name: string;
      column_label: string | null;
    }>();
  const rows = res.results ?? [];
  const ids = rows.map((r) => r.id);
  const [groups, assignees] = await Promise.all([
    loadGroupsForCards(db, ids),
    loadAssigneesForCards(db, ids),
  ]);
  return rows.map((r) => ({
    id: r.id,
    boardId: r.board_id,
    boardSlug: r.board_slug,
    boardName: r.board_name,
    column: r.column_name,
    columnLabel: r.column_label ?? legacyColumnLabel(r.column_name),
    position: r.position,
    title: r.title,
    assignees: assignees.get(r.id) ?? [],
    groups: groups.get(r.id) ?? [],
    assigned: r.assigned,
    startDate: r.start_date,
    dueDate: r.due_date,
    dueTime: r.due_time,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

// ── Timeline view (S17) — cards with date ranges ────────────────────────

export interface TimelineCardRow {
  id: number;
  boardId: number;
  boardSlug: string;
  boardName: string;
  column: ColumnName;
  columnLabel: string;
  title: string;
  /** ISO YYYY-MM-DD; either startDate or dueDate is guaranteed present. */
  startDate: string | null;
  dueDate: string | null;
}

/**
 * Active cards that have at least one date (start_date or due_date)
 * intersecting [fromIso, toIso]. Returns rows ready for SVG bar layout.
 * The intersection check ensures the timeline doesn't show a year-long
 * card as a single point at the window's edge.
 */
export async function listCardsForTimeline(
  db: D1Database,
  fromIso: string,
  toIso: string
): Promise<TimelineCardRow[]> {
  // A card intersects [from, to] iff:
  //   max(start, due, due) <= to AND min(start, due, due) >= from
  // We coalesce start_date with due_date and vice versa so single-date
  // cards still produce a 1-day bar.
  const res = await db
    .prepare(
      `SELECT c.id, c.board_id, c.column_name, c.title,
              c.start_date, c.due_date,
              b.slug as board_slug, b.name as board_name,
              bc.label as column_label
       FROM kanban_cards c
       JOIN kanban_boards b ON b.id = c.board_id
       LEFT JOIN kanban_board_columns bc
         ON bc.board_id = c.board_id AND bc.column_name = c.column_name
       WHERE c.archived_at IS NULL
         AND (c.start_date IS NOT NULL OR c.due_date IS NOT NULL)
         AND COALESCE(c.start_date, c.due_date) <= ?
         AND COALESCE(c.due_date, c.start_date) >= ?
       ORDER BY COALESCE(c.start_date, c.due_date) ASC, c.id ASC`
    )
    .bind(toIso, fromIso)
    .all<{
      id: number;
      board_id: number;
      column_name: ColumnName;
      title: string;
      start_date: string | null;
      due_date: string | null;
      board_slug: string;
      board_name: string;
      column_label: string | null;
    }>();
  return (res.results ?? []).map((r) => ({
    id: r.id,
    boardId: r.board_id,
    boardSlug: r.board_slug,
    boardName: r.board_name,
    column: r.column_name,
    columnLabel: r.column_label ?? legacyColumnLabel(r.column_name),
    title: r.title,
    startDate: r.start_date,
    dueDate: r.due_date,
  }));
}

// ── Calendar view (cross-board, by due date) ────────────────────────────

export interface CalendarCardSummary {
  id: number;
  boardId: number;
  boardSlug: string;
  boardName: string;
  column: ColumnName;
  title: string;
  startDate: string | null;
  dueDate: string;        // never null in this projection — we filter on it
  dueTime: string | null;
}

/**
 * Active cards across every board with a due_date within [fromIso, toIso]
 * inclusive (YYYY-MM-DD). Sorted by due_date then time. Used by /calendar.
 */
export async function listCardsWithDueDateInRange(
  db: D1Database,
  fromIso: string,
  toIso: string
): Promise<CalendarCardSummary[]> {
  const res = await db
    .prepare(
      `SELECT c.id, c.board_id, c.column_name, c.title,
              c.start_date, c.due_date, c.due_time,
              b.slug as board_slug, b.name as board_name
       FROM kanban_cards c
       JOIN kanban_boards b ON b.id = c.board_id
       WHERE c.archived_at IS NULL
         AND c.due_date IS NOT NULL
         AND c.due_date >= ? AND c.due_date <= ?
       ORDER BY c.due_date ASC, c.due_time ASC, b.name ASC, c.id ASC`
    )
    .bind(fromIso, toIso)
    .all<{
      id: number;
      board_id: number;
      column_name: ColumnName;
      title: string;
      start_date: string | null;
      due_date: string;
      due_time: string | null;
      board_slug: string;
      board_name: string;
    }>();
  return (res.results ?? []).map((r) => ({
    id: r.id,
    boardId: r.board_id,
    boardSlug: r.board_slug,
    boardName: r.board_name,
    column: r.column_name,
    title: r.title,
    startDate: r.start_date,
    dueDate: r.due_date,
    dueTime: r.due_time,
  }));
}

// ── Attachments (S11 — metadata; bytes live in R2) ──────────────────────

export interface AttachmentDto {
  id: number;
  cardId: number;
  r2Key: string;
  originalName: string;
  contentType: string;
  sizeBytes: number;
  uploadedByUserId: number | null;
  createdAt: string;
}

interface RawAttachmentRow {
  id: number;
  card_id: number;
  r2_key: string;
  original_name: string;
  content_type: string;
  size_bytes: number;
  uploaded_by_user_id: number | null;
  created_at: string;
}

function hydrateAttachment(row: RawAttachmentRow): AttachmentDto {
  return {
    id: row.id,
    cardId: row.card_id,
    r2Key: row.r2_key,
    originalName: row.original_name,
    contentType: row.content_type,
    sizeBytes: row.size_bytes,
    uploadedByUserId: row.uploaded_by_user_id,
    createdAt: row.created_at,
  };
}

export async function listAttachments(
  db: D1Database,
  cardId: number
): Promise<AttachmentDto[]> {
  const res = await db
    .prepare(
      `SELECT * FROM kanban_card_attachments
       WHERE card_id = ?
       ORDER BY id ASC`
    )
    .bind(cardId)
    .all<RawAttachmentRow>();
  return (res.results ?? []).map(hydrateAttachment);
}

export async function getAttachment(
  db: D1Database,
  id: number
): Promise<AttachmentDto | null> {
  const row = await db
    .prepare(`SELECT * FROM kanban_card_attachments WHERE id = ?`)
    .bind(id)
    .first<RawAttachmentRow>();
  return row ? hydrateAttachment(row) : null;
}

export async function insertAttachment(
  db: D1Database,
  input: {
    cardId: number;
    r2Key: string;
    originalName: string;
    contentType: string;
    sizeBytes: number;
    uploadedByUserId: number | null;
  }
): Promise<AttachmentDto> {
  const row = await db
    .prepare(
      `INSERT INTO kanban_card_attachments
         (card_id, r2_key, original_name, content_type, size_bytes, uploaded_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?)
       RETURNING *`
    )
    .bind(
      input.cardId,
      input.r2Key,
      input.originalName,
      input.contentType,
      input.sizeBytes,
      input.uploadedByUserId
    )
    .first<RawAttachmentRow>();
  if (!row) throw new Error('Failed to insert attachment');
  return hydrateAttachment(row);
}

/**
 * Delete an attachment row. Returns the row metadata (so the caller can
 * purge R2 with the right key) or null if no row matched. Authorization
 * is enforced upstream — this is just the SQL. Owner-only delete is the
 * caller's choice.
 */
export async function deleteAttachmentRow(
  db: D1Database,
  id: number,
  userId: number | null,
  isAdmin: boolean
): Promise<AttachmentDto | null> {
  if (userId === null && !isAdmin) return null;
  const row = isAdmin
    ? await db
        .prepare(
          `DELETE FROM kanban_card_attachments WHERE id = ? RETURNING *`
        )
        .bind(id)
        .first<RawAttachmentRow>()
    : await db
        .prepare(
          `DELETE FROM kanban_card_attachments
           WHERE id = ? AND uploaded_by_user_id = ?
           RETURNING *`
        )
        .bind(id, userId)
        .first<RawAttachmentRow>();
  return row ? hydrateAttachment(row) : null;
}

// ── Dashboard aggregates (S16) ──────────────────────────────────────────

export interface BoardCardCount {
  boardId: number;
  boardName: string;
  boardSlug: string;
  count: number;
}

/** Active (non-archived) card counts per board, sorted by count desc. */
export async function getCardCountsByBoard(
  db: D1Database
): Promise<BoardCardCount[]> {
  const res = await db
    .prepare(
      `SELECT b.id, b.name, b.slug, COUNT(c.id) as cnt
       FROM kanban_boards b
       LEFT JOIN kanban_cards c ON c.board_id = b.id AND c.archived_at IS NULL
       GROUP BY b.id
       ORDER BY cnt DESC, b.name ASC`
    )
    .all<{ id: number; name: string; slug: string; cnt: number }>();
  return (res.results ?? []).map((r) => ({
    boardId: r.id,
    boardName: r.name,
    boardSlug: r.slug,
    count: r.cnt,
  }));
}

export interface AssigneeCardCount {
  userId: number;
  displayName: string | null;
  email: string;
  count: number;
}

/** Top assignees by active card count. Limited to N to keep the chart legible. */
export async function getCardCountsByAssignee(
  db: D1Database,
  limit = 10
): Promise<AssigneeCardCount[]> {
  const res = await db
    .prepare(
      `SELECT u.id, u.display_name, u.email, COUNT(*) as cnt
       FROM kanban_card_assignees a
       JOIN kanban_cards c ON c.id = a.card_id
       JOIN users u ON u.id = a.user_id
       WHERE c.archived_at IS NULL
       GROUP BY u.id
       ORDER BY cnt DESC, u.email ASC
       LIMIT ?`
    )
    .bind(limit)
    .all<{ id: number; display_name: string | null; email: string; cnt: number }>();
  return (res.results ?? []).map((r) => ({
    userId: r.id,
    displayName: r.display_name,
    email: r.email,
    count: r.cnt,
  }));
}

export interface DailyEventCount {
  /** YYYY-MM-DD (UTC). */
  day: string;
  count: number;
}

/**
 * Daily event counts from the per-card activity log over the last `days`
 * days (zero-filled for any day with no events). Sorted ascending so the
 * first element is the oldest day in the window.
 */
export async function getEventCountsByDay(
  db: D1Database,
  days = 30
): Promise<DailyEventCount[]> {
  const today = new Date();
  // Build the zero-filled day map first so missing days show as 0 in the chart.
  const buckets = new Map<string, number>();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 24 * 60 * 60 * 1000);
    buckets.set(d.toISOString().slice(0, 10), 0);
  }
  // SQLite's substr() pulls YYYY-MM-DD off the front of created_at without a
  // strftime call (which D1 supports but is overkill for a date prefix).
  const res = await db
    .prepare(
      `SELECT substr(created_at, 1, 10) as day, COUNT(*) as cnt
       FROM kanban_card_events
       WHERE created_at >= datetime('now', '-' || ? || ' days')
       GROUP BY day
       ORDER BY day ASC`
    )
    .bind(days)
    .all<{ day: string; cnt: number }>();
  for (const r of res.results ?? []) {
    if (buckets.has(r.day)) buckets.set(r.day, r.cnt);
  }
  return Array.from(buckets.entries()).map(([day, count]) => ({ day, count }));
}

// ── My Cards (cross-board) ──────────────────────────────────────────────

export interface AssignedCardSummary {
  id: number;
  boardId: number;
  boardSlug: string;
  boardName: string;
  column: ColumnName;
  position: number;
  title: string;
  startDate: string | null;
  dueDate: string | null;
  dueTime: string | null;
}

/**
 * Active (non-archived) cards across every board where `userId` is in
 * the assignee set. Sorted by due date (nulls last), then by board, then
 * by column position. Used by the /my page.
 */
export async function listCardsAssignedToUser(
  db: D1Database,
  userId: number
): Promise<AssignedCardSummary[]> {
  const res = await db
    .prepare(
      `SELECT c.id, c.board_id, c.column_name, c.position, c.title,
              c.start_date, c.due_date, c.due_time,
              b.slug as board_slug, b.name as board_name
       FROM kanban_card_assignees a
       JOIN kanban_cards c ON c.id = a.card_id
       JOIN kanban_boards b ON b.id = c.board_id
       WHERE a.user_id = ? AND c.archived_at IS NULL
       ORDER BY (c.due_date IS NULL) ASC, c.due_date ASC,
                b.name ASC, c.column_name ASC, c.position ASC`
    )
    .bind(userId)
    .all<{
      id: number;
      board_id: number;
      column_name: ColumnName;
      position: number;
      title: string;
      start_date: string | null;
      due_date: string | null;
      due_time: string | null;
      board_slug: string;
      board_name: string;
    }>();
  return (res.results ?? []).map((r) => ({
    id: r.id,
    boardId: r.board_id,
    boardSlug: r.board_slug,
    boardName: r.board_name,
    column: r.column_name,
    position: r.position,
    title: r.title,
    startDate: r.start_date,
    dueDate: r.due_date,
    dueTime: r.due_time,
  }));
}

/**
 * Hard cap on columns per board. Boards with this many columns refuse
 * further additions; the DO turns the resulting error into a typed nack.
 */
export const MAX_BOARD_COLUMNS = 7;

export class KanbanColumnLimitError extends Error {
  readonly limit: number;
  constructor(limit: number) {
    super(`Boards are limited to ${limit} columns.`);
    this.name = 'KanbanColumnLimitError';
    this.limit = limit;
  }
}

/**
 * Add a new column to a board. The key is normalized; on collision with
 * an existing column the call is a no-op and returns the existing config
 * row. New columns go to the end of the position order. Throws
 * KanbanColumnLimitError when the board already has MAX_BOARD_COLUMNS;
 * idempotent re-adds of an existing column are allowed even at the cap.
 */
export async function addBoardColumn(
  db: D1Database,
  boardId: number,
  rawKey: string,
  rawLabel: string
): Promise<BoardColumnConfigDto | null> {
  const key = normalizeColumnKey(rawKey);
  const label = rawLabel.trim().slice(0, 64);
  if (!key || !label) return null;
  const existing = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM kanban_board_columns WHERE board_id = ?1) AS total,
         (SELECT 1 FROM kanban_board_columns WHERE board_id = ?1 AND column_name = ?2 LIMIT 1) AS has_key`
    )
    .bind(boardId, key)
    .first<{ total: number; has_key: number | null }>();
  if (!existing?.has_key && (existing?.total ?? 0) >= MAX_BOARD_COLUMNS) {
    throw new KanbanColumnLimitError(MAX_BOARD_COLUMNS);
  }
  await db
    .prepare(
      `INSERT OR IGNORE INTO kanban_board_columns (board_id, column_name, label, position)
       VALUES (?, ?, ?,
         (SELECT COALESCE(MAX(position), -1) + 1 FROM kanban_board_columns WHERE board_id = ?)
       )`
    )
    .bind(boardId, key, label, boardId)
    .run();
  const row = await db
    .prepare(
      `SELECT column_name, label, position, wip_limit, color
       FROM kanban_board_columns WHERE board_id = ? AND column_name = ?`
    )
    .bind(boardId, key)
    .first<{ column_name: string; label: string; position: number; wip_limit: number | null; color: string | null }>();
  return row
    ? { columnName: row.column_name, label: row.label, position: row.position, wipLimit: row.wip_limit, color: row.color }
    : null;
}

export async function renameBoardColumn(
  db: D1Database,
  boardId: number,
  columnName: string,
  rawLabel: string
): Promise<BoardColumnConfigDto | null> {
  const label = rawLabel.trim().slice(0, 64);
  if (!label) return null;
  const row = await db
    .prepare(
      `UPDATE kanban_board_columns SET label = ?
       WHERE board_id = ? AND column_name = ?
       RETURNING column_name, label, position, wip_limit, color`
    )
    .bind(label, boardId, columnName)
    .first<{ column_name: string; label: string; position: number; wip_limit: number | null; color: string | null }>();
  return row
    ? { columnName: row.column_name, label: row.label, position: row.position, wipLimit: row.wip_limit, color: row.color }
    : null;
}

/**
 * Remove a column. Refuses if any active card still lives there — the
 * caller must move or archive those cards first. Returns true on
 * successful delete, false if blocked by cards or missing.
 */
export async function removeBoardColumn(
  db: D1Database,
  boardId: number,
  columnName: string
): Promise<{ ok: boolean; reason?: 'has_cards' | 'not_found' | 'last_column' }> {
  const cardRow = await db
    .prepare(
      `SELECT COUNT(*) as cnt FROM kanban_cards
       WHERE board_id = ? AND column_name = ? AND archived_at IS NULL`
    )
    .bind(boardId, columnName)
    .first<{ cnt: number }>();
  if ((cardRow?.cnt ?? 0) > 0) return { ok: false, reason: 'has_cards' };

  const remaining = await db
    .prepare(`SELECT COUNT(*) as cnt FROM kanban_board_columns WHERE board_id = ?`)
    .bind(boardId)
    .first<{ cnt: number }>();
  if ((remaining?.cnt ?? 0) <= 1) return { ok: false, reason: 'last_column' };

  const res = await db
    .prepare(
      `DELETE FROM kanban_board_columns
       WHERE board_id = ? AND column_name = ?`
    )
    .bind(boardId, columnName)
    .run();
  if ((res.meta?.changes ?? 0) === 0) return { ok: false, reason: 'not_found' };
  return { ok: true };
}

/**
 * Reorder all columns on a board. The caller supplies the new order as a
 * full list of column_name values; we validate it's exactly the current
 * set (no add/remove, no duplicates) and then renumber positions 0..N-1
 * in one batch. Returns the refreshed config rows on success, null on
 * any validation failure.
 */
export async function reorderBoardColumns(
  db: D1Database,
  boardId: number,
  orderedColumnNames: string[]
): Promise<BoardColumnConfigDto[] | null> {
  const current = await listBoardColumns(db, boardId);
  if (current.length !== orderedColumnNames.length) return null;
  const currentSet = new Set(current.map((c) => c.columnName));
  for (const name of orderedColumnNames) {
    if (!currentSet.has(name)) return null;
  }
  if (new Set(orderedColumnNames).size !== orderedColumnNames.length) return null;

  const stmts = orderedColumnNames.map((name, idx) =>
    db
      .prepare(
        `UPDATE kanban_board_columns SET position = ?
         WHERE board_id = ? AND column_name = ?`
      )
      .bind(idx, boardId, name)
  );
  await db.batch(stmts);
  return listBoardColumns(db, boardId);
}

export async function listActiveUserDirectory(
  db: D1Database
): Promise<AssigneeDto[]> {
  const res = await db
    .prepare(
      `SELECT id, display_name, email FROM users
       WHERE active = 1
       ORDER BY display_name ASC, email ASC`
    )
    .all<{ id: number; display_name: string | null; email: string }>();
  return (res.results ?? []).map((r) => ({
    userId: r.id,
    displayName: r.display_name,
    email: r.email,
  }));
}

/** Deduplicate + trim + drop empties, preserving first-seen casing. */
function normalizeGroups(raw: string[] | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of raw) {
    const t = typeof v === 'string' ? v.trim() : '';
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

/**
 * Count cards per column. Every column is present in the result, zero-filled.
 * When `boardId` is omitted, aggregates across every board (the home tile's
 * total-across-all-boards view). When provided, scopes to that board only.
 */
export async function getColumnCounts(
  db: D1Database,
  boardId?: number
): Promise<Record<ColumnName, number>> {
  const zeroed = KANBAN_COLUMNS.reduce(
    (acc, col) => {
      acc[col] = 0;
      return acc;
    },
    {} as Record<ColumnName, number>
  );
  // Archived cards never count toward column totals — they're hidden from the
  // primary board and the home-tile "work remaining" number.
  const res = boardId === undefined
    ? await db
        .prepare(
          `SELECT column_name, COUNT(*) as c FROM kanban_cards
           WHERE archived_at IS NULL GROUP BY column_name`
        )
        .all<{ column_name: ColumnName; c: number }>()
    : await db
        .prepare(
          `SELECT column_name, COUNT(*) as c FROM kanban_cards
           WHERE board_id = ? AND archived_at IS NULL GROUP BY column_name`
        )
        .bind(boardId)
        .all<{ column_name: ColumnName; c: number }>();
  for (const row of res.results ?? []) {
    if (row.column_name in zeroed) zeroed[row.column_name] = row.c;
  }
  return zeroed;
}

/**
 * Active cards on a board (archived excluded). The board view uses this for
 * its snapshot — archived cards load on demand via listArchivedCards().
 */
/**
 * List active cards for a board. When `viewerUserId` is passed, the
 * returned DTOs carry `hasUnreadComments` — true when there is any
 * comment authored by someone *other than* the viewer that was created
 * after the viewer's last `kanban_card_views` timestamp (or the viewer
 * has never opened the card and a non-self comment exists). Self-
 * authored comments never count as unread for the author.
 */
export async function listCards(
  db: D1Database,
  boardId: number,
  viewerUserId?: number
): Promise<CardDto[]> {
  type UnreadRow = RawCardRow & { has_unread_comments?: number };
  const sql = viewerUserId !== undefined
    ? `SELECT c.*,
         CASE WHEN EXISTS (
           SELECT 1 FROM kanban_card_comments cm
           LEFT JOIN kanban_card_views v
             ON v.card_id = cm.card_id AND v.user_id = ?2
           WHERE cm.card_id = c.id
             AND (cm.author_user_id IS NULL OR cm.author_user_id <> ?2)
             AND (v.last_viewed_at IS NULL OR cm.created_at > v.last_viewed_at)
         ) THEN 1 ELSE 0 END AS has_unread_comments
       FROM kanban_cards c
       WHERE c.board_id = ?1 AND c.archived_at IS NULL
       ORDER BY c.column_name ASC, c.position ASC, c.id ASC`
    : `SELECT * FROM kanban_cards WHERE board_id = ?1 AND archived_at IS NULL
       ORDER BY column_name ASC, position ASC, id ASC`;
  const stmt = viewerUserId !== undefined
    ? db.prepare(sql).bind(boardId, viewerUserId)
    : db.prepare(sql).bind(boardId);
  const res = await stmt.all<UnreadRow>();
  const rows = res.results ?? [];
  const ids = rows.map((r) => r.id);
  const [groups, assignees] = await Promise.all([
    loadGroupsForCards(db, ids),
    loadAssigneesForCards(db, ids),
  ]);
  return rows.map((r) =>
    hydrateCard(
      r,
      groups.get(r.id) ?? [],
      assignees.get(r.id) ?? [],
      viewerUserId !== undefined ? !!r.has_unread_comments : undefined
    )
  );
}

/**
 * Upsert the viewer's last-viewed timestamp on a card. Called when the
 * card detail modal opens; clears the unread-comments dot for that user.
 */
export async function markCardViewed(
  db: D1Database,
  userId: number,
  cardId: number
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO kanban_card_views (user_id, card_id, last_viewed_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(user_id, card_id)
       DO UPDATE SET last_viewed_at = datetime('now')`
    )
    .bind(userId, cardId)
    .run();
}

/**
 * Archived cards on a board, most recently archived first. Loaded on demand
 * when the user opens the archive drawer — keeps the main snapshot small.
 */
export async function listArchivedCards(
  db: D1Database,
  boardId: number
): Promise<CardDto[]> {
  const res = await db
    .prepare(
      `SELECT * FROM kanban_cards WHERE board_id = ? AND archived_at IS NOT NULL
       ORDER BY archived_at DESC, id DESC`
    )
    .bind(boardId)
    .all<RawCardRow>();
  const rows = res.results ?? [];
  const ids = rows.map((r) => r.id);
  const [groups, assignees] = await Promise.all([
    loadGroupsForCards(db, ids),
    loadAssigneesForCards(db, ids),
  ]);
  return rows.map((r) =>
    hydrateCard(r, groups.get(r.id) ?? [], assignees.get(r.id) ?? [])
  );
}

export interface CreateCardInput {
  column: ColumnName;
  title: string;
  groups?: string[];
  assigneeUserIds?: number[];
  assigned?: string | null;
  notes?: string | null;
  startDate?: string | null;
  dueDate?: string | null;
  dueTime?: string | null;
  /** Optional cover color (#aabbcc). Null/undefined = no cover. */
  coverColor?: string | null;
}

export async function createCard(
  db: D1Database,
  boardId: number,
  input: CreateCardInput,
  userId: number | null
): Promise<CardDto> {
  const groups = normalizeGroups(input.groups);
  // Validate the target column exists on this board (S12 — columns are
  // now per-board, no longer a fixed enum).
  if (!(await columnExists(db, boardId, input.column))) {
    throw new Error(`Column "${input.column}" does not exist on this board`);
  }
  // Append to the end of the target column on this board. MAX(position)
  // must only consider active (non-archived) cards — archived rows carry
  // position = -1 as a sentinel and must not influence new-card placement.
  const row = await db
    .prepare(
      `INSERT INTO kanban_cards
         (board_id, column_name, position, title, assigned, notes,
          start_date, due_date, due_time, cover_color,
          created_by_user_id, updated_by_user_id)
       VALUES (
         ?,
         ?,
         (SELECT COALESCE(MAX(position), -1) + 1 FROM kanban_cards
           WHERE board_id = ? AND column_name = ? AND archived_at IS NULL),
         ?, ?, ?, ?, ?, ?, ?, ?, ?
       )
       RETURNING *`
    )
    .bind(
      boardId,
      input.column,
      boardId,
      input.column,
      input.title,
      input.assigned ?? null,
      input.notes ?? null,
      input.startDate ?? null,
      input.dueDate ?? null,
      input.dueTime ?? null,
      input.coverColor ?? null,
      userId,
      userId
    )
    .first<RawCardRow>();

  if (!row) throw new Error('Failed to insert kanban card');
  if (groups.length > 0) {
    // Two writes per group: (1) ensure a kanban_groups row exists for
    // this (board, name) so future setGroupColor calls have something to
    // update; (2) link the card to the group via the existing junction.
    const stmts = [];
    for (const g of groups) {
      stmts.push(
        db
          .prepare(
            `INSERT OR IGNORE INTO kanban_groups (board_id, name) VALUES (?, ?)`
          )
          .bind(boardId, g)
      );
      stmts.push(
        db
          .prepare(
            `INSERT OR IGNORE INTO kanban_card_groups (card_id, group_name) VALUES (?, ?)`
          )
          .bind(row.id, g)
      );
    }
    await db.batch(stmts);
  }
  if (input.assigneeUserIds && input.assigneeUserIds.length > 0) {
    await setCardAssignees(db, row.id, input.assigneeUserIds);
  }
  const assignees = await loadAssigneesForCard(db, row.id);
  // Reload groups with color now that they've been ensured in kanban_groups.
  const groupDtos = await loadGroupsForCard(db, row.id);
  return hydrateCard(row, groupDtos, assignees);
}

export interface UpdateCardPatch {
  title?: string;
  /** Undefined = don't touch groups. Array = replace the whole set (empty = remove all). */
  groups?: string[];
  /** Undefined = don't touch assignees. Array = replace the whole set. */
  assigneeUserIds?: number[];
  assigned?: string | null;
  notes?: string | null;
  startDate?: string | null;
  dueDate?: string | null;
  dueTime?: string | null;
  /** Undefined = don't touch; null = clear cover; '#aabbcc' = set. */
  coverColor?: string | null;
}

/** Returns the updated card, or null on version conflict / not found. */
export async function updateCard(
  db: D1Database,
  id: number,
  expectedVersion: number,
  patch: UpdateCardPatch,
  userId: number | null
): Promise<CardDto | null> {
  const sets: string[] = [];
  const binds: Array<string | number | null> = [];

  if (patch.title !== undefined) {
    sets.push('title = ?');
    binds.push(patch.title);
  }
  if (patch.assigned !== undefined) {
    sets.push('assigned = ?');
    binds.push(patch.assigned ?? null);
  }
  if (patch.notes !== undefined) {
    sets.push('notes = ?');
    binds.push(patch.notes ?? null);
  }
  if (patch.dueDate !== undefined) {
    sets.push('due_date = ?');
    binds.push(patch.dueDate ?? null);
  }
  if (patch.startDate !== undefined) {
    sets.push('start_date = ?');
    binds.push(patch.startDate ?? null);
  }
  if (patch.dueTime !== undefined) {
    sets.push('due_time = ?');
    binds.push(patch.dueTime ?? null);
  }
  if (patch.coverColor !== undefined) {
    sets.push('cover_color = ?');
    binds.push(patch.coverColor ?? null);
  }

  const normalizedGroups =
    patch.groups !== undefined ? normalizeGroups(patch.groups) : undefined;

  // If nothing would change at all (no columns + no groups + no assignees
  // touched), return the current row at the expected version.
  if (sets.length === 0 && normalizedGroups === undefined && patch.assigneeUserIds === undefined) {
    const row = await db
      .prepare(`SELECT * FROM kanban_cards WHERE id = ? AND version = ?`)
      .bind(id, expectedVersion)
      .first<RawCardRow>();
    if (!row) return null;
    return hydrateCard(
      row,
      await loadGroupsForCard(db, id),
      await loadAssigneesForCard(db, id)
    );
  }

  // Always bump version/updated_at when groups are touched, even if no scalar
  // column changed — callers rely on a version increment after any edit.
  sets.push('version = version + 1');
  sets.push(`updated_at = datetime('now')`);
  sets.push('updated_by_user_id = ?');
  binds.push(userId);
  binds.push(id);
  binds.push(expectedVersion);

  const row = await db
    .prepare(
      `UPDATE kanban_cards SET ${sets.join(', ')}
       WHERE id = ? AND version = ?
       RETURNING *`
    )
    .bind(...binds)
    .first<RawCardRow>();

  if (!row) return null;

  if (normalizedGroups !== undefined) {
    // Same auto-insert pattern as createCard: ensure each named group
    // exists in kanban_groups for this card's board before linking it.
    const stmts: ReturnType<typeof db.prepare>[] = [
      db.prepare(`DELETE FROM kanban_card_groups WHERE card_id = ?`).bind(id) as ReturnType<typeof db.prepare>,
    ];
    for (const g of normalizedGroups) {
      stmts.push(
        db
          .prepare(
            `INSERT OR IGNORE INTO kanban_groups (board_id, name)
             SELECT board_id, ? FROM kanban_cards WHERE id = ?`
          )
          .bind(g, id)
      );
      stmts.push(
        db
          .prepare(
            `INSERT OR IGNORE INTO kanban_card_groups (card_id, group_name) VALUES (?, ?)`
          )
          .bind(id, g)
      );
    }
    await db.batch(stmts);
  }
  if (patch.assigneeUserIds !== undefined) {
    await setCardAssignees(db, id, patch.assigneeUserIds);
  }

  const finalGroups = await loadGroupsForCard(db, id);
  const finalAssignees = await loadAssigneesForCard(db, id);
  return hydrateCard(row, finalGroups, finalAssignees);
}

export interface AffectedPosition {
  id: number;
  column: ColumnName;
  position: number;
  version: number;
}

export interface MoveResult {
  card: CardDto;
  affected: AffectedPosition[];
  fromColumn: ColumnName;
  toColumn: ColumnName;
}

/**
 * Move a card to (toColumn, toPosition). Renumbers positions within the
 * card's board in the source and target columns so they stay dense.
 *
 * Returns null if the card doesn't exist or the caller's version is stale.
 * On success, `affected` contains every card in the touched column(s) with
 * their post-move position and version — the client uses this to re-render
 * those columns from server-authoritative state.
 */
export async function moveCard(
  db: D1Database,
  id: number,
  expectedVersion: number,
  toColumn: ColumnName,
  toPosition: number,
  userId: number | null
): Promise<MoveResult | null> {
  const current = await db
    .prepare(
      `SELECT board_id, column_name, position, version, archived_at
         FROM kanban_cards WHERE id = ?`
    )
    .bind(id)
    .first<{ board_id: number; column_name: ColumnName; position: number; version: number; archived_at: string | null }>();
  if (!current) return null;
  if (current.version !== expectedVersion) return null;
  // Archived cards are not on the board; refuse to move them.
  if (current.archived_at) return null;

  const boardId = current.board_id;
  const fromColumn = current.column_name;
  const fromPosition = current.position;

  // Refuse moves to a column that doesn't exist on this board (S12).
  // Same-column reorders are still valid even if the column is somehow
  // missing — they don't change column_name — so only validate cross-column.
  if (toColumn !== fromColumn && !(await columnExists(db, boardId, toColumn))) {
    return null;
  }

  // Clamp toPosition into the valid range for the destination (board, column).
  // Only active cards count — archived rows sit outside the position ordering.
  const countRow = await db
    .prepare(
      `SELECT COUNT(*) as c FROM kanban_cards
         WHERE board_id = ? AND column_name = ? AND archived_at IS NULL`
    )
    .bind(boardId, toColumn)
    .first<{ c: number }>();
  const targetCount = countRow?.c ?? 0;
  const maxPos = fromColumn === toColumn ? targetCount - 1 : targetCount;
  const effectiveToPos = Math.max(0, Math.min(Math.floor(toPosition), maxPos));

  const stmts = [];

  if (fromColumn === toColumn) {
    if (effectiveToPos === fromPosition) {
      // No-op. Still bump version + updated_at so clients observe a coherent
      // state (and so the caller's optimistic move is acked).
      stmts.push(
        db
          .prepare(
            `UPDATE kanban_cards
             SET version = version + 1, updated_at = datetime('now'), updated_by_user_id = ?
             WHERE id = ? AND version = ?`
          )
          .bind(userId, id, expectedVersion)
      );
    } else if (effectiveToPos > fromPosition) {
      stmts.push(
        db
          .prepare(
            `UPDATE kanban_cards SET position = position - 1
             WHERE board_id = ? AND column_name = ? AND archived_at IS NULL
               AND position > ? AND position <= ?`
          )
          .bind(boardId, fromColumn, fromPosition, effectiveToPos)
      );
      stmts.push(
        db
          .prepare(
            `UPDATE kanban_cards
             SET column_name = ?, position = ?, version = version + 1,
                 updated_at = datetime('now'), updated_by_user_id = ?
             WHERE id = ? AND version = ?`
          )
          .bind(toColumn, effectiveToPos, userId, id, expectedVersion)
      );
    } else {
      stmts.push(
        db
          .prepare(
            `UPDATE kanban_cards SET position = position + 1
             WHERE board_id = ? AND column_name = ? AND archived_at IS NULL
               AND position >= ? AND position < ?`
          )
          .bind(boardId, fromColumn, effectiveToPos, fromPosition)
      );
      stmts.push(
        db
          .prepare(
            `UPDATE kanban_cards
             SET column_name = ?, position = ?, version = version + 1,
                 updated_at = datetime('now'), updated_by_user_id = ?
             WHERE id = ? AND version = ?`
          )
          .bind(toColumn, effectiveToPos, userId, id, expectedVersion)
      );
    }
  } else {
    // Cross-column: close gap in source, open gap in target, then relocate.
    // Both writes are scoped to this board. Archived rows are excluded from
    // position shifts — their position is a -1 sentinel outside the ordering.
    stmts.push(
      db
        .prepare(
          `UPDATE kanban_cards SET position = position - 1
           WHERE board_id = ? AND column_name = ? AND archived_at IS NULL
             AND position > ?`
        )
        .bind(boardId, fromColumn, fromPosition)
    );
    stmts.push(
      db
        .prepare(
          `UPDATE kanban_cards SET position = position + 1
           WHERE board_id = ? AND column_name = ? AND archived_at IS NULL
             AND position >= ?`
        )
        .bind(boardId, toColumn, effectiveToPos)
    );
    stmts.push(
      db
        .prepare(
          `UPDATE kanban_cards
           SET column_name = ?, position = ?, version = version + 1,
               updated_at = datetime('now'), updated_by_user_id = ?
           WHERE id = ? AND version = ?`
        )
        .bind(toColumn, effectiveToPos, userId, id, expectedVersion)
    );
  }

  await db.batch(stmts);

  const movedRow = await db
    .prepare(`SELECT * FROM kanban_cards WHERE id = ?`)
    .bind(id)
    .first<RawCardRow>();
  if (!movedRow) return null;

  const affectedCols: ColumnName[] =
    fromColumn === toColumn ? [fromColumn] : [fromColumn, toColumn];
  const affectedRows = await db
    .prepare(
      `SELECT id, column_name, position, version FROM kanban_cards
       WHERE board_id = ? AND archived_at IS NULL
         AND column_name IN (${affectedCols.map(() => '?').join(',')})`
    )
    .bind(boardId, ...affectedCols)
    .all<{ id: number; column_name: ColumnName; position: number; version: number }>();

  const movedGroups = await loadGroupsForCard(db, id);
  const movedAssignees = await loadAssigneesForCard(db, id);
  return {
    card: hydrateCard(movedRow, movedGroups, movedAssignees),
    fromColumn,
    toColumn,
    affected: (affectedRows.results ?? []).map((r) => ({
      id: r.id,
      column: r.column_name,
      position: r.position,
      version: r.version,
    })),
  };
}

/**
 * Hard-delete a card (destructive; retained for completeness but not wired
 * into the UI — the board uses `archiveCard` as its primary destructive
 * action). Returns true on success, false on version conflict / not found.
 *
 * If the card is already archived its position is -1 and no gap needs to
 * close; otherwise shift the later cards in its column down by one.
 */
export async function deleteCard(
  db: D1Database,
  id: number,
  expectedVersion: number
): Promise<boolean> {
  const current = await db
    .prepare(
      `SELECT board_id, column_name, position, version, archived_at
         FROM kanban_cards WHERE id = ?`
    )
    .bind(id)
    .first<{ board_id: number; column_name: ColumnName; position: number; version: number; archived_at: string | null }>();
  if (!current || current.version !== expectedVersion) return false;

  const stmts = [
    db
      .prepare(`DELETE FROM kanban_cards WHERE id = ? AND version = ?`)
      .bind(id, expectedVersion),
  ];
  if (!current.archived_at) {
    stmts.push(
      db
        .prepare(
          `UPDATE kanban_cards SET position = position - 1
           WHERE board_id = ? AND column_name = ? AND archived_at IS NULL
             AND position > ?`
        )
        .bind(current.board_id, current.column_name, current.position)
    );
  }
  await db.batch(stmts);

  return true;
}

export interface ArchiveResult {
  card: CardDto;
  column: ColumnName;
  /** Post-archive positions of the remaining active cards in the affected column. */
  affected: AffectedPosition[];
}

/**
 * Archive (soft-delete) a card. The row is retained with a non-null
 * `archived_at` timestamp and its position is set to -1 (sentinel, outside
 * the dense ordering). Later active cards in the same column shift down
 * to close the gap.
 *
 * Returns null on version conflict, missing card, or already-archived.
 */
export async function archiveCard(
  db: D1Database,
  id: number,
  expectedVersion: number,
  userId: number | null
): Promise<ArchiveResult | null> {
  const current = await db
    .prepare(
      `SELECT board_id, column_name, position, version, archived_at
         FROM kanban_cards WHERE id = ?`
    )
    .bind(id)
    .first<{ board_id: number; column_name: ColumnName; position: number; version: number; archived_at: string | null }>();
  if (!current) return null;
  if (current.version !== expectedVersion) return null;
  if (current.archived_at) return null;

  await db.batch([
    db
      .prepare(
        `UPDATE kanban_cards
         SET archived_at = datetime('now'), position = -1,
             version = version + 1, updated_at = datetime('now'),
             updated_by_user_id = ?
         WHERE id = ? AND version = ?`
      )
      .bind(userId, id, expectedVersion),
    db
      .prepare(
        `UPDATE kanban_cards SET position = position - 1
         WHERE board_id = ? AND column_name = ? AND archived_at IS NULL
           AND position > ?`
      )
      .bind(current.board_id, current.column_name, current.position),
  ]);

  const row = await db
    .prepare(`SELECT * FROM kanban_cards WHERE id = ?`)
    .bind(id)
    .first<RawCardRow>();
  if (!row) return null;

  const affectedRows = await db
    .prepare(
      `SELECT id, column_name, position, version FROM kanban_cards
       WHERE board_id = ? AND column_name = ? AND archived_at IS NULL`
    )
    .bind(current.board_id, current.column_name)
    .all<{ id: number; column_name: ColumnName; position: number; version: number }>();

  return {
    card: hydrateCard(row, await loadGroupsForCard(db, id), await loadAssigneesForCard(db, id)),
    column: current.column_name,
    affected: (affectedRows.results ?? []).map((r) => ({
      id: r.id,
      column: r.column_name,
      position: r.position,
      version: r.version,
    })),
  };
}

/**
 * Restore a previously-archived card. It returns to the end of its original
 * column. Returns null on version conflict, missing card, or not-archived.
 */
export async function unarchiveCard(
  db: D1Database,
  id: number,
  expectedVersion: number,
  userId: number | null
): Promise<ArchiveResult | null> {
  const current = await db
    .prepare(
      `SELECT board_id, column_name, version, archived_at
         FROM kanban_cards WHERE id = ?`
    )
    .bind(id)
    .first<{ board_id: number; column_name: ColumnName; version: number; archived_at: string | null }>();
  if (!current) return null;
  if (current.version !== expectedVersion) return null;
  if (!current.archived_at) return null;

  await db
    .prepare(
      `UPDATE kanban_cards
       SET archived_at = NULL,
           position = (SELECT COALESCE(MAX(position), -1) + 1 FROM kanban_cards
                        WHERE board_id = ? AND column_name = ? AND archived_at IS NULL),
           version = version + 1,
           updated_at = datetime('now'),
           updated_by_user_id = ?
       WHERE id = ? AND version = ?`
    )
    .bind(current.board_id, current.column_name, userId, id, expectedVersion)
    .run();

  const row = await db
    .prepare(`SELECT * FROM kanban_cards WHERE id = ?`)
    .bind(id)
    .first<RawCardRow>();
  if (!row) return null;

  const affectedRows = await db
    .prepare(
      `SELECT id, column_name, position, version FROM kanban_cards
       WHERE board_id = ? AND column_name = ? AND archived_at IS NULL`
    )
    .bind(current.board_id, current.column_name)
    .all<{ id: number; column_name: ColumnName; position: number; version: number }>();

  return {
    card: hydrateCard(row, await loadGroupsForCard(db, id), await loadAssigneesForCard(db, id)),
    column: current.column_name,
    affected: (affectedRows.results ?? []).map((r) => ({
      id: r.id,
      column: r.column_name,
      position: r.position,
      version: r.version,
    })),
  };
}

// ── Card events (per-card activity log) ─────────────────────────────────

/**
 * Known event kinds. Not a DB CHECK constraint — new kinds can be added by
 * the application without a migration — but TypeScript enforces the shape
 * at the call sites. Expands over time as new features ship (comments,
 * assignees, etc.).
 */
export type CardEventKind =
  | 'card.created'
  | 'card.updated'
  | 'card.moved'
  | 'card.archived'
  | 'card.unarchived'
  | 'card.deleted';

export interface CardEventDto {
  id: number;
  cardId: number;
  actorUserId: number | null;
  /** Actor display name, resolved at list time from users.display_name. */
  actorDisplayName: string | null;
  kind: CardEventKind | string;
  /** Parsed JSON metadata; null when the kind carries no payload. */
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

interface RawCardEventRow {
  id: number;
  card_id: number;
  actor_user_id: number | null;
  kind: string;
  metadata: string | null;
  created_at: string;
}

function parseEventMetadata(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function hydrateCardEvent(
  row: RawCardEventRow,
  actorDisplayName: string | null
): CardEventDto {
  return {
    id: row.id,
    cardId: row.card_id,
    actorUserId: row.actor_user_id,
    actorDisplayName,
    kind: row.kind,
    metadata: parseEventMetadata(row.metadata),
    createdAt: row.created_at,
  };
}

/**
 * Append a row to the per-card activity log. Returns the freshly-inserted
 * event (with its id + created_at) so the DO can broadcast it without a
 * second round-trip. `actorDisplayName` is resolved here so broadcast
 * payloads don't need the client to maintain a user directory.
 */
export async function logCardEvent(
  db: D1Database,
  input: {
    cardId: number;
    userId: number | null;
    kind: CardEventKind;
    metadata?: Record<string, unknown>;
  }
): Promise<CardEventDto> {
  const metaJson = input.metadata ? JSON.stringify(input.metadata) : null;
  const row = await db
    .prepare(
      `INSERT INTO kanban_card_events (card_id, actor_user_id, kind, metadata)
       VALUES (?, ?, ?, ?) RETURNING *`
    )
    .bind(input.cardId, input.userId, input.kind, metaJson)
    .first<RawCardEventRow>();
  if (!row) throw new Error('Failed to insert card event');

  let actorDisplayName: string | null = null;
  if (input.userId !== null) {
    const u = await db
      .prepare(`SELECT display_name FROM users WHERE id = ?`)
      .bind(input.userId)
      .first<{ display_name: string | null }>();
    actorDisplayName = u?.display_name ?? null;
  }
  return hydrateCardEvent(row, actorDisplayName);
}

/**
 * Return the most recent events for a card (newest first), up to `limit`.
 * Actor display names are resolved in the same query via LEFT JOIN so a
 * user who's been renamed since the event fired shows their current name.
 */
export async function listCardEvents(
  db: D1Database,
  cardId: number,
  limit = 50
): Promise<CardEventDto[]> {
  const res = await db
    .prepare(
      `SELECT e.*, u.display_name as actor_display_name
       FROM kanban_card_events e
       LEFT JOIN users u ON u.id = e.actor_user_id
       WHERE e.card_id = ?
       ORDER BY e.id DESC
       LIMIT ?`
    )
    .bind(cardId, limit)
    .all<RawCardEventRow & { actor_display_name: string | null }>();
  return (res.results ?? []).map((r) => hydrateCardEvent(r, r.actor_display_name));
}

// ── Comments ────────────────────────────────────────────────────────────

export interface CommentDto {
  id: number;
  cardId: number;
  authorUserId: number | null;
  authorDisplayName: string | null;
  body: string;
  /** ISO timestamp of the most recent edit; null if never edited. */
  editedAt: string | null;
  createdAt: string;
}

interface RawCommentRow {
  id: number;
  card_id: number;
  author_user_id: number | null;
  body: string;
  edited_at: string | null;
  created_at: string;
}

function hydrateComment(
  row: RawCommentRow,
  authorDisplayName: string | null
): CommentDto {
  return {
    id: row.id,
    cardId: row.card_id,
    authorUserId: row.author_user_id,
    authorDisplayName,
    body: row.body,
    editedAt: row.edited_at,
    createdAt: row.created_at,
  };
}

/** Oldest first — conventional thread order. */
export async function listComments(
  db: D1Database,
  cardId: number
): Promise<CommentDto[]> {
  const res = await db
    .prepare(
      `SELECT c.*, u.display_name as author_display_name
       FROM kanban_card_comments c
       LEFT JOIN users u ON u.id = c.author_user_id
       WHERE c.card_id = ?
       ORDER BY c.id ASC`
    )
    .bind(cardId)
    .all<RawCommentRow & { author_display_name: string | null }>();
  return (res.results ?? []).map((r) => hydrateComment(r, r.author_display_name));
}

export async function createComment(
  db: D1Database,
  cardId: number,
  body: string,
  userId: number | null
): Promise<CommentDto> {
  const trimmed = body.trim();
  if (!trimmed) throw new Error('Comment body is required');
  const row = await db
    .prepare(
      `INSERT INTO kanban_card_comments (card_id, author_user_id, body)
       VALUES (?, ?, ?)
       RETURNING *`
    )
    .bind(cardId, userId, trimmed)
    .first<RawCommentRow>();
  if (!row) throw new Error('Failed to insert comment');
  // Resolve display name once for the broadcast payload — same pattern as
  // logCardEvent. Avoids a second client round-trip to enrich the row.
  let displayName: string | null = null;
  if (userId !== null) {
    const u = await db
      .prepare(`SELECT display_name FROM users WHERE id = ?`)
      .bind(userId)
      .first<{ display_name: string | null }>();
    displayName = u?.display_name ?? null;
  }
  return hydrateComment(row, displayName);
}

/**
 * Edit a comment body. Only the original author may edit; everyone else
 * (including admins) must delete-and-repost. Returns null when the
 * caller isn't the author, the comment is missing, or the body is empty.
 */
export async function updateComment(
  db: D1Database,
  id: number,
  body: string,
  userId: number | null
): Promise<CommentDto | null> {
  const trimmed = body.trim();
  if (!trimmed) return null;
  if (userId === null) return null;
  const row = await db
    .prepare(
      `UPDATE kanban_card_comments
       SET body = ?, edited_at = datetime('now')
       WHERE id = ? AND author_user_id = ?
       RETURNING *`
    )
    .bind(trimmed, id, userId)
    .first<RawCommentRow>();
  if (!row) return null;
  const u = await db
    .prepare(`SELECT display_name FROM users WHERE id = ?`)
    .bind(userId)
    .first<{ display_name: string | null }>();
  return hydrateComment(row, u?.display_name ?? null);
}

export interface DeletedCommentRef {
  id: number;
  cardId: number;
}

/**
 * Delete a comment. Author may delete their own; admins may delete any.
 * Returns the (id, cardId) of the deleted row so the caller can broadcast
 * a precise removal, or null if no row matched the auth predicate.
 */
export async function deleteComment(
  db: D1Database,
  id: number,
  userId: number | null,
  isAdmin: boolean
): Promise<DeletedCommentRef | null> {
  if (userId === null && !isAdmin) return null;
  const row = isAdmin
    ? await db
        .prepare(
          `DELETE FROM kanban_card_comments WHERE id = ? RETURNING id, card_id`
        )
        .bind(id)
        .first<{ id: number; card_id: number }>()
    : await db
        .prepare(
          `DELETE FROM kanban_card_comments
           WHERE id = ? AND author_user_id = ?
           RETURNING id, card_id`
        )
        .bind(id, userId)
        .first<{ id: number; card_id: number }>();
  return row ? { id: row.id, cardId: row.card_id } : null;
}

// ── Checklist items (S10) ───────────────────────────────────────────────

export interface ChecklistItemDto {
  id: number;
  cardId: number;
  position: number;
  body: string;
  /** ISO timestamp when checked off; null = unchecked. */
  completedAt: string | null;
  dueDate: string | null;
  assigneeUserId: number | null;
  createdAt: string;
}

interface RawChecklistRow {
  id: number;
  card_id: number;
  position: number;
  body: string;
  completed_at: string | null;
  due_date: string | null;
  assignee_user_id: number | null;
  created_at: string;
}

function hydrateChecklistItem(row: RawChecklistRow): ChecklistItemDto {
  return {
    id: row.id,
    cardId: row.card_id,
    position: row.position,
    body: row.body,
    completedAt: row.completed_at,
    dueDate: row.due_date,
    assigneeUserId: row.assignee_user_id,
    createdAt: row.created_at,
  };
}

export async function listChecklistItems(
  db: D1Database,
  cardId: number
): Promise<ChecklistItemDto[]> {
  const res = await db
    .prepare(
      `SELECT * FROM kanban_card_checklist_items
       WHERE card_id = ?
       ORDER BY position ASC, id ASC`
    )
    .bind(cardId)
    .all<RawChecklistRow>();
  return (res.results ?? []).map(hydrateChecklistItem);
}

export async function createChecklistItem(
  db: D1Database,
  cardId: number,
  body: string
): Promise<ChecklistItemDto> {
  const trimmed = body.trim();
  if (!trimmed) throw new Error('Checklist item body is required');
  const row = await db
    .prepare(
      `INSERT INTO kanban_card_checklist_items (card_id, position, body)
       VALUES (
         ?,
         (SELECT COALESCE(MAX(position), -1) + 1 FROM kanban_card_checklist_items WHERE card_id = ?),
         ?
       )
       RETURNING *`
    )
    .bind(cardId, cardId, trimmed)
    .first<RawChecklistRow>();
  if (!row) throw new Error('Failed to insert checklist item');
  return hydrateChecklistItem(row);
}

export interface ChecklistItemPatch {
  body?: string;
  /** true = mark complete (sets completed_at = now); false = uncheck (set null). */
  completed?: boolean;
}

/** Anyone authenticated can edit checklist items — they're sub-task notes,
    not authoritative records. Returns the updated item or null if missing. */
export async function updateChecklistItem(
  db: D1Database,
  id: number,
  patch: ChecklistItemPatch
): Promise<ChecklistItemDto | null> {
  const sets: string[] = [];
  const binds: Array<string | number | null> = [];
  if (patch.body !== undefined) {
    const trimmed = patch.body.trim();
    if (!trimmed) return null;
    sets.push('body = ?');
    binds.push(trimmed);
  }
  if (patch.completed !== undefined) {
    sets.push('completed_at = ?');
    binds.push(patch.completed ? new Date().toISOString().replace('T', ' ').slice(0, 19) : null);
  }
  if (sets.length === 0) {
    const row = await db
      .prepare(`SELECT * FROM kanban_card_checklist_items WHERE id = ?`)
      .bind(id)
      .first<RawChecklistRow>();
    return row ? hydrateChecklistItem(row) : null;
  }
  binds.push(id);
  const row = await db
    .prepare(
      `UPDATE kanban_card_checklist_items SET ${sets.join(', ')}
       WHERE id = ? RETURNING *`
    )
    .bind(...binds)
    .first<RawChecklistRow>();
  return row ? hydrateChecklistItem(row) : null;
}

export interface DeletedChecklistRef {
  id: number;
  cardId: number;
}

export async function deleteChecklistItem(
  db: D1Database,
  id: number
): Promise<DeletedChecklistRef | null> {
  const row = await db
    .prepare(
      `DELETE FROM kanban_card_checklist_items WHERE id = ? RETURNING id, card_id`
    )
    .bind(id)
    .first<{ id: number; card_id: number }>();
  return row ? { id: row.id, cardId: row.card_id } : null;
}

/** Look up a single comment (for authorization / refetch flows). */
export async function getComment(
  db: D1Database,
  id: number
): Promise<CommentDto | null> {
  const row = await db
    .prepare(
      `SELECT c.*, u.display_name as author_display_name
       FROM kanban_card_comments c
       LEFT JOIN users u ON u.id = c.author_user_id
       WHERE c.id = ?`
    )
    .bind(id)
    .first<RawCommentRow & { author_display_name: string | null }>();
  return row ? hydrateComment(row, row.author_display_name) : null;
}
