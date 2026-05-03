/**
 * OIDC routes for Okta and Google. Symmetrical flows; the only differences
 * are the provider config and the handling of unknown-email Google sign-ins.
 *
 *   GET  /auth/okta/login        — kick off Okta flow
 *   GET  /auth/okta/callback     — exchange code, create session
 *   GET  /auth/google/login      — kick off Google flow
 *   GET  /auth/google/callback   — exchange code, check allow-list, create session
 *   POST /auth/logout            — revoke current session, clear cookie
 */

import { Hono, type Context } from 'hono';
import type { AppEnv, RoleName } from '../env';
import { oktaConfig } from '../services/okta.service';
import { googleConfig } from '../services/google.service';
import { beginLogin, handleCallback, stateCookieName, type OidcProviderConfig } from '../services/oidc.service';
import { verifyIdToken } from '../services/jwks.service';
import { parseCookies, serializeCookie, signValue, clearCookieSerialized } from '../services/cookie.service';
import { createSession, revokeSession, touchLastLogin } from '../services/session.service';
import { findUserByEmail, getUserRoles, insertUser, setUserRoles } from '../services/users.service';
import { writeAudit } from '../services/audit.service';
import { SESSION_COOKIE_NAME } from '../middleware/auth';

const OKTA_SESSION_TTL = 7 * 24 * 60 * 60;   // 7 days
const GOOGLE_SESSION_TTL = 8 * 60 * 60;      // 8 hours
const GUEST_SESSION_TTL = 24 * 60 * 60;      // 24 hours — bypass is short-lived
// Okta auto-provisions anyone in the APRS Foundation tenant as staff on
// first sign-in. Google users remain admin-invite-only (see /google/callback).
const DEFAULT_NEW_USER_ROLE: RoleName = 'staff';

/** Constant-time string compare. Equal-length strings only. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const authRoutes = new Hono<AppEnv>();

function safeNext(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  // Only allow same-origin relative paths. Reject protocol-relative, absolute URLs, anything weird.
  if (!raw.startsWith('/') || raw.startsWith('//')) return undefined;
  return raw;
}

function getClientIp(c: Context<AppEnv>): string | null {
  return c.req.header('CF-Connecting-IP') ?? c.req.header('X-Forwarded-For') ?? null;
}

async function issueSessionCookie(
  sessionId: string,
  secret: string,
  ttlSeconds: number
): Promise<string> {
  const signed = await signValue(sessionId, secret);
  return serializeCookie(SESSION_COOKIE_NAME, signed, {
    maxAgeSeconds: ttlSeconds,
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
  });
}

// ── Guest login (testing-only bypass) ───────────────────────────────────
//
// Opt-in via the GUEST_LOGIN_TOKEN wrangler secret. When the secret is
// unset, this endpoint is a hard 403 — nothing an attacker can probe for
// reveals whether it's armed. When set, a caller with the secret token
// can sign in as any email; the row is auto-provisioned as staff if it
// doesn't exist. Use sparingly, rotate by rewriting the secret, and
// delete the secret entirely when done (`wrangler secret delete GUEST_LOGIN_TOKEN`).
//
// Every invocation writes a login.guest (or login.guest.denied) audit row
// so the usage trail is queryable.
authRoutes.get('/guest-login', async (c) => {
  const expected = c.env.GUEST_LOGIN_TOKEN;
  if (!expected) {
    // Do not leak whether the feature is armed — treat missing secret
    // the same as a bad token.
    return c.text('Not found', 404);
  }

  const tokenRaw = c.req.query('token') ?? '';
  const emailRaw = (c.req.query('email') ?? '').trim().toLowerCase();

  if (!safeEqual(tokenRaw, expected)) {
    await writeAudit(c.env.DB, {
      action: 'login.guest.denied',
      metadata: { reason: 'bad token', emailAttempted: emailRaw || null },
      ip: getClientIp(c),
    });
    return c.text('Forbidden', 403);
  }

  if (!emailRaw || !EMAIL_RE.test(emailRaw)) {
    await writeAudit(c.env.DB, {
      action: 'login.guest.denied',
      metadata: { reason: 'missing or invalid email', emailAttempted: emailRaw || null },
      ip: getClientIp(c),
    });
    return c.text('Missing or invalid email query parameter', 400);
  }

  let user = await findUserByEmail(c.env.DB, emailRaw);
  if (user && !user.active) {
    await writeAudit(c.env.DB, {
      userId: user.id,
      action: 'login.guest.denied',
      metadata: { email: emailRaw, reason: 'account deactivated' },
      ip: getClientIp(c),
    });
    return c.redirect(
      `/access-denied?reason=${encodeURIComponent('Account is deactivated.')}`,
      302
    );
  }
  if (!user) {
    user = await insertUser(c.env.DB, { email: emailRaw, authType: 'okta' });
    await setUserRoles(c.env.DB, user.id, [DEFAULT_NEW_USER_ROLE], null);
  }

  const sessionId = await createSession(c.env.DB, {
    userId: user.id,
    ttlSeconds: GUEST_SESSION_TTL,
    userAgent: c.req.header('User-Agent') ?? undefined,
    ip: getClientIp(c) ?? undefined,
  });
  await touchLastLogin(c.env.DB, user.id);
  await writeAudit(c.env.DB, {
    userId: user.id,
    action: 'login.guest',
    metadata: { email: emailRaw },
    ip: getClientIp(c),
  });

  const cookie = await issueSessionCookie(sessionId, c.env.SESSION_SECRET, GUEST_SESSION_TTL);
  c.header('Set-Cookie', cookie, { append: true });

  // Never honor a `next` — guest login always drops the user on the home page.
  return c.redirect('/', 302);
});

// ── Okta ────────────────────────────────────────────────────────────────

authRoutes.get('/okta/login', async (c) => {
  const config = oktaConfig(c.env);
  const next = safeNext(c.req.query('next'));
  const { authorizeUrl, setCookie } = await beginLogin(config, c.env.SESSION_SECRET, next);
  c.header('Set-Cookie', setCookie);
  return c.redirect(authorizeUrl, 302);
});

authRoutes.get('/okta/callback', async (c) => {
  const config = oktaConfig(c.env);
  try {
    const result = await runOidcCallback(c, config);
    if (result instanceof Response) return result;

    const { claims } = result;
    const email = claims.email;
    if (!email) throw new Error('ID token missing email claim');

    // Upsert by email. If an Okta user doesn't exist, auto-create with the
    // default role. If a row exists with auth_type='google', we leave it
    // alone and refuse to sign in as Okta — one email, one identity source.
    let user = await findUserByEmail(c.env.DB, email);
    if (user && user.authType !== 'okta') {
      await writeAudit(c.env.DB, {
        action: 'login.okta.denied',
        metadata: { email, reason: 'email exists as google-only user; Okta sign-in rejected' },
        ip: getClientIp(c),
      });
      return c.redirect(`/access-denied?reason=${encodeURIComponent('This email is registered as an external (Google) user, not an Okta user.')}`, 302);
    }
    if (!user) {
      user = await insertUser(c.env.DB, {
        email,
        authType: 'okta',
        displayName: (claims.name as string | undefined) ?? undefined,
      });
      await setUserRoles(c.env.DB, user.id, [DEFAULT_NEW_USER_ROLE], null);
    }
    if (!user.active) {
      await writeAudit(c.env.DB, {
        userId: user.id,
        action: 'login.okta.denied',
        metadata: { email, reason: 'account deactivated' },
        ip: getClientIp(c),
      });
      return c.redirect(`/access-denied?reason=${encodeURIComponent('Your account has been deactivated. Contact an admin.')}`, 302);
    }

    // MCP / Claude.ai connector flow: when /authorize stashed the OAuth
    // AuthRequest in the OIDC state cookie, finish by minting an OAuth
    // grant + redirecting back to the connector's redirect_uri instead of
    // creating a regular browser session for the dashboard. The user's
    // identity is now confirmed via Okta; we hand it to the OAuthProvider.
    if (result.mcpAuthRequest) {
      try {
        const authReq = JSON.parse(result.mcpAuthRequest) as Parameters<
          typeof c.env.OAUTH_PROVIDER.completeAuthorization
        >[0]['request'];
        const userRoles = await getUserRoles(c.env.DB, user.id);
        const isAdmin = userRoles.includes('admin');
        const isStaff = isAdmin || userRoles.includes('staff');
        const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
          request: authReq,
          userId: String(user.id),
          metadata: { email, displayName: user.displayName ?? null },
          scope: authReq.scope,
          props: {
            userId: user.id,
            email,
            displayName: user.displayName ?? null,
            isStaff,
            isAdmin,
          },
        });
        await touchLastLogin(c.env.DB, user.id);
        await writeAudit(c.env.DB, {
          userId: user.id,
          action: 'login.okta.mcp',
          metadata: { clientId: authReq.clientId },
          ip: getClientIp(c),
        });
        return c.redirect(redirectTo, 302);
      } catch (err) {
        console.error('mcp completeAuthorization failed:', err);
        return c.redirect(
          `/login?error=${encodeURIComponent('MCP authorization failed. Please try again.')}`,
          302
        );
      }
    }

    const sessionId = await createSession(c.env.DB, {
      userId: user.id,
      ttlSeconds: OKTA_SESSION_TTL,
      userAgent: c.req.header('User-Agent') ?? undefined,
      ip: getClientIp(c) ?? undefined,
    });
    await touchLastLogin(c.env.DB, user.id);
    await writeAudit(c.env.DB, { userId: user.id, action: 'login.okta', ip: getClientIp(c) });

    const cookie = await issueSessionCookie(sessionId, c.env.SESSION_SECRET, OKTA_SESSION_TTL);
    c.header('Set-Cookie', cookie, { append: true });

    return c.redirect(result.redirectAfterLogin ?? '/', 302);
  } catch (err) {
    console.error('okta callback error:', err);
    try {
      await writeAudit(c.env.DB, {
        action: 'login.okta.failed',
        metadata: {
          error: String((err as Error)?.message ?? err),
          stack: (err as Error)?.stack,
        },
        ip: getClientIp(c),
      });
    } catch (auditErr) {
      console.error('failed to write okta failure audit row:', auditErr);
    }
    return c.redirect(`/login?error=${encodeURIComponent('Okta sign-in failed. Please try again.')}`, 302);
  }
});

// ── Google ──────────────────────────────────────────────────────────────

function googleConfigured(env: AppEnv['Bindings']): boolean {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
}

authRoutes.get('/google/login', async (c) => {
  if (!googleConfigured(c.env)) {
    return c.redirect(`/login?error=${encodeURIComponent('Google sign-in is not configured yet. Use Okta.')}`, 302);
  }
  const config = googleConfig(c.env);
  const next = safeNext(c.req.query('next'));
  const { authorizeUrl, setCookie } = await beginLogin(config, c.env.SESSION_SECRET, next);
  c.header('Set-Cookie', setCookie);
  return c.redirect(authorizeUrl, 302);
});

authRoutes.get('/google/callback', async (c) => {
  if (!googleConfigured(c.env)) {
    return c.redirect(`/login?error=${encodeURIComponent('Google sign-in is not configured yet.')}`, 302);
  }
  const config = googleConfig(c.env);
  try {
    const result = await runOidcCallback(c, config);
    if (result instanceof Response) return result;

    const { claims } = result;
    const email = claims.email;
    if (!email) throw new Error('Google ID token missing email claim');
    if (claims.email_verified !== true) {
      await writeAudit(c.env.DB, {
        action: 'login.google.denied',
        metadata: { email, reason: 'email_verified=false' },
        ip: getClientIp(c),
      });
      return c.redirect(`/access-denied?email=${encodeURIComponent(email)}`, 302);
    }

    const user = await findUserByEmail(c.env.DB, email, 'google');
    if (!user || !user.active) {
      await writeAudit(c.env.DB, {
        action: 'login.google.denied',
        metadata: { email, reason: !user ? 'not on allow-list' : 'deactivated' },
        ip: getClientIp(c),
      });
      return c.redirect(`/access-denied?email=${encodeURIComponent(email)}`, 302);
    }

    const sessionId = await createSession(c.env.DB, {
      userId: user.id,
      ttlSeconds: GOOGLE_SESSION_TTL,
      userAgent: c.req.header('User-Agent') ?? undefined,
      ip: getClientIp(c) ?? undefined,
    });
    await touchLastLogin(c.env.DB, user.id);
    await writeAudit(c.env.DB, { userId: user.id, action: 'login.google', ip: getClientIp(c) });

    const cookie = await issueSessionCookie(sessionId, c.env.SESSION_SECRET, GOOGLE_SESSION_TTL);
    c.header('Set-Cookie', cookie, { append: true });

    return c.redirect(result.redirectAfterLogin ?? '/', 302);
  } catch (err) {
    console.error('google callback error:', err);
    try {
      await writeAudit(c.env.DB, {
        action: 'login.google.failed',
        metadata: {
          error: String((err as Error)?.message ?? err),
          stack: (err as Error)?.stack,
        },
        ip: getClientIp(c),
      });
    } catch (auditErr) {
      console.error('failed to write google failure audit row:', auditErr);
    }
    return c.redirect(`/login?error=${encodeURIComponent('Google sign-in failed. Please try again.')}`, 302);
  }
});

// ── Logout ──────────────────────────────────────────────────────────────

authRoutes.post('/logout', async (c) => {
  const cookies = parseCookies(c.req.header('Cookie'));
  const signed = cookies[SESSION_COOKIE_NAME];
  if (signed) {
    const { verifySignedValue } = await import('../services/cookie.service');
    const sessionId = await verifySignedValue(signed, c.env.SESSION_SECRET);
    if (sessionId) {
      await revokeSession(c.env.DB, sessionId);
      await writeAudit(c.env.DB, { action: 'logout', ip: getClientIp(c) });
    }
  }
  c.header('Set-Cookie', clearCookieSerialized(SESSION_COOKIE_NAME));
  return c.redirect('/login', 302);
});

// ── Shared callback plumbing ────────────────────────────────────────────

interface OidcCallbackSuccess {
  claims: Awaited<ReturnType<typeof verifyIdToken>>;
  redirectAfterLogin?: string;
  /** Echo of the MCP / Claude.ai AuthRequest that beginLogin stashed in
   *  the OIDC state cookie, if any. When set, the Okta callback dispatches
   *  to OAUTH_PROVIDER.completeAuthorization instead of issuing a session. */
  mcpAuthRequest?: string;
}

/**
 * Drives the shared code path: read the state cookie, validate the `state`
 * param, exchange the code, verify the ID token. Returns either the
 * decoded claims (plus redirect) or a ready-to-send Response for error cases.
 */
async function runOidcCallback(
  c: Context<AppEnv>,
  config: OidcProviderConfig
): Promise<OidcCallbackSuccess | Response> {
  const code = c.req.query('code');
  const state = c.req.query('state');
  const errorParam = c.req.query('error');

  if (errorParam) {
    console.warn(`OIDC error from ${config.providerId}:`, errorParam, c.req.query('error_description'));
    return c.redirect(
      `/login?error=${encodeURIComponent(`Sign-in was cancelled or failed (${errorParam}).`)}`,
      302
    );
  }
  if (!code || !state) {
    return c.redirect(`/login?error=${encodeURIComponent('Invalid callback parameters.')}`, 302);
  }

  const cookies = parseCookies(c.req.header('Cookie'));
  const stateCookie = cookies[stateCookieName(config.providerId)];

  const { tokens, redirectAfterLogin, mcpAuthRequest, clearStateCookie } = await handleCallback({
    config,
    secret: c.env.SESSION_SECRET,
    code,
    returnedState: state,
    stateCookieValue: stateCookie,
  });

  const claims = await verifyIdToken({
    idToken: tokens.id_token,
    jwksUri: config.jwksUri,
    expectedIssuer: config.issuer,
    expectedAudience: config.clientId,
  });

  c.header('Set-Cookie', clearStateCookie, { append: true });

  return { claims, redirectAfterLogin: safeNext(redirectAfterLogin), mcpAuthRequest };
}
