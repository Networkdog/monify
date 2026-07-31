// WebSocketSource — a DataSource that streams entity updates over a WebSocket.
//
// It connects to a server that pushes JSON batches and reconnects with
// exponential backoff. By default it accepts either a bare `EntityUpdate[]` or
// `{ entities: EntityUpdate[] }`; pass `parse` to adapt any other envelope. This
// is the "real backend" counterpart to SimulatedSource.

import type {
  ConnectionState,
  DataListener,
  DataSource,
  EntityUpdate,
  StateListener,
} from './types';

export interface WebSocketSourceOptions {
  /** ws:// or wss:// endpoint. */
  url: string;
  /** Parse a raw text message into entity updates. Default: JSON array or `{entities}`. */
  parse?: (data: string) => readonly EntityUpdate[];
  /** Optional auth token sent as the first message: `{type:'auth',token}`. */
  auth?: string;
  /** Initial reconnect delay in ms. Default 1000. */
  reconnectDelay?: number;
  /** Maximum reconnect delay in ms. Default 30000. */
  maxReconnectDelay?: number;
}

/** Minimal structural subset of the WebSocket API this source relies on. */
interface SocketLike {
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  send(data: string): void;
  close(): void;
}

function defaultParse(data: string): readonly EntityUpdate[] {
  const parsed: unknown = JSON.parse(data);
  if (Array.isArray(parsed)) return parsed as EntityUpdate[];
  if (
    parsed &&
    typeof parsed === 'object' &&
    Array.isArray((parsed as { entities?: unknown }).entities)
  ) {
    return (parsed as { entities: EntityUpdate[] }).entities;
  }
  return [];
}

export class WebSocketSource implements DataSource {
  readonly name = 'websocket';

  private readonly url: string;
  private readonly parse: (data: string) => readonly EntityUpdate[];
  private readonly auth?: string;
  private readonly baseDelay: number;
  private readonly maxDelay: number;

  private readonly dataCbs = new Set<DataListener>();
  private readonly stateCbs = new Set<StateListener>();
  private ws: SocketLike | null = null;
  private delay: number;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private _state: ConnectionState = 'idle';

  constructor(opts: WebSocketSourceOptions) {
    this.url = opts.url;
    this.parse = opts.parse ?? defaultParse;
    this.auth = opts.auth;
    this.baseDelay = opts.reconnectDelay ?? 1000;
    this.maxDelay = opts.maxReconnectDelay ?? 30000;
    this.delay = this.baseDelay;
  }

  onData(listener: DataListener): () => void {
    this.dataCbs.add(listener);
    return () => this.dataCbs.delete(listener);
  }

  onState(listener: StateListener): () => void {
    this.stateCbs.add(listener);
    return () => this.stateCbs.delete(listener);
  }

  /** Current connection state. */
  get state(): ConnectionState {
    return this._state;
  }

  start(): void {
    this.disposed = false;
    this._open();
  }

  stop(): void {
    this.disposed = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this._setState('closed');
  }

  private _open(): void {
    const Ctor = (globalThis as { WebSocket?: new (url: string) => SocketLike }).WebSocket;
    if (!Ctor) {
      this._setState('error');
      return;
    }
    this._setState('connecting');
    const ws = new Ctor(this.url);
    this.ws = ws;
    ws.onopen = (): void => {
      this.delay = this.baseDelay;
      this._setState('open');
      if (this.auth) ws.send(JSON.stringify({ type: 'auth', token: this.auth }));
    };
    ws.onmessage = (ev): void => {
      try {
        const records = this.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
        if (records.length > 0) this._emit(records);
      } catch {
        // Ignore malformed frames; a monitoring stream should never crash the UI.
      }
    };
    ws.onclose = (): void => {
      this._setState('closed');
      this._scheduleReconnect();
    };
    ws.onerror = (): void => {
      this._setState('error');
    };
  }

  private _scheduleReconnect(): void {
    if (this.disposed) return;
    this.reconnectTimer = setTimeout(() => this._open(), this.delay);
    this.delay = Math.min(this.delay * 2, this.maxDelay);
  }

  private _emit(records: readonly EntityUpdate[]): void {
    for (const cb of this.dataCbs) cb(records);
  }

  private _setState(s: ConnectionState): void {
    if (this._state === s) return;
    this._state = s;
    for (const cb of this.stateCbs) cb(s);
  }
}
