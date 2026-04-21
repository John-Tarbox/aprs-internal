export interface Env {
  DB: D1Database;

  ENVIRONMENT: 'production' | 'development';
  OKTA_DOMAIN: string;
  OKTA_CLIENT_ID: string;
  SITE_URL: string;

  OKTA_CLIENT_SECRET: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  SESSION_SECRET: string;
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
