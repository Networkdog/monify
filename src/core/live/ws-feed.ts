// ---------------------------------------------------------------------------
// WebSocket feed client — receives MutationMessages from a remote server and
// dispatches them to the MutationBus for tile invalidation and re-rendering.
//
// Protocol (JSON over WebSocket):
//   Server → Client: MutationMessage { v: 1, seq, ts, ops }
//   Client → Server: { v: 1, ack: seq, applied: number }
//
// The client auto-reconnects on disconnect with exponential backoff.
// ---------------------------------------------------------------------------

import type { MutationBus } from './mutation-bus';
import type { MutationMessage, MutationOp } from './live-store';

export interface WsFeedOptions {
  /** WebSocket server URL (ws:// or wss://). */
  url: string;
  /** MutationBus to dispatch received ops to. */
  bus: MutationBus;
  /**
   * Authentication token. When set, sent as the first message after
   * connection opens: `{ v: 1, type: "auth", token }`. The server
   * should validate the token and close the connection if invalid.
   */
  auth?: string;
  /** Initial reconnect delay in ms. Default: 1000. */
  reconnectDelay?: number;
  /** Max reconnect delay in ms. Default: 30000. */
  maxReconnectDelay?: number;
  /** Called when connected. */
  onConnect?: () => void;
  /** Called when disconnected. */
  onDisconnect?: (ev: CloseEvent) => void;
  /** Called on parse/protocol errors. */
  onError?: (err: unknown) => void;
}

export class WsFeed {
  private url: string;
  private bus: MutationBus;
  private ws: WebSocket | null = null;
  private auth: string | undefined;
  private reconnectDelay: number;
  private maxReconnectDelay: number;
  private currentDelay: number;
  private disposed = false;
  private lastSeq = -1;
  private onConnect: (() => void) | undefined;
  private onDisconnect: ((ev: CloseEvent) => void) | undefined;
  private onError: ((err: unknown) => void) | undefined;

  constructor(opts: WsFeedOptions) {
    this.url = opts.url;
    this.bus = opts.bus;
    this.auth = opts.auth;
    this.reconnectDelay = opts.reconnectDelay ?? 1000;
    this.maxReconnectDelay = opts.maxReconnectDelay ?? 30_000;
    this.currentDelay = this.reconnectDelay;
    this.onConnect = opts.onConnect;
    this.onDisconnect = opts.onDisconnect;
    this.onError = opts.onError;
  }

  /** Open the WebSocket connection. */
  connect(): void {
    if (this.disposed) return;
    this._open();
  }

  /** Close the connection and stop reconnecting. */
  dispose(): void {
    this.disposed = true;
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.onmessage = null;
      this.ws.close();
      this.ws = null;
    }
  }

  /** Send a raw JSON message to the server. */
  send(msg: unknown): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  // ── Internals ─────────────────────────────────────────────────────────

  private _open(): void {
    if (this.disposed) return;
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.onopen = () => {
      this.currentDelay = this.reconnectDelay;
      // Send auth token as the first message when configured.
      if (this.auth) {
        this.send({ v: 1, type: 'auth', token: this.auth });
      }
      this.onConnect?.();
    };

    ws.onmessage = (ev: MessageEvent) => {
      this._handleMessage(ev.data);
    };

    ws.onclose = (ev: CloseEvent) => {
      this.onDisconnect?.(ev);
      this._scheduleReconnect();
    };

    ws.onerror = () => {
      // onerror is always followed by onclose, so reconnect happens there.
    };
  }

  private _handleMessage(data: unknown): void {
    try {
      const raw = typeof data === 'string' ? data : String(data);
      const msg = JSON.parse(raw) as MutationMessage;

      if (msg.v !== 1) {
        this.onError?.(new Error(`Unsupported protocol version: ${msg.v}`));
        return;
      }

      // Deduplicate: skip if we've already processed this sequence number.
      if (msg.seq <= this.lastSeq) return;
      this.lastSeq = msg.seq;

      // Validate ops array
      if (!Array.isArray(msg.ops) || msg.ops.length === 0) return;

      // Dispatch to bus
      const batchOp: MutationOp = msg.ops.length === 1
        ? msg.ops[0]
        : { op: 'batch', ops: msg.ops };
      this.bus.apply(batchOp);

      // Send ack
      this.send({ v: 1, ack: msg.seq, applied: msg.ops.length });
    } catch (err) {
      this.onError?.(err);
    }
  }

  private _scheduleReconnect(): void {
    if (this.disposed) return;
    setTimeout(() => this._open(), this.currentDelay);
    this.currentDelay = Math.min(this.currentDelay * 2, this.maxReconnectDelay);
  }
}
