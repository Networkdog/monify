// Compilation — the final step that turns an encoded dataset into the exact
// inputs the visualizations consume: HexGrid cells and TreeMap nodes.

import type { RGBA } from '../core/types';
import type { ResourceLink, WorkloadInput } from '../viz/hexgrid';
import type { TreeMapNode } from '../viz/treemap';
import type { HierarchyNode } from './hierarchy';
import { pathOf } from './hierarchy';
import { aggregate, describe } from './aggregate';
import {
  buildCategoryScale,
  isCategoricalColor,
  mapRange,
  quantitativeScale,
  NEUTRAL_TINT,
  type EncodingSpec,
  type ResourceValue,
} from './encode';
import type { CompiledLayer } from './layers';
import type { Accessor, AggName, DatasetSpec } from './types';

/** Everything HexGrid needs, ready to spread into its options. */
export interface HexGridInput {
  workloads: WorkloadInput[];
  placement: 'hash' | 'grouped' | 'hierarchical' | 'dense' | 'affinity' | 'relational' | 'force';
  affinityWeights?: number[];
  moats?: number[];
  layers: CompiledLayer[];
}

/** Resolved per-row channel values shared by both compilers. */
export interface CompiledRow {
  id: string;
  label: string;
  path: string[];
  /** Value the color scale was sampled at. */
  value: number;
  /** Live severity 0..1 driving the health colour. */
  status: number;
  color: RGBA;
  size: number;
  height: number;
  central: number;
  monitored: boolean;
  tooltip: string[];
  links: ResourceLink[];
  anchor: string;
  affinity: string[];
  resources: ResourceValue[];
  meta?: Record<string, unknown>;
}

function resolveLabel<T>(
  enc: EncodingSpec<T> | undefined,
  spec: DatasetSpec<T>,
): Accessor<T, string> | null {
  const l = enc?.label;
  if (typeof l === 'function') return l;
  if (typeof l === 'string') {
    const dim = spec.dimensions?.[l];
    if (dim) return dim.of;
    const level = spec.hierarchy?.[l];
    if (level) return level;
  }
  return spec.label ?? null;
}

function resolveTooltip<T>(
  enc: EncodingSpec<T> | undefined,
  spec: DatasetSpec<T>,
): Accessor<T, string[]> | null {
  const t = enc?.tooltip;
  if (!t) return null;
  if (typeof t === 'function') return t;
  const fields = t.map((name) => {
    const dim = spec.dimensions?.[name];
    const level = spec.hierarchy?.[name];
    const measure = spec.measures?.[name];
    const label = dim?.label ?? measure?.label ?? name;
    const read: Accessor<T, string> = dim
      ? dim.of
      : level
        ? level
        : measure
          ? (row, i): string => String(measure.value(row, i))
          : (): string => '';
    return { label, read };
  });
  return (row, i): string[] => fields.map((f) => `${f.label}: ${f.read(row, i)}`);
}

function measureValues<T>(
  spec: DatasetSpec<T>,
  name: string | undefined,
): { values: number[]; domain: [number, number]; agg: AggName } | null {
  if (!name) return null;
  const m = spec.measures?.[name];
  if (!m) return null;
  const values = spec.data.map((row, i) => {
    const v = m.value(row, i);
    return Number.isFinite(v) ? v : 0;
  });
  const stats = describe(values);
  return {
    values,
    domain: m.domain ?? [stats.min, stats.max],
    agg: m.agg ?? 'mean',
  };
}

function centralOf<T>(enc: EncodingSpec<T> | undefined, spec: DatasetSpec<T>): Accessor<T, number> {
  const c = enc?.central;
  if (!c) return (): number => 0;
  if (typeof c === 'function') return c;
  const dim = spec.dimensions?.[c.by];
  const read = dim?.of ?? spec.hierarchy?.[c.by];
  if (!read) return (): number => c.fallback ?? 0;
  return (row, i): number => c.weights[read(row, i)] ?? c.fallback ?? 0;
}

/** Affinity attributes: dimension names resolve to their values per row. */
function resolveAffinity<T>(
  enc: EncodingSpec<T> | undefined,
  spec: DatasetSpec<T>,
): Accessor<T, string[]> | null {
  const a = enc?.affinity;
  if (!a) return null;
  if (typeof a === 'function') return a;
  const reads = a
    .map((name) => spec.dimensions?.[name]?.of ?? spec.hierarchy?.[name])
    .filter((r): r is Accessor<T, string> => r !== undefined);
  if (reads.length === 0) return null;
  return (row, i): string[] => reads.map((r) => r(row, i));
}

/** Resolve the per-row colour function for whichever colour encoding is set. */
function colorResolver<T>(
  spec: DatasetSpec<T>,
  enc: EncodingSpec<T> | undefined,
): { colorAt: (row: T, index: number, value: number) => RGBA; quantValues: number[] | null } {
  const colorEnc = enc?.color;
  if (!colorEnc) return { colorAt: (): RGBA => NEUTRAL_TINT, quantValues: null };

  if (isCategoricalColor(colorEnc)) {
    const dim = spec.dimensions?.[colorEnc.by];
    const read = dim?.of ?? spec.hierarchy?.[colorEnc.by];
    if (!read) return { colorAt: (): RGBA => NEUTRAL_TINT, quantValues: null };
    const keys = spec.data.map((row, i) => read(row, i));
    const scale = buildCategoryScale(keys, {
      order: colorEnc.order ?? dim?.order,
      palette: colorEnc.palette ?? dim?.palette,
    });
    return { colorAt: (row, i): RGBA => scale.colorOf(read(row, i)), quantValues: null };
  }

  const quant = measureValues(spec, colorEnc.by);
  if (!quant) return { colorAt: (): RGBA => NEUTRAL_TINT, quantValues: null };
  const scale = quantitativeScale(colorEnc.scale, quant.domain, colorEnc.reverse);
  return { colorAt: (_row, _i, value): RGBA => scale(value), quantValues: quant.values };
}

/** Resolve every encoding channel for each row, once. */
export function compileRows<T>(
  spec: DatasetSpec<T>,
  enc: EncodingSpec<T> | undefined,
  levels: readonly Accessor<T, string>[],
): CompiledRow[] {
  const { colorAt, quantValues } = colorResolver(spec, enc);
  const sizeM = measureValues(spec, enc?.size?.by);
  const heightM = measureValues(spec, enc?.height?.by);
  const statusM = measureValues(spec, enc?.status?.by);
  const label = resolveLabel(enc, spec);
  const tooltip = resolveTooltip(enc, spec);
  const central = centralOf(enc, spec);
  const monitored = enc?.monitored;
  const links = enc?.links;
  const anchor = enc?.anchor;
  const resources = enc?.resources;
  const affinity = resolveAffinity(enc, spec);

  return spec.data.map((row, i) => {
    const value = quantValues ? quantValues[i] : 0;
    return {
      id: spec.id(row, i),
      label: label ? label(row, i) : spec.id(row, i),
      path: pathOf(row, i, levels),
      value,
      status: statusM ? statusM.values[i] : value,
      color: colorAt(row, i, value),
      size: sizeM && enc?.size ? mapRange(sizeM.values[i], sizeM.domain, enc.size.range ?? [1, 1]) : 1,
      height: heightM && enc?.height ? mapRange(heightM.values[i], heightM.domain, enc.height.range ?? [0, 1]) : 0,
      central: central(row, i),
      monitored: monitored ? monitored(row, i) : true,
      tooltip: tooltip ? tooltip(row, i) : [],
      links: links ? links(row, i) : [],
      anchor: anchor ? anchor(row, i) : '',
      affinity: affinity ? affinity(row, i) : [],
      resources: resources ? resources(row, i) : [],
      meta: spec.meta?.(row, i),
    };
  });
}

export interface ToHexGridOptions {
  placement?: HexGridInput['placement'];
  affinityWeights?: number[];
  moats?: number[];
  layers?: CompiledLayer[];
}

/** Build HexGrid cells: one cell per row, positioned by the layout hierarchy. */
export function rowsToHexGrid(
  rows: readonly CompiledRow[],
  opts: ToHexGridOptions = {},
): HexGridInput {
  const workloads: WorkloadInput[] = rows.map((r) => {
    const w: WorkloadInput = {
      name: r.id,
      id: r.id,
      criticality: r.status,
      size: Math.max(1, Math.round(r.size)),
      groupPath: r.path,
      tint: r.color,
      monitored: r.monitored,
    };
    if (r.label) w.label = r.label;
    if (r.tooltip.length > 0) w.tooltip = r.tooltip;
    if (r.central > 0) w.central = r.central;
    if (r.links.length > 0) w.deps = r.links;
    if (r.anchor) w.anchor = r.anchor;
    if (r.affinity.length > 0) w.affinity = r.affinity;
    if (r.resources.length > 0) w.resources = r.resources;
    if (r.meta) w.meta = r.meta;
    return w;
  });
  const input: HexGridInput = {
    workloads,
    placement: opts.placement ?? 'dense',
    layers: opts.layers ?? [],
  };
  if (opts.affinityWeights) input.affinityWeights = opts.affinityWeights;
  if (opts.moats) input.moats = opts.moats;
  return input;
}

export interface ToTreeMapOptions {
  /** Label for the synthetic root node. */
  rootLabel?: string;
  /** How branch values combine. Only 'sum' matches TreeMap's own semantics. */
  agg?: AggName;
}

/** Build a TreeMap tree from the hierarchy, with leaves carrying row values. */
export function treeToTreeMap(
  root: HierarchyNode,
  rows: readonly CompiledRow[],
  valueOf: (rowIndex: number) => number,
  opts: ToTreeMapOptions = {},
): TreeMapNode {
  const build = (node: HierarchyNode): TreeMapNode => {
    if (node.children.length === 0) {
      // A leaf group holds the rows themselves.
      const children = node.rows.map((i) => {
        const r = rows[i];
        const leaf: TreeMapNode = { id: r.id, label: r.label || r.id, value: valueOf(i), color: r.color };
        if (r.meta) leaf.meta = r.meta;
        return leaf;
      });
      return {
        id: node.path.join('/') || 'root',
        label: node.key || (opts.rootLabel ?? 'root'),
        value: aggregate(children.map((c) => c.value), opts.agg ?? 'sum'),
        children,
      };
    }
    const children = node.children.map(build);
    return {
      id: node.path.join('/') || 'root',
      label: node.key || (opts.rootLabel ?? 'root'),
      value: aggregate(children.map((c) => c.value), opts.agg ?? 'sum'),
      children,
    };
  };
  return build(root);
}
