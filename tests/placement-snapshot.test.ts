import { describe, it, expect } from 'vitest';
import {
  placeRelational,
  placementKey,
  serializePlacement,
  restorePlacement,
  PLACEMENT_VERSION,
  type RelItem,
} from '../src/viz/hexgrid/placement';

// A small estate with the shape that matters here: a containment path, links
// that cross it, and the affinity attributes the layout keys off.
function buildEstate(): RelItem[] {
  const items: RelItem[] = [];
  let seq = 0;
  const emit = (path: string[], code: string, central: number, deps: string[] = []): string => {
    const name = `${code}-${seq++}`;
    items.push({ name, size: 1, path, deps, central, affinity: [path[0], path[1]] });
    return name;
  };
  const hub = emit(['sub-connectivity', 'rg-conn'], 'VHUB', 1);
  for (let w = 0; w < 6; w++) {
    const sub = `sub-wl${w}`;
    const vnet = emit([sub, `${sub}-net`], 'VNET', 0.92, [hub]);
    for (let v = 0; v < 3; v++) {
      const vm = emit([sub, `${sub}-app`], 'VM', 0.1);
      emit([sub, `${sub}-app`], 'NIC', 0.2, [vm, vnet]);
      emit([sub, `${sub}-app`], 'DISK', 0.05, [vm]);
    }
  }
  return items;
}

const OPTS = { moats: [2, 1], affinityWeights: [1.2, 0.6] };

describe('placement snapshots', () => {
  const items = buildEstate();
  const key = placementKey(items, OPTS);
  const placed = placeRelational(items, OPTS);

  it('restores a layout cell for cell', () => {
    const restored = restorePlacement(serializePlacement(placed, key), items, key);
    expect(restored).not.toBeNull();
    expect(restored?.map((p) => p.name)).toEqual(placed.map((p) => p.name));
    expect(restored?.map((p) => p.cells)).toEqual(placed.map((p) => p.cells));
    expect(restored?.map((p) => p.anchor)).toEqual(placed.map((p) => p.anchor));
  });

  it('rejects a snapshot from another algorithm version', () => {
    const snap = serializePlacement(placed, key);
    expect(restorePlacement({ ...snap, version: PLACEMENT_VERSION + 1 }, items, key)).toBeNull();
  });

  it('rejects a snapshot whose key no longer matches', () => {
    const snap = serializePlacement(placed, key);
    expect(restorePlacement(snap, items, 'stale')).toBeNull();
  });

  it('rejects a snapshot that is missing a resource', () => {
    const snap = serializePlacement(placed, key);
    const grown = [...items, { name: 'VM-new', size: 1, path: ['sub-wl0', 'sub-wl0-app'] }];
    // Same key on purpose: even so, the new resource has nowhere to be restored to.
    expect(restorePlacement(snap, grown, key)).toBeNull();
  });
});

describe('placement key', () => {
  const items = buildEstate();
  const key = placementKey(items, OPTS);

  it('is stable for the same estate and options', () => {
    expect(placementKey(buildEstate(), OPTS)).toBe(key);
  });

  it('changes when a resource is added or removed', () => {
    expect(placementKey(items.slice(0, -1), OPTS)).not.toBe(key);
    expect(
      placementKey([...items, { name: 'VM-new', size: 1, path: ['sub-wl0', 'sub-wl0-app'] }], OPTS),
    ).not.toBe(key);
  });

  it('changes when a resource moves to another resource group', () => {
    const moved = items.map((it, i) => (i === items.length - 1 ? { ...it, path: ['sub-wl5', 'sub-wl5-net'] } : it));
    expect(placementKey(moved, OPTS)).not.toBe(key);
  });

  it('changes when the wiring changes', () => {
    const rewired = items.map((it, i) => (i === items.length - 1 ? { ...it, deps: [] } : it));
    expect(placementKey(rewired, OPTS)).not.toBe(key);
  });

  it('changes when the layout options change', () => {
    expect(placementKey(items, { ...OPTS, moats: [3, 1] })).not.toBe(key);
    expect(placementKey(items, { ...OPTS, affinityWeights: [1, 1] })).not.toBe(key);
  });
});
