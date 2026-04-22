/**
 * Data export aggregator (P6) — pulls every relevant table into a
 * record of named JSON blobs. Intended for the admin-only ZIP route;
 * the route wraps the output with the tiny zip encoder in util/zip.ts.
 *
 * Attachment R2 bytes are NOT included (the metadata pointer is, with
 * a note in the README on how to fetch each file). Including bytes
 * could balloon the ZIP arbitrarily; admins who need the bytes can
 * iterate the metadata + hit /kanban/attachment/<id> per row.
 */

export interface ExportBundle {
  /** YYYY-MM-DDTHH:mm:ssZ timestamp the snapshot was taken. */
  generatedAt: string;
  files: Array<{ name: string; bytes: string }>;
}

async function dumpAll<T>(db: D1Database, sql: string): Promise<T[]> {
  const res = await db.prepare(sql).all<T>();
  return res.results ?? [];
}

export async function buildExportBundle(db: D1Database): Promise<ExportBundle> {
  // One pass per table — D1 caps query result sizes but our datasets
  // are well below the threshold for an internal tool. If we ever
  // grow past it, paginate here.
  const [
    boards,
    columns,
    cards,
    cardGroups,
    cardAssignees,
    comments,
    events,
    checklists,
    attachments,
    groups,
    notifications,
    savedFilters,
    cardTemplates,
    users,
  ] = await Promise.all([
    dumpAll<unknown>(db, `SELECT * FROM kanban_boards`),
    dumpAll<unknown>(db, `SELECT * FROM kanban_board_columns`),
    dumpAll<unknown>(db, `SELECT * FROM kanban_cards`),
    dumpAll<unknown>(db, `SELECT * FROM kanban_card_groups`),
    dumpAll<unknown>(db, `SELECT * FROM kanban_card_assignees`),
    dumpAll<unknown>(db, `SELECT * FROM kanban_card_comments`),
    dumpAll<unknown>(db, `SELECT * FROM kanban_card_events`),
    dumpAll<unknown>(db, `SELECT * FROM kanban_card_checklist_items`),
    dumpAll<unknown>(db, `SELECT * FROM kanban_card_attachments`),
    dumpAll<unknown>(db, `SELECT * FROM kanban_groups`),
    dumpAll<unknown>(db, `SELECT * FROM notifications`),
    dumpAll<unknown>(db, `SELECT * FROM kanban_saved_filters`),
    dumpAll<unknown>(db, `SELECT * FROM kanban_card_templates`),
    // Users projection — strip nothing-secret-but-noisy fields like
    // last_login IPs (which aren't in this table anyway) and keep
    // everything that's useful for re-import.
    dumpAll<unknown>(db, `SELECT id, email, auth_type, display_name, active, created_at, last_login_at, invited_by_user_id FROM users`),
  ]);

  const generatedAt = new Date().toISOString();

  // Count rows for the README.
  const counts = {
    boards: boards.length,
    columns: columns.length,
    cards: cards.length,
    cardGroups: cardGroups.length,
    cardAssignees: cardAssignees.length,
    comments: comments.length,
    events: events.length,
    checklists: checklists.length,
    attachments: attachments.length,
    groups: groups.length,
    notifications: notifications.length,
    savedFilters: savedFilters.length,
    cardTemplates: cardTemplates.length,
    users: users.length,
  };

  const readme = [
    `APRS Internal — Kanban data export`,
    `Generated: ${generatedAt}`,
    ``,
    `Row counts:`,
    ...Object.entries(counts).map(([k, v]) => `  ${k.padEnd(18)} ${v}`),
    ``,
    `Files:`,
    `  boards.json              kanban_boards rows`,
    `  columns.json             kanban_board_columns rows`,
    `  cards.json               kanban_cards rows (active + archived)`,
    `  card_groups.json         kanban_card_groups junction rows`,
    `  card_assignees.json      kanban_card_assignees junction rows`,
    `  comments.json            kanban_card_comments rows`,
    `  events.json              kanban_card_events activity-log rows`,
    `  checklists.json          kanban_card_checklist_items rows`,
    `  attachments.json         kanban_card_attachments METADATA only — file bytes`,
    `                           are in R2 under r2_key; fetch via`,
    `                           /kanban/attachment/<id> while signed in.`,
    `  groups.json              kanban_groups (per-board label color metadata)`,
    `  notifications.json       notifications rows`,
    `  saved_filters.json       kanban_saved_filters rows`,
    `  card_templates.json      kanban_card_templates rows`,
    `  users.json               public projection of users (no auth secrets)`,
    ``,
    `Notes:`,
    `  - All timestamps are in the format SQLite's datetime('now') produces:`,
    `    "YYYY-MM-DD HH:MM:SS" in UTC, no trailing Z. Parse as UTC.`,
    `  - column_name on kanban_cards is a free string; the canonical`,
    `    set per board lives in columns.json (kanban_board_columns).`,
    `  - This export does NOT include R2 attachment bytes.`,
    ``,
  ].join('\n');

  return {
    generatedAt,
    files: [
      { name: 'README.txt', bytes: readme },
      { name: 'boards.json', bytes: JSON.stringify(boards, null, 2) },
      { name: 'columns.json', bytes: JSON.stringify(columns, null, 2) },
      { name: 'cards.json', bytes: JSON.stringify(cards, null, 2) },
      { name: 'card_groups.json', bytes: JSON.stringify(cardGroups, null, 2) },
      { name: 'card_assignees.json', bytes: JSON.stringify(cardAssignees, null, 2) },
      { name: 'comments.json', bytes: JSON.stringify(comments, null, 2) },
      { name: 'events.json', bytes: JSON.stringify(events, null, 2) },
      { name: 'checklists.json', bytes: JSON.stringify(checklists, null, 2) },
      { name: 'attachments.json', bytes: JSON.stringify(attachments, null, 2) },
      { name: 'groups.json', bytes: JSON.stringify(groups, null, 2) },
      { name: 'notifications.json', bytes: JSON.stringify(notifications, null, 2) },
      { name: 'saved_filters.json', bytes: JSON.stringify(savedFilters, null, 2) },
      { name: 'card_templates.json', bytes: JSON.stringify(cardTemplates, null, 2) },
      { name: 'users.json', bytes: JSON.stringify(users, null, 2) },
    ],
  };
}

