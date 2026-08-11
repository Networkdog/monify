// In-cell label typography — the rules that keep a glyph legible inside a cell.
//
// Split out from the viz so it can be tested without a WebGL context: the label
// must breathe (never touch the border), keep WCAG-AA contrast against whatever
// colour the cell currently is, and truncate rather than shrink.

import type { RGBA } from '../../core/types';
import { oklchToRgba, rgbaToOklch } from '../../color/scales';

export const LABEL_SIZE_PX = 11;
/** Smallest on-screen cell that still carries a label. */
export const LABEL_MIN_CELL_PX = 54;
/** Share of the cell width kept empty on each side. */
export const LABEL_PAD = 0.2;
/** Glyphs a label may show before it is truncated. */
export const LABEL_MAX_CHARS = 4;
/**
 * Mean advance width of a glyph at this weight, in em. Measured against the
 * widest realistic label — a truncated one, where the ellipsis runs wider than
 * the letters it replaces — so the padding budget holds for the worst case.
 */
export const LABEL_CHAR_EM = 0.72;
/** Pointy-top hexagons are narrower than tall: width = √3/2 × height. */
export const HEX_WIDTH_RATIO = 0.8660254037844386;
/**
 * Label font size as a fraction of the cell's diameter, derived so that
 * LABEL_MAX_CHARS fit inside the padded width. Sizing from the budget (rather
 * than picking a size and hoping) is what keeps the breathing room honest at
 * every zoom, since the glyph scales with the cell.
 */
export const LABEL_CELL_FRACTION =
  (HEX_WIDTH_RATIO * (1 - 2 * LABEL_PAD)) / (LABEL_MAX_CHARS * LABEL_CHAR_EM);
// Quoted families keep the engine's font parser from mistaking the `sans-serif`
// inside `ui-sans-serif` for the start of the family list.
export const LABEL_FONT = "600 'Inter', 'Pretendard', system-ui, sans-serif";
/** Small text opens up slightly so short uppercase codes stay distinct. */
export const LABEL_TRACKING = '0.03em';

/**
 * Contrast the glyph aims for against the cell it sits on, and the floor it may
 * never drop below (WCAG AAA and AA for body text). The cell colour is data and
 * cannot be nudged, so the glyph is what moves — and it moves far enough to be
 * comfortable, not just far enough to be legal.
 */
export const LABEL_TARGET_CONTRAST = 7;
export const LABEL_MIN_CONTRAST = 4.5;
/**
 * How far the glyph tone may travel. Stopping short of 0 and 1 keeps it off
 * pure black and pure white, which look like a hole punched in the cell.
 */
const TONE_DARKEST = 0.08;
const TONE_LIGHTEST = 0.985;
/**
 * Chroma the glyph keeps from its cell — enough to stay in the cell's colour
 * family (a deep green on a green cell reads as one object, an off-black on it
 * reads as a sticker), capped so the glyph never becomes a second colour
 * competing with the fill.
 */
const TONE_CHROMA_KEPT = 0.6;
const TONE_CHROMA_MAX = 0.07;
/**
 * Lightness within which the glyph gives its colour back up. A tone this close
 * to black or white has almost no room for chroma anyway, and the little it
 * could hold only muddies it — and costs contrast on exactly the mid-tone cells
 * that have none to spare.
 */
const TONE_CHROMA_FADE_DARK = 0.35;
const TONE_CHROMA_FADE_LIGHT = 0.2;
/**
 * Fill luminance where dark and light glyphs are equally readable. Below it the
 * cell is dark enough that the glyph must go light, above it dark.
 */
const TONE_CROSSOVER = 0.179;

function channel(v: number): number {
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

/** WCAG 2.x relative luminance of an engine RGBA colour. */
export function relativeLuminance(c: RGBA): number {
  return 0.2126 * channel(c[0]) + 0.7152 * channel(c[1]) + 0.0722 * channel(c[2]);
}

/** WCAG contrast ratio between two colours (1..21). */
export function contrastRatio(a: RGBA, b: RGBA): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Walk the fill's own lightness toward `limit` and stop at the first tone that
 * hits the contrast target, so the glyph is only ever as extreme as it has to
 * be; if even `limit` falls short, `limit` is the answer. Contrast rises
 * monotonically along the walk, which is what lets a bisection find that tone.
 */
function toneToward(
  fill: RGBA,
  lightness: number,
  chroma: number,
  hue: number,
  limit: number,
): RGBA {
  const tone = (l: number): RGBA =>
    oklchToRgba(
      l,
      chroma * Math.min(1, l / TONE_CHROMA_FADE_DARK, (1 - l) / TONE_CHROMA_FADE_LIGHT),
      hue,
    );
  let best = tone(limit);
  if (contrastRatio(best, fill) < LABEL_TARGET_CONTRAST) return best;
  let near = lightness;
  let far = limit;
  for (let i = 0; i < 12; i++) {
    const mid = (near + far) / 2;
    const probe = tone(mid);
    if (contrastRatio(probe, fill) >= LABEL_TARGET_CONTRAST) {
      best = probe;
      far = mid;
    } else {
      near = mid;
    }
  }
  return best;
}

/**
 * The glyph colour for a cell of colour `fill`: the cell's own hue taken to
 * whichever end of the lightness range reads against it.
 *
 * Two fixed colours (an off-black and a soft white) cannot clear AA on the
 * mid-tone greens, reds and ambers a status ramp passes through, which is why
 * the glyph used to be outlined. Deriving the tone from the fill removes the
 * need for the outline: there is always a tone of the cell's own hue that
 * separates from it, and it separates by colour rather than by a rim of paint
 * around every letter.
 */
export function labelColorFor(fill: RGBA): RGBA {
  const [lightness, chroma, hue] = rgbaToOklch(fill);
  const kept = Math.min(chroma * TONE_CHROMA_KEPT, TONE_CHROMA_MAX);
  const goDark = relativeLuminance(fill) > TONE_CROSSOVER;
  const preferred = toneToward(fill, lightness, kept, hue, goDark ? TONE_DARKEST : TONE_LIGHTEST);
  if (contrastRatio(preferred, fill) >= LABEL_TARGET_CONTRAST) return preferred;
  // The cell sits too near the middle for the natural direction to get there;
  // take whichever end separates most.
  const other = toneToward(fill, lightness, kept, hue, goDark ? TONE_LIGHTEST : TONE_DARKEST);
  return contrastRatio(other, fill) > contrastRatio(preferred, fill) ? other : preferred;
}

/** World-space font size for a cell of the given world radius. */
export function labelWorldSize(worldRadius: number): number {
  return 2 * worldRadius * LABEL_CELL_FRACTION;
}

/**
 * Glyphs that fit across a cell once padding is reserved. Constant, because the
 * label scales with the cell: zooming in reveals a bigger glyph, not more of it.
 */
export function labelCapacity(): number {
  return LABEL_MAX_CHARS;
}

/**
 * Fit a label into `maxChars`, truncating with an ellipsis rather than shrinking
 * the type. Returns null when even a truncated glyph would crowd the cell, so
 * the caller drops the label instead of letting it touch the border.
 */
export function fitLabel(text: string, maxChars: number): string | null {
  if (maxChars < 2 || text.length === 0) return null;
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 1)}…`;
}
