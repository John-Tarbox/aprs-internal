-- Identity & authorization schema for aprs-internal.
--
-- Two identity providers (Okta, Google) feed a single users table, gated
-- by a local roles model. Sessions live server-side in D1 so admin
-- deactivation invalidates live cookies on the next request.

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  auth_type TEXT NOT NULL CHECK (auth_type IN ('okta','google')),
  display_name TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  invited_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_users_email_active ON users(email, active);

CREATE TABLE IF NOT EXISTS roles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  description TEXT
);

CREATE TABLE IF NOT EXISTS user_roles (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  granted_at TEXT NOT NULL DEFAULT (datetime('now')),
  granted_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (user_id, role_id)
);
CREATE INDEX IF NOT EXISTS idx_user_roles_user ON user_roles(user_id);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,                -- 32-byte hex, opaque
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  user_agent TEXT,
  ip TEXT,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  metadata TEXT,                      -- JSON blob
  ip TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_action_time ON audit_log(action, created_at);
