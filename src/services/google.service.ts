/**
 * Google-specific OIDC configuration.
 *
 * IMPORTANT: we deliberately do NOT set an `hd` hosted-domain parameter.
 * Per the product requirements, ANY Google account is allowed through
 * identity; authorization is enforced entirely by the D1 `users` allow-list.
 */

import type { Env } from '../env';
import type { OidcProviderConfig } from './oidc.service';

export function googleConfig(env: Env): OidcProviderConfig {
  return {
    providerId: 'google',
    authorizeEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenEndpoint: 'https://oauth2.googleapis.com/token',
    jwksUri: 'https://www.googleapis.com/oauth2/v3/certs',
    issuer: 'https://accounts.google.com',
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    redirectUri: `${env.SITE_URL}/auth/google/callback`,
    scope: 'openid email profile',
  };
}
