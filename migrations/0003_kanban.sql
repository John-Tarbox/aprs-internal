-- Single shared company-wide kanban board.
--
-- Real-time fan-out is handled by a Durable Object (KanbanBoardDO);
-- this table is the durable source of truth. Positions are dense
-- 0-based integers within a column, renumbered on move/delete.

CREATE TABLE IF NOT EXISTS kanban_cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  column_name TEXT NOT NULL CHECK (column_name IN (
    'not_started','started','blocked','ready','approval','done'
  )),
  position INTEGER NOT NULL,
  title TEXT NOT NULL,
  group_name TEXT,
  assigned TEXT,
  notes TEXT,
  due_date TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_kanban_cards_col_pos
  ON kanban_cards(column_name, position);
