/**
 * "My Cards" — cross-board view of every active card assigned to the
 * current user. Read-only; clicking a card jumps to its board with the
 * modal auto-opened (same redirector path as notification clicks).
 */

import type { FC } from 'hono/jsx';
import { Layout } from './Layout';
import type { AuthUser } from '../env';
import type { AssignedCardSummary, ColumnName } from '../services/kanban.service';

interface MyCardsPageProps {
  user: AuthUser;
  cards: AssignedCardSummary[];
}

const COLUMN_LABEL: Record<ColumnName, string> = {
  not_started: 'Not Started',
  started: 'Started',
  blocked: 'Blocked',
  ready: 'Ready',
  approval: 'Approval',
  done: 'Done',
};

function formatDue(card: AssignedCardSummary): string {
  if (!card.dueDate) return '';
  return card.dueTime ? `${card.dueDate} ${card.dueTime}` : card.dueDate;
}

export const MyCardsPage: FC<MyCardsPageProps> = ({ user, cards }) => {
  // Group by board for a hierarchical view — easier to scan than a flat
  // list when the user is on many boards.
  const byBoard = new Map<number, { name: string; slug: string; items: AssignedCardSummary[] }>();
  for (const c of cards) {
    const existing = byBoard.get(c.boardId);
    if (existing) existing.items.push(c);
    else byBoard.set(c.boardId, { name: c.boardName, slug: c.boardSlug, items: [c] });
  }
  const groups = Array.from(byBoard.values()).sort((a, b) => a.name.localeCompare(b.name));

  // Today as YYYY-MM-DD for "overdue" badges. Computed server-side using
  // the Worker's UTC clock — close enough for v1 since the server is
  // always in a consistent zone.
  const today = new Date().toISOString().slice(0, 10);

  return (
    <Layout title="My Cards" user={user}>
      <style>{css}</style>
      <h1 class="my-head">My Cards</h1>
      <p class="muted">{cards.length === 0 ? 'You’re not currently assigned to any active cards.' : `${cards.length} active card${cards.length === 1 ? '' : 's'} assigned to you.`}</p>

      {groups.length === 0 ? (
        <div class="card">
          <p>Nothing on your plate right now. Check the <a href="/kanban">boards</a> for unassigned work, or wait for someone to @mention you.</p>
        </div>
      ) : (
        groups.map((g) => (
          <section class="my-board">
            <h2 class="my-board-title">
              <a href={`/kanban/${encodeURIComponent(g.slug)}`}>{g.name}</a>
              <span class="muted my-board-count"> · {g.items.length}</span>
            </h2>
            <ul class="my-list">
              {g.items.map((c) => {
                const overdue = !!(c.dueDate && c.dueDate < today && c.column !== 'done');
                return (
                  <li class="my-item">
                    <a class="my-item-link" href={`/kanban/c/${c.id}`}>
                      <div class="my-item-row">
                        <span class="my-item-title">{c.title}</span>
                        <span class={`my-pill my-pill-${c.column}`}>{COLUMN_LABEL[c.column]}</span>
                      </div>
                      <div class="my-item-meta">
                        {c.startDate ? <span class="my-meta-chip">Start {c.startDate}</span> : null}
                        {c.dueDate ? (
                          <span class={overdue ? 'my-meta-chip my-meta-overdue' : 'my-meta-chip'}>
                            Due {formatDue(c)}{overdue ? ' (overdue)' : ''}
                          </span>
                        ) : null}
                      </div>
                    </a>
                  </li>
                );
              })}
            </ul>
          </section>
        ))
      )}
    </Layout>
  );
};

const css = `
  .my-head { margin-bottom: 4px; }
  .my-board { margin-top: 24px; }
  .my-board-title { font-size: 1.1em; margin: 0 0 8px 0; }
  .my-board-title a { color: inherit; text-decoration: none; }
  .my-board-title a:hover { text-decoration: underline; }
  .my-board-count { font-weight: 400; }
  .my-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
  .my-item { padding: 0; }
  .my-item-link {
    display: block; padding: 10px 14px; color: inherit; text-decoration: none;
    border: 1px solid rgba(128,128,128,0.25); border-radius: 6px;
    background: rgba(128,128,128,0.04);
  }
  .my-item-link:hover { border-color: rgba(128,128,128,0.5); background: rgba(128,128,128,0.08); }
  .my-item-row { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; }
  .my-item-title { font-weight: 500; flex: 1; min-width: 0; }
  .my-item-meta { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 4px; font-size: 0.85em; opacity: 0.8; }
  .my-meta-chip { background: rgba(128,128,128,0.15); padding: 1px 6px; border-radius: 999px; }
  .my-meta-overdue { background: rgba(220,38,38,0.18); color: #b91c1c; opacity: 1; font-weight: 500; }
  .my-pill {
    font-size: 0.75em; padding: 2px 8px; border-radius: 999px; font-weight: 500;
    background: rgba(128,128,128,0.18);
  }
  .my-pill-not_started { background: rgba(148,163,184,0.25); }
  .my-pill-started     { background: rgba(56,189,248,0.22); }
  .my-pill-blocked     { background: rgba(220,38,38,0.18); color: #b91c1c; }
  .my-pill-ready       { background: rgba(168,85,247,0.22); }
  .my-pill-approval    { background: rgba(234,179,8,0.22); }
  .my-pill-done        { background: rgba(34,197,94,0.22); }
`;
