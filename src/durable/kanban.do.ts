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
  createCard,
  deleteCard,
  listCards,
  moveCard,
  updateCard,
  type CardDto,
  type ColumnName,
} from '../services/kanban.service';

const MAX_MSG_PER_SEC = 20;
const RATE_WINDOW_MS = 1000;
const MAX_TITLE = 200;
const MAX_FIELD = 100;
const MAX_NOTES = 10_000;

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
    group: nullableStr(MAX_FIELD),
    assigned: nullableStr(MAX_FIELD),
    notes: nullableStr(MAX_NOTES),
    dueDate: dueDateSchema,
  }),
  z.object({
    type: z.literal('update_card'),
    clientMsgId: z.string().max(64),
    id: z.number().int().positive(),
    version: z.number().int().positive(),
    patch: z.object({
      title: z.string().min(1).max(MAX_TITLE).optional(),
      group: nullableStr(MAX_FIELD),
      assigned: nullableStr(MAX_FIELD),
      notes: nullableStr(MAX_NOTES),
      dueDate: dueDateSchema,
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
]);

type ClientMsg = z.infer<typeof clientMsgSchema>;

interface SocketAttachment {
  userId: number;
  email: string;
  displayName: string | null;
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
    const userId = userIdRaw ? Number.parseInt(userIdRaw, 10) : NaN;
    if (!Number.isFinite(userId) || userId <= 0 || !email) {
      // The Worker route is supposed to inject these; if they're missing
      // something is wrong with the caller chain.
      return new Response('Unauthorized', { status: 401 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    this.ctx.acceptWebSocket(server);
    const attachment: SocketAttachment = {
      userId,
      email,
      displayName: displayName || null,
      recentMs: [],
    };
    server.serializeAttachment(attachment);

    // Send initial snapshot. If this throws, the socket will close.
    const cards = await listCards(this.env.DB);
    server.send(
      JSON.stringify({ type: 'snapshot', cards: cards.map(cardToDto) })
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
          const cards = await listCards(this.env.DB);
          this.sendTo(ws, { type: 'snapshot', cards });
          this.sendTo(ws, { type: 'ack', clientMsgId: parsed.clientMsgId, ok: true });
          return;
        }
        case 'create_card': {
          const card = await createCard(
            this.env.DB,
            {
              column: parsed.column,
              title: parsed.title,
              group: parsed.group ?? null,
              assigned: parsed.assigned ?? null,
              notes: parsed.notes ?? null,
              dueDate: parsed.dueDate ?? null,
            },
            attachment.userId
          );
          this.broadcast({ type: 'card_created', card });
          this.sendTo(ws, { type: 'ack', clientMsgId: parsed.clientMsgId, ok: true });
          return;
        }
        case 'update_card': {
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
