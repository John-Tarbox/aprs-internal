-- Card attachments (S11). Metadata only — file bytes live in R2 under
-- the key stored in `r2_key`. Cascade with the parent card on hard-
-- delete so we don't leave orphan rows pointing to removed cards;
-- archived cards retain their attachments. R2 objects don't auto-delete
-- when the row is removed — the delete route purges R2 and DB together.
--
-- size_bytes is enforced at the upload route (cap defined there); we
-- store it for display + reporting. content_type comes from the upload
-- and is what gets sent on download — we don't sniff or rewrite it.

CREATE TABLE IF NOT EXISTS kanban_card_attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id INTEGER NOT NULL REFERENCES kanban_cards(id) ON DELETE CASCADE,
  r2_key TEXT NOT NULL,
  original_name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  uploaded_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_kanban_card_attachments_card
  ON kanban_card_attachments(card_id, id);
