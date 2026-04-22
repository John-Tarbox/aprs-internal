-- Add start date and due-date time-of-day to kanban cards.
--
-- start_date is YYYY-MM-DD (or null) — paired with due_date to enable the
-- Timeline/Gantt view (S17) and proper sprint planning. Cards without a
-- start date fall back to "due-date only" rendering everywhere.
--
-- due_time is HH:MM in 24-hour format (or null). Stored separately from
-- due_date so the existing date-only model keeps working unchanged when
-- no time is set; we never have to handle "midnight in some timezone"
-- ambiguity for the common case. When both are set the UI renders them
-- joined.

ALTER TABLE kanban_cards ADD COLUMN start_date TEXT;
ALTER TABLE kanban_cards ADD COLUMN due_time TEXT;
