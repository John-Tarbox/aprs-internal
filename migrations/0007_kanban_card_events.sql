-- Per-card activity log. Append-only, one row per observable event on a
-- kanban card. FK to kanban_cards with CASCADE so a hard-deleted card
-- takes its history with it; archived cards retain their events because
-- archive is a status flip, not a delete.
--
-- `kind` is a free string (e.g. 'card.created', 'card.moved',
-- 'card.archived', later 'comment.created', 'assignee.added'). Not a CHECK
-- constraint so new event types can be added without a schema migration;
-- the application validates shape.
--
-- `metadata` is a JSON blob with event-specific payload — e.g. for
-- 'card.moved': {"fromColumn":"started","toColumn":"done","toPosition":0}.

CREATE TABLE IF NOT EXISTS kanban_card_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id INTEGER NOT NULL REFERENCES kanban_cards(id) ON DELETE CASCADE,
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  metadata TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Timeline queries are always scoped to one card, most-recent first.
CREATE INDEX IF NOT EXISTS idx_kanban_card_events_card_time
  ON kanban_card_events(card_id, id DESC);
