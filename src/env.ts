export interface Env {
  DB: D1Database;
  KANBAN_DO: DurableObjectNamespace;

  ENVIRONMENT: 'production' | 'development';
  OKTA_DOMAIN: string;
  OKTA_CLIENT_ID: string;
  SITE_URL: string;

  OKTA_CLIENT_SECRET: string;
  // Google is optional — sign-in with Google is disabled when these are missing.
  // See `googleConfigured()` in src/routes/auth.routes.ts.
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  SESSION_SECRET: string;
  // Optional. When set, enables GET /auth/guest-login?token=X&email=Y
  // as a testing-only bypass for users blocked from the normal OIDC flow.
  // Delete the secret to disable the endpoint entirely.
  GUEST_LOGIN_TOKEN?: string;
}

export type AuthType = 'okta' | 'google';
export type RoleName = 'admin' | 'staff' | 'viewer';

export interface AuthUser {
  id: number;
  email: string;
  authType: AuthType;
  displayName: string | null;
  roles: RoleName[];
}

export type AppEnv = {
  Bindings: Env;
  Variables: {
    user: AuthUser;
    sessionId: string;
  };
};
