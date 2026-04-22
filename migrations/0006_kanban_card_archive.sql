-- Soft-delete (archive) for kanban cards.
--
-- Archived cards are hidden from board views but retain their full row and
-- history. Positions in the card's column close when it is archived (so the
-- visible stack stays dense) and the card returns to the end of its original
-- column when unarchived. Archived rows keep position = -1 as a sentinel so
-- the dense-position invariant among non-archived cards is unambiguous.
--
-- Why keep archived_at nullable rather than a boolean: we can later order
-- archived cards by recency without a second column.

ALTER TABLE kanban_cards ADD COLUMN archived_at TEXT;

-- Indexes to support the two dominant queries:
--   (1) active cards per board+column, ordered by position (board render)
--   (2) archived cards per board, ordered by archived_at (archive drawer)
-- The existing idx_kanban_cards_board_col_pos covers (1) fine; SQLite will
-- use it with the AND archived_at IS NULL predicate. For (2), a dedicated
-- partial index keeps the archive drawer fast even with large boards.
CREATE INDEX IF NOT EXISTS idx_kanban_cards_archived
  ON kanban_cards(board_id, archived_at)
  WHERE archived_at IS NOT NULL;
