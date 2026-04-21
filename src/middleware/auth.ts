/**
 * Authentication + authorization middleware.
 *
 * `authMiddleware` resolves the request's session into an `AuthUser` and
 * puts it on `c.var.user`. No user → redirect to /login (for browsers) or
 * 401 JSON (for API paths).
 *
 * `requireRole(minRole)` is hierarchical: admin > staff > viewer.
 *
 * In development, callers can bypass real auth with X-Mock-User-Email /
 * X-Mock-User-Role headers. This mirrors FAQ's /home/wa1kli/FAQ/src/middleware/auth.ts
 * but adapted to our users/roles model.
 */

import { createMiddleware } from 'hono/factory';
import type { AppEnv, AuthUser, RoleName } from '../env';
import { parseCookies, verifySignedValue } from '../services/cookie.service';
import { resolveSession } from '../services/session.service';
import { findUserByEmail, getUserRoles } from '../services/users.service';

export const SESSION_COOKIE_NAME = 'session';

const ROLE_RANK: Record<RoleName, number> = { admin: 3, staff: 2, viewer: 1 };

export function hasMinRole(userRoles: RoleName[], minRole: RoleName): boolean {
  const bestRank = Math.max(0, ...userRoles.map((r) => ROLE_RANK[r] ?? 0));
  return bestRank >= ROLE_RANK[minRole];
}

function wantsJson(acceptHeader: string | undefined, path: string): boolean {
  if (path.startsWith('/api/')) return true;
  if (!acceptHeader) return false;
  return acceptHeader.includes('application/json') && !acceptHeader.includes('text/html');
}

function redirectToLogin(currentPath: string): Response {
  const url = new URL('/login', 'http://placeholder');
  if (currentPath && currentPath !== '/' && currentPath !== '/login') {
    url.searchParams.set('next', currentPath);
  }
  return new Response(null, {
    status: 302,
    headers: { Location: `${url.pathname}${url.search}` },
  });
}

export const authMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  // Dev mock — only honored when ENVIRONMENT=development.
  // Query-param fallback (`?mockEmail=...&mockRole=...`) is for scenarios
  // where request headers can't be set from the caller (e.g. browsers
  // initiating a WebSocket upgrade for multi-user local testing).
  if (c.env.ENVIRONMENT === 'development') {
    const mockEmail = c.req.header('X-Mock-User-Email') ?? c.req.query('mockEmail');
    const mockRole =
      (c.req.header('X-Mock-User-Role') as RoleName | undefined) ??
      (c.req.query('mockRole') as RoleName | undefined) ??
      'viewer';
    if (mockEmail) {
      const existing = await findUserByEmail(c.env.DB, mockEmail);
      const roles = existing ? await getUserRoles(c.env.DB, existing.id) : [mockRole];
      const user: AuthUser = {
        id: existing?.id ?? 0,
        email: mockEmail,
        authType: existing?.authType ?? 'okta',
        displayName: existing?.displayName ?? 'Mock User',
        roles: roles.length ? roles : [mockRole],
      };
      c.set('user', user);
      c.set('sessionId', 'mock');
      return next();
    }
  }

  const cookies = parseCookies(c.req.header('Cookie'));
  const signed = cookies[SESSION_COOKIE_NAME];
  const path = new URL(c.req.url).pathname;

  if (!signed) {
    if (wantsJson(c.req.header('Accept'), path)) {
      return c.json({ error: 'Authentication required' }, 401);
    }
    return redirectToLogin(path);
  }

  const sessionId = await verifySignedValue(signed, c.env.SESSION_SECRET);
  if (!sessionId) {
    if (wantsJson(c.req.header('Accept'), path)) {
      return c.json({ error: 'Invalid session cookie' }, 401);
    }
    return redirectToLogin(path);
  }

  const resolved = await resolveSession(c.env.DB, sessionId);
  if (!resolved) {
    if (wantsJson(c.req.header('Accept'), path)) {
      return c.json({ error: 'Session expired' }, 401);
    }
    return redirectToLogin(path);
  }

  c.set('user', resolved.user);
  c.set('sessionId', resolved.sessionId);
  return next();
});

export function requireRole(minRole: RoleName) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const user = c.get('user');
    if (!user || !hasMinRole(user.roles, minRole)) {
      const path = new URL(c.req.url).pathname;
      if (wantsJson(c.req.header('Accept'), path)) {
        return c.json({ error: 'Insufficient permissions' }, 403);
      }
      return c.redirect('/access-denied', 302);
    }
    return next();
  });
}
