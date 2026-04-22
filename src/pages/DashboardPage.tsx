/**
 * Dashboard — read-only aggregates over the kanban data + activity log.
 *
 * All charts are inline SVG with no client-side dependency. The shapes
 * are simple horizontal bars + a sparkline for the 30-day event trend.
 * Anything more elaborate would mean pulling in a chart library, which
 * is unjustified for fewer than ~50 data points per chart.
 */

import type { FC } from 'hono/jsx';
import { Layout } from './Layout';
import type { AuthUser } from '../env';
import type {
  AssigneeCardCount,
  BoardCardCount,
  ColumnName,
  DailyEventCount,
} from '../services/kanban.service';
import { colorForColumn } from '../util/colors';

interface DashboardPageProps {
  user: AuthUser;
  /** Active card counts per column, across all boards. */
  columnCounts: Record<ColumnName, number>;
  byBoard: BoardCardCount[];
  byAssignee: AssigneeCardCount[];
  eventTrend: DailyEventCount[];
}

const COLUMN_LABEL: Record<ColumnName, string> = {
  not_started: 'Not Started',
  started: 'Started',
  blocked: 'Blocked',
  ready: 'Ready',
  approval: 'Approval',
  done: 'Done',
};

const COLUMN_ORDER: ColumnName[] = [
  'not_started', 'started', 'blocked', 'ready', 'approval', 'done',
];


interface BarProps {
  label: string;
  value: number;
  max: number;
  color?: string;
  href?: string;
}

const Bar: FC<BarProps> = ({ label, value, max, color, href }) => {
  const pct = max > 0 ? (value / max) * 100 : 0;
  const fill = color ?? '#2563eb';
  const labelEl = href
    ? <a href={href} class="dash-bar-label">{label}</a>
    : <span class="dash-bar-label">{label}</span>;
  return (
    <div class="dash-bar-row">
      {labelEl}
      <div class="dash-bar-track">
        <div class="dash-bar-fill" style={`width: ${pct}%; background: ${fill}`} />
      </div>
      <span class="dash-bar-value">{value}</span>
    </div>
  );
};

/** Simple SVG sparkline. Width is fixed; height scales with `peak`. */
const Sparkline: FC<{ points: DailyEventCount[]; height?: number }> = ({ points, height = 64 }) => {
  if (points.length === 0) return <p class="muted">No activity in this window.</p>;
  const w = 720;
  const h = height;
  const peak = Math.max(1, ...points.map((p) => p.count));
  const stepX = points.length > 1 ? w / (points.length - 1) : 0;
  const path = points
    .map((p, i) => {
      const x = i * stepX;
      const y = h - (p.count / peak) * (h - 4) - 2;
      return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(' ');
  // Filled area under the line for visual heft.
  const fill = `${path} L ${(w).toFixed(1)} ${h} L 0 ${h} Z`;
  const total = points.reduce((sum, p) => sum + p.count, 0);
  return (
    <div class="dash-sparkline-wrap">
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" class="dash-sparkline" aria-label={`Events per day, peak ${peak}`}>
        <path d={fill} fill="rgba(37,99,235,0.18)" />
        <path d={path} fill="none" stroke="#2563eb" stroke-width="2" />
      </svg>
      <div class="dash-sparkline-legend">
        <span>{points[0].day}</span>
        <span class="muted">peak {peak} · total {total} events</span>
        <span>{points[points.length - 1].day}</span>
      </div>
    </div>
  );
};

export const DashboardPage: FC<DashboardPageProps> = ({
  user,
  columnCounts,
  byBoard,
  byAssignee,
  eventTrend,
}) => {
  const totalCards = COLUMN_ORDER.reduce((sum, c) => sum + (columnCounts[c] ?? 0), 0);
  const colMax = Math.max(1, ...COLUMN_ORDER.map((c) => columnCounts[c] ?? 0));
  const boardMax = Math.max(1, ...byBoard.map((b) => b.count));
  const assigneeMax = Math.max(1, ...byAssignee.map((a) => a.count));

  return (
    <Layout title="Dashboard" user={user}>
      <style>{css}</style>
      <h1>Dashboard</h1>
      <p class="muted">{totalCards} active card{totalCards === 1 ? '' : 's'} across {byBoard.length} board{byBoard.length === 1 ? '' : 's'}.</p>

      <section class="dash-card">
        <h2>By column</h2>
        <div class="dash-bars">
          {COLUMN_ORDER.map((c) => (
            <Bar
              label={COLUMN_LABEL[c]}
              value={columnCounts[c] ?? 0}
              max={colMax}
              color={colorForColumn(c, null)}
            />
          ))}
        </div>
      </section>

      <section class="dash-card">
        <h2>By board</h2>
        {byBoard.length === 0 ? (
          <p class="muted">No boards yet.</p>
        ) : (
          <div class="dash-bars">
            {byBoard.map((b) => (
              <Bar
                label={b.boardName}
                value={b.count}
                max={boardMax}
                href={`/kanban/${encodeURIComponent(b.boardSlug)}`}
              />
            ))}
          </div>
        )}
      </section>

      <section class="dash-card">
        <h2>Top assignees</h2>
        {byAssignee.length === 0 ? (
          <p class="muted">Nobody assigned to any cards yet.</p>
        ) : (
          <div class="dash-bars">
            {byAssignee.map((a) => (
              <Bar
                label={a.displayName || a.email}
                value={a.count}
                max={assigneeMax}
              />
            ))}
          </div>
        )}
      </section>

      <section class="dash-card">
        <h2>Activity (last 30 days)</h2>
        <Sparkline points={eventTrend} />
      </section>
    </Layout>
  );
};

const css = `
  .dash-card {
    border: 1px solid rgba(128,128,128,0.25); border-radius: 8px;
    padding: 16px 20px; margin: 16px 0;
  }
  .dash-card h2 { margin-top: 0; font-size: 1.05em; }
  .dash-bars { display: flex; flex-direction: column; gap: 6px; }
  .dash-bar-row {
    display: grid; grid-template-columns: 160px 1fr 50px;
    gap: 12px; align-items: center; font-size: 0.9em;
  }
  .dash-bar-label {
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    color: inherit; text-decoration: none;
  }
  a.dash-bar-label:hover { text-decoration: underline; }
  .dash-bar-track {
    background: rgba(128,128,128,0.15); border-radius: 4px;
    height: 16px; overflow: hidden;
  }
  .dash-bar-fill { height: 100%; transition: width 0.3s; }
  .dash-bar-value { font-variant-numeric: tabular-nums; text-align: right; }

  .dash-sparkline-wrap { display: flex; flex-direction: column; gap: 6px; }
  .dash-sparkline { width: 100%; height: 64px; display: block; }
  .dash-sparkline-legend {
    display: flex; justify-content: space-between; font-size: 0.8em;
    font-variant-numeric: tabular-nums; opacity: 0.8;
  }
`;
