-- Per-user card-view tracking, added 2026-05 to power the
-- "unread comments" indicator on board card tiles.
--
-- We track a single timestamp per (user, card) — the last time that user
-- opened the card detail modal. The unread predicate at read time is:
--
--   exists a comment on this card authored by someone other than this
--   user, with created_at > the user's last_viewed_at (or no view row).
--
-- This is intentionally card-level, not comment-level: the indicator is
-- a single dot on the tile, and the user clearing it always means "I've
-- now caught up on this card." A per-comment read table would be wasted
-- granularity.
--
-- Backfill marks every (user, card-with-comments) pair as already-seen
-- so day-one rollout doesn't show dots on every historically commented
-- card for every user. After this, only NEW comments produce dots.

CREATE TABLE IF NOT EXISTS kanban_card_views (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  card_id INTEGER NOT NULL REFERENCES kanban_cards(id) ON DELETE CASCADE,
  last_viewed_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, card_id)
);

INSERT OR IGNORE INTO kanban_card_views (user_id, card_id, last_viewed_at)
SELECT u.id, c.id, datetime('now')
FROM users u
CROSS JOIN kanban_cards c
WHERE EXISTS (SELECT 1 FROM kanban_card_comments cm WHERE cm.card_id = c.id);
