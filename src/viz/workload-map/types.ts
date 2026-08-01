// Public domain model for the workload health map.
//
// The model is deliberately transport-agnostic: a backend adapter maps its
// native payload onto these records, and the store absorbs them. Every field
// except `id` is optional so a streaming source can send partial snapshots.

/** Coarse health band. Derived from a severity value, never stored by callers. */
export type HealthStatus = 'healthy' | 'warning' | 'critical' | 'unknown';

/** Band indices as stored in the aggregate counters. */
export const BAND_HEALTHY = 0;
export const BAND_WARNING = 1;
export const BAND_CRITICAL = 2;
export const BAND_UNKNOWN = 3;
export const BAND_COUNT = 4;

/** Severity thresholds separating the health bands. */
export interface HealthBands {
  /** Severity at or above this is `warning`. */
  warn: number;
  /** Severity at or above this is `critical`. */
  crit: number;
}

export const DEFAULT_BANDS: HealthBands = { warn: 0.4, crit: 0.75 };

/**
 * One node of the monitored estate. `parent` refers to another node's `id`;
 * a missing or unknown parent is tolerated (see `WorkloadStore` placeholders)
 * so out-of-order streaming does not drop data.
 */
export interface NodeInput {
  id: string;
  /** Free-form category ("vm", "database", …). Interned internally. */
  kind?: string;
  /** Parent node id. Omit for a root. */
  parent?: string;
  /**
   * Severity in [0, 1] — 0 healthy, 1 critical. Non-finite, negative or
   * missing values are treated as "no signal" and reported as `unknown`.
   */
  health?: number;
  /** Source timestamp (epoch ms) used for staleness. Defaults to now. */
  ts?: number;
}

/** How the store reacts to an operation naming an id it does not know. */
export type UnknownIdPolicy = 'ignore' | 'warn' | 'throw';

/** A non-fatal problem found while absorbing input. */
export interface Diagnostic {
  code:
    | 'invalid-id'
    | 'invalid-record'
    | 'unknown-id'
    | 'cycle-rejected'
    | 'self-parent'
    | 'capacity-exceeded'
    | 'kind-overflow';
  message: string;
  id?: string;
}

/** Outcome of a batch, used for telemetry and tests. */
export interface BatchResult {
  /** Records that changed at least one field. */
  applied: number;
  /** Records rejected as malformed or unknown. */
  rejected: number;
  /** Nodes created by this batch (including placeholders). */
  created: number;
  /** Nodes removed by this batch (including cascaded descendants). */
  removed: number;
  diagnostics: readonly Diagnostic[];
}

export interface WorkloadStoreOptions {
  /** Pre-allocate room for this many nodes. Grows automatically. */
  capacity?: number;
  /** Reaction to updates naming an unknown id. Default `'ignore'`. */
  unknownIdPolicy?: UnknownIdPolicy;
  /** Severity thresholds for the health bands. */
  bands?: HealthBands;
  /** Hard cap on hierarchy depth; deeper chains are rejected as cycles. */
  maxDepth?: number;
  /**
   * Maximum changed nodes tracked per frame. Beyond it the store stops
   * enumerating and reports `dirtyOverflowed`, signalling a full redraw.
   */
  dirtyBudget?: number;
  /**
   * Fraction of the estate above which `applyHealthBulk` abandons incremental
   * rollups and rebuilds every aggregate in one linear pass. 0 disables the
   * rebuild path entirely. Default 0.3, measured — see docs/workload-map.md §9.
   */
  rebuildCrossover?: number;
  /** Collect diagnostics per batch. Disable in hot paths. Default true. */
  collectDiagnostics?: boolean;
}

/** Aggregate health of a node's subtree. */
export interface Rollup {
  /**
   * Worst severity across the subtree, quantized *upward* to 1/64 so a rollup
   * never under-reports severity. -1 when no descendant has a signal.
   */
  worst: number;
  /** Mean severity of descendants that have a signal. -1 when none do. */
  mean: number;
  /** Exact per-band descendant counts. */
  healthy: number;
  warning: number;
  critical: number;
  unknown: number;
  /** Direct children, regardless of signal. */
  children: number;
}
