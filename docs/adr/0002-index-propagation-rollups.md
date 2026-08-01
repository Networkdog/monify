# 2. Bucketed Rollups Propagating Indices, Not Values

Date: 2026-07

## Status

Accepted

## Context

A workload must report the worst severity among its resources. Severities go
*down* as often as up — incidents get resolved — and a parent may have thousands
of children.

Options considered for "worst child":

1. **Running max** — O(1) on increase, but a *decrease* cannot be handled
   without rescanning every child. A resolved incident would leave the parent
   red forever.
2. **Rescan children on change** — Correct but O(children) per update.
3. **Sorted structure (heap / balanced tree)** — O(log n), and allocates.
4. **Bucketed counters with an occupancy bitmask** — O(1) in both directions,
   allocation-free.

A second question is what to propagate upward once a parent's worst changes.

## Decision

Quantize severity into 64 buckets. Each parent keeps a count per bucket plus a
64-bit occupancy mask split across two `Uint32`s; the worst occupied bucket is
`Math.clz32` on the mask. Band counts are kept separately and exactly.

Propagate the bucket **index** and band **rank** upward — never a severity
value. `bucketValue()` returns a bucket's upper bound, so re-quantizing it at
each level inflates severity by 1/64 per hop; at depth 8 a `0.5` leaf reported
`0.625`, and a `0.7461` leaf could surface as `critical` on its parent despite
being under the `0.75` threshold. `max()` over an index is idempotent.

## Consequences

- **Positive**: Worst-child is O(1) on both increase and decrease, regardless of
  sibling count. A leaf update costs O(depth), not O(children).
- **Positive**: Display error is bounded at 1/64 ≈ 0.016 severity **at any
  depth**, and health bands are **exact at every depth**.
- **Positive**: Leaves still report their exact severity, because `severityOf()`
  recombines the node's own value with the quantized subtree worst at read time.
- **Negative**: The rolled-up *display* value is quantized, always upward. A
  rollup never under-reports severity, but may overstate it by up to one bucket.
- **Negative**: Every aggregate statistic must be exactly reversible from the
  registered `slotBucket` / `slotBand`. Any new statistic that cannot be undone
  when a child's value drops needs a count-based representation.
- **Negative**: The registration order (`removeFromAgg` → mutate → `addToAgg`)
  is load-bearing and easy to get wrong; reversing it corrupts counters
  permanently. Property tests against a naive oracle guard this.
