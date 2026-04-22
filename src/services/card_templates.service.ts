/**
 * Card templates (P5) — JSON snapshots of the user-editable card fields,
 * scoped to a board. Anyone authed can save / use; only the creator
 * (or admin) can delete.
 *
 * The template payload mirrors the create_card patch shape so creating
 * a card from a template is essentially a clone-then-modify.
 */

import {
  createCard,
  createChecklistItem,
  type CardDto,
  type ColumnName,
} from './kanban.service';

export interface CardTemplatePayload {
  /** If null/undefined, the user is asked for a title at create time. */
  title?: string;
  notes?: string | null;
  groups?: string[];
  assigneeUserIds?: number[];
  /** Days from "now" to set as start date when materializing.
   *  Null = no start date; undefined = preserve absent. */
  startOffsetDays?: number | null;
  dueOffsetDays?: number | null;
  dueTime?: string | null;
  coverColor?: string | null;
  /** Each becomes a checklist item on the new card, in order. */
  checklist?: string[];
}

export interface CardTemplateDto {
  id: number;
  boardId: number;
  name: string;
  payload: CardTemplatePayload;
  createdByUserId: number | null;
  createdAt: string;
}

interface RawTemplateRow {
  id: number;
  board_id: number;
  name: string;
  payload: string;
  created_by_user_id: number | null;
  created_at: string;
}

function safeParsePayload(raw: string): CardTemplatePayload {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed as CardTemplatePayload;
  } catch {
    /* fall through */
  }
  return {};
}

function hydrate(row: RawTemplateRow): CardTemplateDto {
  return {
    id: row.id,
    boardId: row.board_id,
    name: row.name,
    payload: safeParsePayload(row.payload),
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
  };
}

export async function listTemplatesForBoard(
  db: D1Database,
  boardId: number
): Promise<CardTemplateDto[]> {
  const res = await db
    .prepare(
      `SELECT * FROM kanban_card_templates
       WHERE board_id = ?
       ORDER BY name ASC`
    )
    .bind(boardId)
    .all<RawTemplateRow>();
  return (res.results ?? []).map(hydrate);
}

export interface CreateTemplateInput {
  name: string;
  payload: CardTemplatePayload;
}

export async function createTemplate(
  db: D1Database,
  boardId: number,
  userId: number | null,
  input: CreateTemplateInput
): Promise<CardTemplateDto | null> {
  const name = input.name.trim().slice(0, 100);
  if (!name) return null;
  const payloadJson = JSON.stringify(input.payload ?? {});
  const row = await db
    .prepare(
      `INSERT INTO kanban_card_templates (board_id, name, payload, created_by_user_id)
       VALUES (?, ?, ?, ?)
       RETURNING *`
    )
    .bind(boardId, name, payloadJson, userId)
    .first<RawTemplateRow>();
  return row ? hydrate(row) : null;
}

/**
 * Materialize a template into a new card on the given column. Returns
 * the freshly-created card (the caller broadcasts card_created). If the
 * template carries `checklist`, items are inserted afterwards (one
 * round-trip per item — fine for the small lists templates carry).
 */
export async function createCardFromTemplate(
  db: D1Database,
  boardId: number,
  template: CardTemplateDto,
  column: ColumnName,
  userId: number | null,
  /** Optional title override — useful when the user wants to change
   *  it at create-time without mutating the template. */
  titleOverride?: string
): Promise<CardDto> {
  const p = template.payload || {};
  // Resolve relative dates (offset from "now") into absolute ISO dates.
  const today = new Date();
  function offsetIso(days: number | null | undefined): string | null | undefined {
    if (days === undefined) return undefined;
    if (days === null) return null;
    const d = new Date(today.getTime() + days * 86400000);
    return d.toISOString().slice(0, 10);
  }
  const startDate = offsetIso(p.startOffsetDays);
  const dueDate = offsetIso(p.dueOffsetDays);

  const card = await createCard(
    db,
    boardId,
    {
      column,
      title: (titleOverride ?? p.title ?? template.name).trim(),
      groups: p.groups,
      assigneeUserIds: p.assigneeUserIds,
      notes: p.notes ?? null,
      startDate: startDate ?? null,
      dueDate: dueDate ?? null,
      dueTime: p.dueTime ?? null,
      coverColor: p.coverColor ?? null,
    },
    userId
  );

  if (Array.isArray(p.checklist) && p.checklist.length > 0) {
    for (const body of p.checklist) {
      const trimmed = String(body || '').trim();
      if (trimmed) await createChecklistItem(db, card.id, trimmed);
    }
  }
  return card;
}

/** Owner-or-admin delete. Returns true if a row was actually removed. */
export async function deleteTemplate(
  db: D1Database,
  id: number,
  userId: number | null,
  isAdmin: boolean
): Promise<boolean> {
  if (userId === null && !isAdmin) return false;
  const res = isAdmin
    ? await db
        .prepare(`DELETE FROM kanban_card_templates WHERE id = ?`)
        .bind(id)
        .run()
    : await db
        .prepare(
          `DELETE FROM kanban_card_templates
           WHERE id = ? AND created_by_user_id = ?`
        )
        .bind(id, userId)
        .run();
  return (res.meta?.changes ?? 0) > 0;
}
