import { describe, it, expect, vi } from 'vitest';
import { MonitorFeed } from '../src/data/monitor-feed';
import type {
  ConnectionState,
  DataListener,
  DataSource,
  EntityUpdate,
  MonitorTarget,
  StateListener,
} from '../src/data/types';

class FakeSource implements DataSource {
  readonly name = 'fake';
  private readonly data = new Set<DataListener>();
  private readonly stateCbs = new Set<StateListener>();
  started = false;
  stopped = false;
  start(): void {
    this.started = true;
  }
  stop(): void {
    this.stopped = true;
  }
  onData(l: DataListener): () => void {
    this.data.add(l);
    return () => this.data.delete(l);
  }
  onState(l: StateListener): () => void {
    this.stateCbs.add(l);
    return () => this.stateCbs.delete(l);
  }
  emit(records: EntityUpdate[]): void {
    for (const l of this.data) l(records);
  }
  setState(s: ConnectionState): void {
    for (const l of this.stateCbs) l(s);
  }
}

class CaptureTarget implements MonitorTarget {
  readonly batches: EntityUpdate[][] = [];
  applyUpdate(records: readonly EntityUpdate[]): void {
    this.batches.push([...records]);
  }
}

describe('MonitorFeed', () => {
  it('forwards synchronously when coalesce is false', () => {
    const source = new FakeSource();
    const target = new CaptureTarget();
    const feed = new MonitorFeed({ source, target, coalesce: false });
    feed.start();
    expect(source.started).toBe(true);
    source.emit([{ id: 'a', severity: 0.5 }]);
    source.emit([{ id: 'b', severity: 0.2 }]);
    expect(target.batches.length).toBe(2);
    feed.stop();
    expect(source.stopped).toBe(true);
  });

  it('coalesces a burst into one deduped batch on the next frame', () => {
    vi.useFakeTimers();
    try {
      const source = new FakeSource();
      const target = new CaptureTarget();
      const feed = new MonitorFeed({ source, target, coalesce: true });
      feed.start();
      source.emit([{ id: 'a', severity: 0.1 }]);
      source.emit([
        { id: 'a', severity: 0.9 },
        { id: 'b', anomaly: 0.5 },
      ]);
      // Nothing is applied until the scheduled frame flush.
      expect(target.batches.length).toBe(0);
      vi.runOnlyPendingTimers();
      expect(target.batches.length).toBe(1);
      const batch = target.batches[0];
      expect(batch.length).toBe(2);
      expect(batch.find((r) => r.id === 'a')?.severity).toBe(0.9);
      feed.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('merges resources across coalesced updates (latest value per resource wins)', () => {
    vi.useFakeTimers();
    try {
      const source = new FakeSource();
      const target = new CaptureTarget();
      const feed = new MonitorFeed({ source, target });
      feed.start();
      source.emit([{ id: 'a', resources: [{ id: 'cpu', value: 0.2 }] }]);
      source.emit([
        {
          id: 'a',
          resources: [
            { id: 'mem', value: 0.4 },
            { id: 'cpu', value: 0.7 },
          ],
        },
      ]);
      vi.runOnlyPendingTimers();
      const a = target.batches[0].find((r) => r.id === 'a');
      expect(a?.resources?.find((x) => x.id === 'cpu')?.value).toBe(0.7);
      expect(a?.resources?.find((x) => x.id === 'mem')?.value).toBe(0.4);
      feed.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('forwards connection state to the callback and exposes it', () => {
    const source = new FakeSource();
    const target = new CaptureTarget();
    const seen: ConnectionState[] = [];
    const feed = new MonitorFeed({ source, target, onState: (s) => seen.push(s) });
    feed.start();
    source.setState('open');
    expect(feed.state).toBe('open');
    expect(seen).toContain('open');
    feed.stop();
  });
});
