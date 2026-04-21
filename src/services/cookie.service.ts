/**
 * HMAC-signed cookie helpers. Used for:
 *  - the session cookie (`session=<id>.<sig>`) — opaque session id, D1-backed
 *  - the short-lived OIDC state cookie (`oidc_state=<payload>.<sig>`) —
 *    carries PKCE verifier + post-login redirect across the round-trip
 *    to the identity provider
 *
 * Both use the same HMAC-SHA256 signing with SESSION_SECRET so we don't need
 * a separate secret. Signing is defence in depth; the session id is itself
 * an unguessable 32-byte value and the state cookie is short-TTL.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(input: string): Uint8Array {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (input.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

export async function signValue(value: string, secret: string): Promise<string> {
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(value));
  return `${value}.${base64UrlEncode(new Uint8Array(sig))}`;
}

export async function verifySignedValue(signed: string, secret: string): Promise<string | null> {
  const lastDot = signed.lastIndexOf('.');
  if (lastDot <= 0) return null;
  const value = signed.slice(0, lastDot);
  const sig = signed.slice(lastDot + 1);
  const key = await hmacKey(secret);
  const sigBytes = base64UrlDecode(sig);
  const ok = await crypto.subtle.verify('HMAC', key, sigBytes, encoder.encode(value));
  return ok ? value : null;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

export interface CookieOptions {
  maxAgeSeconds?: number;
  path?: string;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Lax' | 'Strict' | 'None';
  expires?: Date;
}

export function serializeCookie(name: string, value: string, opts: CookieOptions = {}): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${opts.path ?? '/'}`);
  if (opts.maxAgeSeconds !== undefined) parts.push(`Max-Age=${opts.maxAgeSeconds}`);
  if (opts.expires) parts.push(`Expires=${opts.expires.toUTCString()}`);
  if (opts.httpOnly ?? true) parts.push('HttpOnly');
  if (opts.secure ?? true) parts.push('Secure');
  parts.push(`SameSite=${opts.sameSite ?? 'Lax'}`);
  return parts.join('; ');
}

export function clearCookieSerialized(name: string, path = '/'): string {
  return `${name}=; Path=${path}; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

/** Pack an object as a signed cookie value (JSON → base64url → HMAC). */
export async function signJsonValue(payload: unknown, secret: string): Promise<string> {
  const json = JSON.stringify(payload);
  const encoded = base64UrlEncode(encoder.encode(json));
  return signValue(encoded, secret);
}

/** Inverse of `signJsonValue`. Returns null on tampering or malformed input. */
export async function verifyJsonValue<T = unknown>(signed: string, secret: string): Promise<T | null> {
  const value = await verifySignedValue(signed, secret);
  if (!value) return null;
  try {
    const json = decoder.decode(base64UrlDecode(value));
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}
