// The estate the demo draws — read from a real Azure Resource Graph snapshot.
//
// `tools/build-estate.mjs` folds a Resource Graph dump into one compact file:
// dictionaries for management groups, regions and resource types, then flat
// records for subscriptions, resource groups and resources, and the wiring as a
// flat list of index pairs. This expands that back into the rows the demo's
// dataset spec is written against.
//
// Everything here is real except the metrics: a snapshot has no time series in
// it, so each resource is given a plausible set of metric ids and a baseline,
// and the live severity is driven by the simulator on top. Where Azure Resource
// Health did report on a resource, that state is the baseline it starts from.

import { mulberry32, randRange, randInt } from './random';

/** One resource — a single cell on the wall. */
export interface Target {
  name: string;
  /** Top-level management group (the first level that actually varies). */
  mgTop: string;
  /** The management group the subscription sits in. */
  mg: string;
  /** The Virtual WAN hub the subscription's networks peer with. */
  hub: string;
  sub: string;
  rg: string;
  /** The service the subscription belongs to (from its `Service` tag). */
  service: string;
  /** Service grade (A/B/C…) as tagged on the subscription. */
  grade: string;
  region: string;
  env: string;
  typeCode: string;
  typeName: string;
  kind: string;
  /** Shared-ness, from how much of the estate points at it: higher sits nearer
   *  the middle of its cluster. */
  central: number;
  /** False when Azure Resource Health reports nothing about this type. */
  monitored: boolean;
  /** What it is wired to, and what kind of relationship each link is. */
  deps: { id: string; kind: string }[];
  base: number;
  metrics: { id: string; base: number }[];
}

export interface Estate {
  targets: Target[];
  /** False when the file was built with real names (`--real`). */
  anonymized: boolean;
  generated: string;
}

interface TypeSpec {
  code: string;
  name: string;
  kind: string;
  central: number;
  monitored: boolean;
}

/** The on-disk format. Indices everywhere; see tools/build-estate.mjs. */
interface EstateFile {
  version: number;
  anonymized: boolean;
  generated: string;
  mgs: string[];
  locations: string[];
  types: TypeSpec[];
  /** [name, managementGroupPath, env, service, grade, hub] */
  subs: [string, number[], string, string, string, string][];
  /** [name, subscriptionIndex] */
  rgs: [string, number][];
  /** [name, typeIndex, resourceGroupIndex, locationIndex, health, central] */
  res: [string, number, number, number, number, number][];
  /** Flat pairs of resource indices. */
  deps: number[];
}

const METRIC_KINDS = ['cpu', 'mem', 'net', 'disk', 'lat', 'err'];

/**
 * Expand the compact file into one row per resource. The management-group path
 * arrives with the levels every subscription shares already stripped, so its
 * first entry is the estate's real top-level split and its last is the group the
 * subscription actually sits in.
 */
export function expandEstate(file: EstateFile): Estate {
  const rng = mulberry32(1337);
  const targets: Target[] = new Array(file.res.length);

  for (let i = 0; i < file.res.length; i++) {
    const [name, t, g, l, health, central] = file.res[i];
    const spec = file.types[t];
    const [rgName, subIdx] = file.rgs[g];
    const [subName, path, env, service, grade, hub] = file.subs[subIdx];
    const monitored = spec.monitored;
    // A real availability state where Azure reported one, a calm baseline where
    // it did not; resources health says nothing about stay flat at zero.
    const base = !monitored
      ? 0
      : health >= 0
        ? health
        : randRange(rng, 0.03, env === 'prd' ? 0.11 : 0.2);
    targets[i] = {
      name,
      mgTop: file.mgs[path[0]] ?? '(none)',
      mg: file.mgs[path[path.length - 1]] ?? '(none)',
      hub: hub || '(no hub)',
      sub: subName,
      rg: rgName,
      service: service || '(untagged)',
      grade: grade || '(untagged)',
      region: file.locations[l] ?? 'global',
      env: env || 'unset',
      typeCode: spec.code,
      typeName: spec.name,
      kind: spec.kind,
      central,
      monitored,
      deps: [],
      base,
      metrics: monitored
        ? Array.from({ length: randInt(rng, 2, 4) }, (_, m) => ({
            id: METRIC_KINDS[m % METRIC_KINDS.length],
            base: randRange(rng, 0.04, 0.28),
          }))
        : [],
    };
  }

  // A link's kind is the kind of what it points at — attaching a disk to a
  // machine is a compute attachment, a private endpoint onto a database is data
  // access. The visualization registers each link on both of its ends, so it is
  // only recorded once here.
  for (let i = 0; i < file.deps.length; i += 2) {
    const from = targets[file.deps[i]];
    const to = targets[file.deps[i + 1]];
    if (from && to) from.deps.push({ id: to.name, kind: to.kind });
  }

  return { targets, anonymized: file.anonymized, generated: file.generated };
}

/**
 * Fetch the snapshot the demo runs on. It is a build artefact — see the README
 * section in tools/build-estate.mjs — so a missing file is a setup problem, not
 * a runtime one, and says so plainly.
 */
export async function loadEstate(url = '/estate.json'): Promise<Estate> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `estate snapshot not found at ${url} (${res.status}). ` +
        'Build it with: node tools/build-estate.mjs --dump <resource-graph-dump-dir>',
    );
  }
  return expandEstate((await res.json()) as EstateFile);
}
