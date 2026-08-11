import { describe, it, expect } from 'vitest';
import { defineDataset } from '../src/shape/dataset';
import { NEUTRAL_TINT, buildCategoryScale, categoryColor } from '../src/shape/encode';
import { categorical } from '../src/color';

interface Res {
  id: string;
  hub: string;
  sub: string;
  rg: string;
  type: string;
  severity: number;
  cost: number;
}

function estate(): Res[] {
  const rows: Res[] = [];
  for (let h = 0; h < 3; h++) {
    for (let s = 0; s < 4; s++) {
      for (let r = 0; r < 5; r++) {
        rows.push({
          id: `r-${h}-${s}-${r}`,
          hub: `hub${h}`,
          sub: `sub${h}-${s}`,
          rg: `rg${h}-${s}-${r % 2}`,
          type: r % 2 === 0 ? 'VM' : 'SQL',
          severity: (h * 20 + s * 5 + r) / 100,
          cost: 100 + r * 10,
        });
      }
    }
  }
  return rows;
}

function makeDataset(rows = estate()) {
  return defineDataset<Res>(
    {
      data: rows,
      id: (r) => r.id,
      hierarchy: { hub: (r) => r.hub, sub: (r) => r.sub, rg: (r) => r.rg },
      measures: {
        severity: { value: (r) => r.severity, agg: 'worst', domain: [0, 1] },
        cost: { value: (r) => r.cost, agg: 'sum' },
      },
      dimensions: { type: { of: (r) => r.type, label: 'Resource type' } },
    },
    { validate: false },
  );
}

describe('Dataset', () => {
  it('exposes size, levels, and a clean validation report', () => {
    const ds = makeDataset();
    expect(ds.size).toBe(60);
    expect(ds.levelNames).toEqual(['hub', 'sub', 'rg']);
    expect(ds.validation.ok).toBe(true);
  });

  it('rolls a measure up the hierarchy', () => {
    const ds = makeDataset();
    const worst = ds.rollup('severity');
    expect(worst.get('hub0')).toBeCloseTo(0.19, 6);
    expect(ds.total('cost', 'sum')).toBe(estate().reduce((a, r) => a + r.cost, 0));
  });

  it('builds a legend ordered by descending count with shares summing to 1', () => {
    const ds = makeDataset();
    const legend = ds.legend('type');
    expect(legend.map((e) => e.key).sort()).toEqual(['SQL', 'VM']);
    expect(legend[0].count).toBeGreaterThanOrEqual(legend[1].count);
    expect(legend.reduce((a, e) => a + e.share, 0)).toBeCloseTo(1, 6);
  });

  it('compiles HexGrid cells carrying id, path, severity, and tint', () => {
    const ds = makeDataset();
    const out = ds.toHexGrid({
      layout: ['hub', 'sub', 'rg'],
      color: { by: 'severity', scale: 'rdylgn', reverse: true },
      label: 'type',
      tooltip: ['hub', 'sub', 'type'],
    });
    expect(out.workloads.length).toBe(60);
    const w = out.workloads[0];
    expect(w.id).toBe('r-0-0-0');
    expect(w.groupPath).toEqual(['hub0', 'sub0-0', 'rg0-0-0']);
    expect(w.criticality).toBeCloseTo(0, 6);
    expect(w.label).toBe('VM');
    expect(w.tooltip?.length).toBe(3);
    expect(w.tint?.length).toBe(4);
  });

  it('emits one zoom layer per layout level, coarse to fine, with worst-case values', () => {
    const ds = makeDataset();
    const layers = ds.layers({ color: { by: 'severity' } }, { cellZoom: 12 });
    expect(layers.map((l) => l.level)).toEqual(['hub', 'sub', 'rg']);
    expect(layers[0].groups.length).toBe(3);
    expect(layers[1].groups.length).toBe(12);
    expect(layers[0].minZoom).toBe(0);
    expect(layers[layers.length - 1].maxZoom).toBe(12);
    // hub0's worst severity is its highest member severity.
    expect(layers[0].groups[0].value).toBeCloseTo(0.19, 6);
  });

  it('restricts layout to the requested levels', () => {
    const ds = makeDataset();
    const out = ds.toHexGrid({ layout: ['hub', 'sub'] });
    expect(out.workloads[0].groupPath).toEqual(['hub0', 'sub0-0']);
  });

  it('compiles a TreeMap whose branch values sum their leaves', () => {
    const ds = makeDataset();
    const root = ds.toTreeMap({ layout: ['hub', 'sub'], size: { by: 'cost' } });
    const total = estate().reduce((a, r) => a + r.cost, 0);
    expect(root.value).toBe(total);
    expect(root.children?.length).toBe(3);
    const hub0 = root.children?.[0];
    expect(hub0?.children?.length).toBe(4);
  });

  it('is deterministic: the same rows compile to identical cells', () => {
    const rows = estate();
    const a = defineDataset<Res>({ data: rows, id: (r) => r.id, hierarchy: { hub: (r) => r.hub } }, { validate: false });
    const b = defineDataset<Res>({ data: rows, id: (r) => r.id, hierarchy: { hub: (r) => r.hub } }, { validate: false });
    expect(JSON.stringify(a.toHexGrid())).toBe(JSON.stringify(b.toHexGrid()));
  });

  it('maps central weights by dimension', () => {
    const ds = makeDataset();
    const out = ds.toHexGrid({ central: { by: 'type', weights: { VM: 0.1, SQL: 0.9 } } });
    const sql = out.workloads.find((w) => w.id === 'r-0-0-1');
    expect(sql?.central).toBeCloseTo(0.9, 6);
  });

  it('carries relational channels through to the cells', () => {
    const ds = makeDataset();
    const out = ds.toHexGrid(
      {
        status: { by: 'severity' },
        links: (r) => [`r-${r.hub.slice(3)}-0-0`],
        affinity: ['type'],
        resources: (r) => [{ id: 'cpu', value: r.severity }],
        monitored: (r) => r.type !== 'SQL',
      },
      { placement: 'relational', moats: [2, 1], affinityWeights: [1.2, 0.6] },
    );
    expect(out.placement).toBe('relational');
    expect(out.moats).toEqual([2, 1]);
    const vm = out.workloads.find((w) => w.id === 'r-0-0-0');
    expect(vm?.deps).toEqual(['r-0-0-0']);
    expect(vm?.affinity).toEqual(['VM']);
    expect(vm?.resources?.[0]?.id).toBe('cpu');
    expect(vm?.monitored).toBe(true);
    expect(out.workloads.find((w) => w.id === 'r-0-0-1')?.monitored).toBe(false);
  });

  it('drives criticality from status independently of a categorical color', () => {
    const ds = makeDataset();
    const out = ds.toHexGrid({
      status: { by: 'severity' },
      color: { by: 'type', type: 'category' },
    });
    const last = out.workloads[out.workloads.length - 1];
    expect(last.criticality).toBeGreaterThan(0);
    expect(last.tint).toBeDefined();
  });
});

describe('category scale', () => {
  it('hands the curated swatches out biggest category first', () => {
    const aurora = categorical('aurora');
    const scale = buildCategoryScale(['a', 'a', 'a', 'b', 'b', 'c']);
    expect(scale.keys).toEqual(['a', 'b', 'c']);
    expect(scale.colorOf('a')).toEqual(aurora(0));
    expect(scale.colorOf('b')).toEqual(aurora(1));
  });

  it('generates hues once a dimension outgrows the palette', () => {
    const many = Array.from({ length: 40 }, (_, i) => `k${i}`);
    const scale = buildCategoryScale(many, { order: many });
    expect(scale.colorOf('k0')).toEqual(categoryColor(0));
    expect(scale.colorOf('k39')).toEqual(categoryColor(39));
  });

  it('is stable regardless of input order', () => {
    const one = buildCategoryScale(['b', 'a', 'a', 'b', 'a']);
    const two = buildCategoryScale(['a', 'a', 'a', 'b', 'b']);
    expect(one.colorOf('a')).toEqual(two.colorOf('a'));
  });

  it('honours an explicit order', () => {
    const scale = buildCategoryScale(['a', 'a', 'b'], { order: ['b', 'a'] });
    expect(scale.keys).toEqual(['b', 'a']);
  });

  it('returns a neutral tint for unknown keys', () => {
    const scale = buildCategoryScale(['a']);
    expect(scale.colorOf('missing')).toEqual(NEUTRAL_TINT);
  });
});
