# Workload Map — Design Specification

Authoritative design document for the workload health map. Code in
`src/viz/workload-map/**` is written **from this document**; when code and this
document disagree, one of them is a bug — fix both deliberately, never silently.

- [1. Scope and status](#1-scope-and-status)
- [2. Problem constraints](#2-problem-constraints)
- [3. Architecture](#3-architecture)
- [4. Data model](#4-data-model)
- [5. Storage layout](#5-storage-layout)
- [6. Algorithms](#6-algorithms)
- [7. Invariants](#7-invariants)
- [8. Public API](#8-public-api)
- [9. Performance contract](#9-performance-contract)
- [10. Extension guide](#10-extension-guide)
- [11. Testing requirements](#11-testing-requirements)
- [12. Roadmap and known bottlenecks](#12-roadmap-and-known-bottlenecks)

---

## 1. Scope and status

The workload map renders the health of a cloud estate: hundreds of workloads
composed of tens of thousands of resources, each individually addressable and
updatable in real time.

| Layer | Module | Status |
|---|---|---|
| Data plane (state, rollups, dirty tracking) | `src/viz/workload-map/store.ts` | **Built** |
| Domain types | `src/viz/workload-map/types.ts` | **Built** |
| Benchmark harness | `bench/store-bench.ts` | **Built** |
| Affinity layout solver (Web Worker) | `layout/` | Planned |
| Semantic LOD policy | `lod.ts` | Planned |
| Renderer binding (`WorkloadMap extends VizBase`) | `workload-map.ts` | Planned |
| Camera `fitIds` / `focus` | `src/viz/viz-base.ts` | Planned |
| Icon atlas | `src/core/gl/icon-atlas.ts` | Planned |

Everything marked *Planned* must follow the invariants in [§7](#7-invariants).

## 2. Problem constraints

These drive every decision below. Do not optimize against a constraint that is
not on this list without updating this document.

1. **Scale**: 500+ workloads, 50k+ resources; design headroom to 1M nodes.
2. **Identity**: every object carries a caller-supplied stable string id. All
   interaction, updates, and camera targeting are expressed in those ids.
3. **Burst updates**: up to ~10k state changes may arrive in a single batch, and
   must not cost O(total nodes).
4. **Hostile input**: telemetry payloads contain `null`, `NaN`, `Infinity`,
   numeric strings, missing parents, duplicate ids, and out-of-order records.
   Malformed input must never throw and never corrupt state.
5. **Frame budget**: the CPU data plane must leave the bulk of a 16.7 ms frame
   to layout and rendering.
6. **No GC pauses**: steady-state streaming must not allocate.

## 3. Architecture

Three planes, deliberately separated because they change at different rates:

```
 telemetry ──▶ Data plane ──▶ Layout plane ──▶ Render plane
              (this doc)      (Web Worker)     (VizBase/WebGL2)
              state+rollups   positions        tiles+instances
              O(batch)        O(topology)      O(visible)
```

- **State changes** (a severity moved) are frequent and cheap. They never
  trigger layout.
- **Topology changes** (nodes added/removed/reparented) are rare and expensive.
  Only these bump `topologyVersion` and request a re-layout.

The store tracks the two independently:

| Counter | Bumped by | Consumer reaction |
|---|---|---|
| `stateVersion` | any severity change | repaint |
| `topologyVersion` | create, remove, reparent | recompute layout |

`src/core/**` is a vendored WebGL2 semantic-zoom engine. Treat it as a
third-party dependency: the workload map builds *on* it, not *into* it.

### 3.1 Engine contract

The vendored engine originates from the **singlescene** project
(`D:\Workspace\singlescene`, see its `docs/adr/`). monify's copy has since
diverged — it adds `extruded` elements and `hexagon` / flat-hex shapes — so
treat upstream documents as *lineage and rationale*, and this repository's
`src/core/**` as the actual truth.

These constraints are **binding on the planned render plane**. Each one is
cheap to violate and expensive to diagnose.

| Constraint | Value | What breaks if ignored |
|---|---|---|
| Camera-relative coordinates | positions written as `x - camera.centerX` in float64, narrowed to float32 (`scene.ts:305, 462`) | Catastrophic cancellation past z≈18 — geometry visibly jitters and collapses at deep zoom |
| Instanced batching | one draw call per shape type | Per-shape draw calls destroy the frame budget; keep the shape vocabulary small |
| Texture pixel budget | 8M pixels (~32 MB at RGBA8), LRU | Unbounded distinct icons thrash the cache and stall on upload |
| Text rasterization | Canvas2D → GPU texture, **max 16 new text textures per frame** | Labels appear progressively over several frames; never assume all labels render in one |
| Tile cache | LRU, 2,048 entries, generation-counter staleness | Estates spanning more tiles than capacity thrash |
| Tile loader | 6 concurrent loads | — |
| Tile size | `TILE_SIZE = 256` world units at z=0 | — |
| Tile boundary bleed | conservative margin via `tileMargin(z)` | Cells straddling a tile edge get clipped |
| Zoom cross-fade | two FBOs, premultiplied alpha, active while `0 < frac < 1` | Objects present in both layers double-blend and flicker |
| View matrix | 3×3 column-major, scale only, no translation term | — |

Upstream decisions worth inheriting rather than re-litigating:

- **Instanced WebGL2 over Canvas2D/SVG** — upstream reports 10,000+ shapes per
  frame at 60 fps. (Their figure, not measured here; the workload map's own LOD
  instance cap must be measured independently.)
- **Tile pyramid with LRU** — O(visible tiles) per frame, independent of total
  content. This is why the store's cost model is O(batch), not O(nodes).
- **`LiveStore` object ids are stringly-typed** (`"layerIdx:ix:iy"`), which
  upstream lists as a known negative. That is precisely why the workload map
  uses its own id → handle index instead of reusing `LiveStore` for node
  state. Do not "unify" the two.

## 4. Data model

A node is a workload, a resource, or any grouping level above them. The store is
deliberately agnostic about which — hierarchy is expressed purely by `parent`.

```ts
interface NodeInput {
  id: string;            // stable, caller-supplied, globally unique
  kind?: string;         // free-form category, interned to a Uint16
  parent?: string;       // another node's id; omit for a root
  health?: number;       // severity 0..1 — 0 healthy, 1 critical
  ts?: number;           // source timestamp (epoch ms), for staleness
}
```

### Severity, not "health score"

`health` is **severity**: `0` is good, `1` is critical. It reads backwards from
the field name for historical reasons but matches the existing `HexGrid`
`criticality` convention, so both visualizations share palettes and thresholds.

`-1` is the internal sentinel for **no signal** and is never a valid input; any
unusable input collapses to it and surfaces as `'unknown'`.

### Health bands

```ts
DEFAULT_BANDS = { warn: 0.4, crit: 0.75 };
```

| Band | Condition | Rank |
|---|---|---|
| `healthy` | `0 <= v < warn` | 0 |
| `warning` | `warn <= v < crit` | 1 |
| `critical` | `v >= crit` | 2 |
| `unknown` | no signal | −1 |

Ranks are ordered by severity so `max()` composes them. `unknown` is rank −1 —
it is *absence of information*, not a severity, so it never outranks a real
signal.

### Placeholders

A record naming an unknown `parent` creates that parent as a **placeholder**
(`FLAG_PLACEHOLDER`). Streaming sources routinely deliver children before
parents; dropping those records would silently lose data. A later record for the
same id clears the flag and fills in its fields.

## 5. Storage layout

### Why Structure-of-Arrays

One JS object per node costs ~80–150 bytes of heap plus a GC edge. At 1M nodes
that both blows the memory budget and turns every collection into a multi-ms
pause. Instead each field is a parallel typed array indexed by a dense integer
**handle**, so state is contiguous, pointer-free, and invisible to the GC.

Measured: **zero GC collections** across 100 streaming ticks (see
[§9](#9-performance-contract)).

### Per-node columns

| Column | Type | Bytes | Meaning |
|---|---|---|---|
| `health` | `Float32Array` | 4 | own severity, −1 = no signal |
| `rollBucket` | `Int8Array` | 1 | worst bucket over own+subtree |
| `rollBand` | `Int8Array` | 1 | worst band rank over own+subtree |
| `kindId` | `Uint16Array` | 2 | interned `kind` |
| `parent` | `Int32Array` | 4 | parent handle, −1 = root |
| `firstChild` / `nextSibling` / `prevSibling` | `Int32Array` | 12 | intrusive child list |
| `flags` | `Uint8Array` | 1 | `ALIVE`, `PLACEHOLDER` |
| `slotBucket` / `slotBand` | `Int8Array` | 2 | what is *currently registered* in the parent |
| `aggOf` | `Int32Array` | 4 | aggregate slot, −1 for leaves |
| `lastSeen` | `Float64Array` | 8 | staleness clock |

`prevSibling` exists solely so unlinking a node is O(1); without it, detaching
during churn degrades to a sibling scan.

`slotBucket`/`slotBand` are **registration state**, distinct from
`rollBucket`/`rollBand` which are current truth. Keeping them separate is what
makes a parent's counters exactly reversible — see [§6](#6-algorithms).

### Aggregate pool

Only nodes that actually have children get an aggregate slot, allocated lazily.
This is not a micro-optimization: 64 bucket counters per node would cost
**~256 MB at 1M nodes**, whereas ~1k real parents cost well under a megabyte.

| Field | Type | Purpose |
|---|---|---|
| `aggCounts` | `Uint32Array[64]` | children per severity bucket |
| `aggMaskLo` / `aggMaskHi` | `Uint32Array` | occupancy bitmask over the 64 buckets |
| `aggBands` | `Uint32Array[4]` | exact per-band child counts |
| `aggSum` / `aggSignal` | `Float64Array` / `Uint32Array` | mean over children with signal |
| `aggChildren` | `Uint32Array` | direct child count |

Both nodes and aggregate slots use free lists so churn does not grow memory.

## 6. Algorithms

### 6.1 Bucketed rollup with a bitmask

**Problem**: a parent must report the worst severity among its children, and
severities go *down* as often as up. A running max cannot handle a decrease
without rescanning every child.

**Solution**: quantize severity into 64 buckets and keep a count per bucket plus
a 64-bit occupancy mask split across two `Uint32`s. The worst occupied bucket is
then one `Math.clz32` away:

```ts
if (maskHi !== 0) return 32 + (31 - Math.clz32(maskHi));
if (maskLo !== 0) return 31 - Math.clz32(maskLo);
return -1;
```

A child moving between buckets is: decrement old count (clear mask bit if it hit
zero), increment new count (set bit). **O(1) regardless of sibling count**, and
symmetric under increase and decrease.

64 buckets is the deliberate midpoint: it fits two `Uint32` masks, and bounds
display error at 1/64 ≈ 0.016 severity — invisible in a color ramp.

### 6.2 Propagate indices, never values

> This is the single easiest thing to get wrong. It was a real bug, caught by
> the multi-level test.

`bucketValue(b)` returns the bucket's **upper** bound, so a rollup never
under-reports severity. But feeding that value back into `bucketOf()` at the
next level lands in the *next* bucket up — severity inflates by 1/64 per hop. At
depth 8 a `0.5` leaf reported `0.625`, and a `0.7461` leaf could surface as
`critical` on its parent despite being below the `0.75` threshold.

**Rule**: what propagates upward is the bucket **index** and the band **rank**,
never a severity value. `max()` over an index is idempotent, so:

- display error stays bounded at 1/64 **at any depth**;
- the band is **exact at every depth**, because ranks are exact and
  `rankOf(max(v)) === max(rankOf(v))` for values with signal.

`severityOf()` recombines the node's own exact value with the quantized subtree
worst at read time, so **leaves always report their exact severity**.

### 6.3 Upward propagation

`refreshRoll(h)` walks from `h` toward the root. At each level it recomputes the
node's `(bucket, rank)` from its own health plus its aggregate, and **returns
early the moment nothing changed** — which is the common case, since one child
of many rarely moves the parent's worst. Cost is O(depth) with an O(1) step, not
O(children).

Re-registration is strictly ordered — remove under the old key, mutate, re-add
under the new key:

```ts
if (pslot !== NIL) this.removeFromAgg(pslot, cur);   // uses slotBucket/slotBand
this.rollBucket[cur] = bucket;
this.rollBand[cur] = rank;
if (pslot !== NIL) this.addToAgg(pslot, cur);        // writes slotBucket/slotBand
```

Reversing this order corrupts the counters permanently: the removal would use
the *new* key and decrement a bucket the child was never counted in.

### 6.4 Dirty queue with a budget

Changed handles are published through a queue with a `Uint8Array` dedupe mark —
repeated updates to one node cost one entry.

Past `dirtyBudget` (default 65,536) the queue **gives up**: it clears itself and
raises `dirtyOverflowed`. Beyond that many changes, a consumer's full pass is
cheaper than the bookkeeping. Measured effect at 100% churn: drain went
**3.897 ms → 0.007 ms**.

Consumers must therefore always branch:

```ts
if (store.dirtyOverflowed) redrawEverything();
else for (const h of store.drainDirty()) redraw(h);
```

State correctness is unaffected by overflow — only the change *list* is dropped.

### 6.5 Input sanitization

Every untrusted scalar passes through `sanitizeHealth()`, which maps
`null`/`undefined`/`NaN`/`±Infinity`/objects/booleans to no-signal, clamps
finite numbers into `[0, 1]`, and parses numeric strings. Malformed *records*
are skipped individually and reported via `BatchResult.diagnostics` — one bad
row must never discard the other 9,999.

`applyHealthBulk` inlines an equivalent numeric clamp rather than calling
`sanitizeHealth`, because values arrive from a typed array where the general
type dispatch is pure overhead. **The two must stay behaviourally identical.**

### 6.6 Structural safety

- **Cycles**: any reparent walks ancestors first and rejects the edge if it
  would close a loop or exceed `maxDepth`. Self-parenting is rejected too. A
  cycle would hang `refreshRoll` forever.
- **Cascade removal**: `remove()` collects the subtree with an explicit stack.
  Recursion would blow the JS stack on deep or wide estates (tested to 2,000
  deep).
- **Slot reuse**: `alloc()` resets *every* column; `free()` drops the id string
  so a dead slot cannot pin memory. A recycled handle must be indistinguishable
  from a fresh one.

### 6.7 Adaptive rebuild

Incremental maintenance is optimal for small batches but degrades when a batch
touches much of the estate: every child costs a register/unregister pair
scattered across its parent's counters, and the same parent is revisited
thousands of times.

Above `rebuildCrossover`, `applyHealthBulk` switches strategy: it writes every
severity **without touching a single aggregate**, then recomputes all rollups in
one traversal. Each parent's counters are then visited once, with locality,
instead of being scattered into repeatedly.

The traversal collects a breadth-first order from the roots, reusing one scratch
array as both queue and output — appending children while walking it yields a
top-down order, which read backwards is exactly the bottom-up order needed for
children to be final before their parents. The scratch array is allocated only
if the rebuild path is actually used.

**The two paths must remain observationally identical.** That equivalence is
asserted directly by property tests that drive the same input through both and
compare every node's severity, status, and rollup.

The crossover is measured, not assumed — see [§9](#9-performance-contract).
Rebuild cost is dominated by a fixed full traversal, so setting the crossover
too low is actively harmful: at 10% churn the rebuild path is **2.9× slower**
than incremental.

## 7. Invariants

Violating any of these is a defect regardless of whether tests pass.

**Storage**
1. Per-node state lives in typed-array columns. No per-node JS object, `Map`, or
   closure on any path that scales with node count.
2. Adding a column means updating all six sites in
   [§10.1](#101-adding-a-per-node-column). Missing `alloc()` leaks state into
   recycled handles; missing `growColumns()` corrupts silently past capacity.
3. Aggregate slots are allocated only for nodes with children.

**Rollups**
4. Propagate bucket indices and band ranks upward — never severity values.
5. `removeFromAgg` → mutate → `addToAgg`, in that order, always paired.
6. `slotBucket`/`slotBand` describe what is registered in the parent right now,
   and are the only keys used to reverse a registration.
7. Health bands are exact at every depth; only the *display* value is quantized,
   and only upward.

**Hot paths**
8. `applyBatch`, `applyHealthBulk`, `setHealth`, and `drainDirty` allocate
   nothing per update. No array literals, object literals, closures, or string
   concatenation.
9. Cost is O(batch × depth), never O(total nodes).
10. A write that changes nothing marks nothing dirty and bumps no version.

**Robustness**
11. Malformed input never throws. Errors surface as diagnostics or return
    values. `unknownIdPolicy: 'throw'` is the sole opt-in exception.
12. Subtree traversals are iterative.
13. Every parent mutation is cycle-guarded.
14. Dead, negative, and out-of-range handles are tolerated by every accessor and
    return a neutral result.

**API**
15. Handles are stable for a node's lifetime and must never be persisted across
    a `remove()` — ids are the durable identity, handles are the fast one.
16. `drainDirty()` returns a view into internal memory, valid only until the
    next mutation.

## 8. Public API

Exported from `src/viz/workload-map/index.ts`, re-exported through
`src/viz/index.ts` and the package barrel.

### Construction

```ts
new WorkloadStore({
  capacity?: number,              // pre-allocation, grows automatically (default 1024)
  bands?: HealthBands,            // default { warn: 0.4, crit: 0.75 }
  unknownIdPolicy?: 'ignore' | 'warn' | 'throw',  // default 'ignore'
  maxDepth?: number,              // cycle/΄depth guard (default 64)
  dirtyBudget?: number,           // default 65_536
  rebuildCrossover?: number,      // default 0.3; 0 disables the rebuild path
  collectDiagnostics?: boolean,   // default true
});
```

Set `capacity` to the expected node count for large estates — growth doubles and
copies every column.

### Ingest

| Method | Cost | Use |
|---|---|---|
| `applyBatch(records): BatchResult` | O(n × depth) | topology + state from JSON |
| `upsert(node): BatchResult` | O(depth) | single record |
| `setHealth(id, value, ts?): boolean` | O(depth) | one severity by id |
| `applyHealthBulk(handles, values, count?, ts?): number` | O(n × depth) | **streaming fast path** |
| `remove(id): number` | O(subtree) | delete node + descendants |
| `expireStale(maxAgeMs, now?): number` | O(nodes) | drop signals that stopped arriving |

`applyHealthBulk` is the only zero-lookup path: resolve ids to handles **once**,
then stream `Int32Array`/`Float32Array` every tick. This is how a 50 ms tick
stays free of both object churn and hash lookups.

`expireStale` is the one deliberate O(nodes) scan. Call it on a slow timer
(seconds), never per frame.

### Query

```ts
store.has(id);            store.handleOf(id);      // -1 when absent
store.idOf(h);            store.kindOf(h);
store.healthOf(h);        // own severity, exact, -1 = no signal
store.severityOf(h);      // own vs subtree worst; exact for leaves
store.statusOf(h);        // 'healthy' | 'warning' | 'critical' | 'unknown' — exact
store.parentOf(h);        store.childrenOf(h);     // allocates
store.forEachChild(h, fn);                         // allocation-free; safe to remove during
store.rollupOf(h);        // { worst, mean, healthy, warning, critical, unknown, children }
```

`rollupOf` counts **direct children**; `worst` reflects the whole subtree,
because each child's roll already includes its own descendants.

### Change tracking

```ts
store.stateVersion;      store.topologyVersion;
store.dirtySize;         store.dirtyOverflowed;
store.drainDirty();      store.clearDirty();
```

## 9. Performance contract

Measured on Node v22.12.0 / win32 via `bench/store-bench.ts`, with
1,000,000 resources under 1,000 workloads under 20 clusters.

### Baselines

| Metric | Measured |
|---|---|
| Cold ingest (1M records) | 1,870 ms (535k nodes/s) |
| Columnar state | **42.3 MB** |
| Heap delta after ingest | 61.0 MB |
| RSS | 232.4 MB |
| Resolve 1M ids → handles | 463 ms (one-off) |
| **GC collections while streaming** | **0** |
| Steady-state heap growth | none |
| Update throughput ceiling | ~2.3–2.55M updates/s |

### Per-tick latency

Realistic churn, using the default strategy:

| Churn | apply p50 | total p95 | Verdict |
|---|---|---|---|
| 10k updates (1% of 1M) | 3.83 ms | **5.93 ms** | fits 16.7 ms budget |

### Rollup strategy crossover

`apply` p50 at 1M nodes, forcing each strategy:

| Churn | Incremental | Rebuild | Faster |
|---|---:|---:|---|
| 10% | 36.08 ms | 103.29 ms | incremental, 2.9× |
| 20% | 68.40 ms | 117.04 ms | incremental, 1.7× |
| 25% | 92.70 ms | 108.33 ms | incremental, 1.2× |
| 35% | 140.21 ms | 109.20 ms | rebuild, 1.28× |
| 100% | 359.34 ms | 126.78 ms | rebuild, 2.83× |

Incremental scales at roughly 3.5 ms per 1% of the estate; rebuild is a fixed
~100 ms traversal plus ~0.27 ms per 1%. They cross near **31%**, which is where
`rebuildCrossover` defaults to 0.3.

The first guess for this default was 0.05. Measurement showed that value would
have made the common case **2.9× slower** — the crossover must be re-measured on
target hardware and for a materially different estate shape (depth, fan-out).

**Honest limit**: ~39k updates per 16.7 ms frame. Updating 1M nodes every 50 ms
(20M updates/s) is *not* achievable single-threaded even with the rebuild; the
bottleneck is memory-bound access, confirmed by the zero-GC result. Closing it
requires moving ingest off the main thread — see
[§12](#12-roadmap-and-known-bottlenecks).

### Regression policy

Re-run the benchmark after any change to `store.ts` hot paths:

```powershell
$env:NODE_OPTIONS="--expose-gc --max-old-space-size=4096"
npx vite-node bench/store-bench.ts 1000000 0.01
```

A change is a regression if p95 rises >10%, GC collections become non-zero, or
steady-state heap grows. Record new numbers in this section.

> These figures are hardware-specific. Re-measure on the target machine before
> treating them as absolutes.

## 10. Extension guide

### 10.1 Adding a per-node column

All six sites, or the column is broken:

1. **Declare** the field next to the other columns.
2. **Constructor** — allocate at `cap`, `.fill()` if the zero value is wrong.
3. **`alloc()`** — reset to the neutral value, so recycled handles stay clean.
4. **`free()`** — clear it if it holds a reference or must not leak.
5. **`growColumns()`** — grow *and* `.fill()` the newly added region.
6. **`columnBytes`** — add the per-node byte count.

### 10.2 Adding an aggregate statistic

1. Add the array to the aggregate pool and to `growAgg()`.
2. Zero it in `ensureAgg()` (slots are recycled).
3. Update **both** `addToAgg` and `removeFromAgg` symmetrically. If the
   statistic is not exactly reversible from `slotBucket`/`slotBand`, it needs a
   count-based representation like the bucket mask — see [§6.1](#61-bucketed-rollup-with-a-bitmask).
4. Expose it through `rollupOf`.

Ask: *can this be reversed when a child's value drops?* If not, redesign it.

### 10.3 Adding a hot-path field to `NodeInput`

Parse it in `writeRecord`, guard the type, mark dirty only on real change, and
add a diagnostic for malformed values. Never `throw`.

### 10.4 Consuming the store from a renderer

```ts
if (store.dirtyOverflowed) {
  rebuildAllInstances();
} else {
  for (const h of store.drainDirty()) {
    if (store.idOf(h) === undefined) continue;  // died after being queued
    updateInstance(h);
  }
}
```

Never retain the `drainDirty()` view across a mutation, and never assume a
queued handle is still alive.

## 11. Testing requirements

Tests live in `tests/workload-store.test.ts` and run under Vitest (node env).

Every change to the store must keep these categories green:

| Category | Requirement |
|---|---|
| Hostile scalars | `null`, `NaN`, `±Infinity`, objects, booleans, `Symbol`, `BigInt`, numeric strings |
| Malformed records | non-objects, missing/empty/non-string ids, non-string parents |
| Identity | handle stability, duplicate ids, last-write-wins within a batch |
| Hierarchy | forward references, self-parent, 2-node and deep cycles, reparenting |
| Rollups | worst child, **severity decrease**, multi-level non-inflation, band-boundary rounding |
| Removal | cascade, parent counters, unknown ids, slot reuse, 2,000-deep chains |
| Dirty tracking | dedupe, ancestor marking, no-op writes, budget overflow |
| Bulk path | dead/negative/out-of-range handles, mismatched array lengths |

**Property tests are mandatory for rollup changes.** Rollup correctness is
verified against a naive recursive oracle over randomly generated trees
(`fc.assert`, ~200 runs each). A bucket-mask bug is easy to write and nearly
invisible to example-based tests — the oracle is what catches it.

New severity-propagation logic must assert both bounds:

```ts
expect(got).toBeGreaterThanOrEqual(worst - 1e-6);        // never under-reports
expect(got).toBeLessThanOrEqual(worst + 1 / 64 + 1e-6);  // never drifts with depth
```

## 12. Roadmap and known bottlenecks

Ordered by value. Items 1–3 are measured, not speculative.

1. **Saturated batches cost 127 ms at 1M nodes** even with the adaptive rebuild
   (down from 359 ms). The remaining cost is the full traversal plus the
   severity writes themselves, both memory-bound. *Strategy*: move ingest to a
   Web Worker over `SharedArrayBuffer` so the main thread never pays it. This is
   now the only remaining path to the saturated-update target — single-threaded
   tuning is exhausted.
2. **p99 = 22.92 ms at 1% churn** — a single outlier tick, suspected JIT warmup.
   Needs a per-tick trace to confirm before optimizing.
3. **The id `Map<string, number>` dominates memory** — 61 MB heap vs 42.3 MB
   columnar, and 463 ms to resolve 1M ids. *Options*: a packed string arena with
   offsets, or dropping reverse lookup when the host app owns the strings.
   Reverse lookup is currently required by tooltips and interaction.
4. **Worker offload** with `SharedArrayBuffer`, so ingest never touches the main
   thread.
5. **Layout, LOD, renderer, camera** — see [§1](#1-scope-and-status). Nothing has
   been rendered yet, so "1M nodes at 60 FPS" remains unverified end to end; the
   LOD instance budget is the next real unknown.
