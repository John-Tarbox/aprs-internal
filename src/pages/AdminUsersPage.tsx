import type { FC } from 'hono/jsx';
import { Layout } from './Layout';
import type { AuthUser, RoleName } from '../env';
import type { UserWithRoles } from '../services/users.service';

interface AdminUsersPageProps {
  user: AuthUser;
  users: UserWithRoles[];
  flash?: { kind: 'ok' | 'err'; message: string };
}

const ALL_ROLES: RoleName[] = ['admin', 'staff', 'viewer'];

export const AdminUsersPage: FC<AdminUsersPageProps> = ({ user, users, flash }) => {
  return (
    <Layout title="Users" user={user}>
      <h1>Users</h1>
      <p class="muted">
        Okta users are auto-created on first sign-in with the <code>viewer</code> role. Add Google users here
        to put them on the allow-list.
      </p>
      <p>
        <a class="btn" href="/admin/export.zip" title="Download a ZIP of every board's data as JSON">
          ↓ Data export (ZIP)
        </a>
      </p>

      {flash ? <div class={`flash flash-${flash.kind}`}>{flash.message}</div> : null}

      <div class="card">
        <h2>Add external (Google) user</h2>
        <form method="post" action="/admin/users" style="display: flex; gap: 12px; align-items: end; flex-wrap: wrap;">
          <div>
            <label for="email">Google email</label>
            <input id="email" name="email" type="email" required placeholder="jane@example.com" style="min-width: 260px;" />
          </div>
          <div>
            <label for="displayName">Display name (optional)</label>
            <input id="displayName" name="displayName" type="text" placeholder="Jane Doe" />
          </div>
          <div>
            <label for="role">Role</label>
            <select id="role" name="role" required>
              {ALL_ROLES.map((r) => (
                <option value={r} selected={r === 'viewer'}>{r}</option>
              ))}
            </select>
          </div>
          <div>
            <button class="btn btn-primary" type="submit">Add user</button>
          </div>
        </form>
      </div>

      <h2>All users</h2>
      <table>
        <thead>
          <tr>
            <th>Email</th>
            <th>Provider</th>
            <th>Roles</th>
            <th>Active</th>
            <th>Last login</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr style={u.active ? undefined : 'opacity: 0.5;'}>
              <td>
                {u.email}
                {u.displayName ? <div class="muted">{u.displayName}</div> : null}
              </td>
              <td>{u.authType}</td>
              <td>{u.roles.join(', ') || <span class="muted">none</span>}</td>
              <td>{u.active ? 'yes' : 'no'}</td>
              <td class="muted">{u.lastLoginAt ?? 'never'}</td>
              <td>
                <form method="post" action={`/admin/users/${u.id}/roles`} style="display: inline-flex; gap: 4px;">
                  <select name="role">
                    {ALL_ROLES.map((r) => (
                      <option value={r} selected={u.roles.includes(r)}>{r}</option>
                    ))}
                  </select>
                  <button class="btn" type="submit">Set role</button>
                </form>
                {' '}
                {u.active ? (
                  u.id === user.id ? (
                    <span class="muted">(you)</span>
                  ) : (
                    <form method="post" action={`/admin/users/${u.id}/deactivate`} class="inline">
                      <button class="btn" type="submit">Deactivate</button>
                    </form>
                  )
                ) : (
                  <form method="post" action={`/admin/users/${u.id}/reactivate`} class="inline">
                    <button class="btn" type="submit">Reactivate</button>
                  </form>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Layout>
  );
};
