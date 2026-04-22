-- In-app notifications. One row per (recipient, event) so the unread badge
-- can be a fast SELECT COUNT(*) ... WHERE user_id = ? AND read_at IS NULL.
--
-- `kind` is a free string ('mention.comment', 'card.assigned', 'card.commented'
-- etc.) — same convention as kanban_card_events. New kinds don't need a
-- migration; the application validates shape.
--
-- card_id and comment_id are denormalized on the row so the dropdown can
-- link straight to the source without a JOIN. CASCADE on hard-delete so a
-- removed card doesn't leave orphan notifications pointing nowhere.
--
-- read_at is nullable; null = unread. Indexed first so the most common
-- query (unread count for current user) is index-only.

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  card_id INTEGER REFERENCES kanban_cards(id) ON DELETE CASCADE,
  comment_id INTEGER REFERENCES kanban_card_comments(id) ON DELETE CASCADE,
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  /** Free-form payload: e.g. card title snapshot, board slug for deep links. */
  metadata TEXT,
  read_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Unread count per user is the dominant query. Sort within the partial
-- index by id DESC for the dropdown's "newest first" rendering.
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread
  ON notifications(user_id, id DESC)
  WHERE read_at IS NULL;

-- Full inbox listing (read + unread).
CREATE INDEX IF NOT EXISTS idx_notifications_user_all
  ON notifications(user_id, id DESC);
