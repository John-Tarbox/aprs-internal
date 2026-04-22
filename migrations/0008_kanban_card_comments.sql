-- Comments on kanban cards. One row per comment; ordered chronologically
-- by id (which is monotonically increasing). Comments cascade with their
-- parent card on hard-delete; archived cards retain their thread.
--
-- `edited_at` stays null until the first edit, so the UI can render a
-- subtle "(edited)" indicator without needing to compare timestamps.
--
-- Body is stored as raw Markdown; the renderer (S2) handles formatting at
-- display time. Length cap is enforced at the WebSocket schema, not here,
-- so future relaxations don't need a migration.

CREATE TABLE IF NOT EXISTS kanban_card_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id INTEGER NOT NULL REFERENCES kanban_cards(id) ON DELETE CASCADE,
  author_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  edited_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Threads are always queried by card, ordered by time. Composite index on
-- (card_id, id) supports both ASC (oldest-first thread render) and DESC
-- (newest-first if we ever need it) without a second index.
CREATE INDEX IF NOT EXISTS idx_kanban_card_comments_card_id
  ON kanban_card_comments(card_id, id);
