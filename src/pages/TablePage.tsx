/**
 * Table view — flat spreadsheet of every active card across every board.
 * Read-only for v1; click a row to jump to the card's modal via the
 * deep-link redirector. Sortable columns via inline JS; filters live in
 * the URL query string so links are shareable.
 */

import type { FC } from 'hono/jsx';
import { raw } from 'hono/html';
import { Layout } from './Layout';
import type { AuthUser } from '../env';
import type { AssigneeDto, BoardDto, TableCardRow } from '../services/kanban.service';

interface TablePageProps {
  user: AuthUser;
  rows: TableCardRow[];
  boards: BoardDto[];
  filters: {
    boardId: number | null;
    column: string | null;
    assigneeUserId: number | null;
  };
  knownUsers: AssigneeDto[];
}

function formatDue(r: TableCardRow): string {
  if (!r.dueDate) return '';
  return r.dueTime ? `${r.dueDate} ${r.dueTime}` : r.dueDate;
}

export const TablePage: FC<TablePageProps> = ({ user, rows, boards, filters, knownUsers }) => {
  const today = new Date().toISOString().slice(0, 10);
  return (
    <Layout title="Table" user={user}>
      <style>{css}</style>
      <header class="tbl-head">
        <h1>Table</h1>
        <span class="muted">{rows.length} card{rows.length === 1 ? '' : 's'}</span>
      </header>

      <form method="get" action="/table" class="tbl-filters" aria-label="Table filters">
        <label>Board
          <select name="board">
            <option value="">All</option>
            {boards.map((b) => (
              <option value={String(b.id)} selected={filters.boardId === b.id}>{b.name}</option>
            ))}
          </select>
        </label>
        <label>Column
          <input type="text" name="column" value={filters.column ?? ''} placeholder="e.g. started" />
        </label>
        <label>Assignee
          <select name="assignee">
            <option value="">Anyone</option>
            {knownUsers.map((u) => (
              <option value={String(u.userId)} selected={filters.assigneeUserId === u.userId}>
                {u.displayName || u.email}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" class="btn">Apply</button>
        <a class="btn" href="/table">Reset</a>
      </form>

      {rows.length === 0 ? (
        <p class="muted">No cards match these filters.</p>
      ) : (
        <div class="tbl-wrap">
          <table class="tbl" id="kanban-table">
            <thead>
              <tr>
                <th data-sort="board">Board</th>
                <th data-sort="column">Column</th>
                <th data-sort="title">Title</th>
                <th data-sort="assignees">Assignees</th>
                <th data-sort="groups">Labels</th>
                <th data-sort="start">Start</th>
                <th data-sort="due">Due</th>
                <th data-sort="updated">Updated</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const overdue = !!(r.dueDate && r.dueDate < today && r.column !== 'done');
                return (
                  <tr data-card-id={String(r.id)}
                      data-board={r.boardName}
                      data-column={r.columnLabel}
                      data-title={r.title}
                      data-assignees={r.assignees.map((a) => a.displayName || a.email).join(', ')}
                      data-groups={r.groups.map((g) => g.name).join(', ')}
                      data-start={r.startDate ?? ''}
                      data-due={r.dueDate ?? ''}
                      data-updated={r.updatedAt}>
                    <td><a href={`/kanban/${encodeURIComponent(r.boardSlug)}`} class="tbl-link">{r.boardName}</a></td>
                    <td><span class="tbl-pill">{r.columnLabel}</span></td>
                    <td><a href={`/kanban/c/${r.id}`} class="tbl-link tbl-title">{r.title}</a></td>
                    <td>
                      {r.assignees.length === 0 ? <span class="muted">—</span> : (
                        <span class="tbl-chips">
                          {r.assignees.map((a) => <span class="tbl-chip tbl-chip-assignee" title={a.email}>{a.displayName || a.email}</span>)}
                        </span>
                      )}
                    </td>
                    <td>
                      {r.groups.length === 0 ? <span class="muted">—</span> : (
                        <span class="tbl-chips">
                          {r.groups.map((g) => (
                            <span
                              class="tbl-chip"
                              style={g.color ? `background: ${g.color}33; border: 1px solid ${g.color}66` : undefined}
                            >
                              {g.name}
                            </span>
                          ))}
                        </span>
                      )}
                    </td>
                    <td class="tbl-date">{r.startDate ?? ''}</td>
                    <td class={overdue ? 'tbl-date tbl-overdue' : 'tbl-date'}>{formatDue(r)}</td>
                    <td class="tbl-date muted">{r.updatedAt.slice(0, 10)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <script>{raw(sortJs)}</script>
    </Layout>
  );
};

// Tiny client-side sort. Header click toggles asc/desc on the data-* key.
// All comparisons string-based (works for ISO dates too).
const sortJs = `
(function() {
  var table = document.getElementById('kanban-table');
  if (!table) return;
  var dir = {};
  table.querySelectorAll('th[data-sort]').forEach(function(th) {
    th.style.cursor = 'pointer';
    th.addEventListener('click', function() {
      var key = th.getAttribute('data-sort');
      dir[key] = dir[key] === 'asc' ? 'desc' : 'asc';
      var rows = Array.prototype.slice.call(table.tBodies[0].rows);
      rows.sort(function(a, b) {
        var av = (a.getAttribute('data-' + key) || '').toLowerCase();
        var bv = (b.getAttribute('data-' + key) || '').toLowerCase();
        if (av < bv) return dir[key] === 'asc' ? -1 : 1;
        if (av > bv) return dir[key] === 'asc' ? 1 : -1;
        return 0;
      });
      var tbody = table.tBodies[0];
      rows.forEach(function(r) { tbody.appendChild(r); });
    });
  });
})();
`;

const css = `
  body:has(.tbl) .main { max-width: none; padding: 0 16px; }

  .tbl-head { display: flex; gap: 16px; align-items: baseline; }
  .tbl-filters {
    display: flex; gap: 12px; align-items: end; flex-wrap: wrap;
    margin: 16px 0; padding: 12px; border: 1px solid rgba(128,128,128,0.25);
    border-radius: 8px;
  }
  .tbl-filters label { margin: 0; font-size: 0.85em; }
  .tbl-filters select, .tbl-filters input { display: block; margin-top: 4px; }
  .tbl-wrap { overflow-x: auto; }
  .tbl {
    width: 100%; border-collapse: collapse; font-size: 0.9em;
    table-layout: auto;
  }
  .tbl th, .tbl td {
    text-align: left; padding: 6px 10px;
    border-bottom: 1px solid rgba(128,128,128,0.18);
    vertical-align: top;
  }
  .tbl th {
    font-size: 0.75em; text-transform: uppercase; letter-spacing: 0.05em;
    opacity: 0.7; user-select: none;
  }
  .tbl th:hover { opacity: 1; background: rgba(128,128,128,0.08); }
  .tbl tbody tr:hover { background: rgba(128,128,128,0.05); }
  .tbl-link { color: inherit; text-decoration: none; }
  .tbl-link:hover { text-decoration: underline; }
  .tbl-title { font-weight: 500; }
  .tbl-pill {
    font-size: 0.75em; padding: 2px 8px; border-radius: 999px;
    background: rgba(128,128,128,0.18);
  }
  .tbl-chips { display: inline-flex; flex-wrap: wrap; gap: 4px; }
  .tbl-chip {
    font-size: 0.8em; padding: 1px 6px; border-radius: 999px;
    background: rgba(128,128,128,0.15);
  }
  .tbl-chip-assignee { background: rgba(56,189,248,0.18); }
  .tbl-date { font-variant-numeric: tabular-nums; white-space: nowrap; }
  .tbl-overdue { color: #b91c1c; font-weight: 500; }
`;
