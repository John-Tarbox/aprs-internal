/**
 * Top-level page routes that don't fit under /auth or /admin:
 *   GET  /login           — sign-in page
 *   GET  /access-denied   — role-gating landing
 *   GET  /                — authenticated home
 *
 * /login and /access-denied are unauth-accessible; / is gated by the app-level
 * authMiddleware in src/index.ts.
 */

import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { LoginPage } from '../pages/LoginPage';
import { HomePage } from '../pages/HomePage';
import { AccessDeniedPage } from '../pages/AccessDeniedPage';
import { getColumnCounts } from '../services/kanban.service';

export const publicPageRoutes = new Hono<AppEnv>();

publicPageRoutes.get('/login', (c) => {
  const next = c.req.query('next');
  const error = c.req.query('error');
  const googleEnabled = Boolean(c.env.GOOGLE_CLIENT_ID && c.env.GOOGLE_CLIENT_SECRET);
  return c.html(<LoginPage next={next} error={error} googleEnabled={googleEnabled} />);
});

publicPageRoutes.get('/access-denied', (c) => {
  const attemptedEmail = c.req.query('email');
  const reason = c.req.query('reason');
  return c.html(<AccessDeniedPage attemptedEmail={attemptedEmail} reason={reason} />, 403);
});

export const authedPageRoutes = new Hono<AppEnv>();

authedPageRoutes.get('/', async (c) => {
  const user = c.get('user');
  const kanbanCounts = await getColumnCounts(c.env.DB);
  return c.html(<HomePage user={user} kanbanCounts={kanbanCounts} />);
});
