/**
 * Provider-agnostic OIDC Authorization Code + PKCE helpers.
 *
 * FAQ keeps PKCE state in KV (`pkce:${state}` keys). We deliberately avoid
 * KV here to keep the MVP binding set minimal — the PKCE state is instead
 * packed into a short-lived signed cookie that travels with the user's
 * round-trip to the identity provider.
 */

import { signJsonValue, verifyJsonValue, serializeCookie, clearCookieSerialized } from './cookie.service';

export interface OidcProviderConfig {
  providerId: string;                 // 'okta' | 'google' — used in cookie name to keep flows isolated
  authorizeEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  issuer: string;                     // expected `iss` in the ID token
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scope: string;
}

export interface PkceStateCookie {
  p: string;                          // provider id (sanity check on callback)
  s: string;                          // opaque state (anti-CSRF)
  v: string;                          // PKCE code_verifier
  r?: string;                         // post-login redirect path
  /**
   * Optional: serialized OAuth AuthRequest from the MCP / Claude.ai
   * connector flow. When present, the callback finishes by calling
   * `oauthProvider.completeAuthorization()` and redirecting to the
   * Claude.ai-supplied redirect_uri instead of the dashboard. Carrying
   * the AuthRequest here (signed cookie on the user's browser) lets us
   * round-trip Okta without needing a KV stash.
   */
  m?: string;                         // JSON-serialized AuthRequest
}

const STATE_COOKIE_TTL_SECONDS = 5 * 60;

function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
}

function base64UrlEncode(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function codeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64UrlEncode(digest);
}

export function stateCookieName(providerId: string): string {
  return `oidc_state_${providerId}`;
}

export interface BeginLoginResult {
  authorizeUrl: string;
  setCookie: string;                  // Set-Cookie header value for the PKCE state cookie
}

export async function beginLogin(
  config: OidcProviderConfig,
  secret: string,
  redirectAfterLogin: string | undefined,
  /**
   * Optional MCP-flow payload. When provided, it survives the Okta
   * round-trip in the signed PKCE state cookie and is read back in the
   * callback to complete an OAuth authorization for Claude.ai.
   */
  mcpAuthRequest?: string | undefined
): Promise<BeginLoginResult> {
  const state = randomHex(16);
  const verifier = randomHex(32);
  const challenge = await codeChallenge(verifier);

  const cookiePayload: PkceStateCookie = {
    p: config.providerId,
    s: state,
    v: verifier,
    r: redirectAfterLogin,
    m: mcpAuthRequest,
  };
  const signed = await signJsonValue(cookiePayload, secret);

  const params = new URLSearchParams({
    client_id: config.clientId,
    response_type: 'code',
    scope: config.scope,
    redirect_uri: config.redirectUri,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });

  return {
    authorizeUrl: `${config.authorizeEndpoint}?${params}`,
    setCookie: serializeCookie(stateCookieName(config.providerId), signed, {
      maxAgeSeconds: STATE_COOKIE_TTL_SECONDS,
      sameSite: 'Lax',
      httpOnly: true,
      secure: true,
      path: '/',
    }),
  };
}

export interface TokenResponse {
  id_token: string;
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in: number;
}

export interface HandleCallbackArgs {
  config: OidcProviderConfig;
  secret: string;
  code: string;
  returnedState: string;
  stateCookieValue: string | undefined;
}

export interface HandleCallbackResult {
  tokens: TokenResponse;
  redirectAfterLogin?: string;
  /** Echoes back the MCP AuthRequest passed into beginLogin, if any. */
  mcpAuthRequest?: string;
  clearStateCookie: string;
}

/** Exchange the authorization code for tokens. Throws on any mismatch. */
export async function handleCallback(args: HandleCallbackArgs): Promise<HandleCallbackResult> {
  if (!args.stateCookieValue) {
    throw new Error('Missing PKCE state cookie (expired or third-party cookie blocked?)');
  }
  const payload = await verifyJsonValue<PkceStateCookie>(args.stateCookieValue, args.secret);
  if (!payload) throw new Error('PKCE state cookie signature invalid');
  if (payload.p !== args.config.providerId) throw new Error('PKCE state cookie provider mismatch');
  if (payload.s !== args.returnedState) throw new Error('OAuth state parameter mismatch (possible CSRF)');

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: args.code,
    redirect_uri: args.config.redirectUri,
    client_id: args.config.clientId,
    client_secret: args.config.clientSecret,
    code_verifier: payload.v,
  });

  const res = await fetch(args.config.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: body.toString(),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${err}`);
  }

  const tokens = (await res.json()) as TokenResponse;

  return {
    tokens,
    redirectAfterLogin: payload.r,
    mcpAuthRequest: payload.m,
    clearStateCookie: clearCookieSerialized(stateCookieName(args.config.providerId)),
  };
}
