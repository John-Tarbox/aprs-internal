-- Parent-child relationships between kanban cards (added 2026-05).
--
-- A card may optionally point at another card on the SAME board as its
-- parent. Single-parent (1:N) tree, matching the standard Epic -> Story
-- -> Sub-task hierarchy. Same-board and acyclic invariants are enforced
-- at the application layer (SQLite can't express either as a CHECK).
--
-- ON DELETE SET NULL keeps orphaned children alive when a parent is
-- hard-deleted, mirroring how kanban_card_assignees etc. handle FK
-- removal. Archive (soft-delete) preserves parent_card_id untouched.

ALTER TABLE kanban_cards
  ADD COLUMN parent_card_id INTEGER REFERENCES kanban_cards(id) ON DELETE SET NULL;

-- Lookup by parent: "list this card's direct children" + the bulk
-- child-count rollup on every board snapshot. Partial index (WHERE NOT
-- NULL) keeps the index tiny for boards where most cards are top-level.
CREATE INDEX IF NOT EXISTS idx_kanban_cards_parent
  ON kanban_cards(parent_card_id)
  WHERE parent_card_id IS NOT NULL;
