/**
 * APRS internal site — Cloudflare Worker entry point.
 *
 * Route layout (top-level):
 *   /api/health          — unauthenticated health probe
 *   /login               — unauthenticated sign-in page
 *   /access-denied       — unauthenticated "ask an admin" page
 *   /auth/*              — OIDC callbacks (unauthenticated)
 *   /authorize           — OAuth authorization endpoint for MCP / Claude.ai
 *   /admin/*             — requires role=admin
 *   /mcp, /mcp/sse       — MCP server (Streamable HTTP); auth via OAuthProvider
 *   everything else      — requires authenticated session
 *
 * The default export is wrapped in @cloudflare/workers-oauth-provider so
 * that /authorize, /token, /register, and /.well-known/oauth-* are
 * served by the OAuth provider, /mcp* is gated on a valid bearer token,
 * and everything else falls through to the existing browser-session app.
 */

import { Hono } from 'hono';
import { logger } from 'hono/logger';
import OAuthProvider from '@cloudflare/workers-oauth-provider';
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
import { oauthBridgeRoutes } from './mcp/oauth-bridge';
import { mcpApiHandler } from './mcp/http';

// Re-exported at module level so the Workers runtime can find the class
// referenced by wrangler.toml's [[durable_objects.bindings]] class_name.
export { KanbanBoardDO } from './durable/kanban.do';

const app = new Hono<AppEnv>();

app.use('*', logger());

// Unauthenticated endpoints — must come before authMiddleware.
app.route('/api/health', healthRoutes);
app.route('/', publicPageRoutes);      // /login, /access-denied
app.route('/auth', authRoutes);
// /authorize is the OAuth bridge for MCP / Claude.ai connectors. The
// OAuthProvider routes /authorize requests to defaultHandler (this app)
// — the bridge parses the AuthRequest, stashes it in the OIDC state
// cookie, and redirects to Okta. Must be unauthenticated since the user
// hasn't signed in yet at this point.
app.route('/authorize', oauthBridgeRoutes);

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

const oauthProvider = new OAuthProvider({
  // /mcp is the API surface; bearer token is required.
  apiRoute: ['/mcp'],
  apiHandler: mcpApiHandler,
  // Everything else (browser app + /authorize bridge) is unauth from the
  // OAuth provider's perspective. The app applies its own session auth.
  defaultHandler: { fetch: app.fetch.bind(app) },
  authorizeEndpoint: '/authorize',
  tokenEndpoint: '/token',
  clientRegistrationEndpoint: '/register',
  scopesSupported: ['kanban'],
});

export default oauthProvider;
