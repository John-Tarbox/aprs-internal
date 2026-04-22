/**
 * Kanban board picker. Lists every board with its column counts, plus a
 * "new board" form. Staff+ can rename and delete (delete requires confirm).
 */

import type { FC } from 'hono/jsx';
import { Layout } from './Layout';
import type { AuthUser } from '../env';
import type { BoardDto } from '../services/kanban.service';

interface KanbanBoardListPageProps {
  user: AuthUser;
  boards: BoardDto[];
  countsByBoardId: Record<number, Record<string, number>>;
  columns: string[];
  flash?: { kind: 'ok' | 'err'; message: string };
}

const COLUMN_LABELS: Record<string, string> = {
  not_started: 'Not Started',
  started: 'Started',
  blocked: 'Blocked',
  ready: 'Ready',
  approval: 'Approval',
  done: 'Done',
};

function totalFor(counts: Record<string, number>): number {
  return Object.values(counts).reduce((a, b) => a + b, 0);
}

export const KanbanBoardListPage: FC<KanbanBoardListPageProps> = ({
  user,
  boards,
  countsByBoardId,
  columns,
  flash,
}) => {
  const canManage = user.roles.includes('staff') || user.roles.includes('admin');

  return (
    <Layout title="Kanban boards" user={user}>
      <style>{css}</style>
      <div class="bl-head">
        <h1>Kanban boards</h1>
        <span class="muted">{boards.length} board{boards.length === 1 ? '' : 's'}</span>
      </div>

      {flash ? (
        <div class={`flash flash-${flash.kind}`}>{flash.message}</div>
      ) : null}

      <div class="bl-grid">
        {boards.map((b) => {
          const counts = countsByBoardId[b.id] ?? {};
          const total = totalFor(counts);
          return (
            <div class="bl-card">
              <a class="bl-card-main" href={`/kanban/${encodeURIComponent(b.slug)}`}>
                <div class="bl-card-head">
                  <span class="bl-card-title">{b.name}</span>
                  <span class="muted bl-slug">/{b.slug}</span>
                </div>
                <div class="bl-stats">
                  {columns.map((col) => (
                    <span class="bl-stat" title={COLUMN_LABELS[col] ?? col}>
                      <span class="bl-stat-label">{COLUMN_LABELS[col] ?? col}</span>
                      <span class="bl-stat-value">{counts[col] ?? 0}</span>
                    </span>
                  ))}
                </div>
                <div class="bl-card-foot">
                  <span class="muted">{total} {total === 1 ? 'task' : 'tasks'}</span>
                  <span class="bl-cta">Open →</span>
                </div>
              </a>
              {canManage ? (
                <details class="bl-manage">
                  <summary class="muted">Manage</summary>
                  <form method="post" action={`/kanban/${encodeURIComponent(b.slug)}/rename`} class="bl-manage-form">
                    <label>
                      Rename
                      <input type="text" name="name" defaultValue={b.name} maxlength={100} required />
                    </label>
                    <button type="submit" class="btn">Save name</button>
                  </form>
                  <form method="post" action={`/kanban/${encodeURIComponent(b.slug)}/delete`} class="bl-manage-form bl-delete">
                    <label>
                      <span class="muted">Type the slug <code>{b.slug}</code> to confirm delete.</span>
                      <input type="text" name="confirm" autocomplete="off" />
                    </label>
                    <button type="submit" class="btn bl-btn-danger">Delete board</button>
                  </form>
                </details>
              ) : null}
            </div>
          );
        })}
      </div>

      {canManage ? (
        <div class="card bl-new">
          <h2>New board</h2>
          <form method="post" action="/kanban">
            <label>Name
              <input type="text" name="name" required maxlength={100} placeholder="e.g. Board of Directors" />
            </label>
            <label>Slug <span class="muted">(optional — auto-derived from the name)</span>
              <input type="text" name="slug" maxlength={60} placeholder="e.g. board-of-directors" />
            </label>
            <button type="submit" class="btn btn-primary">Create board</button>
          </form>
        </div>
      ) : null}
    </Layout>
  );
};

const css = `
  .bl-head { display: flex; align-items: baseline; gap: 12px; margin-bottom: 18px; }
  .bl-head h1 { margin: 0; }
  .bl-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
    gap: 14px;
    margin-bottom: 24px;
  }
  .bl-card {
    border: 1px solid rgba(128,128,128,0.28);
    border-radius: 10px;
    padding: 16px;
    display: flex; flex-direction: column; gap: 10px;
    background: rgba(255,255,255,0.02);
  }
  @media (prefers-color-scheme: light) { .bl-card { background: #fff; } }
  .bl-card-main {
    display: flex; flex-direction: column; gap: 10px;
    color: inherit; text-decoration: none;
  }
  .bl-card-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
  .bl-card-title { font-weight: 600; font-size: 1.1rem; }
  .bl-slug { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.8em; }
  .bl-stats { display: flex; flex-wrap: wrap; gap: 6px; }
  .bl-stat {
    display: inline-flex; align-items: baseline; gap: 6px;
    padding: 3px 9px; border-radius: 6px;
    background: rgba(128,128,128,0.1);
    border: 1px solid rgba(128,128,128,0.2);
    font-size: 0.82em;
  }
  .bl-stat-label { opacity: 0.75; }
  .bl-stat-value { font-variant-numeric: tabular-nums; font-weight: 600; }
  .bl-card-foot { display: flex; align-items: center; justify-content: space-between; }
  .bl-cta { font-weight: 600; color: #2563eb; }
  .bl-manage { border-top: 1px dashed rgba(128,128,128,0.3); padding-top: 10px; }
  .bl-manage summary { cursor: pointer; font-size: 0.85em; }
  .bl-manage-form { display: grid; gap: 6px; margin-top: 10px; }
  .bl-manage-form label { display: grid; gap: 4px; font-size: 0.85em; }
  .bl-delete { border-top: 1px dashed rgba(239,68,68,0.3); margin-top: 8px; padding-top: 10px; }
  .bl-btn-danger { color: #b91c1c; border-color: rgba(185,28,28,0.5); }
  .bl-new { margin-top: 16px; }
  .bl-new form { display: grid; gap: 10px; max-width: 480px; }
  code { background: rgba(128,128,128,0.15); padding: 1px 4px; border-radius: 3px; }
`;
