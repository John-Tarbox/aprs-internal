-- Per-board column configuration (S9 + scaffolding for S12).
--
-- For S9 the only user-configurable field is `wip_limit` (null = no
-- limit). The other columns (label, position) carry seed values mirroring
-- the current hard-coded enum so the board UI keeps rendering the same
-- six columns in the same order.
--
-- S12 will repurpose this table to support fully-custom column sets.
-- For now this table is purely additive: any board without rows here
-- still renders the legacy enum columns with no WIP limits.

CREATE TABLE IF NOT EXISTS kanban_board_columns (
  board_id INTEGER NOT NULL REFERENCES kanban_boards(id) ON DELETE CASCADE,
  column_name TEXT NOT NULL,
  label TEXT NOT NULL,
  position INTEGER NOT NULL,
  wip_limit INTEGER,
  PRIMARY KEY (board_id, column_name)
);

CREATE INDEX IF NOT EXISTS idx_kanban_board_columns_pos
  ON kanban_board_columns(board_id, position);

-- Seed every existing board with the canonical 6-column set. One INSERT
-- per column to stay under D1's SQLITE_LIMIT_COMPOUND_SELECT (which is
-- low enough that a 6-way UNION ALL inside a JOIN trips it).
-- INSERT OR IGNORE makes re-running the migration a no-op.
INSERT OR IGNORE INTO kanban_board_columns (board_id, column_name, label, position)
  SELECT id, 'not_started', 'Not Started', 0 FROM kanban_boards;
INSERT OR IGNORE INTO kanban_board_columns (board_id, column_name, label, position)
  SELECT id, 'started', 'Started', 1 FROM kanban_boards;
INSERT OR IGNORE INTO kanban_board_columns (board_id, column_name, label, position)
  SELECT id, 'blocked', 'Blocked', 2 FROM kanban_boards;
INSERT OR IGNORE INTO kanban_board_columns (board_id, column_name, label, position)
  SELECT id, 'ready', 'Ready', 3 FROM kanban_boards;
INSERT OR IGNORE INTO kanban_board_columns (board_id, column_name, label, position)
  SELECT id, 'approval', 'Approval', 4 FROM kanban_boards;
INSERT OR IGNORE INTO kanban_board_columns (board_id, column_name, label, position)
  SELECT id, 'done', 'Done', 5 FROM kanban_boards;
