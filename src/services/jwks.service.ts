/**
 * JWKS fetch + ID-token verification.
 *
 * Keys are cached per-issuer in a module-level Map with a TTL. This is
 * fine for a Worker because each isolate handles many requests and keys
 * rotate infrequently (hours to days). A cold isolate pays one fetch;
 * subsequent requests in the same isolate reuse the cache.
 */

export interface VerifiedIdToken {
  iss: string;
  aud: string | string[];
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
  hd?: string;
  iat: number;
  exp: number;
  nbf?: number;
  [claim: string]: unknown;
}

interface Jwk {
  kty: string;
  kid: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
  crv?: string;
  x?: string;
  y?: string;
}

interface JwksCacheEntry {
  keysByKid: Map<string, CryptoKey>;
  fetchedAt: number;
}

const JWKS_TTL_MS = 60 * 60 * 1000; // 1 hour
const jwksCache = new Map<string, JwksCacheEntry>();

function base64UrlDecode(input: string): Uint8Array {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (input.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeJson<T>(part: string): T {
  return JSON.parse(new TextDecoder().decode(base64UrlDecode(part))) as T;
}

async function importJwk(jwk: Jwk): Promise<CryptoKey | null> {
  // Okta and Google both publish RS256 keys (RSA-SHA256).
  if (jwk.kty !== 'RSA' || !jwk.n || !jwk.e) return null;
  return crypto.subtle.importKey(
    'jwk',
    { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', use: 'sig', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  );
}

async function fetchJwks(jwksUri: string): Promise<JwksCacheEntry> {
  const res = await fetch(jwksUri, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`JWKS fetch failed (${res.status}) from ${jwksUri}`);
  const { keys } = (await res.json()) as { keys: Jwk[] };
  const keysByKid = new Map<string, CryptoKey>();
  for (const jwk of keys ?? []) {
    const key = await importJwk(jwk);
    if (key && jwk.kid) keysByKid.set(jwk.kid, key);
  }
  return { keysByKid, fetchedAt: Date.now() };
}

async function getJwksEntry(jwksUri: string, forceRefresh = false): Promise<JwksCacheEntry> {
  const cached = jwksCache.get(jwksUri);
  if (!forceRefresh && cached && Date.now() - cached.fetchedAt < JWKS_TTL_MS) {
    return cached;
  }
  const fresh = await fetchJwks(jwksUri);
  jwksCache.set(jwksUri, fresh);
  return fresh;
}

export interface VerifyIdTokenArgs {
  idToken: string;
  jwksUri: string;
  expectedIssuer: string;
  expectedAudience: string;
  clockSkewSeconds?: number;
}

/**
 * Verify an RS256-signed JWT ID token: signature, iss, aud, exp, nbf, iat.
 * Returns the decoded claims on success. Throws on any mismatch.
 *
 * One retry with forced JWKS refresh if the `kid` isn't in cache — covers
 * the case where an identity provider rotated signing keys after our last fetch.
 */
export async function verifyIdToken(args: VerifyIdTokenArgs): Promise<VerifiedIdToken> {
  const [headerB64, payloadB64, sigB64] = args.idToken.split('.');
  if (!headerB64 || !payloadB64 || !sigB64) throw new Error('ID token malformed');

  const header = decodeJson<{ alg: string; kid?: string; typ?: string }>(headerB64);
  if (header.alg !== 'RS256') throw new Error(`Unsupported ID token alg: ${header.alg}`);
  if (!header.kid) throw new Error('ID token header missing kid');

  let jwks = await getJwksEntry(args.jwksUri);
  let key = jwks.keysByKid.get(header.kid);
  if (!key) {
    jwks = await getJwksEntry(args.jwksUri, true);
    key = jwks.keysByKid.get(header.kid);
    if (!key) throw new Error(`No JWKS key for kid=${header.kid}`);
  }

  const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const sigBytes = base64UrlDecode(sigB64);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sigBytes, signingInput);
  if (!ok) throw new Error('ID token signature invalid');

  const claims = decodeJson<VerifiedIdToken>(payloadB64);

  if (claims.iss !== args.expectedIssuer) {
    throw new Error(`ID token issuer mismatch: got ${claims.iss}, expected ${args.expectedIssuer}`);
  }

  const audList = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audList.includes(args.expectedAudience)) {
    throw new Error(`ID token audience mismatch: got ${JSON.stringify(claims.aud)}, expected ${args.expectedAudience}`);
  }

  const skew = args.clockSkewSeconds ?? 30;
  const now = Math.floor(Date.now() / 1000);
  if (claims.exp + skew < now) throw new Error('ID token expired');
  if (claims.nbf !== undefined && claims.nbf - skew > now) throw new Error('ID token not yet valid');
  if (claims.iat - skew > now) throw new Error('ID token iat in the future');

  return claims;
}
