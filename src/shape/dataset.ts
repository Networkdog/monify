// The shape toolkit's entry point: declare what your rows mean, then compile
// them into cell + layer data for any monify visualization.

import type { RGBA } from '../core/types';
import { buildHierarchy, inspectHierarchy, nodesAtDepth, type HierarchyNode } from './hierarchy';
import { aggregate, describe, rollupTree, type MeasureStats } from './aggregate';
import { NEUTRAL_TINT, buildCategoryScale } from './encode';
import type { EncodingSpec } from './encode';
import { compileLayers, type CompiledLayer, type CompileLayersOptions } from './layers';
import {
  compileRows,
  rowsToHexGrid,
  treeToTreeMap,
  type CompiledRow,
  type HexGridInput,
  type ToHexGridOptions,
  type ToTreeMapOptions,
} from './compile';
import { profileRows, type DataProfile } from './profile';
import { formatReport, validateSpec, type ValidationReport } from './validate';
import type { Accessor, AggName, DatasetSpec, Issue, LegendEntry } from './types';
import type { TreeMapNode } from '../viz/treemap';

export interface DatasetOptions {
  /**
   * Validate the spec and warn about problems. Defaults to true when
   * `import.meta.env?.DEV` is set, false otherwise.
   */
  validate?: boolean;
  /** Called with any validation issues instead of the default console warning. */
  onIssues?: (issues: Issue[]) => void;
}

/** A compiled view of user rows, ready to feed the visualizations. */
export class Dataset<T> {
  readonly spec: DatasetSpec<T>;
  readonly levelNames: string[];
  readonly validation: ValidationReport;

  private readonly levels: Accessor<T, string>[];
  private _tree: HierarchyNode | null = null;

  constructor(spec: DatasetSpec<T>, opts: DatasetOptions = {}) {
    this.spec = spec;
    this.levelNames = Object.keys(spec.hierarchy ?? {});
    this.levels = this.levelNames.map((n) => (spec.hierarchy ?? {})[n]);
    this.validation = validateSpec(spec);

    const shouldValidate = opts.validate ?? isDev();
    if (shouldValidate) {
      const issues = [...this.validation.errors, ...this.validation.warnings];
      if (issues.length > 0) {
        if (opts.onIssues) opts.onIssues(issues);
        else console.warn(formatReport(this.validation));
      }
    }
  }

  /** Row count. */
  get size(): number {
    return this.spec.data.length;
  }

  /** The containment tree (built once, then cached). */
  get tree(): HierarchyNode {
    if (!this._tree) this._tree = buildHierarchy(this.spec.data, this.levels);
    return this._tree;
  }

  /** Groups at one hierarchy level, coarsest = the first declared level. */
  groupsAt(level: string): HierarchyNode[] {
    const depth = this.levelNames.indexOf(level) + 1;
    return depth === 0 ? [] : nodesAtDepth(this.tree, depth);
  }

  /** Summary statistics for a declared measure. */
  stats(measure: string): MeasureStats {
    const m = this.spec.measures?.[measure];
    if (!m) return describe([]);
    return describe(this.spec.data.map((r, i) => m.value(r, i)));
  }

  /** Aggregate a measure across every group, keyed by path. */
  rollup(measure: string, agg?: AggName): Map<string, number> {
    const m = this.spec.measures?.[measure];
    if (!m) return new Map();
    const valueOf = (i: number): number => {
      const v = m.value(this.spec.data[i], i);
      return Number.isFinite(v) ? v : 0;
    };
    const weight = m.weight;
    const weightOf = weight ? (i: number): number => weight(this.spec.data[i], i) : undefined;
    return rollupTree(this.tree, valueOf, agg ?? m.agg ?? 'mean', weightOf);
  }

  /** Aggregate a measure over the whole dataset. */
  total(measure: string, agg?: AggName): number {
    const m = this.spec.measures?.[measure];
    if (!m) return 0;
    const values = this.spec.data.map((r, i) => {
      const v = m.value(r, i);
      return Number.isFinite(v) ? v : 0;
    });
    return aggregate(values, agg ?? m.agg ?? 'mean');
  }

  /** Legend entries for a categorical dimension or hierarchy level. */
  legend(dimension: string): LegendEntry[] {
    const dim = this.spec.dimensions?.[dimension];
    const read = dim?.of ?? this.spec.hierarchy?.[dimension];
    if (!read) return [];
    const keys = this.spec.data.map((r, i) => read(r, i));
    return buildCategoryScale(keys, { order: dim?.order, palette: dim?.palette }).legend;
  }

  /** Per-row categorical colors for a dimension, aligned to `spec.data`. */
  tints(dimension: string): RGBA[] {
    const dim = this.spec.dimensions?.[dimension];
    const read = dim?.of ?? this.spec.hierarchy?.[dimension];
    if (!read) return this.spec.data.map(() => NEUTRAL_TINT);
    const keys = this.spec.data.map((r, i) => read(r, i));
    const scale = buildCategoryScale(keys, { order: dim?.order, palette: dim?.palette });
    return keys.map((k) => scale.colorOf(k));
  }

  /** Infer field kinds, hierarchy candidates, a placement recommendation, and quality warnings. */
  profile(): DataProfile {
    const fields: Record<string, (row: T, index: number) => unknown> = {};
    for (const [name, of] of Object.entries(this.spec.hierarchy ?? {})) fields[name] = of;
    for (const [name, d] of Object.entries(this.spec.dimensions ?? {})) fields[name] = d.of;
    for (const [name, m] of Object.entries(this.spec.measures ?? {})) fields[name] = m.value;
    const p = profileRows(this.spec.data, fields);
    p.issues.push(...inspectHierarchy(this.tree, this.levelNames));
    return p;
  }

  /** Resolve every encoding channel for each row. */
  encode(enc?: EncodingSpec<T>): CompiledRow[] {
    return compileRows(this.spec, enc, this.layoutLevels(enc));
  }

  /** Build the zoom layers, one per layout level. */
  layers(enc?: EncodingSpec<T>, opts: CompileLayersOptions = {}): CompiledLayer[] {
    const names = this.layoutNames(enc);
    const tree = names.length === this.levelNames.length
      ? this.tree
      : buildHierarchy(this.spec.data, this.layoutLevels(enc));
    const colorBy = enc?.status?.by ?? enc?.color?.by;
    const measure = colorBy ? this.spec.measures?.[colorBy] : undefined;
    const valueAt = measure
      ? (i: number): number => {
          const v = measure.value(this.spec.data[i], i);
          return Number.isFinite(v) ? v : 0;
        }
      : undefined;
    return compileLayers(tree, names, { ...opts, valueAt: opts.valueAt ?? valueAt });
  }

  /** Compile HexGrid cells + layers from an encoding. */
  toHexGrid(enc?: EncodingSpec<T>, opts: ToHexGridOptions = {}): HexGridInput {
    const rows = this.encode(enc);
    return rowsToHexGrid(rows, { ...opts, layers: opts.layers ?? this.layers(enc) });
  }

  /** Compile a TreeMap tree from an encoding. */
  toTreeMap(enc?: EncodingSpec<T>, opts: ToTreeMapOptions = {}): TreeMapNode {
    const rows = this.encode(enc);
    const names = this.layoutNames(enc);
    const tree = names.length === this.levelNames.length
      ? this.tree
      : buildHierarchy(this.spec.data, this.layoutLevels(enc));
    const sizeBy = enc?.size?.by;
    const measure = sizeBy ? this.spec.measures?.[sizeBy] : undefined;
    const valueOf = measure
      ? (i: number): number => {
          const v = measure.value(this.spec.data[i], i);
          return Number.isFinite(v) ? v : 0;
        }
      : (): number => 1;
    return treeToTreeMap(tree, rows, valueOf, opts);
  }

  private layoutNames(enc?: EncodingSpec<T>): string[] {
    const requested = enc?.layout;
    if (!requested || requested.length === 0) return this.levelNames;
    return requested.filter((n) => this.spec.hierarchy?.[n] !== undefined);
  }

  private layoutLevels(enc?: EncodingSpec<T>): Accessor<T, string>[] {
    return this.layoutNames(enc).map((n) => (this.spec.hierarchy ?? {})[n]);
  }
}

function isDev(): boolean {
  const env = (import.meta as { env?: { DEV?: boolean } }).env;
  return env?.DEV === true;
}

/** Declare a dataset: what identifies a row, how rows nest, and what they measure. */
export function defineDataset<T>(spec: DatasetSpec<T>, opts?: DatasetOptions): Dataset<T> {
  return new Dataset(spec, opts);
}
