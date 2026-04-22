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
}

export const COLUMNS: Array<{ key: ColumnName; label: string }> = [
  { key: 'not_started', label: 'Not Started' },
  { key: 'started', label: 'Started' },
  { key: 'blocked', label: 'Blocked' },
  { key: 'ready', label: 'Ready' },
  { key: 'approval', label: 'Approval' },
  { key: 'done', label: 'Done' },
];

export const KanbanPage: FC<KanbanPageProps> = ({ user, board }) => {
  return (
    <Layout title={`Kanban · ${board.name}`} user={user}>
      <style>{kanbanCss}</style>
      <div class="kanban-head">
        <a class="kanban-back" href="/kanban" aria-label="Back to board list">← All boards</a>
        <h1>{board.name}</h1>
        <span id="kanban-status" class="kanban-status kanban-status-pending">Connecting…</span>
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

      <div id="kanban-modal" class="kanban-modal" hidden>
        <div class="kanban-modal-inner">
          <h2 id="kanban-modal-title">New card</h2>
          <form id="kanban-form">
            <label>Task Name
              <input type="text" id="kf-title" required maxlength={200} />
            </label>
            <label>Group
              <input type="text" id="kf-group" maxlength={100} />
            </label>
            <label>Assigned
              <input type="text" id="kf-assigned" maxlength={100} />
            </label>
            <label>Due Date
              <input type="date" id="kf-due" />
            </label>
            <label>Notes
              <textarea id="kf-notes" rows={4} maxlength={10000}></textarea>
            </label>
            <p id="kf-error" class="kanban-error" hidden></p>
            <div class="kanban-modal-actions">
              <button type="button" id="kf-cancel" class="btn">Cancel</button>
              <button type="button" id="kf-delete" class="btn kanban-btn-danger" hidden>Delete</button>
              <button type="submit" id="kf-save" class="btn btn-primary">Save</button>
            </div>
          </form>
        </div>
      </div>

      <div id="kanban-toast" class="kanban-toast" hidden></div>

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
`;

const kanbanClientJs = `
(function() {
  'use strict';
  var cards = new Map();
  var ws = null;
  var reconnectAttempt = 0;
  var pendingClientMsgs = new Map(); // clientMsgId -> { type, meta }
  var editingCardId = null;

  var statusEl = document.getElementById('kanban-status');
  var boardEl = document.getElementById('kanban-board');
  var modalEl = document.getElementById('kanban-modal');
  var modalTitleEl = document.getElementById('kanban-modal-title');
  var formEl = document.getElementById('kanban-form');
  var titleInput = document.getElementById('kf-title');
  var groupInput = document.getElementById('kf-group');
  var assignedInput = document.getElementById('kf-assigned');
  var dueInput = document.getElementById('kf-due');
  var notesInput = document.getElementById('kf-notes');
  var errorEl = document.getElementById('kf-error');
  var cancelBtn = document.getElementById('kf-cancel');
  var deleteBtn = document.getElementById('kf-delete');
  var saveBtn = document.getElementById('kf-save');
  var toastEl = document.getElementById('kanban-toast');
  var toastTimer = null;

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

  function send(msg) {
    if (!ws || ws.readyState !== 1) return false;
    ws.send(JSON.stringify(msg));
    return true;
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
    if (card.group) meta.appendChild(chip('Group: ' + card.group));
    if (card.assigned) meta.appendChild(chip('@ ' + card.assigned));
    if (card.dueDate) meta.appendChild(chip('Due ' + card.dueDate));
    if (meta.childNodes.length > 0) el.appendChild(meta);

    if (card.notes) {
      var notesEl = document.createElement('div');
      notesEl.className = 'kanban-card-notes';
      notesEl.textContent = card.notes;
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

  // --- Modal ---
  function openCreateModal(column) {
    editingCardId = null;
    modalTitleEl.textContent = 'New card';
    titleInput.value = '';
    groupInput.value = '';
    assignedInput.value = '';
    dueInput.value = '';
    notesInput.value = '';
    errorEl.hidden = true;
    deleteBtn.hidden = true;
    saveBtn.disabled = false;
    formEl.dataset.column = column;
    modalEl.hidden = false;
    titleInput.focus();
  }

  function openEditModal(id) {
    var card = cards.get(id);
    if (!card) return;
    editingCardId = id;
    modalTitleEl.textContent = 'Edit card';
    titleInput.value = card.title;
    groupInput.value = card.group || '';
    assignedInput.value = card.assigned || '';
    dueInput.value = card.dueDate || '';
    notesInput.value = card.notes || '';
    errorEl.hidden = true;
    deleteBtn.hidden = false;
    saveBtn.disabled = false;
    formEl.dataset.column = card.column;
    modalEl.hidden = false;
    titleInput.focus();
  }

  function closeModal() {
    modalEl.hidden = true;
    editingCardId = null;
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
        group: groupInput.value.trim() || null,
        assigned: assignedInput.value.trim() || null,
        notes: notesInput.value.trim() || null,
        dueDate: dueInput.value || null,
      });
      if (!ok) showFormError('Disconnected — try again when reconnected.');
    } else {
      var card = cards.get(editingCardId);
      if (!card) { showFormError('Card no longer exists.'); return; }
      pendingClientMsgs.set(cmid, { type: 'update', id: editingCardId });
      var ok2 = send({
        type: 'update_card',
        clientMsgId: cmid,
        id: editingCardId,
        version: card.version,
        patch: {
          title: title,
          group: groupInput.value.trim() || null,
          assigned: assignedInput.value.trim() || null,
          notes: notesInput.value.trim() || null,
          dueDate: dueInput.value || null,
        },
      });
      if (!ok2) showFormError('Disconnected — try again when reconnected.');
    }
  });

  deleteBtn.addEventListener('click', function() {
    if (editingCardId === null) return;
    var card = cards.get(editingCardId);
    if (!card) { closeModal(); return; }
    if (!confirm('Delete this card?')) return;
    saveBtn.disabled = true;
    var cmid = nextClientMsgId();
    pendingClientMsgs.set(cmid, { type: 'delete', id: editingCardId });
    send({ type: 'delete_card', clientMsgId: cmid, id: editingCardId, version: card.version });
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
        upsertCard(msg.card);
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
        removeCardNode(msg.id);
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
