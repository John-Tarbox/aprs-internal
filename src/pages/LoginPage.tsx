import type { FC } from 'hono/jsx';
import { Layout } from './Layout';

interface LoginPageProps {
  next?: string;
  error?: string;
  googleEnabled?: boolean;
}

export const LoginPage: FC<LoginPageProps> = ({ next, error, googleEnabled }) => {
  const qs = next ? `?next=${encodeURIComponent(next)}` : '';
  return (
    <Layout title="Sign in">
      <div class="card" style="max-width: 420px; margin: 48px auto;">
        <h1>Sign in</h1>
        <p class="muted">This is the APRS Foundation internal site. Choose how you want to sign in.</p>

        {error ? <div class="flash flash-err">{error}</div> : null}

        <div style="display: flex; flex-direction: column; gap: 12px; margin-top: 20px;">
          <a class="btn btn-primary" href={`/auth/okta/login${qs}`}>Sign in with Okta</a>
          {googleEnabled ? (
            <a class="btn" href={`/auth/google/login${qs}`}>Sign in with Google</a>
          ) : null}
        </div>

        <p class="muted" style="margin-top: 24px;">
          {googleEnabled
            ? 'Staff: use Okta. External collaborators: use the Google account the admin added to your invitation.'
            : 'Google sign-in for external collaborators is not yet configured. Staff: use Okta.'}
        </p>
      </div>
    </Layout>
  );
};
