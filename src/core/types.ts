// Shared engine types.

/** Tile coordinate `(z, x, y)` — z is the zoom layer, x/y are integer tile indices. */
export interface TileCoord {
  z: number;
  x: number;
  y: number;
}

export function tileKey(z: number, x: number, y: number): string {
  // Small integer z values produce short strings; template literals with
  // small numbers are well-optimized in V8 (interned keys for z < 10).
  return `${z}/${x}/${y}`;
}

/**
 * Numeric tile key packing z (5 bits), x and y (24 bits each, offset by
 * 0x800000 for negatives) into a single safe integer.  Used where Map
 * lookups benefit from numeric keys over string allocation.
 */
export function tileKeyNum(z: number, x: number, y: number): number {
  return ((z & 0x1F) * 0x1000000 + ((x + 0x800000) & 0xFFFFFF)) * 0x1000000 + ((y + 0x800000) & 0xFFFFFF);
}

/** Axis-aligned 2D bounding box in world space. */
export interface AABB {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** RGBA color, each component in [0,1]. */
export type RGBA = [number, number, number, number];
