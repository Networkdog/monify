# 4. Affinity Seeding Spaces Primary Clusters by Size, Not by Index

Date: 2026-07

## Status

Accepted

## Context

`placeAffinity` seeds each primary cluster (the coarsest grouping attribute —
in the workload map, the management group) onto a sunflower disc, then relaxes
the territories under attraction to their seed and mutual repulsion.

The seed radius was `r0 * fill * 0.68 * sqrt((pi + 0.5) / pv.length)`, where
`pi` is the cluster's position in map insertion order. A sunflower spaced this
way is uniform only when every cluster holds roughly the same number of cells.

Real estates are not like that. A Cloud Adoption Framework hierarchy puts one
subscription each under Identity, Management, Connectivity and Security, and
tens under Corp and Online. Modelling that faithfully in the demo gave the
primary clusters a 300:1 size spread, and the consequence was visible
immediately: the four two-resource platform clusters were handed the inner half
of the disc, the four large landing-zone clusters were seeded near the rim, and
repulsion pushed them further out. The estate rendered as a hollow ring with an
empty middle roughly 40% of its radius.

Options considered:

1. **Leave it and shrink the size spread in the demo** — Hides the defect by
   making the data less true. The hierarchy is the thing being visualized.
2. **Weight the relaxation instead** — Let large clusters resist repulsion in
   proportion to their size. Adds a tuning constant to a loop that already has
   several, and it corrects the symptom after seeding it wrong.
3. **Space the seeds by cumulative size** — Give each cluster the annulus its
   own area earns, so seed density follows cell density by construction.

## Decision

Order the primary clusters largest first and place seed `k` at
`r0 * fill * 0.68 * sqrt((cum_k + size_k / 2) / total)`, where `cum_k` is the
total size of the clusters before it. Equal area per cell, so no cluster can
claim a ring disproportionate to what it holds, and the largest cluster — whose
own radius is the largest — is the one that covers the centre.

## Consequences

- The middle of the layout is occupied by the biggest primary cluster rather
  than evacuated. Verified on the workload map demo: 8 management groups, 41
  subscriptions, 500 resource groups, 21,034 cells, at 60 fps.
- Insertion order no longer influences centrality. Any domain meaning that was
  implicitly riding on it — "connectivity is listed first, so it sits near the
  middle" — is gone, and must be expressed through `HierItem.central`, which is
  what that field is for.
- Within a cluster, ordering is unchanged: `makeSeedOrder` still ranks by
  shared-ness and keeps a workload's territories adjacent.
- The three `placement-uniformity` tests continue to pass, including the one
  asserting the hub centre is not packed denser than the rest.
