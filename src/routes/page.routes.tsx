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
import { MyCardsPage } from '../pages/MyCardsPage';
import { CalendarPage } from '../pages/CalendarPage';
import { AccessDeniedPage } from '../pages/AccessDeniedPage';
import {
  getColumnCounts,
  listCardsAssignedToUser,
  listCardsWithDueDateInRange,
} from '../services/kanban.service';

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

authedPageRoutes.get('/my', async (c) => {
  const user = c.get('user');
  const cards = await listCardsAssignedToUser(c.env.DB, user.id);
  return c.html(<MyCardsPage user={user} cards={cards} />);
});

authedPageRoutes.get('/calendar', async (c) => {
  const user = c.get('user');
  // Default to current month (UTC). Query params override.
  const now = new Date();
  const yearRaw = Number.parseInt(c.req.query('year') ?? '', 10);
  const monthRaw = Number.parseInt(c.req.query('month') ?? '', 10);
  const year = Number.isFinite(yearRaw) && yearRaw >= 1970 && yearRaw <= 9999
    ? yearRaw
    : now.getUTCFullYear();
  const month = Number.isFinite(monthRaw) && monthRaw >= 1 && monthRaw <= 12
    ? monthRaw
    : now.getUTCMonth() + 1;

  // Query window covers the full grid (6 weeks starting on Sun before the 1st).
  const firstDow = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const fromDate = new Date(Date.UTC(year, month - 1, 1 - firstDow));
  const toDate = new Date(fromDate.getTime() + 41 * 24 * 60 * 60 * 1000);
  const fromIso = fromDate.toISOString().slice(0, 10);
  const toIso = toDate.toISOString().slice(0, 10);

  const cards = await listCardsWithDueDateInRange(c.env.DB, fromIso, toIso);
  return c.html(<CalendarPage user={user} year={year} month={month} cards={cards} />);
});
