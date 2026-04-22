-- Multi-select Group field: cards can carry zero or more group labels.
-- Replaces the single `group_name TEXT` column with a junction table.
--
-- Backfill preserves every existing non-empty single-group value as one
-- row in the junction table, then drops the old column. Requires SQLite
-- 3.35+ (D1's runtime is well past that).

CREATE TABLE IF NOT EXISTS kanban_card_groups (
  card_id INTEGER NOT NULL REFERENCES kanban_cards(id) ON DELETE CASCADE,
  group_name TEXT NOT NULL,
  PRIMARY KEY (card_id, group_name)
);
CREATE INDEX IF NOT EXISTS idx_kanban_card_groups_name
  ON kanban_card_groups(group_name);

INSERT OR IGNORE INTO kanban_card_groups (card_id, group_name)
SELECT id, TRIM(group_name)
FROM kanban_cards
WHERE group_name IS NOT NULL AND TRIM(group_name) != '';

ALTER TABLE kanban_cards DROP COLUMN group_name;
