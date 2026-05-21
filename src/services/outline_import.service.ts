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

/** Marker class used by Word-style multilevel outlines. Each class is
 *  treated as an independent "series" — depth comes from the order in
 *  which new series open, not from indentation. */
type MarkerStyle =
  | 'numeric'         // 1. 2. 3.   (or 1) 2) 3))
  | 'numeric_dotted'  // 1.2.3      (explicit depth = dot count)
  | 'alpha_lower'     // a. b. c.
  | 'alpha_upper'     // A. B. C.
  | 'roman_lower'     // i. ii. iii.
  | 'roman_upper'     // I. II. III.
  | 'bullet'          // - * •
  | 'none';

interface MarkerInfo {
  style: MarkerStyle;
  /** 1-based ordinal within the series — drives the "is this a new
   *  series" (value === 1) vs "continuation" check. 0 for bullets. */
  value: number;
  /** Body text with the marker stripped (single space-trimmed). */
  text: string;
  /** For numeric_dotted only: the explicit dot-count depth. */
  dottedDepth: number;
  /** The original marker token (e.g. "1", "a", "ii", "iv"). Lets the
   *  depth-assigner spot the alpha-vs-roman ambiguity for single
   *  letters like "i" / "v" that could be either. */
  literal: string;
}

interface RawLine {
  /** Indent level in source units (tab count or space count). */
  rawIndent: number;
  /** Marker style + value + cleaned text. style==='none' for plain
   *  body paragraphs (which flow into the previous heading's notes). */
  marker: MarkerInfo;
}

/** Word's roman-numeral pattern. Cheap regex test — we don't validate
 *  that "iiii" isn't a "real" roman numeral, but in outline context
 *  any sequence of [ivxlcdm]+ followed by a marker punctuator is
 *  almost certainly meant as a roman ordinal. */
const ROMAN_LOWER_RE = /^([ivxlcdm]+)$/;
const ROMAN_UPPER_RE = /^([IVXLCDM]+)$/;

function romanToInt(s: string): number {
  const map: Record<string, number> = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };
  const lower = s.toLowerCase();
  let total = 0;
  for (let i = 0; i < lower.length; i++) {
    const cur = map[lower[i]] ?? 0;
    const next = map[lower[i + 1]] ?? 0;
    total += cur < next ? -cur : cur;
  }
  return total;
}

/** Classify a (left-trimmed) line by its marker. Returns marker.style ===
 *  'none' for plain body text. Ambiguous singletons like "i." (roman 1
 *  vs the 9th letter) are returned as roman_lower when multi-char or
 *  when only roman_lower would make sense; the caller breaks the tie
 *  during depth assignment if needed. */
function classifyMarker(line: string): MarkerInfo {
  // 1. Dotted numeric (1.2.3 or 1.2.3.) — explicit depth.
  let m = line.match(/^([0-9]+(?:\.[0-9]+)+)[.)]?\s+(.*)$/);
  if (m) {
    return {
      style: 'numeric_dotted',
      value: 0,
      dottedDepth: m[1].split('.').length,
      text: m[2],
      literal: m[1],
    };
  }
  // 2. Numeric single (1. 2. 3.) or with parenthesis (1) 2)).
  m = line.match(/^([0-9]+)[.)]\s+(.*)$/);
  if (m) {
    const v = parseInt(m[1], 10);
    return { style: 'numeric', value: v, dottedDepth: 0, text: m[2], literal: m[1] };
  }
  // 3. Multi-letter lowercase tokens — could be roman (ii, iii, iv) or
  //    just alpha (only single letter is alpha in standard outlines).
  m = line.match(/^([a-z]+)[.)]\s+(.*)$/);
  if (m) {
    const tok = m[1];
    if (tok.length > 1 && ROMAN_LOWER_RE.test(tok)) {
      return { style: 'roman_lower', value: romanToInt(tok), dottedDepth: 0, text: m[2], literal: tok };
    }
    if (tok.length === 1) {
      // Single letter — ambiguous between alpha_lower (a..z) and
      // roman_lower (i, v, x, l, c, d, m). Default to alpha_lower; the
      // depth assigner promotes to roman_lower based on the literal
      // character if alpha doesn't fit the active series stack.
      const v = tok.charCodeAt(0) - 96;
      return { style: 'alpha_lower', value: v, dottedDepth: 0, text: m[2], literal: tok };
    }
    return { style: 'none', value: 0, dottedDepth: 0, text: line, literal: '' };
  }
  // 4. Uppercase tokens — same logic.
  m = line.match(/^([A-Z]+)[.)]\s+(.*)$/);
  if (m) {
    const tok = m[1];
    if (tok.length > 1 && ROMAN_UPPER_RE.test(tok)) {
      return { style: 'roman_upper', value: romanToInt(tok), dottedDepth: 0, text: m[2], literal: tok };
    }
    if (tok.length === 1) {
      const v = tok.charCodeAt(0) - 64;
      return { style: 'alpha_upper', value: v, dottedDepth: 0, text: m[2], literal: tok };
    }
    return { style: 'none', value: 0, dottedDepth: 0, text: line, literal: '' };
  }
  // 5. Bullet glyphs.
  m = line.match(/^([-*•●○◦▪▫–—])\s+(.*)$/);
  if (m) return { style: 'bullet', value: 0, dottedDepth: 0, text: m[2], literal: '' };
  // 6. No marker — body text.
  return { style: 'none', value: 0, dottedDepth: 0, text: line, literal: '' };
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

/** First pass: classify every non-empty line into a RawLine.
 *  Each line ends up with (a) its leading indent in source units and
 *  (b) its marker info. The second pass assigns depth using whichever
 *  signal works for the document. */
function classifyLines(input: string): RawLine[] {
  const lines = input.replace(/\r\n?/g, '\n').split('\n');
  const spaceUnit = detectSpaceIndent(lines);
  const out: RawLine[] = [];
  for (const rawLine of lines) {
    if (/^\s*$/.test(rawLine)) {
      out.push({
        rawIndent: -1,
        marker: { style: 'none', value: 0, dottedDepth: 0, text: '', literal: '' },
      });
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
    out.push({
      rawIndent: indent,
      marker: classifyMarker(body.trim()),
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

  // Three depth strategies, picked per-line:
  //
  // 1. Dotted-numeric (1.2.3) — always honored when present on that line.
  // 2. Marker series stack — when ANY line has a marker, depth comes
  //    from the series the marker belongs to: each new "first" item
  //    (value=1, "a", "i", "I") opens a new deeper series; continuations
  //    truncate the stack back to the level that matches the marker
  //    style. This handles Word's classic 1/a/i/1 nesting where depth
  //    is implicit in the marker class, not indentation.
  // 3. Tab/space indentation — fallback when neither of the above apply
  //    (lines without markers get their depth from indent).
  //
  // Markers and indentation can also combine — an explicitly indented
  // "1." line opens its series at that indent depth.
  const anyMarker = raw.some(
    (l) => l.marker.style !== 'none' && l.marker.style !== 'bullet'
  );

  // The active series stack: stack[k] tells us which marker style +
  // last-seen value is "open" at depth k. Bullets and plain text don't
  // sit on the stack — they just inherit the current depth.
  const seriesStack: { style: MarkerStyle; lastValue: number }[] = [];

  /** Decide what depth a line's marker should land at, mutating the
   *  seriesStack to reflect the new state. Returns the chosen depth.
   *
   *  Rule: a value=1 marker (or the alpha "a", or "i"/"I" for roman) is
   *  the START of a new series — these always open a fresh deeper
   *  level, with depth = previous-heading-depth + 1. Continuations
   *  (value > 1) look for the existing series by style on the stack and
   *  resume at that depth.
   *
   *  This is what handles Word's classic 1/a/i/1 nesting: when a "1."
   *  appears after an "i." (depth 2), it's recognized as starting a new
   *  numeric sub-series at depth 3, even though numeric is already open
   *  at depth 0. */
  function placeInSeries(style: MarkerStyle, value: number): number {
    if (value === 1) {
      const newDepth = state.lastDepth + 1;
      seriesStack.length = newDepth;
      seriesStack.push({ style, lastValue: value });
      return newDepth;
    }
    // Continuation lookup: prefer the STRICTEST match — value ===
    // lastValue + 1 (sequential continuation). If none found, accept
    // the deepest "loose" match where value > lastValue. This is the
    // trick that makes the inner "1, 2, 3" series under "i. Foo"
    // resolve correctly: when we see "2.", the inner NUM/1 is the
    // strict-match candidate, even though an outer NUM/5 series is
    // also open at depth 0.
    let strictDepth = -1;
    let looseDepth = -1;
    for (let d = seriesStack.length - 1; d >= 0; d--) {
      const entry = seriesStack[d];
      if (entry.style !== style) continue;
      if (value === entry.lastValue + 1) {
        strictDepth = d;
        break; // deepest strict match wins; we're scanning deep→shallow.
      }
      if (value > entry.lastValue && looseDepth === -1) {
        looseDepth = d;
      }
    }
    const matchDepth = strictDepth !== -1 ? strictDepth : looseDepth;
    if (matchDepth !== -1) {
      seriesStack.length = matchDepth + 1;
      seriesStack[matchDepth].lastValue = value;
      return matchDepth;
    }
    // No plausible existing series — push as a new deeper one.
    const newDepth = state.lastDepth + 1;
    seriesStack.length = newDepth;
    seriesStack.push({ style, lastValue: value });
    return newDepth;
  }

  /** Single-letter tokens (i, v, x, c, …) can mean alpha (9th, 22nd,
   *  …) OR roman (1, 5, 10, …). Promote to roman in two cases:
   *
   *  1. The letter would be the EXACT next value in an already-open
   *     roman series (e.g., "v." after "iv." — lastValue=4, romanVal=5).
   *     This is a strict +1 continuation; it stops 'c' from being
   *     mis-promoted to roman(100) when no roman series exists at
   *     value 99.
   *  2. The literal is "i" and an alpha series is already open at some
   *     depth (the user is starting a NEW deeper roman series under
   *     alpha — the conventional 1/a/i nesting). */
  function disambiguateAlphaSingle(
    style: MarkerStyle,
    value: number,
    literal: string
  ): { style: MarkerStyle; value: number } {
    const ROMAN_LOWER_VALUES: Record<string, number> = {
      i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000,
    };
    const ROMAN_UPPER_VALUES: Record<string, number> = {
      I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000,
    };

    if (style === 'alpha_lower') {
      const romanVal = ROMAN_LOWER_VALUES[literal];
      if (romanVal !== undefined) {
        // Case 1: strict +1 continuation of an open roman_lower series.
        for (let d = seriesStack.length - 1; d >= 0; d--) {
          const e = seriesStack[d];
          if (e.style === 'roman_lower' && romanVal === e.lastValue + 1) {
            return { style: 'roman_lower', value: romanVal };
          }
        }
        // Case 2: literal 'i' starting a new roman series under alpha.
        if (
          literal === 'i' &&
          seriesStack.some((e) => e.style === 'alpha_lower')
        ) {
          return { style: 'roman_lower', value: 1 };
        }
      }
    }
    if (style === 'alpha_upper') {
      const romanVal = ROMAN_UPPER_VALUES[literal];
      if (romanVal !== undefined) {
        for (let d = seriesStack.length - 1; d >= 0; d--) {
          const e = seriesStack[d];
          if (e.style === 'roman_upper' && romanVal === e.lastValue + 1) {
            return { style: 'roman_upper', value: romanVal };
          }
        }
        if (
          literal === 'I' &&
          seriesStack.some((e) => e.style === 'alpha_upper')
        ) {
          return { style: 'roman_upper', value: 1 };
        }
      }
    }
    return { style, value };
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
    // Blank line — paragraph separator inside notes.
    if (line.rawIndent === -1 && line.marker.style === 'none' && line.marker.text === '') {
      pendingBlank = true;
      continue;
    }

    const marker = line.marker;

    // Indent-only mode: if the document has no markers anywhere, every
    // non-blank line becomes a heading and depth = leading-tab/space
    // count. This is the "pure outline" path — Word's Outline View
    // copied as plain text often falls into this mode.
    if (!anyMarker) {
      pushHeading(Math.max(0, line.rawIndent), marker.text.slice(0, 200));
      pendingBlank = false;
      continue;
    }

    // Marker mode: lines without a marker are continuation paragraphs
    // that flow into the previous heading's notes.
    if (marker.style === 'none') {
      const open = state.lastOpen;
      if (pendingBlank && open && open.notes) open.notes += '\n';
      appendNotes(marker.text);
      pendingBlank = false;
      continue;
    }

    // Compute the depth for this heading.
    let depth: number;
    if (marker.style === 'numeric_dotted') {
      // Explicit depth wins — drops dot-numeric headings exactly where
      // the dots say they go, ignoring whatever series state we held.
      depth = Math.max(0, marker.dottedDepth - 1);
      // Wipe series stack above this depth so subsequent style-based
      // markers re-open from here.
      seriesStack.length = depth;
    } else if (marker.style === 'bullet') {
      // Bullets inherit the most recent heading's depth + 1 (i.e., a
      // bullet under "1. Foo" becomes a child of Foo). If there's no
      // previous heading, fall back to indentation.
      depth = state.lastOpen ? state.lastDepth + 1 : Math.max(0, line.rawIndent);
    } else {
      // Disambiguate "i" / "I" single letters that look like alpha but
      // are actually the start of a deeper roman series.
      const promoted = disambiguateAlphaSingle(marker.style, marker.value, marker.literal);
      depth = placeInSeries(promoted.style, promoted.value);
    }

    pushHeading(depth, marker.text.slice(0, 200));
    pendingBlank = false;
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
