// monify — public library barrel.
//
// monify is a collection of scenario-specialized data visualizations built on a
// vendored WebGL2 semantic-zoom engine (src/core, originally from singlescene).
// Each visualization is a self-contained tool with a consistent concept: mouse
// + keyboard interaction, smooth zoom that reveals detail or aggregates, and
// position / color / shape / height (Z) all carrying meaning.

// ── Engine (vendored WebGL2 semantic-zoom core) ──────────────────────────────
export { Scene, type SceneOptions } from './core/scene';
export {
  Camera,
  type CameraOptions,
  InputController,
  type UserInteractReason,
  GuidedTour,
  type GuidedTourStop,
  type GuidedTourOptions,
  type GuidedTourConfig,
  visibleTiles,
  tileWorldBounds,
  zoomLayers,
  resetTilePool,
} from './core/camera';
export {
  TileCache,
  type TileEntry,
  type TileStatus,
  TileLoader,
  type TileLoaderOptions,
  TilePrefetcher,
  WsTileSource,
  type WsTileSourceOptions,
  flattenTile,
  type BaseElement,
  type ShapeElement,
  type TextElement,
  type ImageElement,
  type VectorElement,
  type GroupElement,
  type TileElement,
  type FlatElement,
  type FlatTile,
  type TileJSON,
} from './core/tile';
export {
  LiveStore,
  type ObjectOverride,
  type EphemeralObject,
  type MutationOp,
  type MutationMessage,
  MutationBus,
  type LayerMeta,
  WsFeed,
  type WsFeedOptions,
} from './core/live';
export { tileKey, tileKeyNum, type TileCoord, type AABB, type RGBA } from './core/types';
export {
  TILE_SIZE,
  TILE_LOADER_CONCURRENCY,
  TILE_CACHE_CAPACITY,
  FIXED_STEP,
  MAX_STEPS_PER_FRAME,
} from './core/constants';

// ── Color palettes & scales ──────────────────────────────────────────────────
export * from './color';

// ── Visualizations ───────────────────────────────────────────────────────────
export * from './viz';
