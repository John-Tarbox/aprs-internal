-- User-configurable colors at three levels: columns (per board, staff),
-- cards (per card, anyone), and groups (per board, staff).
--
-- All color values are stored as HTML hex strings ('#abc' or '#aabbcc')
-- or null = "use the default for this kind/key". Validation is at the
-- application layer; the schema accepts any TEXT for forward compat
-- (alpha hex, named colors, etc., if we ever want to support them).
--
-- A new kanban_groups table holds per-board group metadata (currently
-- just color, but the table will grow when we add description / aliasing
-- later). The existing kanban_card_groups junction continues to
-- reference groups by name — kanban_groups is a "definitions" table
-- that the join augments at read time. Backfill creates a row for
-- every distinct (board, group_name) pair already in use, so colors
-- can be set on existing labels without losing any cards' assignments.

ALTER TABLE kanban_board_columns ADD COLUMN color TEXT;
ALTER TABLE kanban_cards ADD COLUMN cover_color TEXT;

CREATE TABLE IF NOT EXISTS kanban_groups (
  board_id INTEGER NOT NULL REFERENCES kanban_boards(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT,
  PRIMARY KEY (board_id, name)
);

-- Backfill: one kanban_groups row per distinct (board, group_name) pair
-- currently in use across kanban_card_groups. INSERT OR IGNORE makes
-- this safe to re-run.
INSERT OR IGNORE INTO kanban_groups (board_id, name)
  SELECT DISTINCT c.board_id, g.group_name
  FROM kanban_card_groups g
  JOIN kanban_cards c ON c.id = g.card_id;
