-- S12 — drop the CHECK constraint on kanban_cards.column_name so per-board
-- custom columns can use arbitrary keys. SQLite doesn't support
-- ALTER TABLE ... DROP CONSTRAINT, so we go through the standard
-- "rename + recreate + copy + swap" dance.
--
-- Authorization for which column names are valid moves to the application
-- layer: every mutating service function now validates against the
-- per-board kanban_board_columns rows seeded in migration 0012.
--
-- All existing data is preserved verbatim — column_name keys stay the
-- same six the enum used (not_started/started/blocked/ready/approval/done),
-- and the new table has the same column order so SELECT * keeps working.

PRAGMA foreign_keys = OFF;

CREATE TABLE kanban_cards_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  column_name TEXT NOT NULL,
  position INTEGER NOT NULL,
  title TEXT NOT NULL,
  assigned TEXT,
  notes TEXT,
  due_date TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  board_id INTEGER REFERENCES kanban_boards(id) ON DELETE CASCADE,
  archived_at TEXT,
  start_date TEXT,
  due_time TEXT
);

INSERT INTO kanban_cards_new
  SELECT id, column_name, position, title, assigned, notes, due_date,
         version, created_by_user_id, updated_by_user_id,
         created_at, updated_at, board_id, archived_at, start_date, due_time
  FROM kanban_cards;

DROP TABLE kanban_cards;
ALTER TABLE kanban_cards_new RENAME TO kanban_cards;

-- Re-create the indexes that lived on the old table.
CREATE INDEX IF NOT EXISTS idx_kanban_cards_board_col_pos
  ON kanban_cards(board_id, column_name, position);
CREATE INDEX IF NOT EXISTS idx_kanban_cards_col_pos
  ON kanban_cards(column_name, position);
CREATE INDEX IF NOT EXISTS idx_kanban_cards_archived
  ON kanban_cards(board_id, archived_at)
  WHERE archived_at IS NOT NULL;

PRAGMA foreign_keys = ON;
