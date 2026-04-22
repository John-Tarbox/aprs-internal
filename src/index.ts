/**
 * APRS internal site — Cloudflare Worker entry point.
 *
 * Route layout (top-level):
 *   /api/health          — unauthenticated health probe
 *   /login               — unauthenticated sign-in page
 *   /access-denied       — unauthenticated "ask an admin" page
 *   /auth/*              — OIDC callbacks (unauthenticated)
 *   /admin/*             — requires role=admin
 *   everything else      — requires authenticated session
 */

import { Hono } from 'hono';
import { logger } from 'hono/logger';
import type { AppEnv } from './env';
import { healthRoutes } from './routes/health.routes';
import { authRoutes } from './routes/auth.routes';
import { publicPageRoutes, authedPageRoutes } from './routes/page.routes';
import { adminRoutes } from './routes/admin.routes';
import { exportsRoutes } from './routes/exports.routes';
import { kanbanRoutes } from './routes/kanban.routes';
import { notificationsRoutes } from './routes/notifications.routes';
import { savedFiltersRoutes } from './routes/saved_filters.routes';
import { authMiddleware, requireRole } from './middleware/auth';

// Re-exported at module level so the Workers runtime can find the class
// referenced by wrangler.toml's [[durable_objects.bindings]] class_name.
export { KanbanBoardDO } from './durable/kanban.do';

const app = new Hono<AppEnv>();

app.use('*', logger());

// Unauthenticated endpoints — must come before authMiddleware.
app.route('/api/health', healthRoutes);
app.route('/', publicPageRoutes);      // /login, /access-denied
app.route('/auth', authRoutes);

// Everything past this point requires a valid session.
app.use('*', authMiddleware);

app.use('/admin/*', requireRole('admin'));
app.route('/admin', adminRoutes);
app.route('/admin', exportsRoutes);

app.route('/kanban', kanbanRoutes);
app.route('/api/notifications', notificationsRoutes);
app.route('/api/filters', savedFiltersRoutes);

app.route('/', authedPageRoutes);      // /

app.onError((err, c) => {
  console.error('unhandled error:', err);
  return c.text('Internal Server Error', 500);
});

export default app;
