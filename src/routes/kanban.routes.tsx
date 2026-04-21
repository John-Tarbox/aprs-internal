/**
 * Kanban routes.
 *   GET /kanban       — server-rendered board page
 *   GET /kanban/ws    — WebSocket upgrade forwarded to KanbanBoardDO
 *
 * Auth is enforced via the app-level `authMiddleware` in src/index.ts, so
 * `c.get('user')` is guaranteed present.
 *
 * For the WS upgrade we build a fresh Request with the authenticated
 * identity in internal headers (X-User-*). Any X-User-* headers on the
 * inbound client request are dropped — only the authoritative server-side
 * values reach the DO. This prevents header smuggling by a malicious
 * authenticated user who might try to impersonate another user id.
 */

import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { KanbanPage } from '../pages/KanbanPage';

export const kanbanRoutes = new Hono<AppEnv>();

kanbanRoutes.get('/', (c) => {
  const user = c.get('user');
  return c.html(<KanbanPage user={user} />);
});

kanbanRoutes.get('/ws', async (c) => {
  if (c.req.header('Upgrade') !== 'websocket') {
    return c.text('Expected WebSocket upgrade', 426);
  }

  const user = c.get('user');
  const id = c.env.KANBAN_DO.idFromName('main-board');
  const stub = c.env.KANBAN_DO.get(id);

  const forwarded = new Request(c.req.raw.url, {
    method: 'GET',
    headers: {
      Upgrade: 'websocket',
      'X-User-Id': String(user.id),
      'X-User-Email': user.email,
      'X-User-Display-Name': user.displayName ?? '',
    },
  });

  return stub.fetch(forwarded);
});
