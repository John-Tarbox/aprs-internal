/**
 * Saved-filter HTTP API (P4). JSON-only, consumed by the chip row above
 * the kanban filter bar.
 *
 *   GET    /api/filters?board=<slug>     → { items: SavedFilterDto[] }
 *   POST   /api/filters                  → body { name, query, boardSlug? } → { filter }
 *   DELETE /api/filters/:id              → { ok: true }
 *
 * All endpoints scope to the calling user via authMiddleware (mounted
 * in src/index.ts). Mutations are owner-checked at the SQL level — a
 * forged id from another user is harmlessly a no-op.
 */

import { Hono } from 'hono';
import type { AppEnv } from '../env';
import {
  createSavedFilter,
  deleteSavedFilter,
  listSavedFilters,
} from '../services/saved_filters.service';
import { getBoardBySlug } from '../services/kanban.service';

export const savedFiltersRoutes = new Hono<AppEnv>();

async function resolveBoardId(
  db: D1Database,
  slug: string | undefined
): Promise<number | null | undefined> {
  if (!slug) return undefined;
  const board = await getBoardBySlug(db, slug);
  return board ? board.id : null;
}

savedFiltersRoutes.get('/', async (c) => {
  const user = c.get('user');
  const slug = c.req.query('board') ?? undefined;
  const boardId = await resolveBoardId(c.env.DB, slug);
  // boardId === null means "slug supplied but didn't match" → return [].
  if (boardId === null) return c.json({ items: [] });
  const items = await listSavedFilters(c.env.DB, user.id, boardId);
  return c.json({ items });
});

savedFiltersRoutes.post('/', async (c) => {
  const user = c.get('user');
  let body: unknown = null;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid json' }, 400);
  }
  const obj = (body && typeof body === 'object') ? (body as Record<string, unknown>) : {};
  const name = typeof obj.name === 'string' ? obj.name : '';
  const query = typeof obj.query === 'string' ? obj.query : '';
  const slug = typeof obj.boardSlug === 'string' ? obj.boardSlug : undefined;
  if (!name.trim() || !query.trim()) {
    return c.json({ error: 'name and query are required' }, 400);
  }
  const boardId = await resolveBoardId(c.env.DB, slug);
  if (boardId === null) return c.json({ error: 'unknown board' }, 404);
  const filter = await createSavedFilter(c.env.DB, user.id, {
    name,
    query,
    boardId: boardId ?? null,
  });
  if (!filter) {
    return c.json({ error: 'a filter with that name already exists' }, 409);
  }
  return c.json({ filter });
});

savedFiltersRoutes.delete('/:id', async (c) => {
  const user = c.get('user');
  const id = Number.parseInt(c.req.param('id'), 10);
  if (!Number.isFinite(id) || id <= 0) return c.json({ error: 'invalid id' }, 400);
  const ok = await deleteSavedFilter(c.env.DB, user.id, id);
  if (!ok) return c.json({ error: 'not found' }, 404);
  return c.json({ ok: true });
});
