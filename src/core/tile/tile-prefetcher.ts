/**
 * Background tile prefetcher using Web Workers.
 *
 * Pre-generates tiles for ADJACENT zoom levels (z±1, z±2) on worker threads
 * so they're already cached when the user zooms. The main thread still
 * generates current-zoom tiles synchronously (no flicker guarantee), but
 * zoom transitions become instant when prefetched tiles are in cache.
 */

import { TileCache } from './tile-cache';
import type { FlatElement } from './tile-schema';
import type { TileCoord } from '../types';
import { tileKeyNum } from '../types';

export class TilePrefetcher {
  private workers: Worker[] = [];
  private round = 0;
  private inflight = new Set<number>();
  private cache: TileCache;
  private onReady: () => void;
  private available = false;

  constructor(cache: TileCache, onReady: () => void, workerUrl?: URL) {
    this.cache = cache;
    this.onReady = onReady;

    // Detect worker support + allocate half of available cores (min 1, max 4).
    if (typeof Worker === 'undefined' || !workerUrl) return;
    const n = Math.max(1, Math.min(4, ((navigator.hardwareConcurrency ?? 2) >> 1)));
    try {
      for (let i = 0; i < n; i++) {
        const w = new Worker(
          workerUrl,
          { type: 'module' },
        );
        w.onmessage = (e) => this.onBatchResult(e.data);
        w.onerror = () => { /* worker failed — degrade gracefully */ };
        this.workers.push(w);
      }
      this.available = true;
    } catch {
      // Workers not supported (e.g., file:// protocol). Degrade gracefully.
    }
  }

  /** Send a batch of tile coords for background generation. */
  prefetch(coords: TileCoord[]): void {
    if (!this.available || coords.length === 0) return;

    // Filter to tiles not already cached or in-flight.
    const batch: Array<{ z: number; x: number; y: number }> = [];
    for (const c of coords) {
      const key = tileKeyNum(c.z, c.x, c.y);
      if (this.inflight.has(key)) continue;
      const existing = this.cache.get(c.z, c.x, c.y);
      if (existing && existing.status === 'ready') continue;
      this.inflight.add(key);
      batch.push({ z: c.z, x: c.x, y: c.y });
    }

    if (batch.length === 0) return;

    // Round-robin across workers.
    const worker = this.workers[this.round++ % this.workers.length];
    worker.postMessage(batch);
  }

  private onBatchResult(results: Array<{ z: number; x: number; y: number; elements: FlatElement[] }>): void {
    let added = false;
    for (const r of results) {
      const key = tileKeyNum(r.z, r.x, r.y);
      this.inflight.delete(key);
      // Only cache if not already ready (main thread may have generated it).
      const existing = this.cache.get(r.z, r.x, r.y);
      if (!existing || existing.status !== 'ready') {
        this.cache.set(r.z, r.x, r.y, {
          status: 'ready',
          tile: { z: r.z, x: r.x, y: r.y, elements: r.elements },
        });
        added = true;
      }
    }
    if (added) this.onReady();
  }

  terminate(): void {
    for (const w of this.workers) w.terminate();
    this.workers.length = 0;
    this.available = false;
  }
}
