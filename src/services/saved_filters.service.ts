/**
 * Saved filters (P4) — per-user named queries against the kanban board.
 *
 * A filter is a name + query string scoped to a user, optionally
 * narrowed to a single board. The query string is the same syntax the
 * client-side parser already accepts (operators like `assigned:` /
 * `label:` / `is:overdue` plus bare-word substrings).
 *
 * Authorization: every function takes a userId; mutations match on
 * (id, user_id) so a user can never see, modify, or delete another
 * user's filters even with a forged id. There's no admin override —
 * filters are personal preferences, not shared state.
 */

export interface SavedFilterDto {
  id: number;
  userId: number;
  /** null = applies to every board the user opens. */
  boardId: number | null;
  name: string;
  query: string;
  createdAt: string;
}

interface RawSavedFilterRow {
  id: number;
  user_id: number;
  board_id: number | null;
  name: string;
  query: string;
  created_at: string;
}

function hydrate(row: RawSavedFilterRow): SavedFilterDto {
  return {
    id: row.id,
    userId: row.user_id,
    boardId: row.board_id,
    name: row.name,
    query: row.query,
    createdAt: row.created_at,
  };
}

/**
 * List filters for a user, optionally narrowed to a board. When
 * `boardId` is provided, returns both the user's board-agnostic
 * filters AND the ones scoped to that board — that's what the chip
 * row should show. When omitted, returns *all* of the user's filters
 * (used by a future "manage filters" view).
 */
export async function listSavedFilters(
  db: D1Database,
  userId: number,
  boardId?: number | null
): Promise<SavedFilterDto[]> {
  const sql = boardId !== undefined && boardId !== null
    ? `SELECT * FROM kanban_saved_filters
       WHERE user_id = ? AND (board_id IS NULL OR board_id = ?)
       ORDER BY (board_id IS NULL) DESC, name ASC`
    : `SELECT * FROM kanban_saved_filters
       WHERE user_id = ?
       ORDER BY (board_id IS NULL) DESC, board_id ASC, name ASC`;
  const res = boardId !== undefined && boardId !== null
    ? await db.prepare(sql).bind(userId, boardId).all<RawSavedFilterRow>()
    : await db.prepare(sql).bind(userId).all<RawSavedFilterRow>();
  return (res.results ?? []).map(hydrate);
}

export interface CreateSavedFilterInput {
  name: string;
  query: string;
  boardId?: number | null;
}

/**
 * Create a new saved filter. Returns null when:
 *  - name is empty after trimming
 *  - query is empty after trimming
 *  - a filter with the same (user, board, name) already exists
 *    (the partial-unique index would 409 anyway; we catch + return null).
 */
export async function createSavedFilter(
  db: D1Database,
  userId: number,
  input: CreateSavedFilterInput
): Promise<SavedFilterDto | null> {
  const name = input.name.trim().slice(0, 100);
  const query = input.query.trim().slice(0, 500);
  if (!name || !query) return null;
  const boardId = input.boardId ?? null;
  try {
    const row = await db
      .prepare(
        `INSERT INTO kanban_saved_filters (user_id, board_id, name, query)
         VALUES (?, ?, ?, ?)
         RETURNING *`
      )
      .bind(userId, boardId, name, query)
      .first<RawSavedFilterRow>();
    return row ? hydrate(row) : null;
  } catch {
    // UNIQUE violation — surfaced as null so the caller can render
    // "name already taken" without distinguishing causes.
    return null;
  }
}

/**
 * Delete by id, owner-scoped. Returns true if a row was actually
 * removed; false on no-match (wrong id or wrong owner).
 */
export async function deleteSavedFilter(
  db: D1Database,
  userId: number,
  id: number
): Promise<boolean> {
  const res = await db
    .prepare(
      `DELETE FROM kanban_saved_filters WHERE id = ? AND user_id = ?`
    )
    .bind(id, userId)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}
