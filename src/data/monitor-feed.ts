// MonitorFeed — wires a DataSource into a MonitorTarget (a visualization).
//
// It subscribes to the source, optionally coalesces bursts of updates into a
// single per-frame batch (deduping by entity id so only the latest signal per
// entity survives), and forwards connection-state changes. This is the one
// object an application constructs to make a dashboard "live".

import type {
  ConnectionState,
  DataSource,
  EntityUpdate,
  MonitorTarget,
  ResourceUpdate,
  StateListener,
} from './types';

export interface MonitorFeedOptions {
  /** Backend adapter producing entity updates. */
  source: DataSource;
  /** Visualization absorbing the updates. */
  target: MonitorTarget;
  /**
   * Buffer updates and flush once per animation frame, deduping by entity id so
   * a firehose costs at most one `applyUpdate` per frame. Default true. Set
   * false to forward every batch synchronously as it arrives.
   */
  coalesce?: boolean;
  /** Notified whenever the source connection state changes. */
  onState?: StateListener;
}

/** Merge `next` into `into` in place, keeping the freshest signal per field. */
function mergeUpdate(into: EntityUpdate, next: EntityUpdate): void {
  if (next.severity !== undefined) into.severity = next.severity;
  if (next.anomaly !== undefined) into.anomaly = Math.max(into.anomaly ?? 0, next.anomaly);
  if (next.tint !== undefined) into.tint = next.tint;
  if (next.ts !== undefined) into.ts = next.ts;
  if (next.resources) {
    const merged = new Map<string, number>();
    for (const r of into.resources ?? []) merged.set(r.id, r.value);
    for (const r of next.resources) merged.set(r.id, r.value);
    const list: ResourceUpdate[] = [];
    for (const [id, value] of merged) list.push({ id, value });
    into.resources = list;
  }
}

export class MonitorFeed {
  private readonly source: DataSource;
  private readonly target: MonitorTarget;
  private readonly coalesce: boolean;
  private readonly onStateCb?: StateListener;

  private offData: (() => void) | null = null;
  private offState: (() => void) | null = null;
  private started = false;

  /** Latest pending update per entity id, flushed on the next frame. */
  private readonly pending = new Map<string, EntityUpdate>();
  private scheduled = 0;
  private _state: ConnectionState = 'idle';

  constructor(opts: MonitorFeedOptions) {
    this.source = opts.source;
    this.target = opts.target;
    this.coalesce = opts.coalesce ?? true;
    this.onStateCb = opts.onState;
  }

  /** Current source connection state. */
  get state(): ConnectionState {
    return this._state;
  }

  /** Subscribe to the source and begin forwarding updates to the target. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.offData = this.source.onData((records) => this._ingest(records));
    this.offState = this.source.onState((s) => {
      this._state = s;
      this.onStateCb?.(s);
    });
    this.source.start();
  }

  /** Stop the source and cancel any pending flush. */
  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.source.stop();
    this.offData?.();
    this.offState?.();
    this.offData = null;
    this.offState = null;
    if (this.scheduled) {
      this._cancel(this.scheduled);
      this.scheduled = 0;
    }
    this.pending.clear();
  }

  private _ingest(records: readonly EntityUpdate[]): void {
    if (!this.coalesce) {
      if (records.length) this.target.applyUpdate(records);
      return;
    }
    for (const r of records) {
      const prev = this.pending.get(r.id);
      if (prev) mergeUpdate(prev, r);
      else this.pending.set(r.id, { ...r });
    }
    if (this.scheduled === 0 && this.pending.size > 0) {
      this.scheduled = this._schedule(() => this._flush());
    }
  }

  private _flush(): void {
    this.scheduled = 0;
    if (this.pending.size === 0) return;
    const batch: EntityUpdate[] = [];
    for (const u of this.pending.values()) batch.push(u);
    this.pending.clear();
    this.target.applyUpdate(batch);
  }

  private _schedule(fn: () => void): number {
    const g = globalThis as typeof globalThis & {
      requestAnimationFrame?: (cb: () => void) => number;
    };
    if (typeof g.requestAnimationFrame === 'function') return g.requestAnimationFrame(fn);
    return g.setTimeout(fn, 16) as unknown as number;
  }

  private _cancel(id: number): void {
    const g = globalThis as typeof globalThis & {
      cancelAnimationFrame?: (handle: number) => void;
    };
    if (typeof g.cancelAnimationFrame === 'function') g.cancelAnimationFrame(id);
    else g.clearTimeout(id);
  }
}
