/**
 * Timeline / Gantt view — horizontal SVG bars showing each card's
 * start→due range across a one-month window.
 *
 * Bar layout: cards are placed in lanes via a greedy first-fit algorithm
 * (left-to-right scan; each card joins the first lane whose last bar
 * ends before this card starts, otherwise opens a new lane). This keeps
 * total lanes minimal without worrying about optimal packing.
 *
 * Hover shows board + dates; click jumps to the card's modal via the
 * existing /kanban/c/<id> deep-link redirector. Read-only for v1.
 */

import type { FC } from 'hono/jsx';
import { Layout } from './Layout';
import type { AuthUser } from '../env';
import type { TimelineCardRow } from '../services/kanban.service';
import { colorForColumn } from '../util/colors';

interface TimelinePageProps {
  user: AuthUser;
  year: number;
  month: number;
  cards: TimelineCardRow[];
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function pad2(n: number): string { return n < 10 ? '0' + n : String(n); }

function shiftMonth(year: number, month: number, delta: number): { year: number; month: number } {
  let m = month + delta;
  let y = year;
  while (m < 1) { m += 12; y -= 1; }
  while (m > 12) { m -= 12; y += 1; }
  return { year: y, month: m };
}

interface LaidOutCard extends TimelineCardRow {
  /** Day-of-month start (1-based, clamped to [1, daysInMonth]). */
  startDay: number;
  /** Day-of-month end (inclusive). */
  endDay: number;
  lane: number;
}

function clampDay(iso: string | null, year: number, month: number, fallback: number): number {
  if (!iso) return fallback;
  const [yy, mm, dd] = iso.split('-').map((n) => Number.parseInt(n, 10));
  if (yy === year && mm === month) return Math.max(1, Math.min(31, dd));
  // Out of window: clamp to the relevant edge.
  if (yy < year || (yy === year && mm < month)) return 1;
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Greedy lane assignment — O(N·L) where N is cards, L is final lane count. */
function assignLanes(cards: LaidOutCard[]): LaidOutCard[] {
  const laneEnds: number[] = [];
  for (const c of cards) {
    let placed = false;
    for (let i = 0; i < laneEnds.length; i++) {
      if (laneEnds[i] < c.startDay) {
        c.lane = i;
        laneEnds[i] = c.endDay;
        placed = true;
        break;
      }
    }
    if (!placed) {
      c.lane = laneEnds.length;
      laneEnds.push(c.endDay);
    }
  }
  return cards;
}

export const TimelinePage: FC<TimelinePageProps> = ({ user, year, month, cards }) => {
  const dim = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const titleStr = `${MONTH_NAMES[month - 1]} ${year}`;
  const prev = shiftMonth(year, month, -1);
  const next = shiftMonth(year, month, +1);

  // Compute clamped start/end days for every card, then greedy-assign lanes.
  const laidOut: LaidOutCard[] = cards.map((c) => {
    const start = c.startDate ?? c.dueDate!;
    const end = c.dueDate ?? c.startDate!;
    const startDay = clampDay(start, year, month, 1);
    const endDay = clampDay(end, year, month, dim);
    return { ...c, startDay: Math.min(startDay, endDay), endDay: Math.max(startDay, endDay), lane: 0 };
  });
  // Sort by start, then end, then id for determinism before lane assignment.
  laidOut.sort((a, b) => a.startDay - b.startDay || a.endDay - b.endDay || a.id - b.id);
  assignLanes(laidOut);
  const laneCount = Math.max(1, ...laidOut.map((c) => c.lane + 1));

  // SVG geometry. Width scales with day count; lane height fixed.
  const dayWidth = 36;
  const laneHeight = 28;
  const laneGap = 4;
  const headerHeight = 28;
  const leftGutter = 8;
  const width = leftGutter + dayWidth * dim + 8;
  const height = headerHeight + laneCount * (laneHeight + laneGap) + 8;
  const today = new Date().toISOString().slice(0, 10);
  const todayDay = today.startsWith(`${year}-${pad2(month)}-`)
    ? Number.parseInt(today.slice(8, 10), 10)
    : null;

  return (
    <Layout title={`Timeline · ${titleStr}`} user={user}>
      <style>{css}</style>
      <header class="tl-head">
        <h1 class="tl-title">{titleStr}</h1>
        <nav class="tl-nav">
          <a class="btn tl-nav-btn" href={`/timeline?year=${prev.year}&month=${prev.month}`}>← Prev</a>
          <a class="btn tl-nav-btn" href="/timeline">Today</a>
          <a class="btn tl-nav-btn" href={`/timeline?year=${next.year}&month=${next.month}`}>Next →</a>
        </nav>
        <span class="muted tl-count">{cards.length} card{cards.length === 1 ? '' : 's'} this month</span>
      </header>

      {laidOut.length === 0 ? (
        <p class="muted">No cards with dates in this month. Add a start date or due date to a card to see it here.</p>
      ) : (
        <div class="tl-wrap">
          <svg
            viewBox={`0 0 ${width} ${height}`}
            width={width}
            height={height}
            class="tl-svg"
            role="img"
            aria-label={`Timeline of ${cards.length} cards in ${titleStr}`}
          >
            {/* Day grid background. */}
            {Array.from({ length: dim }, (_, i) => i + 1).map((d) => {
              const x = leftGutter + (d - 1) * dayWidth;
              const dow = new Date(Date.UTC(year, month - 1, d)).getUTCDay();
              const weekend = dow === 0 || dow === 6;
              return (
                <g>
                  {weekend ? (
                    <rect x={x} y={headerHeight} width={dayWidth} height={height - headerHeight}
                          fill="rgba(128,128,128,0.06)" />
                  ) : null}
                  <line x1={x} y1={headerHeight} x2={x} y2={height}
                        stroke="rgba(128,128,128,0.18)" stroke-width="1" />
                  <text x={x + dayWidth / 2} y={headerHeight - 8} text-anchor="middle"
                        font-size="11" fill="currentColor" opacity="0.75">{d}</text>
                </g>
              );
            })}

            {/* Today line. */}
            {todayDay !== null ? (
              <line
                x1={leftGutter + (todayDay - 0.5) * dayWidth}
                y1={headerHeight - 4}
                x2={leftGutter + (todayDay - 0.5) * dayWidth}
                y2={height}
                stroke="#2563eb"
                stroke-width="2"
                opacity="0.65"
              />
            ) : null}

            {/* Card bars. */}
            {laidOut.map((c) => {
              const x = leftGutter + (c.startDay - 1) * dayWidth;
              const w = (c.endDay - c.startDay + 1) * dayWidth - 2;
              const y = headerHeight + c.lane * (laneHeight + laneGap);
              // Per-board column color overrides legacy default if set;
              //  TimelineCardRow doesn't carry the color yet (would need
              //  a JOIN), so the helper falls back to the column-key default.
              const fill = colorForColumn(c.column, null);
              const tooltip = `${c.title} · ${c.boardName}\n${c.startDate ?? ''}${c.dueDate ? ' → ' + c.dueDate : ''}`;
              return (
                <a href={`/kanban/c/${c.id}`} class="tl-bar-link">
                  <rect x={x + 1} y={y} width={Math.max(8, w)} height={laneHeight}
                        rx="4" fill={fill} fill-opacity="0.85" stroke={fill} stroke-width="1" />
                  <text x={x + 8} y={y + laneHeight / 2 + 4} font-size="12" fill="#fff" font-weight="600"
                        clip-path={`inset(0 ${Math.max(0, width - x - w + 6)}px 0 0)`}>
                    {c.title}
                  </text>
                  <title>{tooltip}</title>
                </a>
              );
            })}
          </svg>
        </div>
      )}
    </Layout>
  );
};

const css = `
  body:has(.tl-svg) .main { max-width: none; padding: 0 16px; }

  .tl-head { display: flex; gap: 16px; align-items: baseline; flex-wrap: wrap; }
  .tl-title { margin: 0; }
  .tl-nav { display: flex; gap: 6px; }
  .tl-nav-btn { padding: 6px 12px; font-size: 0.85em; }
  .tl-count { margin-left: auto; }
  .tl-wrap { overflow-x: auto; margin-top: 16px; border: 1px solid rgba(128,128,128,0.2); border-radius: 8px; padding: 8px; }
  .tl-svg { display: block; min-width: 100%; }
  .tl-bar-link { cursor: pointer; }
  .tl-bar-link:hover rect { fill-opacity: 1; }
`;
