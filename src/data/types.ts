// monify data layer — a source-agnostic pipeline that feeds live monitoring
// data into a visualization.
//
//   DataSource  →  MonitorFeed  →  MonitorTarget (a viz such as HexGrid)
//
// `EntityUpdate` is a tiny partial status snapshot for one monitored entity. A
// backend adapter (WebSocket, REST poll, simulation) maps its native payload
// onto a batch of these; a visualization implements `MonitorTarget.applyUpdate`
// to absorb the batch. Because the record carries only an id plus a few optional
// signals, no adapter needs to know anything about the renderer.

import type { RGBA } from '../core/types';

/** Severity of one sub-resource inside an entity (0 = healthy, 1 = critical). */
export interface ResourceUpdate {
  /** Resource id, matching a workload resource's id in the visualization. */
  id: string;
  /** Severity 0..1. */
  value: number;
}

/**
 * A partial live status update for a single monitored entity. Only `id` is
 * required; every other field is an optional signal, so an adapter sends just
 * what it currently knows.
 */
export interface EntityUpdate {
  /** Stable entity id (matches a visualization entity's id). */
  id: string;
  /** Overall severity 0..1 (0 = healthy, 1 = critical) driving the status colour. */
  severity?: number;
  /** Transient anomaly pulse 0..1 — a momentary spike that decays on its own. */
  anomaly?: number;
  /** Per-resource severities for deep-zoom detail. */
  resources?: readonly ResourceUpdate[];
  /** Categorical tint override (used by a category colour mode). */
  tint?: RGBA;
  /** Source timestamp (epoch ms); informational. */
  ts?: number;
}

/**
 * A visualization that can absorb a batch of entity updates in a single call.
 * Implemented by the monitoring visualizations so any DataSource can drive them.
 */
export interface MonitorTarget {
  applyUpdate(records: readonly EntityUpdate[]): void;
}

/** Lifecycle state of a DataSource connection. */
export type ConnectionState = 'idle' | 'connecting' | 'open' | 'closed' | 'error';

/** Receives batches of entity updates from a DataSource. */
export type DataListener = (records: readonly EntityUpdate[]) => void;

/** Receives connection-state transitions from a DataSource. */
export type StateListener = (state: ConnectionState) => void;

/**
 * A backend adapter that emits batches of entity updates. Concrete sources
 * (WebSocket, REST poll, simulation) implement this so the rest of the pipeline
 * stays transport-agnostic.
 */
export interface DataSource {
  /** Human-readable adapter name (for diagnostics). */
  readonly name: string;
  /** Begin producing data (connect / start polling / start the sim clock). */
  start(): void;
  /** Stop producing data and release resources. */
  stop(): void;
  /** Subscribe to update batches. Returns an unsubscribe function. */
  onData(listener: DataListener): () => void;
  /** Subscribe to connection-state changes. Returns an unsubscribe function. */
  onState(listener: StateListener): () => void;
}
