# 3. Adaptive Rollup Strategy Selected by Measured Crossover

Date: 2026-07

## Status

Accepted

## Context

Incremental rollup maintenance costs one register/unregister pair per changed
child, scattered across that child's parent counters. It is optimal for small
batches, but a batch touching most of the estate revisits the same parent
thousands of times with no locality. Measured at 1M nodes, a 100% churn tick
cost 359 ms — 21× the frame budget.

Options considered:

1. **Tune the incremental path** — Already done (inlined clamp, dirty budget).
   Yielded 13%; the remaining cost is memory-bound, not instruction-bound.
2. **Always rebuild** — One linear traversal recomputing every aggregate. Fast
   when everything changed, but pays a full-estate traversal for a five-node
   update.
3. **Adaptive** — Pick per batch, based on how much of the estate it touches.

## Decision

Implement both and select per batch. Above `rebuildCrossover`, write severities
without touching aggregates and then recompute all rollups in one bottom-up
traversal ordered by a reversed breadth-first walk from the roots.

Set the default crossover **from measurement**, not from reasoning. At 1M nodes
incremental scales at ~3.5 ms per 1% of the estate while rebuild is a fixed
~100 ms traversal plus ~0.27 ms per 1%; they cross near 31%, so the default is
0.3.

## Consequences

- **Positive**: Saturated batches dropped from 359 ms to 127 ms (2.83×), and
  35% churn from 140 ms to 109 ms.
- **Positive**: The common case is untouched — below the crossover the
  incremental path runs exactly as before.
- **Positive**: `rebuildCrossover: 0` disables the rebuild entirely, which makes
  the two paths directly comparable in tests and benchmarks.
- **Negative**: Two code paths must stay observationally identical forever. This
  is guarded by property tests that drive the same input through both and
  compare every node's severity, status, and rollup — without them the second
  path would silently drift.
- **Negative**: The crossover is hardware- and shape-dependent. The first guess
  (0.05) would have made 10% churn **2.9× slower**; anyone re-tuning it must
  re-run the sweep rather than reason about it.
- **Negative**: One scratch `Uint32Array` sized to capacity (4 MB at 1M nodes),
  allocated lazily only if the rebuild path is ever taken.
