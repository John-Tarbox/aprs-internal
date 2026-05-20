/**
 * Read-only outline view of a board (added 2026-05). Renders the
 * parent/child tree of active cards as a nested numbered list using
 * Word's classic 1 / a / i / 1 / a / i marker rotation per depth.
 *
 * The shape mirrors what the outline-import path consumes, so a board
 * imported from a Word outline can be displayed back in roughly the
 * same form. Cards without a parent (or whose parent is archived) are
 * top-level roots; their column appears as a small chip next to the
 * title.
 *
 * Click a title to jump to the board with that card's modal open
 * (using the existing ?card=N query-param deep-link).
 */

import type { FC } from 'hono/jsx';
import { Layout } from './Layout';
import type { AuthUser } from '../env';
import type {
  BoardColumnConfigDto,
  BoardDto,
  CardDto,
} from '../services/kanban.service';

interface OutlineViewPageProps {
  user: AuthUser;
  board: BoardDto;
  cards: CardDto[];
  columns: BoardColumnConfigDto[];
}

/** Tree node built from the flat CardDto list. We don't reuse OutlineNode
 *  from the parser because that one's intentionally tiny (title/notes);
 *  this view wants the full card metadata for chips + the deep-link. */
interface OutlineCardNode {
  card: CardDto;
  children: OutlineCardNode[];
}

/** Build the parent/child forest. Roots are cards whose parent is null
 *  OR whose parent isn't in the active set (archived parents). Sort
 *  siblings by (column position, then card position within column,
 *  then id) so the outline reads top-down / left-to-right in the same
 *  order as the board. */
function buildForest(
  cards: CardDto[],
  columnPosByKey: Map<string, number>
): OutlineCardNode[] {
  const byId = new Map<number, CardDto>();
  for (const c of cards) byId.set(c.id, c);

  const childrenByParent = new Map<number | null, OutlineCardNode[]>();
  for (const card of cards) {
    const effectiveParent =
      card.parentCardId != null && byId.has(card.parentCardId)
        ? card.parentCardId
        : null;
    if (!childrenByParent.has(effectiveParent)) {
      childrenByParent.set(effectiveParent, []);
    }
    childrenByParent.get(effectiveParent)!.push({ card, children: [] });
  }

  function sortSiblings(nodes: OutlineCardNode[]): void {
    nodes.sort((a, b) => {
      const aColPos = columnPosByKey.get(a.card.column) ?? 999;
      const bColPos = columnPosByKey.get(b.card.column) ?? 999;
      if (aColPos !== bColPos) return aColPos - bColPos;
      if (a.card.position !== b.card.position) {
        return a.card.position - b.card.position;
      }
      return a.card.id - b.card.id;
    });
  }

  function attach(node: OutlineCardNode): void {
    const kids = childrenByParent.get(node.card.id);
    if (!kids) return;
    sortSiblings(kids);
    for (const k of kids) attach(k);
    node.children = kids;
  }

  const roots = childrenByParent.get(null) ?? [];
  sortSiblings(roots);
  for (const r of roots) attach(r);
  return roots;
}

/** Pick the OL `type` attribute based on depth, rotating like Word:
 *  0 → "1", 1 → "a", 2 → "i", 3 → "1", 4 → "a", 5 → "i", ...
 *  Browsers honor `type` on ordered lists and render the corresponding
 *  marker glyphs, so we don't have to compose marker text ourselves. */
function olTypeForDepth(depth: number): '1' | 'a' | 'i' {
  switch (depth % 3) {
    case 0: return '1';
    case 1: return 'a';
    default: return 'i';
  }
}

const OutlineList: FC<{
  nodes: OutlineCardNode[];
  depth: number;
  boardSlug: string;
  columnLabels: Map<string, string>;
}> = ({ nodes, depth, boardSlug, columnLabels }) => {
  if (nodes.length === 0) return null;
  return (
    <ol class={`outline-list outline-depth-${depth}`} type={olTypeForDepth(depth)}>
      {nodes.map((n) => (
        <li>
          <a class="outline-title" href={`/kanban/${encodeURIComponent(boardSlug)}?card=${n.card.id}`}>
            {n.card.title}
          </a>
          <span class="outline-col-chip">{columnLabels.get(n.card.column) ?? n.card.column}</span>
          {n.card.notes ? (
            <div class="outline-notes">{n.card.notes}</div>
          ) : null}
          {n.children.length > 0 ? (
            <OutlineList
              nodes={n.children}
              depth={depth + 1}
              boardSlug={boardSlug}
              columnLabels={columnLabels}
            />
          ) : null}
        </li>
      ))}
    </ol>
  );
};

export const OutlineViewPage: FC<OutlineViewPageProps> = ({ user, board, cards, columns }) => {
  const columnPosByKey = new Map(columns.map((c) => [c.columnName, c.position]));
  const columnLabels = new Map(columns.map((c) => [c.columnName, c.label]));
  const tree = buildForest(cards, columnPosByKey);

  return (
    <Layout title={`Outline · ${board.name}`} user={user}>
      <style>{css}</style>
      <div class="outline-head">
        <h1>
          <a class="outline-back" href={`/kanban/${encodeURIComponent(board.slug)}`}>← {board.name}</a>
          {' '}— outline
        </h1>
        <p class="muted outline-summary">
          {cards.length} active card{cards.length === 1 ? '' : 's'}, {tree.length} top-level item{tree.length === 1 ? '' : 's'}.
          Click any title to open the card on the board.
        </p>
      </div>

      {tree.length === 0 ? (
        <p class="muted">This board has no active cards yet.</p>
      ) : (
        <OutlineList
          nodes={tree}
          depth={0}
          boardSlug={board.slug}
          columnLabels={columnLabels}
        />
      )}
    </Layout>
  );
};

const css = `
  .outline-head h1 { margin: 0 0 4px 0; }
  .outline-back { text-decoration: none; color: inherit; opacity: 0.7; }
  .outline-back:hover { opacity: 1; text-decoration: underline; }
  .outline-summary { margin: 0 0 16px 0; font-size: 0.9em; }

  /* Nested OL — browser-native markers, just tightened indent. */
  .outline-list {
    margin: 0;
    padding-inline-start: 28px;
  }
  .outline-list > li {
    margin: 6px 0;
    line-height: 1.5;
  }
  .outline-title {
    color: inherit;
    text-decoration: none;
    font-weight: 500;
  }
  .outline-title:hover {
    text-decoration: underline;
  }
  .outline-col-chip {
    display: inline-block;
    margin-left: 8px;
    padding: 1px 8px;
    font-size: 0.75em;
    background: rgba(128,128,128,0.15);
    border-radius: 999px;
    vertical-align: middle;
    opacity: 0.75;
  }
  .outline-notes {
    margin: 2px 0 4px 0;
    padding: 4px 10px;
    font-size: 0.88em;
    opacity: 0.75;
    border-left: 2px solid rgba(128,128,128,0.3);
    white-space: pre-wrap;
  }

  /* Print: drop the chrome, expand notes, force black-on-white so the
     output works as a handout. */
  @media print {
    .outline-back, .outline-summary, .outline-col-chip { display: none; }
    .outline-notes {
      color: #333; opacity: 1; border-left-color: #888;
    }
    .outline-title { color: #000; }
  }
`;
