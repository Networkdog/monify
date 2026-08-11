// Hierarchy construction — turns flat user rows into a containment tree whose
// levels become placement paths and zoom layers.

import type { Accessor, Issue } from './types';

/** Substituted for a missing / empty hierarchy key so a row is never dropped. */
export const MISSING_KEY = '(none)';

export interface HierarchyNode {
  /** Key at this level; '' for the root. */
  key: string;
  /** Path from the root, coarse→fine, excluding the root. */
  path: string[];
  depth: number;
  children: HierarchyNode[];
  /** Indices of every row under this node. */
  rows: number[];
  /** Row count (= rows.length). */
  size: number;
}

/** Coerce any accessor result into a usable key. */
export function normalizeKey(value: unknown): string {
  if (value === null || value === undefined) return MISSING_KEY;
  const s = String(value).trim();
  return s === '' ? MISSING_KEY : s;
}

/** Extract one row's coarse→fine path. */
export function pathOf<T>(
  row: T,
  index: number,
  levels: readonly Accessor<T, string>[],
): string[] {
  const out: string[] = new Array(levels.length);
  for (let i = 0; i < levels.length; i++) out[i] = normalizeKey(levels[i](row, index));
  return out;
}

function makeNode(key: string, path: string[], depth: number): HierarchyNode {
  return { key, path, depth, children: [], rows: [], size: 0 };
}

/**
 * Build the containment tree. Children keep first-appearance order, so the
 * result is deterministic for a given input order.
 */
export function buildHierarchy<T>(
  rows: readonly T[],
  levels: readonly Accessor<T, string>[],
): HierarchyNode {
  const root = makeNode('', [], 0);
  const index = new Map<string, HierarchyNode>();
  for (let i = 0; i < rows.length; i++) {
    const path = pathOf(rows[i], i, levels);
    let node = root;
    node.rows.push(i);
    for (let d = 0; d < path.length; d++) {
      const prefix = path.slice(0, d + 1);
      const cacheKey = prefix.join('\u0000');
      let child = index.get(cacheKey);
      if (!child) {
        child = makeNode(path[d], prefix, d + 1);
        index.set(cacheKey, child);
        node.children.push(child);
      }
      child.rows.push(i);
      node = child;
    }
  }
  finalizeSizes(root);
  return root;
}

function finalizeSizes(node: HierarchyNode): void {
  node.size = node.rows.length;
  for (const c of node.children) finalizeSizes(c);
}

/** All nodes at a given depth (1 = coarsest level). */
export function nodesAtDepth(root: HierarchyNode, depth: number): HierarchyNode[] {
  if (depth <= 0) return [root];
  const out: HierarchyNode[] = [];
  const walk = (n: HierarchyNode): void => {
    if (n.depth === depth) {
      out.push(n);
      return;
    }
    for (const c of n.children) walk(c);
  };
  walk(root);
  return out;
}

/** Join a path into a stable group key. */
export function pathKey(path: readonly string[]): string {
  return path.join('/');
}

/**
 * Report structural problems: rows that fell back to `MISSING_KEY`, and levels
 * whose group sizes are so skewed that a layout will look lopsided.
 */
export function inspectHierarchy(
  root: HierarchyNode,
  levelNames: readonly string[],
): Issue[] {
  const issues: Issue[] = [];
  for (let d = 1; d <= levelNames.length; d++) {
    const nodes = nodesAtDepth(root, d);
    const name = levelNames[d - 1];
    const missing = nodes.find((n) => n.key === MISSING_KEY);
    if (missing) {
      issues.push({
        level: 'warning',
        code: 'missing-hierarchy-key',
        subject: name,
        message: `${missing.size} row(s) have no '${name}' value and were grouped under ${MISSING_KEY}.`,
      });
    }
    if (nodes.length > 2) {
      const sizes = nodes.map((n) => n.size);
      const total = sizes.reduce((a, b) => a + b, 0);
      const max = Math.max(...sizes);
      if (total > 0 && max / total > 0.7) {
        issues.push({
          level: 'warning',
          code: 'unbalanced-level',
          subject: name,
          message: `Level '${name}' is dominated by one group (${((max / total) * 100).toFixed(0)}% of rows); the layout will be lopsided.`,
        });
      }
    }
  }
  return issues;
}
