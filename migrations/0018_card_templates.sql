-- Card templates (P5). A template is a JSON snapshot of the
-- user-editable card fields, scoped to a board. Anyone authenticated
-- can save / use; only the creator (or admin) can delete.
--
-- The payload is freeform JSON because the set of "templatable" card
-- fields will grow over time (custom fields, attachments-by-reference,
-- etc.) and we don't want a migration every time. The application
-- knows the shape:
--   { title, notes?, groups?: string[], assigneeUserIds?: number[],
--     dueOffsetDays?: number, dueTime?: string, startOffsetDays?: number,
--     coverColor?: string, checklist?: string[] }
--
-- Cascade with the parent board so a deleted board doesn't leave orphan
-- templates pointing nowhere.

CREATE TABLE IF NOT EXISTS kanban_card_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  board_id INTEGER NOT NULL REFERENCES kanban_boards(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_card_templates_board
  ON kanban_card_templates(board_id, name);
