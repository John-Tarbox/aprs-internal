/**
 * Kanban card persistence. One shared company-wide board; columns are a
 * fixed enum, card order within a column is a dense integer `position`.
 *
 * Concurrency model: every card carries a `version` column. Updates/moves/
 * deletes are gated on the caller's expected version, so conflicting writes
 * from two editors return a signalled failure (null / false) that the caller
 * turns into a WebSocket `nack { reason: 'version_conflict' }`.
 *
 * Atomicity: move/delete reshape positions across multiple rows. Those are
 * issued as a single `db.batch([...])` so partial application is impossible.
 * Cross-request races are prevented by the KanbanBoardDO isolate, which
 * serializes every webSocketMessage call.
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

export interface CardDto {
  id: number;
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

export async function listCards(db: D1Database): Promise<CardDto[]> {
  const res = await db
    .prepare(
      `SELECT * FROM kanban_cards ORDER BY column_name ASC, position ASC, id ASC`
    )
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
  input: CreateCardInput,
  userId: number | null
): Promise<CardDto> {
  // Append to the end of the target column. The subquery is evaluated inside
  // the same statement, which is atomic for a single-connection D1 write.
  const row = await db
    .prepare(
      `INSERT INTO kanban_cards
         (column_name, position, title, group_name, assigned, notes, due_date,
          created_by_user_id, updated_by_user_id)
       VALUES (
         ?,
         (SELECT COALESCE(MAX(position), -1) + 1 FROM kanban_cards WHERE column_name = ?),
         ?, ?, ?, ?, ?, ?, ?
       )
       RETURNING *`
    )
    .bind(
      input.column,
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
 * Move a card to (toColumn, toPosition). Renumbers positions in the source
 * and target columns so they stay dense.
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
    .prepare(`SELECT column_name, position, version FROM kanban_cards WHERE id = ?`)
    .bind(id)
    .first<{ column_name: ColumnName; position: number; version: number }>();
  if (!current) return null;
  if (current.version !== expectedVersion) return null;

  const fromColumn = current.column_name;
  const fromPosition = current.position;

  // Clamp toPosition into the valid range. If moving within the same column,
  // the card itself counts once among the targets.
  const countRow = await db
    .prepare(`SELECT COUNT(*) as c FROM kanban_cards WHERE column_name = ?`)
    .bind(toColumn)
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
             WHERE column_name = ? AND position > ? AND position <= ?`
          )
          .bind(fromColumn, fromPosition, effectiveToPos)
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
             WHERE column_name = ? AND position >= ? AND position < ?`
          )
          .bind(fromColumn, effectiveToPos, fromPosition)
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
    stmts.push(
      db
        .prepare(
          `UPDATE kanban_cards SET position = position - 1
           WHERE column_name = ? AND position > ?`
        )
        .bind(fromColumn, fromPosition)
    );
    stmts.push(
      db
        .prepare(
          `UPDATE kanban_cards SET position = position + 1
           WHERE column_name = ? AND position >= ?`
        )
        .bind(toColumn, effectiveToPos)
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
       WHERE column_name IN (${affectedCols.map(() => '?').join(',')})`
    )
    .bind(...affectedCols)
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
    .prepare(`SELECT column_name, position, version FROM kanban_cards WHERE id = ?`)
    .bind(id)
    .first<{ column_name: ColumnName; position: number; version: number }>();
  if (!current || current.version !== expectedVersion) return false;

  await db.batch([
    db
      .prepare(`DELETE FROM kanban_cards WHERE id = ? AND version = ?`)
      .bind(id, expectedVersion),
    db
      .prepare(
        `UPDATE kanban_cards SET position = position - 1
         WHERE column_name = ? AND position > ?`
      )
      .bind(current.column_name, current.position),
  ]);

  return true;
}
