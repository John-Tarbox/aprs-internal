/**
 * Notification API. JSON endpoints consumed by the bell in the page header.
 *
 *   GET  /api/notifications/unread-count → { count }
 *   GET  /api/notifications              → { items: NotificationDto[] }
 *   POST /api/notifications/read-all     → { changed }
 *   POST /api/notifications/read         → body { ids: number[] } → { changed }
 *
 * All endpoints scope to the calling user via authMiddleware (mounted in
 * src/index.ts), so there are no per-id ownership checks here — the
 * service marks-as-read is owner-scoped at the SQL level.
 */

import { Hono } from 'hono';
import type { AppEnv } from '../env';
import {
  countUnreadNotifications,
  listNotifications,
  markAllNotificationsRead,
  markNotificationsRead,
} from '../services/notifications.service';

export const notificationsRoutes = new Hono<AppEnv>();

notificationsRoutes.get('/unread-count', async (c) => {
  const user = c.get('user');
  const count = await countUnreadNotifications(c.env.DB, user.id);
  return c.json({ count });
});

notificationsRoutes.get('/', async (c) => {
  const user = c.get('user');
  const unreadOnly = c.req.query('unread') === '1';
  const limitRaw = Number.parseInt(c.req.query('limit') ?? '30', 10);
  const limit = Number.isFinite(limitRaw) ? limitRaw : 30;
  const items = await listNotifications(c.env.DB, user.id, { unreadOnly, limit });
  return c.json({ items });
});

notificationsRoutes.post('/read-all', async (c) => {
  const user = c.get('user');
  const changed = await markAllNotificationsRead(c.env.DB, user.id);
  return c.json({ changed });
});

notificationsRoutes.post('/read', async (c) => {
  const user = c.get('user');
  let body: unknown = null;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid json' }, 400);
  }
  const ids = Array.isArray((body as { ids?: unknown }).ids)
    ? ((body as { ids: unknown[] }).ids.filter(
        (n): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0
      ) as number[])
    : [];
  const changed = await markNotificationsRead(c.env.DB, user.id, ids);
  return c.json({ changed });
});
