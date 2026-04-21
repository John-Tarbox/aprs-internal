/**
 * Admin user-management UI. All routes require the `admin` role (enforced
 * at the app-composition level in src/index.ts via requireRole('admin')).
 *
 *   GET  /admin/users
 *   POST /admin/users                       — add external Google user
 *   POST /admin/users/:id/roles             — change a user's role
 *   POST /admin/users/:id/deactivate
 *   POST /admin/users/:id/reactivate
 */

import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv, RoleName } from '../env';
import { AdminUsersPage } from '../pages/AdminUsersPage';
import {
  listUsers,
  findUserByEmail,
  insertUser,
  setUserRoles,
  deactivateUser,
  reactivateUser,
} from '../services/users.service';
import { revokeAllForUser } from '../services/session.service';
import { writeAudit } from '../services/audit.service';

const ROLE_ENUM = z.enum(['admin', 'staff', 'viewer']);

const addUserSchema = z.object({
  email: z.string().email(),
  displayName: z.string().max(200).optional().or(z.literal('')),
  role: ROLE_ENUM,
});

const setRoleSchema = z.object({
  role: ROLE_ENUM,
});

export const adminRoutes = new Hono<AppEnv>();

adminRoutes.get('/users', async (c) => {
  const user = c.get('user');
  const users = await listUsers(c.env.DB);
  const flashKind = c.req.query('ok') ? 'ok' : c.req.query('err') ? 'err' : undefined;
  const flashMsg = c.req.query('ok') ?? c.req.query('err') ?? undefined;
  return c.html(
    <AdminUsersPage
      user={user}
      users={users}
      flash={flashKind && flashMsg ? { kind: flashKind, message: flashMsg } : undefined}
    />
  );
});

adminRoutes.post('/users', async (c) => {
  const user = c.get('user');
  const form = await c.req.formData();
  const parsed = addUserSchema.safeParse({
    email: form.get('email'),
    displayName: form.get('displayName'),
    role: form.get('role'),
  });
  if (!parsed.success) {
    return c.redirect(`/admin/users?err=${encodeURIComponent('Invalid input: ' + parsed.error.issues[0].message)}`, 302);
  }

  const existing = await findUserByEmail(c.env.DB, parsed.data.email);
  if (existing) {
    return c.redirect(`/admin/users?err=${encodeURIComponent(`User ${parsed.data.email} already exists (${existing.authType}).`)}`, 302);
  }

  const created = await insertUser(c.env.DB, {
    email: parsed.data.email,
    authType: 'google',
    displayName: parsed.data.displayName || undefined,
    invitedByUserId: user.id,
  });
  await setUserRoles(c.env.DB, created.id, [parsed.data.role as RoleName], user.id);
  await writeAudit(c.env.DB, {
    userId: user.id,
    action: 'user.invited',
    metadata: { invitedUserId: created.id, email: created.email, role: parsed.data.role },
  });

  return c.redirect(`/admin/users?ok=${encodeURIComponent(`Added ${created.email}. They can now sign in with Google.`)}`, 302);
});

adminRoutes.post('/users/:id/roles', async (c) => {
  const user = c.get('user');
  const targetId = Number(c.req.param('id'));
  if (!Number.isFinite(targetId)) return c.redirect('/admin/users?err=Invalid+user+id', 302);

  const form = await c.req.formData();
  const parsed = setRoleSchema.safeParse({ role: form.get('role') });
  if (!parsed.success) return c.redirect('/admin/users?err=Invalid+role', 302);

  await setUserRoles(c.env.DB, targetId, [parsed.data.role as RoleName], user.id);
  await writeAudit(c.env.DB, {
    userId: user.id,
    action: 'user.roles_changed',
    metadata: { targetUserId: targetId, role: parsed.data.role },
  });
  return c.redirect(`/admin/users?ok=${encodeURIComponent('Role updated.')}`, 302);
});

adminRoutes.post('/users/:id/deactivate', async (c) => {
  const user = c.get('user');
  const targetId = Number(c.req.param('id'));
  if (!Number.isFinite(targetId)) return c.redirect('/admin/users?err=Invalid+user+id', 302);
  if (targetId === user.id) {
    return c.redirect('/admin/users?err=You+cannot+deactivate+yourself', 302);
  }

  await deactivateUser(c.env.DB, targetId);
  await revokeAllForUser(c.env.DB, targetId);
  await writeAudit(c.env.DB, {
    userId: user.id,
    action: 'user.deactivated',
    metadata: { targetUserId: targetId },
  });
  return c.redirect(`/admin/users?ok=${encodeURIComponent('User deactivated and live sessions revoked.')}`, 302);
});

adminRoutes.post('/users/:id/reactivate', async (c) => {
  const user = c.get('user');
  const targetId = Number(c.req.param('id'));
  if (!Number.isFinite(targetId)) return c.redirect('/admin/users?err=Invalid+user+id', 302);

  await reactivateUser(c.env.DB, targetId);
  await writeAudit(c.env.DB, {
    userId: user.id,
    action: 'user.reactivated',
    metadata: { targetUserId: targetId },
  });
  return c.redirect(`/admin/users?ok=${encodeURIComponent('User reactivated.')}`, 302);
});
