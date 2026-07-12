// ---------------------------------------------------------------------------
// MutationBus — dispatches MutationOps to the LiveStore and computes which
// tiles need invalidation in the TileCache.
//
// The bus sits between external data sources (WebSocket, REST, JS API) and
// the LiveStore + TileCache. It:
//   1. Applies ops to the LiveStore.
//   2. Computes affected tile coordinates for each mutated object.
//   3. Evicts those tiles from the TileCache.
//   4. Marks the Scene dirty so the next frame re-generates them.
//
// Frame-level coalescing: when `coalesce` is enabled, mutations are buffered
// and flushed once per animation frame. This prevents redundant tile eviction
// when many ops arrive between two frames.
// ---------------------------------------------------------------------------

import type { LiveStore, MutationOp, EphemeralObject } from './live-store';
import type { TileCache } from '../tile/tile-cache';
import type { TileCoord } from '../types';

// ═══════════════════════════════════════════════════════════════════════════
// Layer metadata (zoom ranges) — injected at construction so the bus does
// not import content.ts and create a circular dependency.
// ═══════════════════════════════════════════════════════════════════════════

export interface LayerMeta {
  minZ: number;
  maxZ: number;
}

export interface MutationBusOptions {
  store: LiveStore;
  cache: TileCache;
  layers: LayerMeta[];
  /** Resolve an object ID to its world position. */
  resolvePosition: (id: string) => [number, number] | null;
  /** Called after tiles are evicted so the scene can schedule a redraw. */
  onDirty?: () => void;
  /** Buffer mutations and flush once per rAF. Default: false. */
  coalesce?: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════
// MutationBus
// ═══════════════════════════════════════════════════════════════════════════

export class MutationBus {
  private store: LiveStore;
  private cache: TileCache;
  private layers: LayerMeta[];
  private resolvePosition: (id: string) => [number, number] | null;
  private onDirty: () => void;
  private coalesce: boolean;

  // Coalescing state
  private _buffer: MutationOp[] = [];
  private _rafId = 0;

  constructor(opts: MutationBusOptions) {
    this.store = opts.store;
    this.cache = opts.cache;
    this.layers = opts.layers;
    this.resolvePosition = opts.resolvePosition;
    this.onDirty = opts.onDirty ?? (() => {});
    this.coalesce = opts.coalesce ?? false;
  }

  /**
   * Submit a mutation. When coalescing is enabled, the op is buffered and
   * applied on the next animation frame. Otherwise, applied immediately.
   */
  apply(op: MutationOp): void {
    if (this.coalesce) {
      this._buffer.push(op);
      if (this._rafId === 0) {
        this._rafId = requestAnimationFrame(() => this._flush());
      }
    } else {
      this._applyImmediate(op);
    }
  }

  /** Submit multiple ops as a batch. */
  applyBatch(ops: MutationOp[]): void {
    this.apply({ op: 'batch', ops });
  }

  /**
   * Compute the tile coordinates affected by a mutation on a given object.
   * Used internally for cache eviction, but exposed for testing.
   */
  affectedTiles(id: string, layerIdx: number): TileCoord[] {
    const pos = this.resolvePosition(id);
    if (!pos) return [];

    const [wx, wy] = pos;
    const layer = this.layers[layerIdx];
    if (!layer) return [];

    const result: TileCoord[] = [];
    for (let z = layer.minZ; z <= layer.maxZ; z++) {
      const scale = Math.pow(2, z);
      const tx = Math.floor(wx * scale);
      const ty = Math.floor(wy * scale);
      result.push({ z, x: tx, y: ty });

      // Also invalidate neighboring tiles if the object is near a boundary.
      // An object at the edge of a tile may bleed into adjacent tiles.
      const fx = wx * scale - tx;
      const fy = wy * scale - ty;
      const margin = 0.15; // conservative margin
      if (fx < margin) result.push({ z, x: tx - 1, y: ty });
      if (fx > 1 - margin) result.push({ z, x: tx + 1, y: ty });
      if (fy < margin) result.push({ z, x: tx, y: ty - 1 });
      if (fy > 1 - margin) result.push({ z, x: tx, y: ty + 1 });
      // Corner tiles
      if (fx < margin && fy < margin) result.push({ z, x: tx - 1, y: ty - 1 });
      if (fx > 1 - margin && fy < margin) result.push({ z, x: tx + 1, y: ty - 1 });
      if (fx < margin && fy > 1 - margin) result.push({ z, x: tx - 1, y: ty + 1 });
      if (fx > 1 - margin && fy > 1 - margin) result.push({ z, x: tx + 1, y: ty + 1 });
    }
    return result;
  }

  /** Cancel any pending coalesced flush. */
  dispose(): void {
    if (this._rafId !== 0) {
      cancelAnimationFrame(this._rafId);
      this._rafId = 0;
    }
  }

  // ── Internals ─────────────────────────────────────────────────────────

  private _flush(): void {
    this._rafId = 0;
    if (this._buffer.length === 0) return;
    const ops = this._buffer;
    this._buffer = [];
    // Apply all buffered ops as a single batch to the store (one generation bump).
    this.store.batch(ops);
    // Evict affected tiles.
    this._evictForOps(ops);
    this.onDirty();
  }

  private _applyImmediate(op: MutationOp): void {
    this.store.apply(op);
    this._evictForOp(op);
    this.onDirty();
  }

  private _evictForOps(ops: MutationOp[]): void {
    for (const op of ops) {
      this._evictForOp(op);
    }
  }

  private _evictForOp(op: MutationOp): void {
    switch (op.op) {
      case 'set':
      case 'delete':
      case 'restore': {
        const layerIdx = this._layerFromId(op.id);
        if (layerIdx < 0) return;
        const tiles = this.affectedTiles(op.id, layerIdx);
        for (const t of tiles) this.cache.delete(t.z, t.x, t.y);
        break;
      }
      case 'add': {
        const obj = op.obj as EphemeralObject;
        this._evictEphemeral(obj);
        break;
      }
      case 'remove': {
        // Look up the ephemeral object before it was removed to find its position.
        // After store.apply() it's gone, so we resolve by ID.
        const layerIdx = this._layerFromId(op.id);
        if (layerIdx >= 0) {
          const tiles = this.affectedTiles(op.id, layerIdx);
          for (const t of tiles) this.cache.delete(t.z, t.x, t.y);
        }
        break;
      }
      case 'snapshot': {
        // Full state reset — flush entire cache.
        this._evictAll();
        break;
      }
      case 'batch': {
        for (const sub of op.ops) this._evictForOp(sub);
        break;
      }
    }
  }

  private _evictEphemeral(obj: EphemeralObject): void {
    for (let z = obj.minZoom; z <= obj.maxZoom; z++) {
      const scale = Math.pow(2, z);
      const tx = Math.floor(obj.worldX * scale);
      const ty = Math.floor(obj.worldY * scale);
      this.cache.delete(z, tx, ty);
      // Neighbors for border bleed
      this.cache.delete(z, tx - 1, ty);
      this.cache.delete(z, tx + 1, ty);
      this.cache.delete(z, tx, ty - 1);
      this.cache.delete(z, tx, ty + 1);
    }
  }

  private _evictAll(): void {
    // Delete all cached entries. Walk through entries and collect keys first
    // to avoid mutation during iteration.
    const keys: [number, number, number][] = [];
    for (const [packed] of this.cache.entries()) {
      // Unpack: z = top 5 bits, x = next 24 bits - offset, y = bottom 24 bits - offset
      const y = (packed & 0xFFFFFF) - 0x800000;
      const rest = Math.floor(packed / 0x1000000);
      const x = (rest & 0xFFFFFF) - 0x800000;
      const z = Math.floor(rest / 0x1000000) & 0x1F;
      keys.push([z, x, y]);
    }
    for (const [z, x, y] of keys) this.cache.delete(z, x, y);
  }

  /** Extract layer index from an object ID string "layerIdx:ix:iy". */
  private _layerFromId(id: string): number {
    const colon = id.indexOf(':');
    if (colon < 0) return -1;
    return parseInt(id.substring(0, colon), 10);
  }
}
