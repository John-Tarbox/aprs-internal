import type { FC } from 'hono/jsx';
import { Layout } from './Layout';
import type { AuthUser } from '../env';

interface HomePageProps {
  user: AuthUser;
}

export const HomePage: FC<HomePageProps> = ({ user }) => {
  return (
    <Layout title="Home" user={user}>
      <h1>Welcome, {user.displayName || user.email}</h1>
      <p class="muted">
        You're signed in via {user.authType === 'okta' ? 'Okta' : 'Google'}
        {user.roles.length ? <> with role{user.roles.length > 1 ? 's' : ''} <strong>{user.roles.join(', ')}</strong></> : null}.
      </p>

      <div class="card">
        <h2>Sections</h2>
        <p class="muted">These are placeholders. The real content for each section will be built in follow-on work.</p>
        <ul>
          <li><span class="muted">Internal docs &amp; runbooks</span> — coming soon</li>
          <li><span class="muted">Staff &amp; member directory</span> — coming soon</li>
          <li><span class="muted">Operational dashboards</span> — coming soon</li>
          <li><span class="muted">Internal tools &amp; forms</span> — coming soon</li>
        </ul>
        {user.roles.includes('admin') ? (
          <p><a class="btn" href="/admin/users">Manage users</a></p>
        ) : null}
      </div>
    </Layout>
  );
};
