import type { FC, PropsWithChildren } from 'hono/jsx';
import { raw } from 'hono/html';
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
              <a href="/my">My Cards</a>
              <a href="/kanban">Boards</a>
              <a href="/table">Table</a>
              <a href="/calendar">Calendar</a>
              <a href="/timeline">Timeline</a>
              <a href="/dashboard">Dashboard</a>
              <span class="who">
                {user.displayName || user.email} · {user.roles.join(', ') || 'no role'}
              </span>
              {/* Notification bell — only meaningful for authed users. The
                  client script lazy-polls for unread count and renders a
                  dropdown on click. */}
              <div id="notif-root" class="notif-root">
                <button id="notif-bell" type="button" class="notif-bell" aria-label="Notifications" aria-expanded="false">
                  <span class="notif-icon" aria-hidden="true">🔔</span>
                  <span id="notif-count" class="notif-count" hidden>0</span>
                </button>
                <div id="notif-panel" class="notif-panel" hidden>
                  <div class="notif-panel-head">
                    <strong>Notifications</strong>
                    <button type="button" id="notif-mark-all" class="notif-mark-all">Mark all read</button>
                  </div>
                  <ol id="notif-list" class="notif-list" aria-live="polite"></ol>
                  <p id="notif-empty" class="notif-empty" hidden>You're all caught up.</p>
                </div>
              </div>
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
        {user ? <script>{raw(notifClientJs)}</script> : null}
      </body>
    </html>
  );
};

const css = `
  :root {
    color-scheme: light dark;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    /* Brand + accent — single blue used for primary actions, today
       markers, focus rings, "live" indicators, and chart strokes. */
    --brand: #2563eb;
    --brand-tint-strong: rgba(37, 99, 235, 0.45);
    --brand-tint-weak: rgba(37, 99, 235, 0.14);
    /* Status palette — solid for borders/text, _bg variants for
       low-alpha fills behind status text. */
    --status-ok:    #22c55e;  --status-ok-text:    #16a34a;
    --status-err:   #dc2626;  --status-err-text:   #b91c1c;
    --status-warn:  #eab308;
    --status-info:  #38bdf8;
    --status-ok-bg:    rgba(34, 197, 94, 0.15);
    --status-err-bg:   rgba(239, 68, 68, 0.15);
    --status-warn-bg:  rgba(234, 179, 8, 0.15);
    --status-info-bg:  rgba(56, 189, 248, 0.18);
    /* Accent — accent-color cascades to native checkboxes, radios,
       range sliders, and progress bars. One declaration recolors the
       whole site's form chrome. */
    accent-color: #2563eb;
  }
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
  .btn-primary { background: var(--brand); color: white; border-color: var(--brand); }
  .btn:hover { opacity: 0.9; }
  .card { border: 1px solid rgba(128,128,128,0.25); border-radius: 8px; padding: 20px; margin: 16px 0; }
  table { border-collapse: collapse; width: 100%; margin: 16px 0; }
  th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid rgba(128,128,128,0.2); }
  th { font-size: 0.85em; opacity: 0.7; text-transform: uppercase; }
  input, select { font: inherit; padding: 8px; border: 1px solid rgba(128,128,128,0.4); border-radius: 4px; background: transparent; color: inherit; }
  label { display: block; margin: 12px 0 4px; font-size: 0.9em; }
  .flash { padding: 12px 16px; border-radius: 6px; margin: 16px 0; }
  .flash-ok  { background: var(--status-ok-bg);  border: 1px solid rgba(34,197,94,0.4); }
  .flash-err { background: var(--status-err-bg); border: 1px solid rgba(239,68,68,0.4); }
  .muted { opacity: 0.6; font-size: 0.9em; }

  /* Notification bell + dropdown. */
  .notif-root { position: relative; display: inline-flex; align-items: center; }
  .notif-bell {
    position: relative; background: none; border: none; cursor: pointer;
    color: inherit; font: inherit; padding: 4px; line-height: 1;
  }
  .notif-icon { font-size: 1.2em; }
  .notif-count {
    position: absolute; top: -2px; right: -4px;
    background: var(--status-err); color: #fff; font-size: 0.7em;
    min-width: 16px; height: 16px; border-radius: 999px;
    display: inline-flex; align-items: center; justify-content: center; padding: 0 4px;
  }
  .notif-count[hidden] { display: none; }
  .notif-panel {
    position: absolute; top: calc(100% + 6px); right: 0;
    width: 320px; max-height: 400px; overflow-y: auto;
    background: #fff; color: #111;
    border: 1px solid rgba(128,128,128,0.3); border-radius: 8px;
    box-shadow: 0 8px 24px rgba(0,0,0,0.15);
    z-index: 1200;
  }
  @media (prefers-color-scheme: dark) {
    .notif-panel { background: #1a1a1a; color: #eee; }
  }
  .notif-panel[hidden] { display: none; }
  .notif-panel-head {
    display: flex; justify-content: space-between; align-items: center;
    padding: 10px 12px; border-bottom: 1px solid rgba(128,128,128,0.2);
  }
  .notif-mark-all {
    background: none; border: none; cursor: pointer; color: inherit; font: inherit;
    font-size: 0.85em; opacity: 0.7; text-decoration: underline;
  }
  .notif-mark-all:hover { opacity: 1; }
  .notif-list { list-style: none; margin: 0; padding: 0; }
  .notif-item {
    display: block; padding: 10px 12px;
    border-bottom: 1px solid rgba(128,128,128,0.15);
    color: inherit; text-decoration: none; cursor: pointer;
    font-size: 0.9em;
  }
  .notif-item:hover { background: rgba(128,128,128,0.08); }
  .notif-item-unread { background: rgba(37,99,235,0.06); }
  .notif-item-meta { font-size: 0.8em; opacity: 0.6; margin-top: 2px; }
  .notif-empty { padding: 20px; text-align: center; opacity: 0.6; font-style: italic; }
`;

// Small inline client. Polls the unread count on a slow interval and
// fetches the dropdown items on demand. Renders entirely via DOM APIs —
// notification text is server-supplied (display names, card titles) but
// we still pipe everything through textContent to avoid surprises.
const notifClientJs = `
(function() {
  'use strict';
  var bell = document.getElementById('notif-bell');
  var panel = document.getElementById('notif-panel');
  var countEl = document.getElementById('notif-count');
  var listEl = document.getElementById('notif-list');
  var emptyEl = document.getElementById('notif-empty');
  var markAllBtn = document.getElementById('notif-mark-all');
  if (!bell || !panel || !countEl || !listEl) return;

  var POLL_INTERVAL_MS = 60_000; // every minute is plenty for v1

  function setCount(n) {
    if (typeof n !== 'number' || n <= 0) {
      countEl.hidden = true;
      countEl.textContent = '';
    } else {
      countEl.hidden = false;
      countEl.textContent = n > 99 ? '99+' : String(n);
    }
  }

  function fetchUnreadCount() {
    return fetch('/api/notifications/unread-count', { credentials: 'same-origin' })
      .then(function(r) { return r.ok ? r.json() : { count: 0 }; })
      .then(function(j) { setCount(j.count || 0); })
      .catch(function() { /* silent — header bell isn't critical */ });
  }

  function renderItems(items) {
    while (listEl.firstChild) listEl.removeChild(listEl.firstChild);
    if (!items || items.length === 0) {
      emptyEl.hidden = false;
      return;
    }
    emptyEl.hidden = true;
    items.forEach(function(n) { listEl.appendChild(renderItemNode(n)); });
  }

  function relativeTime(iso) {
    if (!iso) return '';
    var s = String(iso);
    if (s.indexOf('T') < 0 && s.indexOf(' ') > 0) s = s.replace(' ', 'T') + 'Z';
    var then = new Date(s).getTime();
    if (isNaN(then)) return iso;
    var secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
    if (secs < 60) return secs + 's ago';
    var mins = Math.floor(secs / 60);
    if (mins < 60) return mins + 'm ago';
    var hours = Math.floor(mins / 60);
    if (hours < 24) return hours + 'h ago';
    var days = Math.floor(hours / 24);
    return days + 'd ago';
  }

  function describe(n) {
    var actor = n.actorDisplayName || 'Someone';
    var title = (n.metadata && n.metadata.cardTitle) || 'a card';
    if (n.kind === 'mention.comment') return actor + ' mentioned you on ' + title;
    if (n.kind === 'card.assigned')   return actor + ' assigned you to ' + title;
    return n.kind;
  }

  function renderItemNode(n) {
    var li = document.createElement('li');
    var a = document.createElement('a');
    a.className = 'notif-item' + (n.readAt ? '' : ' notif-item-unread');
    a.href = n.cardId ? ('/kanban/c/' + n.cardId + '?notif=' + n.id) : '#';
    a.textContent = describe(n);
    var meta = document.createElement('div');
    meta.className = 'notif-item-meta';
    meta.textContent = relativeTime(n.createdAt);
    a.appendChild(meta);
    a.addEventListener('click', function() {
      // Mark this single notification read on click; navigation continues
      // via the link's normal behavior.
      if (!n.readAt) {
        fetch('/api/notifications/read', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ ids: [n.id] }),
        }).catch(function() {});
      }
    });
    li.appendChild(a);
    return li;
  }

  function openPanel() {
    panel.hidden = false;
    bell.setAttribute('aria-expanded', 'true');
    fetch('/api/notifications?limit=20', { credentials: 'same-origin' })
      .then(function(r) { return r.ok ? r.json() : { items: [] }; })
      .then(function(j) { renderItems(j.items || []); });
  }

  function closePanel() {
    panel.hidden = true;
    bell.setAttribute('aria-expanded', 'false');
  }

  bell.addEventListener('click', function(e) {
    e.stopPropagation();
    if (panel.hidden) openPanel(); else closePanel();
  });

  document.addEventListener('click', function(e) {
    if (panel.hidden) return;
    if (!panel.contains(e.target) && !bell.contains(e.target)) closePanel();
  });

  if (markAllBtn) {
    markAllBtn.addEventListener('click', function() {
      fetch('/api/notifications/read-all', {
        method: 'POST',
        credentials: 'same-origin',
      })
        .then(function() { setCount(0); openPanel(); })
        .catch(function() {});
    });
  }

  fetchUnreadCount();
  setInterval(fetchUnreadCount, POLL_INTERVAL_MS);
})();
`;
