/**
 * Calendar view — cross-board cards plotted on a month grid by due date.
 * Read-only for v1; clicking a card jumps to /kanban/c/<id>.
 *
 * The grid always renders six weeks (42 cells) so the layout is stable
 * across months — the leading/trailing days from neighbouring months are
 * dimmed but still navigable.
 */

import type { FC } from 'hono/jsx';
import { Layout } from './Layout';
import type { AuthUser } from '../env';
import type { CalendarCardSummary, ColumnName } from '../services/kanban.service';

interface CalendarPageProps {
  user: AuthUser;
  /** Year of the focal month (e.g. 2026). */
  year: number;
  /** 1-based month (1 = January). */
  month: number;
  cards: CalendarCardSummary[];
}

const COLUMN_LABEL: Record<ColumnName, string> = {
  not_started: 'Not Started',
  started: 'Started',
  blocked: 'Blocked',
  ready: 'Ready',
  approval: 'Approval',
  done: 'Done',
};

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function pad2(n: number): string {
  return n < 10 ? '0' + n : String(n);
}

function isoDate(y: number, m: number, d: number): string {
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

/** Day of week (0=Sun, 6=Sat) for a given Y-M-D using JS Date. */
function dayOfWeek(y: number, m: number, d: number): number {
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Days in a 1-based month. */
function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

interface MonthShift { year: number; month: number; }
function shiftMonth(year: number, month: number, delta: number): MonthShift {
  let m = month + delta;
  let y = year;
  while (m < 1) { m += 12; y -= 1; }
  while (m > 12) { m -= 12; y += 1; }
  return { year: y, month: m };
}

export const CalendarPage: FC<CalendarPageProps> = ({ user, year, month, cards }) => {
  // Build a map of YYYY-MM-DD → cards for O(1) cell lookup.
  const byDay = new Map<string, CalendarCardSummary[]>();
  for (const c of cards) {
    const list = byDay.get(c.dueDate);
    if (list) list.push(c);
    else byDay.set(c.dueDate, [c]);
  }

  // 6-row grid starting on the Sunday on/before the 1st.
  const firstDow = dayOfWeek(year, month, 1); // 0..6
  const dim = daysInMonth(year, month);
  const prev = shiftMonth(year, month, -1);
  const next = shiftMonth(year, month, +1);
  const prevDim = daysInMonth(prev.year, prev.month);

  const cells: Array<{ y: number; m: number; d: number; current: boolean; iso: string }> = [];
  // Leading days from the previous month.
  for (let i = firstDow - 1; i >= 0; i--) {
    const dd = prevDim - i;
    cells.push({ y: prev.year, m: prev.month, d: dd, current: false, iso: isoDate(prev.year, prev.month, dd) });
  }
  // Current month.
  for (let d = 1; d <= dim; d++) {
    cells.push({ y: year, m: month, d, current: true, iso: isoDate(year, month, d) });
  }
  // Trailing days to fill 42.
  let trail = 1;
  while (cells.length < 42) {
    cells.push({ y: next.year, m: next.month, d: trail, current: false, iso: isoDate(next.year, next.month, trail) });
    trail++;
  }

  // Today (UTC; same caveat as MyCardsPage — close enough for a v1 view).
  const today = new Date().toISOString().slice(0, 10);

  const titleStr = `${MONTH_NAMES[month - 1]} ${year}`;

  return (
    <Layout title={`Calendar · ${titleStr}`} user={user}>
      <style>{css}</style>
      <header class="cal-head">
        <h1 class="cal-title">{titleStr}</h1>
        <nav class="cal-nav" aria-label="Month navigation">
          <a class="btn cal-nav-btn" href={`/calendar?year=${prev.year}&month=${prev.month}`} aria-label="Previous month">← Prev</a>
          <a class="btn cal-nav-btn" href="/calendar" aria-label="Today">Today</a>
          <a class="btn cal-nav-btn" href={`/calendar?year=${next.year}&month=${next.month}`} aria-label="Next month">Next →</a>
        </nav>
        <span class="muted cal-count">{cards.length} card{cards.length === 1 ? '' : 's'} this month</span>
      </header>

      <div class="cal-grid" role="grid">
        {['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map((dow) => (
          <div class="cal-dow" role="columnheader">{dow}</div>
        ))}
        {cells.map((cell) => {
          const dayCards = byDay.get(cell.iso) ?? [];
          const isToday = cell.iso === today;
          const cls = ['cal-cell'];
          if (!cell.current) cls.push('cal-cell-other');
          if (isToday) cls.push('cal-cell-today');
          return (
            <div class={cls.join(' ')} role="gridcell" aria-label={cell.iso}>
              <div class="cal-cell-head">
                <span class="cal-cell-day">{cell.d}</span>
                {dayCards.length > 0 ? <span class="cal-cell-count">{dayCards.length}</span> : null}
              </div>
              {dayCards.length > 0 ? (
                <ul class="cal-cell-cards">
                  {dayCards.map((c) => (
                    <li>
                      <a class={`cal-card cal-card-${c.column}`} href={`/kanban/c/${c.id}`}
                         title={`${c.title} (${COLUMN_LABEL[c.column]} on ${c.boardName})`}>
                        {c.dueTime ? <span class="cal-card-time">{c.dueTime}</span> : null}
                        <span class="cal-card-title">{c.title}</span>
                      </a>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          );
        })}
      </div>
    </Layout>
  );
};

const css = `
  /* Calendar needs more horizontal room than the default Layout 960px cap. */
  body:has(.cal-grid) .main { max-width: none; padding: 0 16px; }

  .cal-head { display: flex; gap: 16px; align-items: baseline; flex-wrap: wrap; }
  .cal-title { margin: 0; }
  .cal-nav { display: flex; gap: 6px; }
  .cal-nav-btn { padding: 6px 12px; font-size: 0.85em; }
  .cal-count { margin-left: auto; }

  .cal-grid {
    display: grid;
    grid-template-columns: repeat(7, minmax(120px, 1fr));
    gap: 4px;
    margin-top: 16px;
  }
  .cal-dow {
    font-size: 0.75em; text-transform: uppercase; letter-spacing: 0.06em;
    opacity: 0.7; padding: 4px 6px;
  }
  .cal-cell {
    border: 1px solid rgba(128,128,128,0.25); border-radius: 6px;
    min-height: 90px; padding: 6px; display: flex; flex-direction: column; gap: 4px;
    background: rgba(128,128,128,0.04);
  }
  .cal-cell-other { opacity: 0.55; background: transparent; }
  .cal-cell-today { border-color: #2563eb; box-shadow: inset 0 0 0 1px #2563eb; }
  .cal-cell-head { display: flex; justify-content: space-between; align-items: baseline; }
  .cal-cell-day { font-weight: 600; font-size: 0.9em; }
  .cal-cell-count {
    font-size: 0.7em; opacity: 0.6;
    background: rgba(128,128,128,0.15); border-radius: 999px; padding: 0 6px;
  }
  .cal-cell-cards { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
  .cal-card {
    display: flex; gap: 4px; align-items: baseline;
    text-decoration: none; color: inherit;
    font-size: 0.78em; padding: 2px 6px; border-radius: 4px;
    background: rgba(128,128,128,0.18);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .cal-card:hover { background: rgba(128,128,128,0.32); }
  .cal-card-time { opacity: 0.7; font-variant-numeric: tabular-nums; flex-shrink: 0; }
  .cal-card-title { overflow: hidden; text-overflow: ellipsis; }
  .cal-card-blocked  { background: rgba(220,38,38,0.18); }
  .cal-card-done     { background: rgba(34,197,94,0.18); text-decoration: line-through; opacity: 0.7; }
  .cal-card-approval { background: rgba(234,179,8,0.22); }
  .cal-card-started  { background: rgba(56,189,248,0.22); }
  .cal-card-ready    { background: rgba(168,85,247,0.22); }
`;
