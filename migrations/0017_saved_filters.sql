-- Per-user named search/filter queries (P4).
--
-- A saved filter is a named query string the user can recall with one
-- click on the kanban filter bar. Scope is per-user; an optional
-- board_id narrows visibility to a single board (null = applies to
-- every board the user opens). The query string is the same syntax the
-- client-side parser already accepts (P3 operators + bare words).
--
-- name is unique per (user, board) so the user can't accidentally
-- create two filters that would render as duplicate chips. The PK is
-- still id so renames + reorders stay possible without orphaning rows
-- or breaking external references.

CREATE TABLE IF NOT EXISTS kanban_saved_filters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  /** Optional board scope — null = applies to every board. */
  board_id INTEGER REFERENCES kanban_boards(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  query TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Lookup is always "what filters does this user have for this board"
-- — index covers both the global (board_id IS NULL) and per-board
-- variants without a second pass.
CREATE INDEX IF NOT EXISTS idx_saved_filters_user_board
  ON kanban_saved_filters(user_id, board_id, id);

-- Soft uniqueness — a user can't have two filters with the same name
-- on the same board (or two board-agnostic filters with the same name).
-- Partial-unique on (user_id, board_id, name) requires the COALESCE
-- trick because SQLite treats NULLs as distinct in unique constraints.
CREATE UNIQUE INDEX IF NOT EXISTS idx_saved_filters_uniq_name
  ON kanban_saved_filters(user_id, COALESCE(board_id, 0), name);
