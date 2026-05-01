-- Helper indexes for the label-manager UI added 2026-05.
--
-- 1. NOCASE unique index on (board_id, name) so the application layer can
--    safely run "does a label with this name already exist on this board?"
--    lookups without case-sensitive duplicates ("Urgent" vs "urgent").
-- 2. Lookup index on the junction's group_name so renames and deletes,
--    which scan kanban_card_groups by group_name, don't need full scans.
--
-- Neither table grows in size; this migration is index-only.

CREATE UNIQUE INDEX IF NOT EXISTS idx_kanban_groups_board_name_nocase
  ON kanban_groups(board_id, name COLLATE NOCASE);

CREATE INDEX IF NOT EXISTS idx_kanban_card_groups_name
  ON kanban_card_groups(group_name);
