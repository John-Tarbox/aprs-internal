-- Multi-assignee support: each card can be assigned to zero or more users.
-- Junction table; PK on (card_id, user_id) makes the assignment idempotent.
--
-- Cascade on both sides: deleting a card removes its assignments;
-- deleting a user removes them from all cards. (We don't currently delete
-- users — only deactivate — but the cascade is correct semantics.)
--
-- The legacy `assigned TEXT` column on kanban_cards stays in place as a
-- free-text fallback (e.g. for off-system collaborators or historical
-- data). The UI surfaces both.

CREATE TABLE IF NOT EXISTS kanban_card_assignees (
  card_id INTEGER NOT NULL REFERENCES kanban_cards(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assigned_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (card_id, user_id)
);

-- For "my cards" / "cards assigned to user X" queries (S13).
CREATE INDEX IF NOT EXISTS idx_kanban_card_assignees_user
  ON kanban_card_assignees(user_id);
