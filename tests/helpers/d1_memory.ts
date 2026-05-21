/**
 * Focused in-memory D1 mock for service-layer tests. Intentionally
 * narrow: only handles the SQL that `moveCardToBoard` and its inline
 * helpers issue — adding tests for another service function may need
 * a few more handlers below.
 *
 * Why not better-sqlite3 or @cloudflare/vitest-pool-workers? Both add
 * native build steps that don't always work in the dev environment
 * here; a pattern-match mock keeps the test surface zero-dep and is
 * still useful as long as we keep the dispatch table honest.
 */

type Row = Record<string, unknown>;

/** Public state of the in-memory database. Tests seed these directly. */
export interface FakeDb {
  cards: Row[];
  boards: Row[];
  boardColumns: Row[]; // (board_id, column_name, label, position, wip_limit, color)
  cardGroups: Row[]; // (card_id, group_name)
  cardAssignees: Row[]; // (card_id, user_id)
  cardComments: Row[]; // (id, card_id, author_user_id, ...)
  users: Row[]; // (id, display_name, email, active)
  cardEvents: Row[]; // (card_id, actor_user_id, kind, metadata, created_at)
}

export function emptyDb(): FakeDb {
  return {
    cards: [],
    boards: [],
    boardColumns: [],
    cardGroups: [],
    cardAssignees: [],
    cardComments: [],
    users: [],
    cardEvents: [],
  };
}

/** A statement whose binds have been captured; calling first/all/run
 *  dispatches into the handler table. */
class FakeStatement {
  constructor(
    private readonly db: FakeDb,
    private readonly sql: string,
    private readonly binds: unknown[] = []
  ) {}

  bind(...values: unknown[]): FakeStatement {
    return new FakeStatement(this.db, this.sql, values);
  }

  async first<T = Row>(): Promise<T | null> {
    const r = dispatch(this.db, this.sql, this.binds);
    if (Array.isArray(r)) return (r[0] ? cloneRow(r[0]) : null) as T | null;
    return (r ? cloneRow(r as Row) : null) as T | null;
  }

  async all<T = Row>(): Promise<{ results: T[]; success: true; meta: Record<string, unknown> }> {
    const r = dispatch(this.db, this.sql, this.binds);
    const rows = Array.isArray(r) ? r : r ? [r as Row] : [];
    // Clone each row — real D1 returns plain JSON, never references
    // into the running store. Without this, callers can accidentally
    // mutate the source-of-truth (this bit a test during development).
    const results = rows.map((row) => cloneRow(row)) as T[];
    return { results, success: true, meta: {} };
  }

  async run(): Promise<{ success: true; meta: Record<string, unknown> }> {
    dispatch(this.db, this.sql, this.binds);
    return { success: true, meta: {} };
  }
}

export class FakeD1 {
  constructor(public state: FakeDb) {}

  prepare(sql: string): FakeStatement {
    return new FakeStatement(this.state, sql);
  }

  async batch(stmts: FakeStatement[]): Promise<unknown[]> {
    // D1's batch runs statements sequentially under the hood; mirror
    // that here. Failures don't trigger rollback in our mock — tests
    // either succeed on the happy path or short-circuit before batch.
    const results: unknown[] = [];
    for (const s of stmts) {
      results.push(await s.run());
    }
    return results;
  }
}

/** Normalize SQL for matching: collapse whitespace, trim. */
function norm(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

/** SQL dispatch table — keep handlers in execution order of the
 *  function under test so it's obvious which query each one serves. */
function dispatch(db: FakeDb, rawSql: string, binds: unknown[]): Row | Row[] | null {
  const sql = norm(rawSql);

  // === moveCardToBoard direct queries ===

  // Initial card load.
  if (
    sql.startsWith(
      'SELECT board_id, column_name, position, version, parent_card_id, archived_at FROM kanban_cards WHERE id = ?'
    )
  ) {
    const id = binds[0] as number;
    return findCard(db, id);
  }

  // Target board existence check.
  if (sql === 'SELECT id FROM kanban_boards WHERE id = ?') {
    const id = binds[0] as number;
    const b = db.boards.find((r) => r.id === id);
    return b ? { id: b.id } : null;
  }

  // columnExists.
  if (
    sql.startsWith(
      'SELECT 1 as ok FROM kanban_board_columns WHERE board_id = ? AND column_name = ?'
    )
  ) {
    const [boardId, col] = binds as [number, string];
    const found = db.boardColumns.some(
      (r) => r.board_id === boardId && r.column_name === col
    );
    return found ? { ok: 1 } : null;
  }

  // Child count.
  if (
    sql.startsWith(
      'SELECT COUNT(*) AS n FROM kanban_cards WHERE parent_card_id = ? AND archived_at IS NULL'
    )
  ) {
    const parentId = binds[0] as number;
    const n = db.cards.filter(
      (r) => r.parent_card_id === parentId && r.archived_at == null
    ).length;
    return { n };
  }

  // Label names on the card.
  if (sql === 'SELECT group_name FROM kanban_card_groups WHERE card_id = ?') {
    const cardId = binds[0] as number;
    return db.cardGroups
      .filter((r) => r.card_id === cardId)
      .map((r) => ({ group_name: r.group_name }));
  }

  // The big UPDATE: move card across boards.
  if (
    sql.startsWith(
      "UPDATE kanban_cards SET board_id = ?, column_name = ?, position = ( SELECT COALESCE(MAX(position), -1) + 1 FROM kanban_cards WHERE board_id = ? AND column_name = ? AND archived_at IS NULL ), parent_card_id = NULL, version = version + 1"
    )
  ) {
    const [
      targetBoardId,
      targetCol,
      _selBoardId, // duplicate bind for the subselect
      _selCol,
      userId,
      cardId,
      expectedVersion,
    ] = binds as [number, string, number, string, number | null, number, number];
    const card = db.cards.find((r) => r.id === cardId && r.version === expectedVersion);
    if (!card) return null;
    const maxPos = db.cards
      .filter(
        (r) => r.board_id === targetBoardId && r.column_name === targetCol && r.archived_at == null
      )
      .reduce((acc, r) => Math.max(acc, r.position as number), -1);
    card.board_id = targetBoardId;
    card.column_name = targetCol;
    card.position = maxPos + 1;
    card.parent_card_id = null;
    card.version = (card.version as number) + 1;
    card.updated_at = new Date().toISOString();
    card.updated_by_user_id = userId;
    return card;
  }

  // Drop label memberships.
  if (sql === 'DELETE FROM kanban_card_groups WHERE card_id = ?') {
    const cardId = binds[0] as number;
    db.cardGroups = db.cardGroups.filter((r) => r.card_id !== cardId);
    return null;
  }

  // Dense-shift source column.
  if (
    sql.startsWith(
      'UPDATE kanban_cards SET position = position - 1 WHERE board_id = ? AND column_name = ? AND archived_at IS NULL AND position > ?'
    )
  ) {
    const [boardId, col, gtPos] = binds as [number, string, number];
    for (const r of db.cards) {
      if (
        r.board_id === boardId &&
        r.column_name === col &&
        r.archived_at == null &&
        (r.position as number) > gtPos
      ) {
        r.position = (r.position as number) - 1;
      }
    }
    return null;
  }

  // Reload the card after the move.
  if (sql === 'SELECT * FROM kanban_cards WHERE id = ?') {
    const id = binds[0] as number;
    return findCard(db, id);
  }

  // Affected-positions snapshot (source or dest column).
  if (
    sql.startsWith(
      'SELECT id, column_name, position, version FROM kanban_cards WHERE board_id = ? AND column_name = ? AND archived_at IS NULL'
    )
  ) {
    const [boardId, col] = binds as [number, string];
    return db.cards
      .filter((r) => r.board_id === boardId && r.column_name === col && r.archived_at == null)
      .map((r) => ({
        id: r.id,
        column_name: r.column_name,
        position: r.position,
        version: r.version,
      }));
  }

  // === loadAssigneesForCards (called via loadAssigneesForCard for single id) ===
  // Pattern: SELECT a.card_id, a.user_id, u.display_name, u.email FROM kanban_card_assignees a JOIN users u ON u.id = a.user_id WHERE a.card_id IN (?) ORDER BY ...
  if (
    /^SELECT a\.card_id, a\.user_id, u\.display_name, u\.email FROM kanban_card_assignees a JOIN users u/i.test(
      sql
    )
  ) {
    const cardIds = binds as number[];
    return db.cardAssignees
      .filter((r) => cardIds.includes(r.card_id as number))
      .map((a) => {
        const u = db.users.find((uu) => uu.id === a.user_id);
        return {
          card_id: a.card_id,
          user_id: a.user_id,
          display_name: u?.display_name ?? null,
          email: u?.email ?? '',
        };
      });
  }

  // === loadCommentCountForCard ===
  if (
    sql === 'SELECT COUNT(*) AS n FROM kanban_card_comments WHERE card_id = ?'
  ) {
    const cardId = binds[0] as number;
    const n = db.cardComments.filter((r) => r.card_id === cardId).length;
    return { n };
  }

  // === logCardEvent — INSERT INTO kanban_card_events ===
  // Used by emitCardEvent inside the DO, not by the service we test
  // directly, but tests that exercise the DO path would hit this.
  if (/^INSERT INTO kanban_card_events/i.test(sql)) {
    const [cardId, actorUserId, kind, metadata] = binds as [
      number,
      number | null,
      string,
      string | null,
    ];
    const row: Row = {
      id: db.cardEvents.length + 1,
      card_id: cardId,
      actor_user_id: actorUserId,
      kind,
      metadata,
      created_at: new Date().toISOString(),
    };
    db.cardEvents.push(row);
    return row;
  }

  // Unhandled query — make the test fail loudly so we know to add a handler.
  throw new Error(`d1_memory: unhandled SQL\n  ${sql}\n  binds=${JSON.stringify(binds)}`);
}

function findCard(db: FakeDb, id: number): Row | null {
  return db.cards.find((r) => r.id === id) ?? null;
}

/** Shallow-copy a row so callers can't mutate the live store. Real
 *  D1 returns plain JSON over the wire; this matches that contract. */
function cloneRow(r: Row): Row {
  return { ...r };
}

// ── Factory helpers for tests ──────────────────────────────────────────

let nextCardId = 1;
let nextBoardId = 1;

export function resetIdCounters(): void {
  nextCardId = 1;
  nextBoardId = 1;
}

export function makeBoard(db: FakeDb, opts: { name: string; slug?: string }): Row {
  const id = nextBoardId++;
  const b: Row = {
    id,
    name: opts.name,
    slug: opts.slug ?? opts.name.toLowerCase().replace(/\s+/g, '-'),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  db.boards.push(b);
  // Seed canonical 6 columns so columnExists works without per-test setup.
  const canonical: Array<[string, string, number]> = [
    ['not_started', 'Not Started', 0],
    ['started', 'Started', 1],
    ['blocked', 'Blocked', 2],
    ['ready', 'Ready', 3],
    ['approval', 'Approval', 4],
    ['done', 'Done', 5],
  ];
  for (const [key, label, position] of canonical) {
    db.boardColumns.push({
      board_id: id,
      column_name: key,
      label,
      position,
      wip_limit: null,
      color: null,
    });
  }
  return b;
}

export function makeCard(
  db: FakeDb,
  opts: {
    boardId: number;
    column?: string;
    title?: string;
    position?: number;
    parentCardId?: number | null;
    archived?: boolean;
    version?: number;
  }
): Row {
  const id = nextCardId++;
  const card: Row = {
    id,
    board_id: opts.boardId,
    column_name: opts.column ?? 'not_started',
    position: opts.position ?? db.cards.filter(
      (c) => c.board_id === opts.boardId && c.column_name === (opts.column ?? 'not_started') && c.archived_at == null
    ).length,
    title: opts.title ?? `Card ${id}`,
    assigned: null,
    notes: null,
    start_date: null,
    due_date: null,
    due_time: null,
    cover_color: null,
    archived_at: opts.archived ? new Date().toISOString() : null,
    parent_card_id: opts.parentCardId ?? null,
    version: opts.version ?? 1,
    created_by_user_id: null,
    updated_by_user_id: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  db.cards.push(card);
  return card;
}

export function attachLabel(db: FakeDb, cardId: number, groupName: string): void {
  db.cardGroups.push({ card_id: cardId, group_name: groupName });
}
