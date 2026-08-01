# 5. The Finer Zoom Layer Shows Metrics, Not a Procedural Fill

Date: 2026-08

## Status

Accepted

## Context

HexGrid's semantic zoom replaced each workload cell with a finer honeycomb
every `LAYER_SPAN` zoom levels. That finer layer was generated procedurally:
`LAYER_SUBDIV = 2^5`, so a cell was subdivided into roughly a thousand
sub-hexes, each coloured by a hash-picked resource plus a deterministic jitter.

It looked like detail, and it was self-similar to any depth, but it was not
data. An Azure managed disk reports four metrics; the layer drew it as ~1000
cells whose colours came from a hash. A viewer counting cells, or reading the
variation between them, was reading noise. The workload map's own rule — do not
invent a layer from data that does not exist — was being broken by the engine
underneath it, which is why the demo had pushed `firstLayerZoom` out to 24 to
keep the layer off screen entirely.

Options considered:

1. **Keep it, label it decorative** — Leaves a monitoring tool showing a
   thousand cells of noise inside a resource that has four numbers.
2. **Drop the finer layer** — Honest, but wastes the zoom range and leaves
   per-metric values reachable only through the tooltip, one at a time.
3. **Bind the layer to the metrics** — Draw exactly as many cells as the
   resource reports metrics.

## Decision

Layer 0 stays one cell per resource. Past `firstLayerZoom`, that cell is
replaced by exactly `resources.length` hexagons on a hex spiral, sized from
`spiralRadiusFor(n)` so the outermost ring fits the area the resource occupies
at layer 0. Each cell carries its own metric's value through the same health
ramp, gets its name written in it once it is large enough, and answers the
tooltip with that metric's name and value.

## Consequences

- Cell count is now meaningful: three metrics show three cells, ten show ten.
  Nothing is padded and nothing is hashed.
- The resource's own hexagon is redrawn under its metrics at `BACKDROP_DIM` of
  its colour, so a metric visibly belongs to a resource and the gaps between
  resources still read. It is emitted only from the tile containing the
  resource's centre: tile elements are drawn in world space and are not clipped
  to their tile, so a second copy from a neighbouring tile would paint over
  metric cells that tile had already drawn.
- The self-similar infinite zoom is gone. There is one finer layer; zooming
  past it enlarges the same cells rather than inventing another level. This is
  the thing given up, and it was only ever showing noise.
- `firstLayerZoom` now means "the zoom at which metrics appear". The demo sets
  it to 8, measured: a resource cell is ~235 px wide there
  (`bench/placement-diag.ts`), so a ten-metric resource still gives ~84 px per
  metric cell.
- Metric colours animate the same way layer 0 does — each `LiveResource` owns a
  persistent `fillRGBA` recoloured in place, so a live value change repaints
  without rebuilding a tile.
- `hashCell`, `inHexCore`, `pointInRings` and the nested-gap machinery they fed
  are deleted; the metric layer needs none of them.
