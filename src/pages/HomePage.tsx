import type { FC } from 'hono/jsx';
import { raw } from 'hono/html';
import { Layout } from './Layout';
import { COLUMNS } from './KanbanPage';
import type { AuthUser } from '../env';
import type { ColumnName } from '../services/kanban.service';

interface HomePageProps {
  user: AuthUser;
  kanbanCounts: Record<ColumnName, number>;
}

const ROADMAP: Array<{ title: string; desc: string }> = [
  { title: 'Internal docs & runbooks', desc: 'Playbooks, on-call notes, operating procedures.' },
  { title: 'Staff & member directory', desc: 'Who does what, how to reach them.' },
  { title: 'Operational dashboards', desc: 'Live metrics for the services we run.' },
  { title: 'Internal tools & forms', desc: 'Small utilities the team uses day-to-day.' },
];

const firstName = (u: AuthUser): string => {
  if (u.displayName) return u.displayName.split(/\s+/)[0] || u.displayName;
  const localPart = u.email.split('@')[0] || u.email;
  return localPart.charAt(0).toUpperCase() + localPart.slice(1);
};

const kanbanTotal = (counts: Record<ColumnName, number>): number =>
  Object.values(counts).reduce((a, b) => a + b, 0);

export const HomePage: FC<HomePageProps> = ({ user, kanbanCounts }) => {
  const name = firstName(user);
  const total = kanbanTotal(kanbanCounts);
  const isAdmin = user.roles.includes('admin');

  return (
    <Layout title="Home" user={user}>
      <style>{homeCss}</style>

      <section class="home-hero">
        <h1 class="home-hero-title">
          <span data-home-greet>Hello</span>, <span>{name}</span>.
        </h1>
        <p class="home-hero-sub">
          <span>APRS Foundation · internal site</span>
          {user.roles.length > 0 ? (
            <span class="home-roles">
              {user.roles.map((r) => (
                <span class={`home-role home-role-${r}`}>{r}</span>
              ))}
            </span>
          ) : null}
        </p>
      </section>

      <h2 class="home-eyebrow">Available now</h2>
      <div class="home-grid">
        <a class="home-tile home-tile-live" href="/kanban">
          <div class="home-tile-head">
            <span class="home-tile-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round">
                <rect x="3" y="4" width="5" height="16" rx="1" />
                <rect x="10" y="4" width="5" height="10" rx="1" />
                <rect x="17" y="4" width="4" height="14" rx="1" />
              </svg>
            </span>
            <span class="home-tile-title">Kanban board</span>
            <span class="home-tile-pill home-tile-pill-live">Live</span>
          </div>
          <p class="home-tile-desc">
            Shared real-time task board for the team. Drag cards between lanes; changes sync to everyone in sub-second.
          </p>
          <div class="home-stats">
            {COLUMNS.map((col) => (
              <span class="home-stat" title={col.label}>
                <span class="home-stat-label">{col.label}</span>
                <span class="home-stat-value">{kanbanCounts[col.key]}</span>
              </span>
            ))}
          </div>
          <div class="home-tile-foot">
            <span class="muted">{total} {total === 1 ? 'task' : 'tasks'} total</span>
            <span class="home-tile-cta" aria-hidden="true">Open →</span>
          </div>
        </a>

        {isAdmin ? (
          <a class="home-tile home-tile-live" href="/admin/users">
            <div class="home-tile-head">
              <span class="home-tile-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round">
                  <circle cx="12" cy="12" r="3" />
                  <path d="M12 2v3M12 19v3M4.93 4.93l2.12 2.12M16.95 16.95l2.12 2.12M2 12h3M19 12h3M4.93 19.07l2.12-2.12M16.95 7.05l2.12-2.12" />
                </svg>
              </span>
              <span class="home-tile-title">Admin · Users</span>
              <span class="home-tile-pill home-tile-pill-admin">Admin</span>
            </div>
            <p class="home-tile-desc">
              Manage members, roles, and access. Invite external Google users, rotate roles, or deactivate stale accounts.
            </p>
            <div class="home-tile-foot">
              <span class="muted">Role-gated</span>
              <span class="home-tile-cta" aria-hidden="true">Open →</span>
            </div>
          </a>
        ) : null}
      </div>

      <h2 class="home-eyebrow home-eyebrow-next">On the roadmap</h2>
      <div class="home-grid home-grid-roadmap">
        {ROADMAP.map((r) => (
          <div class="home-tile home-tile-soon" aria-disabled="true">
            <div class="home-tile-head">
              <span class="home-tile-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="3 2">
                  <rect x="4" y="4" width="16" height="16" rx="2" />
                </svg>
              </span>
              <span class="home-tile-title">{r.title}</span>
              <span class="home-tile-pill home-tile-pill-soon">Soon</span>
            </div>
            <p class="home-tile-desc">{r.desc}</p>
          </div>
        ))}
      </div>

      <script>{raw(greetingJs)}</script>
    </Layout>
  );
};

const greetingJs = `
(function() {
  var el = document.querySelector('[data-home-greet]');
  if (!el) return;
  var h = new Date().getHours();
  el.textContent = h < 5 ? 'Hello' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
})();
`;

const homeCss = `
  .home-hero { margin: 8px 0 28px; }
  .home-hero-title { margin: 0 0 6px; font-size: 2rem; font-weight: 600; letter-spacing: -0.01em; }
  .home-hero-sub { margin: 0; display: flex; flex-wrap: wrap; gap: 10px 14px; align-items: center; font-size: 0.95em; opacity: 0.75; }
  .home-roles { display: inline-flex; gap: 6px; align-items: center; }
  .home-role {
    display: inline-block; padding: 2px 10px; border-radius: 999px;
    font-size: 0.72rem; font-weight: 600; letter-spacing: 0.02em; text-transform: uppercase;
    background: rgba(128,128,128,0.15); border: 1px solid rgba(128,128,128,0.3); color: inherit;
  }
  .home-role-admin {
    background: rgba(37,99,235,0.14); border-color: rgba(37,99,235,0.45); color: #2563eb;
  }

  .home-eyebrow {
    font-size: 0.72rem; font-weight: 600; letter-spacing: 0.12em; text-transform: uppercase;
    opacity: 0.55; margin: 28px 0 12px;
  }
  .home-eyebrow-next { margin-top: 36px; }

  .home-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
    gap: 14px;
  }
  .home-grid-roadmap { grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }

  .home-tile {
    display: flex; flex-direction: column; gap: 10px;
    padding: 18px;
    border: 1px solid rgba(128,128,128,0.28);
    border-radius: 10px;
    text-decoration: none; color: inherit;
    background: rgba(255,255,255,0.02);
    transition: transform 120ms ease, border-color 120ms ease, box-shadow 120ms ease;
  }
  @media (prefers-color-scheme: light) {
    .home-tile { background: #fff; }
  }
  .home-tile-live:hover {
    transform: translateY(-1px);
    border-color: rgba(37,99,235,0.55);
    box-shadow: 0 4px 14px rgba(37,99,235,0.12);
  }
  .home-tile-live:focus-visible {
    outline: 2px solid #2563eb;
    outline-offset: 2px;
  }
  .home-tile-soon {
    opacity: 0.55;
    cursor: default;
    border-style: dashed;
  }

  .home-tile-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .home-tile-icon { display: inline-flex; opacity: 0.85; }
  .home-tile-title { font-weight: 600; font-size: 1.05rem; }
  .home-tile-pill {
    margin-left: auto;
    padding: 2px 8px; border-radius: 999px;
    font-size: 0.7rem; font-weight: 600; letter-spacing: 0.02em;
    border: 1px solid rgba(128,128,128,0.35);
  }
  .home-tile-pill-live {
    background: rgba(34,197,94,0.15);
    border-color: rgba(34,197,94,0.45);
    color: #16a34a;
  }
  .home-tile-pill-admin {
    background: rgba(37,99,235,0.14);
    border-color: rgba(37,99,235,0.45);
    color: #2563eb;
  }
  .home-tile-pill-soon {
    background: transparent;
  }
  .home-tile-desc { margin: 0; opacity: 0.82; font-size: 0.95em; line-height: 1.45; }

  .home-stats {
    display: flex; flex-wrap: wrap; gap: 6px;
    margin-top: 2px;
  }
  .home-stat {
    display: inline-flex; align-items: baseline; gap: 6px;
    padding: 4px 10px;
    border-radius: 6px;
    background: rgba(128,128,128,0.1);
    border: 1px solid rgba(128,128,128,0.2);
    font-size: 0.85em;
  }
  .home-stat-label { opacity: 0.75; }
  .home-stat-value { font-variant-numeric: tabular-nums; font-weight: 600; }

  .home-tile-foot {
    margin-top: auto;
    display: flex; align-items: center; justify-content: space-between;
    padding-top: 4px;
  }
  .home-tile-cta { font-weight: 600; color: #2563eb; }
`;
