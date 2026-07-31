import { describe, it, expect } from 'vitest';
import { SimulatedSource, type SimEntity } from '../src/data/simulated-source';

function entities(n: number): SimEntity[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `e${i}`,
    groups: [`hub${i % 2}`, `sub${i % 4}`, `rg${i % 8}`],
    resources: ['cpu', 'mem'],
  }));
}

describe('SimulatedSource', () => {
  it('is deterministic for a fixed seed', () => {
    const a = new SimulatedSource({ entities: entities(40), seed: 7, intervalMs: 1e9 });
    const b = new SimulatedSource({ entities: entities(40), seed: 7, intervalMs: 1e9 });
    a.start();
    b.start();
    const ra = a.tickOnce();
    const rb = b.tickOnce();
    a.stop();
    b.stop();
    expect(ra).toEqual(rb);
    expect(ra.length).toBeGreaterThan(0);
  });

  it('emits severities and resource values within [0,1]', () => {
    const s = new SimulatedSource({ entities: entities(30), seed: 3, intervalMs: 1e9 });
    s.start();
    const recs = s.tickOnce();
    s.stop();
    expect(recs.length).toBeGreaterThan(0);
    for (const r of recs) {
      expect(r.id).toMatch(/^e\d+$/);
      expect(r.severity ?? 0).toBeGreaterThanOrEqual(0);
      expect(r.severity ?? 0).toBeLessThanOrEqual(1);
      for (const ru of r.resources ?? []) {
        expect(ru.value).toBeGreaterThanOrEqual(0);
        expect(ru.value).toBeLessThanOrEqual(1);
      }
    }
  });

  it('delivers batches to subscribers until unsubscribed', () => {
    const s = new SimulatedSource({ entities: entities(20), seed: 9, intervalMs: 1e9 });
    let received = 0;
    const off = s.onData((r) => {
      received += r.length;
    });
    s.start();
    s.tickOnce();
    const afterFirst = received;
    off();
    s.tickOnce();
    s.stop();
    expect(afterFirst).toBeGreaterThan(0);
    expect(received).toBe(afterFirst);
  });

  it('reports connection state through its lifecycle', () => {
    const s = new SimulatedSource({ entities: entities(10), seed: 1, intervalMs: 1e9 });
    const seen: string[] = [];
    s.onState((st) => seen.push(st));
    s.start();
    s.stop();
    expect(seen).toEqual(['open', 'closed']);
  });
});
