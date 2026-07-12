// TreeMap data model.
//
// The public `TreeMapNode` is plain hierarchical data. Internally we build a
// mutable `LiveNode` tree that carries a tweened `current` value (for smooth
// animation), a computed world-space `rect` (from the layout pass), an
// aggregated `color`, and a descendant `leafCount` (shown when a subtree is
// collapsed into a single cell). Branch values are always the sum of their
// children, so updating a leaf ripples up automatically.

import type { RGBA } from '../../core/types';

/** Public hierarchical input for a TreeMap. */
export interface TreeMapNode {
  id: string;
  label: string;
  /** Leaf magnitude. Ignored for branches (derived as the sum of children). */
  value: number;
  /** Category index for categorical coloring. */
  category?: number;
  /** Explicit color override (engine RGBA). */
  color?: RGBA;
  children?: TreeMapNode[];
  meta?: Record<string, unknown>;
}

/** Axis-aligned world rectangle, `x0 <= x1`, `y0 <= y1`. */
export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Internal, mutable node with animation + layout state. */
export interface LiveNode {
  id: string;
  label: string;
  category?: number;
  explicitColor?: RGBA;
  children: LiveNode[];
  parent?: LiveNode;
  depth: number;
  leafCount: number;
  /** Target value (leaves only; branches derive from children). */
  target: number;
  /** Tweened displayed value. */
  current: number;
  /** World rect assigned by the layout pass. */
  rect: Rect;
  /** World height of the caption strip reserved across the top (0 = none). */
  headerH: number;
  /** Aggregated (value-weighted) color. */
  color: RGBA;
  /** Opaque metadata carried from the public node. */
  meta?: Record<string, unknown>;
}

const ZERO_RECT: Rect = { x0: 0, y0: 0, x1: 0, y1: 0 };

/** Build a LiveNode tree from public input. */
export function buildLiveTree(node: TreeMapNode, depth = 0, parent?: LiveNode): LiveNode {
  const live: LiveNode = {
    id: node.id,
    label: node.label,
    category: node.category,
    explicitColor: node.color,
    children: [],
    parent,
    depth,
    leafCount: 0,
    target: 0,
    current: 0,
    rect: { ...ZERO_RECT },
    headerH: 0,
    color: [0.5, 0.5, 0.5, 1],
    meta: node.meta,
  };
  if (node.children && node.children.length > 0) {
    live.children = node.children.map((c) => buildLiveTree(c, depth + 1, live));
    live.target = live.children.reduce((s, c) => s + c.target, 0);
    live.leafCount = live.children.reduce((s, c) => s + c.leafCount, 0);
  } else {
    live.target = Math.max(0, node.value);
    live.leafCount = 1;
  }
  live.current = live.target;
  return live;
}

/** Index all nodes by id for fast value updates. */
export function indexById(root: LiveNode): Map<string, LiveNode> {
  const map = new Map<string, LiveNode>();
  const walk = (n: LiveNode): void => {
    map.set(n.id, n);
    for (const c of n.children) walk(c);
  };
  walk(root);
  return map;
}

/** Set a leaf's target value (branches are derived, so setting them is a no-op). */
export function setLeafTarget(node: LiveNode, value: number): void {
  if (node.children.length === 0) node.target = Math.max(0, value);
}

/**
 * Advance the tween by `dt` seconds at exponential `rate`. Leaves ease toward
 * their target; branch `current` is recomputed as the sum of children. Returns
 * true if anything moved this step.
 */
export function stepTween(root: LiveNode, rate: number, dt: number): boolean {
  const k = 1 - Math.exp(-rate * dt);
  let changed = false;
  const rec = (n: LiveNode): number => {
    if (n.children.length === 0) {
      const d = n.target - n.current;
      const eps = Math.max(1e-4, Math.abs(n.target) * 1e-3);
      if (Math.abs(d) > eps) {
        n.current += d * k;
        changed = true;
      } else {
        n.current = n.target;
      }
      return n.current;
    }
    let sum = 0;
    for (const c of n.children) sum += rec(c);
    n.current = sum;
    return sum;
  };
  rec(root);
  return changed;
}

/**
 * Recompute every node's color. Leaves use `leafColor` (unless they carry an
 * explicit color); branches are the value-weighted mean of their children —
 * so a collapsed subtree shows the average color of what it contains.
 */
export function computeColors(root: LiveNode, leafColor: (n: LiveNode) => RGBA): void {
  const rec = (n: LiveNode): [RGBA, number] => {
    if (n.children.length === 0) {
      n.color = n.explicitColor ?? leafColor(n);
      return [n.color, Math.max(n.current, 1e-6)];
    }
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 0;
    let w = 0;
    for (const c of n.children) {
      const [cc, cw] = rec(c);
      r += cc[0] * cw;
      g += cc[1] * cw;
      b += cc[2] * cw;
      a += cc[3] * cw;
      w += cw;
    }
    const inv = w > 0 ? 1 / w : 0;
    n.color = [r * inv, g * inv, b * inv, a * inv];
    return [n.color, w];
  };
  rec(root);
}

/** Total displayed value at the root (for share calculations). */
export function rootTotal(root: LiveNode): number {
  return root.current;
}
