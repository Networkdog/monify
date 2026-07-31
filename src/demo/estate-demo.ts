// Estate Monitor — a whole Azure estate as a honeycomb of monitored resources.
//
// Every cell is a resource that Azure Resource Health actually reports on (VM,
// SQL DB, App Service, Key Vault, Firewall, …); pure config/policy resources
// with no health concept (VNet, NSG, Public IP, Private Endpoint, NIC, route
// table, firewall policy, App Insights) are left off the wall. Each cell renders
// as a single hex, laid out with *locality*: cells that share a grouping
// criterion sit next to each other. The estate models an Azure landing zone on
// Virtual WAN — 10 secured hubs (Azure Firewall), ~1,000 Prod/Dev subscriptions
// (a VNet spoke each), 500 workloads. Placement nests by network topology
// (hub › subscription › resource group), so each hub is a territory and its
// spoke subscriptions cluster inside it.
//
// The in-cell glyph is the resource-type code (its "icon"). Colour is driven by
// a chosen criterion — Health (live RdYlGn) or a structural dimension (hub /
// environment / management group / workload / type / subscription). Switching to
// a structural dimension paints contiguous colour regions, making the locality
// visible; correlated incidents then light up a whole resource group,
// subscription, or hub at once.

import { HexGrid, type WorkloadInput } from '../viz/hexgrid';
import { paletteStops } from '../color';
import type { RGBA } from '../core/types';
import { mulberry32, randRange, randInt } from './random';
import { SimulatedSource, MonitorFeed, type SimEntity } from '../data';

// ── Estate catalogs ──────────────────────────────────────────────────────────

// 10 Virtual WAN secured hubs (each fronted by Azure Firewall), one per region.
const HUBS = [
  { id: 'vhub-koreacentral', region: 'koreacentral' },
  { id: 'vhub-koreasouth', region: 'koreasouth' },
  { id: 'vhub-japaneast', region: 'japaneast' },
  { id: 'vhub-southeastasia', region: 'southeastasia' },
  { id: 'vhub-eastus2', region: 'eastus2' },
  { id: 'vhub-westus3', region: 'westus3' },
  { id: 'vhub-westeurope', region: 'westeurope' },
  { id: 'vhub-northeurope', region: 'northeurope' },
  { id: 'vhub-uksouth', region: 'uksouth' },
  { id: 'vhub-australiaeast', region: 'australiaeast' },
] as const;

const WORKLOAD_COUNT = 500;
const WORKLOAD_DOMAINS = [
  'payments', 'orders', 'catalog', 'inventory', 'search', 'billing', 'analytics',
  'notify', 'media', 'portal', 'crm', 'risk', 'ledger', 'fraud', 'pricing', 'shipping',
  'returns', 'loyalty', 'recommend', 'chat', 'feed', 'ads', 'wallet', 'invoice', 'tax',
  'audit', 'reporting', 'datalake', 'mlserving', 'iot', 'telemetry', 'support', 'booking',
  'maps', 'streaming', 'gaming', 'social', 'docs', 'signing', 'insights',
];

interface RType {
  code: string;
  name: string;
  kind: string;
}
// Only resource types that Azure Resource Health actually reports on live on the
// wall — this is a health-monitoring estate, so resources with no health concept
// (pure config/policy: Virtual Network, NSG, Public IP, Private Endpoint, NIC,
// Route Table, Firewall Policy) and resources Resource Health doesn't surface
// (App Insights) are intentionally excluded.
// See: https://learn.microsoft.com/azure/service-health/resource-health-checks-resource-types
const RTYPES: Record<string, RType> = {
  VM: { code: 'VM', name: 'Virtual Machine', kind: 'compute' },
  VMSS: { code: 'VMSS', name: 'VM Scale Set', kind: 'compute' },
  AKS: { code: 'AKS', name: 'AKS Node Pool', kind: 'compute' },
  APP: { code: 'APP', name: 'App Service', kind: 'web' },
  FN: { code: 'FN', name: 'Function App', kind: 'web' },
  SQL: { code: 'SQL', name: 'Azure SQL DB', kind: 'data' },
  COS: { code: 'COS', name: 'Cosmos DB', kind: 'data' },
  PG: { code: 'PG', name: 'PostgreSQL', kind: 'data' },
  RDS: { code: 'RDS', name: 'Redis Cache', kind: 'data' },
  STG: { code: 'STG', name: 'Storage Account', kind: 'storage' },
  SB: { code: 'SB', name: 'Service Bus', kind: 'integration' },
  EH: { code: 'EH', name: 'Event Hub', kind: 'integration' },
  KV: { code: 'KV', name: 'Key Vault', kind: 'security' },
  LAW: { code: 'LAW', name: 'Log Analytics', kind: 'monitor' },
  LB: { code: 'LB', name: 'Load Balancer', kind: 'network' },
  AGW: { code: 'AGW', name: 'Application Gateway', kind: 'network' },
  VHUB: { code: 'VHUB', name: 'Virtual WAN Hub', kind: 'connectivity' },
  FW: { code: 'FW', name: 'Azure Firewall', kind: 'connectivity' },
  VPN: { code: 'VPN', name: 'VPN Gateway', kind: 'connectivity' },
  ER: { code: 'ER', name: 'ExpressRoute Gateway', kind: 'connectivity' },
};

const METRIC_KINDS = ['cpu', 'mem', 'net', 'disk', 'lat', 'err'];

// ── Generated model ──────────────────────────────────────────────────────────

interface Target {
  name: string;
  mg: string;
  sub: string;
  rg: string;
  workload: string;
  hub: string;
  region: string;
  env: string;
  typeCode: string;
  typeName: string;
  kind: string;
  base: number;
  metrics: { id: string; base: number }[];
}

function pad(n: number, w: number): string {
  return String(n).padStart(w, '0');
}

interface SubCtx {
  mg: string;
  sub: string;
  workload: string;
  hub: string;
  region: string;
  env: string;
}

/** Build the estate: 10 vWAN hubs › ~1,010 subscriptions (Prod/Dev + connectivity) › RGs ›
 *  health-reported resources. Per-workload size: 95% of workloads sit near ~50 resources,
 *  while a rare 5% vary widely, spreading from 50 up to 300. */
function buildEstate(rng: () => number): Target[] {
  const targets: Target[] = [];
  let seq = 0;

  const metricsFor = (): { id: string; base: number }[] => {
    const n = randInt(rng, 2, 4);
    return Array.from({ length: n }, (_, m) => ({
      id: METRIC_KINDS[m % METRIC_KINDS.length],
      base: randRange(rng, 0.04, 0.28),
    }));
  };

  const emit = (ctx: SubCtx, rg: string, code: string): void => {
    const rt = RTYPES[code];
    seq++;
    targets.push({
      name: `${ctx.workload}-${code.toLowerCase()}-${pad(seq, 6)}`,
      mg: ctx.mg,
      sub: ctx.sub,
      rg,
      workload: ctx.workload,
      hub: ctx.hub,
      region: ctx.region,
      env: ctx.env,
      typeCode: rt.code,
      typeName: rt.name,
      kind: rt.kind,
      // Dev runs a touch hotter (noisier); prod/platform baselines are calmer.
      base: randRange(rng, 0.03, ctx.env === 'dev' ? 0.2 : 0.11),
      metrics: metricsFor(),
    });
  };

  // Emit `[code, min, max]` random counts of resources into a resource group,
  // scaled by an optional per-workload multiplier so some workloads sprawl.
  const gen = (ctx: SubCtx, rg: string, specs: [string, number, number][], scale = 1): void => {
    for (const [code, lo, hi] of specs) {
      const n = Math.round(randInt(rng, lo, hi) * scale);
      for (let i = 0; i < n; i++) emit(ctx, rg, code);
    }
  };

  // Per-workload resource multiplier. Most workloads (95%) stay near the ~50
  // baseline; only a rare 5% vary widely, spreading anywhere from 50 up to 300
  // resources. Baseline (scale 1) is ~56 resources per workload (its prod + dev
  // subs), so a target of T resources ⇒ scale = T/56.
  const WORKLOAD_BASE = 56;
  const workloadScale = (): number => {
    const t = rng() < 0.95
      ? 50 // the 95%: ~50 resources (only the baseline's own spread varies them)
      : 50 + 250 * rng(); // the rare 5%: spread widely across 50–300
    return t / WORKLOAD_BASE;
  };

  // 500 workloads; workload i is homed in hub i % HUBS.length (its prod & dev subs together).
  const workloads: string[] = [];
  for (let i = 0; i < WORKLOAD_COUNT; i++) {
    const domain = WORKLOAD_DOMAINS[i % WORKLOAD_DOMAINS.length];
    workloads.push(`${domain}-${pad(Math.floor(i / WORKLOAD_DOMAINS.length) + 1, 2)}`);
  }

  HUBS.forEach((hub, h) => {
    // Platform / connectivity subscription: the Virtual WAN hub + Firewall + gateways.
    const conn: SubCtx = {
      mg: 'platform',
      sub: `sub-connectivity-${hub.region}`,
      workload: 'connectivity',
      hub: hub.id,
      region: hub.region,
      env: 'platform',
    };
    const connRg = `rg-connectivity-${hub.region}`;
    emit(conn, connRg, 'VHUB');
    emit(conn, connRg, 'FW');
    emit(conn, connRg, 'VPN');
    emit(conn, connRg, 'ER');
    gen(conn, `rg-platform-mgmt-${hub.region}`, [['LAW', 1, 2], ['STG', 1, 3], ['KV', 1, 2], ['VM', 1, 3]]);

    // Workload subscriptions homed in this hub — prod first, then dev. Each
    // workload gets a size multiplier (most modest, a few sprawling 3×+) applied
    // to both its prod and dev subs, so resource counts vary widely.
    const hubWorkloads = workloads.filter((_, i) => i % HUBS.length === h);
    const scaleOf = new Map<string, number>();
    for (const wl of hubWorkloads) scaleOf.set(wl, workloadScale());
    for (const env of ['prod', 'dev'] as const) {
      const mg = env === 'prod' ? 'lz-prod' : 'lz-dev';
      for (const wl of hubWorkloads) {
        const scale = scaleOf.get(wl) ?? 1;
        const ctx: SubCtx = { mg, sub: `sub-${wl}-${env}`, workload: wl, hub: hub.id, region: hub.region, env };
        // Spoke network: the load balancer is the only network resource with a
        // health concept — the VNet/NSG/PIP/PE/NIC/route-table config resources
        // are excluded because Resource Health doesn't report on them.
        const netRg = `rg-${wl}-${env}-net`;
        gen(ctx, netRg, [['LB', 0, 2]], scale);
        gen(ctx, `rg-${wl}-${env}-web`, [['APP', 2, 6], ['FN', 1, 4], ['AGW', 0, 2]], scale);
        gen(ctx, `rg-${wl}-${env}-app`, [['VM', 2, 7], ['VMSS', 0, 2], ['AKS', 0, 2]], scale);
        gen(ctx, `rg-${wl}-${env}-data`, [['SQL', 1, 3], ['COS', 0, 2], ['PG', 0, 2], ['RDS', 0, 2], ['STG', 1, 3]], scale);
        gen(ctx, `rg-${wl}-${env}-shared`, [['KV', 1, 2], ['STG', 1, 2], ['LAW', 0, 1]], scale);
        // Larger workloads are likelier to run a messaging tier.
        if (rng() < Math.min(0.95, 0.5 + 0.15 * scale)) {
          gen(ctx, `rg-${wl}-${env}-integration`, [['SB', 1, 3], ['EH', 0, 3]], scale);
        }
      }
    }
  });

  return targets;
}

// ── Categorical colouring ────────────────────────────────────────────────────

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number): number => {
    const k = (n + h * 12) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}

/** Distinct, stable hue per category index (golden-angle spread). */
function categoryColor(index: number): RGBA {
  const hue = (index * 0.6180339887) % 1;
  const [r, g, b] = hslToRgb(hue, 0.55, 0.58);
  return [r, g, b, 1];
}

interface DimSpec {
  id: string;
  label: string;
  keyOf?: (t: Target) => string;
}
const DIMS: DimSpec[] = [
  { id: 'health', label: '상태 (Health)' },
  { id: 'hub', label: '허브 (vWAN)', keyOf: (t) => t.hub },
  { id: 'env', label: '환경', keyOf: (t) => t.env },
  { id: 'mg', label: '관리 그룹', keyOf: (t) => t.mg },
  { id: 'workload', label: '워크로드', keyOf: (t) => t.workload },
  { id: 'type', label: '리소스 종류', keyOf: (t) => t.typeCode },
  { id: 'sub', label: '구독', keyOf: (t) => t.sub },
];

interface DimColoring {
  tints: RGBA[]; // per target index, aligned to `targets`
  legend: { key: string; color: RGBA; count: number }[];
}

const NEUTRAL_TINT: RGBA = [0.5, 0.55, 0.62, 1];

/** Precompute a colour per target + a legend for one structural dimension. */
function buildColoring(targets: Target[], keyOf: (t: Target) => string): DimColoring {
  const counts = new Map<string, number>();
  for (const t of targets) {
    const k = keyOf(t);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  // Stable index by descending count then name, so big regions get spread hues.
  const entries = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const color = new Map<string, RGBA>();
  entries.forEach(([k], i) => color.set(k, categoryColor(i)));
  const tints = targets.map((t) => color.get(keyOf(t)) ?? NEUTRAL_TINT);
  const legend = entries.map(([k, count]) => ({ key: k, color: color.get(k) ?? NEUTRAL_TINT, count }));
  return { tints, legend };
}

// ── UI ───────────────────────────────────────────────────────────────────────

function healthStops(): RGBA[] {
  return paletteStops('rdylgn').slice().reverse();
}

function rgbaCss(c: RGBA, a = 1): string {
  return `rgba(${Math.round(c[0] * 255)}, ${Math.round(c[1] * 255)}, ${Math.round(c[2] * 255)}, ${a})`;
}

function renderSegmented(
  host: HTMLElement,
  items: { id: string; label: string }[],
  onPick: (id: string) => void,
): (active: string) => void {
  const buttons = new Map<string, HTMLButtonElement>();
  host.innerHTML = '';
  for (const d of items) {
    const b = document.createElement('button');
    b.textContent = d.label;
    b.className = 'seg';
    b.addEventListener('click', () => onPick(d.id));
    host.appendChild(b);
    buttons.set(d.id, b);
  }
  return (active: string) => {
    for (const [id, b] of buttons) b.classList.toggle('on', id === active);
  };
}

function renderLegend(el: HTMLElement, dimId: string, colorings: Map<string, DimColoring>): void {
  const spec = DIMS.find((d) => d.id === dimId) ?? DIMS[0];
  if (dimId === 'health') {
    const stops = healthStops().map((c) => rgbaCss(c)).join(', ');
    el.innerHTML =
      `<div class="lt">색상 기준 · ${spec.label}</div>` +
      `<div style="height:10px;border-radius:3px;background:linear-gradient(90deg, ${stops})"></div>` +
      `<div class="lr"><span>healthy</span><span>warning</span><span>critical</span></div>` +
      `<div class="ln">색 = 심각도 · 이상 발생 시 붉게 점멸</div>`;
    return;
  }
  const c = colorings.get(dimId);
  if (!c) return;
  const MAX = 12;
  const shown = c.legend.slice(0, MAX);
  const rows = shown
    .map(
      (e) =>
        `<div class="lrow"><span class="sw" style="background:${rgbaCss(e.color)}"></span>` +
        `<span class="lk">${e.key}</span><span class="lc">${e.count}</span></div>`,
    )
    .join('');
  const more = c.legend.length > MAX ? `<div class="lmore">그 외 ${c.legend.length - MAX}개…</div>` : '';
  el.innerHTML =
    `<div class="lt">색상 기준 · ${spec.label} <span class="lg">(${c.legend.length}개 그룹)</span></div>` +
    `<div class="lgrid">${rows}</div>${more}` +
    `<div class="ln">같은 색 = 같은 ${spec.label} · 인접 셀로 로컬리티 확인</div>`;
}

// ── Main ─────────────────────────────────────────────────────────────────────

function main(): void {
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  const hud = document.getElementById('hud') as HTMLDivElement;
  const legend = document.getElementById('legend') as HTMLDivElement;
  const controls = document.getElementById('controls') as HTMLDivElement;

  const rng = mulberry32(1337);
  const targets = buildEstate(rng);

  // Precompute colourings for every structural dimension.
  const colorings = new Map<string, DimColoring>();
  for (const d of DIMS) if (d.keyOf) colorings.set(d.id, buildColoring(targets, d.keyOf));

  // 'All' layout: an *affinity* placement built for incident monitoring. The
  // point of the map is to make blast radius legible — resources that fail
  // together should sit together, so a correlated incident lights up one
  // contiguous patch and the eye can judge "where" and "how far". Placement is
  // therefore driven by the estate's failure-correlation dimensions: a
  // force-directed model attracts territories that share a hub (region), then a
  // workload (its prod+dev subscriptions), while every territory repels the rest.
  // Subscriptions become contiguous blobs, resource groups a patch within them,
  // and same-hub subscriptions gather into an organic region — no rigid hexagon.
  // `affinityPath` gives each cell its attribute vector (coarse→fine) + a leaf
  // for sub-ordering; AFFINITY_WEIGHTS tunes the pull. `central` (per resource
  // kind) then pulls shared infrastructure — the spoke network and the hub's
  // connectivity backbone — toward the middle of each cluster, so the map reads
  // as leaf tissue: hub lobes, workload areoles, and network at every core.
  // Deterministic.
  const affinityPath = (t: Target): string[] => [t.hub, t.workload, t.sub, t.rg];
  const AFFINITY_WEIGHTS = [1.1, 1.3, 0]; // hub · workload · subscription (workload = the base cluster)

  // How "shared" each resource kind is → higher values sit nearer the centre of
  // their cluster. Connectivity (vWAN hub, firewall) is the most shared; the
  // network ingress (load balancer, app gateway) is shared across a workload's
  // backends; compute/web/data are workload-specific leaves at the edges.
  const CENTRALITY: Record<string, number> = {
    connectivity: 1.0,
    network: 0.8,
    security: 0.55,
    monitor: 0.5,
    storage: 0.4,
    integration: 0.3,
    data: 0.15,
    web: 0.1,
    compute: 0.1,
  };

  // HexGrid inputs — one cell per resource. `groupPath` is the affinity attribute
  // vector (hub › workload › subscription › resource group); it drives the
  // force-directed 'All' placement and the zoom-out aggregation levels.
  const inputs: WorkloadInput[] = targets.map((t) => ({
    name: t.name,
    size: 1,
    criticality: t.base,
    groupPath: affinityPath(t),
    central: CENTRALITY[t.kind] ?? 0.1,
    label: t.typeCode,
    tooltip: [
      `type: ${t.typeName} (${t.typeCode})`,
      `workload: ${t.workload}`,
      `resource group: ${t.rg}`,
      `subscription: ${t.sub} · ${t.env}`,
      `mgmt group: ${t.mg}`,
      `hub: ${t.hub} · ${t.region}`,
    ],
    resources: t.metrics.map((m) => ({ id: m.id, value: m.base })),
  }));

  // Live data pipeline: a SimulatedSource stands in for a real monitoring
  // backend (Azure Monitor, Prometheus, a WebSocket feed…), streaming batches of
  // correlated incidents that a MonitorFeed routes into the grid. Its group
  // levels [hub, subscription, resource group] reproduce the estate's
  // blast-radius correlation (coarse groups rarer but wider), so dropping in a
  // WebSocketSource later needs no change to the visualization.
  const simEntities: SimEntity[] = targets.map((t) => ({
    id: t.name,
    baseline: t.base,
    groups: [t.hub, t.sub, t.rg],
    resources: t.metrics.map((m) => m.id),
  }));

  // Latest severity per entity, tracked off the same stream for the HUD counts.
  const severity = new Map<string, number>();

  let grid: HexGrid | null = null;
  let source: SimulatedSource | null = null;
  let feed: MonitorFeed | null = null;
  let hudTimer = 0;
  let colorBy = 'health';

  function applyColorBy(id: string): void {
    colorBy = id;
    const g = grid;
    if (!g) return;
    if (id === 'health') {
      g.setColorMode('health');
    } else {
      const dc = colorings.get(id);
      if (dc) {
        targets.forEach((t, i) => g.setTint(t.name, dc.tints[i]));
        g.setColorMode('category');
      }
    }
    setActiveColor(id);
    renderLegend(legend, id, colorings);
  }

  function updateHud(): void {
    const g = grid;
    if (!g) return;
    let critical = 0;
    let warning = 0;
    let incidents = 0;
    for (const v of severity.values()) {
      if (v > 0.75) critical++;
      else if (v > 0.4) warning++;
      if (v > 0.3) incidents++;
    }
    const dim = DIMS.find((d) => d.id === colorBy) ?? DIMS[0];
    hud.innerHTML =
      `<b>${g.fps} fps</b> · ${targets.length.toLocaleString()} resources · ` +
      `<span class="crit">${critical} critical</span> · <span class="warn">${warning} warning</span> · ` +
      `${incidents} incidents<br>` +
      `색상: ${dim.label} · zoom ${g.scene.camera.zoom.toFixed(1)}`;
  }

  // Build the affinity ('All') grid and reset the sim. Each input's groupPath
  // (set above) drives the force-directed placement + zoom-out aggregation.
  function mount(): void {
    if (hudTimer) clearInterval(hudTimer);
    feed?.stop();
    source?.stop();
    grid?.destroy();
    grid = new HexGrid(canvas, {
      workloads: inputs,
      placement: 'affinity',
      affinityWeights: AFFINITY_WEIGHTS,
      firstLayerZoom: 12,
      tweenRate: 4,
    });
    applyColorBy(colorBy);

    // Wire the live feed into the freshly-built grid. Swapping SimulatedSource
    // for a WebSocketSource (or any DataSource) is the only change needed to
    // drive this exact wall from a real monitoring backend.
    severity.clear();
    source = new SimulatedSource({ entities: simEntities, seed: 1337 });
    source.onData((records) => {
      for (const r of records) if (r.severity !== undefined) severity.set(r.id, r.severity);
    });
    feed = new MonitorFeed({ source, target: grid });
    feed.start();

    hudTimer = window.setInterval(updateHud, 250);
  }

  const setActiveColor = renderSegmented(controls, DIMS, applyColorBy);
  mount();
}

main();
