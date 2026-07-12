// Squarified treemap layout (Bruls, Huizing & van Wijk, 2000).
//
// `squarify` tiles a rectangle with sub-rectangles whose areas are proportional
// to the given weights, greedily keeping each tile's aspect ratio close to 1.
// Rects are returned in input order (so callers can zip them back to nodes).
// `layoutTree` applies it recursively down a LiveNode tree, insetting a small
// gutter at each level so nested cells stay visually separable.

import type { LiveNode, Rect } from './model';

/** Longest/shortest side ratio produced by a row of `areas` across `side`. */
function worstRatio(sum: number, max: number, min: number, side: number): number {
  const s2 = side * side;
  const sum2 = sum * sum;
  return Math.max((s2 * max) / sum2, sum2 / (s2 * min));
}

/**
 * Tile `rect` with sub-rects whose areas are proportional to `weights`.
 * Zero/negative weights collapse to degenerate rects at the rect origin.
 */
export function squarify(weights: readonly number[], rect: Rect): Rect[] {
  const n = weights.length;
  const result: Rect[] = new Array(n);
  const degenerate: Rect = { x0: rect.x0, y0: rect.y0, x1: rect.x0, y1: rect.y0 };
  for (let i = 0; i < n; i++) result[i] = { ...degenerate };
  if (n === 0) return result;

  // Positive tiles only; total area is distributed among them.
  const positive: number[] = [];
  for (let i = 0; i < n; i++) if (weights[i] > 0) positive.push(i);
  const total = positive.reduce((s, i) => s + weights[i], 0);
  if (total <= 0) return result;

  const rectW = rect.x1 - rect.x0;
  const rectH = rect.y1 - rect.y0;
  const area = rectW * rectH;
  if (area <= 0) return result;

  // Scale weights to areas; process largest-first for better aspect ratios.
  const scaled = new Float64Array(n);
  for (const i of positive) scaled[i] = (weights[i] / total) * area;
  const order = positive.slice().sort((a, b) => scaled[b] - scaled[a]);

  const free: Rect = { ...rect };
  let cursor = 0;
  while (cursor < order.length) {
    const freeW = free.x1 - free.x0;
    const freeH = free.y1 - free.y0;
    const side = Math.min(freeW, freeH);

    // Greedily grow the row while the worst aspect ratio keeps improving.
    const rowIdx: number[] = [];
    let rowSum = 0;
    let rowMax = 0;
    let rowMin = Infinity;
    let bestWorst = Infinity;
    let j = cursor;
    while (j < order.length) {
      const v = scaled[order[j]];
      const nSum = rowSum + v;
      const nMax = Math.max(rowMax, v);
      const nMin = Math.min(rowMin, v);
      const w = worstRatio(nSum, nMax, nMin, side);
      if (rowIdx.length === 0 || w <= bestWorst) {
        rowIdx.push(order[j]);
        rowSum = nSum;
        rowMax = nMax;
        rowMin = nMin;
        bestWorst = w;
        j++;
      } else {
        break;
      }
    }

    // Lay the row along the shorter side; thickness consumes the longer side.
    const thickness = rowSum / side;
    let offset = 0;
    if (freeW >= freeH) {
      // Vertical strip on the left; tiles stack top→bottom.
      for (const idx of rowIdx) {
        const h = scaled[idx] / thickness;
        result[idx] = {
          x0: free.x0,
          y0: free.y0 + offset,
          x1: free.x0 + thickness,
          y1: free.y0 + offset + h,
        };
        offset += h;
      }
      free.x0 += thickness;
    } else {
      // Horizontal strip on top; tiles run left→right.
      for (const idx of rowIdx) {
        const w = scaled[idx] / thickness;
        result[idx] = {
          x0: free.x0 + offset,
          y0: free.y0,
          x1: free.x0 + offset + w,
          y1: free.y0 + thickness,
        };
        offset += w;
      }
      free.y0 += thickness;
    }
    cursor = j;
  }
  return result;
}

/** Inset a rect by an absolute amount on all sides (never past its center). */
export function insetRect(rect: Rect, pad: number): Rect {
  const w = rect.x1 - rect.x0;
  const h = rect.y1 - rect.y0;
  const px = Math.min(pad, w / 2);
  const py = Math.min(pad, h / 2);
  return { x0: rect.x0 + px, y0: rect.y0 + py, x1: rect.x1 - px, y1: rect.y1 - py };
}

/**
 * Recursively assign world rects to every node. Children fill their parent
 * completely; only a `headerFrac` caption strip across the top of each branch
 * is reserved (recorded as `node.headerH`) so an expanded parent can label
 * itself above its children. Cell separators are drawn per cell at render time
 * (constant screen thickness), not carved out of the layout.
 */
export function layoutTree(root: LiveNode, rect: Rect, headerFrac = 0): void {
  root.rect = rect;
  const rec = (n: LiveNode): void => {
    if (n.children.length === 0) return;
    const w = n.rect.x1 - n.rect.x0;
    const h = n.rect.y1 - n.rect.y0;
    const header = Math.min(w, h) * headerFrac;
    n.headerH = header;
    const body: Rect = {
      x0: n.rect.x0,
      y0: n.rect.y0 + header,
      x1: n.rect.x1,
      y1: n.rect.y1,
    };
    const weights = n.children.map((c) => Math.max(c.current, 0));
    const rects = squarify(weights, body);
    for (let i = 0; i < n.children.length; i++) {
      n.children[i].rect = rects[i];
      rec(n.children[i]);
    }
  };
  rec(root);
}
