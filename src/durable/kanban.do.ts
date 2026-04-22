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
  KANBAN_COLUMNS,
  archiveCard,
  createCard,
  createChecklistItem,
  createComment,
  deleteCard,
  deleteChecklistItem,
  deleteComment,
  getComment,
  listActiveUserDirectory,
  listArchivedCards,
  listBoardColumns,
  listCardEvents,
  listCards,
  listChecklistItems,
  listComments,
  logCardEvent,
  moveCard,
  setColumnWipLimit,
  unarchiveCard,
  updateCard,
  updateChecklistItem,
  updateComment,
  type CardDto,
  type CardEventDto,
  type ColumnName,
} from '../services/kanban.service';
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

const columnEnum = z.enum(KANBAN_COLUMNS);

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
    const [cards, columns] = await Promise.all([
      listCards(this.env.DB, boardId),
      listBoardColumns(this.env.DB, boardId),
    ]);
    server.send(
      JSON.stringify({ type: 'snapshot', cards: cards.map(cardToDto), columns })
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
          const [cards, columns] = await Promise.all([
            listCards(this.env.DB, attachment.boardId),
            listBoardColumns(this.env.DB, attachment.boardId),
          ]);
          this.sendTo(ws, { type: 'snapshot', cards, columns });
          this.sendTo(ws, { type: 'ack', clientMsgId: parsed.clientMsgId, ok: true });
          return;
        }
        case 'create_card': {
          const card = await createCard(
            this.env.DB,
            attachment.boardId,
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
            },
            attachment.userId
          );
          this.broadcast({ type: 'card_created', card });
          await this.emitCardEvent(card.id, attachment.userId, 'card.created', {
            column: card.column,
            position: card.position,
          });
          // New card → every assignee is "newly assigned" relative to the
          // (empty) prior state.
          await this.fanOutAssignmentNotifications(
            card.id,
            attachment.userId,
            [],
            card.assignees.map((a) => a.userId),
            card.title
          );
          this.sendTo(ws, { type: 'ack', clientMsgId: parsed.clientMsgId, ok: true });
          return;
        }
        case 'update_card': {
          // Capture the prior assignee set before the update so we can
          // diff and only notify newly-added users (not everyone in the
          // post-update set, which would re-notify on every edit).
          let priorAssigneeIds: number[] | null = null;
          if (parsed.patch.assigneeUserIds !== undefined) {
            const before = await this.env.DB
              .prepare(
                `SELECT user_id FROM kanban_card_assignees WHERE card_id = ?`
              )
              .bind(parsed.id)
              .all<{ user_id: number }>();
            priorAssigneeIds = (before.results ?? []).map((r) => r.user_id);
          }

          const updated = await updateCard(
            this.env.DB,
            parsed.id,
            parsed.version,
            parsed.patch,
            attachment.userId
          );
          if (!updated) {
            const cur = await this.readVersion(parsed.id);
            this.sendTo(ws, {
              type: 'nack',
              clientMsgId: parsed.clientMsgId,
              reason: cur === null ? 'not_found' : 'version_conflict',
              currentVersion: cur ?? undefined,
            });
            return;
          }
          this.broadcast({ type: 'card_updated', card: updated });
          // Derive which fields were touched from the patch so the timeline
          // can show "Updated title, notes" rather than a generic "edited".
          const changedFields = Object.keys(parsed.patch);
          if (changedFields.length > 0) {
            await this.emitCardEvent(updated.id, attachment.userId, 'card.updated', { changedFields });
          }
          if (priorAssigneeIds !== null) {
            await this.fanOutAssignmentNotifications(
              updated.id,
              attachment.userId,
              priorAssigneeIds,
              updated.assignees.map((a) => a.userId),
              updated.title
            );
          }
          this.sendTo(ws, { type: 'ack', clientMsgId: parsed.clientMsgId, ok: true });
          return;
        }
        case 'move_card': {
          const result = await moveCard(
            this.env.DB,
            parsed.id,
            parsed.version,
            parsed.toColumn,
            parsed.toPosition,
            attachment.userId
          );
          if (!result) {
            const cur = await this.readVersion(parsed.id);
            this.sendTo(ws, {
              type: 'nack',
              clientMsgId: parsed.clientMsgId,
              reason: cur === null ? 'not_found' : 'version_conflict',
              currentVersion: cur ?? undefined,
            });
            return;
          }
          this.broadcast({
            type: 'card_moved',
            card: result.card,
            fromColumn: result.fromColumn,
            toColumn: result.toColumn,
            positions: result.affected,
          });
          // Only log a move event if the column actually changed — dragging
          // a card within the same column is usually just reordering and
          // floods the timeline if logged each time.
          if (result.fromColumn !== result.toColumn) {
            await this.emitCardEvent(result.card.id, attachment.userId, 'card.moved', {
              fromColumn: result.fromColumn,
              toColumn: result.toColumn,
              toPosition: result.card.position,
            });
          }
          this.sendTo(ws, { type: 'ack', clientMsgId: parsed.clientMsgId, ok: true });
          return;
        }
        case 'delete_card': {
          const ok = await deleteCard(this.env.DB, parsed.id, parsed.version);
          if (!ok) {
            const cur = await this.readVersion(parsed.id);
            this.sendTo(ws, {
              type: 'nack',
              clientMsgId: parsed.clientMsgId,
              reason: cur === null ? 'not_found' : 'version_conflict',
              currentVersion: cur ?? undefined,
            });
            return;
          }
          this.broadcast({ type: 'card_deleted', id: parsed.id });
          this.sendTo(ws, { type: 'ack', clientMsgId: parsed.clientMsgId, ok: true });
          return;
        }
        case 'archive_card': {
          const result = await archiveCard(
            this.env.DB,
            parsed.id,
            parsed.version,
            attachment.userId
          );
          if (!result) {
            const cur = await this.readVersion(parsed.id);
            this.sendTo(ws, {
              type: 'nack',
              clientMsgId: parsed.clientMsgId,
              reason: cur === null ? 'not_found' : 'version_conflict',
              currentVersion: cur ?? undefined,
            });
            return;
          }
          // Broadcast: every connected client should remove the card from
          // the main board view (it's now in the archive drawer) and apply
          // the post-archive positions of the remaining active cards.
          this.broadcast({
            type: 'card_archived',
            card: result.card,
            column: result.column,
            positions: result.affected,
          });
          await this.emitCardEvent(result.card.id, attachment.userId, 'card.archived', {
            column: result.column,
          });
          this.sendTo(ws, { type: 'ack', clientMsgId: parsed.clientMsgId, ok: true });
          return;
        }
        case 'unarchive_card': {
          const result = await unarchiveCard(
            this.env.DB,
            parsed.id,
            parsed.version,
            attachment.userId
          );
          if (!result) {
            const cur = await this.readVersion(parsed.id);
            this.sendTo(ws, {
              type: 'nack',
              clientMsgId: parsed.clientMsgId,
              reason: cur === null ? 'not_found' : 'version_conflict',
              currentVersion: cur ?? undefined,
            });
            return;
          }
          this.broadcast({
            type: 'card_unarchived',
            card: result.card,
            column: result.column,
            positions: result.affected,
          });
          await this.emitCardEvent(result.card.id, attachment.userId, 'card.unarchived', {
            column: result.column,
          });
          this.sendTo(ws, { type: 'ack', clientMsgId: parsed.clientMsgId, ok: true });
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
          const comment = await createComment(
            this.env.DB,
            parsed.cardId,
            parsed.body,
            attachment.userId
          );
          this.broadcast({ type: 'comment_created', comment });
          // Mirror to the activity timeline so the same modal section that
          // already shows other events surfaces "X commented" as well.
          await this.emitCardEvent(parsed.cardId, attachment.userId, 'card.updated', {
            changedFields: ['comments'],
            commentId: comment.id,
          });
          // Fan out @mention notifications. We need the card's title for the
          // notification snippet — single point query keeps the read cheap.
          const titleRow = await this.env.DB
            .prepare(`SELECT title FROM kanban_cards WHERE id = ?`)
            .bind(parsed.cardId)
            .first<{ title: string }>();
          await this.fanOutMentionNotifications(
            parsed.body,
            attachment.userId,
            parsed.cardId,
            comment.id,
            titleRow?.title ?? null
          );
          this.sendTo(ws, { type: 'ack', clientMsgId: parsed.clientMsgId, ok: true });
          return;
        }
        case 'update_comment': {
          const updated = await updateComment(
            this.env.DB,
            parsed.id,
            parsed.body,
            attachment.userId
          );
          if (!updated) {
            // No row matched the (id, author_user_id) predicate — either the
            // comment doesn't exist or this user isn't the author.
            this.sendTo(ws, {
              type: 'nack',
              clientMsgId: parsed.clientMsgId,
              reason: 'not_found',
            });
            return;
          }
          this.broadcast({ type: 'comment_updated', comment: updated });
          this.sendTo(ws, { type: 'ack', clientMsgId: parsed.clientMsgId, ok: true });
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
          const item = await createChecklistItem(
            this.env.DB,
            parsed.cardId,
            parsed.body
          );
          this.broadcast({ type: 'checklist_item_created', item });
          this.sendTo(ws, { type: 'ack', clientMsgId: parsed.clientMsgId, ok: true });
          return;
        }
        case 'update_checklist_item': {
          const updated = await updateChecklistItem(this.env.DB, parsed.id, {
            body: parsed.body,
            completed: parsed.completed,
          });
          if (!updated) {
            this.sendTo(ws, {
              type: 'nack',
              clientMsgId: parsed.clientMsgId,
              reason: 'not_found',
            });
            return;
          }
          this.broadcast({ type: 'checklist_item_updated', item: updated });
          this.sendTo(ws, { type: 'ack', clientMsgId: parsed.clientMsgId, ok: true });
          return;
        }
        case 'delete_checklist_item': {
          const ref = await deleteChecklistItem(this.env.DB, parsed.id);
          if (!ref) {
            this.sendTo(ws, {
              type: 'nack',
              clientMsgId: parsed.clientMsgId,
              reason: 'not_found',
            });
            return;
          }
          this.broadcast({
            type: 'checklist_item_deleted',
            id: ref.id,
            cardId: ref.cardId,
          });
          this.sendTo(ws, { type: 'ack', clientMsgId: parsed.clientMsgId, ok: true });
          return;
        }
        case 'set_wip_limit': {
          if (!attachment.isStaff) {
            this.sendTo(ws, {
              type: 'nack',
              clientMsgId: parsed.clientMsgId,
              reason: 'forbidden',
            });
            return;
          }
          const config = await setColumnWipLimit(
            this.env.DB,
            attachment.boardId,
            parsed.column,
            parsed.wipLimit
          );
          if (!config) {
            this.sendTo(ws, {
              type: 'nack',
              clientMsgId: parsed.clientMsgId,
              reason: 'not_found',
            });
            return;
          }
          this.broadcast({ type: 'column_config_updated', column: config });
          this.sendTo(ws, { type: 'ack', clientMsgId: parsed.clientMsgId, ok: true });
          return;
        }
        case 'delete_comment': {
          // Look up first so we can broadcast cardId even when the row vanishes
          // from the predicate-matched DELETE (admin path doesn't read it back).
          const existing = await getComment(this.env.DB, parsed.id);
          if (!existing) {
            this.sendTo(ws, {
              type: 'nack',
              clientMsgId: parsed.clientMsgId,
              reason: 'not_found',
            });
            return;
          }
          const ref = await deleteComment(
            this.env.DB,
            parsed.id,
            attachment.userId,
            attachment.isAdmin
          );
          if (!ref) {
            // Authorization check failed — caller is neither author nor admin.
            this.sendTo(ws, {
              type: 'nack',
              clientMsgId: parsed.clientMsgId,
              reason: 'forbidden',
            });
            return;
          }
          this.broadcast({
            type: 'comment_deleted',
            id: ref.id,
            cardId: ref.cardId,
          });
          this.sendTo(ws, { type: 'ack', clientMsgId: parsed.clientMsgId, ok: true });
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
}
