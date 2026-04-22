-- Multi-board kanban. Each board is its own Durable Object room and each
-- kanban_cards row belongs to exactly one board via board_id.
--
-- SQLite cannot retroactively tighten NULL -> NOT NULL on an existing column
-- without a table rebuild, so board_id stays nullable at the SQL layer. The
-- app layer always sets it on INSERT; that's the invariant.

CREATE TABLE IF NOT EXISTS kanban_boards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE COLLATE NOCASE,
  created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Seed the Default board with id=1 so the backfill below can reference it.
INSERT OR IGNORE INTO kanban_boards (id, name, slug, created_by_user_id)
  VALUES (1, 'Default', 'default', 1);

ALTER TABLE kanban_cards
  ADD COLUMN board_id INTEGER REFERENCES kanban_boards(id) ON DELETE CASCADE;

UPDATE kanban_cards SET board_id = 1 WHERE board_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_kanban_cards_board_col_pos
  ON kanban_cards(board_id, column_name, position);
