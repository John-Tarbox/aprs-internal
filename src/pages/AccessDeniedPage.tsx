import type { FC } from 'hono/jsx';
import { Layout } from './Layout';
import type { AuthUser } from '../env';

interface AccessDeniedPageProps {
  user?: AuthUser | null;
  /** If present, the Google email that attempted to sign in and wasn't on the allow-list. */
  attemptedEmail?: string;
  /** Free-text reason (role mismatch, deactivated, etc.). */
  reason?: string;
}

export const AccessDeniedPage: FC<AccessDeniedPageProps> = ({ user, attemptedEmail, reason }) => {
  return (
    <Layout title="Access denied" user={user ?? null}>
      <div class="card" style="max-width: 560px; margin: 48px auto;">
        <h1>Access denied</h1>

        {attemptedEmail ? (
          <>
            <p>
              The Google account <strong>{attemptedEmail}</strong> is not on the APRS internal site allow-list.
            </p>
            <p>
              If you should have access, ask an APRS admin to add <strong>{attemptedEmail}</strong> at{' '}
              <code>/admin/users</code>. Once added, come back here and click <em>Sign in with Google</em>.
            </p>
          </>
        ) : (
          <p>{reason || 'You do not have permission to view this page.'}</p>
        )}

        <p style="margin-top: 24px;">
          <a class="btn" href="/login">Back to sign in</a>
        </p>
      </div>
    </Layout>
  );
};
