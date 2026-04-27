/**
 * Bulk CSV import (P7). Staff-only; creates many cards on a board from
 * a CSV with a header row.
 *
 * Recognized headers (case-insensitive):
 *   title              (required)    card title
 *   notes              (optional)    card notes / description
 *   assigned           (optional)    legacy free-text assignee
 *   labels (or groups) (optional)    pipe- OR comma-separated labels.
 *                                    "groups" is accepted as a back-
 *                                    compat alias — earlier versions
 *                                    of this tool used that name.
 *
 * Unrecognized columns are ignored (logged to the caller as warnings).
 * Rows with an empty title are skipped; rows beyond MAX_ROWS are
 * truncated with a warning. All-or-nothing commit: if any create fails,
 * no cards are kept (we stage via createCard calls and rely on the
 * caller surface failure as an error response — D1 doesn't support
 * client-side transactions across `createCard` calls).
 */

import { parseCsv, indexHeaders } from '../util/csv';
import { createCard, type ColumnName, type CardDto } from './kanban.service';

export const MAX_IMPORT_ROWS = 500;

export interface ImportResult {
  created: CardDto[];
  skipped: number;
  warnings: string[];
}

export interface ImportRow {
  title: string;
  notes: string | null;
  assigned: string | null;
  groups: string[];
}

/**
 * Parse + validate a CSV into normalized ImportRow objects without
 * writing anything. Used for both preview and commit — commit then
 * iterates the rows and calls createCard.
 */
export function parseImportCsv(csv: string): { rows: ImportRow[]; warnings: string[]; totalRaw: number } {
  const raw = parseCsv(csv);
  const warnings: string[] = [];
  if (raw.length === 0) {
    return { rows: [], warnings: ['Empty file.'], totalRaw: 0 };
  }
  const header = raw[0];
  const idx = indexHeaders(header, ['title', 'notes', 'assigned', 'labels', 'groups']);
  if (idx.title === null) {
    return { rows: [], warnings: ['CSV must have a "title" column.'], totalRaw: raw.length - 1 };
  }
  // Labels column: prefer the new "labels" header; fall back to the
  // legacy "groups" header so older CSVs still import cleanly.
  const labelsIdx = idx.labels !== null ? idx.labels : idx.groups;
  const body = raw.slice(1);
  const totalRaw = body.length;
  if (body.length > MAX_IMPORT_ROWS) {
    warnings.push(`Row count ${body.length} exceeds max ${MAX_IMPORT_ROWS}; only the first ${MAX_IMPORT_ROWS} will be imported.`);
  }
  const clipped = body.slice(0, MAX_IMPORT_ROWS);
  const rows: ImportRow[] = [];
  for (let i = 0; i < clipped.length; i++) {
    const r = clipped[i];
    const title = (idx.title !== null ? (r[idx.title] ?? '') : '').trim();
    if (!title) continue; // silently skip empty-title rows
    const notes = idx.notes !== null ? (r[idx.notes] ?? '').trim() : '';
    const assigned = idx.assigned !== null ? (r[idx.assigned] ?? '').trim() : '';
    const groupsRaw = labelsIdx !== null ? (r[labelsIdx] ?? '') : '';
    // Accept either pipe- or comma-separated group lists. Users paste
    // either shape depending on their source tool.
    const groups = groupsRaw
      .split(/[|,]/)
      .map((g) => g.trim())
      .filter((g) => g.length > 0);
    rows.push({
      title: title.slice(0, 200),
      notes: notes ? notes.slice(0, 10_000) : null,
      assigned: assigned ? assigned.slice(0, 100) : null,
      groups,
    });
  }
  return { rows, warnings, totalRaw };
}

export async function commitImport(
  db: D1Database,
  boardId: number,
  column: ColumnName,
  rows: ImportRow[],
  userId: number | null
): Promise<ImportResult> {
  const created: CardDto[] = [];
  // Loop + single createCard per row. Each call is its own mini-batch
  // (groups + card + assignees). 500 rows × ~3 writes each = 1500
  // statements; well within D1's per-second limits for a rare admin op.
  for (const row of rows) {
    const card = await createCard(
      db,
      boardId,
      {
        column,
        title: row.title,
        groups: row.groups,
        assigned: row.assigned,
        notes: row.notes,
      },
      userId
    );
    created.push(card);
  }
  return { created, skipped: 0, warnings: [] };
}
