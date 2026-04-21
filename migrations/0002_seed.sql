-- Seed the three starter roles and the bootstrap admin user.
-- Safe to run multiple times against a fresh DB; against an existing
-- DB the UNIQUE constraints will (correctly) error and leave data untouched.

INSERT INTO roles (name, description) VALUES
  ('admin',  'Full admin; can manage users and all content'),
  ('staff',  'Staff member with elevated read/write'),
  ('viewer', 'Read-only internal access');

-- Bootstrap admin. This account MUST exist in aprsfoundation.okta.com so
-- first sign-in via Okta succeeds. After that, further users are added
-- through the /admin/users UI rather than new migrations.
INSERT INTO users (email, auth_type, display_name, active)
  VALUES ('john.tarbox@aprsfoundation.org', 'okta', 'John Tarbox (Bootstrap Admin)', 1);

INSERT INTO user_roles (user_id, role_id)
  SELECT u.id, r.id FROM users u, roles r
  WHERE u.email = 'john.tarbox@aprsfoundation.org' AND r.name = 'admin';
