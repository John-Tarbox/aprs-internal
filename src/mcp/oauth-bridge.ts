/**
 * OAuth bridge: kicks off the Okta sign-in flow on behalf of an
 * MCP / Claude.ai connector that has hit /authorize on this Worker.
 *
 * The flow:
 *   1. Claude.ai → GET /authorize?response_type=code&client_id=…&redirect_uri=…
 *   2. We parse the OAuth AuthRequest via OAUTH_PROVIDER.parseAuthRequest.
 *   3. We auto-register the calling client if it isn't known yet (Claude.ai
 *      uses Dynamic Client Registration on first connect).
 *   4. We stash the AuthRequest as a JSON blob in the OIDC state cookie
 *      (signed) and redirect the browser to Okta.
 *   5. The Okta callback (src/routes/auth.routes.ts) detects the stashed
 *      AuthRequest and completes the OAuth grant via
 *      OAUTH_PROVIDER.completeAuthorization, redirecting back to Claude.ai.
 *
 * Why this lives outside the existing /auth/* tree: it's the public face
 * of the OAuth provider, not part of the staff-facing OIDC consumer flow.
 * Keeping the file separate keeps the surface clear when reading either side.
 */

import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { oktaConfig } from '../services/okta.service';
import { beginLogin } from '../services/oidc.service';

export const oauthBridgeRoutes = new Hono<AppEnv>();

oauthBridgeRoutes.get('/', async (c) => {
  let authReq;
  try {
    authReq = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
  } catch (err) {
    console.error('parseAuthRequest failed:', err);
    return c.text(`Invalid OAuth authorization request: ${(err as Error).message}`, 400);
  }

  // First-connect path: Claude.ai issues a Dynamic Client Registration
  // POST to /register *before* /authorize, so by the time we get here the
  // client should already exist. If it doesn't, treat the request as
  // invalid rather than silently auto-creating — silent creation would
  // make typo'd client_ids look like real ones.
  const client = await c.env.OAUTH_PROVIDER.lookupClient(authReq.clientId);
  if (!client) {
    return c.text(
      `Unknown OAuth client_id "${authReq.clientId}". The client must register at /register first.`,
      400
    );
  }

  // Round-trip the AuthRequest through Okta in the signed PKCE state cookie.
  // The Okta callback unpacks payload.m, calls completeAuthorization, and
  // redirects back to Claude.ai. No KV stash needed.
  const config = oktaConfig(c.env);
  const { authorizeUrl, setCookie } = await beginLogin(
    config,
    c.env.SESSION_SECRET,
    undefined,                       // no post-login redirect — MCP path takes over
    JSON.stringify(authReq)
  );
  c.header('Set-Cookie', setCookie);
  return c.redirect(authorizeUrl, 302);
});
