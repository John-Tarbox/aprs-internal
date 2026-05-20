/**
 * Outline-to-tree parser. Staff paste a hierarchical outline (typically
 * copied from Microsoft Word's Outline View) and we turn it into a
 * tree of OutlineNodes that bulkCreateCardTree can ingest.
 *
 * Three input styles are recognized, in priority order:
 *
 *   1. Tab indentation        "\tBuild login screen"
 *   2. Space indentation      "  Build login screen"  (2- or 4-space step,
 *                                                     autodetected per-doc)
 *   3. Numbered prefix        "1.2.3 Build login screen"  (also I.A.1, etc.)
 *
 * Bullet markers at the start of a line are stripped before nesting is
 * computed: "- foo", "* foo", "• foo", "1. foo", "1) foo" all become
 * "foo" once their indentation has been read.
 *
 * Body paragraphs (non-empty lines at the same indent level as the
 * preceding heading, but starting with no bullet marker) become the
 * card's notes. The first line at any indent level is always treated as
 * the card title; subsequent lines at the SAME indent without a bullet
 * are appended to that card's notes until a deeper indent or a sibling
 * starts a new card.
 *
 * Lossy rules:
 *  - Empty lines are paragraph separators inside notes, otherwise ignored.
 *  - More than 9 levels of indentation collapses to 9; warned.
 *  - More than 500 cards aborts; the caller should resubmit a smaller
 *    outline (mirrors CSV import's MAX_IMPORT_ROWS).
 */

import type { OutlineNode } from './kanban.service';

export const MAX_OUTLINE_CARDS = 500;
export const MAX_OUTLINE_DEPTH = 9;

export interface OutlineParseResult {
  tree: OutlineNode[];
  /** Flat count for the preview screen ("Create 23 cards"). */
  totalCards: number;
  /** Deepest level encountered (1 = top-level only). */
  maxDepth: number;
  /** Human-readable parse warnings (over-deep, over-count, etc.). */
  warnings: string[];
}

interface RawLine {
  /** Indent level in source units (tab count or space count). */
  rawIndent: number;
  /** Numbered-prefix depth if the line is "1.2 Foo" style; else 0. */
  numberedDepth: number;
  /** Title text with bullets/numbering stripped. */
  text: string;
  /** True when the line has a bullet/number marker — these always
   *  start a NEW card. Plain text without a marker at the same indent
   *  flows into the preceding card's notes. */
  isHeading: boolean;
}

/** Strip the most common bullet/numbering prefixes. Returns the cleaned
 *  text and whether a marker was actually found (callers use that to
 *  decide heading-vs-notes). */
function stripMarker(s: string): { text: string; hadMarker: boolean } {
  // Roman / alpha / digit numbered: "1.", "1.2.3", "1)", "I.", "A."
  let m = s.match(/^([0-9]+(?:\.[0-9]+)*[.)]|[IVXLCDM]+\.|[A-Z]\.)\s+(.*)$/);
  if (m) return { text: m[2], hadMarker: true };
  // Bullet glyphs commonly produced by Word/Google Docs/Markdown.
  m = s.match(/^([-*•●○◦▪▫–—])\s+(.*)$/);
  if (m) return { text: m[2], hadMarker: true };
  return { text: s, hadMarker: false };
}

/** Returns the dotted-prefix depth of "1.2.3 Foo" style lines, else 0. */
function numberedPrefixDepth(s: string): number {
  const m = s.match(/^([0-9]+(?:\.[0-9]+)*)(?:[.)])\s+/);
  if (!m) return 0;
  // "1." -> 1 segment -> depth 1; "1.2.3." -> 3 segments -> depth 3.
  return m[1].split('.').length;
}

/** Detect the indent unit for space-indented outlines. Walks every
 *  line, takes the smallest non-zero leading-space count, and snaps to
 *  the nearest of 2 or 4 (Word's default is 0.5" which renders as ~4
 *  spaces in plain-text paste). Defaults to 2. */
function detectSpaceIndent(lines: string[]): number {
  let smallest = Infinity;
  for (const line of lines) {
    const m = line.match(/^( +)/);
    if (!m) continue;
    if (m[1].length > 0 && m[1].length < smallest) smallest = m[1].length;
  }
  if (smallest === Infinity) return 2;
  // Snap to 2 or 4 (whichever the smallest non-zero indent is closer to).
  return Math.abs(smallest - 4) < Math.abs(smallest - 2) ? 4 : 2;
}

/** First pass: classify every non-empty line into a RawLine. The
 *  classification is purely textual; the second pass turns these into
 *  a tree using whichever indent signal dominates. */
function classifyLines(input: string): RawLine[] {
  const lines = input.replace(/\r\n?/g, '\n').split('\n');
  const spaceUnit = detectSpaceIndent(lines);
  const out: RawLine[] = [];
  for (const rawLine of lines) {
    // Preserve completely blank lines as paragraph separators inside
    // notes (handled in pass 2); skip whitespace-only lines.
    if (/^\s*$/.test(rawLine)) {
      out.push({ rawIndent: -1, numberedDepth: 0, text: '', isHeading: false });
      continue;
    }
    let indent = 0;
    let body = rawLine;
    const tabMatch = body.match(/^(\t+)/);
    if (tabMatch) {
      indent = tabMatch[1].length;
      body = body.slice(tabMatch[1].length);
    } else {
      const spaceMatch = body.match(/^( +)/);
      if (spaceMatch) {
        indent = Math.floor(spaceMatch[1].length / spaceUnit);
        body = body.slice(spaceMatch[1].length);
      }
    }
    body = body.trim();
    const numberedDepth = numberedPrefixDepth(body);
    const { text, hadMarker } = stripMarker(body);
    // A line is a heading when it has a marker OR is indented relative
    // to the prior line. Whether "indented relative" applies is decided
    // in pass 2; here we only record `hadMarker`. Pass 2 also treats
    // every indent-0 line as a heading start when the previous heading
    // is closed (next blank line or de-dent).
    out.push({
      rawIndent: indent,
      numberedDepth,
      text,
      isHeading: hadMarker,
    });
  }
  return out;
}

/** Second pass: walk the classified lines and build a tree.
 *
 *  Strategy: maintain a stack of "currently-open" ancestor nodes
 *  indexed by depth. Each new heading line picks its parent from the
 *  stack at depth - 1. Continuation lines (no marker, same indent as
 *  the immediately-preceding heading) append to the open node's notes.
 */
export function parseOutline(input: string): OutlineParseResult {
  const warnings: string[] = [];
  const raw = classifyLines(input);
  // Decide which indent signal to honor. Numbered-prefix depth wins
  // when ANY line has it (Word's "1. 1.1 1.1.1" outlines are usually
  // pasted without indentation). Otherwise tab/space indentation is
  // already encoded in rawIndent.
  const anyNumbered = raw.some((l) => l.numberedDepth > 0);
  let depthOf = (l: RawLine): number => l.rawIndent;
  if (anyNumbered) {
    depthOf = (l) => (l.numberedDepth > 0 ? l.numberedDepth - 1 : 0);
  }

  const roots: OutlineNode[] = [];
  // stack[k] is the most-recently-opened node at depth k (its
  // .children array is where depth-(k+1) headings get appended).
  const stack: (OutlineNode | null)[] = [];
  // Held in an object so the closures inside pushHeading/appendNotes
  // mutate a shared reference rather than rebinding a local — keeps
  // TypeScript's control-flow analysis from narrowing this to `never`
  // at the call site below.
  const state: { lastOpen: OutlineNode | null; lastDepth: number } = {
    lastOpen: null,
    lastDepth: -1,
  };
  let totalCards = 0;
  let maxDepthSeen = 0;
  let overDepthWarned = false;
  let overCountWarned = false;

  function pushHeading(rawDepth: number, title: string): void {
    if (totalCards >= MAX_OUTLINE_CARDS) {
      if (!overCountWarned) {
        warnings.push(
          `Outline exceeds ${MAX_OUTLINE_CARDS} cards — extra lines were dropped.`
        );
        overCountWarned = true;
      }
      return;
    }
    let depth = rawDepth;
    if (depth >= MAX_OUTLINE_DEPTH) {
      if (!overDepthWarned) {
        warnings.push(
          `Outline goes deeper than ${MAX_OUTLINE_DEPTH} levels — deeper items were collapsed.`
        );
        overDepthWarned = true;
      }
      depth = MAX_OUTLINE_DEPTH - 1;
    }
    const node: OutlineNode = { title, notes: null, children: [] };
    if (depth === 0) {
      roots.push(node);
    } else {
      // Walk up until we find an ancestor at depth - 1. If the user
      // skipped a level (depth 0 -> depth 2 with no depth-1 between),
      // we re-parent under whatever is the closest open ancestor.
      let parentDepth = depth - 1;
      while (parentDepth >= 0 && !stack[parentDepth]) parentDepth--;
      if (parentDepth < 0) {
        roots.push(node);
        depth = 0;
      } else {
        stack[parentDepth]!.children.push(node);
        depth = parentDepth + 1;
      }
    }
    // Truncate the stack above the new node and install it.
    stack.length = depth + 1;
    stack[depth] = node;
    state.lastOpen = node;
    state.lastDepth = depth;
    if (depth + 1 > maxDepthSeen) maxDepthSeen = depth + 1;
    totalCards++;
  }

  function appendNotes(text: string): void {
    const open = state.lastOpen;
    if (!open) return; // notes before any heading are dropped
    if (open.notes && open.notes.length > 0) {
      open.notes += '\n' + text;
    } else {
      open.notes = text;
    }
  }

  let pendingBlank = false;
  for (const line of raw) {
    if (line.rawIndent === -1 && line.text === '') {
      // Blank line — paragraph separator inside notes; ignored if no
      // open card.
      pendingBlank = true;
      continue;
    }
    const depth = Math.max(0, depthOf(line));
    const looksLikeHeading =
      line.isHeading || depth !== state.lastDepth || state.lastOpen === null;
    if (looksLikeHeading) {
      pushHeading(depth, line.text.slice(0, 200));
      pendingBlank = false;
    } else {
      // Continuation paragraph at the same level. Preserve a paragraph
      // break if a blank line preceded it.
      const open = state.lastOpen;
      if (pendingBlank && open && open.notes) open.notes += '\n';
      appendNotes(line.text);
      pendingBlank = false;
    }
  }

  // Trim notes — leading/trailing whitespace from accumulation +
  // 10k cap matching createCard's notes limit.
  function trimNotes(n: OutlineNode): void {
    if (n.notes) {
      const trimmed = n.notes.replace(/^\s+|\s+$/g, '');
      n.notes = trimmed.length > 10_000 ? trimmed.slice(0, 10_000) : trimmed;
      if (n.notes.length === 0) n.notes = null;
    }
    n.children.forEach(trimNotes);
  }
  roots.forEach(trimNotes);

  if (totalCards === 0) {
    warnings.push('No outline rows were detected. Paste content with one item per line.');
  }
  return {
    tree: roots,
    totalCards,
    maxDepth: maxDepthSeen,
    warnings,
  };
}
