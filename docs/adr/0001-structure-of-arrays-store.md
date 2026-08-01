# 1. Structure-of-Arrays Storage for Workload State

Date: 2026-07

## Status

Accepted

## Context

The workload map must hold hundreds of workloads and tens of thousands of
resources, with design headroom to 1M nodes, and absorb burst updates without
GC pauses in the render loop.

Options considered:

1. **One JS object per node** — Ergonomic, but ~80–150 bytes of heap each plus a
   GC edge. At 1M nodes this exceeds the memory budget and turns every
   collection into a multi-millisecond pause mid-frame.
2. **`Map<string, NodeState>`** — Same object cost, plus hashing on every access
   in the hot path.
3. **Structure-of-Arrays over typed arrays** — Each field is a parallel typed
   array indexed by a dense integer handle.

## Decision

Use Structure-of-Arrays. Callers address nodes by stable string id; the store
resolves an id to an integer **handle** once and all internal state is indexed
by it. `applyHealthBulk` lets streaming callers skip the lookup entirely by
reusing resolved handles across ticks.

## Consequences

- **Positive**: Measured 42.3 MB of columnar state at 1M nodes, and **zero GC
  collections** across 100 streaming ticks.
- **Positive**: Node state is contiguous and pointer-free, so the hot loop is
  bounded by memory bandwidth rather than allocator and GC behaviour.
- **Negative**: Adding a field means touching six sites (declare, construct,
  `alloc`, `free`, `growColumns`, `columnBytes`). Missing one fails silently —
  hence the checklist in the design spec §10.1.
- **Negative**: The id → handle `Map` still dominates memory (61 MB heap vs
  42.3 MB columnar at 1M nodes) and costs 463 ms to resolve 1M ids. Reverse
  lookup is required by tooltips and interaction, so it stays for now.
- **Negative**: No per-node object to hand to a debugger; inspection goes
  through accessor methods.
