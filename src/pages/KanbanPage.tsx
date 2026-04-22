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
import type {
  AssigneeDto,
  BoardColumnConfigDto,
  BoardDto,
  ColumnName,
} from '../services/kanban.service';

interface KanbanPageProps {
  user: AuthUser;
  board: BoardDto;
  knownGroups: string[];
  /** Active-user directory for the assignee picker. */
  knownUsers: AssigneeDto[];
  /** Per-board column config (S12). Server-rendered as the initial board
   *  structure; the client rebuilds when columns are added/renamed/deleted. */
  columns: BoardColumnConfigDto[];
}

/** Legacy default — kept only as a server-side fallback if a board has
 *  no kanban_board_columns rows for some reason. Should never trigger
 *  in practice because every new board is auto-seeded. */
const FALLBACK_COLUMNS: BoardColumnConfigDto[] = [
  { columnName: 'not_started', label: 'Not Started', position: 0, wipLimit: null, color: null },
  { columnName: 'started', label: 'Started', position: 1, wipLimit: null, color: null },
  { columnName: 'blocked', label: 'Blocked', position: 2, wipLimit: null, color: null },
  { columnName: 'ready', label: 'Ready', position: 3, wipLimit: null, color: null },
  { columnName: 'approval', label: 'Approval', position: 4, wipLimit: null, color: null },
  { columnName: 'done', label: 'Done', position: 5, wipLimit: null, color: null },
];

export const KanbanPage: FC<KanbanPageProps> = ({ user, board, knownGroups, knownUsers, columns }) => {
  const cols = columns.length > 0 ? columns : FALLBACK_COLUMNS;
  const isStaff = user.roles.includes('admin') || user.roles.includes('staff');
  return (
    <Layout title={`Kanban · ${board.name}`} user={user}>
      <style>{kanbanCss}</style>
      <div class="kanban-head">
        <a class="kanban-back" href="/kanban" aria-label="Back to board list">← All boards</a>
        <h1>{board.name}</h1>
        <span id="kanban-status" class="kanban-status kanban-status-pending">Connecting…</span>
        <button id="kanban-templates-btn" class="btn" type="button" title="Card templates">
          Templates
        </button>
        {isStaff ? (
          <a class="btn" href={`/kanban/${encodeURIComponent(board.slug)}/import`} title="Bulk import from CSV">
            Import CSV
          </a>
        ) : null}
        <button id="kanban-archive-toggle" class="btn kanban-archive-toggle" type="button" aria-expanded="false">
          Show archived
        </button>
      </div>

      <div id="kanban-saved-filters" class="kanban-saved-filters" aria-label="Saved filters" hidden></div>

      <div class="kanban-filters" id="kanban-filters" role="search" aria-label="Filter cards">
        <input type="search" id="kf-search" class="kf-search"
               placeholder="Search… or operators: assigned:lion label:urgent column:done has:due is:overdue"
               aria-label="Search cards" autocomplete="off"
               title="Press / anywhere to focus this box. Operators: assigned:, label:, group:, column:, has:due|start|cover|notes, is:overdue|mine|archived|done" />
        <label class="kf-filter-toggle">
          <input type="checkbox" id="kf-mine" />
          <span>Mine</span>
        </label>
        <label class="kf-filter-toggle">
          <input type="checkbox" id="kf-overdue" />
          <span>Overdue</span>
        </label>
        <label class="kf-filter-toggle">
          <input type="checkbox" id="kf-has-due" />
          <span>Has due date</span>
        </label>
        <button type="button" id="kf-clear" class="btn kf-clear" hidden>Clear</button>
        <button type="button" id="kf-save-filter" class="btn kf-save-filter" hidden title="Save the current query as a named filter">★ Save</button>
        <span id="kf-count" class="kf-count" aria-live="polite"></span>
      </div>

      <div class="kanban-board" id="kanban-board" data-board-slug={board.slug}>
        {cols.map((col) => (
          <section
            class="kanban-col"
            data-col={col.columnName}
            data-col-color={col.color ?? ''}
            style={col.color ? `--col-accent: ${col.color}` : undefined}
          >
            <header class="kanban-col-head">
              <span class="kanban-col-title" data-col-title={col.columnName}>{col.label}</span>
              <span class="kanban-col-count" data-col-count={col.columnName} aria-label="Card count"></span>
              {isStaff ? (
                <input
                  type="color"
                  class="kanban-col-color"
                  data-col-color-input={col.columnName}
                  value={col.color ?? '#94a3b8'}
                  aria-label={`Color for column ${col.label}`}
                  title="Set column color"
                />
              ) : null}
              {isStaff ? (
                <button class="kanban-col-del" data-col-del={col.columnName} type="button" aria-label={`Delete column ${col.label}`} title="Delete column (must be empty)">×</button>
              ) : null}
              <button class="kanban-add" data-add-col={col.columnName} type="button" aria-label={`Add card to ${col.label}`}>+</button>
            </header>
            <div class="kanban-col-body" data-col-body={col.columnName}></div>
          </section>
        ))}
        {isStaff ? (
          <section class="kanban-col kanban-col-add" id="kanban-col-add">
            <button id="kanban-add-col-btn" type="button" class="kanban-add-col-btn" aria-label="Add a new column">
              + Add column
            </button>
          </section>
        ) : null}
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
            <div class="kf-assignees-field">
              <span class="kf-assignees-label">Assignees</span>
              <div id="kf-assignees-chips" class="kf-assignees-chips" aria-live="polite"></div>
              <div class="kf-assignees-entry">
                <input type="text" id="kf-assignees-input" list="kf-assignees-suggest"
                       placeholder="Type a name or email and press Enter"
                       aria-label="Add an assignee" />
                <datalist id="kf-assignees-suggest"></datalist>
                <button type="button" id="kf-assignees-add" class="btn">Add</button>
              </div>
            </div>
            <label>Assigned (legacy text — for non-users)
              <input type="text" id="kf-assigned" maxlength={100} />
            </label>
            <label>Start Date
              <input type="date" id="kf-start" />
            </label>
            <div class="kf-due-row">
              <label class="kf-due-date">Due Date
                <input type="date" id="kf-due" />
              </label>
              <label class="kf-due-time">Due Time
                <input type="time" id="kf-due-time" />
              </label>
            </div>
            <div class="kf-cover-row">
              <label class="kf-cover-label">Cover color
                <input type="color" id="kf-cover" />
              </label>
              <button type="button" id="kf-cover-clear" class="btn kf-cover-clear">Clear</button>
            </div>
            <label>Notes
              <textarea id="kf-notes" rows={4} maxlength={10000}></textarea>
              <span class="kf-notes-hint">Markdown supported: **bold**, *italic*, `code`, [link](https://…), bullet/numbered lists, # headings.</span>
            </label>
            <section id="kf-attachments" class="kf-attachments" hidden aria-label="Attachments">
              <h3 class="kf-attachments-title">Attachments</h3>
              <ul id="kf-attachments-list" class="kf-attachments-list"></ul>
              <div class="kf-attachments-add">
                <input type="file" id="kf-attachment-input" aria-label="Choose file to upload" />
                <button type="button" id="kf-attachment-upload" class="btn">Upload</button>
                <span id="kf-attachment-status" class="kf-attachment-status muted"></span>
              </div>
            </section>
            <section id="kf-checklist" class="kf-checklist" hidden aria-label="Checklist">
              <h3 class="kf-checklist-title">Checklist <span id="kf-checklist-progress" class="kf-checklist-progress"></span></h3>
              <ol id="kf-checklist-list" class="kf-checklist-list"></ol>
              <div class="kf-checklist-add">
                <input type="text" id="kf-checklist-input" maxlength={500}
                       placeholder="Add an item, press Enter" aria-label="New checklist item" />
                <button type="button" id="kf-checklist-add-btn" class="btn">Add</button>
              </div>
            </section>
            <section id="kf-comments" class="kf-comments" hidden aria-label="Comments">
              <h3 class="kf-comments-title">Comments</h3>
              <ol id="kf-comments-list" class="kf-comments-list"></ol>
              <p id="kf-comments-empty" class="kf-comments-empty" hidden>No comments yet — be the first.</p>
              <div class="kf-comment-composer">
                <textarea id="kf-comment-input" rows={2} maxlength={5000}
                          placeholder="Write a comment… (Markdown supported, Ctrl+Enter to post)"
                          aria-label="New comment"></textarea>
                <div class="kf-comment-composer-actions">
                  <button type="button" id="kf-comment-post" class="btn btn-primary">Post</button>
                </div>
              </div>
            </section>
            <section id="kf-activity" class="kf-activity" hidden aria-label="Activity timeline">
              <h3 class="kf-activity-title">Activity</h3>
              <ol id="kf-activity-list" class="kf-activity-list"></ol>
              <p id="kf-activity-empty" class="kf-activity-empty" hidden>No activity yet.</p>
            </section>
            <p id="kf-error" class="kanban-error" hidden></p>
            <div class="kanban-modal-actions">
              <button type="button" id="kf-cancel" class="btn">Cancel</button>
              <button type="button" id="kf-save-template" class="btn" hidden title="Save this card as a reusable template">Save as template</button>
              <button type="button" id="kf-archive" class="btn kanban-btn-danger" hidden>Archive</button>
              <button type="button" id="kf-restore" class="btn" hidden>Restore</button>
              <button type="submit" id="kf-save" class="btn btn-primary">Save</button>
            </div>
          </form>
        </div>
      </div>

      <div id="kanban-templates-modal" class="kanban-modal" hidden role="dialog" aria-label="Card templates">
        <div class="kanban-modal-inner">
          <h2>Card templates</h2>
          <p class="muted" id="kt-empty" hidden>No templates yet on this board. Open a card and click "Save as template" to create one.</p>
          <ul id="kt-list" class="kt-list"></ul>
          <div class="kanban-modal-actions">
            <button type="button" id="kt-close" class="btn">Close</button>
          </div>
        </div>
      </div>

      <div id="kanban-toast" class="kanban-toast" hidden></div>

      {/* JSON data island — server-rendered list of known group names for
          autocomplete. Safe: JSON.stringify escapes everything, and the
          client parses via textContent (not eval) when the type is JSON. */}
      <script type="application/json" id="kanban-known-groups">
        {JSON.stringify(knownGroups)}
      </script>
      {/* Current user identity — used by the comment UI to decide which
          rows show inline edit/delete buttons. Same safety story as above. */}
      <script type="application/json" id="kanban-current-user">
        {JSON.stringify({
          id: user.id,
          displayName: user.displayName,
          isAdmin: user.roles.includes('admin'),
          isStaff: user.roles.includes('admin') || user.roles.includes('staff'),
        })}
      </script>
      {/* Active-user directory for the assignee picker. Same safety story
          as the other JSON islands above. */}
      <script type="application/json" id="kanban-known-users">
        {JSON.stringify(knownUsers)}
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

  /* Card templates modal list (P5). */
  .kt-list {
    list-style: none; margin: 0; padding: 0;
    display: flex; flex-direction: column; gap: 6px;
    max-height: 320px; overflow-y: auto;
  }
  .kt-item {
    display: flex; align-items: center; gap: 8px;
    padding: 8px 10px; border: 1px solid rgba(128,128,128,0.25);
    border-radius: 6px;
  }
  .kt-item-name { font-weight: 500; flex: 1; }
  .kt-item-meta { font-size: 0.8em; opacity: 0.6; }
  .kt-item-col {
    font: inherit; padding: 4px 6px;
    border: 1px solid rgba(128,128,128,0.4); border-radius: 4px;
    background: transparent; color: inherit;
  }
  .kt-item-create { padding: 4px 10px; font-size: 0.85em; }
  .kt-item-del {
    background: none; border: none; color: inherit; cursor: pointer;
    font-size: 1em; opacity: 0.4; padding: 0 4px;
  }
  .kt-item:hover .kt-item-del,
  .kt-item:focus-within .kt-item-del { opacity: 0.8; }
  .kt-item-del:hover { color: #b91c1c; opacity: 1; }

  /* Saved-filter chips row above the filter bar (P4). */
  .kanban-saved-filters {
    display: flex; flex-wrap: wrap; gap: 6px; align-items: center;
    margin-top: 12px;
  }
  .kanban-saved-filters[hidden] { display: none; }
  .ksf-label {
    font-size: 0.78em; opacity: 0.6; text-transform: uppercase;
    letter-spacing: 0.06em; margin-right: 4px;
  }
  .ksf-chip {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 3px 10px; border-radius: 999px;
    border: 1px solid rgba(128,128,128,0.4); background: transparent;
    color: inherit; font: inherit; font-size: 0.85em; cursor: pointer;
  }
  .ksf-chip:hover { background: rgba(128,128,128,0.12); }
  .ksf-chip.ksf-chip-active {
    background: var(--brand-tint-weak, rgba(37,99,235,0.14));
    border-color: var(--brand-tint-strong, rgba(37,99,235,0.45));
  }
  .ksf-chip-name { white-space: nowrap; }
  .ksf-chip-scope {
    font-size: 0.75em; opacity: 0.55; font-style: italic;
  }
  .ksf-chip-del {
    background: none; border: none; cursor: pointer; color: inherit;
    font-size: 1em; padding: 0 2px; opacity: 0;
  }
  .ksf-chip:hover .ksf-chip-del,
  .ksf-chip:focus-within .ksf-chip-del { opacity: 0.6; }
  .ksf-chip-del:hover { opacity: 1; color: #b91c1c; }
  .kf-save-filter { padding: 6px 12px; font-size: 0.85em; }

  /* Filter bar above the board. */
  .kanban-filters {
    display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center;
    margin: 16px 0 0 0; padding: 8px 0;
  }
  .kf-search {
    flex: 1 1 280px; max-width: 480px;
    padding: 8px 12px; border-radius: 6px;
    border: 1px solid rgba(128,128,128,0.4); background: transparent; color: inherit;
    font: inherit;
  }
  .kf-filter-toggle {
    display: inline-flex; align-items: center; gap: 4px; cursor: pointer;
    padding: 4px 10px; border-radius: 999px;
    border: 1px solid rgba(128,128,128,0.4);
    font-size: 0.9em; user-select: none; margin: 0;
  }
  .kf-filter-toggle input { margin: 0; accent-color: #2563eb; }
  .kf-filter-toggle:has(input:checked) {
    background: rgba(37,99,235,0.15); border-color: rgba(37,99,235,0.5);
  }
  .kf-clear { padding: 6px 12px; font-size: 0.85em; }
  .kf-count { margin-left: auto; opacity: 0.7; font-size: 0.85em; }

  /* Hide non-matching cards during filtering without removing them from
     the DOM — keeps SortableJS state and avoids flicker. */
  .kanban-card.kf-hidden { display: none; }

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
  .kanban-col-title { font-weight: 600; font-size: 0.95em; flex: 1; cursor: text; }
  .kanban-col-title.kanban-col-title-edit {
    background: rgba(128,128,128,0.15); border-radius: 3px; padding: 0 4px;
  }
  .kanban-col-del {
    background: transparent; border: 1px solid transparent; border-radius: 4px;
    width: 22px; height: 22px; cursor: pointer; color: inherit; opacity: 0.4;
    font: inherit; line-height: 1;
  }
  .kanban-col-del:hover { opacity: 1; color: #b91c1c; border-color: rgba(185,28,28,0.4); }
  .kanban-col-add {
    background: transparent; border: 2px dashed rgba(128,128,128,0.3);
    align-items: center; justify-content: center;
    min-width: 160px; min-height: 80px;
  }
  .kanban-add-col-btn {
    background: transparent; border: none; cursor: pointer; color: inherit;
    font: inherit; opacity: 0.7; padding: 12px;
  }
  .kanban-add-col-btn:hover { opacity: 1; }
  .kanban-col-count {
    font-size: 0.8em; opacity: 0.7; padding: 2px 6px; border-radius: 999px;
    background: rgba(128,128,128,0.12); cursor: default;
  }
  .kanban-col-count.kanban-wip-exceeded {
    background: rgba(220,38,38,0.2); color: #b91c1c; opacity: 1; font-weight: 600;
  }
  .kanban-col-count.kanban-wip-editable { cursor: pointer; }
  .kanban-col-count.kanban-wip-editable:hover { background: rgba(128,128,128,0.25); }
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

  /* Card aging (P1): visual fade for cards that haven't been touched in
     a while. Done-column cards never age — they're done. The dashed
     border on old cards is the strongest cue without becoming alarming. */
  .kanban-card-aged-young { opacity: 0.85; }
  .kanban-card-aged-mid { opacity: 0.7; border-style: dashed; }
  .kanban-card-aged-old {
    opacity: 0.55;
    border-style: dashed;
    border-color: rgba(220, 38, 38, 0.4);
  }
  .kanban-card-aged-old::before {
    content: '⚠ stale';
    display: block;
    font-size: 0.7em;
    opacity: 0.7;
    margin-bottom: 4px;
    color: var(--status-err-text, #b91c1c);
  }
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

  /* Attachments in the card modal. */
  .kf-attachments { margin-top: 16px; border-top: 1px solid rgba(128,128,128,0.25); padding-top: 12px; }
  .kf-attachments[hidden] { display: none; }
  .kf-attachments-title { margin: 0 0 8px 0; font-size: 0.95em; font-weight: 600; }
  .kf-attachments-list { list-style: none; margin: 0 0 8px 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
  .kf-attachment-item {
    display: flex; align-items: center; gap: 8px;
    padding: 4px 8px; border: 1px solid rgba(128,128,128,0.2); border-radius: 4px;
    font-size: 0.9em;
  }
  .kf-attachment-link { color: inherit; text-decoration: none; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .kf-attachment-link:hover { text-decoration: underline; }
  .kf-attachment-meta { opacity: 0.6; font-size: 0.85em; flex-shrink: 0; }
  .kf-attachment-delete {
    background: none; border: none; color: inherit; cursor: pointer;
    font-size: 1em; opacity: 0.5; padding: 0 4px;
  }
  .kf-attachment-delete:hover { opacity: 1; color: #b91c1c; }
  .kf-attachments-add { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  .kf-attachments-add input[type=file] { font-size: 0.85em; }
  .kf-attachment-status { margin-left: auto; font-size: 0.85em; }

  /* Checklist in the card modal. */
  .kf-checklist { margin-top: 16px; border-top: 1px solid rgba(128,128,128,0.25); padding-top: 12px; }
  .kf-checklist[hidden] { display: none; }
  .kf-checklist-title { margin: 0 0 8px 0; font-size: 0.95em; font-weight: 600; }
  .kf-checklist-progress { font-weight: 400; opacity: 0.7; font-size: 0.9em; margin-left: 4px; }
  .kf-checklist-list { list-style: none; margin: 0 0 8px 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
  .kf-checklist-item {
    display: flex; align-items: flex-start; gap: 8px;
    padding: 4px 6px; border-radius: 4px; font-size: 0.9em;
  }
  .kf-checklist-item:hover { background: rgba(128,128,128,0.08); }
  .kf-checklist-item input[type=checkbox] { margin-top: 4px; flex-shrink: 0; cursor: pointer; }
  .kf-checklist-body { flex: 1; word-break: break-word; }
  .kf-checklist-item.kf-checklist-done .kf-checklist-body { text-decoration: line-through; opacity: 0.6; }
  .kf-checklist-delete {
    background: none; border: none; color: inherit; cursor: pointer;
    font-size: 1em; opacity: 0; padding: 0 4px;
  }
  .kf-checklist-item:hover .kf-checklist-delete,
  .kf-checklist-item:focus-within .kf-checklist-delete { opacity: 0.7; }
  .kf-checklist-delete:hover { opacity: 1; }
  .kf-checklist-add { display: flex; gap: 6px; }
  .kf-checklist-add input { flex: 1; }

  /* Comments thread in the card modal. */
  .kf-comments { margin-top: 16px; border-top: 1px solid rgba(128,128,128,0.25); padding-top: 12px; }
  .kf-comments[hidden] { display: none; }
  .kf-comments-title { margin: 0 0 8px 0; font-size: 0.95em; font-weight: 600; }
  .kf-comments-list {
    list-style: none; margin: 0 0 12px 0; padding: 0;
    display: flex; flex-direction: column; gap: 10px;
    max-height: 280px; overflow-y: auto;
  }
  .kf-comment {
    background: rgba(128,128,128,0.06);
    border: 1px solid rgba(128,128,128,0.2);
    border-radius: 6px;
    padding: 8px 10px;
    font-size: 0.9em;
    position: relative;
  }
  .kf-comment-head {
    display: flex; gap: 8px; align-items: baseline;
    font-size: 0.85em; margin-bottom: 4px;
  }
  .kf-comment-author { font-weight: 600; }
  .kf-comment-time { opacity: 0.6; }
  .kf-comment-edited { opacity: 0.6; font-style: italic; font-size: 0.85em; }
  .kf-comment-body p,
  .kf-comment-body ul,
  .kf-comment-body ol { margin: 0; padding: 0; }
  .kf-comment-body ul,
  .kf-comment-body ol { padding-left: 1.2em; }
  .kf-comment-body p + p { margin-top: 6px; }
  .kf-comment-body code {
    background: rgba(128,128,128,0.18); padding: 0 3px; border-radius: 3px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 0.95em;
  }
  .kf-comment-body a { color: inherit; text-decoration: underline; }
  .kf-comment-actions {
    display: flex; gap: 6px; margin-top: 6px;
    opacity: 0; transition: opacity 0.1s;
  }
  .kf-comment:hover .kf-comment-actions,
  .kf-comment:focus-within .kf-comment-actions { opacity: 1; }
  .kf-comment-action {
    background: transparent; border: none; padding: 0; cursor: pointer;
    color: inherit; font: inherit; font-size: 0.8em; opacity: 0.7;
    text-decoration: underline;
  }
  .kf-comment-action:hover { opacity: 1; }
  .kf-comment-edit-area {
    display: flex; flex-direction: column; gap: 6px; margin-top: 4px;
  }
  .kf-comment-edit-area textarea {
    width: 100%; box-sizing: border-box;
  }
  .kf-comment-edit-actions { display: flex; gap: 6px; justify-content: flex-end; }
  .kf-comments-empty { font-size: 0.85em; opacity: 0.6; font-style: italic; margin: 4px 0 12px; }
  .kf-comment-composer { display: flex; flex-direction: column; gap: 6px; }
  .kf-comment-composer textarea {
    width: 100%; box-sizing: border-box; font-family: inherit;
  }
  .kf-comment-composer-actions { display: flex; gap: 6px; justify-content: flex-end; }

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

  /* Side-by-side due date + time inputs in the modal. */
  .kf-due-row { display: flex; gap: 12px; margin-top: 12px; }
  .kf-due-date { flex: 2; margin: 0; }
  .kf-due-time { flex: 1; margin: 0; }

  /* Card cover color picker in the modal. */
  .kf-cover-row { display: flex; gap: 8px; align-items: end; margin-top: 12px; }
  .kf-cover-label { flex: 0 0 auto; margin: 0; font-size: 0.9em; }
  .kf-cover-label input { width: 60px; height: 32px; padding: 2px; cursor: pointer; }
  .kf-cover-clear { padding: 6px 10px; font-size: 0.85em; }

  /* Card cover stripe — thin top band when card.coverColor is set. */
  .kanban-card-cover {
    height: 6px; margin: -8px -10px 6px -10px;
    border-radius: 6px 6px 0 0;
  }

  /* Column color: swatch in header (staff editable) + accent on body. */
  .kanban-col-color {
    width: 14px; height: 14px; border-radius: 4px; padding: 0;
    border: 1px solid rgba(128,128,128,0.4); cursor: pointer;
    flex-shrink: 0;
  }
  .kanban-col[data-col-color] .kanban-col-body {
    border-top: 3px solid var(--col-accent, transparent);
    padding-top: 6px;
    margin-top: -1px;
  }

  /* Group/label chip — when a color is set, the chip background uses
     a tint derived inline from the hex via the renderer. Staff get a
     pointer cursor for the inline color picker. */
  .kanban-chip-editable { cursor: pointer; }
  .kanban-chip-color-input {
    width: 0; height: 0; opacity: 0; border: none; padding: 0;
    position: absolute;
  }

  /* Multi-select assignees control in the modal — same shape as groups. */
  .kf-assignees-field { display: flex; flex-direction: column; gap: 6px; margin-top: 12px; }
  .kf-assignees-label { font-size: 0.9em; }
  .kf-assignees-chips { display: flex; flex-wrap: wrap; gap: 4px; min-height: 18px; }
  .kf-assignee-chip {
    display: inline-flex; align-items: center; gap: 4px;
    background: rgba(56,189,248,0.18); padding: 1px 6px; border-radius: 999px;
    font-size: 0.85em;
  }
  .kf-assignee-remove {
    background: none; border: none; color: inherit; cursor: pointer;
    font: inherit; font-size: 1.1em; line-height: 1; padding: 0 2px; opacity: 0.7;
  }
  .kf-assignee-remove:hover { opacity: 1; }
  .kf-assignees-entry { display: flex; gap: 6px; }
  .kf-assignees-entry input { flex: 1; }
  .kanban-chip-assignee { background: rgba(56,189,248,0.18); }

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
  var startInput = document.getElementById('kf-start');
  var dueInput = document.getElementById('kf-due');
  var dueTimeInput = document.getElementById('kf-due-time');
  var coverInput = document.getElementById('kf-cover');
  var coverClearBtn = document.getElementById('kf-cover-clear');
  var notesInput = document.getElementById('kf-notes');
  // Tracks whether the user explicitly set a cover via the picker.
  // <input type=color> can't represent "no color"; we mirror that
  // semantic with a separate boolean and the Clear button.
  var coverSet = false;
  coverInput.addEventListener('input', function() { coverSet = true; });
  coverClearBtn.addEventListener('click', function() {
    coverSet = false;
    coverInput.value = '#000000';
  });
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
  var commentsSectionEl = document.getElementById('kf-comments');
  var commentsListEl = document.getElementById('kf-comments-list');
  var commentsEmptyEl = document.getElementById('kf-comments-empty');
  var commentInputEl = document.getElementById('kf-comment-input');
  var commentPostBtn = document.getElementById('kf-comment-post');
  var attachmentsSectionEl = document.getElementById('kf-attachments');
  var attachmentsListEl = document.getElementById('kf-attachments-list');
  var attachmentInputEl = document.getElementById('kf-attachment-input');
  var attachmentUploadBtn = document.getElementById('kf-attachment-upload');
  var attachmentStatusEl = document.getElementById('kf-attachment-status');
  var checklistSectionEl = document.getElementById('kf-checklist');
  var checklistListEl = document.getElementById('kf-checklist-list');
  var checklistInputEl = document.getElementById('kf-checklist-input');
  var checklistAddBtn = document.getElementById('kf-checklist-add-btn');
  var checklistProgressEl = document.getElementById('kf-checklist-progress');

  // Current user identity, parsed from a JSON island the server emits.
  // Used to gate inline edit/delete buttons. Falls back to a placeholder
  // if the island is missing (defensive — should always be present).
  var currentUser = { id: 0, displayName: null, isAdmin: false };
  try {
    var cuRaw = document.getElementById('kanban-current-user');
    if (cuRaw && cuRaw.textContent) {
      currentUser = JSON.parse(cuRaw.textContent) || currentUser;
    }
  } catch (_err) { /* keep default */ }

  // Per-column config (label, position, wipLimit). Indexed by column key.
  // Populated by snapshot/column_config_updated; defaults to empty so
  // boards that pre-date the seed migration just show plain counts.
  var columnConfig = new Map();

  // Per-group color directory for this board, indexed by group name
  // (case-insensitive key). Built from snapshot card data and updated
  // by group_color_updated broadcasts. Used to tint chips both in the
  // card preview and in the modal's selectedGroups list.
  var groupColors = new Map();
  function groupColorKey(name) { return String(name || '').toLowerCase(); }
  function setGroupColorLocal(name, color) {
    if (!name) return;
    if (color) groupColors.set(groupColorKey(name), color);
    else groupColors.delete(groupColorKey(name));
  }
  function getGroupColorLocal(name) {
    return groupColors.get(groupColorKey(name)) || null;
  }
  function ingestGroupsFromCard(card) {
    if (!card || !Array.isArray(card.groups)) return;
    card.groups.forEach(function(g) {
      if (g && typeof g === 'object' && g.color) {
        groupColors.set(groupColorKey(g.name), g.color);
      }
    });
  }

  // Active-user directory for the assignee picker.
  var knownUsers = [];
  try {
    var kuRaw = document.getElementById('kanban-known-users');
    if (kuRaw && kuRaw.textContent) knownUsers = JSON.parse(kuRaw.textContent) || [];
  } catch (_err) { knownUsers = []; }
  // Index for fast lookup by display key (lowercased name or email).
  function userKey(u) {
    return ((u.displayName || u.email || '') + ' <' + (u.email || '') + '>').toLowerCase();
  }
  var assigneesChipsEl = document.getElementById('kf-assignees-chips');
  var assigneesInputEl = document.getElementById('kf-assignees-input');
  var assigneesAddBtn = document.getElementById('kf-assignees-add');
  var assigneesDatalist = document.getElementById('kf-assignees-suggest');
  var selectedAssignees = []; // array of AssigneeDto

  function rebuildAssigneesDatalist() {
    while (assigneesDatalist.firstChild) assigneesDatalist.removeChild(assigneesDatalist.firstChild);
    var taken = new Set();
    selectedAssignees.forEach(function(a) { taken.add(a.userId); });
    knownUsers.forEach(function(u) {
      if (taken.has(u.userId)) return;
      var opt = document.createElement('option');
      // Datalist shows the value; we use "Display Name <email>" so users
      // can disambiguate two people with the same display name. Parsing
      // back happens in addAssigneeFromInput.
      opt.value = (u.displayName || u.email) + ' <' + u.email + '>';
      assigneesDatalist.appendChild(opt);
    });
  }

  function renderSelectedAssignees() {
    while (assigneesChipsEl.firstChild) assigneesChipsEl.removeChild(assigneesChipsEl.firstChild);
    selectedAssignees.forEach(function(a, idx) {
      var c = document.createElement('span');
      c.className = 'kanban-chip kf-assignee-chip';
      var txt = document.createElement('span');
      txt.textContent = a.displayName || a.email;
      var x = document.createElement('button');
      x.type = 'button';
      x.className = 'kf-assignee-remove';
      x.setAttribute('aria-label', 'Remove assignee ' + (a.displayName || a.email));
      x.textContent = '×';
      x.addEventListener('click', function() {
        selectedAssignees.splice(idx, 1);
        renderSelectedAssignees();
        rebuildAssigneesDatalist();
      });
      c.appendChild(txt);
      c.appendChild(x);
      assigneesChipsEl.appendChild(c);
    });
    rebuildAssigneesDatalist();
  }

  function findUserMatch(typed) {
    var t = typed.trim().toLowerCase();
    if (!t) return null;
    // Exact-email match wins.
    var byEmail = null, byDisplay = null, byEmailContains = null;
    for (var i = 0; i < knownUsers.length; i++) {
      var u = knownUsers[i];
      if ((u.email || '').toLowerCase() === t) return u;
      if (!byDisplay && (u.displayName || '').toLowerCase() === t) byDisplay = u;
      // Recognize the "Display <email>" shape from the datalist.
      var combo = ((u.displayName || u.email) + ' <' + u.email + '>').toLowerCase();
      if (combo === t) return u;
      if (!byEmailContains && (u.email || '').toLowerCase().indexOf(t) === 0) byEmailContains = u;
    }
    return byDisplay || byEmailContains;
  }

  function addAssigneeFromInput() {
    var v = assigneesInputEl.value;
    if (!v.trim()) return;
    var match = findUserMatch(v);
    if (!match) {
      showToast('No user matches "' + v + '" — try their email.', 3500);
      return;
    }
    if (selectedAssignees.some(function(a) { return a.userId === match.userId; })) {
      // Already selected — silently ignore.
    } else {
      selectedAssignees.push(match);
      renderSelectedAssignees();
    }
    assigneesInputEl.value = '';
    assigneesInputEl.focus();
  }

  assigneesAddBtn.addEventListener('click', addAssigneeFromInput);
  assigneesInputEl.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      addAssigneeFromInput();
    }
  });
  assigneesInputEl.addEventListener('change', function() {
    if (assigneesInputEl.value.trim()) addAssigneeFromInput();
  });

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
      // Tint chip with this group's color if one is set.
      var color = getGroupColorLocal(g);
      if (color) {
        c.style.background = color + '33';
        c.style.border = '1px solid ' + color + '66';
      }
      var txt = document.createElement('span');
      txt.textContent = g;
      // Staff: clicking the label opens an inline color picker that
      // sets the per-board color for this group. Native <input type=color>
      // is hidden offscreen and triggered programmatically — feels like
      // clicking the chip directly opens a color picker.
      if (currentUser.isStaff) {
        c.classList.add('kanban-chip-editable');
        c.title = 'Click to set color for label "' + g + '"';
        var picker = document.createElement('input');
        picker.type = 'color';
        picker.className = 'kanban-chip-color-input';
        picker.value = color || '#94a3b8';
        picker.addEventListener('change', function() {
          var cmid = nextClientMsgId();
          pendingClientMsgs.set(cmid, { type: 'set_group_color', name: g });
          send({ type: 'set_group_color', clientMsgId: cmid, name: g, color: picker.value });
        });
        c.appendChild(picker);
        txt.addEventListener('click', function(ev) {
          ev.stopPropagation();
          picker.click();
        });
      }
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

  // ── Search / filter ─────────────────────────────────────────────────
  // Pure client-side filtering over the in-memory cards map. Filters
  // run against every card after each render or upsert; non-matching
  // cards get a kf-hidden class (display: none) rather than being
  // removed, so SortableJS state stays intact and re-applying filters
  // is a fast classList toggle.
  var filterState = { query: '', mine: false, overdue: false, hasDue: false };
  var searchInputEl = document.getElementById('kf-search');
  var mineToggleEl = document.getElementById('kf-mine');
  var overdueToggleEl = document.getElementById('kf-overdue');
  var hasDueToggleEl = document.getElementById('kf-has-due');
  var clearBtnEl = document.getElementById('kf-clear');
  var countEl = document.getElementById('kf-count');

  function isFilterActive() {
    return !!(filterState.query || filterState.mine || filterState.overdue || filterState.hasDue);
  }

  function todayIso() {
    // Use the user's local date — we render due dates as YYYY-MM-DD without
    // timezone, so "overdue" needs the local-day boundary, not UTC.
    var d = new Date();
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
  }

  // P3 — search operator parser. Tokens like assigned:foo / label:bar /
  // column:done / has:due / is:overdue / is:mine / is:archived become
  // AND-combined predicates. Bare words fall back to substring match
  // across title/notes/groups/assignees/assigned. Tiny regex-shaped
  // parser, no real grammar — enough for the UX without invariants
  // beyond "every term must match."
  var QUERY_OP_RE = /\b(assigned|label|group|column|has|is):([a-zA-Z0-9._@-]+)/g;

  function parseQuery(raw) {
    var operators = [];
    var bareTerms = [];
    if (!raw) return { operators: operators, bareTerms: bareTerms };
    var working = String(raw).replace(QUERY_OP_RE, function(_match, key, value) {
      operators.push({ key: key, value: String(value).toLowerCase() });
      return ' ';
    });
    working.split(/\s+/).forEach(function(w) {
      var t = w.trim();
      if (t) bareTerms.push(t.toLowerCase());
    });
    return { operators: operators, bareTerms: bareTerms };
  }

  function groupNamesOf(card) {
    if (!Array.isArray(card.groups)) return [];
    return card.groups.map(function(g) {
      return (g && typeof g === 'object') ? g.name : g;
    });
  }

  function predicateMatches(card, op, today) {
    var v = op.value;
    var i, a, local, dn;
    switch (op.key) {
      case 'assigned':
        if (Array.isArray(card.assignees)) {
          for (i = 0; i < card.assignees.length; i++) {
            a = card.assignees[i];
            local = ((a.email || '').split('@')[0] || '').toLowerCase();
            if (local.indexOf(v) === 0) return true;
            dn = (a.displayName || '').toLowerCase();
            if (dn.split(/\s+/).some(function(w) { return w.indexOf(v) === 0; })) return true;
          }
        }
        if (card.assigned && card.assigned.toLowerCase().indexOf(v) >= 0) return true;
        return false;
      case 'label':
      case 'group':
        return groupNamesOf(card).some(function(n) {
          return n.toLowerCase().indexOf(v) >= 0;
        });
      case 'column':
        return String(card.column || '').toLowerCase().indexOf(v) >= 0;
      case 'has':
        if (v === 'due') return !!card.dueDate;
        if (v === 'start') return !!card.startDate;
        if (v === 'cover') return !!card.coverColor;
        if (v === 'assignee') return Array.isArray(card.assignees) && card.assignees.length > 0;
        if (v === 'label' || v === 'group') return groupNamesOf(card).length > 0;
        if (v === 'notes') return !!(card.notes && card.notes.length > 0);
        return false;
      case 'is':
        if (v === 'archived') return !!card.archivedAt;
        if (v === 'mine') {
          return Array.isArray(card.assignees) &&
            card.assignees.some(function(a) { return a.userId === currentUser.id; });
        }
        if (v === 'overdue') {
          return !!(card.dueDate && card.dueDate < today && card.column !== 'done');
        }
        if (v === 'done') return card.column === 'done';
        return false;
    }
    return false;
  }

  function cardMatches(card) {
    if (filterState.query) {
      var parsed = parseQuery(filterState.query);
      var today = todayIso();
      // Each operator is an AND-required predicate.
      for (var i = 0; i < parsed.operators.length; i++) {
        if (!predicateMatches(card, parsed.operators[i], today)) return false;
      }
      // Bare-term substring match against the card's haystack.
      if (parsed.bareTerms.length > 0) {
        var hay = '';
        hay += (card.title || '') + ' ';
        hay += (card.notes || '') + ' ';
        hay += (card.assigned || '') + ' ';
        hay += groupNamesOf(card).join(' ') + ' ';
        if (Array.isArray(card.assignees)) {
          hay += card.assignees.map(function(a) {
            return (a.displayName || '') + ' ' + (a.email || '');
          }).join(' ');
        }
        hay = hay.toLowerCase();
        for (var j = 0; j < parsed.bareTerms.length; j++) {
          if (hay.indexOf(parsed.bareTerms[j]) < 0) return false;
        }
      }
    }
    if (filterState.mine) {
      var mine = false;
      if (Array.isArray(card.assignees)) {
        for (var k = 0; k < card.assignees.length; k++) {
          if (card.assignees[k].userId === currentUser.id) { mine = true; break; }
        }
      }
      if (!mine) return false;
    }
    if (filterState.hasDue && !card.dueDate) return false;
    if (filterState.overdue) {
      if (!card.dueDate) return false;
      // Done-column cards aren't really overdue even if past their date.
      if (card.column === 'done') return false;
      if (card.dueDate >= todayIso()) return false;
    }
    return true;
  }

  function applyFilters() {
    var visible = 0;
    var total = 0;
    cards.forEach(function(card) {
      total++;
      var node = document.querySelector('[data-card-id="' + card.id + '"]');
      if (!node) return;
      if (cardMatches(card)) {
        node.classList.remove('kf-hidden');
        visible++;
      } else {
        node.classList.add('kf-hidden');
      }
    });
    if (isFilterActive()) {
      countEl.textContent = visible + ' of ' + total + ' visible';
      clearBtnEl.hidden = false;
    } else {
      countEl.textContent = '';
      clearBtnEl.hidden = true;
    }
    // Save button visible whenever the text query is non-empty (toggles
    // alone don't get saved — they're stateful UI controls, not queries).
    if (saveFilterBtn) {
      saveFilterBtn.hidden = !filterState.query;
    }
    // Re-render saved-filter chips so the active highlight tracks the
    // current query — cheap because rendering is local DOM only.
    if (savedFilters.length > 0) renderSavedFilters();
  }

  function setFilter(partial) {
    Object.assign(filterState, partial);
    applyFilters();
  }

  // ── Saved filters (P4) ──────────────────────────────────────────────
  // Per-user named queries fetched from /api/filters?board=<slug>. Click
  // a chip to apply; ★ Save adds the current query as a named filter.
  // Delete via × on hover. The "active" chip is the one whose query is
  // an exact match for the current filterState.query.
  var savedFiltersBarEl = document.getElementById('kanban-saved-filters');
  var saveFilterBtn = document.getElementById('kf-save-filter');
  var savedFilters = [];
  var boardSlugForFilters = boardEl.getAttribute('data-board-slug') || '';

  function renderSavedFilters() {
    while (savedFiltersBarEl.firstChild) savedFiltersBarEl.removeChild(savedFiltersBarEl.firstChild);
    if (savedFilters.length === 0) {
      savedFiltersBarEl.hidden = true;
      return;
    }
    savedFiltersBarEl.hidden = false;
    var label = document.createElement('span');
    label.className = 'ksf-label';
    label.textContent = 'Saved:';
    savedFiltersBarEl.appendChild(label);
    savedFilters.forEach(function(f) {
      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'ksf-chip';
      if (filterState.query && filterState.query === f.query) {
        chip.classList.add('ksf-chip-active');
      }
      chip.title = f.query;
      var n = document.createElement('span');
      n.className = 'ksf-chip-name';
      n.textContent = f.name;
      chip.appendChild(n);
      if (f.boardId === null) {
        // Board-agnostic filters get a tiny "·all" marker so the user
        // knows clicking it isn't board-specific.
        var scope = document.createElement('span');
        scope.className = 'ksf-chip-scope';
        scope.textContent = 'all boards';
        chip.appendChild(scope);
      }
      chip.addEventListener('click', function() {
        searchInputEl.value = f.query;
        setFilter({ query: f.query });
        renderSavedFilters();
      });
      var del = document.createElement('button');
      del.type = 'button';
      del.className = 'ksf-chip-del';
      del.textContent = '×';
      del.setAttribute('aria-label', 'Delete saved filter ' + f.name);
      del.addEventListener('click', function(ev) {
        ev.stopPropagation();
        if (!confirm('Delete saved filter "' + f.name + '"?')) return;
        fetch('/api/filters/' + f.id, { method: 'DELETE', credentials: 'same-origin' })
          .then(function(r) { return r.ok ? r.json() : Promise.reject(r); })
          .then(function() {
            savedFilters = savedFilters.filter(function(x) { return x.id !== f.id; });
            renderSavedFilters();
          })
          .catch(function() { showToast('Could not delete filter.', 4000); });
      });
      chip.appendChild(del);
      savedFiltersBarEl.appendChild(chip);
    });
  }

  function refreshSavedFilters() {
    fetch('/api/filters?board=' + encodeURIComponent(boardSlugForFilters), {
      credentials: 'same-origin',
    })
      .then(function(r) { return r.ok ? r.json() : { items: [] }; })
      .then(function(j) {
        savedFilters = (j.items || []).slice();
        renderSavedFilters();
      })
      .catch(function() { /* silent — chip row stays empty */ });
  }

  saveFilterBtn.addEventListener('click', function() {
    var query = filterState.query.trim();
    if (!query) {
      showToast('Type a query first, then save it.', 3500);
      return;
    }
    var name = prompt('Name this filter:', '');
    if (name === null) return;
    name = name.trim();
    if (!name) return;
    saveFilterBtn.disabled = true;
    fetch('/api/filters', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name, query: query, boardSlug: boardSlugForFilters }),
    })
      .then(function(r) {
        if (r.status === 409) throw new Error('duplicate');
        return r.ok ? r.json() : Promise.reject(r);
      })
      .then(function(j) {
        if (j.filter) savedFilters.push(j.filter);
        renderSavedFilters();
        showToast('Saved filter "' + name + '".', 3000);
      })
      .catch(function(err) {
        if (err && err.message === 'duplicate') {
          showToast('A filter with that name already exists.', 4000);
        } else {
          showToast('Could not save filter.', 4000);
        }
      })
      .then(function() { saveFilterBtn.disabled = false; });
  });

  refreshSavedFilters();

  // ── Card templates (P5) ─────────────────────────────────────────────
  // List populated via list_templates WS; modified via templates_*
  // broadcasts. The Templates button in the head opens a modal showing
  // every template on this board with a per-row "Create in <column>"
  // dropdown + button. The card modal gains a "Save as template" button
  // that snapshots the currently-edited card's fields.
  var templates = [];
  var templatesBtn = document.getElementById('kanban-templates-btn');
  var templatesModalEl = document.getElementById('kanban-templates-modal');
  var templatesListEl = document.getElementById('kt-list');
  var templatesEmptyEl = document.getElementById('kt-empty');
  var templatesCloseBtn = document.getElementById('kt-close');
  var saveTemplateBtn = document.getElementById('kf-save-template');

  function renderTemplatesList() {
    while (templatesListEl.firstChild) templatesListEl.removeChild(templatesListEl.firstChild);
    if (templates.length === 0) {
      templatesEmptyEl.hidden = false;
      return;
    }
    templatesEmptyEl.hidden = true;
    var sorted = templates.slice().sort(function(a, b) {
      return (a.name || '').localeCompare(b.name || '');
    });
    sorted.forEach(function(t) {
      var li = document.createElement('li');
      li.className = 'kt-item';
      var n = document.createElement('span');
      n.className = 'kt-item-name';
      n.textContent = t.name;
      li.appendChild(n);
      // Per-row column picker — defaults to the first column.
      var sel = document.createElement('select');
      sel.className = 'kt-item-col';
      var ordered = Array.from(columnConfig.values()).sort(function(a, b) {
        return a.position - b.position;
      });
      if (ordered.length === 0) {
        // Fall back to whatever data-col attributes exist on the board.
        boardEl.querySelectorAll('[data-col]').forEach(function(s) {
          var key = s.getAttribute('data-col');
          if (!key) return;
          var opt = document.createElement('option');
          opt.value = key;
          opt.textContent = key;
          sel.appendChild(opt);
        });
      } else {
        ordered.forEach(function(col) {
          var opt = document.createElement('option');
          opt.value = col.columnName;
          opt.textContent = col.label;
          sel.appendChild(opt);
        });
      }
      li.appendChild(sel);
      var go = document.createElement('button');
      go.type = 'button';
      go.className = 'btn btn-primary kt-item-create';
      go.textContent = 'Create';
      go.addEventListener('click', function() {
        go.disabled = true;
        var cmid = nextClientMsgId();
        pendingClientMsgs.set(cmid, { type: 'create_from_template', templateId: t.id });
        send({
          type: 'create_from_template',
          clientMsgId: cmid,
          templateId: t.id,
          column: sel.value,
        });
        // Close the modal optimistically — the new card_created broadcast
        // will appear on the board behind it.
        templatesModalEl.hidden = true;
      });
      li.appendChild(go);
      // Author or admin can delete.
      if ((t.createdByUserId !== null && t.createdByUserId === currentUser.id) || currentUser.isAdmin) {
        var del = document.createElement('button');
        del.type = 'button';
        del.className = 'kt-item-del';
        del.setAttribute('aria-label', 'Delete template ' + t.name);
        del.textContent = '×';
        del.addEventListener('click', function() {
          if (!confirm('Delete template "' + t.name + '"?')) return;
          var cmid = nextClientMsgId();
          pendingClientMsgs.set(cmid, { type: 'delete_template', id: t.id });
          send({ type: 'delete_template', clientMsgId: cmid, id: t.id });
        });
        li.appendChild(del);
      }
      templatesListEl.appendChild(li);
    });
  }

  function refreshTemplates() {
    var cmid = nextClientMsgId();
    pendingClientMsgs.set(cmid, { type: 'list_templates' });
    send({ type: 'list_templates', clientMsgId: cmid });
  }

  templatesBtn.addEventListener('click', function() {
    refreshTemplates();
    templatesModalEl.hidden = false;
  });
  templatesCloseBtn.addEventListener('click', function() {
    templatesModalEl.hidden = true;
  });
  templatesModalEl.addEventListener('click', function(e) {
    if (e.target === templatesModalEl) templatesModalEl.hidden = true;
  });

  saveTemplateBtn.addEventListener('click', function() {
    if (editingCardId === null) return;
    var card = editingArchived ? archivedCards.get(editingCardId) : cards.get(editingCardId);
    if (!card) return;
    var name = prompt('Template name?', card.title || '');
    if (name === null) return;
    name = name.trim();
    if (!name) return;
    // Snapshot the user-editable fields — same shape the create handler
    // accepts. Dates are absolute here (no offsets) to keep v1 simple;
    // future "rolling templates" can store offsets.
    var payload = {
      title: card.title,
      notes: card.notes,
      groups: groupNamesOf(card),
      assigneeUserIds: Array.isArray(card.assignees)
        ? card.assignees.map(function(a) { return a.userId; })
        : [],
      coverColor: card.coverColor || null,
      // Dates intentionally omitted — usually templates are date-relative;
      // no UX yet to enter offsets, so don't carry literal dates that
      // would be wrong when applied later.
    };
    var cmid = nextClientMsgId();
    pendingClientMsgs.set(cmid, { type: 'save_template', name: name });
    send({
      type: 'save_template',
      clientMsgId: cmid,
      name: name,
      payload: payload,
    });
    showToast('Template saved as "' + name + '".', 3000);
  });

  searchInputEl.addEventListener('input', function() {
    setFilter({ query: searchInputEl.value.trim() });
  });
  mineToggleEl.addEventListener('change', function() {
    setFilter({ mine: !!mineToggleEl.checked });
  });
  overdueToggleEl.addEventListener('change', function() {
    setFilter({ overdue: !!overdueToggleEl.checked });
  });
  hasDueToggleEl.addEventListener('change', function() {
    setFilter({ hasDue: !!hasDueToggleEl.checked });
  });
  clearBtnEl.addEventListener('click', function() {
    searchInputEl.value = '';
    mineToggleEl.checked = false;
    overdueToggleEl.checked = false;
    hasDueToggleEl.checked = false;
    setFilter({ query: '', mine: false, overdue: false, hasDue: false });
    searchInputEl.focus();
  });

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
    // Re-apply filters whenever the DOM is rebuilt — newly-rendered nodes
    // would otherwise show even if a filter is active.
    applyFilters();
    renderColumnHeaders();
  }

  function countActiveCardsByColumn() {
    var counts = {};
    cards.forEach(function(c) {
      counts[c.column] = (counts[c.column] || 0) + 1;
    });
    return counts;
  }

  function renderColumnHeaders() {
    var counts = countActiveCardsByColumn();
    var nodes = boardEl.querySelectorAll('[data-col-count]');
    for (var i = 0; i < nodes.length; i++) {
      var col = nodes[i].getAttribute('data-col-count');
      var n = counts[col] || 0;
      var cfg = columnConfig.get(col);
      var limit = cfg && typeof cfg.wipLimit === 'number' ? cfg.wipLimit : null;
      // Reset class + label each render — cheaper and simpler than tracking.
      nodes[i].className = 'kanban-col-count';
      if (limit !== null) {
        nodes[i].textContent = n + ' / ' + limit;
        if (n > limit) nodes[i].classList.add('kanban-wip-exceeded');
      } else {
        nodes[i].textContent = String(n);
      }
      nodes[i].title = limit !== null
        ? 'WIP limit ' + limit + (currentUser.isStaff ? ' — click to change' : '')
        : (currentUser.isStaff ? 'Click to set WIP limit' : '');
      if (currentUser.isStaff) nodes[i].classList.add('kanban-wip-editable');
    }
  }

  // Staff click on a column count → prompt for new WIP limit. Empty/0
  // clears the limit. UX is intentionally minimal for v1.
  boardEl.addEventListener('click', function(e) {
    var t = e.target;
    if (!t || !t.matches || !t.matches('.kanban-col-count.kanban-wip-editable')) return;
    if (!currentUser.isStaff) return;
    var col = t.getAttribute('data-col-count');
    var current = columnConfig.get(col);
    var prev = current && current.wipLimit ? String(current.wipLimit) : '';
    var entered = prompt('WIP limit for this column? (blank to clear)', prev);
    if (entered === null) return;
    var trimmed = entered.trim();
    var newLimit = trimmed === '' ? null : Math.floor(Number(trimmed));
    if (newLimit !== null && (!Number.isFinite(newLimit) || newLimit < 1)) {
      showToast('WIP limit must be a positive integer or blank.', 4000);
      return;
    }
    var cmid = nextClientMsgId();
    pendingClientMsgs.set(cmid, { type: 'set_wip_limit', column: col });
    send({ type: 'set_wip_limit', clientMsgId: cmid, column: col, wipLimit: newLimit });
  });

  // ── Column management (S12) ─────────────────────────────────────────
  // Staff rename a column by clicking its title (becomes contenteditable);
  // deletes via × in the header (only succeeds if the column has no cards);
  // creates a new column via the "+ Add column" pseudo-section at the
  // right edge of the board.

  function rebuildBoardStructure() {
    // Sort current columns by position, then re-create section nodes to
    // match. Card bodies start empty — renderAll() refills them.
    var ordered = Array.from(columnConfig.values()).sort(function(a, b) {
      return a.position - b.position;
    });
    // Save the "Add column" sentinel if present so we can append it after
    // rebuilding the column sections.
    var addSection = document.getElementById('kanban-col-add');
    while (boardEl.firstChild) boardEl.removeChild(boardEl.firstChild);
    ordered.forEach(function(col) {
      boardEl.appendChild(buildColumnSection(col));
    });
    if (addSection) boardEl.appendChild(addSection);
    // Re-bind drag-and-drop on every column body, and re-bind add-card
    // handlers; the previous nodes were detached.
    setupSortable();
    boardEl.querySelectorAll('.kanban-add').forEach(function(btn) {
      btn.addEventListener('click', function() {
        openCreateModal(btn.getAttribute('data-add-col'));
      });
    });
  }

  function buildColumnSection(col) {
    var sec = document.createElement('section');
    sec.className = 'kanban-col';
    sec.setAttribute('data-col', col.columnName);
    if (col.color) {
      sec.setAttribute('data-col-color', col.color);
      sec.style.setProperty('--col-accent', col.color);
    }

    var head = document.createElement('header');
    head.className = 'kanban-col-head';

    var title = document.createElement('span');
    title.className = 'kanban-col-title';
    title.setAttribute('data-col-title', col.columnName);
    title.textContent = col.label;
    head.appendChild(title);

    var count = document.createElement('span');
    count.className = 'kanban-col-count';
    count.setAttribute('data-col-count', col.columnName);
    count.setAttribute('aria-label', 'Card count');
    head.appendChild(count);

    if (currentUser.isStaff) {
      var picker = document.createElement('input');
      picker.type = 'color';
      picker.className = 'kanban-col-color';
      picker.setAttribute('data-col-color-input', col.columnName);
      picker.value = col.color || '#94a3b8';
      picker.title = 'Set column color';
      picker.setAttribute('aria-label', 'Color for column ' + col.label);
      head.appendChild(picker);

      var del = document.createElement('button');
      del.className = 'kanban-col-del';
      del.type = 'button';
      del.setAttribute('data-col-del', col.columnName);
      del.setAttribute('aria-label', 'Delete column ' + col.label);
      del.title = 'Delete column (must be empty)';
      del.textContent = '×';
      head.appendChild(del);
    }

    var add = document.createElement('button');
    add.className = 'kanban-add';
    add.setAttribute('data-add-col', col.columnName);
    add.type = 'button';
    add.setAttribute('aria-label', 'Add card to ' + col.label);
    add.textContent = '+';
    head.appendChild(add);

    sec.appendChild(head);

    var body = document.createElement('div');
    body.className = 'kanban-col-body';
    body.setAttribute('data-col-body', col.columnName);
    sec.appendChild(body);

    return sec;
  }

  // Inline rename: dblclick on the title turns it editable; Enter or blur
  // commits, Escape cancels.
  boardEl.addEventListener('dblclick', function(e) {
    var t = e.target;
    if (!t || !t.matches || !t.matches('.kanban-col-title')) return;
    if (!currentUser.isStaff) return;
    var col = t.getAttribute('data-col-title');
    var current = columnConfig.get(col);
    var original = current ? current.label : t.textContent;
    t.contentEditable = 'true';
    t.classList.add('kanban-col-title-edit');
    t.focus();
    var range = document.createRange();
    range.selectNodeContents(t);
    var sel = window.getSelection();
    if (sel) { sel.removeAllRanges(); sel.addRange(range); }
    var done = false;
    function commit() {
      if (done) return; done = true;
      t.contentEditable = 'false';
      t.classList.remove('kanban-col-title-edit');
      var newLabel = (t.textContent || '').trim();
      if (!newLabel || newLabel === original) {
        t.textContent = original;
        return;
      }
      var cmid = nextClientMsgId();
      pendingClientMsgs.set(cmid, { type: 'rename_column', column: col });
      send({ type: 'rename_column', clientMsgId: cmid, column: col, label: newLabel });
    }
    function cancel() {
      if (done) return; done = true;
      t.contentEditable = 'false';
      t.classList.remove('kanban-col-title-edit');
      t.textContent = original;
    }
    t.addEventListener('blur', commit, { once: true });
    t.addEventListener('keydown', function(ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); commit(); t.blur(); }
      else if (ev.key === 'Escape') { ev.preventDefault(); cancel(); t.blur(); }
    });
  });

  // Column color picker (staff). Native <input type=color> fires 'change'
  // when the popover closes, so we don't bombard the server while the
  // user is dragging the swatch.
  boardEl.addEventListener('change', function(e) {
    var t = e.target;
    if (!t || !t.matches || !t.matches('.kanban-col-color')) return;
    if (!currentUser.isStaff) return;
    var col = t.getAttribute('data-col-color-input');
    var newColor = t.value;
    var cmid = nextClientMsgId();
    pendingClientMsgs.set(cmid, { type: 'set_column_color', column: col });
    send({ type: 'set_column_color', clientMsgId: cmid, column: col, color: newColor });
  });

  // Delete column (×).
  boardEl.addEventListener('click', function(e) {
    var t = e.target;
    if (!t || !t.matches || !t.matches('.kanban-col-del')) return;
    if (!currentUser.isStaff) return;
    var col = t.getAttribute('data-col-del');
    var cfg = columnConfig.get(col);
    var label = cfg ? cfg.label : col;
    if (!confirm('Delete column "' + label + '"? This requires the column to be empty.')) return;
    var cmid = nextClientMsgId();
    pendingClientMsgs.set(cmid, { type: 'delete_column', column: col });
    send({ type: 'delete_column', clientMsgId: cmid, column: col });
  });

  // "+ Add column" button.
  var addColBtn = document.getElementById('kanban-add-col-btn');
  if (addColBtn) {
    addColBtn.addEventListener('click', function() {
      var label = prompt('New column name?');
      if (label === null) return;
      label = label.trim();
      if (!label) return;
      // Derive a key from the label client-side; the server normalizes
      // and may collide-merge with an existing column.
      var key = label.toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
      if (!key) { showToast('Could not derive a column key from that name.', 4000); return; }
      var cmid = nextClientMsgId();
      pendingClientMsgs.set(cmid, { type: 'add_column', key: key });
      send({ type: 'add_column', clientMsgId: cmid, key: key, label: label });
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
    applyFilters();
  }

  function removeCardNode(id) {
    cards.delete(id);
    var existing = document.querySelector('[data-card-id="' + id + '"]');
    if (existing) existing.parentNode.removeChild(existing);
  }

  // Build a card DOM node. Uses textContent throughout — card content is
  // user-supplied and must NEVER be concatenated into an HTML string.
  // P1 — card aging. Returns a CSS class (or '') based on how long since
  // the card was last touched. Done-column cards never age (they're done).
  function ageClass(card) {
    if (!card || !card.updatedAt) return '';
    if (card.column === 'done') return '';
    var s = String(card.updatedAt);
    if (s.indexOf('T') < 0 && s.indexOf(' ') > 0) s = s.replace(' ', 'T') + 'Z';
    var t = new Date(s).getTime();
    if (isNaN(t)) return '';
    var days = Math.floor((Date.now() - t) / 86400000);
    if (days >= 60) return 'kanban-card-aged-old';
    if (days >= 30) return 'kanban-card-aged-mid';
    if (days >= 14) return 'kanban-card-aged-young';
    return '';
  }

  function renderCardNode(card) {
    var el = document.createElement('div');
    el.className = 'kanban-card';
    var ac = ageClass(card);
    if (ac) el.classList.add(ac);
    el.setAttribute('data-card-id', String(card.id));
    el.setAttribute('data-version', String(card.version));

    if (card.coverColor) {
      var cover = document.createElement('div');
      cover.className = 'kanban-card-cover';
      cover.style.background = card.coverColor;
      el.appendChild(cover);
    }

    var titleEl = document.createElement('div');
    titleEl.className = 'kanban-card-title';
    titleEl.textContent = card.title;
    el.appendChild(titleEl);

    var meta = document.createElement('div');
    meta.className = 'kanban-card-meta';
    if (Array.isArray(card.groups)) {
      card.groups.forEach(function(g) {
        // Groups are now { name, color | null }; older snapshots may
        // still send raw strings — handle both for forward compat.
        var name = (g && typeof g === 'object') ? g.name : g;
        var color = (g && typeof g === 'object') ? g.color : null;
        var ch = chip(name);
        if (color) {
          ch.style.background = color + '33';
          ch.style.border = '1px solid ' + color + '66';
        }
        meta.appendChild(ch);
      });
    }
    if (Array.isArray(card.assignees)) {
      card.assignees.forEach(function(a) {
        var label = '@ ' + (a.displayName || a.email);
        var ch = chip(label);
        ch.classList.add('kanban-chip-assignee');
        ch.title = a.email;
        meta.appendChild(ch);
      });
    }
    if (card.assigned) meta.appendChild(chip('@ ' + card.assigned));
    if (card.startDate) meta.appendChild(chip('Start ' + card.startDate));
    if (card.dueDate) {
      var dueLabel = 'Due ' + card.dueDate;
      if (card.dueTime) dueLabel += ' ' + card.dueTime;
      meta.appendChild(chip(dueLabel));
    }
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

  // ── Attachments ─────────────────────────────────────────────────────
  // Attachments live outside the WebSocket flow — they go through HTTP
  // routes (POST upload, GET stream, POST delete). We refetch the list on
  // every modal open and after each mutation rather than bolting onto the
  // realtime broadcast layer; uploads are infrequent enough that the UX
  // cost (no live cross-user sync of attachments) is negligible.
  var attachmentsByCardId = 0;
  var attachmentList = [];

  function formatBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function renderAttachments() {
    while (attachmentsListEl.firstChild) attachmentsListEl.removeChild(attachmentsListEl.firstChild);
    if (attachmentList.length === 0) {
      var empty = document.createElement('li');
      empty.className = 'muted';
      empty.style.fontStyle = 'italic';
      empty.style.fontSize = '0.85em';
      empty.textContent = 'No attachments yet.';
      attachmentsListEl.appendChild(empty);
      return;
    }
    attachmentList.forEach(function(a) {
      var li = document.createElement('li');
      li.className = 'kf-attachment-item';
      var link = document.createElement('a');
      link.className = 'kf-attachment-link';
      link.href = '/kanban/attachment/' + a.id;
      link.textContent = a.originalName;
      link.title = a.originalName;
      link.target = '_blank';
      link.rel = 'noopener';
      var meta = document.createElement('span');
      meta.className = 'kf-attachment-meta';
      meta.textContent = formatBytes(a.sizeBytes);
      var del = document.createElement('button');
      del.type = 'button';
      del.className = 'kf-attachment-delete';
      del.textContent = '×';
      del.setAttribute('aria-label', 'Delete attachment ' + a.originalName);
      del.addEventListener('click', function() {
        if (!confirm('Delete this attachment? This cannot be undone.')) return;
        fetch('/kanban/attachment/' + a.id + '/delete', {
          method: 'POST',
          credentials: 'same-origin',
        })
          .then(function(r) { return r.ok ? r.json() : Promise.reject(r); })
          .then(function() {
            attachmentList = attachmentList.filter(function(x) { return x.id !== a.id; });
            renderAttachments();
          })
          .catch(function() { showToast('Could not delete attachment.', 4000); });
      });
      li.appendChild(link);
      li.appendChild(meta);
      li.appendChild(del);
      attachmentsListEl.appendChild(li);
    });
  }

  function refreshAttachments(cardId) {
    attachmentsByCardId = cardId;
    attachmentList = [];
    renderAttachments();
    fetch('/kanban/c/' + cardId + '/attachments', { credentials: 'same-origin' })
      .then(function(r) { return r.ok ? r.json() : { items: [] }; })
      .then(function(j) {
        if (attachmentsByCardId !== cardId) return; // stale
        attachmentList = (j.items || []).slice();
        renderAttachments();
      })
      .catch(function() { /* leave empty */ });
  }

  attachmentUploadBtn.addEventListener('click', function() {
    if (!attachmentsByCardId) return;
    var f = attachmentInputEl.files && attachmentInputEl.files[0];
    if (!f) { showToast('Pick a file first.', 3000); return; }
    var fd = new FormData();
    fd.append('file', f);
    attachmentUploadBtn.disabled = true;
    attachmentStatusEl.textContent = 'Uploading…';
    fetch('/kanban/c/' + attachmentsByCardId + '/attachments', {
      method: 'POST',
      credentials: 'same-origin',
      body: fd,
    })
      .then(function(r) {
        if (r.status === 413) throw new Error('too-large');
        return r.ok ? r.json() : Promise.reject(r);
      })
      .then(function(j) {
        if (j.attachment) attachmentList.push(j.attachment);
        renderAttachments();
        attachmentInputEl.value = '';
        attachmentStatusEl.textContent = 'Uploaded.';
        setTimeout(function() { attachmentStatusEl.textContent = ''; }, 2500);
      })
      .catch(function(err) {
        attachmentStatusEl.textContent = '';
        if (err && err.message === 'too-large') {
          showToast('File too large (max 25 MB).', 5000);
        } else {
          showToast('Upload failed.', 4000);
        }
      })
      .then(function() { attachmentUploadBtn.disabled = false; });
  });

  // ── Checklist ───────────────────────────────────────────────────────
  // Items for the currently-opened card. Reset on each modal open.
  var checklistByCardId = 0;
  var checklistItems = [];

  function renderChecklist() {
    while (checklistListEl.firstChild) checklistListEl.removeChild(checklistListEl.firstChild);
    var done = 0;
    for (var i = 0; i < checklistItems.length; i++) {
      var item = checklistItems[i];
      if (item.completedAt) done++;
      checklistListEl.appendChild(renderChecklistItemNode(item));
    }
    checklistProgressEl.textContent = checklistItems.length === 0
      ? ''
      : '(' + done + ' / ' + checklistItems.length + ')';
  }

  function renderChecklistItemNode(item) {
    var li = document.createElement('li');
    li.className = 'kf-checklist-item' + (item.completedAt ? ' kf-checklist-done' : '');
    li.setAttribute('data-checklist-id', String(item.id));

    var box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = !!item.completedAt;
    box.setAttribute('aria-label', item.completedAt ? 'Mark item incomplete' : 'Mark item complete');
    box.addEventListener('change', function() {
      var cmid = nextClientMsgId();
      pendingClientMsgs.set(cmid, { type: 'update_checklist_item', id: item.id });
      send({
        type: 'update_checklist_item',
        clientMsgId: cmid,
        id: item.id,
        completed: box.checked,
      });
    });
    li.appendChild(box);

    var body = document.createElement('span');
    body.className = 'kf-checklist-body';
    body.textContent = item.body;
    li.appendChild(body);

    var del = document.createElement('button');
    del.type = 'button';
    del.className = 'kf-checklist-delete';
    del.textContent = '×';
    del.setAttribute('aria-label', 'Delete checklist item');
    del.addEventListener('click', function() {
      var cmid = nextClientMsgId();
      pendingClientMsgs.set(cmid, { type: 'delete_checklist_item', id: item.id });
      send({ type: 'delete_checklist_item', clientMsgId: cmid, id: item.id });
    });
    li.appendChild(del);

    return li;
  }

  function requestChecklistItems(cardId) {
    checklistByCardId = cardId;
    checklistItems = [];
    renderChecklist();
    var cmid = nextClientMsgId();
    pendingClientMsgs.set(cmid, { type: 'list_checklist_items', cardId: cardId });
    send({ type: 'list_checklist_items', clientMsgId: cmid, cardId: cardId });
  }

  function postChecklistItem() {
    if (!checklistByCardId) return;
    var body = checklistInputEl.value.trim();
    if (!body) return;
    checklistAddBtn.disabled = true;
    var cmid = nextClientMsgId();
    pendingClientMsgs.set(cmid, { type: 'create_checklist_item', cardId: checklistByCardId });
    var ok = send({
      type: 'create_checklist_item',
      clientMsgId: cmid,
      cardId: checklistByCardId,
      body: body,
    });
    if (ok) {
      checklistInputEl.value = '';
    }
    checklistAddBtn.disabled = false;
    checklistInputEl.focus();
  }

  checklistAddBtn.addEventListener('click', postChecklistItem);
  checklistInputEl.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      postChecklistItem();
    }
  });

  // ── Comments ────────────────────────────────────────────────────────
  // Comments for the currently-opened card, oldest first. Reset on each
  // modal open. Comment ids are unique across the board so we key by id.
  var commentsByCardId = 0;
  var commentList = [];

  function canModifyComment(comment) {
    if (!currentUser.id) return false;
    if (comment.authorUserId === currentUser.id) return true;
    if (currentUser.isAdmin) return true;
    return false;
  }

  function renderCommentBody(body, container) {
    // Reuse the Markdown renderer for full block-level rendering inside
    // the comment thread. Lists/headings are rare in comments but fine.
    renderMarkdownInto(body, container);
  }

  function renderCommentNode(comment) {
    var li = document.createElement('li');
    li.className = 'kf-comment';
    li.setAttribute('data-comment-id', String(comment.id));

    var head = document.createElement('div');
    head.className = 'kf-comment-head';

    var author = document.createElement('span');
    author.className = 'kf-comment-author';
    author.textContent = comment.authorDisplayName || 'Unknown';
    head.appendChild(author);

    var time = document.createElement('span');
    time.className = 'kf-comment-time';
    time.textContent = relativeTime(comment.createdAt);
    time.title = comment.createdAt || '';
    head.appendChild(time);

    if (comment.editedAt) {
      var edited = document.createElement('span');
      edited.className = 'kf-comment-edited';
      edited.textContent = '(edited)';
      edited.title = 'Edited ' + comment.editedAt;
      head.appendChild(edited);
    }

    li.appendChild(head);

    var body = document.createElement('div');
    body.className = 'kf-comment-body';
    renderCommentBody(comment.body, body);
    li.appendChild(body);

    if (canModifyComment(comment)) {
      var actions = document.createElement('div');
      actions.className = 'kf-comment-actions';
      // Author may edit; admin-only deletes can't be edited (admin must
      // delete + repost as themselves, matching the service contract).
      if (comment.authorUserId === currentUser.id) {
        var editBtn = document.createElement('button');
        editBtn.type = 'button';
        editBtn.className = 'kf-comment-action';
        editBtn.textContent = 'Edit';
        editBtn.addEventListener('click', function() { beginEditComment(comment.id); });
        actions.appendChild(editBtn);
      }
      var delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'kf-comment-action';
      delBtn.textContent = 'Delete';
      delBtn.addEventListener('click', function() {
        if (!confirm('Delete this comment? This cannot be undone.')) return;
        var cmid = nextClientMsgId();
        pendingClientMsgs.set(cmid, { type: 'delete_comment', id: comment.id });
        send({ type: 'delete_comment', clientMsgId: cmid, id: comment.id });
      });
      actions.appendChild(delBtn);
      li.appendChild(actions);
    }

    return li;
  }

  function beginEditComment(commentId) {
    var comment = null;
    for (var i = 0; i < commentList.length; i++) {
      if (commentList[i].id === commentId) { comment = commentList[i]; break; }
    }
    if (!comment) return;
    var li = commentsListEl.querySelector('[data-comment-id="' + commentId + '"]');
    if (!li) return;
    // Replace body + actions with an inline edit area; restore on save/cancel.
    var bodyEl = li.querySelector('.kf-comment-body');
    var actionsEl = li.querySelector('.kf-comment-actions');
    if (bodyEl) bodyEl.style.display = 'none';
    if (actionsEl) actionsEl.style.display = 'none';

    var area = document.createElement('div');
    area.className = 'kf-comment-edit-area';
    var ta = document.createElement('textarea');
    ta.rows = 3;
    ta.maxLength = 5000;
    ta.value = comment.body;
    var btnRow = document.createElement('div');
    btnRow.className = 'kf-comment-edit-actions';
    var cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', function() {
      area.parentNode.removeChild(area);
      if (bodyEl) bodyEl.style.display = '';
      if (actionsEl) actionsEl.style.display = '';
    });
    var save = document.createElement('button');
    save.type = 'button';
    save.className = 'btn btn-primary';
    save.textContent = 'Save';
    save.addEventListener('click', function() {
      var body = ta.value.trim();
      if (!body) return;
      save.disabled = true;
      var cmid = nextClientMsgId();
      pendingClientMsgs.set(cmid, { type: 'update_comment', id: commentId });
      send({ type: 'update_comment', clientMsgId: cmid, id: commentId, body: body });
    });
    btnRow.appendChild(cancel);
    btnRow.appendChild(save);
    area.appendChild(ta);
    area.appendChild(btnRow);
    li.appendChild(area);
    ta.focus();
  }

  function renderCommentsList() {
    while (commentsListEl.firstChild) commentsListEl.removeChild(commentsListEl.firstChild);
    if (commentList.length === 0) {
      commentsEmptyEl.hidden = false;
      return;
    }
    commentsEmptyEl.hidden = true;
    for (var i = 0; i < commentList.length; i++) {
      commentsListEl.appendChild(renderCommentNode(commentList[i]));
    }
  }

  function requestComments(cardId) {
    commentsByCardId = cardId;
    commentList = [];
    renderCommentsList();
    var cmid = nextClientMsgId();
    pendingClientMsgs.set(cmid, { type: 'list_comments', cardId: cardId });
    send({ type: 'list_comments', clientMsgId: cmid, cardId: cardId });
  }

  function postComment() {
    if (!commentsByCardId) return;
    var body = commentInputEl.value.trim();
    if (!body) return;
    commentPostBtn.disabled = true;
    var cmid = nextClientMsgId();
    pendingClientMsgs.set(cmid, { type: 'create_comment', cardId: commentsByCardId });
    var ok = send({ type: 'create_comment', clientMsgId: cmid, cardId: commentsByCardId, body: body });
    if (!ok) {
      commentPostBtn.disabled = false;
      showToast('Disconnected — comment not sent.', 4000);
    }
  }

  commentPostBtn.addEventListener('click', postComment);
  commentInputEl.addEventListener('keydown', function(e) {
    // Ctrl/Cmd+Enter to post — saves a click for keyboard-heavy users.
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      postComment();
    }
  });

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
    selectedAssignees = [];
    renderSelectedAssignees();
    assigneesInputEl.value = '';
    assignedInput.value = '';
    startInput.value = '';
    dueInput.value = '';
    dueTimeInput.value = '';
    coverInput.value = '#2563eb';
    coverSet = false;
    notesInput.value = '';
    errorEl.hidden = true;
    archiveBtn.hidden = true;
    restoreBtn.hidden = true;
    saveTemplateBtn.hidden = true;
    // No card id yet → no activity timeline or comments to show.
    activitySectionEl.hidden = true;
    activityEvents = [];
    commentsSectionEl.hidden = true;
    commentList = [];
    commentsByCardId = 0;
    commentInputEl.value = '';
    commentPostBtn.disabled = false;
    checklistSectionEl.hidden = true;
    checklistItems = [];
    checklistByCardId = 0;
    checklistInputEl.value = '';
    attachmentsSectionEl.hidden = true;
    attachmentList = [];
    attachmentsByCardId = 0;
    attachmentInputEl.value = '';
    attachmentStatusEl.textContent = '';
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
    // card.groups is { name, color }[] post-color migration; selectedGroups
    // is plain string[] (the wire format for create/update). Map down.
    selectedGroups = Array.isArray(card.groups)
      ? card.groups.map(function(g) { return (g && typeof g === 'object') ? g.name : g; })
      : [];
    renderSelectedGroups();
    groupsInput.value = '';
    selectedAssignees = Array.isArray(card.assignees) ? card.assignees.slice() : [];
    renderSelectedAssignees();
    assigneesInputEl.value = '';
    assignedInput.value = card.assigned || '';
    startInput.value = card.startDate || '';
    dueInput.value = card.dueDate || '';
    dueTimeInput.value = card.dueTime || '';
    if (card.coverColor) {
      coverInput.value = card.coverColor;
      coverSet = true;
    } else {
      coverInput.value = '#2563eb';
      coverSet = false;
    }
    notesInput.value = card.notes || '';
    errorEl.hidden = true;
    // Archive and Restore are mutually exclusive: Archive only appears for
    // active cards; Restore only appears for archived ones.
    archiveBtn.hidden = editingArchived;
    restoreBtn.hidden = !editingArchived;
    // Templates can be saved from any active card (not from archived).
    saveTemplateBtn.hidden = editingArchived;
    // Reveal attachments + checklist + comments + activity timeline and
    // kick off fetches for this card. All four render empty while in
    // flight.
    attachmentsSectionEl.hidden = false;
    refreshAttachments(id);
    checklistSectionEl.hidden = false;
    checklistInputEl.value = '';
    requestChecklistItems(id);
    commentsSectionEl.hidden = false;
    commentInputEl.value = '';
    commentPostBtn.disabled = false;
    requestComments(id);
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
    // Fold any unsubmitted typed group / assignee into their chip lists.
    if (groupsInput.value.trim()) addGroupFromInput();
    if (assigneesInputEl.value.trim()) addAssigneeFromInput();
    var title = titleInput.value.trim();
    if (!title) { showFormError('Task Name is required.'); return; }
    saveBtn.disabled = true;
    var cmid = nextClientMsgId();
    var assigneeIds = selectedAssignees.map(function(a) { return a.userId; });
    if (editingCardId === null) {
      pendingClientMsgs.set(cmid, { type: 'create' });
      var ok = send({
        type: 'create_card',
        clientMsgId: cmid,
        column: formEl.dataset.column,
        title: title,
        groups: selectedGroups.slice(),
        assigneeUserIds: assigneeIds,
        assigned: assignedInput.value.trim() || null,
        notes: notesInput.value.trim() || null,
        startDate: startInput.value || null,
        dueDate: dueInput.value || null,
        dueTime: dueTimeInput.value || null,
        coverColor: coverSet ? coverInput.value : null,
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
          assigneeUserIds: assigneeIds,
          assigned: assignedInput.value.trim() || null,
          notes: notesInput.value.trim() || null,
          startDate: startInput.value || null,
          dueDate: dueInput.value || null,
          dueTime: dueTimeInput.value || null,
          coverColor: coverSet ? coverInput.value : null,
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
        // Replace column config wholesale so a board with WIP limits set
        // shows them as soon as the snapshot lands.
        columnConfig.clear();
        if (Array.isArray(msg.columns)) {
          msg.columns.forEach(function(c) { columnConfig.set(c.columnName, c); });
        }
        // Build group-color directory from every card we just received.
        groupColors.clear();
        msg.cards.forEach(ingestGroupsFromCard);
        renderAll();
        // Deep-link from a notification: /kanban/<slug>?card=<id> auto-opens
        // that card's modal as soon as the snapshot lands. One-shot — strip
        // the query param so a refresh doesn't keep re-opening the modal.
        try {
          var qs = new URLSearchParams(location.search);
          var deepCardId = parseInt(qs.get('card') || '', 10);
          if (deepCardId && cards.has(deepCardId)) {
            openEditModal(deepCardId, false);
            qs.delete('card');
            var newSearch = qs.toString();
            history.replaceState(null, '',
              location.pathname + (newSearch ? '?' + newSearch : '') + location.hash);
          }
        } catch (_err) { /* best-effort */ }
        return;
      case 'card_created':
        ingestGroupsFromCard(msg.card);
        upsertCard(msg.card);
        return;
      case 'card_updated':
        ingestGroupsFromCard(msg.card);
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
      case 'comments_snapshot':
        if (commentsByCardId !== msg.cardId) return;
        commentList = (msg.comments || []).slice();
        renderCommentsList();
        return;
      case 'comment_created':
        // A comment may be created on any card; only render if the modal
        // is showing that card. Append to thread (oldest-first ordering)
        // and clear the composer if this client posted it.
        if (!msg.comment || commentsByCardId !== msg.comment.cardId) return;
        commentList.push(msg.comment);
        renderCommentsList();
        if (msg.comment.authorUserId === currentUser.id) {
          commentInputEl.value = '';
          commentPostBtn.disabled = false;
          // Scroll the new comment into view inside the list.
          commentsListEl.scrollTop = commentsListEl.scrollHeight;
        }
        return;
      case 'comment_updated':
        if (!msg.comment || commentsByCardId !== msg.comment.cardId) return;
        for (var ci = 0; ci < commentList.length; ci++) {
          if (commentList[ci].id === msg.comment.id) {
            commentList[ci] = msg.comment;
            break;
          }
        }
        renderCommentsList();
        return;
      case 'comment_deleted':
        if (commentsByCardId !== msg.cardId) return;
        commentList = commentList.filter(function(c) { return c.id !== msg.id; });
        renderCommentsList();
        return;
      case 'checklist_items_snapshot':
        if (checklistByCardId !== msg.cardId) return;
        checklistItems = (msg.items || []).slice();
        renderChecklist();
        return;
      case 'checklist_item_created':
        if (!msg.item || checklistByCardId !== msg.item.cardId) return;
        checklistItems.push(msg.item);
        renderChecklist();
        return;
      case 'checklist_item_updated':
        if (!msg.item || checklistByCardId !== msg.item.cardId) return;
        for (var ki = 0; ki < checklistItems.length; ki++) {
          if (checklistItems[ki].id === msg.item.id) {
            checklistItems[ki] = msg.item;
            break;
          }
        }
        renderChecklist();
        return;
      case 'checklist_item_deleted':
        if (checklistByCardId !== msg.cardId) return;
        checklistItems = checklistItems.filter(function(i) { return i.id !== msg.id; });
        renderChecklist();
        return;
      case 'column_config_updated':
        // Single column's config changed (WIP limit, color, etc.).
        if (msg.column && msg.column.columnName) {
          columnConfig.set(msg.column.columnName, msg.column);
          renderColumnHeaders();
          // Apply / clear the color accent and color-picker value.
          var sec = boardEl.querySelector('[data-col="' + msg.column.columnName + '"]');
          if (sec) {
            if (msg.column.color) {
              sec.setAttribute('data-col-color', msg.column.color);
              sec.style.setProperty('--col-accent', msg.column.color);
            } else {
              sec.removeAttribute('data-col-color');
              sec.style.removeProperty('--col-accent');
            }
            var picker = sec.querySelector('.kanban-col-color');
            if (picker) picker.value = msg.column.color || '#94a3b8';
          }
        }
        return;
      case 'column_added':
        if (msg.column && msg.column.columnName) {
          columnConfig.set(msg.column.columnName, msg.column);
          rebuildBoardStructure();
          renderAll();
        }
        return;
      case 'column_renamed':
        if (msg.column && msg.column.columnName) {
          columnConfig.set(msg.column.columnName, msg.column);
          // Label change doesn't require a structural rebuild — just patch
          // the title text in place.
          var titleEl = boardEl.querySelector('[data-col-title="' + msg.column.columnName + '"]');
          if (titleEl) titleEl.textContent = msg.column.label;
          renderColumnHeaders();
        }
        return;
      case 'column_removed':
        if (msg.column) {
          columnConfig.delete(msg.column);
          rebuildBoardStructure();
          renderAll();
        }
        return;
      case 'group_color_updated':
        if (msg.group && msg.group.name) {
          setGroupColorLocal(msg.group.name, msg.group.color);
          // Re-render the board (chips on cards) and the modal's chip
          // list if it's currently open.
          renderAll();
          if (!modalEl.hidden) renderSelectedGroups();
        }
        return;
      case 'templates_snapshot':
        templates = (msg.templates || []).slice();
        if (!templatesModalEl.hidden) renderTemplatesList();
        return;
      case 'template_created':
        if (msg.template) {
          // Replace if present (idempotent); append otherwise.
          var foundIdx = -1;
          for (var ti = 0; ti < templates.length; ti++) {
            if (templates[ti].id === msg.template.id) { foundIdx = ti; break; }
          }
          if (foundIdx >= 0) templates[foundIdx] = msg.template;
          else templates.push(msg.template);
          if (!templatesModalEl.hidden) renderTemplatesList();
        }
        return;
      case 'template_deleted':
        if (typeof msg.id === 'number') {
          templates = templates.filter(function(t) { return t.id !== msg.id; });
          if (!templatesModalEl.hidden) renderTemplatesList();
        }
        return;
      case 'ack':
        pendingClientMsgs.delete(msg.clientMsgId);
        if (!modalEl.hidden && saveBtn.disabled) closeModal();
        return;
      case 'nack':
        var pending = pendingClientMsgs.get(msg.clientMsgId);
        pendingClientMsgs.delete(msg.clientMsgId);
        // Column-management nacks aren't modal-bound, so route them to
        // toast messages with reason-specific text.
        if (pending && (pending.type === 'add_column' || pending.type === 'rename_column' || pending.type === 'delete_column')) {
          if (msg.reason === 'has_cards') {
            showToast('Can’t delete a column that still has cards — move or archive them first.', 5000);
          } else if (msg.reason === 'last_column') {
            showToast('Can’t delete the last remaining column on a board.', 5000);
          } else if (msg.reason === 'forbidden') {
            showToast('Only staff+ can change board columns.', 4000);
          } else if (msg.reason === 'not_found') {
            showToast('That column no longer exists — refresh to see current state.', 4000);
          } else {
            showToast('Column update failed.', 4000);
          }
          return;
        }
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
