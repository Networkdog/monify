// ---------------------------------------------------------------------------
// LiveStore — mutable runtime state layer for real-time object mutation.
//
// Objects in the procedural hierarchy are identified by "layerIdx:ix:iy".
// Ephemeral (runtime-created) objects use arbitrary string IDs with an "e:"
// prefix to avoid collision with procedural keys.
//
// The store holds three collections:
//   overrides  — partial property bags that modify procedural objects
//   ephemeral  — objects created at runtime, not in the procedural grid
//   deleted    — IDs suppressed from rendering
//
// A monotonically increasing `generation` counter tracks mutations so the
// tile cache can detect staleness without explicit per-tile invalidation.
// ---------------------------------------------------------------------------

import type { RGBA } from '../types';

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

/** Partial property overrides applied to a procedural object. */
export interface ObjectOverride {
  /** Direct fill color override (bypasses status/utilization color logic). */
  color?: RGBA;
  /** Override the h1 hash value (drives status color in draw functions). */
  statusValue?: number;
  /** Override the h2 hash value (drives sizing / utilization heat). */
  utilizationValue?: number;
  /** Hide the object without removing its override entry. */
  visible?: boolean;
  /** Override label text (layer-dependent). */
  label?: string;
  /** Animated visual effect. */
  pulseEffect?: 'alert' | 'highlight' | 'none';
  /** Extensible metadata (ignored by the renderer, available to consumers). */
  custom?: Record<string, unknown>;
}

/** A runtime-created object not present in the procedural grid. */
export interface EphemeralObject {
  id: string;
  layerIdx: number;
  worldX: number;
  worldY: number;
  minZoom: number;
  maxZoom: number;
  drawFn: string;
  props: Record<string, unknown>;
}

/** Mutation operation discriminated union. */
export type MutationOp =
  | { op: 'set'; id: string; fields: Partial<ObjectOverride> }
  | { op: 'delete'; id: string }
  | { op: 'restore'; id: string }
  | { op: 'add'; obj: EphemeralObject }
  | { op: 'remove'; id: string }
  | { op: 'snapshot'; overrides: Record<string, Partial<ObjectOverride>>; deleted: string[]; ephemeral: EphemeralObject[] }
  | { op: 'batch'; ops: MutationOp[] };

/** Wire-format message for the WebSocket / REST protocol. */
export interface MutationMessage {
  /** Protocol version. */
  v: 1;
  /** Monotonic sequence number for ordering. */
  seq: number;
  /** Timestamp in epoch milliseconds. */
  ts: number;
  /** Operations to apply. */
  ops: MutationOp[];
}

export type MutationListener = (op: MutationOp) => void;

// ═══════════════════════════════════════════════════════════════════════════
// LiveStore
// ═══════════════════════════════════════════════════════════════════════════

export class LiveStore {
  /** Partial property overrides keyed by object ID ("layerIdx:ix:iy"). */
  readonly overrides = new Map<string, Partial<ObjectOverride>>();

  /** Runtime-created objects keyed by their string ID. */
  readonly ephemeral = new Map<string, EphemeralObject>();

  /** Object IDs suppressed from rendering. */
  readonly deleted = new Set<string>();

  /**
   * Monotonically increasing counter. Bumped on every mutation so the tile
   * cache can detect stale entries via a simple numeric comparison.
   */
  generation = 0;

  /** Listeners notified after each top-level mutation. */
  private _listeners: MutationListener[] = [];

  // ── Mutation API ──────────────────────────────────────────────────────

  /** Override properties of a procedural object. */
  set(id: string, fields: Partial<ObjectOverride>): void {
    const existing = this.overrides.get(id);
    if (existing) {
      Object.assign(existing, fields);
    } else {
      this.overrides.set(id, { ...fields });
    }
    this.generation++;
    this._notify({ op: 'set', id, fields });
  }

  /** Mark a procedural object as deleted (hidden from rendering). */
  delete(id: string): void {
    this.deleted.add(id);
    this.generation++;
    this._notify({ op: 'delete', id });
  }

  /** Restore a previously deleted procedural object. */
  restore(id: string): void {
    if (this.deleted.delete(id)) {
      this.generation++;
      this._notify({ op: 'restore', id });
    }
  }

  /** Add a runtime-created ephemeral object. */
  add(obj: EphemeralObject): void {
    this.ephemeral.set(obj.id, obj);
    this.generation++;
    this._notify({ op: 'add', obj });
  }

  /** Remove a previously added ephemeral object. */
  remove(id: string): void {
    if (this.ephemeral.delete(id)) {
      this.generation++;
      this._notify({ op: 'remove', id });
    }
  }

  /**
   * Apply a full-state snapshot (replaces all current state).
   * Bumps generation exactly once.
   */
  applySnapshot(
    overrides: Record<string, Partial<ObjectOverride>>,
    deleted: string[],
    ephemeral: EphemeralObject[],
  ): void {
    this.overrides.clear();
    for (const [k, v] of Object.entries(overrides)) this.overrides.set(k, v);
    this.deleted.clear();
    for (const id of deleted) this.deleted.add(id);
    this.ephemeral.clear();
    for (const obj of ephemeral) this.ephemeral.set(obj.id, obj);
    this.generation++;
    this._notify({
      op: 'snapshot',
      overrides,
      deleted,
      ephemeral,
    });
  }

  /**
   * Apply multiple operations atomically — generation increments once,
   * listeners receive one `batch` event.
   */
  batch(ops: MutationOp[]): void {
    for (const op of ops) this._applyOne(op, false);
    this.generation++;
    this._notify({ op: 'batch', ops });
  }

  /** Apply a single MutationOp (including nested batches). */
  apply(op: MutationOp): void {
    this._applyOne(op, true);
  }

  /** Get the override for an object, or undefined. */
  get(id: string): Partial<ObjectOverride> | undefined {
    return this.overrides.get(id);
  }

  /**
   * Convert a numeric key back to a string ID, using a small cache to
   * avoid per-cell string allocation in the hot renderContent loop.
   */
  private _idCache = new Map<number, string>();
  _numToId(key: number, layerIdx: number, ix: number, iy: number): string {
    let s = this._idCache.get(key);
    if (s === undefined) {
      s = `${layerIdx}:${ix}:${iy}`;
      this._idCache.set(key, s);
      // Cap cache at 16k entries to prevent unbounded growth.
      if (this._idCache.size > 16384) this._idCache.clear();
    }
    return s;
  }

  /** Check if an object has been deleted. */
  isDeleted(id: string): boolean {
    return this.deleted.has(id);
  }

  /** Check if any pulse effects are active (drives continuous redraw). */
  hasActivePulses(): boolean {
    for (const ov of this.overrides.values()) {
      if (ov.pulseEffect && ov.pulseEffect !== 'none') return true;
    }
    return false;
  }

  /** Reset all state. */
  clear(): void {
    this.overrides.clear();
    this.ephemeral.clear();
    this.deleted.clear();
    this.generation++;
  }

  // ── Subscriptions ─────────────────────────────────────────────────────

  /** Subscribe to mutation events. Returns an unsubscribe function. */
  onChange(listener: MutationListener): () => void {
    this._listeners.push(listener);
    return () => {
      const idx = this._listeners.indexOf(listener);
      if (idx >= 0) this._listeners.splice(idx, 1);
    };
  }

  // ── Internals ─────────────────────────────────────────────────────────

  private _applyOne(op: MutationOp, bump: boolean): void {
    switch (op.op) {
      case 'set': {
        const existing = this.overrides.get(op.id);
        if (existing) Object.assign(existing, op.fields);
        else this.overrides.set(op.id, { ...op.fields });
        break;
      }
      case 'delete':
        this.deleted.add(op.id);
        break;
      case 'restore':
        this.deleted.delete(op.id);
        break;
      case 'add':
        this.ephemeral.set(op.obj.id, op.obj);
        break;
      case 'remove':
        this.ephemeral.delete(op.id);
        break;
      case 'snapshot':
        this.applySnapshot(op.overrides, op.deleted, op.ephemeral);
        return; // applySnapshot handles its own generation bump
      case 'batch':
        for (const sub of op.ops) this._applyOne(sub, false);
        break;
    }
    if (bump) {
      this.generation++;
      this._notify(op);
    }
  }

  private _notify(op: MutationOp): void {
    for (let i = 0; i < this._listeners.length; i++) {
      this._listeners[i](op);
    }
  }
}
