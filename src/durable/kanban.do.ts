/**
 * Durable Object that acts as the real-time coordination room for the shared
 * kanban board. Singleton: one instance (`idFromName('main-board')`) fans
 * out every change to every connected WebSocket.
 *
 * Authentication: the Worker-side route (`/kanban/ws`) runs `authMiddleware`
 * and then forwards the upgrade request with trusted internal headers
 * (X-User-Id, X-User-Email, X-User-Display-Name). Any X-User-* headers from
 * the original client request are stripped at the boundary. The DO never
 * parses cookies or sessions.
 *
 * Hibernation: uses `ctx.acceptWebSocket` so idle connections do not pin the
 * isolate in memory. State that must survive hibernation lives in each
 * socket's `serializeAttachment` blob — identity + rate-limit timestamps.
 * D1 is the durable source of truth; nothing about the board is cached here.
 */

import { DurableObject } from 'cloudflare:workers';
import { z } from 'zod';
import type { Env } from '../env';
import {
  addBoardColumn,
  archiveCard,
  countCardsPerGroup,
  createCard,
  createChecklistItem,
  createComment,
  createGroup,
  deleteCard,
  deleteChecklistItem,
  deleteComment,
  deleteGroup,
  getComment,
  KanbanColumnLimitError,
  listActiveUserDirectory,
  listArchivedCards,
  listBoardColumns,
  listCardEvents,
  listCards,
  listChecklistItems,
  listComments,
  listGroupsForBoard,
  logCardEvent,
  markCardViewed,
  moveCard,
  removeBoardColumn,
  renameBoardColumn,
  renameGroup,
  reorderBoardColumns,
  setColumnColor,
  setColumnWipLimit,
  setGroupColor,
  unarchiveCard,
  updateCard,
  updateChecklistItem,
  updateComment,
  type CardDto,
  type CardEventDto,
  type ColumnName,
} from '../services/kanban.service';
import { normalizeHexColor } from '../util/colors';
import {
  createCardFromTemplate,
  createTemplate,
  deleteTemplate,
  listTemplatesForBoard,
} from '../services/card_templates.service';
import type { CardTemplatePayload } from '../services/card_templates.service';
import {
  createNotification,
  parseMentions,
} from '../services/notifications.service';

const MAX_MSG_PER_SEC = 20;
const RATE_WINDOW_MS = 1000;
const MAX_TITLE = 200;
const MAX_FIELD = 100;
const MAX_NOTES = 10_000;
const MAX_COMMENT = 5_000;
const MAX_CHECKLIST_ITEM = 500;

// ── Op-method error hierarchy ───────────────────────────────────────────
//
// The DO's write operations are exposed as plain async methods (`op*`)
// callable both by the WebSocket message handler (this file) and by the
// MCP server (src/mcp/*) via Durable Object RPC. To keep one source of
// truth for failure modes, op methods throw these typed errors instead of
// returning result unions. The WS handler translates them to nack frames
// (`reason: 'forbidden' | 'not_found' | 'version_conflict' | 'invalid' |
// 'column_limit'`) at the socket boundary; MCP tools let them propagate
// and the SDK turns them into JSON-RPC errors for the client.
export class OpForbiddenError extends Error {
  constructor(message = 'forbidden') { super(message); this.name = 'OpForbiddenError'; }
}
export class OpNotFoundError extends Error {
  constructor(message = 'not_found') { super(message); this.name = 'OpNotFoundError'; }
}
export class OpVersionConflictError extends Error {
  constructor(public readonly currentVersion: number | null) {
    super('version_conflict');
    this.name = 'OpVersionConflictError';
  }
}
export class OpInvalidError extends Error {
  constructor(message = 'invalid') { super(message); this.name = 'OpInvalidError'; }
}

// Post-S12, columns are arbitrary per-board strings, validated against
// kanban_board_columns at the service layer rather than at the wire-
// format layer. Kept as a permissive shape so a typo or bad-input case
// returns 'invalid' / 'not_found' from the service rather than a Zod
// rejection that the client might handle less gracefully.
const columnEnum = z.string().min(1).max(64);

const nullableStr = (max: number) =>
  z
    .string()
    .max(max)
    .nullable()
    .optional()
    .transform((v) => (v === undefined ? undefined : v));

const dueDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .nullable()
  .optional();

// Same shape as dueDateSchema but kept separate to allow future divergence
// (e.g. start dates may eventually allow ranges or relative offsets).
const startDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .nullable()
  .optional();

// HH:MM in 24h format, 00:00–23:59. Loose on minute edges (any 0–9 ten's
// digit) — exact range bounds aren't worth the regex complexity here.
const dueTimeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
  .nullable()
  .optional();

// Hex color (#abc or #aabbcc). Server normalizes via normalizeHexColor
// before storing — this regex is just first-line input validation so a
// patently bad value gets rejected at the WS boundary.
const colorSchema = z
  .string()
  .regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/)
  .nullable()
  .optional();

const clientMsgSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('hello'),
    clientMsgId: z.string().max(64),
  }),
  z.object({
    type: z.literal('create_card'),
    clientMsgId: z.string().max(64),
    column: columnEnum,
    title: z.string().min(1).max(MAX_TITLE),
    groups: z.array(z.string().trim().max(MAX_FIELD)).max(20).optional(),
    assigneeUserIds: z.array(z.number().int().positive()).max(10).optional(),
    assigned: nullableStr(MAX_FIELD),
    notes: nullableStr(MAX_NOTES),
    startDate: startDateSchema,
    dueDate: dueDateSchema,
    dueTime: dueTimeSchema,
    coverColor: colorSchema,
  }),
  z.object({
    type: z.literal('update_card'),
    clientMsgId: z.string().max(64),
    id: z.number().int().positive(),
    version: z.number().int().positive(),
    patch: z.object({
      title: z.string().min(1).max(MAX_TITLE).optional(),
      groups: z.array(z.string().trim().max(MAX_FIELD)).max(20).optional(),
      assigneeUserIds: z.array(z.number().int().positive()).max(10).optional(),
      assigned: nullableStr(MAX_FIELD),
      notes: nullableStr(MAX_NOTES),
      startDate: startDateSchema,
      dueDate: dueDateSchema,
      dueTime: dueTimeSchema,
      coverColor: colorSchema,
    }),
  }),
  z.object({
    type: z.literal('move_card'),
    clientMsgId: z.string().max(64),
    id: z.number().int().positive(),
    version: z.number().int().positive(),
    toColumn: columnEnum,
    toPosition: z.number().int().min(0),
  }),
  z.object({
    type: z.literal('delete_card'),
    clientMsgId: z.string().max(64),
    id: z.number().int().positive(),
    version: z.number().int().positive(),
  }),
  z.object({
    type: z.literal('archive_card'),
    clientMsgId: z.string().max(64),
    id: z.number().int().positive(),
    version: z.number().int().positive(),
  }),
  z.object({
    type: z.literal('unarchive_card'),
    clientMsgId: z.string().max(64),
    id: z.number().int().positive(),
    version: z.number().int().positive(),
  }),
  z.object({
    // Client requests the archive drawer snapshot. DO replies with
    // { type: 'archived_snapshot', cards } to the requester only.
    type: z.literal('list_archived'),
    clientMsgId: z.string().max(64),
  }),
  z.object({
    // Client requests the activity timeline for a card (modal open). DO
    // replies with { type: 'card_events_snapshot', cardId, events }.
    type: z.literal('list_card_events'),
    clientMsgId: z.string().max(64),
    cardId: z.number().int().positive(),
  }),
  z.object({
    // Comments thread snapshot for a card (modal open). DO replies with
    // { type: 'comments_snapshot', cardId, comments }.
    type: z.literal('list_comments'),
    clientMsgId: z.string().max(64),
    cardId: z.number().int().positive(),
  }),
  z.object({
    type: z.literal('create_comment'),
    clientMsgId: z.string().max(64),
    cardId: z.number().int().positive(),
    body: z.string().min(1).max(MAX_COMMENT),
  }),
  z.object({
    type: z.literal('update_comment'),
    clientMsgId: z.string().max(64),
    id: z.number().int().positive(),
    body: z.string().min(1).max(MAX_COMMENT),
  }),
  z.object({
    type: z.literal('delete_comment'),
    clientMsgId: z.string().max(64),
    id: z.number().int().positive(),
  }),
  z.object({
    // Staff+ can set a per-column WIP limit. null = clear the limit.
    type: z.literal('set_wip_limit'),
    clientMsgId: z.string().max(64),
    column: columnEnum,
    wipLimit: z.number().int().min(1).max(999).nullable(),
  }),
  z.object({
    type: z.literal('list_checklist_items'),
    clientMsgId: z.string().max(64),
    cardId: z.number().int().positive(),
  }),
  z.object({
    type: z.literal('create_checklist_item'),
    clientMsgId: z.string().max(64),
    cardId: z.number().int().positive(),
    body: z.string().min(1).max(MAX_CHECKLIST_ITEM),
  }),
  z.object({
    type: z.literal('update_checklist_item'),
    clientMsgId: z.string().max(64),
    id: z.number().int().positive(),
    body: z.string().min(1).max(MAX_CHECKLIST_ITEM).optional(),
    completed: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('delete_checklist_item'),
    clientMsgId: z.string().max(64),
    id: z.number().int().positive(),
  }),
  z.object({
    // Staff+ adds a new column to this board. Key + label both supplied;
    // the key is normalized server-side.
    type: z.literal('add_column'),
    clientMsgId: z.string().max(64),
    key: z.string().min(1).max(64),
    label: z.string().min(1).max(64),
  }),
  z.object({
    type: z.literal('rename_column'),
    clientMsgId: z.string().max(64),
    column: columnEnum,
    label: z.string().min(1).max(64),
  }),
  z.object({
    type: z.literal('delete_column'),
    clientMsgId: z.string().max(64),
    column: columnEnum,
  }),
  z.object({
    // Staff+ reorders columns. `order` is the full list of column names
    // in the desired left-to-right order; the server renumbers positions
    // 0..N-1 to match.
    type: z.literal('move_column'),
    clientMsgId: z.string().max(64),
    order: z.array(columnEnum).min(1).max(64),
  }),
  z.object({
    // Staff+ sets a column's color. null clears back to the legacy default.
    type: z.literal('set_column_color'),
    clientMsgId: z.string().max(64),
    column: columnEnum,
    color: colorSchema,
  }),
  z.object({
    // Staff+ sets the color for a group/label on this board. null clears.
    type: z.literal('set_group_color'),
    clientMsgId: z.string().max(64),
    name: z.string().min(1).max(MAX_FIELD),
    color: colorSchema,
  }),
  z.object({
    // Staff+ creates a new label on this board. Idempotent + NOCASE-safe.
    type: z.literal('create_group'),
    clientMsgId: z.string().max(64),
    name: z.string().min(1).max(MAX_FIELD),
    color: colorSchema.optional(),
  }),
  z.object({
    // Staff+ renames a label everywhere it appears on this board.
    type: z.literal('rename_group'),
    clientMsgId: z.string().max(64),
    oldName: z.string().min(1).max(MAX_FIELD),
    newName: z.string().min(1).max(MAX_FIELD),
  }),
  z.object({
    // Staff+ deletes a label, detaching it from every card on this board.
    type: z.literal('delete_group'),
    clientMsgId: z.string().max(64),
    name: z.string().min(1).max(MAX_FIELD),
  }),
  z.object({
    // Staff+ requests the per-board label palette + per-label card counts
    // for the manager modal.
    type: z.literal('list_groups'),
    clientMsgId: z.string().max(64),
  }),
  z.object({
    // Mark the caller's last_viewed_at on a card to clear the unread-
    // comments dot. Idempotent. Fires when the user opens a card modal.
    type: z.literal('mark_card_viewed'),
    clientMsgId: z.string().max(64),
    cardId: z.number().int().positive(),
  }),
  z.object({
    type: z.literal('list_templates'),
    clientMsgId: z.string().max(64),
  }),
  z.object({
    // Save a snapshot of an existing card as a named template, or save
    // a freshly-composed payload (omit cardId for the latter).
    type: z.literal('save_template'),
    clientMsgId: z.string().max(64),
    name: z.string().min(1).max(100),
    /** JSON-shaped payload. Validated for top-level type only here;
     *  the service is forgiving about unknown / extra keys. */
    payload: z.record(z.string(), z.unknown()),
  }),
  z.object({
    type: z.literal('create_from_template'),
    clientMsgId: z.string().max(64),
    templateId: z.number().int().positive(),
    column: columnEnum,
    /** Optional title override at create-time; defaults to template's. */
    titleOverride: z.string().max(MAX_TITLE).optional(),
  }),
  z.object({
    type: z.literal('delete_template'),
    clientMsgId: z.string().max(64),
    id: z.number().int().positive(),
  }),
]);

type ClientMsg = z.infer<typeof clientMsgSchema>;

interface SocketAttachment {
  userId: number;
  email: string;
  displayName: string | null;
  // Whether the user holds the 'admin' role. Cached on the socket so
  // authorization checks (e.g., "can this user delete anyone's comment")
  // don't need a DB hit per message. The route reads roles from the
  // session-resolved AuthUser and forwards via X-User-Is-Admin header.
  isAdmin: boolean;
  // Whether the user holds the 'staff' role (or higher). Used by the
  // WIP-limit setter and other board-config mutations. Admin implies
  // staff at the route layer — so this is true if either role is held.
  isStaff: boolean;
  // Which board this socket is connected to. Each DO instance is per-board
  // (idFromName('board-' + id)), but we also store it on the attachment so
  // service calls can pass it explicitly rather than relying on DO-internal
  // state that the `ctx` doesn't expose.
  boardId: number;
  // Sliding window of recent message timestamps (ms since epoch), for rate
  // limiting. Kept bounded to MAX_MSG_PER_SEC entries.
  recentMs: number[];
}

function cardToDto(c: CardDto) {
  return c; // already a plain object with the public shape
}

export class KanbanBoardDO extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }

    const userIdRaw = request.headers.get('X-User-Id');
    const email = request.headers.get('X-User-Email');
    const displayName = request.headers.get('X-User-Display-Name');
    const boardIdRaw = request.headers.get('X-Board-Id');
    const isAdminRaw = request.headers.get('X-User-Is-Admin');
    const isStaffRaw = request.headers.get('X-User-Is-Staff');
    const userId = userIdRaw ? Number.parseInt(userIdRaw, 10) : NaN;
    const boardId = boardIdRaw ? Number.parseInt(boardIdRaw, 10) : NaN;
    if (!Number.isFinite(userId) || userId <= 0 || !email) {
      // The Worker route is supposed to inject these; if they're missing
      // something is wrong with the caller chain.
      return new Response('Unauthorized', { status: 401 });
    }
    if (!Number.isFinite(boardId) || boardId <= 0) {
      return new Response('Missing or invalid board id', { status: 400 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    this.ctx.acceptWebSocket(server);
    const attachment: SocketAttachment = {
      userId,
      email,
      displayName: displayName || null,
      isAdmin: isAdminRaw === '1',
      isStaff: isStaffRaw === '1' || isAdminRaw === '1',
      boardId,
      recentMs: [],
    };
    server.serializeAttachment(attachment);

    // Send initial snapshot for this board. If this throws, the socket will close.
    // listCards is called with the viewer's userId so per-user
    // hasUnreadComments flags are correct on first paint.
    const [cards, columns, groups] = await Promise.all([
      listCards(this.env.DB, boardId, userId),
      listBoardColumns(this.env.DB, boardId),
      listGroupsForBoard(this.env.DB, boardId),
    ]);
    server.send(
      JSON.stringify({
        type: 'snapshot',
        cards: cards.map(cardToDto),
        columns,
        groups,
      })
    );

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const attachment = (ws.deserializeAttachment() as SocketAttachment | null) ?? null;
    if (!attachment) {
      ws.close(1011, 'missing attachment');
      return;
    }

    // Rate limit: sliding 1s window.
    const now = Date.now();
    attachment.recentMs = attachment.recentMs.filter((t) => now - t < RATE_WINDOW_MS);
    if (attachment.recentMs.length >= MAX_MSG_PER_SEC) {
      ws.close(1008, 'rate limit exceeded');
      return;
    }
    attachment.recentMs.push(now);
    ws.serializeAttachment(attachment);

    const text = typeof message === 'string' ? message : new TextDecoder().decode(message);
    let parsed: ClientMsg;
    try {
      const raw = JSON.parse(text);
      parsed = clientMsgSchema.parse(raw);
    } catch (_err) {
      this.sendTo(ws, { type: 'nack', clientMsgId: 'unknown', reason: 'invalid' });
      return;
    }

    try {
      switch (parsed.type) {
        case 'hello': {
          const [cards, columns, groups] = await Promise.all([
            listCards(this.env.DB, attachment.boardId, attachment.userId),
            listBoardColumns(this.env.DB, attachment.boardId),
            listGroupsForBoard(this.env.DB, attachment.boardId),
          ]);
          this.sendTo(ws, { type: 'snapshot', cards, columns, groups });
          this.sendTo(ws, { type: 'ack', clientMsgId: parsed.clientMsgId, ok: true });
          return;
        }
        case 'create_card': {
          try {
            await this.opCreateCard(
              {
                column: parsed.column,
                title: parsed.title,
                groups: parsed.groups,
                assigneeUserIds: parsed.assigneeUserIds,
                assigned: parsed.assigned ?? null,
                notes: parsed.notes ?? null,
                startDate: parsed.startDate ?? null,
                dueDate: parsed.dueDate ?? null,
                dueTime: parsed.dueTime ?? null,
                coverColor: parsed.coverColor ?? null,
              },
              attachment.userId,
              attachment.isStaff,
              attachment.boardId
            );
            this.sendTo(ws, { type: 'ack', clientMsgId: parsed.clientMsgId, ok: true });
          } catch (err) {
            this.sendOpError(ws, parsed.clientMsgId, err);
          }
          return;
        }
        case 'update_card': {
          try {
            await this.opUpdateCard(
              { id: parsed.id, version: parsed.version, patch: parsed.patch },
              attachment.userId,
              attachment.isStaff,
              attachment.boardId
            );
            this.sendTo(ws, { type: 'ack', clientMsgId: parsed.clientMsgId, ok: true });
          } catch (err) {
            this.sendOpError(ws, parsed.clientMsgId, err);
          }
          return;
        }
        case 'move_card': {
          try {
            await this.opMoveCard(
              {
                id: parsed.id,
                version: parsed.version,
                toColumn: parsed.toColumn,
                toPosition: parsed.toPosition,
              },
              attachment.userId
            );
            this.sendTo(ws, { type: 'ack', clientMsgId: parsed.clientMsgId, ok: true });
          } catch (err) {
            this.sendOpError(ws, parsed.clientMsgId, err);
          }
          return;
        }
        case 'delete_card': {
          try {
            await this.opDeleteCard({ id: parsed.id, version: parsed.version });
            this.sendTo(ws, { type: 'ack', clientMsgId: parsed.clientMsgId, ok: true });
          } catch (err) {
            this.sendOpError(ws, parsed.clientMsgId, err);
          }
          return;
        }
        case 'archive_card': {
          try {
            await this.opArchiveCard(
              { id: parsed.id, version: parsed.version },
              attachment.userId
            );
            this.sendTo(ws, { type: 'ack', clientMsgId: parsed.clientMsgId, ok: true });
          } catch (err) {
            this.sendOpError(ws, parsed.clientMsgId, err);
          }
          return;
        }
        case 'unarchive_card': {
          try {
            await this.opUnarchiveCard(
              { id: parsed.id, version: parsed.version },
              attachment.userId
            );
            this.sendTo(ws, { type: 'ack', clientMsgId: parsed.clientMsgId, ok: true });
          } catch (err) {
            this.sendOpError(ws, parsed.clientMsgId, err);
          }
          return;
        }
        case 'list_archived': {
          const cards = await listArchivedCards(this.env.DB, attachment.boardId);
          this.sendTo(ws, { type: 'archived_snapshot', cards });
          this.sendTo(ws, { type: 'ack', clientMsgId: parsed.clientMsgId, ok: true });
          return;
        }
        case 'list_card_events': {
          const events = await listCardEvents(this.env.DB, parsed.cardId);
          this.sendTo(ws, {
            type: 'card_events_snapshot',
            cardId: parsed.cardId,
            events,
          });
          this.sendTo(ws, { type: 'ack', clientMsgId: parsed.clientMsgId, ok: true });
          return;
        }
        case 'list_comments': {
          const comments = await listComments(this.env.DB, parsed.cardId);
          this.sendTo(ws, {
            type: 'comments_snapshot',
            cardId: parsed.cardId,
            comments,
          });
          this.sendTo(ws, { type: 'ack', clientMsgId: parsed.clientMsgId, ok: true });
          return;
        }
        case 'create_comment': {
          try {
            await this.opCreateComment(
              { cardId: parsed.cardId, body: parsed.body },
              attachment.userId
            );
            this.sendTo(ws, { type: 'ack', clientMsgId: parsed.clientMsgId, ok: true });
          } catch (err) {
            this.sendOpError(ws, parsed.clientMsgId, err);
          }
          return;
        }
        case 'update_comment': {
          try {
            await this.opUpdateComment(
              { id: parsed.id, body: parsed.body },
              attachment.userId
            );
            this.sendTo(ws, { type: 'ack', clientMsgId: parsed.clientMsgId, ok: true });
          } catch (err) {
            this.sendOpError(ws, parsed.clientMsgId, err);
          }
          return;
        }
        case 'list_checklist_items': {
          const items = await listChecklistItems(this.env.DB, parsed.cardId);
          this.sendTo(ws, {
            type: 'checklist_items_snapshot',
            cardId: parsed.cardId,
            items,
          });
          this.sendTo(ws, { type: 'ack', clientMsgId: parsed.clientMsgId, ok: true });
          return;
        }
        case 'create_checklist_item': {
          try {
            await this.opCreateChecklistItem({ cardId: parsed.cardId, body: parsed.body });
            this.sendTo(ws, { type: 'ack', clientMsgId: parsed.clientMsgId, ok: true });
          } catch (err) {
            this.sendOpError(ws, parsed.clientMsgId, err);
          }
          return;
        }
        case 'update_checklist_item': {
          try {
            await this.opUpdateChecklistItem({
              id: parsed.id,
              body: parsed.body,
              completed: parsed.completed,
            });
            this.sendTo(ws, { type: 'ack', clientMsgId: parsed.clientMsgId, ok: true });
          } catch (err) {
            this.sendOpError(ws, parsed.clientMsgId, err);
          }
          return;
        }
        case 'delete_checklist_item': {
          try {
            await this.opDeleteChecklistItem({ id: parsed.id });
            this.sendTo(ws, { type: 'ack', clientMsgId: parsed.clientMsgId, ok: true });
          } catch (err) {
            this.sendOpError(ws, parsed.clientMsgId, err);
          }
          return;
        }
        case 'add_column': {
          try {
            await this.opAddColumn(
              { key: parsed.key, label: parsed.label },
              attachment.isStaff,
              attachment.boardId
            );
            this.sendTo(ws, { type: 'ack', clientMsgId: parsed.clientMsgId, ok: true });
          } catch (err) {
            this.sendOpError(ws, parsed.clientMsgId, err);
          }
          return;
        }
        case 'rename_column': {
          try {
            await this.opRenameColumn(
              { column: parsed.column, label: parsed.label },
              attachment.isStaff,
              attachment.boardId
            );
            this.sendTo(ws, { type: 'ack', clientMsgId: parsed.clientMsgId, ok: true });
          } catch (err) {
            this.sendOpError(ws, parsed.clientMsgId, err);
          }
          return;
        }
        case 'delete_column': {
          try {
            await this.opDeleteColumn(
              { column: parsed.column },
              attachment.isStaff,
              attachment.boardId
            );
            this.sendTo(ws, { type: 'ack', clientMsgId: parsed.clientMsgId, ok: true });
          } catch (err) {
            this.sendOpError(ws, parsed.clientMsgId, err);
          }
          return;
        }
        case 'move_column': {
          try {
            await this.opMoveColumn(
              { order: parsed.order },
              attachment.isStaff,
              attachment.boardId
            );
            this.sendTo(ws, { type: 'ack', clientMsgId: parsed.clientMsgId, ok: true });
          } catch (err) {
            this.sendOpError(ws, parsed.clientMsgId, err);
          }
          return;
        }
        case 'list_templates': {
          const templates = await listTemplatesForBoard(this.env.DB, attachment.boardId);
          this.sendTo(ws, { type: 'templates_snapshot', templates });
          this.sendTo(ws, { type: 'ack', clientMsgId: parsed.clientMsgId, ok: true });
          return;
        }
        case 'save_template': {
          const payload = parsed.payload as CardTemplatePayload;
          // Normalize cover color server-side, same as direct card edits,
          // so a snapshot from an old client gets the canonical form.
          if (payload.coverColor) {
            payload.coverColor = normalizeHexColor(payload.coverColor) ?? null;
          }
          const tpl = await createTemplate(
            this.env.DB,
            attachment.boardId,
            attachment.userId,
            { name: parsed.name, payload }
          );
          if (!tpl) {
            this.sendTo(ws, { type: 'nack', clientMsgId: parsed.clientMsgId, reason: 'invalid' });
            return;
          }
          this.broadcast({ type: 'template_created', template: tpl });
          this.sendTo(ws, { type: 'ack', clientMsgId: parsed.clientMsgId, ok: true });
          return;
        }
        case 'create_from_template': {
          // Re-fetch templates rather than caching — a delete from
          // another client could otherwise materialize a tombstoned one.
          const templates = await listTemplatesForBoard(this.env.DB, attachment.boardId);
          const tpl = templates.find((t) => t.id === parsed.templateId);
          if (!tpl) {
            this.sendTo(ws, { type: 'nack', clientMsgId: parsed.clientMsgId, reason: 'not_found' });
            return;
          }
          const card = await createCardFromTemplate(
            this.env.DB,
            attachment.boardId,
            tpl,
            parsed.column,
            attachment.userId,
            parsed.titleOverride
          );
          this.broadcast({ type: 'card_created', card });
          await this.emitCardEvent(card.id, attachment.userId, 'card.created', {
            column: card.column,
            position: card.position,
            fromTemplate: tpl.name,
          });
          this.sendTo(ws, { type: 'ack', clientMsgId: parsed.clientMsgId, ok: true });
          return;
        }
        case 'delete_template': {
          const ok = await deleteTemplate(
            this.env.DB,
            parsed.id,
            attachment.userId,
            attachment.isAdmin
          );
          if (!ok) {
            this.sendTo(ws, { type: 'nack', clientMsgId: parsed.clientMsgId, reason: 'forbidden' });
            return;
          }
          this.broadcast({ type: 'template_deleted', id: parsed.id });
          this.sendTo(ws, { type: 'ack', clientMsgId: parsed.clientMsgId, ok: true });
          return;
        }
        case 'set_column_color': {
          try {
            await this.opSetColumnColor(
              { column: parsed.column, color: parsed.color },
              attachment.isStaff,
              attachment.boardId
            );
            this.sendTo(ws, { type: 'ack', clientMsgId: parsed.clientMsgId, ok: true });
          } catch (err) {
            this.sendOpError(ws, parsed.clientMsgId, err);
          }
          return;
        }
        case 'set_group_color': {
          try {
            await this.opSetGroupColor(
              { name: parsed.name, color: parsed.color },
              attachment.isStaff,
              attachment.boardId
            );
            this.sendTo(ws, { type: 'ack', clientMsgId: parsed.clientMsgId, ok: true });
          } catch (err) {
            this.sendOpError(ws, parsed.clientMsgId, err);
          }
          return;
        }
        case 'create_group': {
          try {
            await this.opCreateGroup(
              { name: parsed.name, color: parsed.color },
              attachment.isStaff,
              attachment.boardId
            );
            this.sendTo(ws, { type: 'ack', clientMsgId: parsed.clientMsgId, ok: true });
          } catch (err) {
            this.sendOpError(ws, parsed.clientMsgId, err);
          }
          return;
        }
        case 'rename_group': {
          try {
            await this.opRenameGroup(
              { oldName: parsed.oldName, newName: parsed.newName },
              attachment.userId,
              attachment.isStaff,
              attachment.boardId
            );
            this.sendTo(ws, { type: 'ack', clientMsgId: parsed.clientMsgId, ok: true });
          } catch (err) {
            this.sendOpError(ws, parsed.clientMsgId, err);
          }
          return;
        }
        case 'delete_group': {
          try {
            await this.opDeleteGroup(
              { name: parsed.name },
              attachment.userId,
              attachment.isStaff,
              attachment.boardId
            );
            this.sendTo(ws, { type: 'ack', clientMsgId: parsed.clientMsgId, ok: true });
          } catch (err) {
            this.sendOpError(ws, parsed.clientMsgId, err);
          }
          return;
        }
        case 'list_groups': {
          const [groups, counts] = await Promise.all([
            listGroupsForBoard(this.env.DB, attachment.boardId),
            countCardsPerGroup(this.env.DB, attachment.boardId),
          ]);
          this.sendTo(ws, { type: 'groups_snapshot', groups, counts });
          this.sendTo(ws, { type: 'ack', clientMsgId: parsed.clientMsgId, ok: true });
          return;
        }
        case 'mark_card_viewed': {
          await markCardViewed(this.env.DB, attachment.userId, parsed.cardId);
          // User-scoped fanout: only the same user's other open sockets
          // should clear their unread dot. Other users' sockets keep
          // their own per-user state.
          this.broadcastToUser(attachment.userId, {
            type: 'card_view_marked',
            cardId: parsed.cardId,
            userId: attachment.userId,
          });
          this.sendTo(ws, { type: 'ack', clientMsgId: parsed.clientMsgId, ok: true });
          return;
        }
        case 'set_wip_limit': {
          try {
            await this.opSetWipLimit(
              { column: parsed.column, wipLimit: parsed.wipLimit },
              attachment.isStaff,
              attachment.boardId
            );
            this.sendTo(ws, { type: 'ack', clientMsgId: parsed.clientMsgId, ok: true });
          } catch (err) {
            this.sendOpError(ws, parsed.clientMsgId, err);
          }
          return;
        }
        case 'delete_comment': {
          try {
            await this.opDeleteComment(
              { id: parsed.id },
              attachment.userId,
              attachment.isAdmin
            );
            this.sendTo(ws, { type: 'ack', clientMsgId: parsed.clientMsgId, ok: true });
          } catch (err) {
            this.sendOpError(ws, parsed.clientMsgId, err);
          }
          return;
        }
      }
    } catch (err) {
      console.error('kanban DO message error:', err);
      this.sendTo(ws, {
        type: 'nack',
        clientMsgId: parsed.clientMsgId,
        reason: 'db_error',
      });
    }
  }

  async webSocketClose(
    _ws: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean
  ): Promise<void> {
    // Nothing durable to clean; D1 is the source of truth.
  }

  async webSocketError(_ws: WebSocket, error: unknown): Promise<void> {
    console.error('kanban DO websocket error:', error);
  }

  /**
   * Insert in-app notifications for users mentioned in a comment body.
   * Self-mentions are skipped (the actor doesn't notify themselves).
   * Errors are swallowed for the same reason as emitCardEvent — we don't
   * want notification failures to mask the comment write itself.
   */
  private async fanOutMentionNotifications(
    body: string,
    actorUserId: number,
    cardId: number,
    commentId: number,
    cardTitle: string | null
  ): Promise<void> {
    try {
      const directory = await listActiveUserDirectory(this.env.DB);
      const userIds = parseMentions(
        body,
        directory.map((u) => ({ userId: u.userId, email: u.email }))
      );
      for (const uid of userIds) {
        if (uid === actorUserId) continue;
        await createNotification(this.env.DB, {
          userId: uid,
          kind: 'mention.comment',
          cardId,
          commentId,
          actorUserId,
          metadata: { cardTitle: cardTitle ?? undefined },
        });
      }
    } catch (err) {
      console.error('fanOutMentionNotifications failed:', err);
    }
  }

  /**
   * Insert assignment notifications for users newly added to a card's
   * assignee set. `previousIds` is the pre-mutation set; we diff against
   * `currentIds` and notify only the additions. Self-assignments don't
   * notify the actor.
   */
  private async fanOutAssignmentNotifications(
    cardId: number,
    actorUserId: number,
    previousIds: number[],
    currentIds: number[],
    cardTitle: string | null
  ): Promise<void> {
    try {
      const prev = new Set(previousIds);
      const added = currentIds.filter((id) => !prev.has(id) && id !== actorUserId);
      for (const uid of added) {
        await createNotification(this.env.DB, {
          userId: uid,
          kind: 'card.assigned',
          cardId,
          actorUserId,
          metadata: { cardTitle: cardTitle ?? undefined },
        });
      }
    } catch (err) {
      console.error('fanOutAssignmentNotifications failed:', err);
    }
  }

  /**
   * Write an activity-log row for a card and broadcast it to every socket on
   * this board. The actor is passed explicitly by the handler (via the
   * socket's attachment) — we can't infer it here. Swallows errors so a
   * logging failure never masks a successful mutation — missing events are
   * less bad than failed writes.
   */
  private async emitCardEvent(
    cardId: number,
    userId: number | null,
    kind: Parameters<typeof logCardEvent>[1]['kind'],
    metadata?: Record<string, unknown>
  ): Promise<void> {
    let event: CardEventDto;
    try {
      event = await logCardEvent(this.env.DB, { cardId, userId, kind, metadata });
    } catch (err) {
      console.error('logCardEvent failed:', err);
      return;
    }
    this.broadcast({ type: 'card_event', event });
  }

  /**
   * Strip group names from an inbound card patch when the user isn't
   * staff and the name doesn't yet exist as a kanban_groups row for this
   * board. This is the server-side gate for the staff-only label-
   * creation policy: non-staff can attach existing labels but can't mint
   * new ones via card edits, even if a malicious client sends fresh
   * names. Staff requests pass through unchanged. Empty / undefined
   * input returns input unchanged.
   */
  private async filterAttachableGroups(
    boardId: number,
    isStaff: boolean,
    groups: string[] | undefined
  ): Promise<string[] | undefined> {
    if (!groups || groups.length === 0) return groups;
    if (isStaff) return groups;
    const existing = await listGroupsForBoard(this.env.DB, boardId);
    const allowed = new Set(existing.map((g) => g.name.toLowerCase()));
    return groups.filter((g) => allowed.has(g.trim().toLowerCase()));
  }

  private async readVersion(id: number): Promise<number | null> {
    const row = await this.env.DB.prepare(
      `SELECT version FROM kanban_cards WHERE id = ?`
    )
      .bind(id)
      .first<{ version: number }>();
    return row ? row.version : null;
  }

  private sendTo(ws: WebSocket, payload: unknown): void {
    try {
      ws.send(JSON.stringify(payload));
    } catch {
      // Dead socket — close handler (if any) will tidy up.
    }
  }

  /**
   * Translate an op-method error into a nack frame on the originating
   * socket. The case bodies in webSocketMessage call this in their catch
   * blocks so the WS wire shape is unchanged from before the refactor.
   */
  private sendOpError(ws: WebSocket, clientMsgId: string, err: unknown): void {
    if (err instanceof OpForbiddenError) {
      this.sendTo(ws, { type: 'nack', clientMsgId, reason: 'forbidden' });
      return;
    }
    if (err instanceof OpNotFoundError) {
      this.sendTo(ws, { type: 'nack', clientMsgId, reason: 'not_found' });
      return;
    }
    if (err instanceof OpVersionConflictError) {
      this.sendTo(ws, {
        type: 'nack',
        clientMsgId,
        reason: err.currentVersion === null ? 'not_found' : 'version_conflict',
        currentVersion: err.currentVersion ?? undefined,
      });
      return;
    }
    if (err instanceof KanbanColumnLimitError) {
      this.sendTo(ws, { type: 'nack', clientMsgId, reason: 'column_limit', limit: err.limit });
      return;
    }
    if (err instanceof OpInvalidError) {
      this.sendTo(ws, { type: 'nack', clientMsgId, reason: err.message || 'invalid' });
      return;
    }
    // Unknown error — log and return a generic db_error nack so the
    // client surfaces "something went wrong" instead of hanging.
    console.error('kanban DO op error:', err);
    this.sendTo(ws, { type: 'nack', clientMsgId, reason: 'db_error' });
  }

  private broadcast(payload: unknown): void {
    const json = JSON.stringify(payload);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(json);
      } catch {
        // Dead socket
      }
    }
  }

  /** Send to every socket currently attached for a single user.
   *  Used for per-user notifications (e.g. clearing the unread-comments
   *  dot on the user's other open tabs after they view a card). */
  private broadcastToUser(userId: number, payload: unknown): void {
    const json = JSON.stringify(payload);
    for (const ws of this.ctx.getWebSockets()) {
      const att = (ws.deserializeAttachment() as SocketAttachment | null) ?? null;
      if (!att || att.userId !== userId) continue;
      try {
        ws.send(json);
      } catch {
        // Dead socket
      }
    }
  }

  // ── Op methods (RPC + WebSocket call into these) ─────────────────────
  //
  // Each method below is the single source of truth for one write
  // operation. The WebSocket message handler in webSocketMessage() calls
  // these and translates thrown errors into nack frames; the MCP server
  // (src/mcp/*) calls these directly via Durable Object RPC and lets
  // errors propagate to the JSON-RPC tool response.
  //
  // Side effects (broadcast, audit log, notifications) happen inside
  // the op method, NOT at the call site, so both callers always trigger
  // them consistently.

  // ── Card ops ─────────────────────────────────────────────────────────

  async opCreateCard(
    input: {
      column: ColumnName;
      title: string;
      groups?: string[];
      assigneeUserIds?: number[];
      assigned?: string | null;
      notes?: string | null;
      startDate?: string | null;
      dueDate?: string | null;
      dueTime?: string | null;
      coverColor?: string | null;
    },
    actorUserId: number,
    actorIsStaff: boolean,
    boardId: number
  ): Promise<CardDto> {
    const filteredGroups = await this.filterAttachableGroups(
      boardId,
      actorIsStaff,
      input.groups
    );
    const card = await createCard(
      this.env.DB,
      boardId,
      {
        column: input.column,
        title: input.title,
        groups: filteredGroups,
        assigneeUserIds: input.assigneeUserIds,
        assigned: input.assigned ?? null,
        notes: input.notes ?? null,
        startDate: input.startDate ?? null,
        dueDate: input.dueDate ?? null,
        dueTime: input.dueTime ?? null,
        coverColor: input.coverColor
          ? normalizeHexColor(input.coverColor)
          : (input.coverColor ?? null),
      },
      actorUserId
    );
    this.broadcast({ type: 'card_created', card });
    await this.emitCardEvent(card.id, actorUserId, 'card.created', {
      column: card.column,
      position: card.position,
    });
    await this.fanOutAssignmentNotifications(
      card.id,
      actorUserId,
      [],
      card.assignees.map((a) => a.userId),
      card.title
    );
    return card;
  }

  async opUpdateCard(
    input: {
      id: number;
      version: number;
      patch: {
        title?: string;
        groups?: string[];
        assigneeUserIds?: number[];
        assigned?: string | null;
        notes?: string | null;
        startDate?: string | null;
        dueDate?: string | null;
        dueTime?: string | null;
        coverColor?: string | null;
      };
    },
    actorUserId: number,
    actorIsStaff: boolean,
    boardId: number
  ): Promise<CardDto> {
    let priorAssigneeIds: number[] | null = null;
    if (input.patch.assigneeUserIds !== undefined) {
      const before = await this.env.DB
        .prepare(`SELECT user_id FROM kanban_card_assignees WHERE card_id = ?`)
        .bind(input.id)
        .all<{ user_id: number }>();
      priorAssigneeIds = (before.results ?? []).map((r) => r.user_id);
    }

    let normalizedPatch = input.patch.coverColor !== undefined
      ? {
          ...input.patch,
          coverColor: input.patch.coverColor ? normalizeHexColor(input.patch.coverColor) : null,
        }
      : input.patch;
    if (normalizedPatch.groups !== undefined) {
      normalizedPatch = {
        ...normalizedPatch,
        groups: await this.filterAttachableGroups(
          boardId,
          actorIsStaff,
          normalizedPatch.groups
        ),
      };
    }
    const updated = await updateCard(
      this.env.DB,
      input.id,
      input.version,
      normalizedPatch,
      actorUserId
    );
    if (!updated) {
      throw new OpVersionConflictError(await this.readVersion(input.id));
    }
    this.broadcast({ type: 'card_updated', card: updated });
    const changedFields = Object.keys(input.patch);
    if (changedFields.length > 0) {
      await this.emitCardEvent(updated.id, actorUserId, 'card.updated', { changedFields });
    }
    if (priorAssigneeIds !== null) {
      await this.fanOutAssignmentNotifications(
        updated.id,
        actorUserId,
        priorAssigneeIds,
        updated.assignees.map((a) => a.userId),
        updated.title
      );
    }
    return updated;
  }

  async opMoveCard(
    input: { id: number; version: number; toColumn: ColumnName; toPosition: number },
    actorUserId: number
  ): Promise<{ card: CardDto; fromColumn: ColumnName; toColumn: ColumnName; affected: Array<{ id: number; position: number }> }> {
    const result = await moveCard(
      this.env.DB,
      input.id,
      input.version,
      input.toColumn,
      input.toPosition,
      actorUserId
    );
    if (!result) {
      throw new OpVersionConflictError(await this.readVersion(input.id));
    }
    this.broadcast({
      type: 'card_moved',
      card: result.card,
      fromColumn: result.fromColumn,
      toColumn: result.toColumn,
      positions: result.affected,
    });
    if (result.fromColumn !== result.toColumn) {
      await this.emitCardEvent(result.card.id, actorUserId, 'card.moved', {
        fromColumn: result.fromColumn,
        toColumn: result.toColumn,
        toPosition: result.card.position,
      });
    }
    return result;
  }

  async opDeleteCard(
    input: { id: number; version: number }
  ): Promise<void> {
    const ok = await deleteCard(this.env.DB, input.id, input.version);
    if (!ok) {
      throw new OpVersionConflictError(await this.readVersion(input.id));
    }
    this.broadcast({ type: 'card_deleted', id: input.id });
  }

  async opArchiveCard(
    input: { id: number; version: number },
    actorUserId: number
  ): Promise<{ card: CardDto; column: ColumnName; affected: Array<{ id: number; position: number }> }> {
    const result = await archiveCard(this.env.DB, input.id, input.version, actorUserId);
    if (!result) {
      throw new OpVersionConflictError(await this.readVersion(input.id));
    }
    this.broadcast({
      type: 'card_archived',
      card: result.card,
      column: result.column,
      positions: result.affected,
    });
    await this.emitCardEvent(result.card.id, actorUserId, 'card.archived', {
      column: result.column,
    });
    return result;
  }

  async opUnarchiveCard(
    input: { id: number; version: number },
    actorUserId: number
  ): Promise<{ card: CardDto; column: ColumnName; affected: Array<{ id: number; position: number }> }> {
    const result = await unarchiveCard(this.env.DB, input.id, input.version, actorUserId);
    if (!result) {
      throw new OpVersionConflictError(await this.readVersion(input.id));
    }
    this.broadcast({
      type: 'card_unarchived',
      card: result.card,
      column: result.column,
      positions: result.affected,
    });
    await this.emitCardEvent(result.card.id, actorUserId, 'card.unarchived', {
      column: result.column,
    });
    return result;
  }

  // ── Comment ops ──────────────────────────────────────────────────────

  async opCreateComment(
    input: { cardId: number; body: string },
    actorUserId: number
  ): Promise<Awaited<ReturnType<typeof createComment>>> {
    const comment = await createComment(this.env.DB, input.cardId, input.body, actorUserId);
    this.broadcast({ type: 'comment_created', comment });
    await this.emitCardEvent(input.cardId, actorUserId, 'card.updated', {
      changedFields: ['comments'],
      commentId: comment.id,
    });
    const titleRow = await this.env.DB
      .prepare(`SELECT title FROM kanban_cards WHERE id = ?`)
      .bind(input.cardId)
      .first<{ title: string }>();
    await this.fanOutMentionNotifications(
      input.body,
      actorUserId,
      input.cardId,
      comment.id,
      titleRow?.title ?? null
    );
    return comment;
  }

  async opUpdateComment(
    input: { id: number; body: string },
    actorUserId: number
  ): Promise<Awaited<ReturnType<typeof updateComment>>> {
    const updated = await updateComment(this.env.DB, input.id, input.body, actorUserId);
    if (!updated) throw new OpNotFoundError();
    this.broadcast({ type: 'comment_updated', comment: updated });
    return updated;
  }

  async opDeleteComment(
    input: { id: number },
    actorUserId: number,
    actorIsAdmin: boolean
  ): Promise<{ id: number; cardId: number }> {
    const existing = await getComment(this.env.DB, input.id);
    if (!existing) throw new OpNotFoundError();
    const ref = await deleteComment(this.env.DB, input.id, actorUserId, actorIsAdmin);
    if (!ref) throw new OpForbiddenError();
    this.broadcast({ type: 'comment_deleted', id: ref.id, cardId: ref.cardId });
    return ref;
  }

  // ── Checklist ops ────────────────────────────────────────────────────

  async opCreateChecklistItem(
    input: { cardId: number; body: string }
  ): Promise<Awaited<ReturnType<typeof createChecklistItem>>> {
    const item = await createChecklistItem(this.env.DB, input.cardId, input.body);
    this.broadcast({ type: 'checklist_item_created', item });
    return item;
  }

  async opUpdateChecklistItem(
    input: { id: number; body?: string; completed?: boolean }
  ): Promise<NonNullable<Awaited<ReturnType<typeof updateChecklistItem>>>> {
    const updated = await updateChecklistItem(this.env.DB, input.id, {
      body: input.body,
      completed: input.completed,
    });
    if (!updated) throw new OpNotFoundError();
    this.broadcast({ type: 'checklist_item_updated', item: updated });
    return updated;
  }

  async opDeleteChecklistItem(
    input: { id: number }
  ): Promise<{ id: number; cardId: number }> {
    const ref = await deleteChecklistItem(this.env.DB, input.id);
    if (!ref) throw new OpNotFoundError();
    this.broadcast({ type: 'checklist_item_deleted', id: ref.id, cardId: ref.cardId });
    return ref;
  }

  // ── Column ops (staff-only) ──────────────────────────────────────────

  async opAddColumn(
    input: { key: string; label: string },
    actorIsStaff: boolean,
    boardId: number
  ): Promise<NonNullable<Awaited<ReturnType<typeof addBoardColumn>>>> {
    if (!actorIsStaff) throw new OpForbiddenError();
    // addBoardColumn throws KanbanColumnLimitError on cap; let it propagate.
    const config = await addBoardColumn(this.env.DB, boardId, input.key, input.label);
    if (!config) throw new OpInvalidError();
    this.broadcast({ type: 'column_added', column: config });
    return config;
  }

  async opRenameColumn(
    input: { column: ColumnName; label: string },
    actorIsStaff: boolean,
    boardId: number
  ): Promise<NonNullable<Awaited<ReturnType<typeof renameBoardColumn>>>> {
    if (!actorIsStaff) throw new OpForbiddenError();
    const config = await renameBoardColumn(this.env.DB, boardId, input.column, input.label);
    if (!config) throw new OpNotFoundError();
    this.broadcast({ type: 'column_renamed', column: config });
    return config;
  }

  async opDeleteColumn(
    input: { column: ColumnName },
    actorIsStaff: boolean,
    boardId: number
  ): Promise<void> {
    if (!actorIsStaff) throw new OpForbiddenError();
    const result = await removeBoardColumn(this.env.DB, boardId, input.column);
    if (!result.ok) throw new OpInvalidError(result.reason ?? 'invalid');
    this.broadcast({ type: 'column_removed', column: input.column });
  }

  async opMoveColumn(
    input: { order: ColumnName[] },
    actorIsStaff: boolean,
    boardId: number
  ): Promise<NonNullable<Awaited<ReturnType<typeof reorderBoardColumns>>>> {
    if (!actorIsStaff) throw new OpForbiddenError();
    const cols = await reorderBoardColumns(this.env.DB, boardId, input.order);
    if (!cols) throw new OpInvalidError();
    this.broadcast({ type: 'columns_reordered', columns: cols });
    return cols;
  }

  async opSetColumnColor(
    input: { column: ColumnName; color: string | null | undefined },
    actorIsStaff: boolean,
    boardId: number
  ): Promise<NonNullable<Awaited<ReturnType<typeof setColumnColor>>>> {
    if (!actorIsStaff) throw new OpForbiddenError();
    const norm = input.color ? normalizeHexColor(input.color) : null;
    const config = await setColumnColor(this.env.DB, boardId, input.column, norm);
    if (!config) throw new OpNotFoundError();
    this.broadcast({ type: 'column_config_updated', column: config });
    return config;
  }

  async opSetWipLimit(
    input: { column: ColumnName; wipLimit: number | null },
    actorIsStaff: boolean,
    boardId: number
  ): Promise<NonNullable<Awaited<ReturnType<typeof setColumnWipLimit>>>> {
    if (!actorIsStaff) throw new OpForbiddenError();
    const config = await setColumnWipLimit(this.env.DB, boardId, input.column, input.wipLimit);
    if (!config) throw new OpNotFoundError();
    this.broadcast({ type: 'column_config_updated', column: config });
    return config;
  }

  // ── Label / group ops (staff-only) ───────────────────────────────────

  async opCreateGroup(
    input: { name: string; color?: string | null | undefined },
    actorIsStaff: boolean,
    boardId: number
  ): Promise<NonNullable<Awaited<ReturnType<typeof createGroup>>>> {
    if (!actorIsStaff) throw new OpForbiddenError();
    const norm = input.color ? normalizeHexColor(input.color) : null;
    const group = await createGroup(this.env.DB, boardId, input.name, norm ?? null);
    if (!group) throw new OpInvalidError();
    this.broadcast({ type: 'group_created', group });
    return group;
  }

  async opRenameGroup(
    input: { oldName: string; newName: string },
    actorUserId: number,
    actorIsStaff: boolean,
    boardId: number
  ): Promise<NonNullable<Awaited<ReturnType<typeof renameGroup>>>> {
    if (!actorIsStaff) throw new OpForbiddenError();
    const result = await renameGroup(this.env.DB, boardId, input.oldName, input.newName);
    if (!result) throw new OpInvalidError();
    this.broadcast({
      type: 'group_renamed',
      oldName: result.old,
      group: result.group,
    });
    for (const cardId of result.affectedCardIds) {
      await this.emitCardEvent(cardId, actorUserId, 'card.updated', {
        changedFields: ['groups'],
        labelOp: 'renamed',
        oldName: result.old,
        newName: result.group.name,
      });
    }
    return result;
  }

  async opDeleteGroup(
    input: { name: string },
    actorUserId: number,
    actorIsStaff: boolean,
    boardId: number
  ): Promise<{ ok: true; affectedCardIds: number[] }> {
    if (!actorIsStaff) throw new OpForbiddenError();
    const result = await deleteGroup(this.env.DB, boardId, input.name);
    if (!result.ok) throw new OpNotFoundError();
    this.broadcast({ type: 'group_deleted', name: input.name });
    for (const cardId of result.affectedCardIds) {
      await this.emitCardEvent(cardId, actorUserId, 'card.updated', {
        changedFields: ['groups'],
        labelOp: 'deleted',
        labelName: input.name,
      });
    }
    return { ok: true, affectedCardIds: result.affectedCardIds };
  }

  async opSetGroupColor(
    input: { name: string; color: string | null | undefined },
    actorIsStaff: boolean,
    boardId: number
  ): Promise<NonNullable<Awaited<ReturnType<typeof setGroupColor>>>> {
    if (!actorIsStaff) throw new OpForbiddenError();
    const norm = input.color ? normalizeHexColor(input.color) : null;
    const group = await setGroupColor(this.env.DB, boardId, input.name, norm);
    if (!group) throw new OpInvalidError();
    this.broadcast({ type: 'group_color_updated', group });
    return group;
  }
}
