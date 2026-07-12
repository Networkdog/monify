import { Camera } from './camera';
import { INV_POW2, TILE_SIZE } from '../constants';
import type { TileCoord } from '../types';

// Reusable tile coordinate pool — grows only, never shrinks.
const _tilePool: TileCoord[] = [];
let _tilePoolUsed = 0;

function _borrowTile(z: number, x: number, y: number): TileCoord {
  if (_tilePoolUsed < _tilePool.length) {
    const t = _tilePool[_tilePoolUsed++];
    t.z = z; t.x = x; t.y = y;
    return t;
  }
  const t = { z, x, y };
  _tilePool.push(t);
  _tilePoolUsed++;
  return t;
}

/** Reset pool for next frame. Call once before all visibleTiles() calls. */
export function resetTilePool(): void { _tilePoolUsed = 0; }

/**
 * Compute the set of visible tiles at integer zoom `z` for the given
 * camera/view. A `margin`-tile border is added around the viewport so that
 * objects whose center is just off-screen (but whose visual extent
 * overflows into the viewport) are still loaded and drawn. The default
 * margin of 1 handles cells up to ~2 tiles wide; layers whose cells span
 * more tiles (e.g. very-deep-zoom composite charts) should pass a larger
 * value so their center tile remains in the visible set.
 */
export function visibleTiles(cam: Camera, viewW: number, viewH: number, z: number, margin = 1): TileCoord[] {
  const tileScale = cam.scaleAt(z);
  const tileWorld = TILE_SIZE / tileScale;
  const viewScale = Math.min(cam.scale, tileScale);
  const halfW = viewW / 2 / viewScale;
  const halfH = viewH / 2 / viewScale;
  const minWX = cam.centerX - halfW;
  const minWY = cam.centerY - halfH;
  const maxWX = cam.centerX + halfW;
  const maxWY = cam.centerY + halfH;
  const minTX = Math.floor(minWX / tileWorld) - margin;
  const minTY = Math.floor(minWY / tileWorld) - margin;
  const maxTX = Math.floor(maxWX / tileWorld) + margin;
  const maxTY = Math.floor(maxWY / tileWorld) + margin;

  const out: TileCoord[] = [];
  for (let ty = minTY; ty <= maxTY; ty++) {
    for (let tx = minTX; tx <= maxTX; tx++) {
      out.push(_borrowTile(z, tx, ty));
    }
  }
  return out;
}

/** World-space AABB covered by a tile at coord (z,x,y). */
export function tileWorldBounds(z: number, x: number, y: number): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} {
  // At zoom z, scale = TILE_SIZE * 2^z, so tileWorldSize = 1 / 2^z
  const size = INV_POW2[z];
  return {
    minX: x * size,
    minY: y * size,
    maxX: (x + 1) * size,
    maxY: (y + 1) * size,
  };
}

/** Pick the two integer zoom levels we render this frame for cross-fade. */
export function zoomLayers(zoom: number, minZ: number, maxZ: number): {
  lower: number;
  upper: number;
  /** Cross-fade fraction in [0,1]: 0 → fully `lower`, 1 → fully `upper`. */
  frac: number;
} {
  const zFloor = Math.max(minZ, Math.min(maxZ - 1, Math.floor(zoom)));
  let frac = Math.max(0, Math.min(1, zoom - zFloor));
  // Snap near-integer zoom to a single layer. The camera spring is
  // asymptotic, so without this we'd perpetually render both the active and
  // the next layer at ~0 / ~1 opacity -- doubling draw cost and producing
  // sub-pixel cross-fade flicker. Widened from 0.005 to 0.02 to land on
  // single-layer draws more often during slow zoom settles.
  const SNAP_EPS = 0.05;
  if (frac < SNAP_EPS) frac = 0;
  else if (frac > 1 - SNAP_EPS) frac = 1;
  return { lower: zFloor, upper: zFloor + 1, frac };
}
