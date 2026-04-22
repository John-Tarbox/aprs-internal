-- Per-card checklist items (S10).
--
-- One row per item; ordered within a card by `position` (dense int).
-- Cascade with the parent card on hard-delete.
--
-- For v1 the UI only edits body + completed_at toggle. due_date and
-- assignee_user_id are present in the schema so we don't need a follow-
-- up migration when the per-item editor lands. completed_at is nullable
-- (null = unchecked); checking sets to datetime('now').

CREATE TABLE IF NOT EXISTS kanban_card_checklist_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id INTEGER NOT NULL REFERENCES kanban_cards(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  body TEXT NOT NULL,
  completed_at TEXT,
  due_date TEXT,
  assignee_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_kanban_checklist_card_pos
  ON kanban_card_checklist_items(card_id, position);
