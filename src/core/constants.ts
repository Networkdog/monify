/** Engine-wide constants. */

export const TILE_SIZE = 256;

/** Max concurrent tile fetches in flight. */
export const TILE_LOADER_CONCURRENCY = 6;

/** LRU tile cache capacity (items). */
export const TILE_CACHE_CAPACITY = 2048;

/** Fixed simulation step (s) for the input/camera integrator. */
export const FIXED_STEP = 1 / 120;

/** Max simulation steps allowed per RAF tick (prevents spiral-of-death). */
export const MAX_STEPS_PER_FRAME = 6;

/** Precomputed 2^z for integer z ∈ [0..40]. Avoids Math.pow on hot paths. */
export const POW2 = new Float64Array(41);
/** Precomputed 2^(-z) for integer z ∈ [0..40]. */
export const INV_POW2 = new Float64Array(41);
for (let i = 0; i <= 40; i++) {
  POW2[i] = 2 ** i;
  INV_POW2[i] = 2 ** -i;
}
