/**
 * Okta-specific OIDC configuration. All mechanics live in oidc.service.ts;
 * this file is just the config factory.
 */

import type { Env } from '../env';
import type { OidcProviderConfig } from './oidc.service';

export function oktaConfig(env: Env): OidcProviderConfig {
  const domain = env.OKTA_DOMAIN;
  return {
    providerId: 'okta',
    authorizeEndpoint: `https://${domain}/oauth2/v1/authorize`,
    tokenEndpoint: `https://${domain}/oauth2/v1/token`,
    jwksUri: `https://${domain}/oauth2/v1/keys`,
    issuer: `https://${domain}`,
    clientId: env.OKTA_CLIENT_ID,
    clientSecret: env.OKTA_CLIENT_SECRET,
    redirectUri: `${env.SITE_URL}/auth/okta/callback`,
    scope: 'openid profile email',
  };
}
