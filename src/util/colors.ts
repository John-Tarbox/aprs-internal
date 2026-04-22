/**
 * Single source of truth for color helpers used across the app.
 *
 * As of the web-safe-picker change, all user-pickable colors (card
 * cover, column color, group/label color) are constrained to the
 * 216-color web-safe palette: each RGB channel one of {0x00, 0x33,
 * 0x66, 0x99, 0xCC, 0xFF}. The picker UI only offers these 216;
 * the server snaps any incoming non-web-safe hex to its nearest
 * web-safe neighbour before persisting (snap-on-store). Older rows
 * stay as-is until next edit.
 *
 * - WEB_SAFE_COLORS: the canonical 216 hex strings, sorted for
 *   pleasant grid display (achromatic first, then by hue, then by
 *   lightness desc).
 * - DEFAULT_COLUMN_COLOR: hex per legacy column key — all web-safe.
 * - COLUMN_FALLBACK_COLOR: for column keys not in the legacy six —
 *   web-safe gray.
 * - HEX_COLOR_RE / isValidHexColor: validates user-supplied colors
 *   at service boundaries. Accepts #abc and #aabbcc forms (case-
 *   insensitive); rejects everything else, including #aabbccdd
 *   (alpha — would surprise our text-on-color contrast logic).
 * - isWebSafeColor / snapToWebSafeColor: web-safe membership and
 *   nearest-neighbour clamp.
 * - normalizeHexColor: parses, expands #abc, snaps to web-safe.
 * - tintFromHex: low-alpha rgba string for chip backgrounds.
 * - readableTextColorOn: '#fff' or '#111' depending on background
 *   luminance.
 */

export type ColumnKey = string;

/** The six channel values that define the web-safe palette. */
const WEB_SAFE_CHANNELS = [0x00, 0x33, 0x66, 0x99, 0xcc, 0xff] as const;
const WEB_SAFE_HEX_DIGITS = ['00', '33', '66', '99', 'cc', 'ff'] as const;

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) * 60;
    else if (max === gn) h = ((bn - rn) / d + 2) * 60;
    else h = ((rn - gn) / d + 4) * 60;
  }
  return [h, s, l];
}

function buildWebSafeColors(): string[] {
  const all: string[] = [];
  for (const r of WEB_SAFE_HEX_DIGITS)
    for (const g of WEB_SAFE_HEX_DIGITS)
      for (const b of WEB_SAFE_HEX_DIGITS)
        all.push('#' + r + g + b);
  // Sort: grayscales first (sorted by lightness asc), then chromatic
  // colors by hue → lightness desc → saturation desc. The visual
  // result is a tidy 18×12 grid: top row = grayscale, then a
  // continuous hue rainbow with similar tones grouped together.
  return all.sort((a, b) => {
    const ar = parseInt(a.slice(1, 3), 16);
    const ag = parseInt(a.slice(3, 5), 16);
    const ab = parseInt(a.slice(5, 7), 16);
    const br = parseInt(b.slice(1, 3), 16);
    const bg = parseInt(b.slice(3, 5), 16);
    const bb = parseInt(b.slice(5, 7), 16);
    const [aH, aS, aL] = rgbToHsl(ar, ag, ab);
    const [bH, bS, bL] = rgbToHsl(br, bg, bb);
    const aGray = aS < 0.001;
    const bGray = bS < 0.001;
    if (aGray && !bGray) return -1;
    if (bGray && !aGray) return 1;
    if (aGray && bGray) return aL - bL;
    // Bucket hues into 12 groups (every 30°) so colors of the same
    // hue family stay adjacent.
    const aHB = Math.round(aH / 30);
    const bHB = Math.round(bH / 30);
    if (aHB !== bHB) return aHB - bHB;
    if (Math.abs(aL - bL) > 0.001) return bL - aL; // light first
    return bS - aS;
  });
}

/** All 216 web-safe colors, sorted for grid display. */
export const WEB_SAFE_COLORS: readonly string[] = buildWebSafeColors();

const WEB_SAFE_SET: Set<string> = new Set(WEB_SAFE_COLORS);

export function isWebSafeColor(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  return WEB_SAFE_SET.has(v.trim().toLowerCase());
}

/** Snap any 24-bit channel value to the nearest web-safe step. */
function snapChannel(v: number): number {
  let bestDelta = Infinity;
  let best = 0;
  for (const c of WEB_SAFE_CHANNELS) {
    const d = Math.abs(v - c);
    if (d < bestDelta) {
      bestDelta = d;
      best = c;
    }
  }
  return best;
}

function channelToHex(c: number): string {
  return c.toString(16).padStart(2, '0');
}

/**
 * Snap a normalized 6-digit hex (#aabbcc, lowercase) to its nearest
 * web-safe neighbour. Returns the snapped #aabbcc string. Use
 * normalizeHexColor for arbitrary inputs — this helper assumes the
 * input is already a clean 6-digit lowercase hex.
 */
export function snapToWebSafeColor(hex6: string): string {
  const r = snapChannel(parseInt(hex6.slice(1, 3), 16));
  const g = snapChannel(parseInt(hex6.slice(3, 5), 16));
  const b = snapChannel(parseInt(hex6.slice(5, 7), 16));
  return '#' + channelToHex(r) + channelToHex(g) + channelToHex(b);
}

const HEX_COLOR_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

export function isValidHexColor(v: unknown): v is string {
  return typeof v === 'string' && HEX_COLOR_RE.test(v);
}

/**
 * Parse an arbitrary user-supplied color string and return a clean
 * lowercase #aabbcc that's guaranteed to be web-safe. Returns null
 * for malformed input. Snap-on-store lets older clients (or future
 * imports) feed any hex without breaking the picker's invariant.
 */
export function normalizeHexColor(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim().toLowerCase();
  if (!HEX_COLOR_RE.test(trimmed)) return null;
  const expanded =
    trimmed.length === 4
      ? '#' + trimmed[1] + trimmed[1] + trimmed[2] + trimmed[2] + trimmed[3] + trimmed[3]
      : trimmed;
  return snapToWebSafeColor(expanded);
}

// Defaults are hand-picked web-safe equivalents of the previous
// Tailwind-derived hues. Every value satisfies isWebSafeColor.
export const DEFAULT_COLUMN_COLOR: Record<string, string> = {
  not_started: '#999999',  // medium gray  (was slate-400)
  started: '#3399cc',      // sky blue     (was sky-400)
  blocked: '#cc0000',      // red          (was red-600)
  ready: '#9933cc',        // purple       (was purple-500)
  approval: '#cc9900',     // amber/gold   (was yellow-500)
  done: '#33cc33',         // green        (was green-500)
};

export const COLUMN_FALLBACK_COLOR = '#666666';

/** Resolve a column's display color: explicit per-board > legacy default > fallback. */
export function colorForColumn(key: ColumnKey, explicit: string | null | undefined): string {
  if (explicit && isValidHexColor(explicit)) return explicit;
  return DEFAULT_COLUMN_COLOR[key] ?? COLUMN_FALLBACK_COLOR;
}

/** Build a low-alpha tint of a hex color, suitable for backgrounds.
 *  Returns the rgba(r,g,b,a) string; falls back to a gray on bad input. */
export function tintFromHex(hex: string, alpha = 0.18): string {
  const norm = normalizeHexColor(hex);
  if (!norm) return `rgba(128,128,128,${alpha})`;
  const r = parseInt(norm.slice(1, 3), 16);
  const g = parseInt(norm.slice(3, 5), 16);
  const b = parseInt(norm.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

/** WCAG-style contrast pick: '#fff' on dark backgrounds, '#111' on light.
 *  Threshold 0.55 was eyeballed against the default column palette. */
export function readableTextColorOn(hex: string): string {
  const norm = normalizeHexColor(hex);
  if (!norm) return '#fff';
  const r = parseInt(norm.slice(1, 3), 16) / 255;
  const g = parseInt(norm.slice(3, 5), 16) / 255;
  const b = parseInt(norm.slice(5, 7), 16) / 255;
  // Relative luminance approximation (Rec. 709 weights).
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return lum > 0.55 ? '#111' : '#fff';
}
