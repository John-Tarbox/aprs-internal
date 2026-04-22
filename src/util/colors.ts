/**
 * Single source of truth for color helpers used across the app.
 *
 * - DEFAULT_COLUMN_COLOR: hex color per legacy column key. Used as the
 *   fallback when a board has no explicit per-column color set.
 * - COLUMN_FALLBACK_COLOR: for column keys not in the legacy six (added
 *   via the S12 custom-columns UI).
 * - HEX_COLOR_RE / isValidHexColor: validates user-supplied colors at
 *   service boundaries. Accepts #abc and #aabbcc forms (case-insensitive);
 *   rejects everything else, including #aabbccdd (alpha — would cause
 *   surprises in our text-on-color contrast logic).
 * - cardCoverTint: derives a low-alpha tint from a hex for use as a
 *   subtle card background; full hex would be too aggressive.
 * - readableTextColorOn: returns '#fff' or '#111' depending on background
 *   luminance. Used for text painted directly on a colored bar/chip.
 */

export type ColumnKey = string;

export const DEFAULT_COLUMN_COLOR: Record<string, string> = {
  not_started: '#94a3b8',
  started: '#38bdf8',
  blocked: '#dc2626',
  ready: '#a855f7',
  approval: '#eab308',
  done: '#22c55e',
};

export const COLUMN_FALLBACK_COLOR = '#64748b';

/** Resolve a column's display color: explicit per-board > legacy default > fallback. */
export function colorForColumn(key: ColumnKey, explicit: string | null | undefined): string {
  if (explicit && isValidHexColor(explicit)) return explicit;
  return DEFAULT_COLUMN_COLOR[key] ?? COLUMN_FALLBACK_COLOR;
}

const HEX_COLOR_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

export function isValidHexColor(v: unknown): v is string {
  return typeof v === 'string' && HEX_COLOR_RE.test(v);
}

/** Normalize a hex color string for storage. Returns null for invalid input. */
export function normalizeHexColor(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim().toLowerCase();
  if (!HEX_COLOR_RE.test(trimmed)) return null;
  // Expand #abc → #aabbcc for consistent storage.
  if (trimmed.length === 4) {
    return '#' + trimmed[1] + trimmed[1] + trimmed[2] + trimmed[2] + trimmed[3] + trimmed[3];
  }
  return trimmed;
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
