import { TILE_LOADER_CONCURRENCY } from '../constants';
import { TileCache } from './tile-cache';
import { flattenTile, type TileJSON } from './tile-schema';
import { tileKeyNum, type TileCoord } from '../types';
import { WsTileSource } from './ws-tile-source';
import { perfTrace } from '../perf-trace';

export interface TileLoaderOptions {
  /** Function building a URL from (z,x,y). Optional when `source` is set. */
  url?: (z: number, x: number, y: number) => string;
  /**
   * Direct tile producer. When provided, bypasses URL/fetch entirely and
   * is invoked on a yielded macrotask per tile (so a burst of generations
   * cannot block a single rAF).
   */
  source?: (z: number, x: number, y: number) => TileJSON;
  /**
   * WebSocket tile source. When provided, tiles are requested over a
   * persistent WebSocket connection for minimum latency. Takes priority
   * over `url` but not over `source`.
   */
  ws?: WsTileSource;
  /** Optional fetch options factory. */
  fetchInit?: () => RequestInit;
  /** Invoked whenever a tile transitions to `ready` (signals a redraw). */
  onReady?: () => void;
}

interface QueueItem extends TileCoord {
  priority: number;
}

/**
 * Concurrency-limited tile loader. Requests can be re-prioritised when the
 * viewport changes — out-of-view pending tiles are dropped.
 */
export class TileLoader {
  private cache: TileCache;
  private opts: TileLoaderOptions;
  private queue: QueueItem[] = [];
  private inFlight = 0;

  constructor(cache: TileCache, opts: TileLoaderOptions) {
    this.cache = cache;
    this.opts = opts;
  }

  /**
   * Submit a viewport's worth of tiles. Pending fetches not in `coords` are
   * cancelled. Lower priority numbers load first.
   */
  request(coords: ReadonlyArray<TileCoord & { priority?: number }>, count?: number): void {
    const n = count ?? coords.length;
    const wanted = new Set<number>();
    for (let i = 0; i < n; i++) wanted.add(tileKeyNum(coords[i].z, coords[i].x, coords[i].y));

    // Cancel pending/loading tiles no longer wanted. Skipped when using
    // tileSource — synchronous generation means tiles are never 'loading'.
    if (!this.opts.source) {
      // Cancel WebSocket pending tiles no longer in viewport.
      if (this.opts.ws) {
        this.opts.ws.cancelUnwanted(wanted);
      }
      for (const [k, entry] of this.cache.entries()) {
        if (entry.status === 'loading' && !wanted.has(k)) {
          entry.abort?.abort();
          entry.status = 'missing';
          entry.abort = undefined;
        }
      }
    }

    // Enqueue newly wanted tiles.
    this.queue.length = 0;
    for (let i = 0; i < n; i++) {
      const c = coords[i];
      const existing = this.cache.get(c.z, c.x, c.y);
      if (existing && (existing.status === 'ready' || existing.status === 'loading')) {
        if (perfTrace.enabled) perfTrace.tileCacheHit();
        continue;
      }
      if (perfTrace.enabled) perfTrace.tileCacheMiss();
      this.queue.push({ z: c.z, x: c.x, y: c.y, priority: c.priority ?? 0 });
    }
    // Always sort by priority so current-zoom tiles generate first.
    this.queue.sort((a, b) => a.priority - b.priority);
    this.pump();
  }

  private pump(): void {
    if (this.opts.source) {
      // Synchronous generation: ALL tiles are produced before draw() runs.
      // This guarantees no flickering from partially-loaded zoom levels.
      // A brief frame stall during zoom transitions is acceptable —
      // it's far less distracting than per-tile content flicker.
      while (this.queue.length > 0) {
        const next = this.queue.shift()!;
        this.fetchOne(next);
      }
      return;
    }
    // Async path — concurrency limited.
    while (this.inFlight < TILE_LOADER_CONCURRENCY && this.queue.length > 0) {
      const next = this.queue.shift()!;
      this.fetchOne(next);
    }
  }

  private fetchOne(c: TileCoord): void {
    // Direct-source fast path: generate SYNCHRONOUSLY so the tile is ready
    // before draw() runs in the same frame. Deferring via yieldThen caused
    // 1-frame placeholder flicker during zoom transitions — the tile was
    // scheduled as a macrotask but draw() ran first, rendering gray rects
    // into the cross-fade FBO.
    if (this.opts.source) {
      const src = this.opts.source;
      try {
        // Timed together: flattening is part of the same synchronous stall.
        const t0 = perfTrace.enabled ? performance.now() : 0;
        const json = src(c.z, c.x, c.y);
        const flat = flattenTile(json);
        if (perfTrace.enabled) perfTrace.tileGenerated(performance.now() - t0);
        this.cache.set(c.z, c.x, c.y, { status: 'ready', tile: flat });
      } catch (err) {
        this.cache.set(c.z, c.x, c.y, { status: 'error', error: err as Error });
      }
      // No inFlight tracking needed — completed inline.
      return;
    }

    // WebSocket fast path: delegate to the WsTileSource which batches
    // requests and streams responses over a persistent connection.
    if (this.opts.ws) {
      this.cache.set(c.z, c.x, c.y, { status: 'loading' });
      this.opts.ws.request(c.z, c.x, c.y);
      // inFlight not tracked for WS — responses arrive asynchronously via
      // the onTile/onEmpty/onError callbacks wired in Scene.
      return;
    }

    const abort = new AbortController();
    this.cache.set(c.z, c.x, c.y, { status: 'loading', abort });
    this.inFlight++;

    if (!this.opts.url) {
      this.inFlight--;
      this.cache.set(c.z, c.x, c.y, {
        status: 'error',
        error: new Error('TileLoader: no url or source configured'),
      });
      return;
    }
    const url = this.opts.url(c.z, c.x, c.y);

    // Fast path: synthetic `data:application/json` URLs are produced by the
    // app and round-tripping them through `fetch` + `Response.json()` costs
    // milliseconds per tile (and schedules a main-thread task). Decode
    // inline via a microtask so the existing async contract is preserved
    // but no fetch task is scheduled.
    if (url.startsWith('data:application/json')) {
      queueMicrotask(() => {
        this.inFlight--;
        if (abort.signal.aborted) {
          const entry = this.cache.get(c.z, c.x, c.y);
          if (entry) entry.status = 'missing';
          this.pump();
          return;
        }
        try {
          const comma = url.indexOf(',');
          const meta = url.slice(5, comma); // strip 'data:'
          let body = url.slice(comma + 1);
          if (meta.endsWith(';base64')) {
            body = atob(body);
          } else {
            body = decodeURIComponent(body);
          }
          const json = JSON.parse(body) as TileJSON;
          const flat = flattenTile(json);
          this.cache.set(c.z, c.x, c.y, { status: 'ready', tile: flat });
          this.opts.onReady?.();
        } catch (err) {
          this.cache.set(c.z, c.x, c.y, { status: 'error', error: err as Error });
        }
        this.pump();
      });
      return;
    }

    const init = { ...(this.opts.fetchInit?.() ?? {}), signal: abort.signal };
    fetch(url, init)
      .then(async (res) => {
        if (!res.ok) {
          if (res.status === 404) {
            this.cache.set(c.z, c.x, c.y, { status: 'missing' });
          } else {
            this.cache.set(c.z, c.x, c.y, { status: 'error', error: new Error(`HTTP ${res.status}`) });
          }
          return;
        }
        const json = (await res.json()) as TileJSON;
        const flat = flattenTile(json);
        this.cache.set(c.z, c.x, c.y, { status: 'ready', tile: flat });
        this.opts.onReady?.();
      })
      .catch((err) => {
        if ((err as Error)?.name === 'AbortError') {
          // Mark as missing so a future request can re-enqueue.
          const entry = this.cache.get(c.z, c.x, c.y);
          if (entry) entry.status = 'missing';
          return;
        }
        this.cache.set(c.z, c.x, c.y, { status: 'error', error: err });
      })
      .finally(() => {
        this.inFlight--;
        this.pump();
      });
  }
}
