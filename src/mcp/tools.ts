/**
 * MCP tool implementations for the APRS-internal Kanban.
 *
 * Tools accept human-friendly inputs (board slugs, email addresses,
 * column keys) and translate to internal IDs / DO calls. The board-
 * level tools (list/get/create/import) use the service layer directly;
 * everything that mutates the contents of a board (cards, columns,
 * labels, comments, checklists) routes through the per-board
 * KanbanBoardDO via Durable Object RPC so live browser sessions get the
 * same broadcast + audit-log + notification side effects they would
 * from a WebSocket-driven edit.
 *
 * Auth: the auth bridge sets `props` on the OAuth grant; the MCP HTTP
 * handler surfaces those props via `extra.authInfo.extra.props`. We read
 * them once at the top of every tool that does anything user-scoped.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Env } from '../env';
import {
  createBoard,
  getBoardBySlug,
  listBoards,
  listBoardColumns,
  listCards,
  listGroupsForBoard,
  type BoardDto,
} from '../services/kanban.service';
import { commitImport, parseImportCsv } from '../services/bulk_import.service';
import { findUserByEmail } from '../services/users.service';
import type {
  KanbanBoardDO,
  OpForbiddenError,
  OpNotFoundError,
  OpInvalidError,
  OpVersionConflictError,
} from '../durable/kanban.do';

/** Shape of the `props` blob the OAuth bridge stores with each grant. */
export interface McpProps {
  userId: number;
  email: string;
  displayName: string | null;
  isStaff: boolean;
  isAdmin: boolean;
}

/**
 * Pulled from `extra.authInfo.extra.props` set by the MCP HTTP handler.
 * Throws if no auth context is present — the OAuthProvider should have
 * already rejected unauthenticated requests, so reaching a tool with no
 * props means a configuration bug, not a user error.
 */
function requireProps(extra: { authInfo?: { extra?: Record<string, unknown> } }): McpProps {
  const props = extra?.authInfo?.extra?.props as McpProps | undefined;
  if (!props || typeof props.userId !== 'number') {
    throw new Error('MCP tool invoked without OAuth props — auth wiring is broken.');
  }
  return props;
}

async function resolveBoardOrThrow(env: Env, slug: string): Promise<BoardDto> {
  const board = await getBoardBySlug(env.DB, slug);
  if (!board) throw new Error(`Board not found: "${slug}"`);
  return board;
}

/** Look up users by email; throw on the first miss with a clear message
 *  so the AI surfaces the typo instead of silently dropping assignees. */
async function resolveAssigneeIdsOrThrow(env: Env, emails: string[] | undefined): Promise<number[] | undefined> {
  if (!emails || emails.length === 0) return undefined;
  const ids: number[] = [];
  for (const email of emails) {
    const u = await findUserByEmail(env.DB, email);
    if (!u) throw new Error(`Unknown user email (no account): ${email}`);
    if (!u.active) throw new Error(`User account is deactivated: ${email}`);
    ids.push(u.id);
  }
  return ids;
}

function getBoardDOStub(env: Env, boardId: number): DurableObjectStub<KanbanBoardDO> {
  const id = env.KANBAN_DO.idFromName('board-' + boardId);
  // The stub returned by the namespace get carries the DO's public methods
  // for direct RPC calls. The cast informs TypeScript of the methods that
  // are typed by the imported KanbanBoardDO class.
  return env.KANBAN_DO.get(id) as unknown as DurableObjectStub<KanbanBoardDO>;
}

/** Wrap any value as an MCP CallToolResult. The SDK supports either
 *  text content blocks or structured JSON; we use text with a JSON-stringified
 *  payload so existing chat surfaces render it nicely. */
function toolOk(value: unknown) {
  return {
    content: [
      { type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
    ],
  };
}

function toolErr(message: string) {
  return {
    isError: true,
    content: [{ type: 'text' as const, text: message }],
  };
}

/** Translate the DO op-method error hierarchy into an MCP isError result.
 *  Only catches the classes we know about; anything else re-throws so the
 *  SDK's default error handling surfaces it with a stack trace. */
function translateOpError(err: unknown): ReturnType<typeof toolErr> | null {
  const e = err as Partial<OpForbiddenError & OpNotFoundError & OpInvalidError & OpVersionConflictError> & {
    name?: string;
  };
  if (!e || !e.name) return null;
  switch (e.name) {
    case 'OpForbiddenError':
      return toolErr('forbidden: this action requires staff role');
    case 'OpNotFoundError':
      return toolErr('not_found: target does not exist');
    case 'OpVersionConflictError':
      return toolErr(
        `version_conflict: card was modified by someone else (currentVersion=${
          (e as OpVersionConflictError).currentVersion ?? 'unknown'
        }). Re-fetch the board and retry.`
      );
    case 'OpInvalidError':
      return toolErr(`invalid: ${e.message ?? 'request rejected'}`);
    case 'KanbanColumnLimitError':
      return toolErr(`column_limit: board already has the maximum number of columns`);
  }
  return null;
}

/** Helper: run an op-call and translate errors. Keeps every tool body short. */
async function runOp<T>(fn: () => Promise<T>): Promise<ReturnType<typeof toolOk> | ReturnType<typeof toolErr>> {
  try {
    const out = await fn();
    return toolOk(out);
  } catch (err) {
    const translated = translateOpError(err);
    if (translated) return translated;
    throw err;
  }
}

// ── Server factory ──────────────────────────────────────────────────────

export function registerKanbanTools(server: McpServer, env: Env): void {
  // ── Auth / discovery ───────────────────────────────────────────────

  server.registerTool(
    'whoami',
    {
      description: 'Returns the authenticated user (email, display name, role flags).',
      inputSchema: {},
    },
    async (_args, extra) => {
      const props = requireProps(extra);
      return toolOk({
        userId: props.userId,
        email: props.email,
        displayName: props.displayName,
        isStaff: props.isStaff,
        isAdmin: props.isAdmin,
      });
    }
  );

  // ── Board-level (direct service calls) ─────────────────────────────

  server.registerTool(
    'list_boards',
    {
      description: 'List all kanban boards visible to the user.',
      inputSchema: {},
    },
    async (_args, extra) => {
      requireProps(extra);
      const boards = await listBoards(env.DB);
      return toolOk(
        boards.map((b) => ({
          id: b.id,
          slug: b.slug,
          name: b.name,
          createdAt: b.createdAt,
          updatedAt: b.updatedAt,
        }))
      );
    }
  );

  server.registerTool(
    'get_board',
    {
      description:
        'Get the full snapshot of a board: its columns, labels, and active (non-archived) cards.',
      inputSchema: { boardSlug: z.string().min(1) },
    },
    async ({ boardSlug }, extra) => {
      const props = requireProps(extra);
      const board = await resolveBoardOrThrow(env, boardSlug);
      const [columns, groups, cards] = await Promise.all([
        listBoardColumns(env.DB, board.id),
        listGroupsForBoard(env.DB, board.id),
        listCards(env.DB, board.id, props.userId),
      ]);
      return toolOk({ board, columns, groups, cards });
    }
  );

  server.registerTool(
    'create_board',
    {
      description: 'Create a new kanban board with the canonical 6-column starter layout.',
      inputSchema: {
        name: z.string().min(1).max(100),
        slug: z.string().min(1).max(60).optional(),
      },
    },
    async ({ name, slug }, extra) => {
      const props = requireProps(extra);
      if (!props.isStaff) return toolErr('forbidden: create_board requires staff role');
      try {
        const board = await createBoard(env.DB, { name, slug }, props.userId);
        return toolOk(board);
      } catch (err) {
        const msg = String((err as Error)?.message ?? err);
        if (msg.includes('UNIQUE') || msg.includes('constraint')) {
          return toolErr(
            `slug_conflict: a board with that slug already exists (${slug ?? 'derived from name'})`
          );
        }
        return toolErr(`create_failed: ${msg}`);
      }
    }
  );

  server.registerTool(
    'bulk_import_cards',
    {
      description:
        'Bulk-import up to 500 cards into a column from CSV. CSV must have a header row; recognised columns: title (required), notes, assigned, labels (or "groups"). Labels may be pipe- or comma-separated within a cell.',
      inputSchema: {
        boardSlug: z.string().min(1),
        columnKey: z.string().min(1),
        csv: z.string().min(1).max(2_000_000),
      },
    },
    async ({ boardSlug, columnKey, csv }, extra) => {
      const props = requireProps(extra);
      if (!props.isStaff) return toolErr('forbidden: bulk_import_cards requires staff role');
      const board = await resolveBoardOrThrow(env, boardSlug);
      const cols = await listBoardColumns(env.DB, board.id);
      const target = cols.find((c) => c.columnName === columnKey);
      if (!target) {
        return toolErr(
          `unknown_column: "${columnKey}" not found on board "${boardSlug}". ` +
            `Valid columns: ${cols.map((c) => c.columnName).join(', ')}`
        );
      }
      const parsed = parseImportCsv(csv);
      if (parsed.rows.length === 0) {
        return toolErr(`empty_or_invalid_csv: ${parsed.warnings.join('; ') || 'no rows parsed'}`);
      }
      const result = await commitImport(env.DB, board.id, columnKey, parsed.rows, props.userId);
      return toolOk({
        createdCount: result.created.length,
        skipped: result.skipped,
        warnings: [...parsed.warnings, ...result.warnings],
        sampleCreated: result.created.slice(0, 5).map((c) => ({
          id: c.id,
          title: c.title,
          column: c.column,
        })),
      });
    }
  );

  // ── Card ops (DO RPC) ──────────────────────────────────────────────

  server.registerTool(
    'create_card',
    {
      description:
        'Create a new card on a board. Pass labels by name (auto-creates if you are staff); pass assigneeEmails to assign users.',
      inputSchema: {
        boardSlug: z.string().min(1),
        columnKey: z.string().min(1),
        title: z.string().min(1).max(200),
        notes: z.string().max(10_000).optional(),
        labels: z.array(z.string().min(1).max(100)).max(20).optional(),
        assigneeEmails: z.array(z.string().email()).max(10).optional(),
        assigned: z.string().max(100).optional(),
        startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        dueTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
        coverColor: z.string().regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/).optional(),
      },
    },
    async (args, extra) => {
      const props = requireProps(extra);
      const board = await resolveBoardOrThrow(env, args.boardSlug);
      const assigneeUserIds = await resolveAssigneeIdsOrThrow(env, args.assigneeEmails);
      const stub = getBoardDOStub(env, board.id);
      return runOp(() =>
        stub.opCreateCard(
          {
            column: args.columnKey,
            title: args.title,
            notes: args.notes ?? null,
            groups: args.labels,
            assigneeUserIds,
            assigned: args.assigned ?? null,
            startDate: args.startDate ?? null,
            dueDate: args.dueDate ?? null,
            dueTime: args.dueTime ?? null,
            coverColor: args.coverColor ?? null,
          },
          props.userId,
          props.isStaff,
          board.id
        )
      );
    }
  );

  server.registerTool(
    'update_card',
    {
      description:
        'Update an existing card. Pass the current `version` for optimistic concurrency. Patch fields are optional; omitted fields stay unchanged.',
      inputSchema: {
        cardId: z.number().int().positive(),
        version: z.number().int().positive(),
        title: z.string().min(1).max(200).optional(),
        notes: z.string().max(10_000).nullable().optional(),
        labels: z.array(z.string().min(1).max(100)).max(20).optional(),
        assigneeEmails: z.array(z.string().email()).max(10).optional(),
        assigned: z.string().max(100).nullable().optional(),
        startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
        dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
        dueTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable().optional(),
        coverColor: z.string().regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/).nullable().optional(),
      },
    },
    async (args, extra) => {
      const props = requireProps(extra);
      // The DO method needs the board id to instantiate; we look up the
      // card row to discover it. One short query, indexed by primary key.
      const row = await env.DB
        .prepare(`SELECT board_id FROM kanban_cards WHERE id = ?`)
        .bind(args.cardId)
        .first<{ board_id: number }>();
      if (!row) return toolErr(`not_found: card ${args.cardId}`);
      const assigneeUserIds = await resolveAssigneeIdsOrThrow(env, args.assigneeEmails);
      const patch: Record<string, unknown> = {};
      if (args.title !== undefined) patch.title = args.title;
      if (args.notes !== undefined) patch.notes = args.notes;
      if (args.labels !== undefined) patch.groups = args.labels;
      if (assigneeUserIds !== undefined) patch.assigneeUserIds = assigneeUserIds;
      if (args.assigned !== undefined) patch.assigned = args.assigned;
      if (args.startDate !== undefined) patch.startDate = args.startDate;
      if (args.dueDate !== undefined) patch.dueDate = args.dueDate;
      if (args.dueTime !== undefined) patch.dueTime = args.dueTime;
      if (args.coverColor !== undefined) patch.coverColor = args.coverColor;
      const stub = getBoardDOStub(env, row.board_id);
      return runOp(() =>
        stub.opUpdateCard(
          { id: args.cardId, version: args.version, patch: patch as Parameters<KanbanBoardDO['opUpdateCard']>[0]['patch'] },
          props.userId,
          props.isStaff,
          row.board_id
        )
      );
    }
  );

  server.registerTool(
    'move_card',
    {
      description: 'Move a card to a different column and position (0-indexed within the destination column).',
      inputSchema: {
        cardId: z.number().int().positive(),
        version: z.number().int().positive(),
        toColumnKey: z.string().min(1),
        toPosition: z.number().int().min(0),
      },
    },
    async ({ cardId, version, toColumnKey, toPosition }, extra) => {
      const props = requireProps(extra);
      const row = await env.DB
        .prepare(`SELECT board_id FROM kanban_cards WHERE id = ?`)
        .bind(cardId)
        .first<{ board_id: number }>();
      if (!row) return toolErr(`not_found: card ${cardId}`);
      const stub = getBoardDOStub(env, row.board_id);
      return runOp(() =>
        stub.opMoveCard({ id: cardId, version, toColumn: toColumnKey, toPosition }, props.userId)
      );
    }
  );

  server.registerTool(
    'archive_card',
    {
      description: 'Soft-delete (archive) a card. Reversible via unarchive_card.',
      inputSchema: {
        cardId: z.number().int().positive(),
        version: z.number().int().positive(),
      },
    },
    async ({ cardId, version }, extra) => {
      const props = requireProps(extra);
      const row = await env.DB
        .prepare(`SELECT board_id FROM kanban_cards WHERE id = ?`)
        .bind(cardId)
        .first<{ board_id: number }>();
      if (!row) return toolErr(`not_found: card ${cardId}`);
      const stub = getBoardDOStub(env, row.board_id);
      return runOp(() => stub.opArchiveCard({ id: cardId, version }, props.userId));
    }
  );

  server.registerTool(
    'unarchive_card',
    {
      description: 'Restore a previously-archived card.',
      inputSchema: {
        cardId: z.number().int().positive(),
        version: z.number().int().positive(),
      },
    },
    async ({ cardId, version }, extra) => {
      const props = requireProps(extra);
      const row = await env.DB
        .prepare(`SELECT board_id FROM kanban_cards WHERE id = ?`)
        .bind(cardId)
        .first<{ board_id: number }>();
      if (!row) return toolErr(`not_found: card ${cardId}`);
      const stub = getBoardDOStub(env, row.board_id);
      return runOp(() => stub.opUnarchiveCard({ id: cardId, version }, props.userId));
    }
  );

  server.registerTool(
    'delete_card',
    {
      description: 'Permanently delete a card. Prefer archive_card unless the deletion is intended.',
      inputSchema: {
        cardId: z.number().int().positive(),
        version: z.number().int().positive(),
      },
    },
    async ({ cardId, version }, extra) => {
      requireProps(extra);
      const row = await env.DB
        .prepare(`SELECT board_id FROM kanban_cards WHERE id = ?`)
        .bind(cardId)
        .first<{ board_id: number }>();
      if (!row) return toolErr(`not_found: card ${cardId}`);
      const stub = getBoardDOStub(env, row.board_id);
      return runOp(async () => {
        await stub.opDeleteCard({ id: cardId, version });
        return { deleted: true, cardId };
      });
    }
  );

  server.registerTool(
    'add_comment',
    {
      description: 'Add a comment to a card. @mentions of users by email trigger notifications.',
      inputSchema: {
        cardId: z.number().int().positive(),
        body: z.string().min(1).max(5_000),
      },
    },
    async ({ cardId, body }, extra) => {
      const props = requireProps(extra);
      const row = await env.DB
        .prepare(`SELECT board_id FROM kanban_cards WHERE id = ?`)
        .bind(cardId)
        .first<{ board_id: number }>();
      if (!row) return toolErr(`not_found: card ${cardId}`);
      const stub = getBoardDOStub(env, row.board_id);
      return runOp(() => stub.opCreateComment({ cardId, body }, props.userId));
    }
  );

  server.registerTool(
    'add_checklist_item',
    {
      description: 'Append a checklist item to a card.',
      inputSchema: {
        cardId: z.number().int().positive(),
        body: z.string().min(1).max(500),
      },
    },
    async ({ cardId, body }, extra) => {
      requireProps(extra);
      const row = await env.DB
        .prepare(`SELECT board_id FROM kanban_cards WHERE id = ?`)
        .bind(cardId)
        .first<{ board_id: number }>();
      if (!row) return toolErr(`not_found: card ${cardId}`);
      const stub = getBoardDOStub(env, row.board_id);
      return runOp(() => stub.opCreateChecklistItem({ cardId, body }));
    }
  );

  server.registerTool(
    'set_checklist_item',
    {
      description: 'Update a checklist item: change body and/or completed flag.',
      inputSchema: {
        boardSlug: z.string().min(1),
        itemId: z.number().int().positive(),
        body: z.string().min(1).max(500).optional(),
        completed: z.boolean().optional(),
      },
    },
    async ({ boardSlug, itemId, body, completed }, extra) => {
      requireProps(extra);
      const board = await resolveBoardOrThrow(env, boardSlug);
      const stub = getBoardDOStub(env, board.id);
      return runOp(() => stub.opUpdateChecklistItem({ id: itemId, body, completed }));
    }
  );

  server.registerTool(
    'delete_checklist_item',
    {
      description: 'Delete a checklist item.',
      inputSchema: {
        boardSlug: z.string().min(1),
        itemId: z.number().int().positive(),
      },
    },
    async ({ boardSlug, itemId }, extra) => {
      requireProps(extra);
      const board = await resolveBoardOrThrow(env, boardSlug);
      const stub = getBoardDOStub(env, board.id);
      return runOp(() => stub.opDeleteChecklistItem({ id: itemId }));
    }
  );

  // ── Column ops (staff-only via DO check) ───────────────────────────

  server.registerTool(
    'add_column',
    {
      description: 'Add a new column to a board. Staff only. Boards have a hard cap of 7 columns.',
      inputSchema: {
        boardSlug: z.string().min(1),
        key: z.string().min(1).max(64),
        label: z.string().min(1).max(64),
      },
    },
    async ({ boardSlug, key, label }, extra) => {
      const props = requireProps(extra);
      const board = await resolveBoardOrThrow(env, boardSlug);
      const stub = getBoardDOStub(env, board.id);
      return runOp(() => stub.opAddColumn({ key, label }, props.isStaff, board.id));
    }
  );

  server.registerTool(
    'rename_column',
    {
      description: 'Rename a column on a board. Staff only.',
      inputSchema: {
        boardSlug: z.string().min(1),
        columnKey: z.string().min(1),
        newLabel: z.string().min(1).max(64),
      },
    },
    async ({ boardSlug, columnKey, newLabel }, extra) => {
      const props = requireProps(extra);
      const board = await resolveBoardOrThrow(env, boardSlug);
      const stub = getBoardDOStub(env, board.id);
      return runOp(() => stub.opRenameColumn({ column: columnKey, label: newLabel }, props.isStaff, board.id));
    }
  );

  server.registerTool(
    'delete_column',
    {
      description: 'Delete a column. Fails if the column still has cards. Staff only.',
      inputSchema: {
        boardSlug: z.string().min(1),
        columnKey: z.string().min(1),
      },
    },
    async ({ boardSlug, columnKey }, extra) => {
      const props = requireProps(extra);
      const board = await resolveBoardOrThrow(env, boardSlug);
      const stub = getBoardDOStub(env, board.id);
      return runOp(async () => {
        await stub.opDeleteColumn({ column: columnKey }, props.isStaff, board.id);
        return { deleted: true, columnKey };
      });
    }
  );

  server.registerTool(
    'move_column',
    {
      description:
        'Reorder columns on a board. Pass the full list of column keys in the desired left-to-right order. Staff only.',
      inputSchema: {
        boardSlug: z.string().min(1),
        order: z.array(z.string().min(1)).min(1).max(64),
      },
    },
    async ({ boardSlug, order }, extra) => {
      const props = requireProps(extra);
      const board = await resolveBoardOrThrow(env, boardSlug);
      const stub = getBoardDOStub(env, board.id);
      return runOp(() => stub.opMoveColumn({ order }, props.isStaff, board.id));
    }
  );

  server.registerTool(
    'set_column_color',
    {
      description: 'Set or clear a column header color. Staff only.',
      inputSchema: {
        boardSlug: z.string().min(1),
        columnKey: z.string().min(1),
        color: z
          .string()
          .regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/)
          .nullable(),
      },
    },
    async ({ boardSlug, columnKey, color }, extra) => {
      const props = requireProps(extra);
      const board = await resolveBoardOrThrow(env, boardSlug);
      const stub = getBoardDOStub(env, board.id);
      return runOp(() =>
        stub.opSetColumnColor({ column: columnKey, color }, props.isStaff, board.id)
      );
    }
  );

  // ── Label ops (staff-only via DO check) ────────────────────────────

  server.registerTool(
    'create_label',
    {
      description: 'Create a new label on a board. Idempotent on (board, name) under NOCASE collation. Staff only.',
      inputSchema: {
        boardSlug: z.string().min(1),
        name: z.string().min(1).max(100),
        color: z
          .string()
          .regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/)
          .optional(),
      },
    },
    async ({ boardSlug, name, color }, extra) => {
      const props = requireProps(extra);
      const board = await resolveBoardOrThrow(env, boardSlug);
      const stub = getBoardDOStub(env, board.id);
      return runOp(() => stub.opCreateGroup({ name, color }, props.isStaff, board.id));
    }
  );

  server.registerTool(
    'rename_label',
    {
      description: 'Rename a label everywhere it appears on a board. Staff only.',
      inputSchema: {
        boardSlug: z.string().min(1),
        oldName: z.string().min(1).max(100),
        newName: z.string().min(1).max(100),
      },
    },
    async ({ boardSlug, oldName, newName }, extra) => {
      const props = requireProps(extra);
      const board = await resolveBoardOrThrow(env, boardSlug);
      const stub = getBoardDOStub(env, board.id);
      return runOp(() =>
        stub.opRenameGroup({ oldName, newName }, props.userId, props.isStaff, board.id)
      );
    }
  );

  server.registerTool(
    'delete_label',
    {
      description: 'Delete a label and detach it from every card on a board. Staff only.',
      inputSchema: {
        boardSlug: z.string().min(1),
        name: z.string().min(1).max(100),
      },
    },
    async ({ boardSlug, name }, extra) => {
      const props = requireProps(extra);
      const board = await resolveBoardOrThrow(env, boardSlug);
      const stub = getBoardDOStub(env, board.id);
      return runOp(async () => {
        const r = await stub.opDeleteGroup({ name }, props.userId, props.isStaff, board.id);
        return { deleted: true, name, affectedCardCount: r.affectedCardIds.length };
      });
    }
  );

  server.registerTool(
    'set_label_color',
    {
      description: 'Set or clear a label color. Staff only.',
      inputSchema: {
        boardSlug: z.string().min(1),
        name: z.string().min(1).max(100),
        color: z
          .string()
          .regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/)
          .nullable(),
      },
    },
    async ({ boardSlug, name, color }, extra) => {
      const props = requireProps(extra);
      const board = await resolveBoardOrThrow(env, boardSlug);
      const stub = getBoardDOStub(env, board.id);
      return runOp(() => stub.opSetGroupColor({ name, color }, props.isStaff, board.id));
    }
  );
}
