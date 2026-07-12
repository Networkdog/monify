import { TILE_CACHE_CAPACITY } from '../constants';
import { tileKeyNum } from '../types';
import type { FlatTile } from './tile-schema';

export type TileStatus = 'loading' | 'ready' | 'missing' | 'error';

export interface TileEntry {
  status: TileStatus;
  tile?: FlatTile;
  /** Abort token for in-flight fetch. */
  abort?: AbortController;
  error?: unknown;
  /** LiveStore generation when this tile was built. */
  generation?: number;
}

/** LRU tile cache keyed by packed numeric z/x/y. */
export class TileCache {
  private map = new Map<number, TileEntry>();
  private capacity: number;

  constructor(capacity = TILE_CACHE_CAPACITY) {
    this.capacity = capacity;
  }

  get(z: number, x: number, y: number): TileEntry | undefined {
    const k = tileKeyNum(z, x, y);
    const v = this.map.get(k);
    if (v) {
      // Re-insert for LRU recency.
      this.map.delete(k);
      this.map.set(k, v);
    }
    return v;
  }

  set(z: number, x: number, y: number, entry: TileEntry): void {
    const k = tileKeyNum(z, x, y);
    if (this.map.has(k)) this.map.delete(k);
    this.map.set(k, entry);
    this.evictIfNeeded();
  }

  has(z: number, x: number, y: number): boolean {
    return this.map.has(tileKeyNum(z, x, y));
  }

  delete(z: number, x: number, y: number): void {
    this.map.delete(tileKeyNum(z, x, y));
  }

  /** Drop every cached tile (aborting any in-flight loads). */
  clear(): void {
    for (const entry of this.map.values()) entry.abort?.abort();
    this.map.clear();
  }

  size(): number {
    return this.map.size;
  }

  /** Iterate entries (oldest → newest). */
  entries(): IterableIterator<[number, TileEntry]> {
    return this.map.entries();
  }

  getCapacity(): number {
    return this.capacity;
  }

  setCapacity(cap: number): void {
    this.capacity = cap;
    this.evictIfNeeded();
  }

  private evictIfNeeded(): void {
    while (this.map.size > this.capacity) {
      const oldestKey = this.map.keys().next().value as number | undefined;
      if (oldestKey === undefined) break;
      const entry = this.map.get(oldestKey);
      // Abort if still loading.
      entry?.abort?.abort();
      this.map.delete(oldestKey);
    }
  }
}
