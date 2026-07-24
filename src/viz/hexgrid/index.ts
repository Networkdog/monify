// HexGrid module barrel.
export {
  HexGrid,
  type HexGridOptions,
  type WorkloadInput,
  type HexResourceInput,
  type WorkloadSummary,
} from './hexgrid-viz';
export {
  axialToPixel,
  pixelToAxial,
  hexRound,
  hexNeighbors,
  hexDistance,
  hexRing,
  hexSpiral,
  spiralCount,
  spiralRadiusFor,
  hexPolygon,
  axialKey,
  type Axial,
} from './hex';
export {
  HexPlacer,
  placeHierarchical,
  hashString,
  type PlacedWorkload,
  type GroupedItem,
  type HierItem,
} from './placement';
