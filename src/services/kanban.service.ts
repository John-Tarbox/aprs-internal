/**
 * Kanban persistence. Multiple boards; each card belongs to exactly one
 * board via board_id. Columns are a fixed enum, and card order within a
 * (board, column) pair is a dense integer `position`.
 *
 * Concurrency model: every card carries a `version` column. Updates/moves/
 * deletes are gated on the caller's expected version, so conflicting writes
 * from two editors return a signalled failure (null / false) that the caller
 * turns into a WebSocket `nack { reason: 'version_conflict' }`.
 *
 * Atomicity: move/delete reshape positions across multiple rows. Those are
 * issued as a single `db.batch([...])` so partial application is impossible.
 * Cross-request races are prevented by the KanbanBoardDO isolate, which
 * serializes every webSocketMessage call — and there is one DO instance
 * per board, so serialization is also per-board.
 */
export const KANBAN_COLUMNS = [
  'not_started',
  'started',
  'blocked',
  'ready',
  'approval',
  'done',
] as const;

export type ColumnName = (typeof KANBAN_COLUMNS)[number];

export function isColumnName(v: unknown): v is ColumnName {
  return typeof v === 'string' && (KANBAN_COLUMNS as readonly string[]).includes(v);
}

// ── Board DTO + CRUD ────────────────────────────────────────────────────

export interface BoardDto {
  id: number;
  name: string;
  slug: string;
  createdByUserId: number | null;
  createdAt: string;
  updatedAt: string;
}

interface RawBoardRow {
  id: number;
  name: string;
  slug: string;
  created_by_user_id: number | null;
  created_at: string;
  updated_at: string;
}

function hydrateBoard(row: RawBoardRow): BoardDto {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listBoards(db: D1Database): Promise<BoardDto[]> {
  const res = await db
    .prepare(`SELECT * FROM kanban_boards ORDER BY id ASC`)
    .all<RawBoardRow>();
  return (res.results ?? []).map(hydrateBoard);
}

export async function getBoardById(
  db: D1Database,
  id: number
): Promise<BoardDto | null> {
  const row = await db
    .prepare(`SELECT * FROM kanban_boards WHERE id = ?`)
    .bind(id)
    .first<RawBoardRow>();
  return row ? hydrateBoard(row) : null;
}

export async function getBoardBySlug(
  db: D1Database,
  slug: string
): Promise<BoardDto | null> {
  const row = await db
    .prepare(`SELECT * FROM kanban_boards WHERE slug = ? COLLATE NOCASE`)
    .bind(slug)
    .first<RawBoardRow>();
  return row ? hydrateBoard(row) : null;
}

/** Produce a URL-safe slug from a name. Returns null for empty/ungenerable. */
export function slugify(input: string): string | null {
  const s = input
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s.length > 0 ? s.slice(0, 60) : null;
}

export interface CreateBoardInput {
  name: string;
  slug?: string;
}

export async function createBoard(
  db: D1Database,
  input: CreateBoardInput,
  userId: number | null
): Promise<BoardDto> {
  const name = input.name.trim();
  if (!name) throw new Error('Board name is required');
  const slug = (input.slug ? slugify(input.slug) : null) ?? slugify(name);
  if (!slug) throw new Error('Could not derive a valid slug from the name');

  const row = await db
    .prepare(
      `INSERT INTO kanban_boards (name, slug, created_by_user_id)
       VALUES (?, ?, ?)
       RETURNING *`
    )
    .bind(name, slug, userId)
    .first<RawBoardRow>();
  if (!row) throw new Error('Failed to insert board');
  return hydrateBoard(row);
}

export async function renameBoard(
  db: D1Database,
  id: number,
  newName: string
): Promise<BoardDto | null> {
  const name = newName.trim();
  if (!name) throw new Error('Board name is required');
  const row = await db
    .prepare(
      `UPDATE kanban_boards SET name = ?, updated_at = datetime('now')
       WHERE id = ? RETURNING *`
    )
    .bind(name, id)
    .first<RawBoardRow>();
  return row ? hydrateBoard(row) : null;
}

export async function deleteBoard(db: D1Database, id: number): Promise<boolean> {
  const res = await db
    .prepare(`DELETE FROM kanban_boards WHERE id = ?`)
    .bind(id)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

// ── Card DTO ────────────────────────────────────────────────────────────

export interface CardDto {
  id: number;
  boardId: number;
  column: ColumnName;
  position: number;
  title: string;
  /** Zero or more group labels. Always an array; empty when unset. */
  groups: string[];
  assigned: string | null;
  notes: string | null;
  dueDate: string | null;
  version: number;
  createdByUserId: number | null;
  updatedByUserId: number | null;
  createdAt: string;
  updatedAt: string;
}

interface RawCardRow {
  id: number;
  board_id: number;
  column_name: ColumnName;
  position: number;
  title: string;
  assigned: string | null;
  notes: string | null;
  due_date: string | null;
  version: number;
  created_by_user_id: number | null;
  updated_by_user_id: number | null;
  created_at: string;
  updated_at: string;
}

function hydrateCard(row: RawCardRow, groups: string[]): CardDto {
  return {
    id: row.id,
    boardId: row.board_id,
    column: row.column_name,
    position: row.position,
    title: row.title,
    groups,
    assigned: row.assigned,
    notes: row.notes,
    dueDate: row.due_date,
    version: row.version,
    createdByUserId: row.created_by_user_id,
    updatedByUserId: row.updated_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Fetch groups for a set of card ids in one query; returns a map cardId -> groups[]. */
async function loadGroupsForCards(
  db: D1Database,
  cardIds: number[]
): Promise<Map<number, string[]>> {
  const map = new Map<number, string[]>();
  if (cardIds.length === 0) return map;
  const placeholders = cardIds.map(() => '?').join(',');
  const res = await db
    .prepare(
      `SELECT card_id, group_name FROM kanban_card_groups
       WHERE card_id IN (${placeholders})
       ORDER BY card_id ASC, group_name ASC`
    )
    .bind(...cardIds)
    .all<{ card_id: number; group_name: string }>();
  for (const row of res.results ?? []) {
    const list = map.get(row.card_id);
    if (list) list.push(row.group_name);
    else map.set(row.card_id, [row.group_name]);
  }
  return map;
}

async function loadGroupsForCard(db: D1Database, cardId: number): Promise<string[]> {
  const map = await loadGroupsForCards(db, [cardId]);
  return map.get(cardId) ?? [];
}

/** Deduplicate + trim + drop empties, preserving first-seen casing. */
function normalizeGroups(raw: string[] | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of raw) {
    const t = typeof v === 'string' ? v.trim() : '';
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

/** Distinct group names ever used (across all boards), sorted alphabetically. */
export async function listDistinctGroupNames(db: D1Database): Promise<string[]> {
  const res = await db
    .prepare(
      `SELECT DISTINCT group_name FROM kanban_card_groups ORDER BY group_name ASC`
    )
    .all<{ group_name: string }>();
  return (res.results ?? []).map((r) => r.group_name);
}

/**
 * Count cards per column. Every column is present in the result, zero-filled.
 * When `boardId` is omitted, aggregates across every board (the home tile's
 * total-across-all-boards view). When provided, scopes to that board only.
 */
export async function getColumnCounts(
  db: D1Database,
  boardId?: number
): Promise<Record<ColumnName, number>> {
  const zeroed = KANBAN_COLUMNS.reduce(
    (acc, col) => {
      acc[col] = 0;
      return acc;
    },
    {} as Record<ColumnName, number>
  );
  const res = boardId === undefined
    ? await db
        .prepare(`SELECT column_name, COUNT(*) as c FROM kanban_cards GROUP BY column_name`)
        .all<{ column_name: ColumnName; c: number }>()
    : await db
        .prepare(
          `SELECT column_name, COUNT(*) as c FROM kanban_cards
           WHERE board_id = ? GROUP BY column_name`
        )
        .bind(boardId)
        .all<{ column_name: ColumnName; c: number }>();
  for (const row of res.results ?? []) {
    if (row.column_name in zeroed) zeroed[row.column_name] = row.c;
  }
  return zeroed;
}

export async function listCards(
  db: D1Database,
  boardId: number
): Promise<CardDto[]> {
  const res = await db
    .prepare(
      `SELECT * FROM kanban_cards WHERE board_id = ?
       ORDER BY column_name ASC, position ASC, id ASC`
    )
    .bind(boardId)
    .all<RawCardRow>();
  const rows = res.results ?? [];
  const groups = await loadGroupsForCards(db, rows.map((r) => r.id));
  return rows.map((r) => hydrateCard(r, groups.get(r.id) ?? []));
}

export interface CreateCardInput {
  column: ColumnName;
  title: string;
  groups?: string[];
  assigned?: string | null;
  notes?: string | null;
  dueDate?: string | null;
}

export async function createCard(
  db: D1Database,
  boardId: number,
  input: CreateCardInput,
  userId: number | null
): Promise<CardDto> {
  const groups = normalizeGroups(input.groups);
  // Append to the end of the target column on this board.
  const row = await db
    .prepare(
      `INSERT INTO kanban_cards
         (board_id, column_name, position, title, assigned, notes, due_date,
          created_by_user_id, updated_by_user_id)
       VALUES (
         ?,
         ?,
         (SELECT COALESCE(MAX(position), -1) + 1 FROM kanban_cards
           WHERE board_id = ? AND column_name = ?),
         ?, ?, ?, ?, ?, ?
       )
       RETURNING *`
    )
    .bind(
      boardId,
      input.column,
      boardId,
      input.column,
      input.title,
      input.assigned ?? null,
      input.notes ?? null,
      input.dueDate ?? null,
      userId,
      userId
    )
    .first<RawCardRow>();

  if (!row) throw new Error('Failed to insert kanban card');
  if (groups.length > 0) {
    await db.batch(
      groups.map((g) =>
        db
          .prepare(
            `INSERT OR IGNORE INTO kanban_card_groups (card_id, group_name) VALUES (?, ?)`
          )
          .bind(row.id, g)
      )
    );
  }
  return hydrateCard(row, groups);
}

export interface UpdateCardPatch {
  title?: string;
  /** Undefined = don't touch groups. Array = replace the whole set (empty = remove all). */
  groups?: string[];
  assigned?: string | null;
  notes?: string | null;
  dueDate?: string | null;
}

/** Returns the updated card, or null on version conflict / not found. */
export async function updateCard(
  db: D1Database,
  id: number,
  expectedVersion: number,
  patch: UpdateCardPatch,
  userId: number | null
): Promise<CardDto | null> {
  const sets: string[] = [];
  const binds: Array<string | number | null> = [];

  if (patch.title !== undefined) {
    sets.push('title = ?');
    binds.push(patch.title);
  }
  if (patch.assigned !== undefined) {
    sets.push('assigned = ?');
    binds.push(patch.assigned ?? null);
  }
  if (patch.notes !== undefined) {
    sets.push('notes = ?');
    binds.push(patch.notes ?? null);
  }
  if (patch.dueDate !== undefined) {
    sets.push('due_date = ?');
    binds.push(patch.dueDate ?? null);
  }

  const normalizedGroups =
    patch.groups !== undefined ? normalizeGroups(patch.groups) : undefined;

  // If nothing would change at all (no columns + no groups touched), return
  // the current row at the expected version.
  if (sets.length === 0 && normalizedGroups === undefined) {
    const row = await db
      .prepare(`SELECT * FROM kanban_cards WHERE id = ? AND version = ?`)
      .bind(id, expectedVersion)
      .first<RawCardRow>();
    if (!row) return null;
    return hydrateCard(row, await loadGroupsForCard(db, id));
  }

  // Always bump version/updated_at when groups are touched, even if no scalar
  // column changed — callers rely on a version increment after any edit.
  sets.push('version = version + 1');
  sets.push(`updated_at = datetime('now')`);
  sets.push('updated_by_user_id = ?');
  binds.push(userId);
  binds.push(id);
  binds.push(expectedVersion);

  const row = await db
    .prepare(
      `UPDATE kanban_cards SET ${sets.join(', ')}
       WHERE id = ? AND version = ?
       RETURNING *`
    )
    .bind(...binds)
    .first<RawCardRow>();

  if (!row) return null;

  if (normalizedGroups !== undefined) {
    const stmts = [
      db.prepare(`DELETE FROM kanban_card_groups WHERE card_id = ?`).bind(id),
      ...normalizedGroups.map((g) =>
        db
          .prepare(
            `INSERT OR IGNORE INTO kanban_card_groups (card_id, group_name) VALUES (?, ?)`
          )
          .bind(id, g)
      ),
    ];
    await db.batch(stmts);
  }

  const finalGroups =
    normalizedGroups !== undefined
      ? normalizedGroups
      : await loadGroupsForCard(db, id);
  return hydrateCard(row, finalGroups);
}

export interface AffectedPosition {
  id: number;
  column: ColumnName;
  position: number;
  version: number;
}

export interface MoveResult {
  card: CardDto;
  affected: AffectedPosition[];
  fromColumn: ColumnName;
  toColumn: ColumnName;
}

/**
 * Move a card to (toColumn, toPosition). Renumbers positions within the
 * card's board in the source and target columns so they stay dense.
 *
 * Returns null if the card doesn't exist or the caller's version is stale.
 * On success, `affected` contains every card in the touched column(s) with
 * their post-move position and version — the client uses this to re-render
 * those columns from server-authoritative state.
 */
export async function moveCard(
  db: D1Database,
  id: number,
  expectedVersion: number,
  toColumn: ColumnName,
  toPosition: number,
  userId: number | null
): Promise<MoveResult | null> {
  const current = await db
    .prepare(
      `SELECT board_id, column_name, position, version FROM kanban_cards WHERE id = ?`
    )
    .bind(id)
    .first<{ board_id: number; column_name: ColumnName; position: number; version: number }>();
  if (!current) return null;
  if (current.version !== expectedVersion) return null;

  const boardId = current.board_id;
  const fromColumn = current.column_name;
  const fromPosition = current.position;

  // Clamp toPosition into the valid range for the destination (board, column).
  const countRow = await db
    .prepare(
      `SELECT COUNT(*) as c FROM kanban_cards WHERE board_id = ? AND column_name = ?`
    )
    .bind(boardId, toColumn)
    .first<{ c: number }>();
  const targetCount = countRow?.c ?? 0;
  const maxPos = fromColumn === toColumn ? targetCount - 1 : targetCount;
  const effectiveToPos = Math.max(0, Math.min(Math.floor(toPosition), maxPos));

  const stmts = [];

  if (fromColumn === toColumn) {
    if (effectiveToPos === fromPosition) {
      // No-op. Still bump version + updated_at so clients observe a coherent
      // state (and so the caller's optimistic move is acked).
      stmts.push(
        db
          .prepare(
            `UPDATE kanban_cards
             SET version = version + 1, updated_at = datetime('now'), updated_by_user_id = ?
             WHERE id = ? AND version = ?`
          )
          .bind(userId, id, expectedVersion)
      );
    } else if (effectiveToPos > fromPosition) {
      stmts.push(
        db
          .prepare(
            `UPDATE kanban_cards SET position = position - 1
             WHERE board_id = ? AND column_name = ? AND position > ? AND position <= ?`
          )
          .bind(boardId, fromColumn, fromPosition, effectiveToPos)
      );
      stmts.push(
        db
          .prepare(
            `UPDATE kanban_cards
             SET column_name = ?, position = ?, version = version + 1,
                 updated_at = datetime('now'), updated_by_user_id = ?
             WHERE id = ? AND version = ?`
          )
          .bind(toColumn, effectiveToPos, userId, id, expectedVersion)
      );
    } else {
      stmts.push(
        db
          .prepare(
            `UPDATE kanban_cards SET position = position + 1
             WHERE board_id = ? AND column_name = ? AND position >= ? AND position < ?`
          )
          .bind(boardId, fromColumn, effectiveToPos, fromPosition)
      );
      stmts.push(
        db
          .prepare(
            `UPDATE kanban_cards
             SET column_name = ?, position = ?, version = version + 1,
                 updated_at = datetime('now'), updated_by_user_id = ?
             WHERE id = ? AND version = ?`
          )
          .bind(toColumn, effectiveToPos, userId, id, expectedVersion)
      );
    }
  } else {
    // Cross-column: close gap in source, open gap in target, then relocate.
    // Both writes are scoped to this board.
    stmts.push(
      db
        .prepare(
          `UPDATE kanban_cards SET position = position - 1
           WHERE board_id = ? AND column_name = ? AND position > ?`
        )
        .bind(boardId, fromColumn, fromPosition)
    );
    stmts.push(
      db
        .prepare(
          `UPDATE kanban_cards SET position = position + 1
           WHERE board_id = ? AND column_name = ? AND position >= ?`
        )
        .bind(boardId, toColumn, effectiveToPos)
    );
    stmts.push(
      db
        .prepare(
          `UPDATE kanban_cards
           SET column_name = ?, position = ?, version = version + 1,
               updated_at = datetime('now'), updated_by_user_id = ?
           WHERE id = ? AND version = ?`
        )
        .bind(toColumn, effectiveToPos, userId, id, expectedVersion)
    );
  }

  await db.batch(stmts);

  const movedRow = await db
    .prepare(`SELECT * FROM kanban_cards WHERE id = ?`)
    .bind(id)
    .first<RawCardRow>();
  if (!movedRow) return null;

  const affectedCols: ColumnName[] =
    fromColumn === toColumn ? [fromColumn] : [fromColumn, toColumn];
  const affectedRows = await db
    .prepare(
      `SELECT id, column_name, position, version FROM kanban_cards
       WHERE board_id = ? AND column_name IN (${affectedCols.map(() => '?').join(',')})`
    )
    .bind(boardId, ...affectedCols)
    .all<{ id: number; column_name: ColumnName; position: number; version: number }>();

  const movedGroups = await loadGroupsForCard(db, id);
  return {
    card: hydrateCard(movedRow, movedGroups),
    fromColumn,
    toColumn,
    affected: (affectedRows.results ?? []).map((r) => ({
      id: r.id,
      column: r.column_name,
      position: r.position,
      version: r.version,
    })),
  };
}

/** Returns true on success, false on version conflict / not found. */
export async function deleteCard(
  db: D1Database,
  id: number,
  expectedVersion: number
): Promise<boolean> {
  const current = await db
    .prepare(
      `SELECT board_id, column_name, position, version FROM kanban_cards WHERE id = ?`
    )
    .bind(id)
    .first<{ board_id: number; column_name: ColumnName; position: number; version: number }>();
  if (!current || current.version !== expectedVersion) return false;

  await db.batch([
    db
      .prepare(`DELETE FROM kanban_cards WHERE id = ? AND version = ?`)
      .bind(id, expectedVersion),
    db
      .prepare(
        `UPDATE kanban_cards SET position = position - 1
         WHERE board_id = ? AND column_name = ? AND position > ?`
      )
      .bind(current.board_id, current.column_name, current.position),
  ]);

  return true;
}
