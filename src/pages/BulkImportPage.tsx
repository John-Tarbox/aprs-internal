/**
 * Bulk CSV import UI (P7). Single-page form: file input + target
 * column dropdown + submit. Server parses + validates + commits on
 * POST; any errors / warnings render inline on the same page after
 * the redirect-with-flash pattern.
 */

import type { FC } from 'hono/jsx';
import { Layout } from './Layout';
import type { AuthUser } from '../env';
import type { BoardColumnConfigDto, BoardDto } from '../services/kanban.service';

interface BulkImportPageProps {
  user: AuthUser;
  board: BoardDto;
  columns: BoardColumnConfigDto[];
  flash?: { kind: 'ok' | 'err'; message: string };
}

export const BulkImportPage: FC<BulkImportPageProps> = ({ user, board, columns, flash }) => {
  return (
    <Layout title={`Bulk import · ${board.name}`} user={user}>
      <style>{css}</style>
      <h1>Bulk import to <a href={`/kanban/${encodeURIComponent(board.slug)}`}>{board.name}</a></h1>

      {flash ? (
        <p class={`flash flash-${flash.kind}`}>{flash.message}</p>
      ) : null}

      <section class="card">
        <p>
          Upload a CSV with a header row. Recognized columns (case-insensitive):
          <code> title</code> (required),
          <code> notes</code>,
          <code> assigned</code>,
          <code> labels</code> (pipe- or comma-separated; <code>groups</code> accepted as an alias).
        </p>
        <p class="muted">Unknown columns are ignored. Empty-title rows are skipped. Max 500 rows per import; anything above is truncated with a warning.</p>

        <form method="post" action={`/kanban/${encodeURIComponent(board.slug)}/import`} enctype="multipart/form-data">
          <label>CSV file
            <input type="file" name="file" accept=".csv,text/csv" required />
          </label>
          <label>Target column
            <select name="column">
              {columns.map((c) => (
                <option value={c.columnName}>{c.label}</option>
              ))}
            </select>
          </label>
          <div class="bulk-actions">
            <a class="btn" href={`/kanban/${encodeURIComponent(board.slug)}`}>Cancel</a>
            <button class="btn btn-primary" type="submit">Import</button>
          </div>
        </form>
      </section>

      <section class="card">
        <h2 class="bulk-eyebrow">Example CSV</h2>
        <pre class="bulk-example">title,notes,assigned,labels{'\n'}Fix login bug,Blocks Okta users,John,bug|urgent{'\n'}Review Q2 plan,,Lion,planning</pre>
      </section>
    </Layout>
  );
};

const css = `
  .bulk-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; }
  .bulk-eyebrow { margin-top: 0; font-size: 0.9em; text-transform: uppercase; letter-spacing: 0.06em; opacity: 0.65; }
  .bulk-example {
    background: rgba(128,128,128,0.1); padding: 10px 12px; border-radius: 4px;
    font-size: 0.85em; overflow-x: auto;
  }
  code {
    background: rgba(128,128,128,0.15); padding: 1px 4px; border-radius: 3px;
    font-size: 0.9em;
  }
`;
