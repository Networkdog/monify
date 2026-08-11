import { describe, it, expect } from 'vitest';
import { profileRows } from '../src/shape/profile';
import { validateSpec } from '../src/shape/validate';

interface Row {
  id: string;
  hub: string;
  sub: string;
  cost: number;
  when: string;
  blank: string | null;
}

function rows(): Row[] {
  const out: Row[] = [];
  for (let h = 0; h < 2; h++) {
    for (let s = 0; s < 3; s++) {
      for (let r = 0; r < 4; r++) {
        out.push({
          id: `id-${h}-${s}-${r}`,
          hub: `hub${h}`,
          sub: `sub${h}-${s}`,
          cost: 100 + h * 137.5 + s * 41.25 + r * 7.125,
          when: '2026-08-09T10:00:00Z',
          blank: null,
        });
      }
    }
  }
  return out;
}

const fields = {
  id: (r: Row): unknown => r.id,
  hub: (r: Row): unknown => r.hub,
  sub: (r: Row): unknown => r.sub,
  cost: (r: Row): unknown => r.cost,
  when: (r: Row): unknown => r.when,
  blank: (r: Row): unknown => r.blank,
};

describe('profileRows', () => {
  it('infers field kinds', () => {
    const p = profileRows(rows(), fields);
    const kind = (n: string): string => p.fields.find((f) => f.name === n)?.kind ?? '';
    expect(kind('id')).toBe('identifier');
    expect(kind('hub')).toBe('categorical');
    expect(kind('cost')).toBe('quantitative');
    expect(kind('when')).toBe('constant');
    expect(kind('blank')).toBe('empty');
  });

  it('detects a containment hierarchy by functional dependency', () => {
    const p = profileRows(rows(), fields);
    const best = p.hierarchyCandidates[0];
    expect(best.levels).toEqual(['hub', 'sub']);
    expect(best.strength).toBeCloseTo(1, 6);
  });

  it('does not chain fields that cross-cut each other', () => {
    const crossed = [
      { a: 'x', b: '1' },
      { a: 'x', b: '2' },
      { a: 'y', b: '1' },
      { a: 'y', b: '2' },
    ];
    const p = profileRows(crossed, { a: (r): unknown => r.a, b: (r): unknown => r.b });
    expect(p.hierarchyCandidates.length).toBe(0);
  });

  it('recommends a placement and explains itself', () => {
    const p = profileRows(rows(), fields);
    expect(p.recommendation?.placement).toBe('dense');
    expect(p.recommendation?.layout).toEqual(['hub', 'sub']);
    expect(p.explain()).toContain('Recommended placement');
  });

  it('warns about sparse fields and empty datasets', () => {
    const p = profileRows(rows(), fields);
    expect(p.issues.some((i) => i.code === 'sparse-field' && i.subject === 'blank')).toBe(true);
    const empty = profileRows([], fields);
    expect(empty.issues.some((i) => i.code === 'empty-dataset')).toBe(true);
  });
});

describe('validateSpec', () => {
  it('accepts a well-formed spec', () => {
    const r = validateSpec({ data: rows(), id: (x) => x.id, hierarchy: { hub: (x) => x.hub } });
    expect(r.ok).toBe(true);
    expect(r.errors).toHaveLength(0);
  });

  it('rejects duplicate and blank ids', () => {
    const dup = validateSpec({ data: [{ id: 'a' }, { id: 'a' }, { id: '' }], id: (x) => x.id });
    expect(dup.ok).toBe(false);
    expect(dup.errors.map((e) => e.code).sort()).toEqual(['blank-id', 'duplicate-id']);
  });

  it('warns about non-numeric measures and rejects an empty domain', () => {
    const r = validateSpec({
      data: [{ id: 'a', v: NaN }],
      id: (x) => x.id,
      measures: { v: { value: (x) => x.v }, bad: { value: () => 1, domain: [1, 1] } },
    });
    expect(r.warnings.some((w) => w.code === 'invalid-measure')).toBe(true);
    expect(r.errors.some((e) => e.code === 'invalid-domain')).toBe(true);
  });

  it('warns when no hierarchy is declared', () => {
    const r = validateSpec({ data: [{ id: 'a' }], id: (x) => x.id });
    expect(r.warnings.some((w) => w.code === 'no-hierarchy')).toBe(true);
  });
});
