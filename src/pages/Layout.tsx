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
              <button id="kbd-help-btn" type="button" class="link kbd-help-btn"
                      title="Keyboard shortcuts (press ?)" aria-label="Keyboard shortcuts">?</button>
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
        {user ? (
          <div id="kbd-help-overlay" class="kbd-overlay" hidden role="dialog" aria-label="Keyboard shortcuts">
            <div class="kbd-overlay-inner">
              <header class="kbd-overlay-head">
                <h2>Keyboard shortcuts</h2>
                <button type="button" id="kbd-help-close" class="link" aria-label="Close shortcuts">×</button>
              </header>
              <div class="kbd-overlay-body">
                <section>
                  <h3>Anywhere</h3>
                  <ul>
                    <li><kbd>?</kbd> Show this overlay</li>
                    <li><kbd>Esc</kbd> Close overlay or modal · blur the focused field</li>
                    <li><kbd>g</kbd> then <kbd>h</kbd> Home</li>
                    <li><kbd>g</kbd> then <kbd>m</kbd> My Cards</li>
                    <li><kbd>g</kbd> then <kbd>b</kbd> Boards</li>
                    <li><kbd>g</kbd> then <kbd>t</kbd> Table</li>
                    <li><kbd>g</kbd> then <kbd>c</kbd> Calendar</li>
                    <li><kbd>g</kbd> then <kbd>l</kbd> Timeline</li>
                    <li><kbd>g</kbd> then <kbd>d</kbd> Dashboard</li>
                  </ul>
                </section>
                <section>
                  <h3>On a board</h3>
                  <ul>
                    <li><kbd>/</kbd> Focus the search/filter box</li>
                    <li><kbd>n</kbd> New card in the leftmost column</li>
                  </ul>
                </section>
                <section>
                  <h3>Search operators</h3>
                  <ul class="kbd-ops">
                    <li><code>assigned:lion</code> · <code>label:urgent</code></li>
                    <li><code>column:done</code> · <code>has:due</code> · <code>has:cover</code></li>
                    <li><code>is:overdue</code> · <code>is:mine</code> · <code>is:archived</code></li>
                  </ul>
                </section>
              </div>
            </div>
          </div>
        ) : null}
        {user ? <script>{raw(notifClientJs)}</script> : null}
        {user ? <script>{raw(kbdClientJs)}</script> : null}
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

  /* Keyboard-shortcut help overlay (P2). */
  .kbd-help-btn {
    margin-left: 4px; padding: 0 8px; font-weight: 600;
    border: 1px solid rgba(128,128,128,0.4); border-radius: 999px;
    text-decoration: none; opacity: 0.6; line-height: 1.4;
  }
  .kbd-help-btn:hover { opacity: 1; }
  .kbd-overlay {
    position: fixed; inset: 0; background: rgba(0,0,0,0.5);
    display: flex; align-items: center; justify-content: center;
    z-index: 1300; padding: 16px;
  }
  .kbd-overlay[hidden] { display: none; }
  .kbd-overlay-inner {
    background: #fff; color: #111; border-radius: 8px; padding: 20px;
    width: 100%; max-width: 560px; max-height: 90vh; overflow-y: auto;
  }
  @media (prefers-color-scheme: dark) {
    .kbd-overlay-inner { background: #1a1a1a; color: #eee; }
  }
  .kbd-overlay-head {
    display: flex; justify-content: space-between; align-items: baseline;
    margin-bottom: 8px;
  }
  .kbd-overlay-head h2 { margin: 0; font-size: 1.1em; }
  .kbd-overlay-body section { margin-top: 14px; }
  .kbd-overlay-body h3 {
    margin: 0 0 6px 0; font-size: 0.78em; text-transform: uppercase;
    letter-spacing: 0.06em; opacity: 0.65; font-weight: 600;
  }
  .kbd-overlay-body ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; font-size: 0.92em; }
  .kbd-overlay-body kbd {
    display: inline-block; min-width: 18px; padding: 1px 6px; margin-right: 4px;
    border: 1px solid rgba(128,128,128,0.45); border-radius: 4px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.85em; line-height: 1.2; text-align: center;
    background: rgba(128,128,128,0.08);
  }
  .kbd-overlay-body code {
    background: rgba(128,128,128,0.15); padding: 1px 5px; border-radius: 3px;
    font-size: 0.9em;
  }
  .kbd-ops li { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.85em; }
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

// Keyboard shortcuts (P2). Lives in Layout so it works on every authed
// page. Chord-style g <letter> for navigation (matches GitHub/Linear);
// single-key shortcuts (?, /, n, Esc) work everywhere except inside an
// editable element.
const kbdClientJs = `
(function() {
  'use strict';
  var overlay = document.getElementById('kbd-help-overlay');
  var helpBtn = document.getElementById('kbd-help-btn');
  var helpClose = document.getElementById('kbd-help-close');
  if (!overlay) return;

  function showHelp() { overlay.hidden = false; }
  function hideHelp() { overlay.hidden = true; }

  helpBtn && helpBtn.addEventListener('click', showHelp);
  helpClose && helpClose.addEventListener('click', hideHelp);
  overlay.addEventListener('click', function(e) { if (e.target === overlay) hideHelp(); });

  function isTypingTarget(el) {
    if (!el) return false;
    var tag = (el.tagName || '').toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (el.isContentEditable) return true;
    return false;
  }

  // Chord-state for "g <letter>" navigation. 700ms window after pressing g.
  var chordPending = false;
  var chordTimer = null;
  function startChord() {
    chordPending = true;
    if (chordTimer) clearTimeout(chordTimer);
    chordTimer = setTimeout(function() { chordPending = false; }, 700);
  }
  var chordTargets = {
    h: '/',
    m: '/my',
    b: '/kanban',
    t: '/table',
    c: '/calendar',
    l: '/timeline',
    d: '/dashboard',
  };

  document.addEventListener('keydown', function(e) {
    // Inside editable fields, only Esc to blur is honoured.
    if (isTypingTarget(e.target)) {
      if (e.key === 'Escape') {
        try { e.target.blur(); } catch (_err) {}
      }
      return;
    }

    // Resolve a pending g-chord if it's the next keystroke.
    if (chordPending) {
      chordPending = false;
      if (chordTimer) { clearTimeout(chordTimer); chordTimer = null; }
      var dest = chordTargets[e.key];
      if (dest) {
        e.preventDefault();
        location.assign(dest);
      }
      return;
    }

    // Esc closes the overlay if open.
    if (e.key === 'Escape' && !overlay.hidden) {
      e.preventDefault();
      hideHelp();
      return;
    }

    // ? opens the overlay. On most layouts ? is Shift+/, so e.key is '?'
    // only when shift is held — accept either form.
    if (e.key === '?' || (e.key === '/' && e.shiftKey)) {
      e.preventDefault();
      showHelp();
      return;
    }

    // / focuses the kanban filter box if present on this page.
    if (e.key === '/' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      var search = document.getElementById('kf-search');
      if (search) {
        e.preventDefault();
        search.focus();
        try { search.select(); } catch (_err) {}
        return;
      }
    }

    // n triggers the leftmost column's "+" button (new card in column 1).
    if (e.key === 'n' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      var addBtn = document.querySelector('.kanban-add');
      if (addBtn) {
        e.preventDefault();
        addBtn.click();
        return;
      }
    }

    // g starts a chord.
    if (e.key === 'g' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      startChord();
      return;
    }
  });
})();
`;
