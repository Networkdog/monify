// Semantic colour tokens — the fixed parts of the visualization that carry no
// data: the canvas behind the marks, the neutral used where a value is missing,
// the glyph and hairline colours, and the accents in the surrounding chrome.
//
// Data colours come from ./palettes and change with the encoding; these do not.
// Keeping them in one place is what makes the three demos, the tooltip and the
// two visualizations read as one product instead of three.
//
// The scale is Tailwind CSS `slate` for surfaces and text, with `sky` as the
// interaction accent and `rose`/`amber`/`emerald` for status. Slate is a cool
// near-neutral: it stays out of the way of the saturated hues drawn on top of
// it, while still reading as a deliberate colour rather than grey.

import type { RGBA } from '../core/types';
import { hexToRgba } from './scales';

/** Surfaces, from the canvas outward. Hex, for CSS and for `hexToRgba`. */
export const SURFACE = {
  /** The canvas the marks sit on — every viz clears to this. */
  canvas: '#0a0f1a',
  /** Page background behind the canvas, so no seam shows at the edges. */
  page: '#0a0f1a',
  /** Floating panels: HUD, legend, control rail, tooltip. */
  panel: '#0f172a',
  /** Raised state of an interactive control. */
  panelHover: '#1e293b',
  /** Hairlines around panels and swatches. */
  border: '#334155',
} as const;

/** Text and glyph colours. */
export const INK = {
  /** Body text on a panel. */
  primary: '#e2e8f0',
  /** Secondary text: units, counts, captions. */
  muted: '#94a3b8',
  /** Links, active controls, focus. */
  accent: '#38bdf8',
  /** Pressed / selected fill behind accent text. */
  accentStrong: '#0284c7',
} as const;

/** Status colours for text and chips — the same hues the health ramp ends on. */
export const STATUS = {
  ok: '#34d399',
  warn: '#fbbf24',
  crit: '#fb7185',
} as const;

/** The canvas clear colour, in engine RGBA. */
export const BACKGROUND: RGBA = hexToRgba(SURFACE.canvas);

/**
 * Fill for a mark with no value to show — a resource nothing is reported for,
 * a category outside the legend. Deliberately desaturated: it must read as
 * "no data", not as a low reading.
 */
export const NEUTRAL: RGBA = hexToRgba('#475569');

/** A shade lighter than NEUTRAL, for neutral scaffolding drawn *under* marks. */
export const NEUTRAL_LIGHT: RGBA = hexToRgba('#64748b');

/** Hairlines drawn on the canvas itself (link wires, connectors). */
export const HAIRLINE: RGBA = hexToRgba('#94a3b8');

/**
 * The colour a mark flashes toward while an anomaly pulses. Warm and near
 * white, so the flash reads as heat against every hue in the status ramp.
 */
export const HOT: RGBA = hexToRgba('#fef3c7');

/** Glyph colours — off-black and soft white, never pure #000 / #fff. */
export const GLYPH_DARK: RGBA = hexToRgba('#0f172a');
export const GLYPH_LIGHT: RGBA = hexToRgba('#e2e8f0');
