/**
 * Kanban board page. Ships as a server-rendered skeleton (columns, modals,
 * CSS) plus an inline client script that opens a WebSocket to the singleton
 * KanbanBoardDO, renders the snapshot, and handles create/edit/move/delete.
 *
 * XSS SAFETY: every card field is attacker-controlled (any authenticated
 * user can type anything into a card), so the client script uses
 * `textContent` / `createTextNode` exclusively when rendering card data.
 * Never concatenate card fields into an HTML string or assign to
 * `innerHTML`. The only `raw()` injection is this module's own static
 * script string, which never contains user input.
 */

import type { FC } from 'hono/jsx';
import { raw } from 'hono/html';
import { Layout } from './Layout';
import type { AuthUser } from '../env';
import type { BoardDto, ColumnName } from '../services/kanban.service';

interface KanbanPageProps {
  user: AuthUser;
  board: BoardDto;
  knownGroups: string[];
}

export const COLUMNS: Array<{ key: ColumnName; label: string }> = [
  { key: 'not_started', label: 'Not Started' },
  { key: 'started', label: 'Started' },
  { key: 'blocked', label: 'Blocked' },
  { key: 'ready', label: 'Ready' },
  { key: 'approval', label: 'Approval' },
  { key: 'done', label: 'Done' },
];

export const KanbanPage: FC<KanbanPageProps> = ({ user, board, knownGroups }) => {
  return (
    <Layout title={`Kanban · ${board.name}`} user={user}>
      <style>{kanbanCss}</style>
      <div class="kanban-head">
        <a class="kanban-back" href="/kanban" aria-label="Back to board list">← All boards</a>
        <h1>{board.name}</h1>
        <span id="kanban-status" class="kanban-status kanban-status-pending">Connecting…</span>
        <button id="kanban-archive-toggle" class="btn kanban-archive-toggle" type="button" aria-expanded="false">
          Show archived
        </button>
      </div>

      <div class="kanban-board" id="kanban-board" data-board-slug={board.slug}>
        {COLUMNS.map((col) => (
          <section class="kanban-col" data-col={col.key}>
            <header class="kanban-col-head">
              <span class="kanban-col-title">{col.label}</span>
              <button class="kanban-add" data-add-col={col.key} type="button" aria-label={`Add card to ${col.label}`}>+</button>
            </header>
            <div class="kanban-col-body" data-col-body={col.key}></div>
          </section>
        ))}
      </div>

      <section id="kanban-archive" class="kanban-archive" hidden aria-label="Archived cards">
        <header class="kanban-archive-head">
          <h2>Archived cards</h2>
          <span id="kanban-archive-count" class="kanban-archive-count"></span>
        </header>
        <div id="kanban-archive-body" class="kanban-archive-body"></div>
        <p id="kanban-archive-empty" class="kanban-archive-empty" hidden>No archived cards on this board.</p>
      </section>

      <div id="kanban-modal" class="kanban-modal" hidden>
        <div class="kanban-modal-inner">
          <h2 id="kanban-modal-title">New card</h2>
          <form id="kanban-form">
            <label>Task Name
              <input type="text" id="kf-title" required maxlength={200} />
            </label>
            <div class="kf-groups-field">
              <span class="kf-groups-label">Groups</span>
              <div id="kf-groups-chips" class="kf-groups-chips" aria-live="polite"></div>
              <div class="kf-groups-entry">
                <input type="text" id="kf-groups-input" list="kf-groups-suggest" maxlength={100}
                       placeholder="Type or pick a group and press Enter"
                       aria-label="Add a group" />
                <datalist id="kf-groups-suggest"></datalist>
                <button type="button" id="kf-groups-add" class="btn">Add</button>
              </div>
            </div>
            <label>Assigned
              <input type="text" id="kf-assigned" maxlength={100} />
            </label>
            <label>Due Date
              <input type="date" id="kf-due" />
            </label>
            <label>Notes
              <textarea id="kf-notes" rows={4} maxlength={10000}></textarea>
              <span class="kf-notes-hint">Markdown supported: **bold**, *italic*, `code`, [link](https://…), bullet/numbered lists, # headings.</span>
            </label>
            <section id="kf-activity" class="kf-activity" hidden aria-label="Activity timeline">
              <h3 class="kf-activity-title">Activity</h3>
              <ol id="kf-activity-list" class="kf-activity-list"></ol>
              <p id="kf-activity-empty" class="kf-activity-empty" hidden>No activity yet.</p>
            </section>
            <p id="kf-error" class="kanban-error" hidden></p>
            <div class="kanban-modal-actions">
              <button type="button" id="kf-cancel" class="btn">Cancel</button>
              <button type="button" id="kf-archive" class="btn kanban-btn-danger" hidden>Archive</button>
              <button type="button" id="kf-restore" class="btn" hidden>Restore</button>
              <button type="submit" id="kf-save" class="btn btn-primary">Save</button>
            </div>
          </form>
        </div>
      </div>

      <div id="kanban-toast" class="kanban-toast" hidden></div>

      {/* JSON data island — server-rendered list of known group names for
          autocomplete. Safe: JSON.stringify escapes everything, and the
          client parses via textContent (not eval) when the type is JSON. */}
      <script type="application/json" id="kanban-known-groups">
        {JSON.stringify(knownGroups)}
      </script>

      {/* SortableJS is pinned to a specific version. For stricter security posture,
           compute and add an SRI `integrity` hash, or vendor the file into the Worker
           and serve it from the same origin. */}
      <script src="https://cdn.jsdelivr.net/npm/sortablejs@1.15.6/Sortable.min.js" crossorigin="anonymous"></script>
      <script>{raw(kanbanClientJs)}</script>
    </Layout>
  );
};

const kanbanCss = `
  /* Break out of Layout's .main max-width: 960px; 6 columns need ~1200px. */
  body:has(.kanban-board) .main { max-width: none; padding: 0 16px; }

  .kanban-head { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
  .kanban-head h1 { margin: 0; }
  .kanban-back { text-decoration: none; color: inherit; opacity: 0.7; font-size: 0.9em; }
  .kanban-back:hover { opacity: 1; text-decoration: underline; }
  .kanban-status { font-size: 0.85em; padding: 4px 10px; border-radius: 999px; }
  .kanban-status-ok { background: rgba(34,197,94,0.15); color: inherit; border: 1px solid rgba(34,197,94,0.4); }
  .kanban-status-pending { background: rgba(234,179,8,0.15); border: 1px solid rgba(234,179,8,0.4); }
  .kanban-status-err { background: rgba(239,68,68,0.15); border: 1px solid rgba(239,68,68,0.4); }

  .kanban-board {
    display: grid;
    grid-template-columns: repeat(6, minmax(200px, 1fr));
    gap: 12px;
    margin-top: 24px;
    overflow-x: auto;
  }
  .kanban-col {
    background: rgba(128,128,128,0.06);
    border: 1px solid rgba(128,128,128,0.2);
    border-radius: 8px;
    padding: 8px;
    min-height: 200px;
    display: flex;
    flex-direction: column;
  }
  .kanban-col-head {
    display: flex; align-items: center; justify-content: space-between;
    padding: 4px 6px 8px; border-bottom: 1px solid rgba(128,128,128,0.2);
    margin-bottom: 8px;
  }
  .kanban-col-title { font-weight: 600; font-size: 0.95em; }
  .kanban-add {
    background: transparent; border: 1px solid rgba(128,128,128,0.4);
    border-radius: 4px; width: 24px; height: 24px; cursor: pointer; color: inherit; font: inherit;
  }
  .kanban-add:hover { background: rgba(128,128,128,0.15); }
  .kanban-col-body { flex: 1; min-height: 40px; }

  .kanban-card {
    background: var(--kanban-card-bg, rgba(255,255,255,0.03));
    border: 1px solid rgba(128,128,128,0.3);
    border-radius: 6px;
    padding: 8px 10px;
    margin-bottom: 8px;
    cursor: pointer;
    font-size: 0.9em;
  }
  @media (prefers-color-scheme: light) {
    .kanban-card { background: #fff; }
  }
  .kanban-card:hover { border-color: rgba(128,128,128,0.6); }
  .kanban-card-title { font-weight: 600; margin-bottom: 4px; word-break: break-word; }
  .kanban-card-meta { display: flex; flex-wrap: wrap; gap: 4px 8px; font-size: 0.8em; opacity: 0.8; }
  .kanban-chip { background: rgba(128,128,128,0.15); padding: 1px 6px; border-radius: 999px; }
  .kanban-card-notes { margin-top: 4px; font-size: 0.85em; opacity: 0.75;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  /* Markdown-rendered content inside notes preview. Aggressive resets so the
     rendered blocks stay compact inside the 2-line clamp. */
  .kanban-card-notes p,
  .kanban-card-notes ul,
  .kanban-card-notes ol { margin: 0; padding: 0; }
  .kanban-card-notes ul,
  .kanban-card-notes ol { padding-left: 1.1em; }
  .kanban-card-notes h1,
  .kanban-card-notes h2,
  .kanban-card-notes h3,
  .kanban-card-notes h4,
  .kanban-card-notes h5,
  .kanban-card-notes h6 { margin: 0; font-size: 1em; font-weight: 700; }
  .kanban-card-notes code {
    background: rgba(128,128,128,0.15); padding: 0 3px; border-radius: 3px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 0.95em;
  }
  .kanban-card-notes a { color: inherit; text-decoration: underline; }
  .kf-notes-hint {
    display: block; font-size: 0.75em; opacity: 0.6; margin-top: 2px;
  }

  /* Activity timeline in the card modal. */
  .kf-activity { margin-top: 16px; border-top: 1px solid rgba(128,128,128,0.25); padding-top: 12px; }
  .kf-activity[hidden] { display: none; }
  .kf-activity-title { margin: 0 0 8px 0; font-size: 0.95em; font-weight: 600; }
  .kf-activity-list {
    list-style: none; margin: 0; padding: 0;
    display: flex; flex-direction: column; gap: 6px;
    max-height: 200px; overflow-y: auto;
  }
  .kf-activity-item {
    font-size: 0.85em; line-height: 1.35;
    display: grid; grid-template-columns: 1fr auto; gap: 4px 12px;
  }
  .kf-activity-actor { font-weight: 600; }
  .kf-activity-desc { opacity: 0.85; }
  .kf-activity-time { opacity: 0.6; font-size: 0.85em; white-space: nowrap; grid-column: 2; grid-row: 1 / span 2; align-self: start; }
  .kf-activity-empty { font-size: 0.85em; opacity: 0.6; font-style: italic; margin: 4px 0 0; }
  .sortable-ghost { opacity: 0.4; }
  .sortable-drag { box-shadow: 0 4px 12px rgba(0,0,0,0.25); }

  .kanban-modal {
    position: fixed; inset: 0; background: rgba(0,0,0,0.5);
    display: flex; align-items: center; justify-content: center; z-index: 1000; padding: 16px;
  }
  .kanban-modal[hidden] { display: none; }
  .kanban-modal-inner {
    background: #fff; color: #111; border-radius: 8px; padding: 20px;
    width: 100%; max-width: 500px; max-height: 90vh; overflow-y: auto;
  }
  @media (prefers-color-scheme: dark) {
    .kanban-modal-inner { background: #1a1a1a; color: #eee; }
  }
  .kanban-modal-inner h2 { margin-top: 0; }
  .kanban-modal-inner input, .kanban-modal-inner textarea {
    width: 100%; box-sizing: border-box; margin-top: 4px;
  }
  .kanban-modal-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; }
  .kanban-btn-danger { color: #b91c1c; border-color: rgba(185,28,28,0.5); margin-right: auto; }
  .kanban-error { color: #b91c1c; font-size: 0.9em; margin: 8px 0 0; }

  .kanban-toast {
    position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
    background: rgba(0,0,0,0.85); color: #fff; padding: 10px 16px; border-radius: 6px;
    font-size: 0.9em; z-index: 1100; max-width: 90vw;
  }
  .kanban-toast[hidden] { display: none; }

  /* Archive toggle + drawer. */
  .kanban-archive-toggle { margin-left: auto; }
  .kanban-archive {
    margin-top: 32px;
    padding: 16px;
    border: 1px dashed rgba(128,128,128,0.4);
    border-radius: 8px;
    background: rgba(128,128,128,0.04);
  }
  .kanban-archive[hidden] { display: none; }
  .kanban-archive-head { display: flex; align-items: baseline; gap: 12px; margin-bottom: 12px; }
  .kanban-archive-head h2 { margin: 0; font-size: 1.05em; }
  .kanban-archive-count { opacity: 0.7; font-size: 0.85em; }
  .kanban-archive-body { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 8px; }
  .kanban-archive-empty { opacity: 0.7; font-style: italic; margin: 0; }
  .kanban-archived-card {
    opacity: 0.75;
    position: relative;
  }
  .kanban-archived-card .kanban-archived-restore {
    position: absolute; top: 6px; right: 6px;
    font-size: 0.75em; padding: 2px 8px; cursor: pointer;
    background: rgba(128,128,128,0.15); border: 1px solid rgba(128,128,128,0.4);
    border-radius: 4px; color: inherit;
  }
  .kanban-archived-card .kanban-archived-restore:hover { background: rgba(128,128,128,0.3); }
  .kanban-archived-stamp {
    font-size: 0.7em; text-transform: uppercase; letter-spacing: 0.08em;
    opacity: 0.6; margin-top: 4px;
  }

  /* Multi-select groups control in the modal. */
  .kf-groups-field { display: flex; flex-direction: column; gap: 6px; margin-top: 12px; }
  .kf-groups-label { font-size: 0.9em; }
  .kf-groups-chips { display: flex; flex-wrap: wrap; gap: 4px; min-height: 18px; }
  .kf-group-chip { display: inline-flex; align-items: center; gap: 4px; }
  .kf-group-remove {
    background: none; border: none; color: inherit; cursor: pointer;
    font: inherit; font-size: 1.1em; line-height: 1; padding: 0 2px; opacity: 0.7;
  }
  .kf-group-remove:hover { opacity: 1; }
  .kf-groups-entry { display: flex; gap: 6px; }
  .kf-groups-entry input { flex: 1; }
`;

const kanbanClientJs = `
(function() {
  'use strict';
  // Active cards visible on the board (indexed by id).
  var cards = new Map();
  // Archived cards for the currently-open drawer (indexed by id). Only
  // populated after the user opens "Show archived" at least once per session.
  var archivedCards = new Map();
  var archivedLoaded = false;
  var ws = null;
  var reconnectAttempt = 0;
  var pendingClientMsgs = new Map(); // clientMsgId -> { type, meta }
  var editingCardId = null;
  // When opening an archived card from the drawer, we look it up in
  // archivedCards instead of cards. This flag tells the modal which action
  // buttons to show.
  var editingArchived = false;

  var statusEl = document.getElementById('kanban-status');
  var boardEl = document.getElementById('kanban-board');
  var modalEl = document.getElementById('kanban-modal');
  var modalTitleEl = document.getElementById('kanban-modal-title');
  var formEl = document.getElementById('kanban-form');
  var titleInput = document.getElementById('kf-title');
  var groupsChips = document.getElementById('kf-groups-chips');
  var groupsInput = document.getElementById('kf-groups-input');
  var groupsAddBtn = document.getElementById('kf-groups-add');
  var groupsDatalist = document.getElementById('kf-groups-suggest');
  var assignedInput = document.getElementById('kf-assigned');
  var dueInput = document.getElementById('kf-due');
  var notesInput = document.getElementById('kf-notes');
  var errorEl = document.getElementById('kf-error');
  var cancelBtn = document.getElementById('kf-cancel');
  var archiveBtn = document.getElementById('kf-archive');
  var restoreBtn = document.getElementById('kf-restore');
  var saveBtn = document.getElementById('kf-save');
  var toastEl = document.getElementById('kanban-toast');
  var toastTimer = null;
  var archiveToggleBtn = document.getElementById('kanban-archive-toggle');
  var archiveSectionEl = document.getElementById('kanban-archive');
  var archiveBodyEl = document.getElementById('kanban-archive-body');
  var archiveCountEl = document.getElementById('kanban-archive-count');
  var archiveEmptyEl = document.getElementById('kanban-archive-empty');
  var activitySectionEl = document.getElementById('kf-activity');
  var activityListEl = document.getElementById('kf-activity-list');
  var activityEmptyEl = document.getElementById('kf-activity-empty');

  // Column key -> display label. Duplicated from COLUMNS on the server side
  // so the activity strings can show "moved from Started to Done" rather
  // than "started to done".
  var COLUMN_LABELS = {
    not_started: 'Not Started',
    started: 'Started',
    blocked: 'Blocked',
    ready: 'Ready',
    approval: 'Approval',
    done: 'Done',
  };

  function setStatus(text, cls) {
    statusEl.textContent = text;
    statusEl.className = 'kanban-status kanban-status-' + cls;
  }

  function showToast(msg, ms) {
    toastEl.textContent = msg;
    toastEl.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function() { toastEl.hidden = true; }, ms || 4000);
  }

  function nextClientMsgId() {
    return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  // --- Known groups (autocomplete source) ---
  var knownGroups = [];
  try {
    var raw = document.getElementById('kanban-known-groups');
    if (raw && raw.textContent) knownGroups = JSON.parse(raw.textContent) || [];
  } catch (_err) { knownGroups = []; }

  function rebuildGroupsDatalist() {
    while (groupsDatalist.firstChild) groupsDatalist.removeChild(groupsDatalist.firstChild);
    // Suggest names not already picked on the current card.
    var taken = new Set();
    selectedGroups.forEach(function(g) { taken.add(g.toLowerCase()); });
    knownGroups.forEach(function(g) {
      if (taken.has(g.toLowerCase())) return;
      var opt = document.createElement('option');
      opt.value = g;
      groupsDatalist.appendChild(opt);
    });
  }

  function learnGroup(name) {
    var key = name.toLowerCase();
    for (var i = 0; i < knownGroups.length; i++) {
      if (knownGroups[i].toLowerCase() === key) return;
    }
    knownGroups.push(name);
    knownGroups.sort(function(a, b) { return a.localeCompare(b); });
  }

  // --- Modal groups state ---
  var selectedGroups = [];

  function renderSelectedGroups() {
    while (groupsChips.firstChild) groupsChips.removeChild(groupsChips.firstChild);
    selectedGroups.forEach(function(g, idx) {
      var c = document.createElement('span');
      c.className = 'kanban-chip kf-group-chip';
      var txt = document.createElement('span');
      txt.textContent = g;
      var x = document.createElement('button');
      x.type = 'button';
      x.className = 'kf-group-remove';
      x.setAttribute('aria-label', 'Remove group ' + g);
      x.textContent = '×';
      x.addEventListener('click', function() {
        selectedGroups.splice(idx, 1);
        renderSelectedGroups();
        rebuildGroupsDatalist();
      });
      c.appendChild(txt);
      c.appendChild(x);
      groupsChips.appendChild(c);
    });
    rebuildGroupsDatalist();
  }

  function addGroupFromInput() {
    var v = groupsInput.value.trim();
    if (!v) return;
    if (v.length > 100) v = v.slice(0, 100);
    var key = v.toLowerCase();
    var dup = selectedGroups.some(function(g) { return g.toLowerCase() === key; });
    if (!dup) {
      selectedGroups.push(v);
      learnGroup(v);
      renderSelectedGroups();
    }
    groupsInput.value = '';
    groupsInput.focus();
  }

  groupsAddBtn.addEventListener('click', addGroupFromInput);
  groupsInput.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      addGroupFromInput();
    }
  });
  groupsInput.addEventListener('change', function() {
    // The datalist fires 'change' when the user picks a suggestion.
    if (groupsInput.value.trim()) addGroupFromInput();
  });

  function send(msg) {
    if (!ws || ws.readyState !== 1) return false;
    ws.send(JSON.stringify(msg));
    return true;
  }

  // ── Markdown renderer ────────────────────────────────────────────────
  // Intentionally small: supports headings (# / ## / ###…), bullet lists
  // (- / *), numbered lists (1.), inline **bold**, *italic*/_italic_,
  // \`code\`, [text](url), and bare URL autolinks. No raw HTML, no images,
  // no tables. Every character from the input flows through createTextNode;
  // the only DOM creations are element names we choose ourselves. URLs go
  // through the URL constructor + a protocol allowlist, so a javascript:
  // scheme gets normalized and rejected.
  function safeUrl(url) {
    try {
      var u = new URL(url, location.href);
      return u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'mailto:';
    } catch (_err) { return false; }
  }

  function renderInlineInto(text, parent) {
    // Regex order matters: code must win over bold (to protect contents);
    // bold must win over italic at the same index (**x** would otherwise be
    // read as *(*x*)*). Links beat autolinks so [text](url) isn't mangled.
    var patterns = [
      { re: /\`([^\`]+)\`/,                          type: 'code'     },
      { re: /\\*\\*([^*]+)\\*\\*/,                     type: 'strong'   },
      { re: /(?:\\*([^*\\n]+)\\*)|(?:_([^_\\n]+)_)/, type: 'em'       },
      { re: /\\[([^\\]]+)\\]\\(([^)\\s]+)\\)/,         type: 'link'     },
      { re: /https?:\\/\\/[^\\s)]+/,                 type: 'autolink' },
    ];
    var s = String(text);
    while (s.length > 0) {
      var winner = null;
      var winnerPat = null;
      for (var k = 0; k < patterns.length; k++) {
        var m = s.match(patterns[k].re);
        if (m && (winner === null || m.index < winner.index)) {
          winner = m;
          winnerPat = patterns[k];
        }
      }
      if (!winner) { parent.appendChild(document.createTextNode(s)); break; }
      if (winner.index > 0) {
        parent.appendChild(document.createTextNode(s.slice(0, winner.index)));
      }
      if (winnerPat.type === 'code') {
        var c = document.createElement('code');
        c.textContent = winner[1];
        parent.appendChild(c);
      } else if (winnerPat.type === 'strong') {
        var b = document.createElement('strong');
        b.textContent = winner[1];
        parent.appendChild(b);
      } else if (winnerPat.type === 'em') {
        var em = document.createElement('em');
        em.textContent = winner[1] || winner[2] || '';
        parent.appendChild(em);
      } else if (winnerPat.type === 'link') {
        var url = winner[2];
        if (safeUrl(url)) {
          var a = document.createElement('a');
          a.href = url;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          a.textContent = winner[1];
          parent.appendChild(a);
        } else {
          parent.appendChild(document.createTextNode(winner[0]));
        }
      } else if (winnerPat.type === 'autolink') {
        var url2 = winner[0];
        if (safeUrl(url2)) {
          var a2 = document.createElement('a');
          a2.href = url2;
          a2.target = '_blank';
          a2.rel = 'noopener noreferrer';
          a2.textContent = url2;
          parent.appendChild(a2);
        } else {
          parent.appendChild(document.createTextNode(url2));
        }
      }
      s = s.slice(winner.index + winner[0].length);
    }
  }

  function renderMarkdownInto(md, container) {
    while (container.firstChild) container.removeChild(container.firstChild);
    if (!md) return;
    var lines = String(md).split(/\\r?\\n/);
    var i = 0;
    while (i < lines.length) {
      var line = lines[i];
      if (!line.trim()) { i++; continue; }
      var h = line.match(/^(#{1,6})\\s+(.+)$/);
      if (h) {
        var tag = 'h' + Math.min(h[1].length, 6);
        var el = document.createElement(tag);
        renderInlineInto(h[2], el);
        container.appendChild(el);
        i++;
        continue;
      }
      if (/^\\s*[-*]\\s+/.test(line)) {
        var ul = document.createElement('ul');
        while (i < lines.length && /^\\s*[-*]\\s+/.test(lines[i])) {
          var li = document.createElement('li');
          renderInlineInto(lines[i].replace(/^\\s*[-*]\\s+/, ''), li);
          ul.appendChild(li);
          i++;
        }
        container.appendChild(ul);
        continue;
      }
      if (/^\\s*\\d+\\.\\s+/.test(line)) {
        var ol = document.createElement('ol');
        while (i < lines.length && /^\\s*\\d+\\.\\s+/.test(lines[i])) {
          var li2 = document.createElement('li');
          renderInlineInto(lines[i].replace(/^\\s*\\d+\\.\\s+/, ''), li2);
          ol.appendChild(li2);
          i++;
        }
        container.appendChild(ol);
        continue;
      }
      var pLines = [];
      while (
        i < lines.length && lines[i].trim() &&
        !/^(#{1,6})\\s+/.test(lines[i]) &&
        !/^\\s*[-*]\\s+/.test(lines[i]) &&
        !/^\\s*\\d+\\.\\s+/.test(lines[i])
      ) {
        pLines.push(lines[i]);
        i++;
      }
      var p = document.createElement('p');
      for (var j = 0; j < pLines.length; j++) {
        if (j > 0) p.appendChild(document.createElement('br'));
        renderInlineInto(pLines[j], p);
      }
      container.appendChild(p);
    }
  }

  function renderAll() {
    for (var i = 0; i < boardEl.children.length; i++) {
      var colKey = boardEl.children[i].getAttribute('data-col');
      var body = boardEl.querySelector('[data-col-body="' + colKey + '"]');
      while (body.firstChild) body.removeChild(body.firstChild);
    }
    var byCol = {};
    cards.forEach(function(card) {
      (byCol[card.column] = byCol[card.column] || []).push(card);
    });
    Object.keys(byCol).forEach(function(col) {
      byCol[col].sort(function(a, b) { return a.position - b.position; });
      var body = boardEl.querySelector('[data-col-body="' + col + '"]');
      if (!body) return;
      byCol[col].forEach(function(card) { body.appendChild(renderCardNode(card)); });
    });
  }

  // Patch a single card's node in place (or add it if new).
  function upsertCard(card) {
    cards.set(card.id, card);
    var existing = document.querySelector('[data-card-id="' + card.id + '"]');
    var node = renderCardNode(card);
    var body = boardEl.querySelector('[data-col-body="' + card.column + '"]');
    if (!body) return;
    if (existing) existing.parentNode.removeChild(existing);
    // Insert at the right position within the column.
    var siblings = Array.prototype.slice.call(body.children);
    var inserted = false;
    for (var i = 0; i < siblings.length; i++) {
      var sid = parseInt(siblings[i].getAttribute('data-card-id'), 10);
      var sc = cards.get(sid);
      if (sc && sc.position > card.position) {
        body.insertBefore(node, siblings[i]);
        inserted = true;
        break;
      }
    }
    if (!inserted) body.appendChild(node);
  }

  function removeCardNode(id) {
    cards.delete(id);
    var existing = document.querySelector('[data-card-id="' + id + '"]');
    if (existing) existing.parentNode.removeChild(existing);
  }

  // Build a card DOM node. Uses textContent throughout — card content is
  // user-supplied and must NEVER be concatenated into an HTML string.
  function renderCardNode(card) {
    var el = document.createElement('div');
    el.className = 'kanban-card';
    el.setAttribute('data-card-id', String(card.id));
    el.setAttribute('data-version', String(card.version));

    var titleEl = document.createElement('div');
    titleEl.className = 'kanban-card-title';
    titleEl.textContent = card.title;
    el.appendChild(titleEl);

    var meta = document.createElement('div');
    meta.className = 'kanban-card-meta';
    if (Array.isArray(card.groups)) {
      card.groups.forEach(function(g) { meta.appendChild(chip(g)); });
    }
    if (card.assigned) meta.appendChild(chip('@ ' + card.assigned));
    if (card.dueDate) meta.appendChild(chip('Due ' + card.dueDate));
    if (meta.childNodes.length > 0) el.appendChild(meta);

    if (card.notes) {
      var notesEl = document.createElement('div');
      notesEl.className = 'kanban-card-notes';
      renderMarkdownInto(card.notes, notesEl);
      el.appendChild(notesEl);
    }

    el.addEventListener('click', function() { openEditModal(card.id); });
    return el;
  }

  function chip(text) {
    var c = document.createElement('span');
    c.className = 'kanban-chip';
    c.textContent = text;
    return c;
  }

  // ── Activity timeline ───────────────────────────────────────────────
  // Events for the currently-opened card, newest first. Reset every time
  // the modal opens; not persisted across sessions.
  var activityEvents = [];

  function relativeTime(iso) {
    if (!iso) return '';
    // D1's datetime('now') returns 'YYYY-MM-DD HH:MM:SS' in UTC without a
    // timezone suffix. Date() needs an explicit Z or offset to parse it as
    // UTC rather than local time.
    var s = String(iso);
    if (s.indexOf('T') < 0 && s.indexOf(' ') > 0) s = s.replace(' ', 'T') + 'Z';
    var then = new Date(s).getTime();
    if (isNaN(then)) return iso;
    var secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
    if (secs < 5) return 'just now';
    if (secs < 60) return secs + 's ago';
    var mins = Math.floor(secs / 60);
    if (mins < 60) return mins + 'm ago';
    var hours = Math.floor(mins / 60);
    if (hours < 24) return hours + 'h ago';
    var days = Math.floor(hours / 24);
    if (days < 30) return days + 'd ago';
    return new Date(then).toISOString().slice(0, 10);
  }

  function describeEvent(ev) {
    var m = ev.metadata || {};
    switch (ev.kind) {
      case 'card.created':
        return 'created this card';
      case 'card.updated':
        if (Array.isArray(m.changedFields) && m.changedFields.length) {
          return 'edited ' + m.changedFields.join(', ');
        }
        return 'edited the card';
      case 'card.moved':
        var from = COLUMN_LABELS[m.fromColumn] || m.fromColumn || '?';
        var to = COLUMN_LABELS[m.toColumn] || m.toColumn || '?';
        return 'moved from ' + from + ' to ' + to;
      case 'card.archived':
        return 'archived this card';
      case 'card.unarchived':
        return 'restored this card';
      case 'card.deleted':
        return 'deleted this card';
      default:
        return ev.kind;
    }
  }

  function renderActivityInto() {
    while (activityListEl.firstChild) activityListEl.removeChild(activityListEl.firstChild);
    if (activityEvents.length === 0) {
      activityEmptyEl.hidden = false;
      return;
    }
    activityEmptyEl.hidden = true;
    for (var i = 0; i < activityEvents.length; i++) {
      var ev = activityEvents[i];
      var li = document.createElement('li');
      li.className = 'kf-activity-item';

      var actor = document.createElement('div');
      actor.className = 'kf-activity-actor';
      actor.textContent = ev.actorDisplayName || 'System';

      var desc = document.createElement('div');
      desc.className = 'kf-activity-desc';
      desc.textContent = describeEvent(ev);

      var time = document.createElement('div');
      time.className = 'kf-activity-time';
      time.textContent = relativeTime(ev.createdAt);
      time.title = ev.createdAt || '';

      li.appendChild(actor);
      li.appendChild(desc);
      li.appendChild(time);
      activityListEl.appendChild(li);
    }
  }

  function requestCardEvents(cardId) {
    activityEvents = [];
    renderActivityInto();
    var cmid = nextClientMsgId();
    pendingClientMsgs.set(cmid, { type: 'list_events', cardId: cardId });
    send({ type: 'list_card_events', clientMsgId: cmid, cardId: cardId });
  }

  // --- Modal ---
  function openCreateModal(column) {
    editingCardId = null;
    editingArchived = false;
    modalTitleEl.textContent = 'New card';
    titleInput.value = '';
    selectedGroups = [];
    renderSelectedGroups();
    groupsInput.value = '';
    assignedInput.value = '';
    dueInput.value = '';
    notesInput.value = '';
    errorEl.hidden = true;
    archiveBtn.hidden = true;
    restoreBtn.hidden = true;
    // No card id yet → no activity timeline to show.
    activitySectionEl.hidden = true;
    activityEvents = [];
    saveBtn.disabled = false;
    formEl.dataset.column = column;
    modalEl.hidden = false;
    titleInput.focus();
  }

  function openEditModal(id, fromArchive) {
    var card = fromArchive ? archivedCards.get(id) : cards.get(id);
    if (!card) return;
    editingCardId = id;
    editingArchived = !!fromArchive;
    modalTitleEl.textContent = editingArchived ? 'Archived card' : 'Edit card';
    titleInput.value = card.title;
    selectedGroups = Array.isArray(card.groups) ? card.groups.slice() : [];
    renderSelectedGroups();
    groupsInput.value = '';
    assignedInput.value = card.assigned || '';
    dueInput.value = card.dueDate || '';
    notesInput.value = card.notes || '';
    errorEl.hidden = true;
    // Archive and Restore are mutually exclusive: Archive only appears for
    // active cards; Restore only appears for archived ones.
    archiveBtn.hidden = editingArchived;
    restoreBtn.hidden = !editingArchived;
    // Reveal the activity timeline and kick off a fetch for this card's
    // events. The list renders empty while the request is in flight.
    activitySectionEl.hidden = false;
    requestCardEvents(id);
    saveBtn.disabled = false;
    formEl.dataset.column = card.column;
    modalEl.hidden = false;
    titleInput.focus();
  }

  function closeModal() {
    modalEl.hidden = true;
    editingCardId = null;
    editingArchived = false;
  }

  function showFormError(msg) {
    errorEl.textContent = msg;
    errorEl.hidden = false;
    saveBtn.disabled = false;
  }

  cancelBtn.addEventListener('click', closeModal);
  modalEl.addEventListener('click', function(e) { if (e.target === modalEl) closeModal(); });

  formEl.addEventListener('submit', function(e) {
    e.preventDefault();
    // Fold any unsubmitted typed group into the chip list before saving.
    if (groupsInput.value.trim()) addGroupFromInput();
    var title = titleInput.value.trim();
    if (!title) { showFormError('Task Name is required.'); return; }
    saveBtn.disabled = true;
    var cmid = nextClientMsgId();
    if (editingCardId === null) {
      pendingClientMsgs.set(cmid, { type: 'create' });
      var ok = send({
        type: 'create_card',
        clientMsgId: cmid,
        column: formEl.dataset.column,
        title: title,
        groups: selectedGroups.slice(),
        assigned: assignedInput.value.trim() || null,
        notes: notesInput.value.trim() || null,
        dueDate: dueInput.value || null,
      });
      if (!ok) showFormError('Disconnected — try again when reconnected.');
    } else {
      var card = editingArchived
        ? archivedCards.get(editingCardId)
        : cards.get(editingCardId);
      if (!card) { showFormError('Card no longer exists.'); return; }
      pendingClientMsgs.set(cmid, { type: 'update', id: editingCardId, archived: editingArchived });
      var ok2 = send({
        type: 'update_card',
        clientMsgId: cmid,
        id: editingCardId,
        version: card.version,
        patch: {
          title: title,
          groups: selectedGroups.slice(),
          assigned: assignedInput.value.trim() || null,
          notes: notesInput.value.trim() || null,
          dueDate: dueInput.value || null,
        },
      });
      if (!ok2) showFormError('Disconnected — try again when reconnected.');
    }
  });

  archiveBtn.addEventListener('click', function() {
    if (editingCardId === null) return;
    var card = cards.get(editingCardId);
    if (!card) { closeModal(); return; }
    // Archive is a soft, reversible action, so a confirm() prompt would be
    // friction without much safety value. If we later add undo-toast UX we
    // can drop even this silent barrier; for now we go direct.
    saveBtn.disabled = true;
    var cmid = nextClientMsgId();
    pendingClientMsgs.set(cmid, { type: 'archive', id: editingCardId });
    send({ type: 'archive_card', clientMsgId: cmid, id: editingCardId, version: card.version });
  });

  restoreBtn.addEventListener('click', function() {
    if (editingCardId === null) return;
    var card = archivedCards.get(editingCardId);
    if (!card) { closeModal(); return; }
    saveBtn.disabled = true;
    var cmid = nextClientMsgId();
    pendingClientMsgs.set(cmid, { type: 'unarchive', id: editingCardId });
    send({ type: 'unarchive_card', clientMsgId: cmid, id: editingCardId, version: card.version });
  });

  // --- Archive drawer ---
  function requestArchivedSnapshot() {
    var cmid = nextClientMsgId();
    pendingClientMsgs.set(cmid, { type: 'list_archived' });
    send({ type: 'list_archived', clientMsgId: cmid });
  }

  function renderArchived() {
    while (archiveBodyEl.firstChild) archiveBodyEl.removeChild(archiveBodyEl.firstChild);
    if (archivedCards.size === 0) {
      archiveEmptyEl.hidden = false;
      archiveCountEl.textContent = '';
      return;
    }
    archiveEmptyEl.hidden = true;
    archiveCountEl.textContent = '(' + archivedCards.size + ')';
    // Render in descending archivedAt order; fall back to id for stability.
    var all = Array.from(archivedCards.values());
    all.sort(function(a, b) {
      var aa = a.archivedAt || '';
      var bb = b.archivedAt || '';
      if (aa < bb) return 1;
      if (aa > bb) return -1;
      return b.id - a.id;
    });
    all.forEach(function(card) {
      archiveBodyEl.appendChild(renderArchivedCardNode(card));
    });
  }

  function renderArchivedCardNode(card) {
    var el = renderCardNode(card);
    el.classList.add('kanban-archived-card');
    // Override the click handler to open the modal in "archived" mode so the
    // Restore button is shown instead of Archive.
    var clone = el.cloneNode(true);
    clone.addEventListener('click', function(ev) {
      // Ignore clicks on the inline Restore button — it has its own handler.
      if (ev.target && ev.target.classList && ev.target.classList.contains('kanban-archived-restore')) return;
      openEditModal(card.id, true);
    });

    var stamp = document.createElement('div');
    stamp.className = 'kanban-archived-stamp';
    stamp.textContent = card.archivedAt
      ? 'Archived ' + card.archivedAt.slice(0, 10)
      : 'Archived';
    clone.appendChild(stamp);

    var restore = document.createElement('button');
    restore.type = 'button';
    restore.className = 'kanban-archived-restore';
    restore.textContent = 'Restore';
    restore.setAttribute('aria-label', 'Restore archived card');
    restore.addEventListener('click', function(ev) {
      ev.stopPropagation();
      var cmid = nextClientMsgId();
      pendingClientMsgs.set(cmid, { type: 'unarchive', id: card.id });
      send({ type: 'unarchive_card', clientMsgId: cmid, id: card.id, version: card.version });
    });
    clone.appendChild(restore);
    return clone;
  }

  archiveToggleBtn.addEventListener('click', function() {
    var showing = !archiveSectionEl.hidden;
    if (showing) {
      archiveSectionEl.hidden = true;
      archiveToggleBtn.setAttribute('aria-expanded', 'false');
      archiveToggleBtn.textContent = 'Show archived';
      return;
    }
    archiveSectionEl.hidden = false;
    archiveToggleBtn.setAttribute('aria-expanded', 'true');
    archiveToggleBtn.textContent = 'Hide archived';
    if (!archivedLoaded) {
      requestArchivedSnapshot();
    } else {
      renderArchived();
    }
  });

  // --- Add button per column ---
  boardEl.querySelectorAll('.kanban-add').forEach(function(btn) {
    btn.addEventListener('click', function() {
      openCreateModal(btn.getAttribute('data-add-col'));
    });
  });

  // --- Drag-and-drop via SortableJS ---
  function setupSortable() {
    boardEl.querySelectorAll('[data-col-body]').forEach(function(body) {
      new Sortable(body, {
        group: 'kanban',
        animation: 150,
        ghostClass: 'sortable-ghost',
        dragClass: 'sortable-drag',
        onEnd: function(evt) {
          var cardId = parseInt(evt.item.getAttribute('data-card-id'), 10);
          var toColumn = evt.to.getAttribute('data-col-body');
          var toPosition = evt.newIndex;
          var card = cards.get(cardId);
          if (!card) return;
          if (card.column === toColumn && card.position === toPosition) return;
          var cmid = nextClientMsgId();
          pendingClientMsgs.set(cmid, { type: 'move', id: cardId, prev: { column: card.column, position: card.position } });
          send({
            type: 'move_card',
            clientMsgId: cmid,
            id: cardId,
            version: card.version,
            toColumn: toColumn,
            toPosition: toPosition,
          });
        },
      });
    });
  }

  // --- Server event dispatch ---
  function onServerMsg(msg) {
    switch (msg.type) {
      case 'snapshot':
        cards.clear();
        msg.cards.forEach(function(c) { cards.set(c.id, c); });
        renderAll();
        return;
      case 'card_created':
        upsertCard(msg.card);
        return;
      case 'card_updated':
        // Edits on archived cards come back here too; keep them in the
        // archivedCards map and re-render the drawer if visible.
        if (msg.card.archivedAt) {
          archivedCards.set(msg.card.id, msg.card);
          if (!archiveSectionEl.hidden) renderArchived();
        } else {
          upsertCard(msg.card);
        }
        // If the modal is open on this card and the update was acked, closeModal runs via the ack handler.
        return;
      case 'card_moved':
        // Apply the canonical post-move positions for all touched cards.
        cards.set(msg.card.id, msg.card);
        if (msg.positions && msg.positions.length) {
          msg.positions.forEach(function(p) {
            var c = cards.get(p.id);
            if (c) { c.column = p.column; c.position = p.position; c.version = p.version; }
          });
        }
        renderAll();
        return;
      case 'card_deleted':
        // Hard-delete path (not wired to the UI but can still arrive from
        // an admin tool or a stale client). Purge from both maps.
        removeCardNode(msg.id);
        archivedCards.delete(msg.id);
        if (!archiveSectionEl.hidden) renderArchived();
        return;
      case 'card_archived':
        // Remove from the board; add to the archive drawer. The payload
        // carries the full card (including archivedAt) plus the post-archive
        // positions of the remaining active cards in the source column.
        removeCardNode(msg.card.id);
        archivedCards.set(msg.card.id, msg.card);
        if (msg.positions && msg.positions.length) {
          msg.positions.forEach(function(p) {
            var c = cards.get(p.id);
            if (c) { c.column = p.column; c.position = p.position; c.version = p.version; }
          });
        }
        renderAll();
        if (!archiveSectionEl.hidden) renderArchived();
        return;
      case 'card_unarchived':
        // Move back to the board; drop from drawer. Positions payload covers
        // the destination column's new dense ordering.
        archivedCards.delete(msg.card.id);
        cards.set(msg.card.id, msg.card);
        if (msg.positions && msg.positions.length) {
          msg.positions.forEach(function(p) {
            var c = cards.get(p.id);
            if (c) { c.column = p.column; c.position = p.position; c.version = p.version; }
          });
        }
        renderAll();
        if (!archiveSectionEl.hidden) renderArchived();
        return;
      case 'archived_snapshot':
        archivedCards.clear();
        (msg.cards || []).forEach(function(c) { archivedCards.set(c.id, c); });
        archivedLoaded = true;
        if (!archiveSectionEl.hidden) renderArchived();
        return;
      case 'card_events_snapshot':
        // Ignore snapshots for a card that's no longer the one being edited
        // — a user may have closed the modal before the response arrived.
        if (editingCardId !== msg.cardId) return;
        activityEvents = (msg.events || []).slice();
        renderActivityInto();
        return;
      case 'card_event':
        // Live append when the event targets the currently-open card.
        // Broadcasts arrive for every mutation; other clients just drop them.
        if (!msg.event || editingCardId !== msg.event.cardId) return;
        // Events arrive newest-last from the DO, but we display newest-first,
        // so unshift into the local list.
        activityEvents.unshift(msg.event);
        renderActivityInto();
        return;
      case 'ack':
        pendingClientMsgs.delete(msg.clientMsgId);
        if (!modalEl.hidden && saveBtn.disabled) closeModal();
        return;
      case 'nack':
        var pending = pendingClientMsgs.get(msg.clientMsgId);
        pendingClientMsgs.delete(msg.clientMsgId);
        if (msg.reason === 'version_conflict') {
          showToast('Someone else just updated this card — refreshed with latest.', 5000);
          if (pending && pending.type === 'update' && editingCardId === pending.id) {
            openEditModal(pending.id);
          } else {
            saveBtn.disabled = false;
          }
        } else if (msg.reason === 'not_found') {
          showToast('That card no longer exists.', 4000);
          if (pending && pending.type === 'move') renderAll();
          saveBtn.disabled = false;
          if (!modalEl.hidden) closeModal();
        } else if (msg.reason === 'invalid') {
          showFormError('Your input was rejected by the server.');
        } else {
          showFormError('Server error — please try again.');
        }
        return;
    }
  }

  // --- Connection lifecycle ---
  function connect() {
    setStatus('Connecting…', 'pending');
    var proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    var slug = boardEl.getAttribute('data-board-slug') || '';
    ws = new WebSocket(proto + location.host + '/kanban/' + encodeURIComponent(slug) + '/ws');
    ws.addEventListener('open', function() {
      reconnectAttempt = 0;
      setStatus('Live', 'ok');
    });
    ws.addEventListener('message', function(ev) {
      try {
        var msg = JSON.parse(ev.data);
        onServerMsg(msg);
      } catch (_err) { /* ignore malformed */ }
    });
    ws.addEventListener('close', function() {
      setStatus('Reconnecting…', 'err');
      pendingClientMsgs.clear();
      var delay = Math.min(30000, 1000 * Math.pow(2, reconnectAttempt));
      reconnectAttempt++;
      setTimeout(connect, delay);
    });
    ws.addEventListener('error', function() { /* close will follow */ });
  }

  setupSortable();
  connect();
})();
`;
