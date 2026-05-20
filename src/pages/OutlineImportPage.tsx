/**
 * Outline import UI. Staff paste a hierarchical outline (typically from
 * Microsoft Word's Outline View) into a textarea, pick a target column,
 * and hit Preview. The server parses + replies with a rendered tree;
 * a Commit button then creates the cards.
 *
 * Preview/commit are two POSTs to the same route — `action=preview` or
 * `action=commit`. Commit always re-parses to avoid trusting a
 * tampered hidden field, then writes the tree atomically (best-effort:
 * D1 has no client-side transactions across createCard).
 */

import type { FC } from 'hono/jsx';
import { Layout } from './Layout';
import type { AuthUser } from '../env';
import type { BoardColumnConfigDto, BoardDto } from '../services/kanban.service';
import type { OutlineParseResult } from '../services/outline_import.service';
import type { OutlineNode } from '../services/kanban.service';

interface OutlineImportPageProps {
  user: AuthUser;
  board: BoardDto;
  columns: BoardColumnConfigDto[];
  /** Re-display the user's pasted text after a parse / error. */
  outlineText?: string;
  /** Selected target column key (for re-selecting on rerender). */
  selectedColumn?: string;
  /** Parse result for the preview pane. Undefined = no preview yet. */
  preview?: OutlineParseResult;
  flash?: { kind: 'ok' | 'err'; message: string };
}

/** Render one node + its descendants as a nested <ul>. Recursive. */
function TreeList({ nodes }: { nodes: OutlineNode[] }) {
  if (nodes.length === 0) return null;
  return (
    <ul class="outline-tree">
      {nodes.map((n) => (
        <li>
          <span class="outline-tree-title">{n.title}</span>
          {n.notes ? (
            <span class="outline-tree-notes" title={n.notes}>
              {n.notes.length > 80 ? n.notes.slice(0, 80) + '…' : n.notes}
            </span>
          ) : null}
          {n.children.length > 0 ? <TreeList nodes={n.children} /> : null}
        </li>
      ))}
    </ul>
  );
}

export const OutlineImportPage: FC<OutlineImportPageProps> = ({
  user, board, columns, outlineText, selectedColumn, preview, flash,
}) => {
  const action = `/kanban/${encodeURIComponent(board.slug)}/import-outline`;
  return (
    <Layout title={`Import outline · ${board.name}`} user={user}>
      <style>{css}</style>
      <h1>
        Import outline to <a href={`/kanban/${encodeURIComponent(board.slug)}`}>{board.name}</a>
      </h1>

      {flash ? <p class={`flash flash-${flash.kind}`}>{flash.message}</p> : null}

      <section class="card">
        <p>
          Paste a hierarchical outline (e.g. copied from Microsoft Word's
          <em> Outline View</em>, or any tool that produces indented or
          numbered lists). Indentation (tabs or spaces) <strong>or</strong> a
          numbered prefix like <code>1.2.3</code> defines the hierarchy.
          Lines without a bullet/number that follow a heading become its
          notes.
        </p>
        <p class="muted">
          Every card lands in the column you pick; move them around after.
          Max 500 cards per import; max 9 levels deep.
        </p>

        <form method="post" action={action}>
          <label>Outline
            <textarea
              name="outline"
              rows={14}
              placeholder={'Launch Mobile App\n\tBuild Login Screen\n\t\tDesign UI\n\t\tWrite API endpoint\n\tBuild Settings Screen\nLaunch Marketing Site'}
              required
            >{outlineText ?? ''}</textarea>
          </label>
          <label>Target column
            <select name="column">
              {columns.map((c) => (
                <option value={c.columnName} selected={selectedColumn === c.columnName}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          <div class="bulk-actions">
            <a class="btn" href={`/kanban/${encodeURIComponent(board.slug)}`}>Cancel</a>
            <button class="btn" type="submit" name="action" value="preview">Preview</button>
          </div>
        </form>
      </section>

      {preview ? (
        <section class="card">
          <h2 class="bulk-eyebrow">Preview — {preview.totalCards} card{preview.totalCards === 1 ? '' : 's'}, max depth {preview.maxDepth}</h2>
          {preview.warnings.length > 0 ? (
            <ul class="outline-warnings">
              {preview.warnings.map((w) => <li>{w}</li>)}
            </ul>
          ) : null}
          {preview.tree.length > 0 ? (
            <>
              <TreeList nodes={preview.tree} />
              <form method="post" action={action}>
                {/* Re-send the same outline + column. We re-parse on
                    commit (cheaper than smuggling the tree JSON through
                    a hidden field, and resistant to tampering). */}
                <input type="hidden" name="outline" value={outlineText ?? ''} />
                <input type="hidden" name="column" value={selectedColumn ?? ''} />
                <div class="bulk-actions">
                  <button class="btn btn-primary" type="submit" name="action" value="commit">
                    Create {preview.totalCards} card{preview.totalCards === 1 ? '' : 's'}
                  </button>
                </div>
              </form>
            </>
          ) : (
            <p class="muted">Nothing to create — adjust your outline and click Preview again.</p>
          )}
        </section>
      ) : null}

      <section class="card">
        <h2 class="bulk-eyebrow">Format tips</h2>
        <ul>
          <li><strong>From Microsoft Word:</strong> switch to View → Outline,
            collapse to the depth you want, then Ctrl+A and Ctrl+C. Paste
            here.</li>
          <li><strong>Numbered outlines</strong> ("1.", "1.1.", "1.1.1.")
            are detected automatically and do not need indentation.</li>
          <li>Bullet markers (<code>-</code> <code>*</code> <code>•</code>
            <code>1.</code> <code>A.</code>) at the start of a line are
            stripped from the card title.</li>
        </ul>
      </section>
    </Layout>
  );
};

const css = `
  .bulk-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; }
  .bulk-eyebrow { margin-top: 0; font-size: 0.9em; text-transform: uppercase; letter-spacing: 0.06em; opacity: 0.65; }
  textarea[name="outline"] {
    width: 100%; box-sizing: border-box;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.9em;
    tab-size: 2;
  }
  code {
    background: rgba(128,128,128,0.15); padding: 1px 4px; border-radius: 3px;
    font-size: 0.9em;
  }
  .outline-tree { list-style: none; padding-left: 18px; margin: 6px 0; }
  .outline-tree > li {
    position: relative; padding: 3px 0;
    border-left: 1px dashed rgba(128,128,128,0.35);
    padding-left: 12px; margin-left: 4px;
  }
  .outline-tree-title { font-weight: 500; }
  .outline-tree-notes {
    margin-left: 8px; font-size: 0.85em; opacity: 0.65;
    font-style: italic;
  }
  .outline-warnings {
    background: rgba(234,179,8,0.10); border: 1px solid rgba(234,179,8,0.35);
    border-radius: 4px; padding: 8px 12px 8px 28px; margin: 0 0 12px;
    font-size: 0.9em;
  }
`;
