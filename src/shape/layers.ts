// Layer data — maps hierarchy levels onto semantic-zoom layers, so each zoom
// band shows an aggregated view of one containment level.

import { nodesAtDepth, pathKey, type HierarchyNode } from './hierarchy';
import { aggregate } from './aggregate';
import type { RGBA } from '../core/types';
import type { AggName } from './types';

/** How one hierarchy level is presented as a zoom layer. */
export interface LayerSpec {
  /** Hierarchy level name. */
  level: string;
  /** How member values collapse into the layer's value. Default 'worst'. */
  aggregate?: AggName;
  label?: string;
  /** Explicit zoom band; assigned automatically when omitted. */
  minZoom?: number;
  maxZoom?: number;
}

/** One group drawn at a layer. */
export interface LayerGroup {
  key: string;
  path: string[];
  /** Row indices in this group. */
  rows: number[];
  size: number;
  value: number;
  color?: RGBA;
}

/** A compiled zoom layer, coarsest first. */
export interface CompiledLayer {
  level: string;
  label: string;
  depth: number;
  aggregate: AggName;
  minZoom: number;
  maxZoom: number;
  groups: LayerGroup[];
}

export interface CompileLayersOptions {
  /** Zoom at which the finest (individual cell) layer takes over. Default 12. */
  cellZoom?: number;
  /** Zoom at which the coarsest layer starts. Default 0. */
  baseZoom?: number;
  /** Per-level aggregation overrides. */
  specs?: readonly LayerSpec[];
  /** Values to aggregate, by row index. */
  valueAt?: (rowIndex: number) => number;
  /** Default aggregation. Default 'worst'. */
  defaultAgg?: AggName;
}

/**
 * Split the zoom range evenly across the hierarchy levels: the coarsest level
 * owns the overview and each finer level takes over as you zoom in, until
 * individual cells appear at `cellZoom`.
 */
export function compileLayers(
  root: HierarchyNode,
  levelNames: readonly string[],
  opts: CompileLayersOptions = {},
): CompiledLayer[] {
  const baseZoom = opts.baseZoom ?? 0;
  const cellZoom = opts.cellZoom ?? 12;
  const defaultAgg = opts.defaultAgg ?? 'worst';
  const valueAt = opts.valueAt ?? ((): number => 0);
  const specByLevel = new Map((opts.specs ?? []).map((s) => [s.level, s]));

  const count = levelNames.length;
  if (count === 0) return [];
  const band = (cellZoom - baseZoom) / count;

  const layers: CompiledLayer[] = [];
  for (let d = 1; d <= count; d++) {
    const level = levelNames[d - 1];
    const spec = specByLevel.get(level);
    const agg = spec?.aggregate ?? defaultAgg;
    const groups: LayerGroup[] = nodesAtDepth(root, d).map((n) => ({
      key: pathKey(n.path),
      path: n.path,
      rows: n.rows,
      size: n.size,
      value: aggregate(n.rows.map(valueAt), agg),
    }));
    layers.push({
      level,
      label: spec?.label ?? level,
      depth: d,
      aggregate: agg,
      minZoom: spec?.minZoom ?? baseZoom + band * (d - 1),
      maxZoom: spec?.maxZoom ?? baseZoom + band * d,
      groups,
    });
  }
  return layers;
}

/** The layer visible at a zoom level, or null once individual cells take over. */
export function layerAtZoom(layers: readonly CompiledLayer[], zoom: number): CompiledLayer | null {
  for (const l of layers) {
    if (zoom >= l.minZoom && zoom < l.maxZoom) return l;
  }
  return null;
}
