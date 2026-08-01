import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { WorkloadStore, sanitizeHealth } from '../src/viz/workload-map/store';
import type { NodeInput } from '../src/viz/workload-map/types';

/** Bucket width of the rollup quantizer — the allowed upward error. */
const BUCKET = 1 / 64;

/** Cast helper for deliberately malformed payloads. */
function hostile(records: unknown[]): NodeInput[] {
  return records as NodeInput[];
}

describe('sanitizeHealth — hostile scalar input', () => {
  it('maps every unusable value to "no signal" instead of throwing', () => {
    for (const bad of [
      undefined,
      null,
      NaN,
      Infinity,
      -Infinity,
      {},
      [],
      '',
      'abc',
      true,
      false,
      Symbol('x'),
      () => 0,
      123n,
    ]) {
      expect(sanitizeHealth(bad)).toBe(-1);
    }
  });

  it('clamps out-of-range numbers into [0, 1]', () => {
    expect(sanitizeHealth(-5)).toBe(0);
    expect(sanitizeHealth(-0.001)).toBe(0);
    expect(sanitizeHealth(1.5)).toBe(1);
    expect(sanitizeHealth(Number.MAX_VALUE)).toBe(1);
    expect(sanitizeHealth(0.42)).toBeCloseTo(0.42, 10);
  });

  it('accepts numeric strings, which real JSON feeds emit', () => {
    expect(sanitizeHealth('0.5')).toBe(0.5);
    expect(sanitizeHealth('2')).toBe(1);
    expect(sanitizeHealth('-1')).toBe(0);
  });
});

describe('WorkloadStore — malformed batches', () => {
  it('skips junk records without losing the good ones', () => {
    const s = new WorkloadStore();
    const res = s.applyBatch(
      hostile([
        null,
        undefined,
        42,
        'nope',
        [],
        { id: '' },
        { id: 123 },
        { noId: true },
        { id: 'good', health: 0.5 },
      ]),
    );
    expect(s.size).toBe(1);
    expect(s.has('good')).toBe(true);
    expect(res.rejected).toBe(8);
    expect(res.applied).toBe(1);
    expect(res.diagnostics.length).toBe(8);
  });

  it('survives an empty batch', () => {
    const s = new WorkloadStore();
    const res = s.applyBatch([]);
    expect(res.applied).toBe(0);
    expect(s.size).toBe(0);
  });

  it('treats chaotic health payloads as unknown rather than poisoning state', () => {
    const s = new WorkloadStore();
    s.applyBatch(
      hostile([
        { id: 'a', health: NaN },
        { id: 'b', health: Infinity },
        { id: 'c', health: null },
        { id: 'd', health: { nested: 1 } },
        { id: 'e', health: -3 },
        { id: 'f', health: 99 },
      ]),
    );
    expect(s.statusOf(s.handleOf('a'))).toBe('unknown');
    expect(s.statusOf(s.handleOf('b'))).toBe('unknown');
    expect(s.statusOf(s.handleOf('c'))).toBe('unknown');
    expect(s.statusOf(s.handleOf('d'))).toBe('unknown');
    expect(s.severityOf(s.handleOf('e'))).toBe(0);
    expect(s.severityOf(s.handleOf('f'))).toBe(1);
  });

  it('resolves duplicate ids inside one batch as last-write-wins', () => {
    const s = new WorkloadStore();
    s.applyBatch([
      { id: 'x', health: 0.1 },
      { id: 'x', health: 0.9 },
      { id: 'x', health: 0.5 },
    ]);
    expect(s.size).toBe(1);
    expect(s.severityOf(s.handleOf('x'))).toBeCloseTo(0.5, 6);
  });

  it('keeps handles stable across updates', () => {
    const s = new WorkloadStore();
    s.upsert({ id: 'x', health: 0.1 });
    const h = s.handleOf('x');
    s.upsert({ id: 'x', health: 0.8 });
    s.upsert({ id: 'x', kind: 'vm' });
    expect(s.handleOf('x')).toBe(h);
    expect(s.handleOf('missing')).toBe(-1);
  });
});

describe('WorkloadStore — hierarchy edge cases', () => {
  it('accepts a child that arrives before its parent', () => {
    const s = new WorkloadStore();
    s.upsert({ id: 'child', parent: 'later', health: 0.9 });
    expect(s.has('later')).toBe(true);
    expect(s.statusOf(s.handleOf('later'))).toBe('critical');

    s.upsert({ id: 'later', kind: 'workload' });
    expect(s.kindOf(s.handleOf('later'))).toBe('workload');
    expect(s.childrenOf(s.handleOf('later'))).toHaveLength(1);
  });

  it('rejects a node parenting itself', () => {
    const s = new WorkloadStore();
    const res = s.upsert({ id: 'a', parent: 'a' });
    expect(res.diagnostics.some((d) => d.code === 'self-parent')).toBe(true);
    expect(s.parentOf(s.handleOf('a'))).toBe(-1);
  });

  it('rejects a two-node cycle', () => {
    const s = new WorkloadStore();
    s.upsert({ id: 'a', parent: 'b' });
    const res = s.upsert({ id: 'b', parent: 'a' });
    expect(res.diagnostics.some((d) => d.code === 'cycle-rejected')).toBe(true);
    expect(s.parentOf(s.handleOf('b'))).toBe(-1);
  });

  it('rejects a deep cycle', () => {
    const s = new WorkloadStore();
    s.applyBatch([
      { id: 'a' },
      { id: 'b', parent: 'a' },
      { id: 'c', parent: 'b' },
      { id: 'd', parent: 'c' },
    ]);
    const res = s.upsert({ id: 'a', parent: 'd' });
    expect(res.diagnostics.some((d) => d.code === 'cycle-rejected')).toBe(true);
    expect(s.parentOf(s.handleOf('a'))).toBe(-1);
  });

  it('moves a node between parents and fixes both aggregates', () => {
    const s = new WorkloadStore();
    s.applyBatch([
      { id: 'p1' },
      { id: 'p2' },
      { id: 'c', parent: 'p1', health: 0.9 },
    ]);
    expect(s.statusOf(s.handleOf('p1'))).toBe('critical');
    expect(s.statusOf(s.handleOf('p2'))).toBe('unknown');

    s.upsert({ id: 'c', parent: 'p2' });
    expect(s.statusOf(s.handleOf('p1'))).toBe('unknown');
    expect(s.statusOf(s.handleOf('p2'))).toBe('critical');
    expect(s.rollupOf(s.handleOf('p1')).children).toBe(0);
    expect(s.rollupOf(s.handleOf('p2')).children).toBe(1);
  });

  it('ignores a non-string parent field', () => {
    const s = new WorkloadStore();
    const res = s.applyBatch(hostile([{ id: 'a', parent: 99 }]));
    expect(res.diagnostics.some((d) => d.code === 'invalid-record')).toBe(true);
    expect(s.parentOf(s.handleOf('a'))).toBe(-1);
  });
});

describe('WorkloadStore — rollups', () => {
  it('reports the worst child and exact band counts', () => {
    const s = new WorkloadStore();
    s.applyBatch([
      { id: 'w' },
      { id: 'r1', parent: 'w', health: 0.1 },
      { id: 'r2', parent: 'w', health: 0.5 },
      { id: 'r3', parent: 'w', health: 0.9 },
      { id: 'r4', parent: 'w' },
    ]);
    const roll = s.rollupOf(s.handleOf('w'));
    expect(roll.children).toBe(4);
    expect(roll.healthy).toBe(1);
    expect(roll.warning).toBe(1);
    expect(roll.critical).toBe(1);
    expect(roll.unknown).toBe(1);
    expect(roll.worst).toBeGreaterThanOrEqual(0.9);
    expect(roll.worst).toBeLessThanOrEqual(0.9 + BUCKET);
    expect(s.statusOf(s.handleOf('w'))).toBe('critical');
  });

  // The case a running max cannot handle: severity going *down* must release
  // the old bucket, otherwise a resolved incident stays red forever.
  it('recovers when the worst child improves', () => {
    const s = new WorkloadStore();
    s.applyBatch([
      { id: 'w' },
      { id: 'r1', parent: 'w', health: 0.95 },
      { id: 'r2', parent: 'w', health: 0.2 },
    ]);
    expect(s.statusOf(s.handleOf('w'))).toBe('critical');

    s.setHealth('r1', 0.1);
    expect(s.statusOf(s.handleOf('w'))).toBe('healthy');
    expect(s.rollupOf(s.handleOf('w')).worst).toBeLessThanOrEqual(0.2 + BUCKET);
  });

  it('propagates through multiple levels without inflating severity', () => {
    const s = new WorkloadStore();
    const records: NodeInput[] = [{ id: 'L0' }];
    for (let i = 1; i <= 8; i++) records.push({ id: `L${i}`, parent: `L${i - 1}` });
    records.push({ id: 'leaf', parent: 'L8', health: 0.5 });
    s.applyBatch(records);

    // Every ancestor must report the same band, and a value within one bucket
    // of the leaf's — no per-level drift.
    for (let i = 0; i <= 8; i++) {
      const h = s.handleOf(`L${i}`);
      expect(s.statusOf(h)).toBe('warning');
      expect(s.severityOf(h)).toBeGreaterThanOrEqual(0.5);
      expect(s.severityOf(h)).toBeLessThanOrEqual(0.5 + BUCKET);
    }
  });

  it('does not let a healthy leaf round up into a critical parent', () => {
    const s = new WorkloadStore();
    // 0.7461 sits just under the 0.75 critical threshold but inside the bucket
    // whose upper bound is exactly 0.75.
    s.applyBatch([
      { id: 'w' },
      { id: 'r', parent: 'w', health: 0.7461 },
    ]);
    expect(s.statusOf(s.handleOf('r'))).toBe('warning');
    expect(s.statusOf(s.handleOf('w'))).toBe('warning');
  });

  it('treats unknown children as absent from the worst calculation', () => {
    const s = new WorkloadStore();
    s.applyBatch([
      { id: 'w' },
      { id: 'r1', parent: 'w' },
      { id: 'r2', parent: 'w' },
    ]);
    expect(s.statusOf(s.handleOf('w'))).toBe('unknown');
    expect(s.rollupOf(s.handleOf('w')).unknown).toBe(2);
    expect(s.rollupOf(s.handleOf('w')).mean).toBe(-1);
  });

  it('keeps a parent critical while any child is critical', () => {
    const s = new WorkloadStore();
    const records: NodeInput[] = [{ id: 'w' }];
    for (let i = 0; i < 50; i++) records.push({ id: `r${i}`, parent: 'w', health: 0.9 });
    s.applyBatch(records);
    for (let i = 0; i < 49; i++) {
      s.setHealth(`r${i}`, 0);
      expect(s.statusOf(s.handleOf('w'))).toBe('critical');
    }
    s.setHealth('r49', 0);
    expect(s.statusOf(s.handleOf('w'))).toBe('healthy');
  });
});

describe('WorkloadStore — removal and slot reuse', () => {
  it('cascades removal through the whole subtree', () => {
    const s = new WorkloadStore();
    s.applyBatch([
      { id: 'w' },
      { id: 'a', parent: 'w' },
      { id: 'b', parent: 'a' },
      { id: 'c', parent: 'b' },
      { id: 'other' },
    ]);
    expect(s.remove('w')).toBe(4);
    expect(s.size).toBe(1);
    for (const id of ['w', 'a', 'b', 'c']) expect(s.has(id)).toBe(false);
    expect(s.has('other')).toBe(true);
  });

  it('updates the parent aggregate when a child is removed', () => {
    const s = new WorkloadStore();
    s.applyBatch([
      { id: 'w' },
      { id: 'r1', parent: 'w', health: 0.95 },
      { id: 'r2', parent: 'w', health: 0.1 },
    ]);
    expect(s.statusOf(s.handleOf('w'))).toBe('critical');
    s.remove('r1');
    expect(s.statusOf(s.handleOf('w'))).toBe('healthy');
    expect(s.rollupOf(s.handleOf('w')).children).toBe(1);
  });

  it('returns 0 for an unknown id without throwing', () => {
    const s = new WorkloadStore();
    expect(s.remove('ghost')).toBe(0);
  });

  it('throws for unknown ids only when configured to', () => {
    const strict = new WorkloadStore({ unknownIdPolicy: 'throw' });
    expect(() => strict.setHealth('ghost', 0.5)).toThrow(/unknown node id/);
    const lax = new WorkloadStore();
    expect(lax.setHealth('ghost', 0.5)).toBe(false);
  });

  it('does not leak state from a recycled slot', () => {
    const s = new WorkloadStore();
    s.applyBatch([
      { id: 'old', kind: 'vm', health: 0.99 },
      { id: 'oldChild', parent: 'old', health: 0.99 },
    ]);
    const recycled = s.handleOf('old');
    s.remove('old');

    s.upsert({ id: 'fresh' });
    // The fresh node lands on a recycled slot; it must not inherit health,
    // children, or the previous id.
    const h = s.handleOf('fresh');
    expect([recycled, s.handleOf('oldChild')]).toContain(h);
    expect(s.severityOf(h)).toBe(-1);
    expect(s.statusOf(h)).toBe('unknown');
    expect(s.childrenOf(h)).toHaveLength(0);
    expect(s.idOf(h)).toBe('fresh');
    expect(s.has('old')).toBe(false);
  });

  it('removes a deep chain iteratively without exhausting the stack', () => {
    const s = new WorkloadStore({ maxDepth: 5000 });
    const records: NodeInput[] = [{ id: 'n0' }];
    for (let i = 1; i < 2000; i++) records.push({ id: `n${i}`, parent: `n${i - 1}` });
    s.applyBatch(records);
    expect(s.remove('n0')).toBe(2000);
    expect(s.size).toBe(0);
  });

  it('reports dead handles as unknown rather than throwing', () => {
    const s = new WorkloadStore();
    s.upsert({ id: 'a', health: 0.9 });
    const h = s.handleOf('a');
    s.remove('a');
    expect(s.severityOf(h)).toBe(-1);
    expect(s.statusOf(h)).toBe('unknown');
    expect(s.idOf(h)).toBeUndefined();
    expect(s.childrenOf(h)).toEqual([]);
    expect(s.rollupOf(h).children).toBe(0);
    expect(s.severityOf(-1)).toBe(-1);
    expect(s.severityOf(999999)).toBe(-1);
  });
});

describe('WorkloadStore — dirty tracking', () => {
  it('deduplicates repeated updates to the same node', () => {
    const s = new WorkloadStore();
    s.upsert({ id: 'a', health: 0.1 });
    s.drainDirty();
    for (let i = 0; i < 100; i++) s.setHealth('a', i / 100);
    expect(s.dirtySize).toBe(1);
    expect(s.drainDirty()).toHaveLength(1);
    expect(s.dirtySize).toBe(0);
  });

  it('marks ancestors whose rollup changed', () => {
    const s = new WorkloadStore();
    s.applyBatch([{ id: 'w' }, { id: 'r', parent: 'w', health: 0.1 }]);
    s.drainDirty();
    s.setHealth('r', 0.95);
    const dirty = Array.from(s.drainDirty());
    expect(dirty).toContain(s.handleOf('r'));
    expect(dirty).toContain(s.handleOf('w'));
  });

  it('does not mark anything when a write changes nothing', () => {
    const s = new WorkloadStore();
    s.upsert({ id: 'a', health: 0.5 });
    s.drainDirty();
    s.setHealth('a', 0.5);
    expect(s.dirtySize).toBe(0);
  });

  it('degrades to a full-redraw signal past the dirty budget', () => {
    const s = new WorkloadStore({ dirtyBudget: 16 });
    const records: NodeInput[] = [];
    for (let i = 0; i < 100; i++) records.push({ id: `n${i}`, health: 0 });
    s.applyBatch(records);
    s.drainDirty();
    expect(s.dirtyOverflowed).toBe(false);

    for (let i = 0; i < 100; i++) s.setHealth(`n${i}`, 0.9);
    expect(s.dirtyOverflowed).toBe(true);
    expect(s.dirtySize).toBe(0);
    // State itself must still be correct after the queue gives up.
    expect(s.statusOf(s.handleOf('n99'))).toBe('critical');

    s.drainDirty();
    expect(s.dirtyOverflowed).toBe(false);
  });
});

describe('WorkloadStore — bulk streaming path', () => {
  it('applies severities addressed by handle with no allocation', () => {
    const s = new WorkloadStore();
    const records: NodeInput[] = [{ id: 'w' }];
    for (let i = 0; i < 100; i++) records.push({ id: `r${i}`, parent: 'w', health: 0 });
    s.applyBatch(records);

    const handles = new Int32Array(100);
    const values = new Float32Array(100);
    for (let i = 0; i < 100; i++) {
      handles[i] = s.handleOf(`r${i}`);
      values[i] = i / 100;
    }
    expect(s.applyHealthBulk(handles, values)).toBe(99);
    expect(s.statusOf(s.handleOf('w'))).toBe('critical');
  });

  it('skips dead, negative and out-of-range handles', () => {
    const s = new WorkloadStore();
    s.upsert({ id: 'a', health: 0 });
    const dead = s.handleOf('a');
    s.remove('a');
    const handles = new Int32Array([dead, -1, 1 << 20]);
    const values = new Float32Array([0.9, 0.9, 0.9]);
    expect(s.applyHealthBulk(handles, values)).toBe(0);
  });

  it('tolerates mismatched array lengths', () => {
    const s = new WorkloadStore();
    s.upsert({ id: 'a', health: 0 });
    const handles = new Int32Array([s.handleOf('a')]);
    expect(s.applyHealthBulk(handles, new Float32Array(0))).toBe(0);
    expect(s.applyHealthBulk(handles, new Float32Array([0.5]), 999)).toBe(1);
  });
});

describe('WorkloadStore — staleness', () => {
  it('drops signals that stopped arriving', () => {
    const s = new WorkloadStore();
    s.applyBatch([
      { id: 'w' },
      { id: 'fresh', parent: 'w', health: 0.9, ts: 10_000 },
      { id: 'stale', parent: 'w', health: 0.9, ts: 1_000 },
    ]);
    expect(s.expireStale(5_000, 10_000)).toBe(1);
    expect(s.statusOf(s.handleOf('stale'))).toBe('unknown');
    expect(s.statusOf(s.handleOf('fresh'))).toBe('critical');
  });

  it('ignores nonsensical windows', () => {
    const s = new WorkloadStore();
    s.upsert({ id: 'a', health: 0.5 });
    expect(s.expireStale(NaN)).toBe(0);
    expect(s.expireStale(-1)).toBe(0);
  });
});

// ── Property-based verification against a naive oracle ──────────────────────

interface OracleNode {
  id: string;
  parent: string | null;
  health: number;
}

/** Worst severity in a subtree, computed the slow obvious way. */
function oracleWorst(id: string, nodes: Map<string, OracleNode>, kids: Map<string, string[]>): number {
  const self = nodes.get(id) as OracleNode;
  let worst = self.health;
  for (const c of kids.get(id) ?? []) {
    const w = oracleWorst(c, nodes, kids);
    if (w > worst) worst = w;
  }
  return worst;
}

function oracleStatus(v: number, warn = 0.4, crit = 0.75): string {
  if (v < 0) return 'unknown';
  if (v >= crit) return 'critical';
  if (v >= warn) return 'warning';
  return 'healthy';
}

describe('WorkloadStore — property tests', () => {
  it('matches a naive rollup oracle on random trees', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            parentPick: fc.integer({ min: 0, max: 1000 }),
            attach: fc.boolean(),
            // -1 encodes "no signal"; 0..100 becomes a severity.
            health: fc.integer({ min: -1, max: 100 }),
          }),
          { minLength: 1, maxLength: 80 },
        ),
        (specs) => {
          const store = new WorkloadStore({ capacity: 8 });
          const nodes = new Map<string, OracleNode>();
          const kids = new Map<string, string[]>();
          const records: NodeInput[] = [];

          specs.forEach((spec, i) => {
            const id = `n${i}`;
            // Parent must be an earlier node, which makes cycles impossible.
            const parent = i > 0 && spec.attach ? `n${spec.parentPick % i}` : null;
            const health = spec.health < 0 ? -1 : spec.health / 100;
            nodes.set(id, { id, parent, health });
            if (parent !== null) {
              const list = kids.get(parent) ?? [];
              list.push(id);
              kids.set(parent, list);
            }
            const rec: NodeInput = { id };
            if (parent !== null) rec.parent = parent;
            if (health >= 0) rec.health = health;
            records.push(rec);
          });

          store.applyBatch(records);
          expect(store.size).toBe(specs.length);

          for (const id of nodes.keys()) {
            const h = store.handleOf(id);
            const worst = oracleWorst(id, nodes, kids);

            expect(store.statusOf(h)).toBe(oracleStatus(worst));

            const got = store.severityOf(h);
            if (worst < 0) {
              expect(got).toBe(-1);
            } else {
              // Never under-reports, never overshoots by more than one bucket.
              expect(got).toBeGreaterThanOrEqual(worst - 1e-6);
              expect(got).toBeLessThanOrEqual(worst + BUCKET + 1e-6);
            }
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('keeps rollups correct while severities move up and down', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            leaf: fc.integer({ min: 0, max: 11 }),
            health: fc.integer({ min: -1, max: 100 }),
          }),
          { minLength: 1, maxLength: 120 },
        ),
        (updates) => {
          const store = new WorkloadStore();
          const records: NodeInput[] = [{ id: 'root' }];
          for (let w = 0; w < 3; w++) {
            records.push({ id: `w${w}`, parent: 'root' });
            for (let r = 0; r < 4; r++) {
              records.push({ id: `w${w}r${r}`, parent: `w${w}` });
            }
          }
          store.applyBatch(records);

          const truth = new Map<string, number>();
          for (const u of updates) {
            const id = `w${Math.floor(u.leaf / 4)}r${u.leaf % 4}`;
            const v = u.health < 0 ? -1 : u.health / 100;
            truth.set(id, v);
            store.setHealth(id, v < 0 ? NaN : v);
          }

          let globalWorst = -1;
          for (let w = 0; w < 3; w++) {
            let groupWorst = -1;
            for (let r = 0; r < 4; r++) {
              const v = truth.get(`w${w}r${r}`) ?? -1;
              if (v > groupWorst) groupWorst = v;
            }
            expect(store.statusOf(store.handleOf(`w${w}`))).toBe(oracleStatus(groupWorst));
            if (groupWorst > globalWorst) globalWorst = groupWorst;
          }
          expect(store.statusOf(store.handleOf('root'))).toBe(oracleStatus(globalWorst));
        },
      ),
      { numRuns: 200 },
    );
  });

  it('never throws and never corrupts its invariants under random abuse', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            fc.record({ op: fc.constant('upsert' as const), id: fc.integer({ min: 0, max: 15 }) }),
            fc.record({ op: fc.constant('child' as const), id: fc.integer({ min: 0, max: 15 }) }),
            fc.record({ op: fc.constant('remove' as const), id: fc.integer({ min: 0, max: 15 }) }),
            fc.record({ op: fc.constant('health' as const), id: fc.integer({ min: 0, max: 15 }) }),
          ),
          { maxLength: 200 },
        ),
        (ops) => {
          const store = new WorkloadStore({ capacity: 8 });
          for (const o of ops) {
            const id = `n${o.id}`;
            if (o.op === 'upsert') store.upsert({ id, health: (o.id % 11) / 10 });
            else if (o.op === 'child') store.upsert({ id, parent: `n${(o.id + 1) % 16}` });
            else if (o.op === 'remove') store.remove(id);
            else store.setHealth(id, (o.id % 7) / 6);
          }

          expect(store.size).toBeGreaterThanOrEqual(0);
          expect(store.size).toBeLessThanOrEqual(store.capacity);

          // Every live handle round-trips through its id, and every parent
          // link points at a live node.
          for (const h of store.handles()) {
            const id = store.idOf(h);
            expect(id).toBeDefined();
            expect(store.handleOf(id as string)).toBe(h);
            const p = store.parentOf(h);
            if (p !== -1) expect(store.idOf(p)).toBeDefined();
          }

          for (const h of store.drainDirty()) {
            expect(h).toBeLessThan(store.capacity);
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});

// ── Adaptive rebuild path ───────────────────────────────────────────────────
//
// Above the crossover, `applyHealthBulk` writes severities without touching
// aggregates and then recomputes every rollup in one pass. That path is only
// safe if it is indistinguishable from incremental maintenance, so every test
// here drives the same input through both and compares observable state.

/** Everything a consumer can see about a node. */
function observable(s: WorkloadStore, ids: readonly string[]): unknown[] {
  return ids.map((id) => {
    const h = s.handleOf(id);
    const r = s.rollupOf(h);
    return {
      id,
      severity: s.severityOf(h),
      status: s.statusOf(h),
      worst: r.worst,
      mean: r.mean,
      healthy: r.healthy,
      warning: r.warning,
      critical: r.critical,
      unknown: r.unknown,
      children: r.children,
    };
  });
}

/** Two stores differing only in which rollup strategy they use. */
function twinStores(opts: { capacity?: number } = {}): [WorkloadStore, WorkloadStore] {
  return [
    new WorkloadStore({ ...opts, rebuildCrossover: 0 }),
    new WorkloadStore({ ...opts, rebuildCrossover: 1e-9 }),
  ];
}

function estateRecords(clusters: number, workloads: number, resources: number): {
  records: NodeInput[];
  leaves: string[];
  all: string[];
} {
  const records: NodeInput[] = [];
  const leaves: string[] = [];
  const all: string[] = [];
  for (let c = 0; c < clusters; c++) {
    records.push({ id: `c${c}`, kind: 'cluster' });
    all.push(`c${c}`);
  }
  for (let w = 0; w < workloads; w++) {
    records.push({ id: `w${w}`, kind: 'workload', parent: `c${w % clusters}` });
    all.push(`w${w}`);
  }
  for (let r = 0; r < resources; r++) {
    const id = `r${r}`;
    records.push({ id, kind: 'resource', parent: `w${r % workloads}`, health: 0 });
    leaves.push(id);
    all.push(id);
  }
  return { records, leaves, all };
}

describe('WorkloadStore — adaptive rebuild', () => {
  it('is indistinguishable from incremental maintenance', () => {
    const [inc, reb] = twinStores();
    const { records, leaves, all } = estateRecords(3, 12, 240);
    inc.applyBatch(records);
    reb.applyBatch(records);

    const handlesInc = new Int32Array(leaves.length);
    const handlesReb = new Int32Array(leaves.length);
    const values = new Float32Array(leaves.length);
    leaves.forEach((id, i) => {
      handlesInc[i] = inc.handleOf(id);
      handlesReb[i] = reb.handleOf(id);
      values[i] = (i % 100) / 100;
    });

    expect(inc.applyHealthBulk(handlesInc, values)).toBe(reb.applyHealthBulk(handlesReb, values));
    expect(observable(reb, all)).toEqual(observable(inc, all));
  });

  it('agrees after severities fall again', () => {
    const [inc, reb] = twinStores();
    const { records, leaves, all } = estateRecords(2, 8, 160);
    inc.applyBatch(records);
    reb.applyBatch(records);

    const hi = new Int32Array(leaves.length);
    const hr = new Int32Array(leaves.length);
    leaves.forEach((id, i) => {
      hi[i] = inc.handleOf(id);
      hr[i] = reb.handleOf(id);
    });

    const spike = new Float32Array(leaves.length).fill(0.95);
    inc.applyHealthBulk(hi, spike);
    reb.applyHealthBulk(hr, spike);
    expect(observable(reb, all)).toEqual(observable(inc, all));

    const recover = new Float32Array(leaves.length).fill(0.05);
    inc.applyHealthBulk(hi, recover);
    reb.applyHealthBulk(hr, recover);
    expect(observable(reb, all)).toEqual(observable(inc, all));
    expect(reb.statusOf(reb.handleOf('c0'))).toBe('healthy');
  });

  it('agrees when the handle space is full of holes', () => {
    const [inc, reb] = twinStores({ capacity: 8 });
    const { records, all } = estateRecords(2, 6, 60);
    inc.applyBatch(records);
    reb.applyBatch(records);

    // Free-list holes: the rebuild scans raw slots, so it must skip dead ones.
    const removed = new Set<string>();
    for (let r = 0; r < 60; r += 3) {
      inc.remove(`r${r}`);
      reb.remove(`r${r}`);
      removed.add(`r${r}`);
    }
    for (let w = 1; w < 6; w += 2) {
      inc.remove(`w${w}`);
      reb.remove(`w${w}`);
      removed.add(`w${w}`);
    }
    const alive = all.filter((id) => !removed.has(id) && inc.has(id));

    const hi: number[] = [];
    const hr: number[] = [];
    for (const id of alive) {
      if (inc.kindOf(inc.handleOf(id)) !== 'resource') continue;
      hi.push(inc.handleOf(id));
      hr.push(reb.handleOf(id));
    }
    const values = new Float32Array(hi.map((_, i) => ((i * 7) % 100) / 100));
    inc.applyHealthBulk(new Int32Array(hi), values);
    reb.applyHealthBulk(new Int32Array(hr), values);

    expect(reb.size).toBe(inc.size);
    expect(observable(reb, alive)).toEqual(observable(inc, alive));
  });

  it('agrees on estates with placeholders and orphan roots', () => {
    const [inc, reb] = twinStores();
    const records: NodeInput[] = [
      { id: 'a', parent: 'ghost', health: 0.9 },   // parent arrives later
      { id: 'b', parent: 'ghost', health: 0.1 },
      { id: 'lonely', health: 0.5 },               // root with no children
      { id: 'emptyParent' },
    ];
    inc.applyBatch(records);
    reb.applyBatch(records);
    const ids = ['a', 'b', 'ghost', 'lonely', 'emptyParent'];

    const hi = new Int32Array([inc.handleOf('a'), inc.handleOf('b'), inc.handleOf('lonely')]);
    const hr = new Int32Array([reb.handleOf('a'), reb.handleOf('b'), reb.handleOf('lonely')]);
    const values = new Float32Array([0.2, 0.8, 0.99]);
    inc.applyHealthBulk(hi, values);
    reb.applyHealthBulk(hr, values);

    expect(observable(reb, ids)).toEqual(observable(inc, ids));
    expect(reb.statusOf(reb.handleOf('ghost'))).toBe('critical');
  });

  it('agrees on deep chains', () => {
    const [inc, reb] = twinStores();
    const records: NodeInput[] = [{ id: 'n0' }];
    const ids = ['n0'];
    for (let i = 1; i < 40; i++) {
      records.push({ id: `n${i}`, parent: `n${i - 1}` });
      ids.push(`n${i}`);
    }
    inc.applyBatch(records);
    reb.applyBatch(records);

    const hi = new Int32Array([inc.handleOf('n39')]);
    const hr = new Int32Array([reb.handleOf('n39')]);
    const values = new Float32Array([0.8]);
    inc.applyHealthBulk(hi, values);
    reb.applyHealthBulk(hr, values);

    expect(observable(reb, ids)).toEqual(observable(inc, ids));
    expect(reb.statusOf(reb.handleOf('n0'))).toBe('critical');
  });

  it('tolerates dead and out-of-range handles in a saturated batch', () => {
    const reb = new WorkloadStore({ rebuildCrossover: 1e-9 });
    reb.applyBatch([{ id: 'w' }, { id: 'r', parent: 'w', health: 0 }]);
    const dead = reb.handleOf('r');
    reb.remove('r');
    const handles = new Int32Array([dead, -1, 1 << 20, reb.handleOf('w')]);
    const values = new Float32Array([0.9, 0.9, 0.9, 0.6]);
    expect(reb.applyHealthBulk(handles, values)).toBe(1);
    expect(reb.statusOf(reb.handleOf('w'))).toBe('warning');
  });

  it('matches incremental maintenance on random trees and updates', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            parentPick: fc.integer({ min: 0, max: 1000 }),
            attach: fc.boolean(),
            health: fc.integer({ min: -1, max: 100 }),
          }),
          { minLength: 1, maxLength: 60 },
        ),
        fc.array(
          fc.record({
            target: fc.integer({ min: 0, max: 1000 }),
            value: fc.integer({ min: -20, max: 120 }),
          }),
          { minLength: 1, maxLength: 60 },
        ),
        (specs, updates) => {
          const [inc, reb] = twinStores({ capacity: 8 });
          const records: NodeInput[] = [];
          const ids: string[] = [];

          specs.forEach((spec, i) => {
            const id = `n${i}`;
            ids.push(id);
            const rec: NodeInput = { id };
            if (i > 0 && spec.attach) rec.parent = `n${spec.parentPick % i}`;
            if (spec.health >= 0) rec.health = spec.health / 100;
            records.push(rec);
          });
          inc.applyBatch(records);
          reb.applyBatch(records);

          const n = updates.length;
          const hi = new Int32Array(n);
          const hr = new Int32Array(n);
          const values = new Float32Array(n);
          updates.forEach((u, i) => {
            const id = ids[u.target % ids.length];
            hi[i] = inc.handleOf(id);
            hr[i] = reb.handleOf(id);
            // Deliberately includes out-of-range values so both paths clamp.
            values[i] = u.value / 100;
          });

          expect(reb.applyHealthBulk(hr, values)).toBe(inc.applyHealthBulk(hi, values));
          expect(observable(reb, ids)).toEqual(observable(inc, ids));
        },
      ),
      { numRuns: 250 },
    );
  });
});
