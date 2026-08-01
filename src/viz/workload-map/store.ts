// WorkloadStore — a Structure-of-Arrays state layer for very large estates.
//
// Design rationale (this is the load-bearing decision of the whole library):
// one JS object per node costs ~80-150 bytes of heap plus a GC edge, so a
// million nodes both blows the memory budget and turns every sweep into a
// multi-millisecond GC pause. Instead every field lives in a parallel typed
// array indexed by a dense integer `handle`, so node state is contiguous,
// pointer-free, and invisible to the garbage collector.
//
// Two properties matter for the render loop:
//
//   1. Updates never scan. `applyBatch` costs O(batch), not O(nodes), and the
//      set of touched handles is published through a dirty queue so the
//      renderer re-uploads only what moved. There is no diffing pass.
//   2. Rollups are O(depth), not O(children). Each parent keeps bucketed
//      counters plus a bitmask, so "worst severity among my children" is a
//      `Math.clz32` away even when a child's severity *drops* — the case a
//      plain running max cannot handle without a rescan.

import {
  BAND_COUNT,
  BAND_CRITICAL,
  BAND_HEALTHY,
  BAND_UNKNOWN,
  BAND_WARNING,
  DEFAULT_BANDS,
  type BatchResult,
  type Diagnostic,
  type HealthBands,
  type HealthStatus,
  type NodeInput,
  type Rollup,
  type UnknownIdPolicy,
  type WorkloadStoreOptions,
} from './types';

/** Severity resolution of the rollup mask: 64 buckets over [0, 1]. */
const BUCKETS = 64;
const NO_SIGNAL = -1;
const NIL = -1;

/** Band ranks ordered by how bad they are. -1 means "no signal at all". */
const RANK_NONE = -1;
const RANK_HEALTHY = 0;
const RANK_WARNING = 1;
const RANK_CRITICAL = 2;

const FLAG_ALIVE = 1 << 0;
/** Created only to host a child; not yet described by its own record. */
const FLAG_PLACEHOLDER = 1 << 1;

const DEFAULT_CAPACITY = 1024;
const DEFAULT_MAX_DEPTH = 64;
const MAX_KINDS = 0xffff;
/**
 * Past this many changed nodes in one frame, enumerating them costs more than
 * the full pass the consumer would do anyway, so the queue stops recording and
 * raises {@link WorkloadStore.dirtyOverflowed} instead.
 */
const DEFAULT_DIRTY_BUDGET = 65_536;
/**
 * Share of the estate above which a full rebuild beats incremental maintenance.
 * Measured, not guessed: rebuild cost is dominated by a fixed full traversal
 * (~100 ms at 1M nodes) while incremental scales at ~3.5 ms per 1% of the
 * estate, so the two cross near 31%. See docs/workload-map.md §9.
 */
const DEFAULT_REBUILD_CROSSOVER = 0.3;

function growF32(src: Float32Array, n: number): Float32Array {
  const out = new Float32Array(n);
  out.set(src);
  return out;
}
function growI32(src: Int32Array, n: number): Int32Array {
  const out = new Int32Array(n);
  out.set(src);
  return out;
}
function growU32(src: Uint32Array, n: number): Uint32Array {
  const out = new Uint32Array(n);
  out.set(src);
  return out;
}
function growU16(src: Uint16Array, n: number): Uint16Array {
  const out = new Uint16Array(n);
  out.set(src);
  return out;
}
function growU8(src: Uint8Array, n: number): Uint8Array {
  const out = new Uint8Array(n);
  out.set(src);
  return out;
}
function growI8(src: Int8Array, n: number): Int8Array {
  const out = new Int8Array(n);
  out.set(src);
  return out;
}
function growF64(src: Float64Array, n: number): Float64Array {
  const out = new Float64Array(n);
  out.set(src);
  return out;
}

/**
 * Coerce untrusted input into a severity in [0, 1], or {@link NO_SIGNAL}.
 *
 * Streaming payloads are hostile in practice: `null`, `"0.42"`, `NaN`,
 * `Infinity` and out-of-range numbers all show up. None of them may throw or
 * poison the typed arrays, so everything unusable collapses to "no signal".
 */
export function sanitizeHealth(v: unknown): number {
  let n: number;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string' && v.length > 0) n = Number(v);
  else return NO_SIGNAL;
  if (!Number.isFinite(n)) return NO_SIGNAL;
  if (n <= 0) return 0;
  return n >= 1 ? 1 : n;
}

/** Bucket index for a severity, or -1 when there is no signal. */
function bucketOf(v: number): number {
  if (v < 0) return NIL;
  const b = (v * BUCKETS) | 0;
  return b >= BUCKETS ? BUCKETS - 1 : b;
}

/** Upper bound of a bucket — rounding severity *up* never hides an incident. */
function bucketValue(b: number): number {
  if (b < 0) return NO_SIGNAL;
  const v = (b + 1) / BUCKETS;
  return v > 1 ? 1 : v;
}

export class WorkloadStore {
  // ── Identity ───────────────────────────────────────────────────────────────
  private readonly index = new Map<string, number>();
  private ids: (string | undefined)[] = [];

  // ── Per-node columns (indexed by handle) ───────────────────────────────────
  /** Severity reported for this node itself; -1 when it has no signal. */
  private health: Float32Array;
  /** Worst bucket across own value and subtree. Propagated, never re-quantized. */
  private rollBucket: Int8Array;
  /** Worst band rank across own value and subtree. Exact — never quantized. */
  private rollBand: Int8Array;
  private kindId: Uint16Array;
  private parent: Int32Array;
  private firstChild: Int32Array;
  private nextSibling: Int32Array;
  private prevSibling: Int32Array;
  private flags: Uint8Array;
  /** Bucket this node currently occupies in its parent's counters. */
  private slotBucket: Int8Array;
  /** Band counter index this node currently occupies in its parent. */
  private slotBand: Int8Array;
  /** Index into the aggregate pool, or -1 for a node with no children. */
  private aggOf: Int32Array;
  private lastSeen: Float64Array;

  // ── Aggregate pool (only nodes that actually have children get a slot) ─────
  private aggCounts: Uint32Array;
  private aggMaskLo: Uint32Array;
  private aggMaskHi: Uint32Array;
  private aggBands: Uint32Array;
  private aggSum: Float64Array;
  private aggSignal: Uint32Array;
  private aggChildren: Uint32Array;
  private aggCapacity: number;
  private aggCount = 0;
  private aggFree: number[] = [];

  // ── Dirty tracking ─────────────────────────────────────────────────────────
  private dirtyQueue: Uint32Array;
  private dirtyMark: Uint8Array;
  private dirtyCount = 0;  private readonly dirtyBudget: number;
  private dirtyOverflow = false;
  /** Bottom-up traversal order, allocated only if the rebuild path is used. */
  private rebuildScratch: Uint32Array | null = null;
  // ── Free list & bookkeeping ────────────────────────────────────────────────
  private freeList: number[] = [];
  private capacityValue: number;
  private used = 0;
  private liveCount = 0;

  private readonly kinds = new Map<string, number>();
  private kindNames: string[] = [];

  private readonly bands: HealthBands;
  private readonly unknownIdPolicy: UnknownIdPolicy;
  private readonly maxDepth: number;
  private readonly collectDiagnostics: boolean;
  private readonly rebuildCrossover: number;

  /** Bumped whenever the node set or hierarchy changes (drives re-layout). */
  topologyVersion = 0;
  /** Bumped whenever any severity changes (drives re-paint). */
  stateVersion = 0;

  constructor(opts: WorkloadStoreOptions = {}) {
    const cap = Math.max(8, opts.capacity ?? DEFAULT_CAPACITY);
    this.capacityValue = cap;
    this.bands = opts.bands ?? DEFAULT_BANDS;
    this.unknownIdPolicy = opts.unknownIdPolicy ?? 'ignore';
    this.maxDepth = Math.max(1, opts.maxDepth ?? DEFAULT_MAX_DEPTH);
    this.collectDiagnostics = opts.collectDiagnostics ?? true;
    this.dirtyBudget = Math.max(1, opts.dirtyBudget ?? DEFAULT_DIRTY_BUDGET);
    this.rebuildCrossover = opts.rebuildCrossover ?? DEFAULT_REBUILD_CROSSOVER;

    this.health = new Float32Array(cap).fill(NO_SIGNAL);
    this.rollBucket = new Int8Array(cap).fill(NIL);
    this.rollBand = new Int8Array(cap).fill(RANK_NONE);
    this.kindId = new Uint16Array(cap);
    this.parent = new Int32Array(cap).fill(NIL);
    this.firstChild = new Int32Array(cap).fill(NIL);
    this.nextSibling = new Int32Array(cap).fill(NIL);
    this.prevSibling = new Int32Array(cap).fill(NIL);
    this.flags = new Uint8Array(cap);
    this.slotBucket = new Int8Array(cap).fill(NIL);
    this.slotBand = new Int8Array(cap).fill(NIL);
    this.aggOf = new Int32Array(cap).fill(NIL);
    this.lastSeen = new Float64Array(cap);

    this.aggCapacity = 16;
    this.aggCounts = new Uint32Array(this.aggCapacity * BUCKETS);
    this.aggMaskLo = new Uint32Array(this.aggCapacity);
    this.aggMaskHi = new Uint32Array(this.aggCapacity);
    this.aggBands = new Uint32Array(this.aggCapacity * BAND_COUNT);
    this.aggSum = new Float64Array(this.aggCapacity);
    this.aggSignal = new Uint32Array(this.aggCapacity);
    this.aggChildren = new Uint32Array(this.aggCapacity);

    this.dirtyQueue = new Uint32Array(cap);
    this.dirtyMark = new Uint8Array(cap);
  }

  // ── Introspection ──────────────────────────────────────────────────────────

  /** Number of live nodes. */
  get size(): number {
    return this.liveCount;
  }

  /** Allocated slots, including free-listed ones. */
  get capacity(): number {
    return this.capacityValue;
  }

  /** Bytes held by the columnar state. Excludes id strings and the id index. */
  get columnBytes(): number {
    const perNode = 4 + 1 + 1 + 2 + 4 + 4 + 4 + 4 + 1 + 1 + 1 + 4 + 8 + 4 + 1;
    const perAgg = BUCKETS * 4 + 4 + 4 + BAND_COUNT * 4 + 8 + 4 + 4;
    const scratch = this.rebuildScratch === null ? 0 : this.rebuildScratch.byteLength;
    return this.capacityValue * perNode + this.aggCapacity * perAgg + scratch;
  }

  has(id: string): boolean {
    return this.index.has(id);
  }

  /** Stable integer handle for an id, or -1. Handles survive updates. */
  handleOf(id: string): number {
    const h = this.index.get(id);
    return h === undefined ? NIL : h;
  }

  idOf(handle: number): string | undefined {
    return this.isLive(handle) ? this.ids[handle] : undefined;
  }

  kindOf(handle: number): string | undefined {
    if (!this.isLive(handle)) return undefined;
    return this.kindNames[this.kindId[handle]];
  }

  /** Severity reported for the node itself, or -1 when it has no signal. */
  healthOf(handle: number): number {
    return this.isLive(handle) ? this.health[handle] : NO_SIGNAL;
  }

  /**
   * Effective severity: the node's own value or its subtree's worst, whichever
   * is higher. Exact for leaves; for parents the subtree part is quantized
   * upward to at most one bucket (1/64) above the true worst.
   */
  severityOf(handle: number): number {
    if (!this.isLive(handle)) return NO_SIGNAL;
    let v = this.health[handle];
    const slot = this.aggOf[handle];
    if (slot !== NIL) {
      const worst = bucketValue(this.worstBucket(slot));
      if (worst > v) v = worst;
    }
    return v;
  }

  /** Health band of the node including its subtree. Exact at every depth. */
  statusOf(handle: number): HealthStatus {
    if (!this.isLive(handle)) return 'unknown';
    return this.bandName(this.rollBand[handle]);
  }

  parentOf(handle: number): number {
    return this.isLive(handle) ? this.parent[handle] : NIL;
  }

  /** Direct children as handles. Allocates; prefer `forEachChild` in hot code. */
  childrenOf(handle: number): number[] {
    const out: number[] = [];
    if (!this.isLive(handle)) return out;
    for (let c = this.firstChild[handle]; c !== NIL; c = this.nextSibling[c]) out.push(c);
    return out;
  }

  forEachChild(handle: number, fn: (child: number) => void): void {
    if (!this.isLive(handle)) return;
    let c = this.firstChild[handle];
    while (c !== NIL) {
      // Read the successor first so the callback may safely remove `c`.
      const next = this.nextSibling[c];
      fn(c);
      c = next;
    }
  }

  /** Aggregate health of a node's direct children. */
  rollupOf(handle: number): Rollup {
    const empty: Rollup = {
      worst: NO_SIGNAL,
      mean: NO_SIGNAL,
      healthy: 0,
      warning: 0,
      critical: 0,
      unknown: 0,
      children: 0,
    };
    if (!this.isLive(handle)) return empty;
    const slot = this.aggOf[handle];
    if (slot === NIL) return empty;
    const base = slot * BAND_COUNT;
    const signal = this.aggSignal[slot];
    return {
      worst: bucketValue(this.worstBucket(slot)),
      mean: signal > 0 ? this.aggSum[slot] / signal : NO_SIGNAL,
      healthy: this.aggBands[base + BAND_HEALTHY],
      warning: this.aggBands[base + BAND_WARNING],
      critical: this.aggBands[base + BAND_CRITICAL],
      unknown: this.aggBands[base + BAND_UNKNOWN],
      children: this.aggChildren[slot],
    };
  }

  /** Live handles, newest slots last. Allocates; for tests and small estates. */
  handles(): number[] {
    const out: number[] = [];
    for (let h = 0; h < this.used; h++) if (this.flags[h] & FLAG_ALIVE) out.push(h);
    return out;
  }

  // ── Mutation ───────────────────────────────────────────────────────────────

  /**
   * Absorb a batch of records. Records are applied in order, so two updates to
   * the same id inside one batch resolve last-write-wins. Malformed records are
   * skipped rather than aborting the batch — a single bad row from a firehose
   * must not lose the other 9,999.
   */
  applyBatch(records: readonly NodeInput[]): BatchResult {
    const diagnostics: Diagnostic[] = [];
    let applied = 0;
    let rejected = 0;
    const before = this.liveCount;

    for (let i = 0; i < records.length; i++) {
      const rec = records[i] as NodeInput | null | undefined;
      if (rec === null || rec === undefined || typeof rec !== 'object') {
        rejected++;
        this.note(diagnostics, { code: 'invalid-record', message: 'record is not an object' });
        continue;
      }
      const id = rec.id;
      if (typeof id !== 'string' || id.length === 0) {
        rejected++;
        this.note(diagnostics, { code: 'invalid-id', message: 'record has no usable id' });
        continue;
      }
      const h = this.intern(id, diagnostics);
      if (h === NIL) {
        rejected++;
        continue;
      }
      this.flags[h] &= ~FLAG_PLACEHOLDER;
      if (this.writeRecord(h, rec, diagnostics)) applied++;
    }

    return {
      applied,
      rejected,
      created: this.liveCount - before,
      removed: 0,
      diagnostics,
    };
  }

  /** Convenience single-record upsert. */
  upsert(node: NodeInput): BatchResult {
    return this.applyBatch([node]);
  }

  /**
   * Zero-allocation streaming path: apply `count` severities addressed by
   * handle. Callers resolve ids to handles once and then stream typed arrays,
   * which keeps a 50 ms tick free of both object churn and hash lookups.
   * Out-of-range or dead handles are skipped.
   */
  applyHealthBulk(
    handles: Int32Array | Uint32Array,
    values: Float32Array | Float64Array,
    count = handles.length,
    ts = Date.now(),
  ): number {
    const n = Math.min(count, handles.length, values.length);
    if (n >= this.rebuildFloor()) return this.bulkThenRebuild(handles, values, n, ts);
    let applied = 0;
    for (let i = 0; i < n; i++) {
      const h = handles[i];
      if (h < 0 || h >= this.used || (this.flags[h] & FLAG_ALIVE) === 0) continue;
      // Inline clamp: values arrive from a typed array, so the general
      // sanitizer's type dispatch is pure overhead on the hot path.
      const raw = values[i];
      let v: number;
      if (raw >= 0 && raw <= 1) v = raw;
      else if (!Number.isFinite(raw)) v = NO_SIGNAL;
      else v = raw < 0 ? 0 : 1;
      this.lastSeen[h] = ts;
      if (this.health[h] === v) continue;
      this.health[h] = v;
      this.markDirty(h);
      this.refreshRoll(h);
      applied++;
    }
    if (applied > 0) this.stateVersion++;
    return applied;
  }

  /** Batch size at or above which a rebuild beats incremental maintenance. */
  private rebuildFloor(): number {
    if (this.rebuildCrossover <= 0) return Infinity;
    return Math.max(1, this.liveCount * this.rebuildCrossover);
  }

  /**
   * Saturated-batch path: write every severity without touching a single
   * aggregate, then recompute all of them in one traversal. Incremental
   * maintenance would scatter a register/unregister pair across each parent's
   * counters per child; the rebuild visits each parent's counters once.
   */
  private bulkThenRebuild(
    handles: Int32Array | Uint32Array,
    values: Float32Array | Float64Array,
    n: number,
    ts: number,
  ): number {
    let applied = 0;
    for (let i = 0; i < n; i++) {
      const h = handles[i];
      if (h < 0 || h >= this.used || (this.flags[h] & FLAG_ALIVE) === 0) continue;
      const raw = values[i];
      let v: number;
      if (raw >= 0 && raw <= 1) v = raw;
      else if (!Number.isFinite(raw)) v = NO_SIGNAL;
      else v = raw < 0 ? 0 : 1;
      this.lastSeen[h] = ts;
      if (this.health[h] === v) continue;
      this.health[h] = v;
      this.markDirty(h);
      applied++;
    }
    if (applied > 0) {
      this.rebuildAggregates();
      this.stateVersion++;
    }
    return applied;
  }

  /**
   * Recompute every rollup from scratch. Children are visited before their
   * parents, so one pass suffices; the result is bit-identical to what
   * incremental maintenance would have produced.
   */
  private rebuildAggregates(): void {
    const order = this.ensureRebuildScratch();

    // Breadth-first from the roots. The queue and the output order are the same
    // array: appending children while walking it yields a top-down ordering,
    // which read backwards is exactly the bottom-up order we need.
    let tail = 0;
    for (let h = 0; h < this.used; h++) {
      if ((this.flags[h] & FLAG_ALIVE) === 0) continue;
      if (this.parent[h] === NIL) order[tail++] = h;
    }
    for (let head = 0; head < tail; head++) {
      const h = order[head];
      const slot = this.aggOf[h];
      if (slot !== NIL) this.resetAggSlot(slot);
      for (let c = this.firstChild[h]; c !== NIL; c = this.nextSibling[c]) order[tail++] = c;
    }

    for (let i = tail - 1; i >= 0; i--) {
      const h = order[i];
      const own = this.health[h];
      let bucket = bucketOf(own);
      let rank = this.rankOf(own);
      const slot = this.aggOf[h];
      if (slot !== NIL) {
        const wb = this.worstBucket(slot);
        if (wb > bucket) bucket = wb;
        const wr = this.worstBand(slot);
        if (wr > rank) rank = wr;
      }
      if (this.rollBucket[h] !== bucket || this.rollBand[h] !== rank) {
        this.rollBucket[h] = bucket;
        this.rollBand[h] = rank;
        this.markDirty(h);
      }
      const p = this.parent[h];
      if (p === NIL) continue;
      const pslot = this.aggOf[p];
      if (pslot === NIL) continue;
      this.aggChildren[pslot]++;
      this.addToAgg(pslot, h);
    }
  }

  private ensureRebuildScratch(): Uint32Array {
    const need = this.used;
    let buf = this.rebuildScratch;
    if (buf === null || buf.length < need) {
      buf = new Uint32Array(Math.max(need, 1024));
      this.rebuildScratch = buf;
    }
    return buf;
  }

  /** Set one node's severity. Returns false when the id is unknown. */
  setHealth(id: string, value: number, ts = Date.now()): boolean {
    const h = this.index.get(id);
    if (h === undefined) {
      this.onUnknownId(id);
      return false;
    }
    const v = sanitizeHealth(value);
    this.lastSeen[h] = ts;
    if (this.health[h] === v) return true;
    this.health[h] = v;
    this.markDirty(h);
    this.refreshRoll(h);
    this.stateVersion++;
    return true;
  }

  /**
   * Remove a node and its whole subtree. Iterative on purpose: a recursive
   * cascade blows the JS stack on deep or wide estates.
   */
  remove(id: string): number {
    const root = this.index.get(id);
    if (root === undefined) {
      this.onUnknownId(id);
      return 0;
    }
    const stack: number[] = [root];
    const doomed: number[] = [];
    while (stack.length > 0) {
      const h = stack.pop() as number;
      doomed.push(h);
      for (let c = this.firstChild[h]; c !== NIL; c = this.nextSibling[c]) stack.push(c);
    }
    // Detach the subtree root once; descendants are freed without touching
    // their parents' counters, which are about to be freed anyway.
    this.detachFromParent(root);
    for (let i = doomed.length - 1; i >= 0; i--) this.free(doomed[i]);
    this.topologyVersion++;
    return doomed.length;
  }

  /** Mark nodes whose last update is older than `maxAgeMs` as having no signal. */
  expireStale(maxAgeMs: number, now = Date.now()): number {
    if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) return 0;
    const cutoff = now - maxAgeMs;
    let expired = 0;
    for (let h = 0; h < this.used; h++) {
      if ((this.flags[h] & FLAG_ALIVE) === 0) continue;
      if (this.health[h] === NO_SIGNAL) continue;
      if (this.lastSeen[h] > cutoff) continue;
      this.health[h] = NO_SIGNAL;
      this.markDirty(h);
      this.refreshRoll(h);
      expired++;
    }
    if (expired > 0) this.stateVersion++;
    return expired;
  }

  // ── Dirty queue ────────────────────────────────────────────────────────────

  get dirtySize(): number {
    return this.dirtyCount;
  }

  /**
   * True when more nodes changed than the dirty budget allows tracking. The
   * consumer must fall back to a full pass; `drainDirty` returns nothing.
   */
  get dirtyOverflowed(): boolean {
    return this.dirtyOverflow;
  }

  /**
   * Hand the renderer the handles touched since the last drain and reset the
   * queue. The returned view aliases internal memory and is valid only until
   * the next mutation — copy it if you need to retain it. Consumers must
   * tolerate handles that died after being queued.
   */
  drainDirty(): Uint32Array {
    const view = this.dirtyQueue.subarray(0, this.dirtyCount);
    for (let i = 0; i < this.dirtyCount; i++) this.dirtyMark[this.dirtyQueue[i]] = 0;
    this.dirtyCount = 0;
    this.dirtyOverflow = false;
    return view;
  }

  clearDirty(): void {
    for (let i = 0; i < this.dirtyCount; i++) this.dirtyMark[this.dirtyQueue[i]] = 0;
    this.dirtyCount = 0;
    this.dirtyOverflow = false;
  }

  // ── Internals: identity & storage ──────────────────────────────────────────

  private isLive(h: number): boolean {
    return h >= 0 && h < this.used && (this.flags[h] & FLAG_ALIVE) !== 0;
  }

  private note(sink: Diagnostic[], d: Diagnostic): void {
    if (this.collectDiagnostics) sink.push(d);
  }

  private onUnknownId(id: string): void {
    if (this.unknownIdPolicy === 'throw') throw new Error(`unknown node id: ${id}`);
    if (this.unknownIdPolicy === 'warn') console.warn(`[monify] unknown node id: ${id}`);
  }

  /** Resolve an id to a handle, allocating a fresh node when new. */
  private intern(id: string, sink: Diagnostic[]): number {
    const existing = this.index.get(id);
    if (existing !== undefined) return existing;
    const h = this.alloc();
    if (h === NIL) {
      this.note(sink, { code: 'capacity-exceeded', message: 'node capacity exhausted', id });
      return NIL;
    }
    this.ids[h] = id;
    this.index.set(id, h);
    this.topologyVersion++;
    return h;
  }

  private alloc(): number {
    let h: number;
    if (this.freeList.length > 0) {
      h = this.freeList.pop() as number;
    } else {
      if (this.used === this.capacityValue) this.growColumns();
      h = this.used++;
    }
    // A recycled slot must not inherit anything from its previous tenant.
    this.health[h] = NO_SIGNAL;
    this.rollBucket[h] = NIL;
    this.rollBand[h] = RANK_NONE;
    this.kindId[h] = 0;
    this.parent[h] = NIL;
    this.firstChild[h] = NIL;
    this.nextSibling[h] = NIL;
    this.prevSibling[h] = NIL;
    this.slotBucket[h] = NIL;
    this.slotBand[h] = NIL;
    this.aggOf[h] = NIL;
    this.lastSeen[h] = 0;
    this.flags[h] = FLAG_ALIVE;
    this.liveCount++;
    return h;
  }

  private free(h: number): void {
    if ((this.flags[h] & FLAG_ALIVE) === 0) return;
    this.releaseAgg(h);
    const id = this.ids[h];
    if (id !== undefined) this.index.delete(id);
    // Drop the string reference so a dead slot cannot pin the id in memory.
    this.ids[h] = undefined;
    this.flags[h] = 0;
    this.parent[h] = NIL;
    this.firstChild[h] = NIL;
    this.nextSibling[h] = NIL;
    this.prevSibling[h] = NIL;
    this.health[h] = NO_SIGNAL;
    this.rollBucket[h] = NIL;
    this.rollBand[h] = RANK_NONE;
    this.dirtyMark[h] = 0;
    this.liveCount--;
    this.freeList.push(h);
  }

  private growColumns(): void {
    const n = this.capacityValue * 2;
    const old = this.capacityValue;
    this.health = growF32(this.health, n);
    this.rollBucket = growI8(this.rollBucket, n);
    this.rollBand = growI8(this.rollBand, n);
    this.kindId = growU16(this.kindId, n);
    this.parent = growI32(this.parent, n);
    this.firstChild = growI32(this.firstChild, n);
    this.nextSibling = growI32(this.nextSibling, n);
    this.prevSibling = growI32(this.prevSibling, n);
    this.flags = growU8(this.flags, n);
    this.slotBucket = growI8(this.slotBucket, n);
    this.slotBand = growI8(this.slotBand, n);
    this.aggOf = growI32(this.aggOf, n);
    this.lastSeen = growF64(this.lastSeen, n);
    this.dirtyQueue = growU32(this.dirtyQueue, n);
    this.dirtyMark = growU8(this.dirtyMark, n);
    this.health.fill(NO_SIGNAL, old);
    this.rollBucket.fill(NIL, old);
    this.rollBand.fill(RANK_NONE, old);
    this.parent.fill(NIL, old);
    this.firstChild.fill(NIL, old);
    this.nextSibling.fill(NIL, old);
    this.prevSibling.fill(NIL, old);
    this.slotBucket.fill(NIL, old);
    this.slotBand.fill(NIL, old);
    this.aggOf.fill(NIL, old);
    this.capacityValue = n;
  }

  private markDirty(h: number): void {
    if (this.dirtyOverflow || this.dirtyMark[h] !== 0) return;
    if (this.dirtyCount >= this.dirtyBudget) {
      // Stop enumerating: past the budget a full consumer pass is cheaper than
      // the bookkeeping, so drop the list and let the consumer redraw wholesale.
      for (let i = 0; i < this.dirtyCount; i++) this.dirtyMark[this.dirtyQueue[i]] = 0;
      this.dirtyCount = 0;
      this.dirtyOverflow = true;
      return;
    }
    if (this.dirtyCount === this.dirtyQueue.length) {
      this.dirtyQueue = growU32(this.dirtyQueue, Math.max(8, this.dirtyQueue.length * 2));
    }
    this.dirtyMark[h] = 1;
    this.dirtyQueue[this.dirtyCount++] = h;
  }

  private internKind(kind: string, sink: Diagnostic[]): number {
    const existing = this.kinds.get(kind);
    if (existing !== undefined) return existing;
    if (this.kindNames.length >= MAX_KINDS) {
      this.note(sink, { code: 'kind-overflow', message: `too many kinds; "${kind}" folded` });
      return 0;
    }
    const id = this.kindNames.length;
    this.kindNames.push(kind);
    this.kinds.set(kind, id);
    return id;
  }

  // ── Internals: record application ──────────────────────────────────────────

  private writeRecord(h: number, rec: NodeInput, sink: Diagnostic[]): boolean {
    let changed = false;

    if (typeof rec.kind === 'string' && rec.kind.length > 0) {
      const k = this.internKind(rec.kind, sink);
      if (this.kindId[h] !== k) {
        this.kindId[h] = k;
        changed = true;
      }
    }

    if (rec.parent !== undefined) {
      if (typeof rec.parent === 'string' && rec.parent.length > 0) {
        if (this.reparent(h, rec.parent, sink)) changed = true;
      } else {
        this.note(sink, { code: 'invalid-record', message: 'parent is not a string', id: rec.id });
      }
    }

    if ('health' in rec) {
      const v = sanitizeHealth(rec.health);
      if (this.health[h] !== v) {
        this.health[h] = v;
        changed = true;
        this.markDirty(h);
        this.refreshRoll(h);
        this.stateVersion++;
      }
    }

    const ts = typeof rec.ts === 'number' && Number.isFinite(rec.ts) ? rec.ts : Date.now();
    this.lastSeen[h] = ts;
    return changed;
  }

  /** Attach `h` under `parentId`, creating a placeholder parent if needed. */
  private reparent(h: number, parentId: string, sink: Diagnostic[]): boolean {
    if (this.ids[h] === parentId) {
      this.note(sink, { code: 'self-parent', message: 'node cannot parent itself', id: parentId });
      return false;
    }
    let p = this.index.get(parentId);
    if (p === undefined) {
      // Forward reference: streams often deliver a child before its parent.
      p = this.intern(parentId, sink);
      if (p === NIL) return false;
      this.flags[p] |= FLAG_PLACEHOLDER;
    }
    if (this.parent[h] === p) return false;
    if (this.wouldCycle(h, p)) {
      this.note(sink, {
        code: 'cycle-rejected',
        message: `parenting under "${parentId}" would create a cycle`,
        id: this.ids[h],
      });
      return false;
    }
    this.detachFromParent(h);
    this.attachToParent(h, p);
    this.topologyVersion++;
    return true;
  }

  /** True when `candidate` is `h` itself or already inside `h`'s subtree. */
  private wouldCycle(h: number, candidate: number): boolean {
    let cur = candidate;
    let guard = 0;
    while (cur !== NIL) {
      if (cur === h) return true;
      if (++guard > this.maxDepth) return true;
      cur = this.parent[cur];
    }
    return false;
  }

  private attachToParent(h: number, p: number): void {
    this.parent[h] = p;
    const head = this.firstChild[p];
    this.nextSibling[h] = head;
    this.prevSibling[h] = NIL;
    if (head !== NIL) this.prevSibling[head] = h;
    this.firstChild[p] = h;

    const slot = this.ensureAgg(p);
    this.aggChildren[slot]++;
    this.addToAgg(slot, h);
    this.refreshRoll(p);
  }

  private detachFromParent(h: number): void {
    const p = this.parent[h];
    if (p === NIL) return;
    const prev = this.prevSibling[h];
    const next = this.nextSibling[h];
    if (prev !== NIL) this.nextSibling[prev] = next;
    else this.firstChild[p] = next;
    if (next !== NIL) this.prevSibling[next] = prev;
    this.prevSibling[h] = NIL;
    this.nextSibling[h] = NIL;
    this.parent[h] = NIL;

    const slot = this.aggOf[p];
    if (slot !== NIL) {
      this.removeFromAgg(slot, h);
      if (this.aggChildren[slot] > 0) this.aggChildren[slot]--;
      this.refreshRoll(p);
    }
  }

  // ── Internals: O(1) rollups ────────────────────────────────────────────────

  /** Band rank of a severity. Higher is worse; -1 means no signal. */
  private rankOf(v: number): number {
    if (v < 0) return RANK_NONE;
    if (v >= this.bands.crit) return RANK_CRITICAL;
    if (v >= this.bands.warn) return RANK_WARNING;
    return RANK_HEALTHY;
  }

  private bandName(rank: number): HealthStatus {
    if (rank === RANK_CRITICAL) return 'critical';
    if (rank === RANK_WARNING) return 'warning';
    if (rank === RANK_HEALTHY) return 'healthy';
    return 'unknown';
  }

  private ensureAgg(h: number): number {
    const existing = this.aggOf[h];
    if (existing !== NIL) return existing;
    let slot: number;
    if (this.aggFree.length > 0) {
      slot = this.aggFree.pop() as number;
    } else {
      if (this.aggCount === this.aggCapacity) this.growAgg();
      slot = this.aggCount++;
    }
    this.resetAggSlot(slot);
    this.aggOf[h] = slot;
    return slot;
  }

  /** Zero an aggregate slot; slots are recycled, so nothing may survive. */
  private resetAggSlot(slot: number): void {
    this.aggCounts.fill(0, slot * BUCKETS, slot * BUCKETS + BUCKETS);
    this.aggBands.fill(0, slot * BAND_COUNT, slot * BAND_COUNT + BAND_COUNT);
    this.aggMaskLo[slot] = 0;
    this.aggMaskHi[slot] = 0;
    this.aggSum[slot] = 0;
    this.aggSignal[slot] = 0;
    this.aggChildren[slot] = 0;
  }

  private releaseAgg(h: number): void {
    const slot = this.aggOf[h];
    if (slot === NIL) return;
    this.aggOf[h] = NIL;
    this.aggFree.push(slot);
  }

  private growAgg(): void {
    const n = this.aggCapacity * 2;
    this.aggCounts = growU32(this.aggCounts, n * BUCKETS);
    this.aggMaskLo = growU32(this.aggMaskLo, n);
    this.aggMaskHi = growU32(this.aggMaskHi, n);
    this.aggBands = growU32(this.aggBands, n * BAND_COUNT);
    this.aggSum = growF64(this.aggSum, n);
    this.aggSignal = growU32(this.aggSignal, n);
    this.aggChildren = growU32(this.aggChildren, n);
    this.aggCapacity = n;
  }

  /** Highest occupied bucket in a slot, or -1. */
  private worstBucket(slot: number): number {
    const hi = this.aggMaskHi[slot];
    if (hi !== 0) return 32 + (31 - Math.clz32(hi));
    const lo = this.aggMaskLo[slot];
    if (lo !== 0) return 31 - Math.clz32(lo);
    return NIL;
  }

  /** Worst band rank among a slot's children, or -1 when none has a signal. */
  private worstBand(slot: number): number {
    const base = slot * BAND_COUNT;
    if (this.aggBands[base + BAND_CRITICAL] > 0) return RANK_CRITICAL;
    if (this.aggBands[base + BAND_WARNING] > 0) return RANK_WARNING;
    if (this.aggBands[base + BAND_HEALTHY] > 0) return RANK_HEALTHY;
    return RANK_NONE;
  }

  private addToAgg(slot: number, child: number): void {
    const bucket = this.rollBucket[child];
    const rank = this.rollBand[child];
    const bandIdx = rank < 0 ? BAND_UNKNOWN : rank;
    this.slotBucket[child] = bucket;
    this.slotBand[child] = bandIdx;
    this.aggBands[slot * BAND_COUNT + bandIdx]++;
    if (bucket >= 0) {
      const at = slot * BUCKETS + bucket;
      if (this.aggCounts[at]++ === 0) this.setMask(slot, bucket);
      this.aggSum[slot] += bucketValue(bucket);
      this.aggSignal[slot]++;
    }
  }

  private removeFromAgg(slot: number, child: number): void {
    const bandIdx = this.slotBand[child];
    const bucket = this.slotBucket[child];
    if (bandIdx >= 0 && this.aggBands[slot * BAND_COUNT + bandIdx] > 0) {
      this.aggBands[slot * BAND_COUNT + bandIdx]--;
    }
    if (bucket >= 0) {
      const at = slot * BUCKETS + bucket;
      if (this.aggCounts[at] > 0 && --this.aggCounts[at] === 0) this.clearMask(slot, bucket);
      if (this.aggSignal[slot] > 0) {
        this.aggSignal[slot]--;
        this.aggSum[slot] -= bucketValue(bucket);
        if (this.aggSignal[slot] === 0) this.aggSum[slot] = 0;
      }
    }
    this.slotBand[child] = NIL;
    this.slotBucket[child] = NIL;
  }

  private setMask(slot: number, bucket: number): void {
    if (bucket < 32) this.aggMaskLo[slot] |= 1 << bucket;
    else this.aggMaskHi[slot] |= 1 << (bucket - 32);
  }

  private clearMask(slot: number, bucket: number): void {
    if (bucket < 32) this.aggMaskLo[slot] &= ~(1 << bucket);
    else this.aggMaskHi[slot] &= ~(1 << (bucket - 32));
  }

  /**
   * Recompute a node's rolled-up bucket and band, then push the change up the
   * tree. Each level is O(1) thanks to the bucket mask, so a leaf update costs
   * O(depth) no matter how many siblings it has. Propagating indices rather
   * than values keeps the result drift-free across arbitrarily deep estates.
   */
  private refreshRoll(h: number): void {
    let cur = h;
    let guard = 0;
    while (cur !== NIL && guard++ <= this.maxDepth) {
      const own = this.health[cur];
      let bucket = bucketOf(own);
      let rank = this.rankOf(own);
      const slot = this.aggOf[cur];
      if (slot !== NIL) {
        const wb = this.worstBucket(slot);
        if (wb > bucket) bucket = wb;
        const wr = this.worstBand(slot);
        if (wr > rank) rank = wr;
      }
      if (this.rollBucket[cur] === bucket && this.rollBand[cur] === rank) return;

      const p = this.parent[cur];
      const pslot = p !== NIL ? this.aggOf[p] : NIL;
      if (pslot !== NIL) this.removeFromAgg(pslot, cur);
      this.rollBucket[cur] = bucket;
      this.rollBand[cur] = rank;
      if (pslot !== NIL) this.addToAgg(pslot, cur);
      this.markDirty(cur);
      cur = p;
    }
  }
}
