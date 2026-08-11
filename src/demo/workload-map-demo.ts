// Workload Map demo — a WorkloadStore driving a live honeycomb.
//
// Placement starts at the resource, not at any group. Every Azure resource is
// one hex cell, and every layer above it is an *aggregation* of that placement:
//
//   tenant             every management group together
//   management group   its subscriptions, separated by the widest gap
//   subscription       its resource groups, separated by a medium gap
//   resource group     the area its own resources carve out, thin gap
//   resource           one cell — the atomic placed unit
//   metric             the real metrics that resource type actually emits
//
// Nothing is drawn as a merged multi-cell object: a group is a *region* of
// adjacent single cells, which is what makes it an aggregate rather than a shape
// of its own. Gap width is what tells the levels apart, so the graduated pads
// below are load-bearing, not decoration.
//
// No layer is invented from data that does not exist. A resource's metrics are
// the ones its own kind emits — a NIC has rx/tx/errors, a database has
// DTU/connections/deadlocks — never a generic fill.
//
// Connectivity drives the arrangement inside a resource group: network-attached
// kinds are placed first, so what everything connects *through* ends up
// surrounded by what connects to it.

import { WorkloadStore, type NodeInput } from '../viz/workload-map';
import { HexGrid, type WorkloadInput } from '../viz/hexgrid';
import type { EntityUpdate } from '../data/types';
import type { RGBA } from '../core/types';
import { DIVERGING } from '../color';
import { mulberry32, randRange, randInt, drift } from './random';

const TENANT = 'contoso';
const ROOT_MG = 'mg-contoso';

/**
 * The Azure landing zone management group hierarchy from the Cloud Adoption
 * Framework conceptual architecture: a tenant root, an intermediate root for
 * the organisation, then Platform (identity, management, connectivity,
 * security), Landing zones (corp, online), Sandbox and Decommissioned.
 * https://learn.microsoft.com/azure/cloud-adoption-framework/ready/landing-zone/
 */
const INTERMEDIATE_MGS = ['mg-platform', 'mg-landingzones'];

interface MgSpec {
  /** The archetype management group subscriptions actually sit under. */
  leaf: string;
  parent: string;
  subs: number;
  /** Drives what a subscription's resource groups are made of. */
  archetype: 'connectivity' | 'identity' | 'management' | 'security' | 'application' | 'sandbox';
}

const MG_SPECS: readonly MgSpec[] = [
  { leaf: 'mg-connectivity', parent: 'mg-platform', subs: 1, archetype: 'connectivity' },
  { leaf: 'mg-identity', parent: 'mg-platform', subs: 1, archetype: 'identity' },
  { leaf: 'mg-management', parent: 'mg-platform', subs: 1, archetype: 'management' },
  { leaf: 'mg-security', parent: 'mg-platform', subs: 1, archetype: 'security' },
  { leaf: 'mg-corp', parent: 'mg-landingzones', subs: 22, archetype: 'application' },
  { leaf: 'mg-online', parent: 'mg-landingzones', subs: 11, archetype: 'application' },
  { leaf: 'mg-sandbox', parent: ROOT_MG, subs: 3, archetype: 'sandbox' },
  { leaf: 'mg-decommissioned', parent: ROOT_MG, subs: 1, archetype: 'sandbox' },
];

const RESOURCE_GROUPS = 500;
const TICK_MS = 50;
/** Metrics refreshed per tick; the cursor sweeps the whole estate. */
const SWEEP = 2_000;
const MAX_INCIDENTS = 14;
/** Metrics elevated per incident. */
const INCIDENT_SPAN = 10;

/** One Virtual WAN hub per region. A subscription's VNets peer into its own. */
const REGIONS = ['koreacentral', 'japaneast', 'southeastasia', 'westeurope', 'eastus'];
const ENVIRONMENTS = ['prod', 'dev', 'test', 'uat'];
const WORKLOADS = ['web', 'api', 'orders', 'billing', 'analytics', 'iot', 'crm', 'erp', 'portal', 'search'];

/**
 * Azure resource types, each with its CAF abbreviation and the metrics Azure
 * Monitor actually publishes for it.
 *
 * Abbreviations: https://learn.microsoft.com/azure/cloud-adoption-framework/ready/azure-best-practices/resource-abbreviations
 * Metrics: https://learn.microsoft.com/azure/azure-monitor/reference/supported-metrics/
 *
 * An empty metric list is a fact, not an omission: subnets, NSGs and route
 * tables publish no platform metrics at all, so their only signal is Azure
 * Resource Health. Inventing metrics for them would be inventing a layer.
 */
interface TypeSpec {
  abbr: string;
  category: string;
  metrics: readonly string[];
}

const RESOURCE_TYPES: Record<string, TypeSpec> = {
  'vwan-hub-connection': {
    abbr: 'vcn',
    category: 'connectivity',
    metrics: ['TunnelAverageBandwidth', 'TunnelIngressBytes', 'TunnelEgressBytes'],
  },
  'vpn-gateway': {
    abbr: 'vpng',
    category: 'connectivity',
    metrics: ['TunnelAverageBandwidth', 'TunnelIngressBytes', 'TunnelEgressBytes', 'P2SConnectionCount'],
  },
  'expressroute-gateway': {
    abbr: 'ergw',
    category: 'connectivity',
    metrics: ['ExpressRouteGatewayBitsPerSecond', 'ExpressRouteGatewayCpuUtilization'],
  },
  'virtual-network': {
    abbr: 'vnet',
    category: 'network',
    metrics: ['PingMeshAverageRoundtripMs', 'IfAzureVmAvailabilityIssue'],
  },
  subnet: { abbr: 'snet', category: 'network', metrics: [] },
  'route-table': { abbr: 'rt', category: 'network', metrics: [] },
  'network-interface': {
    abbr: 'nic',
    category: 'network',
    metrics: ['BytesSentRate', 'BytesReceivedRate', 'PacketsSentRate', 'PacketsReceivedRate'],
  },
  'public-ip': {
    abbr: 'pip',
    category: 'network',
    metrics: ['ByteCount', 'PacketCount', 'SynCount', 'VipAvailability'],
  },
  'load-balancer': {
    abbr: 'lbi',
    category: 'network',
    metrics: ['DipAvailability', 'VipAvailability', 'ByteCount', 'SnatConnectionCount', 'UsedSnatPorts'],
  },
  'private-endpoint': {
    abbr: 'pep',
    category: 'network',
    metrics: ['PEBytesIn', 'PEBytesOut'],
  },
  'dns-private-resolver': {
    abbr: 'dnspr',
    category: 'network',
    metrics: ['InboundQueryVolume', 'OutboundQueryVolume', 'VirtualNetworkLinkCount'],
  },
  firewall: {
    abbr: 'afw',
    category: 'security',
    metrics: ['Throughput', 'FirewallHealth', 'SNATPortUtilization', 'ApplicationRuleHit', 'NetworkRuleHit'],
  },
  'network-security-group': { abbr: 'nsg', category: 'security', metrics: [] },
  bastion: { abbr: 'bas', category: 'security', metrics: ['sessions', 'usage_user', 'pingmesh'] },
  'key-vault': {
    abbr: 'kv',
    category: 'security',
    metrics: ['ServiceApiHit', 'ServiceApiLatency', 'ServiceApiResult', 'Availability'],
  },
  'virtual-machine': {
    abbr: 'vm',
    category: 'compute',
    metrics: [
      'Percentage CPU',
      'Available Memory Bytes',
      'Disk Read Bytes',
      'Disk Write Bytes',
      'Network In Total',
      'Network Out Total',
    ],
  },
  'function-app': {
    abbr: 'func',
    category: 'compute',
    metrics: ['FunctionExecutionCount', 'FunctionExecutionUnits', 'Http5xx', 'AverageResponseTime', 'MemoryWorkingSet'],
  },
  'app-service': {
    abbr: 'app',
    category: 'compute',
    metrics: ['CpuTime', 'Requests', 'Http5xx', 'AverageResponseTime', 'MemoryWorkingSet'],
  },
  'managed-disk': {
    abbr: 'disk',
    category: 'storage',
    metrics: [
      'Composite Disk Read Bytes/sec',
      'Composite Disk Write Bytes/sec',
      'Composite Disk Read Operations/sec',
      'Composite Disk Write Operations/sec',
    ],
  },
  'storage-account': {
    abbr: 'st',
    category: 'storage',
    metrics: ['Transactions', 'SuccessE2ELatency', 'SuccessServerLatency', 'Availability', 'UsedCapacity'],
  },
  'sql-database': {
    abbr: 'sqldb',
    category: 'data',
    metrics: ['cpu_percent', 'dtu_consumption_percent', 'storage_percent', 'connection_failed', 'deadlock'],
  },
  'redis-cache': {
    abbr: 'redis',
    category: 'data',
    metrics: ['percentProcessorTime', 'usedmemorypercentage', 'cachemisses', 'evictedkeys', 'serverLoad'],
  },
  'servicebus-queue': {
    abbr: 'sbq',
    category: 'integration',
    metrics: ['ActiveMessages', 'DeadletteredMessages', 'IncomingMessages', 'ThrottledRequests', 'ServerErrors'],
  },
};

/**
 * Azure Resource Health is the only signal a type without platform metrics has,
 * and every Azure resource has it.
 */
const RESOURCE_HEALTH = ['Resource health'];

/** Services an application landing zone publishes beyond its VM units. */
const APP_SERVICES: readonly (readonly [string, number])[] = [
  ['sql-database', 0.15],
  ['redis-cache', 0.12],
  ['servicebus-queue', 0.12],
  ['function-app', 0.15],
  ['app-service', 0.12],
  ['storage-account', 0.14],
  ['private-endpoint', 0.11],
  ['load-balancer', 0.05],
  ['public-ip', 0.04],
];

/** Shared services a platform landing zone publishes for everyone else. */
const PLATFORM_SERVICES: readonly (readonly [string, number])[] = [
  ['private-endpoint', 0.34],
  ['route-table', 0.14],
  ['network-security-group', 0.13],
  ['storage-account', 0.12],
  ['key-vault', 0.11],
  ['load-balancer', 0.09],
  ['public-ip', 0.07],
];

/** Draw a resource type from a weighted mix. Weights sum to 1. */
function pickKind(rng: () => number, mix: readonly (readonly [string, number])[]): string {
  let t = rng();
  for (const [kind, weight] of mix) {
    t -= weight;
    if (t <= 0) return kind;
  }
  return mix[mix.length - 1][0];
}

/**
 * Pull strength toward the middle of the owning resource group. Placement hands
 * out cells strongest-first from the centre outward, so this is what makes the
 * VNet the core of its group, rings it with the shared network spine, and
 * leaves standalone services on the rim.
 */
const PULL_ANCHOR = 1;
const PULL_SPINE = 0.7;
const PULL_VM_UNIT = 0.4;
const PULL_SERVICE = 0.2;

interface Estate {
  store: WorkloadStore;
  /** One entry per resource — the atomic placed cell. */
  inputs: WorkloadInput[];
  /** Resource id per cell, which is also its renderer id. */
  cellId: string[];
  /** Store handle per cell. */
  cellHandle: Int32Array;
  /** Cell index per store handle, or -1. Sized to the store's capacity. */
  handleToCell: Int32Array;
  /** Store handle of every resource group, for band counts. */
  rgHandle: Int32Array;
  /** First cell of each resource group, used to aim anomaly pulses. */
  rgFirstCell: Int32Array;
  /** Store handle of every metric, resolved once and reused every tick. */
  metricHandle: Int32Array;
  /** First metric index of each resource group, plus a terminating entry. */
  metricStart: Int32Array;
  severity: Float32Array;
  baseline: Float32Array;
  resourceTotal: number;
  subscriptionTotal: number;
}

interface Incident {
  group: number;
  ticks: number;
  peak: number;
}

/**
 * Category is what the eye should sort on first, so each gets its own hue while
 * lightness and saturation stay fixed — no category reads as louder or more
 * urgent than another. Hues are hand-picked rather than evenly divided: hue is
 * not perceptually uniform, and an even split crowds several into the greens.
 */
const CATEGORY_HUE: Record<string, number> = {
  connectivity: 25,
  network: 205,
  security: 350,
  compute: 145,
  storage: 265,
  data: 55,
  integration: 310,
};

const CATEGORY_SATURATION = 0.5;
const CATEGORY_LIGHTNESS = 0.62;

/** HSL → RGBA, so a category can be specified as "a hue at the shared tone". */
function hsl(h: number, s: number, l: number): RGBA {
  const k = (n: number): number => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number): number => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4), 1];
}

const CATEGORY_NAMES = Object.keys(CATEGORY_HUE);
const CATEGORY_COLOR: Record<string, RGBA> = {};
for (const [name, hue] of Object.entries(CATEGORY_HUE)) {
  CATEGORY_COLOR[name] = hsl(hue, CATEGORY_SATURATION, CATEGORY_LIGHTNESS);
}

/** Everything a resource-group build needs to append to. */
interface BuildSink {
  records: NodeInput[];
  inputs: WorkloadInput[];
  cellId: string[];
  metricIds: string[];
  baselines: number[];
}

interface RgContext {
  rgId: string;
  mgLeaf: string;
  sub: string;
  hub: string;
  region: string;
  env: string;
  workload: string;
  archetype: MgSpec['archetype'];
}

/**
 * Append one resource group's resources and their metrics.
 *
 * Resources are generated as real Azure associations rather than a bag of
 * independent types: the VNet anchors the group and is what peers it into the
 * regional hub, the shared network spine hangs off that, and every VM owns the
 * NIC, disk and NSG that follow it. Placement hands out cells strongest-pull
 * first from the centre of the group outward, and ties break on the sort key —
 * so a VM's own satellites land in the cells immediately around it.
 */
function addResourceGroup(sink: BuildSink, ctx: RgContext, rng: () => number): number {
  const platform = ctx.archetype !== 'application' && ctx.archetype !== 'sandbox';
  const budget = platform ? randInt(rng, 50, 200) : randInt(rng, 30, 50);
  const planned: { kind: string; sortKey: string; pull: number; attach: number }[] = [];
  const add = (kind: string, sortKey: string, pull: number, attach: number): void => {
    if (planned.length < budget) planned.push({ kind, sortKey, pull, attach });
  };

  // The connectivity landing zone anchors on the Virtual WAN hub connection
  // itself; every other group anchors on the VNet peered into that hub.
  if (ctx.archetype === 'connectivity') {
    add('vwan-hub-connection', 'a0', PULL_ANCHOR, -1);
    for (const kind of ['firewall', 'vpn-gateway', 'expressroute-gateway', 'dns-private-resolver', 'bastion']) {
      add(kind, `a1-${kind}`, PULL_SPINE, 0);
    }
  } else {
    add('virtual-network', 'a0', PULL_ANCHOR, -1);
  }

  const subnets = randInt(rng, 2, 4);
  for (let i = 0; i < subnets; i++) add('subnet', `a2-snet-${i}`, PULL_SPINE, 0);
  add('route-table', 'a3-rt', PULL_SPINE, 0);
  if (ctx.archetype === 'identity' || ctx.archetype === 'security') add('key-vault', 'a4-kv', PULL_SPINE, 0);

  // VM units. The sort keys keep a unit together and put its VM first, so the
  // disk, NIC and NSG that belong to it are its immediate neighbours.
  const unitBudget = Math.floor(budget * 0.7);
  let unit = 0;
  while (planned.length < unitBudget) {
    const u = `b${String(++unit).padStart(3, '0')}`;
    const vmIndex = planned.length;
    add('virtual-machine', `${u}-0vm`, PULL_VM_UNIT, 0);
    add('network-interface', `${u}-1nic`, PULL_VM_UNIT, vmIndex);
    const disks = randInt(rng, 1, 2);
    for (let d = 0; d < disks; d++) add('managed-disk', `${u}-2disk-${d}`, PULL_VM_UNIT, vmIndex);
    add('network-security-group', `${u}-3nsg`, PULL_VM_UNIT, vmIndex);
  }

  let seq = 0;
  while (planned.length < budget) {
    const kind = pickKind(rng, platform ? PLATFORM_SERVICES : APP_SERVICES);
    add(kind, `c${String(seq++).padStart(3, '0')}-${kind}`, PULL_SERVICE, 0);
  }

  // CAF resource naming: <abbr>-<workload>-<env>-<instance>, numbered per type.
  const counters: Record<string, number> = {};
  const names = planned.map((res) => {
    const abbr = RESOURCE_TYPES[res.kind].abbr;
    counters[abbr] = (counters[abbr] ?? 0) + 1;
    return `${abbr}-${ctx.workload}-${ctx.env}-${String(counters[abbr]).padStart(3, '0')}`;
  });

  planned.forEach((res, i) => {
    const spec = RESOURCE_TYPES[res.kind];
    const id = `${ctx.rgId}/${names[i]}`;
    sink.records.push({ id, kind: res.kind, parent: ctx.rgId });

    // Types with no platform metrics fall back to Resource Health, which every
    // Azure resource does have. Nothing else is invented.
    const metricNames = spec.metrics.length > 0 ? spec.metrics : RESOURCE_HEALTH;
    const metrics: { id: string; value: number }[] = [];
    for (const metric of metricNames) {
      const base = randRange(rng, 0.02, 0.18);
      sink.records.push({ id: `${id}/${metric}`, kind: metric, parent: id, health: base });
      sink.metricIds.push(`${id}/${metric}`);
      sink.baselines.push(base);
      metrics.push({ id: metric, value: base });
    }

    sink.cellId.push(id);
    sink.inputs.push({
      // The grid identifies a workload by name, so it carries the full path;
      // the resource's own name is unique only inside its resource group.
      name: id,
      id,
      size: 1, // atomic cell; a group is a region of these, never a merged shape
      criticality: 0,
      // Only the first three entries group; the last is the sort key that
      // decides which cell inside the resource group this lands in.
      groupPath: [ctx.mgLeaf, ctx.sub, ctx.rgId, res.sortKey],
      central: res.pull,
      label: spec.abbr,
      tint: CATEGORY_COLOR[spec.category],
      resources: metrics,
      tooltip: [
        `${res.kind} · ${spec.category}`,
        res.attach < 0 ? `peered into ${ctx.hub}` : `attached to ${names[res.attach]}`,
        `${ctx.rgId} · ${ctx.region}`,
        `${ctx.sub} · ${ctx.mgLeaf}`,
      ],
    });
  });
  return planned.length;
}

function buildEstate(rng: () => number): Estate {
  // Worst-case node count, so the columns never have to grow mid-build.
  const store = new WorkloadStore({ capacity: 260_000 });

  const sink: BuildSink = {
    records: [{ id: TENANT, kind: 'tenant' }],
    inputs: [],
    cellId: [],
    metricIds: [],
    baselines: [],
  };
  sink.records.push({ id: ROOT_MG, kind: 'management-group', parent: TENANT });
  for (const mg of INTERMEDIATE_MGS) {
    sink.records.push({ id: mg, kind: 'management-group', parent: ROOT_MG });
  }
  for (const spec of MG_SPECS) {
    sink.records.push({ id: spec.leaf, kind: 'management-group', parent: spec.parent });
  }

  // Subscriptions. A subscription lives in one region, so its VNets peer into
  // that region's hub — which is why "VNets gather at their hub" and "a resource
  // group never leaves its subscription" never compete.
  interface SubSpec {
    id: string;
    mgLeaf: string;
    archetype: MgSpec['archetype'];
    region: string;
    hub: string;
    workload: string;
    env: string;
  }
  const subs: SubSpec[] = [];
  for (const spec of MG_SPECS) {
    for (let i = 0; i < spec.subs; i++) {
      const region = REGIONS[subs.length % REGIONS.length];
      const workload = WORKLOADS[subs.length % WORKLOADS.length];
      const env = ENVIRONMENTS[i % ENVIRONMENTS.length];
      const archetypeName = spec.leaf.slice(3);
      const id =
        spec.archetype === 'application'
          ? `sub-${archetypeName}-${workload}-${env}`
          : spec.subs === 1
            ? `sub-${archetypeName}`
            : `sub-${archetypeName}-${String(i + 1).padStart(2, '0')}`;
      sink.records.push({ id, kind: 'subscription', parent: spec.leaf });
      subs.push({
        id,
        mgLeaf: spec.leaf,
        archetype: spec.archetype,
        region,
        hub: `vhub-${region}`,
        workload,
        env,
      });
    }
  }

  // Platform and sandbox subscriptions hold few but resource-heavy groups; the
  // application landing zones carry the rest.
  const rgPerSub = new Int32Array(subs.length);
  let fixed = 0;
  subs.forEach((s, i) => {
    if (s.archetype !== 'application') {
      rgPerSub[i] = 2;
      fixed += 2;
    }
  });
  const appIndices = subs.map((s, i) => (s.archetype === 'application' ? i : -1)).filter((i) => i >= 0);
  let remaining = RESOURCE_GROUPS - fixed;
  const weights = appIndices.map(() => 0.5 + rng() * 1.5);
  const weightSum = weights.reduce((a, b) => a + b, 0);
  appIndices.forEach((subIdx, k) => {
    const share = k === appIndices.length - 1 ? remaining : Math.min(remaining, Math.round((weights[k] / weightSum) * remaining));
    rgPerSub[subIdx] = share;
    remaining -= share;
  });
  if (remaining > 0) rgPerSub[appIndices[appIndices.length - 1]] += remaining;

  const rgIds: string[] = [];
  const rgFirstCell = new Int32Array(RESOURCE_GROUPS);
  const metricStart = new Int32Array(RESOURCE_GROUPS + 1);
  let rgIndex = 0;
  let resourceTotal = 0;

  subs.forEach((sub, subIdx) => {
    for (let g = 0; g < rgPerSub[subIdx] && rgIndex < RESOURCE_GROUPS; g++, rgIndex++) {
      const workload = sub.archetype === 'application' ? sub.workload : sub.archetype;
      const env = sub.archetype === 'application' ? sub.env : 'prod';
      // Numbered estate-wide rather than per subscription: a store id has to be
      // globally unique, and Azure only requires uniqueness within a scope.
      const rgId = `rg-${workload}-${env}-${sub.region}-${String(rgIndex + 1).padStart(3, '0')}`;

      rgIds.push(rgId);
      rgFirstCell[rgIndex] = sink.cellId.length;
      metricStart[rgIndex] = sink.metricIds.length;
      sink.records.push({ id: rgId, kind: 'resource-group', parent: sub.id });
      resourceTotal += addResourceGroup(
        sink,
        {
          rgId,
          mgLeaf: sub.mgLeaf,
          sub: sub.id,
          hub: sub.hub,
          region: sub.region,
          env,
          workload,
          archetype: sub.archetype,
        },
        rng,
      );
    }
  });
  metricStart[RESOURCE_GROUPS] = sink.metricIds.length;
  store.applyBatch(sink.records);

  // Resolve every id once; the streaming loop then addresses nodes by handle.
  const cellHandle = new Int32Array(sink.cellId.length);
  const handleToCell = new Int32Array(store.capacity).fill(-1);
  for (let c = 0; c < sink.cellId.length; c++) {
    cellHandle[c] = store.handleOf(sink.cellId[c]);
    handleToCell[cellHandle[c]] = c;
  }
  const rgHandle = new Int32Array(RESOURCE_GROUPS);
  for (let i = 0; i < RESOURCE_GROUPS; i++) rgHandle[i] = store.handleOf(rgIds[i]);

  const metricHandle = new Int32Array(sink.metricIds.length);
  const severity = new Float32Array(sink.metricIds.length);
  const baseline = new Float32Array(sink.metricIds.length);
  for (let i = 0; i < sink.metricIds.length; i++) {
    metricHandle[i] = store.handleOf(sink.metricIds[i]);
    baseline[i] = sink.baselines[i];
    severity[i] = sink.baselines[i];
  }

  return {
    store,
    inputs: sink.inputs,
    cellId: sink.cellId,
    cellHandle,
    handleToCell,
    rgHandle,
    rgFirstCell,
    metricHandle,
    metricStart,
    severity,
    baseline,
    resourceTotal,
    subscriptionTotal: subs.length,
  };
}

function buildLegend(el: HTMLElement, mode: 'health' | 'category'): void {
  const stops = DIVERGING.rdylgn.slice().reverse().join(', ');
  const swatch = (c: RGBA): string =>
    `rgb(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)})`;
  const categories = CATEGORY_NAMES.map(
    (n) =>
      `<span style="display:inline-flex;align-items:center;gap:4px;margin-right:8px">` +
      `<i style="width:9px;height:9px;border-radius:2px;background:${swatch(CATEGORY_COLOR[n])}"></i>${n}</span>`,
  ).join('');

  el.innerHTML =
    `<div style="font-weight:600;margin-bottom:4px">` +
    `${mode === 'health' ? 'rolled-up severity' : 'resource category'}` +
    `<span style="float:right;opacity:0.6;font-weight:400">press C</span></div>` +
    (mode === 'health'
      ? `<div style="height:10px;border-radius:3px;background:linear-gradient(90deg, ${stops})"></div>` +
        `<div style="display:flex;justify-content:space-between;opacity:0.75;margin-top:2px">` +
        `<span>healthy</span><span>warning</span><span>critical</span></div>`
      : `<div style="line-height:1.9">${categories}</div>`) +
    `<div style="margin-top:7px;opacity:0.7">One cell is one Azure resource.` +
    ` Resource group, subscription and management group are the areas those` +
    ` cells carve out — aggregations of the placement, never shapes of their own.` +
    ` Gap width tells the levels apart: widest between management groups,` +
    ` narrowest between resource groups. Categories share one lightness and` +
    ` saturation and differ only in hue, so none shouts over the others.</div>`;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i];
}

function main(): void {
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  const hud = document.getElementById('hud') as HTMLDivElement;
  const legend = document.getElementById('legend') as HTMLDivElement;

  const rng = mulberry32(20260731);
  const est = buildEstate(rng);
  const grid = new HexGrid(canvas, {
    workloads: est.inputs,
    // Path is [management group, subscription, resource group, resource], so the
    // three grouping levels line up with affinity placement's graduated veins:
    // widest between management groups, narrower between subscriptions,
    // narrowest between resource groups. That gap width is what makes each
    // aggregation legible without drawing a shape for it. `central` then decides
    // which resources get the innermost cells of each resource group.
    placement: 'affinity',
    affinityWeights: [1.3, 1.1, 0.9],
    // Measured: a resource cell is ~235 px wide at zoom 8 (bench/placement-diag),
    // which is where its metric cells become individually readable.
    firstLayerZoom: 8,
    tweenRate: 5,
  });

  let colorMode: 'health' | 'category' = 'health';
  buildLegend(legend, colorMode);
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'c' && e.key !== 'C') return;
    colorMode = colorMode === 'health' ? 'category' : 'health';
    grid.setColorMode(colorMode);
    buildLegend(legend, colorMode);
  });

  const total = est.metricHandle.length;
  // Reused every tick so the streaming path allocates nothing.
  const batchHandles = new Int32Array(SWEEP + MAX_INCIDENTS * INCIDENT_SPAN);
  const batchValues = new Float32Array(batchHandles.length);
  const updates: EntityUpdate[] = [];

  const incidents: Incident[] = [];
  let sweep = 0;
  let appliedTotal = 0;
  let appliedWindow = 0;
  let windowStart = performance.now();
  let updatesPerSec = 0;
  let overflowed = false;
  const applyTimes: number[] = [];

  setInterval(() => {
    // Start an incident: several resources of one resource group degrade
    // together. Most are partial degradations that settle in the warning band;
    // the rest escalate into a full outage, which is what earns the alarm pulse.
    if (incidents.length < MAX_INCIDENTS && rng() < 0.16) {
      const g = randInt(rng, 0, RESOURCE_GROUPS - 1);
      const outage = rng() < 0.4;
      const peak = outage ? randRange(rng, 0.82, 1) : randRange(rng, 0.45, 0.68);
      incidents.push({ group: g, ticks: randInt(rng, 40, 120), peak });
      if (outage) grid.triggerAnomaly(est.cellId[est.rgFirstCell[g]], 1);
    }

    let n = 0;
    // Rotating sweep so every metric is refreshed a few times a minute.
    for (let k = 0; k < SWEEP; k++) {
      const i = sweep;
      sweep = sweep + 1 === total ? 0 : sweep + 1;
      est.severity[i] = drift(
        est.severity[i],
        { min: 0, max: 1, mean: est.baseline[i], reversion: 0.05, volatility: 0.03 },
        rng,
      );
      batchHandles[n] = est.metricHandle[i];
      batchValues[n] = est.severity[i];
      n++;
    }

    // Incident metrics are always in the batch, so a flare is visible at once.
    for (let a = incidents.length - 1; a >= 0; a--) {
      const inc = incidents[a];
      const from = est.metricStart[inc.group];
      const to = est.metricStart[inc.group + 1];
      const hit = Math.min(to - from, INCIDENT_SPAN);
      for (let k = 0; k < hit && n < batchHandles.length; k++) {
        const i = from + k;
        est.severity[i] = drift(
          est.severity[i],
          { min: 0, max: 1, mean: inc.peak, reversion: 0.2, volatility: 0.04 },
          rng,
        );
        batchHandles[n] = est.metricHandle[i];
        batchValues[n] = est.severity[i];
        n++;
      }
      if (--inc.ticks <= 0) {
        // Recovery: let the baseline pull the metrics back down.
        for (let i = from; i < to; i++) est.severity[i] = est.baseline[i];
        incidents.splice(a, 1);
      }
    }

    const t0 = performance.now();
    const applied = est.store.applyHealthBulk(batchHandles, batchValues, n);
    applyTimes.push(performance.now() - t0);
    if (applyTimes.length > 120) applyTimes.shift();
    appliedTotal += applied;
    appliedWindow += applied;

    // Push only what changed. The store reports which handles moved; above its
    // budget it reports overflow instead, and every cell is resynced.
    updates.length = 0;
    if (est.store.dirtyOverflowed) {
      overflowed = true;
      est.store.drainDirty();
      for (let c = 0; c < est.cellId.length; c++) {
        updates.push({ id: est.cellId[c], severity: est.store.severityOf(est.cellHandle[c]) });
      }
    } else {
      for (const h of est.store.drainDirty()) {
        const c = est.handleToCell[h];
        if (c < 0) continue;
        updates.push({ id: est.cellId[c], severity: est.store.severityOf(h) });
      }
    }
    if (updates.length > 0) grid.applyUpdate(updates);
  }, TICK_MS);

  setInterval(() => {
    const now = performance.now();
    updatesPerSec = Math.round((appliedWindow * 1000) / Math.max(1, now - windowStart));
    appliedWindow = 0;
    windowStart = now;

    // Resource-group band counts, read straight off each group's rollup.
    let critical = 0;
    let warning = 0;
    for (let i = 0; i < RESOURCE_GROUPS; i++) {
      const s = est.store.statusOf(est.rgHandle[i]);
      if (s === 'critical') critical++;
      else if (s === 'warning') warning++;
    }

    const sorted = applyTimes.slice().sort((a, b) => a - b);
    hud.innerHTML =
      `<b>${grid.fps} fps</b> · ${est.store.size.toLocaleString()} nodes · ` +
      `colour: ${colorMode}<br />` +
      `${MG_SPECS.length} mgmt groups · ${est.subscriptionTotal} subscriptions · ` +
      `${RESOURCE_GROUPS} resource groups<br />` +
      `<b>${est.resourceTotal.toLocaleString()} resource cells</b> · ` +
      `${total.toLocaleString()} metrics<br />` +
      `${updatesPerSec.toLocaleString()} updates/s · ingest p50 ` +
      `${percentile(sorted, 50).toFixed(2)} ms · p95 ${percentile(sorted, 95).toFixed(2)} ms<br />` +
      `resource groups: <span style="color:#f2777a">${critical} critical</span> · ` +
      `<span style="color:#f0c674">${warning} warning</span> · ` +
      `<span style="opacity:0.8">${RESOURCE_GROUPS - critical - warning} healthy</span> · ` +
      `${incidents.length} active incident${incidents.length === 1 ? '' : 's'}<br />` +
      `<span style="opacity:0.6">${appliedTotal.toLocaleString()} updates applied · ` +
      `dirty path: ${overflowed ? 'overflowed at least once' : 'incremental'}</span>`;
  }, 400);
}

main();
