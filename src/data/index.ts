// monify data layer — public barrel.
//
// A source-agnostic pipeline that feeds live monitoring data into the
// visualizations: DataSource → MonitorFeed → MonitorTarget.

export type {
  ResourceUpdate,
  EntityUpdate,
  MonitorTarget,
  ConnectionState,
  DataListener,
  StateListener,
  DataSource,
} from './types';
export { MonitorFeed, type MonitorFeedOptions } from './monitor-feed';
export {
  SimulatedSource,
  type SimulatedSourceOptions,
  type SimEntity,
} from './simulated-source';
export { WebSocketSource, type WebSocketSourceOptions } from './websocket-source';
