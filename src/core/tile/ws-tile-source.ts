// ---------------------------------------------------------------------------
// WsTileSource — WebSocket-based tile transport for minimum-latency on-demand
// tile loading. Plugs into TileLoader as an alternative to HTTP fetch.
//
// Protocol (mirrors server/tile-server.ts):
//   Client → Server:
//     { type: "tiles", coords: [{z,x,y}, ...] }
//     { type: "cancel", coords: [{z,x,y}, ...] }
//   Server → Client:
//     { type: "tile", z, x, y, elements: FlatElement[] }
//     { type: "tile-empty", z, x, y }
//     { type: "tile-error", z, x, y, error: string }
//
// Features:
//   - Batches tile requests into a single message per frame
//   - Cancels out-of-view tiles (sends cancel to server)
//   - Auto-reconnects with exponential backoff
//   - Request deduplication via pending key tracking
// ---------------------------------------------------------------------------

import type { FlatElement, FlatTile } from './tile-schema';
import { tileKeyNum } from '../types';

export interface WsTileSourceOptions {
  /** WebSocket server URL (ws:// or wss://). */
  url: string;
  /** Called when a tile is ready. */
  onTile?: (z: number, x: number, y: number, tile: FlatTile) => void;
  /** Called when a tile is empty. */
  onEmpty?: (z: number, x: number, y: number) => void;
  /** Called on tile generation error. */
  onError?: (z: number, x: number, y: number, error: string) => void;
  /** Called when connected. */
  onConnect?: () => void;
  /** Called when disconnected. */
  onDisconnect?: () => void;
  /** Initial reconnect delay in ms. Default: 500. */
  reconnectDelay?: number;
  /** Max reconnect delay in ms. Default: 15000. */
  maxReconnectDelay?: number;
  /**
   * Authentication token. When set, sent as the first message after
   * connection opens: `{ type: "auth", token }`. The server should
   * validate the token and close the connection if invalid.
   */
  auth?: string;
}

/**
 * WebSocket tile source. Sends batched tile requests to a tile server and
 * dispatches responses via callbacks. Integrates with TileLoader via the
 * onTile/onEmpty/onError callbacks.
 */
export class WsTileSource {
  private url: string;
  private ws: WebSocket | null = null;
  private disposed = false;
  private reconnectDelay: number;
  private maxReconnectDelay: number;
  private currentDelay: number;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  // Pending tile keys — tracks what we've requested but not yet received.
  private pending = new Set<number>();

  // Batch buffer — accumulated within a frame, flushed on microtask.
  private requestBatch: Array<{ z: number; x: number; y: number }> = [];
  private batchScheduled = false;

  // Callbacks
  private _onTile: WsTileSourceOptions['onTile'];
  private _onEmpty: WsTileSourceOptions['onEmpty'];
  private _onError: WsTileSourceOptions['onError'];
  private _onConnect: WsTileSourceOptions['onConnect'];
  private _onDisconnect: WsTileSourceOptions['onDisconnect'];
  private _auth: string | undefined;

  constructor(opts: WsTileSourceOptions) {
    this.url = opts.url;
    this._auth = opts.auth;
    this.reconnectDelay = opts.reconnectDelay ?? 500;
    this.maxReconnectDelay = opts.maxReconnectDelay ?? 15_000;
    this.currentDelay = this.reconnectDelay;
    this._onTile = opts.onTile;
    this._onEmpty = opts.onEmpty;
    this._onError = opts.onError;
    this._onConnect = opts.onConnect;
    this._onDisconnect = opts.onDisconnect;
  }

  /** Open the WebSocket connection. */
  connect(): void {
    if (this.disposed) return;
    this._open();
  }

  /** Close and stop reconnecting. */
  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.onmessage = null;
      this.ws.close();
      this.ws = null;
    }
    this.pending.clear();
    this.requestBatch.length = 0;
  }

  /** Whether the connection is open. */
  get connected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /**
   * Request a tile. Requests are batched within a microtask and sent as a
   * single message. Duplicate requests (already pending) are skipped.
   */
  request(z: number, x: number, y: number): void {
    const key = tileKeyNum(z, x, y);
    if (this.pending.has(key)) return; // already in-flight
    this.pending.add(key);
    this.requestBatch.push({ z, x, y });

    if (!this.batchScheduled) {
      this.batchScheduled = true;
      queueMicrotask(() => this._flushBatch());
    }
  }

  /**
   * Cancel pending tile requests that are no longer needed (viewport changed).
   * Sends a cancel message to the server so it can skip generating them.
   */
  cancel(coords: Array<{ z: number; x: number; y: number }>): void {
    const toCancel: Array<{ z: number; x: number; y: number }> = [];
    for (const c of coords) {
      const key = tileKeyNum(c.z, c.x, c.y);
      if (this.pending.delete(key)) {
        toCancel.push(c);
      }
    }
    if (toCancel.length > 0) {
      this._send({ type: 'cancel', coords: toCancel });
    }
  }

  /** Cancel ALL pending requests not in the given wanted set. */
  cancelUnwanted(wanted: Set<number>): void {
    const toCancel: Array<{ z: number; x: number; y: number }> = [];
    for (const key of this.pending) {
      if (!wanted.has(key)) {
        // Decode key back to z/x/y (reverse of tileKeyNum)
        const y = (key & 0xFFFFFF) - 0x800000;
        const rest = Math.floor(key / 0x1000000);
        const x = (rest & 0xFFFFFF) - 0x800000;
        const z = Math.floor(rest / 0x1000000) & 0x1F;
        toCancel.push({ z, x, y });
      }
    }
    if (toCancel.length > 0) {
      for (const c of toCancel) {
        this.pending.delete(tileKeyNum(c.z, c.x, c.y));
      }
      this._send({ type: 'cancel', coords: toCancel });
    }
  }

  /** Number of tiles currently waiting for server response. */
  get pendingCount(): number {
    return this.pending.size;
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private _open(): void {
    if (this.disposed) return;
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.onopen = () => {
      this.currentDelay = this.reconnectDelay;
      // Send auth token as the first message when configured.
      if (this._auth) {
        this._send({ type: 'auth', token: this._auth });
      }
      this._onConnect?.();

      // Re-request any tiles that were pending when we disconnected
      if (this.pending.size > 0) {
        const coords: Array<{ z: number; x: number; y: number }> = [];
        for (const key of this.pending) {
          const y = (key & 0xFFFFFF) - 0x800000;
          const rest = Math.floor(key / 0x1000000);
          const x = (rest & 0xFFFFFF) - 0x800000;
          const z = Math.floor(rest / 0x1000000) & 0x1F;
          coords.push({ z, x, y });
        }
        this._send({ type: 'tiles', coords });
      }
    };

    ws.onmessage = (ev: MessageEvent) => {
      this._handleMessage(ev.data);
    };

    ws.onclose = () => {
      this._onDisconnect?.();
      this._scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose always follows — reconnect happens there.
    };
  }

  private _handleMessage(data: unknown): void {
    try {
      const raw = typeof data === 'string' ? data : String(data);
      const msg = JSON.parse(raw);

      if (msg.type === 'tile') {
        const key = tileKeyNum(msg.z, msg.x, msg.y);
        this.pending.delete(key);
        const flat: FlatTile = { z: msg.z, x: msg.x, y: msg.y, elements: msg.elements as FlatElement[] };
        this._onTile?.(msg.z, msg.x, msg.y, flat);
        return;
      }

      if (msg.type === 'tile-empty') {
        const key = tileKeyNum(msg.z, msg.x, msg.y);
        this.pending.delete(key);
        this._onEmpty?.(msg.z, msg.x, msg.y);
        return;
      }

      if (msg.type === 'tile-error') {
        const key = tileKeyNum(msg.z, msg.x, msg.y);
        this.pending.delete(key);
        this._onError?.(msg.z, msg.x, msg.y, msg.error);
        return;
      }
    } catch {
      // Ignore malformed messages
    }
  }

  private _flushBatch(): void {
    this.batchScheduled = false;
    if (this.requestBatch.length === 0) return;

    const coords = this.requestBatch.slice();
    this.requestBatch.length = 0;
    this._send({ type: 'tiles', coords });
  }

  private _send(msg: unknown): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private _scheduleReconnect(): void {
    if (this.disposed) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this._open();
    }, this.currentDelay);
    this.currentDelay = Math.min(this.currentDelay * 2, this.maxReconnectDelay);
  }
}
