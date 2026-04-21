import type { FC, PropsWithChildren } from 'hono/jsx';
import type { AuthUser } from '../env';

interface LayoutProps {
  title: string;
  user?: AuthUser | null;
}

export const Layout: FC<PropsWithChildren<LayoutProps>> = ({ title, user, children }) => {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex, nofollow" />
        <title>{title} — APRS Internal</title>
        <style>{css}</style>
      </head>
      <body>
        <header class="top">
          <a href="/" class="brand">APRS Internal</a>
          {user ? (
            <nav class="nav">
              <span class="who">
                {user.displayName || user.email} · {user.roles.join(', ') || 'no role'}
              </span>
              {user.roles.includes('admin') ? <a href="/admin/users">Users</a> : null}
              <form method="post" action="/auth/logout" class="inline">
                <button type="submit" class="link">Log out</button>
              </form>
            </nav>
          ) : null}
        </header>
        <main class="main">{children}</main>
        <footer class="foot">
          <small>Internal site · APRS Foundation · do not share externally</small>
        </footer>
      </body>
    </html>
  );
};

const css = `
  :root { color-scheme: light dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  body { margin: 0; }
  .top {
    display: flex; justify-content: space-between; align-items: center;
    padding: 12px 24px; border-bottom: 1px solid rgba(128,128,128,0.3);
  }
  .brand { font-weight: 600; text-decoration: none; color: inherit; }
  .nav { display: flex; gap: 16px; align-items: center; }
  .nav a { text-decoration: none; color: inherit; }
  .nav a:hover { text-decoration: underline; }
  .who { opacity: 0.7; font-size: 0.9em; }
  .main { max-width: 960px; margin: 32px auto; padding: 0 24px; }
  .foot { text-align: center; padding: 24px; opacity: 0.6; }
  .inline { display: inline; margin: 0; }
  .link { background: none; border: none; color: inherit; font: inherit; cursor: pointer; padding: 0; text-decoration: underline; }
  .btn {
    display: inline-block; padding: 10px 16px; border-radius: 6px;
    border: 1px solid rgba(128,128,128,0.4); background: transparent;
    color: inherit; text-decoration: none; cursor: pointer; font: inherit;
  }
  .btn-primary { background: #2563eb; color: white; border-color: #2563eb; }
  .btn:hover { opacity: 0.9; }
  .card { border: 1px solid rgba(128,128,128,0.25); border-radius: 8px; padding: 20px; margin: 16px 0; }
  table { border-collapse: collapse; width: 100%; margin: 16px 0; }
  th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid rgba(128,128,128,0.2); }
  th { font-size: 0.85em; opacity: 0.7; text-transform: uppercase; }
  input, select { font: inherit; padding: 8px; border: 1px solid rgba(128,128,128,0.4); border-radius: 4px; background: transparent; color: inherit; }
  label { display: block; margin: 12px 0 4px; font-size: 0.9em; }
  .flash { padding: 12px 16px; border-radius: 6px; margin: 16px 0; }
  .flash-ok  { background: rgba(34,197,94,0.15);  border: 1px solid rgba(34,197,94,0.4); }
  .flash-err { background: rgba(239,68,68,0.15); border: 1px solid rgba(239,68,68,0.4); }
  .muted { opacity: 0.6; font-size: 0.9em; }
`;
