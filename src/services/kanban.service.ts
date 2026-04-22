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
  group: string | null;
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
  group_name: string | null;
  assigned: string | null;
  notes: string | null;
  due_date: string | null;
  version: number;
  created_by_user_id: number | null;
  updated_by_user_id: number | null;
  created_at: string;
  updated_at: string;
}

function hydrateCard(row: RawCardRow): CardDto {
  return {
    id: row.id,
    boardId: row.board_id,
    column: row.column_name,
    position: row.position,
    title: row.title,
    group: row.group_name,
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
  return (res.results ?? []).map(hydrateCard);
}

export interface CreateCardInput {
  column: ColumnName;
  title: string;
  group?: string | null;
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
  // Append to the end of the target column on this board.
  const row = await db
    .prepare(
      `INSERT INTO kanban_cards
         (board_id, column_name, position, title, group_name, assigned, notes, due_date,
          created_by_user_id, updated_by_user_id)
       VALUES (
         ?,
         ?,
         (SELECT COALESCE(MAX(position), -1) + 1 FROM kanban_cards
           WHERE board_id = ? AND column_name = ?),
         ?, ?, ?, ?, ?, ?, ?
       )
       RETURNING *`
    )
    .bind(
      boardId,
      input.column,
      boardId,
      input.column,
      input.title,
      input.group ?? null,
      input.assigned ?? null,
      input.notes ?? null,
      input.dueDate ?? null,
      userId,
      userId
    )
    .first<RawCardRow>();

  if (!row) throw new Error('Failed to insert kanban card');
  return hydrateCard(row);
}

export interface UpdateCardPatch {
  title?: string;
  group?: string | null;
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
  if (patch.group !== undefined) {
    sets.push('group_name = ?');
    binds.push(patch.group ?? null);
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

  if (sets.length === 0) {
    const row = await db
      .prepare(`SELECT * FROM kanban_cards WHERE id = ? AND version = ?`)
      .bind(id, expectedVersion)
      .first<RawCardRow>();
    return row ? hydrateCard(row) : null;
  }

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

  return row ? hydrateCard(row) : null;
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

  return {
    card: hydrateCard(movedRow),
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
