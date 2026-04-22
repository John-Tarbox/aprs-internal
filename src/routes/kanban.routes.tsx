/**
 * Kanban routes. Multi-board:
 *   GET  /kanban                 — board picker (list + create form)
 *   POST /kanban                 — create board           (staff+)
 *   GET  /kanban/:slug           — board page
 *   GET  /kanban/:slug/ws        — WebSocket upgrade to KanbanBoardDO for this board
 *   POST /kanban/:slug/rename    — rename board           (staff+)
 *   POST /kanban/:slug/delete    — delete board           (staff+)
 *
 * Auth is enforced via the app-level `authMiddleware` in src/index.ts, so
 * `c.get('user')` is guaranteed present. Mutation endpoints additionally
 * gate on requireRole('staff').
 *
 * For the WS upgrade we build a fresh Request carrying trusted internal
 * headers (X-User-*, X-Board-Id). Any X-User-* / X-Board-Id headers on the
 * inbound client request are dropped — only the authoritative server-side
 * values reach the DO.
 */

import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { requireRole } from '../middleware/auth';
import { KanbanPage } from '../pages/KanbanPage';
import { KanbanBoardListPage } from '../pages/KanbanBoardListPage';
import {
  listBoards,
  getBoardBySlug,
  createBoard,
  renameBoard,
  deleteBoard,
  deleteAttachmentRow,
  getAttachment,
  getColumnCounts,
  insertAttachment,
  listActiveUserDirectory,
  listAttachments,
  listBoardColumns,
  listDistinctGroupNames,
} from '../services/kanban.service';
import { markNotificationsRead } from '../services/notifications.service';

/** Hard cap for a single attachment upload. R2 itself can take much
 *  larger objects but we proxy through the Worker which has request-body
 *  limits, and the modal UX isn't built for huge files. */
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024; // 25 MiB
import { KANBAN_COLUMNS } from '../services/kanban.service';

export const kanbanRoutes = new Hono<AppEnv>();

// ── Board picker ────────────────────────────────────────────────────────

kanbanRoutes.get('/', async (c) => {
  const user = c.get('user');
  const boards = await listBoards(c.env.DB);
  // Per-board counts, computed in parallel.
  const countsByBoardId: Record<number, Record<string, number>> = {};
  await Promise.all(
    boards.map(async (b) => {
      countsByBoardId[b.id] = await getColumnCounts(c.env.DB, b.id);
    })
  );
  const flashKind = c.req.query('ok') ? 'ok' : c.req.query('err') ? 'err' : undefined;
  const flashMsg = c.req.query('ok') ?? c.req.query('err') ?? undefined;
  return c.html(
    <KanbanBoardListPage
      user={user}
      boards={boards}
      countsByBoardId={countsByBoardId}
      columns={KANBAN_COLUMNS as unknown as string[]}
      flash={flashKind && flashMsg ? { kind: flashKind, message: flashMsg } : undefined}
    />
  );
});

kanbanRoutes.post('/', requireRole('staff'), async (c) => {
  const user = c.get('user');
  const form = await c.req.formData();
  const name = String(form.get('name') ?? '').trim();
  const slugRaw = String(form.get('slug') ?? '').trim();
  if (!name || name.length > 100) {
    return c.redirect(
      `/kanban?err=${encodeURIComponent('Name is required (max 100 chars).')}`,
      302
    );
  }
  try {
    const board = await createBoard(
      c.env.DB,
      { name, slug: slugRaw || undefined },
      user.id
    );
    return c.redirect(
      `/kanban/${encodeURIComponent(board.slug)}?ok=${encodeURIComponent('Board created.')}`,
      302
    );
  } catch (err) {
    const msg = String((err as Error)?.message ?? err);
    // UNIQUE violation on slug → friendly error.
    const friendly = msg.includes('UNIQUE') || msg.includes('constraint')
      ? 'A board with that slug already exists — pick a different name or slug.'
      : `Could not create board: ${msg}`;
    return c.redirect(`/kanban?err=${encodeURIComponent(friendly)}`, 302);
  }
});

// ── Attachments (S11) ───────────────────────────────────────────────────

/** Sanitize a user-supplied filename for inclusion in an R2 object key.
 *  Keep alphanumerics, dots, dashes, underscores; replace the rest with _. */
function safeFilename(name: string): string {
  const trimmed = name.trim().slice(0, 200);
  return trimmed.replace(/[^a-zA-Z0-9._-]+/g, '_') || 'file';
}

/** Cryptographically-random hex id for attachment keys. Avoids guessable URLs
 *  and avoids collisions when the same file is uploaded to two cards. */
function randomKey(): string {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

kanbanRoutes.get('/c/:cardId/attachments', async (c) => {
  const cardId = Number.parseInt(c.req.param('cardId'), 10);
  if (!Number.isFinite(cardId) || cardId <= 0) return c.json({ error: 'invalid' }, 400);
  const items = await listAttachments(c.env.DB, cardId);
  return c.json({ items });
});

kanbanRoutes.post('/c/:cardId/attachments', async (c) => {
  const user = c.get('user');
  const cardId = Number.parseInt(c.req.param('cardId'), 10);
  if (!Number.isFinite(cardId) || cardId <= 0) return c.json({ error: 'invalid card id' }, 400);

  // Verify the card exists before we burn an R2 round-trip on a bad target.
  const cardRow = await c.env.DB
    .prepare(`SELECT id FROM kanban_cards WHERE id = ?`)
    .bind(cardId)
    .first<{ id: number }>();
  if (!cardRow) return c.json({ error: 'card not found' }, 404);

  const form = await c.req.formData();
  const raw = form.get('file');
  // Worker types don't include the File constructor; duck-type via the
  // shape we actually need (Blob plus a name).
  const file = raw as unknown as Blob & { name?: string } | null;
  if (!file || typeof file !== 'object' || typeof (file as Blob).size !== 'number') {
    return c.json({ error: 'missing file' }, 400);
  }
  if (file.size <= 0) return c.json({ error: 'empty file' }, 400);
  if (file.size > MAX_ATTACHMENT_BYTES) {
    return c.json({ error: `file exceeds ${MAX_ATTACHMENT_BYTES} bytes` }, 413);
  }

  const originalName = (file.name && typeof file.name === 'string') ? file.name : 'upload';
  const key = `cards/${cardId}/${randomKey()}-${safeFilename(originalName)}`;
  const contentType = file.type || 'application/octet-stream';
  await c.env.ATTACHMENTS.put(key, file.stream(), {
    httpMetadata: { contentType },
  });

  const row = await insertAttachment(c.env.DB, {
    cardId,
    r2Key: key,
    originalName,
    contentType,
    sizeBytes: file.size,
    uploadedByUserId: user.id,
  });
  return c.json({ attachment: row });
});

kanbanRoutes.get('/attachment/:id', async (c) => {
  const id = Number.parseInt(c.req.param('id'), 10);
  if (!Number.isFinite(id) || id <= 0) return c.text('Invalid id', 400);
  const row = await getAttachment(c.env.DB, id);
  if (!row) return c.text('Not found', 404);
  const obj = await c.env.ATTACHMENTS.get(row.r2Key);
  if (!obj) {
    // Row is orphaned (R2 object missing). Surface as 404; no point repairing
    // here — the user will report it and we can clean up via DB.
    return c.text('Attachment file missing', 404);
  }
  // Inline display for browser-renderable types; force download otherwise.
  const inlineable = /^(image\/|application\/pdf|text\/plain)/.test(row.contentType);
  const disposition = `${inlineable ? 'inline' : 'attachment'}; filename="${row.originalName.replace(/"/g, '')}"`;
  return new Response(obj.body, {
    headers: {
      'Content-Type': row.contentType,
      'Content-Length': String(row.sizeBytes),
      'Content-Disposition': disposition,
      // Inline previews can be cached briefly; auth-gated content shouldn't
      // be stored by intermediaries.
      'Cache-Control': 'private, max-age=300',
    },
  });
});

kanbanRoutes.post('/attachment/:id/delete', async (c) => {
  const user = c.get('user');
  const id = Number.parseInt(c.req.param('id'), 10);
  if (!Number.isFinite(id) || id <= 0) return c.json({ error: 'invalid' }, 400);
  const isAdmin = user.roles.includes('admin');
  const row = await deleteAttachmentRow(c.env.DB, id, user.id, isAdmin);
  if (!row) return c.json({ error: 'forbidden or not found' }, 403);
  // Best-effort R2 purge — if it fails, the row is already gone and we'll
  // have a stranded object. Cheaper than a 2-phase delete for v1.
  await c.env.ATTACHMENTS.delete(row.r2Key).catch(() => {});
  return c.json({ ok: true, id: row.id, cardId: row.cardId });
});

// ── Card deep-link redirector ───────────────────────────────────────────
//
// Notifications carry only the card id (the board may be renamed or moved).
// This redirector resolves card → board slug and 302s to the board page,
// optionally marking the source notification read in the same hop.
kanbanRoutes.get('/c/:cardId', async (c) => {
  const user = c.get('user');
  const cardId = Number.parseInt(c.req.param('cardId'), 10);
  if (!Number.isFinite(cardId) || cardId <= 0) {
    return c.text('Invalid card id', 400);
  }
  const row = await c.env.DB
    .prepare(
      `SELECT b.slug FROM kanban_cards c
       JOIN kanban_boards b ON b.id = c.board_id
       WHERE c.id = ?`
    )
    .bind(cardId)
    .first<{ slug: string }>();
  if (!row) return c.text('Card not found', 404);

  // Mark the originating notification read (best-effort) before redirecting.
  const notifIdRaw = c.req.query('notif');
  if (notifIdRaw) {
    const nid = Number.parseInt(notifIdRaw, 10);
    if (Number.isFinite(nid) && nid > 0) {
      await markNotificationsRead(c.env.DB, user.id, [nid]).catch(() => {});
    }
  }
  return c.redirect(`/kanban/${encodeURIComponent(row.slug)}?card=${cardId}`, 302);
});

// ── Board page ──────────────────────────────────────────────────────────

kanbanRoutes.get('/:slug', async (c) => {
  const user = c.get('user');
  const slug = c.req.param('slug');
  const board = await getBoardBySlug(c.env.DB, slug);
  if (!board) return c.text('Board not found', 404);
  const [knownGroups, knownUsers, columns] = await Promise.all([
    listDistinctGroupNames(c.env.DB),
    listActiveUserDirectory(c.env.DB),
    listBoardColumns(c.env.DB, board.id),
  ]);
  return c.html(
    <KanbanPage
      user={user}
      board={board}
      knownGroups={knownGroups}
      knownUsers={knownUsers}
      columns={columns}
    />
  );
});

kanbanRoutes.get('/:slug/ws', async (c) => {
  if (c.req.header('Upgrade') !== 'websocket') {
    return c.text('Expected WebSocket upgrade', 426);
  }
  const user = c.get('user');
  const slug = c.req.param('slug');
  const board = await getBoardBySlug(c.env.DB, slug);
  if (!board) return c.text('Board not found', 404);

  const id = c.env.KANBAN_DO.idFromName(`board-${board.id}`);
  const stub = c.env.KANBAN_DO.get(id);

  const forwarded = new Request(c.req.raw.url, {
    method: 'GET',
    headers: {
      Upgrade: 'websocket',
      'X-User-Id': String(user.id),
      'X-User-Email': user.email,
      'X-User-Display-Name': user.displayName ?? '',
      // Forward admin/staff status so the DO can authorize sensitive
      // operations (e.g. deleting other users' comments, setting WIP
      // limits) without a per-message DB hit.
      'X-User-Is-Admin': user.roles.includes('admin') ? '1' : '0',
      'X-User-Is-Staff':
        user.roles.includes('admin') || user.roles.includes('staff') ? '1' : '0',
      'X-Board-Id': String(board.id),
    },
  });

  return stub.fetch(forwarded);
});

// ── Board mutations ─────────────────────────────────────────────────────

kanbanRoutes.post('/:slug/rename', requireRole('staff'), async (c) => {
  const slug = c.req.param('slug');
  const board = await getBoardBySlug(c.env.DB, slug);
  if (!board) return c.text('Board not found', 404);
  const form = await c.req.formData();
  const name = String(form.get('name') ?? '').trim();
  if (!name || name.length > 100) {
    return c.redirect(
      `/kanban?err=${encodeURIComponent('Name is required (max 100 chars).')}`,
      302
    );
  }
  await renameBoard(c.env.DB, board.id, name);
  return c.redirect(`/kanban?ok=${encodeURIComponent('Board renamed.')}`, 302);
});

kanbanRoutes.post('/:slug/delete', requireRole('staff'), async (c) => {
  const slug = c.req.param('slug');
  const board = await getBoardBySlug(c.env.DB, slug);
  if (!board) return c.text('Board not found', 404);
  const form = await c.req.formData();
  if (String(form.get('confirm') ?? '') !== board.slug) {
    return c.redirect(
      `/kanban?err=${encodeURIComponent('Delete confirmation did not match; board not deleted.')}`,
      302
    );
  }
  // Never allow deleting the very last board — keeps the app in a valid state.
  const all = await listBoards(c.env.DB);
  if (all.length <= 1) {
    return c.redirect(
      `/kanban?err=${encodeURIComponent('Cannot delete the only remaining board.')}`,
      302
    );
  }
  await deleteBoard(c.env.DB, board.id);
  return c.redirect(
    `/kanban?ok=${encodeURIComponent(`Board "${board.name}" deleted.`)}`,
    302
  );
});
