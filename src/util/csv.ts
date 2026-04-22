/**
 * Tiny RFC 4180-shaped CSV parser. No dependency. Handles:
 *   - Quoted fields: "a, b" → a, b
 *   - Escaped quotes inside quoted fields: "he said ""hi""" → he said "hi"
 *   - CRLF or LF line endings
 *   - Trailing newline tolerated
 *
 * Returns rows of string[]. Caller is responsible for interpreting the
 * first row as a header if wanted (parseCsv doesn't assume).
 */

export function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let i = 0;
  let inQuotes = false;
  const n = input.length;

  while (i < n) {
    const ch = input[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < n && input[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      row.push(field);
      field = '';
      i += 1;
      continue;
    }
    if (ch === '\r') {
      // Treat CRLF or lone CR as a line break.
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += 1;
      if (i < n && input[i] === '\n') i += 1;
      continue;
    }
    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  // Flush any pending field/row (file didn't end in a newline).
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * Map header names → column indexes, case-insensitive and whitespace-
 * tolerant. Returns null for headers not found. Useful for lining up a
 * user's CSV columns with known card fields ("title", "notes", etc.).
 */
export function indexHeaders(
  headerRow: string[],
  wanted: string[]
): Record<string, number | null> {
  const norm = (s: string) => s.trim().toLowerCase();
  const byName = new Map<string, number>();
  headerRow.forEach((h, idx) => {
    byName.set(norm(h), idx);
  });
  const out: Record<string, number | null> = {};
  for (const w of wanted) {
    out[w] = byName.has(norm(w)) ? (byName.get(norm(w)) as number) : null;
  }
  return out;
}
