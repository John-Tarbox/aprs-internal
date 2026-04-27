/**
 * Inline SVG illustrations for the Kanban 101 guide page. Hand-coded so
 * they version with the rest of the site, scale perfectly at any zoom,
 * and don't need asset hosting. Each component renders a self-contained
 * <svg> with currentColor + the brand variable for theming, so the
 * illustrations track light/dark scheme via CSS without inline color
 * forks.
 *
 * Style guidelines (consistent across all four):
 *   - viewBox is the only sizing source — width is 100% via CSS.
 *   - Strokes use currentColor so they respect dark mode.
 *   - Solid fills use semi-transparent currentColor (rgba via opacity)
 *     for a soft feel; brand-blue (var(--brand)) is the only true color
 *     accent and is used sparingly to draw attention.
 *   - aria-hidden="true" — the surrounding figure has the alt-equivalent
 *     caption, and these are decorative supporting visuals.
 */

import type { FC } from 'hono/jsx';

export const BoardsIllustration: FC = () => (
  <svg
    viewBox="0 0 720 240"
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden="true"
    focusable="false"
    class="guide-illus"
  >
    {[0, 1, 2].map((i) => {
      const x = 24 + i * 232;
      const titles = ['Marketing', 'Engineering', 'Operations'];
      return (
        <g>
          <rect x={x} y="20" width="208" height="200" rx="8" ry="8"
                fill="none" stroke="currentColor" stroke-opacity="0.35" stroke-width="1.5" />
          <rect x={x} y="20" width="208" height="32" rx="8" ry="8"
                fill="currentColor" fill-opacity="0.08" />
          <text x={x + 14} y={40} font-size="13" font-weight="600"
                fill="currentColor" fill-opacity="0.8">{titles[i]}</text>
          {/* three column hints with abstract cards */}
          {[0, 1, 2].map((c) => {
            const cx = x + 12 + c * 64;
            return (
              <g>
                <rect x={cx} y="64" width="56" height="144" rx="4" ry="4"
                      fill="currentColor" fill-opacity="0.04" />
                {[0, 1, 2].map((k) => (
                  <rect x={cx + 4} y={72 + k * 40} width="48" height="32" rx="3" ry="3"
                        fill="currentColor" fill-opacity={0.12 - k * 0.02} />
                ))}
              </g>
            );
          })}
        </g>
      );
    })}
  </svg>
);

export const ColumnsIllustration: FC = () => {
  const columnAccents = [
    'rgba(148,163,184,0.55)', // gray
    'rgba(56,189,248,0.55)',  // sky
    'rgba(234,179,8,0.55)',   // amber
    'rgba(34,197,94,0.55)',   // green
    'var(--brand)',           // brand blue (Done / spotlight)
  ];
  const titles = ['Backlog', 'In Progress', 'Blocked', 'Review', 'Done'];
  const cardCounts = [4, 3, 1, 2, 5];
  return (
    <svg
      viewBox="0 0 720 320"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-hidden="true"
      class="guide-illus"
    >
      <rect x="12" y="12" width="696" height="296" rx="10" ry="10"
            fill="none" stroke="currentColor" stroke-opacity="0.25" stroke-width="1.5" />
      {columnAccents.map((accent, i) => {
        const cx = 28 + i * 134;
        return (
          <g>
            <rect x={cx} y="32" width="120" height="260" rx="6" ry="6"
                  fill="currentColor" fill-opacity="0.05" />
            <rect x={cx} y="32" width="120" height="6" rx="3" ry="3" fill={accent} />
            <text x={cx + 10} y="56" font-size="11" font-weight="600"
                  fill="currentColor" fill-opacity="0.8">{titles[i]}</text>
            <text x={cx + 102} y="56" font-size="10" font-weight="600"
                  fill="currentColor" fill-opacity="0.5">{cardCounts[i]}</text>
            {Array.from({ length: cardCounts[i] }).map((_, k) => (
              <g>
                <rect x={cx + 8} y={72 + k * 38} width="104" height="30" rx="4" ry="4"
                      fill="currentColor" fill-opacity="0.08" />
                <rect x={cx + 14} y={78 + k * 38} width="64" height="6" rx="2" ry="2"
                      fill="currentColor" fill-opacity="0.4" />
                {/* tiny assignee dot */}
                <circle cx={cx + 102} cy={87 + k * 38} r="4"
                        fill="currentColor" fill-opacity="0.35" />
              </g>
            ))}
          </g>
        );
      })}
    </svg>
  );
};

export const CardIllustration: FC = () => (
  <svg
    viewBox="0 0 480 320"
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden="true"
    focusable="false"
    class="guide-illus"
  >
    {/* main card */}
    <rect x="60" y="40" width="360" height="240" rx="10" ry="10"
          fill="currentColor" fill-opacity="0.06"
          stroke="currentColor" stroke-opacity="0.3" stroke-width="1.5" />
    {/* cover band — brand accent */}
    <rect x="60" y="40" width="360" height="36" rx="10" ry="10" fill="var(--brand)" fill-opacity="0.85" />
    <rect x="60" y="66" width="360" height="10" fill="var(--brand)" fill-opacity="0.85" />
    {/* title */}
    <rect x="80" y="100" width="220" height="14" rx="3" ry="3"
          fill="currentColor" fill-opacity="0.7" />
    <rect x="80" y="124" width="160" height="10" rx="3" ry="3"
          fill="currentColor" fill-opacity="0.35" />
    {/* label chips */}
    <rect x="80" y="156" width="60" height="18" rx="9" ry="9"
          fill="rgba(234,179,8,0.4)" />
    <rect x="148" y="156" width="80" height="18" rx="9" ry="9"
          fill="rgba(34,197,94,0.4)" />
    {/* assignee avatars */}
    <circle cx="350" cy="165" r="12" fill="currentColor" fill-opacity="0.35" />
    <circle cx="372" cy="165" r="12" fill="currentColor" fill-opacity="0.5" />
    {/* due date pill */}
    <rect x="80" y="196" width="92" height="22" rx="6" ry="6"
          fill="currentColor" fill-opacity="0.1"
          stroke="currentColor" stroke-opacity="0.3" stroke-width="1" />
    <text x="92" y="211" font-size="11" font-weight="600"
          fill="currentColor" fill-opacity="0.75">Due Mar 15</text>
    {/* checklist progress */}
    <text x="80" y="248" font-size="10" font-weight="600"
          fill="currentColor" fill-opacity="0.55">Checklist · 3 / 5</text>
    <rect x="80" y="256" width="320" height="8" rx="4" ry="4"
          fill="currentColor" fill-opacity="0.1" />
    <rect x="80" y="256" width="192" height="8" rx="4" ry="4" fill="var(--brand)" fill-opacity="0.7" />
  </svg>
);

export const ControlsIllustration: FC = () => (
  <svg
    viewBox="0 0 720 96"
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden="true"
    focusable="false"
    class="guide-illus"
  >
    {/* search input */}
    <rect x="16" y="28" width="280" height="40" rx="6" ry="6"
          fill="currentColor" fill-opacity="0.06"
          stroke="currentColor" stroke-opacity="0.3" stroke-width="1" />
    <circle cx="36" cy="48" r="6" fill="none" stroke="currentColor" stroke-opacity="0.55" stroke-width="1.5" />
    <line x1="40" y1="52" x2="46" y2="58" stroke="currentColor" stroke-opacity="0.55" stroke-width="1.5" stroke-linecap="round" />
    <text x="56" y="52" font-size="12" fill="currentColor" fill-opacity="0.5">Search…</text>

    {/* filter chips */}
    {['assigned:', 'label:', 'column:'].map((t, i) => {
      const cx = 312 + i * 84;
      return (
        <g>
          <rect x={cx} y="34" width="76" height="28" rx="14" ry="14"
                fill="currentColor" fill-opacity="0.08"
                stroke="currentColor" stroke-opacity="0.25" stroke-width="1" />
          <text x={cx + 12} y="52" font-size="11"
                font-family="ui-monospace, SFMono-Regular, Menlo, monospace"
                fill="currentColor" fill-opacity="0.7">{t}</text>
        </g>
      );
    })}

    {/* view switcher */}
    {['Kanban', 'Table', 'Calendar'].map((t, i) => {
      const cx = 568 + i * 50;
      const selected = i === 0;
      return (
        <g>
          <rect x={cx} y="34" width="48" height="28"
                rx={i === 0 ? '6' : i === 2 ? '6' : '0'} ry={i === 0 ? '6' : i === 2 ? '6' : '0'}
                fill={selected ? 'var(--brand)' : 'currentColor'}
                fill-opacity={selected ? '0.85' : '0.06'}
                stroke="currentColor" stroke-opacity="0.25" stroke-width="1" />
          <text x={cx + 24} y="52" font-size="10" font-weight="600"
                text-anchor="middle"
                fill={selected ? '#fff' : 'currentColor'}
                fill-opacity={selected ? '1' : '0.7'}>{t}</text>
        </g>
      );
    })}
  </svg>
);
