---
description: "Use when editing the workload map data plane — WorkloadStore, workload-map types, typed-array columns, bucket-mask rollups, health bands, dirty queue, aggregate slots, handle allocation, or the store benchmark and its tests. Covers the invariants that keep 1M-node updates allocation-free and rollups correct."
name: "Workload Map Data Plane"
applyTo: ["src/viz/workload-map/**", "tests/workload-*.test.ts", "bench/**"]
---

# Workload Map — Implementation Rules

Full design spec: [docs/workload-map.md](../../docs/workload-map.md). Read the
relevant section before changing behaviour. The rules below are the ones that
are easy to violate and expensive to debug.

## Storage

Per-node state lives in parallel typed-array columns indexed by an integer
handle. Never introduce a per-node JS object, `Map`, or closure on a path that
scales with node count.

**Adding a column requires all six sites** (§10.1). Missing one fails silently:

1. field declaration → 2. constructor allocation → 3. `alloc()` reset →
4. `free()` clear → 5. `growColumns()` grow *and* fill → 6. `columnBytes`

Skipping `alloc()` leaks state into recycled handles. Skipping `growColumns()`
corrupts data past the initial capacity.

Aggregate slots are allocated lazily, only for nodes that have children. Giving
every node bucket counters costs ~256 MB at 1M nodes.

## Rollups

**Propagate bucket indices and band ranks upward — never severity values.**
Re-quantizing a value at each level inflates severity by 1/64 per hop and can
flip a healthy node to `critical` at depth. `max()` over an index is idempotent;
over a re-quantized value it is not. This was a real bug — see §6.2.

Registration order is fixed and always paired:

```ts
if (pslot !== NIL) this.removeFromAgg(pslot, cur);  // reverses via slotBucket/slotBand
this.rollBucket[cur] = bucket;
this.rollBand[cur] = rank;
if (pslot !== NIL) this.addToAgg(pslot, cur);
```

Reversing it decrements a bucket the child was never counted in, corrupting the
counters permanently.

`slotBucket`/`slotBand` are *what is currently registered in the parent*.
`rollBucket`/`rollBand` are *current truth*. Keep them distinct.

Any new aggregate statistic must be **exactly reversible when a child's value
drops**. If it is not, it needs a count-based representation like the bucket
mask. A running max is not reversible — that is why the mask exists.

## Two rollup paths

`applyHealthBulk` picks between incremental maintenance and a full rebuild based
on `rebuildCrossover`. **The two must stay observationally identical** — same
severity, status, and rollup for every node.

Any change to rollup logic must be applied to both `refreshRoll` (incremental)
and `rebuildAggregates` (batch), and verified by the equivalence property tests
that drive the same input through a `rebuildCrossover: 0` store and a
`rebuildCrossover: 1e-9` store. Without those tests the second path drifts
silently.

The crossover default is measured, not reasoned. Do not adjust it without
re-running the sweep — the first guess was 6× too low and would have made the
common case 2.9× slower.

## Hot paths

`applyBatch`, `applyHealthBulk`, `setHealth`, and `drainDirty` must allocate
nothing per update: no array or object literals, no closures, no string
concatenation. Zero GC collections during streaming is a measured property, not
an aspiration.

Cost must be O(batch × depth), never O(total nodes). `expireStale` is the sole
intentional full scan — it is called on a slow timer, never per frame.

A write that changes nothing marks nothing dirty and bumps no version counter.

`applyHealthBulk` inlines a numeric clamp instead of calling `sanitizeHealth`.
If you change one, change the other — they must stay behaviourally identical.

## Robustness

Malformed input never throws. Bad values become "no signal" (`-1`); bad records
are skipped and reported through `BatchResult.diagnostics`. One bad row must not
discard the rest of the batch. The only exception is the opt-in
`unknownIdPolicy: 'throw'`.

Subtree traversal is iterative with an explicit stack — recursion blows the JS
stack on deep estates. Every parent mutation is cycle-guarded; a cycle makes
upward propagation loop forever.

Every accessor tolerates dead, negative, and out-of-range handles and returns a
neutral result.

## Consuming changes

Always branch on overflow — past `dirtyBudget` the change list is dropped
(state stays correct):

```ts
if (store.dirtyOverflowed) rebuildAll();
else for (const h of store.drainDirty()) { /* h may already be dead */ }
```

`drainDirty()` returns a view into internal memory, valid only until the next
mutation. Handles are stable for a node's lifetime but must never be persisted
across a `remove()` — ids are the durable identity.

## Testing

Rollup changes require **property tests against the naive recursive oracle** in
`tests/workload-store.test.ts`, not just examples. Bucket-mask bugs are nearly
invisible to example-based tests.

Assert both bounds on any severity propagation:

```ts
expect(got).toBeGreaterThanOrEqual(worst - 1e-6);        // never under-reports
expect(got).toBeLessThanOrEqual(worst + 1 / 64 + 1e-6);  // never drifts with depth
```

Keep the hostile-input categories green: `NaN`, `±Infinity`, `null`, objects,
`Symbol`, `BigInt`, numeric strings, duplicate ids, cycles, forward references,
slot reuse, and severity *decrease*.

## Performance changes

Re-run the benchmark and quote real output — never estimate:

```powershell
$env:NODE_OPTIONS="--expose-gc --max-old-space-size=4096"
npx vite-node bench/store-bench.ts 1000000 0.01
```

Regression if p95 rises >10%, GC collections become non-zero, or steady-state
heap grows. Update the baselines in §9 when they legitimately change.

## Render plane

When building the visualization on the vendored engine, these engine constraints
are binding — full table in §3.1 of the spec:

- **Write camera-relative positions**, subtracting `camera.centerX/Y` in float64
  before narrowing to float32. Absolute world coordinates suffer catastrophic
  cancellation past z≈18 and the geometry visibly collapses.
- **Keep the shape vocabulary small** — the renderer batches one draw call per
  shape type, so per-object shape variety costs draw calls.
- **Icons must share an atlas.** The texture cache holds ~8M pixels (~32 MB)
  under LRU eviction; unbounded distinct icon textures thrash it.
- **At most 16 new text textures rasterize per frame.** Labels appear
  progressively — never assume a full label pass completes in one frame.
- **Objects straddling a tile edge need `tileMargin(z)`**, or they get clipped.
- **Both layers draw during a zoom cross-fade.** Content present in both
  double-blends unless `depth` marks its generation.

Do not modify `src/core/**` to work around these — raise it separately.
