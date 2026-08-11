// Estate Monitor — a whole Azure estate as a honeycomb of resources.
//
// The estate is a real one: an Azure Resource Graph snapshot, folded into the
// demo's data file by tools/build-estate.mjs and pseudonymised on the way
// through. ~62,000 resources across ~580 subscriptions, and the 64,000 links
// between them — which Resource Graph does not store as links at all, but which
// are sitting inside each resource's properties as ARM ids: a NIC's virtual
// machine, a disk's owner, a private endpoint's service.
//
// Every cell is one resource, and the map is Azure's own containment tree drawn
// as nested clusters: a subscription holds resource groups, a resource group
// holds resources, and each level is walled off by an empty moat that widens the
// higher up it sits. Nothing can leave its cluster.
//
// Inside those walls the arrangement is decided by the estate's own wiring.
// Linked resources attract like iron filings around a magnet: a machine gathers
// its NIC and disks into a little molecule, a subscription's resources gather
// onto the VNet they attach to, and a shared vault or workspace is pulled to the
// middle of everything that reaches for it. Resources Azure Resource Health
// reports on carry the live status colour; the config resources it says nothing
// about (VNet, NSG, NIC, public IP, private endpoint, disk) are drawn in a muted
// neutral — they are the scaffolding the layout is built around.
//
// Only the metrics are invented: a snapshot has no time series in it, so the
// live severity is driven by a simulator seeded from the snapshot's own health.
//
// The in-cell glyph is the resource-type code (its "icon"). Colour is driven by
// a chosen criterion — Health (live) or a structural dimension — so switching to
// management group, subscription or service paints the containment levels, and
// correlated incidents light up one whole cluster.

import { HexGrid, type LinkStyle, type PlacementSnapshot } from '../viz/hexgrid';
import { hexToRgba, paletteStops } from '../color';
import type { RGBA } from '../core/types';
import { loadEstate, type Target } from './estate-data';
import { SimulatedSource, MonitorFeed, type SimEntity } from '../data';
import { defineDataset, type LegendEntry } from '../shape';

// What each wire means. A link's kind is the kind of resource it points at, so
// these are the relationships the estate is actually made of — and they are not
// equally interesting: a private endpoint onto a database is a fact worth
// seeing, while the NIC and disks hanging off every machine are so numerous
// that they have to stay quiet or they bury everything else.
// Colour says which kind, thickness and opacity say how much it matters.
interface LinkKind {
  id: string;
  label: string;
  color: string;
  alpha: number;
  width: number;
}
const LINK_KINDS: LinkKind[] = [
  { id: 'connectivity', label: '백본 연결', color: '#22d3ee', alpha: 0.95, width: 1.7 },
  { id: 'network', label: '네트워크 연결', color: '#38bdf8', alpha: 0.75, width: 1.15 },
  { id: 'security', label: '시크릿·자격 증명', color: '#fbbf24', alpha: 0.8, width: 1.05 },
  { id: 'data', label: '데이터 접근', color: '#c084fc', alpha: 0.8, width: 1.05 },
  { id: 'storage', label: '스토리지 접근', color: '#2dd4bf', alpha: 0.7, width: 1 },
  { id: 'integration', label: '메시징', color: '#fb923c', alpha: 0.7, width: 1 },
  { id: 'ai', label: 'AI 서비스', color: '#f472b6', alpha: 0.75, width: 1 },
  { id: 'monitor', label: '모니터링·백업', color: '#818cf8', alpha: 0.55, width: 0.9 },
  { id: 'web', label: '앱 연동', color: '#a3e635', alpha: 0.7, width: 1 },
  { id: 'compute', label: '컴퓨트 부착', color: '#94a3b8', alpha: 0.5, width: 0.85 },
];
const LINK_STYLES: Record<string, LinkStyle> = Object.fromEntries(
  LINK_KINDS.map((k) => [k.id, { color: hexToRgba(k.color, k.alpha), width: k.width }]),
);

// ── Colour dimensions ────────────────────────────────────────────────────────

interface DimSpec {
  id: string;
  label: string;
  keyOf?: (t: Target) => string;
}
const DIMS: DimSpec[] = [
  { id: 'health', label: '상태 (Health)' },
  { id: 'mgtop', label: '관리 그룹(상위)', keyOf: (t) => t.mgTop },
  { id: 'mg', label: '관리 그룹', keyOf: (t) => t.mg },
  { id: 'hub', label: '허브 (vWAN)', keyOf: (t) => t.hub },
  { id: 'sub', label: '구독', keyOf: (t) => t.sub },
  { id: 'rg', label: '리소스 그룹', keyOf: (t) => t.rg },
  { id: 'service', label: '서비스', keyOf: (t) => t.service },
  { id: 'env', label: '환경', keyOf: (t) => t.env },
  { id: 'grade', label: '서비스 등급', keyOf: (t) => t.grade },
  { id: 'region', label: '리전', keyOf: (t) => t.region },
  { id: 'type', label: '리소스 종류', keyOf: (t) => t.typeCode },
];

// ── UI ───────────────────────────────────────────────────────────────────────

function healthStops(): RGBA[] {
  // `status` runs critical→healthy; reverse for a healthy→critical legend ramp.
  return paletteStops('status').slice().reverse();
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

/** Swatches for the wire kinds actually present, drawn at their own thickness
 *  and opacity so the legend reads the way the map does. Each row toggles its
 *  kind on the map. */
function wireLegend(kinds: LinkKind[], hidden: Set<string>): string {
  if (kinds.length === 0) return '';
  const rows = kinds
    .map((k) => {
      const off = hidden.has(k.id);
      return (
        `<div class="lrow wk${off ? ' off' : ''}" data-kind="${k.id}">` +
        `<span class="lw" style="background:${k.color};opacity:${off ? 0.25 : k.alpha};` +
        `height:${Math.max(2, Math.round(k.width * 2))}px"></span>` +
        `<span class="lk">${k.label}</span></div>`
      );
    })
    .join('');
  return (
    `<div class="lt lwt">연결선 종류 <span class="lg">(클릭=끄기)</span></div>` +
    `<div class="lgrid">${rows}</div>`
  );
}

function renderLegend(
  el: HTMLElement,
  dimId: string,
  legends: Map<string, LegendEntry[]>,
  wireKinds: LinkKind[],
  hidden: Set<string>,
): void {
  const spec = DIMS.find((d) => d.id === dimId) ?? DIMS[0];
  if (dimId === 'health') {
    const stops = healthStops().map((c) => rgbaCss(c)).join(', ');
    el.innerHTML =
      `<div class="lt">색상 기준 · ${spec.label}</div>` +
      `<div style="height:10px;border-radius:3px;background:linear-gradient(90deg, ${stops})"></div>` +
      `<div class="lr"><span>healthy</span><span>warning</span><span>critical</span></div>` +
      `<div class="ln">색 = 심각도 · 이상 발생 시 붉게 점멸</div>` +
      wireLegend(wireKinds, hidden);
    return;
  }
  const entries = legends.get(dimId);
  if (!entries) return;
  const MAX = 12;
  const shown = entries.slice(0, MAX);
  const rows = shown
    .map(
      (e) =>
        `<div class="lrow"><span class="sw" style="background:${rgbaCss(e.color)}"></span>` +
        `<span class="lk">${e.key}</span><span class="lc">${e.count}</span></div>`,
    )
    .join('');
  const more = entries.length > MAX ? `<div class="lmore">그 외 ${entries.length - MAX}개…</div>` : '';
  el.innerHTML =
    `<div class="lt">색상 기준 · ${spec.label} <span class="lg">(${entries.length}개 그룹)</span></div>` +
    `<div class="lgrid">${rows}</div>${more}` +
    `<div class="ln">같은 색 = 같은 ${spec.label} · 인접 셀로 로컬리티 확인</div>` +
    wireLegend(wireKinds, hidden);
}

// ── Main ─────────────────────────────────────────────────────────────────────

// A baked layout is kept in IndexedDB. Laying ~50k resources out costs seconds,
// but the reason to keep it is that this is a packing: adding one resource
// shifts everything after it, and a monitoring wall is only useful once someone
// has learned where things are. A real deployment would bake it server-side, so
// every operator sees the same map rather than one per browser.
const LAYOUT_DB = 'monify-estate';
const LAYOUT_STORE = 'layout';
const LAYOUT_ID = 'force';

function openLayoutDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(LAYOUT_DB, 1);
      req.onupgradeneeded = (): void => {
        req.result.createObjectStore(LAYOUT_STORE);
      };
      req.onsuccess = (): void => resolve(req.result);
      req.onerror = (): void => resolve(null);
    } catch {
      resolve(null); // blocked storage: just lay the estate out again
    }
  });
}

async function loadLayout(): Promise<PlacementSnapshot | null> {
  const db = await openLayoutDb();
  if (!db) return null;
  return new Promise((resolve) => {
    const req = db.transaction(LAYOUT_STORE, 'readonly').objectStore(LAYOUT_STORE).get(LAYOUT_ID);
    req.onsuccess = (): void => resolve((req.result as PlacementSnapshot | undefined) ?? null);
    req.onerror = (): void => resolve(null);
  });
}

async function saveLayout(snap: PlacementSnapshot): Promise<void> {
  const db = await openLayoutDb();
  if (!db) return;
  db.transaction(LAYOUT_STORE, 'readwrite').objectStore(LAYOUT_STORE).put(snap, LAYOUT_ID);
}

async function main(): Promise<void> {
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  const hud = document.getElementById('hud') as HTMLDivElement;
  const legend = document.getElementById('legend') as HTMLDivElement;
  const controls = document.getElementById('controls') as HTMLDivElement;
  const relationControls = document.getElementById('relations') as HTMLDivElement;
  const focusControls = document.getElementById('focus') as HTMLDivElement;

  const estate = await loadEstate();
  const targets = estate.targets;

  // Declare what the rows mean once; the shape toolkit derives the cells, the
  // categorical colourings and their legends from this single description.
  const ds = defineDataset<Target>({
    data: targets,
    id: (t) => t.name,
    // Containment, outermost first: the management group that governs a
    // subscription, the subscription, and the resource group. The hub is not a
    // wall — it pulls (see `anchor` below), so spokes compete for it against
    // everything else holding them.
    hierarchy: {
      mg: (t) => t.mg,
      sub: (t) => t.sub,
      rg: (t) => t.rg,
    },
    measures: { severity: { value: (t) => t.base, agg: 'worst', domain: [0, 1] } },
    dimensions: Object.fromEntries(
      DIMS.flatMap((d) => (d.keyOf ? [[d.id, { of: d.keyOf, label: d.label }]] : [])),
    ),
  });

  // One legend per structural dimension (colours assigned by descending count).
  const legends = new Map<string, LegendEntry[]>();
  for (const d of DIMS) if (d.keyOf) legends.set(d.id, ds.legend(d.id));

  // Where a resource sits is an argument between the things Azure says about
  // it, and these numbers are the terms of that argument. Cohesion is graded by
  // depth — a resource group holds its contents hardest, a subscription holds
  // its groups less, a management group holds its subscriptions least — so the
  // three levels stay separately readable instead of fusing into one mass.
  // Against them pull the dependencies (a private endpoint toward its database)
  // and the Virtual WAN hub (every subscription peered to the same one drifts
  // together), which is what makes a fault's position tell you whose it is.
  const COHESION = [0.012, 0.03, 0.075, 0.16];
  const MOATS = [4, 2, 1];
  const LINK_K = 0.035;
  const HUB_K = 0.014;

  // HexGrid inputs — one cell per resource.
  const compiled = ds.toHexGrid(
    {
      status: { by: 'severity' },
      label: (t) => t.typeCode,
      central: (t) => t.central,
      monitored: (t) => t.monitored,
      links: (t) => t.deps,
      anchor: (t) => t.hub,
      resources: (t) => t.metrics.map((m) => ({ id: m.id, value: m.base })),
      tooltip: (t) => [
        `type: ${t.typeName} (${t.typeCode})`,
        ...(t.monitored ? [] : ['health: not reported by Resource Health']),
        `resource group: ${t.rg}`,
        `subscription: ${t.sub} · ${t.env}`,
        `hub: ${t.hub}`,
        `mgmt group: ${t.mgTop} › ${t.mg}`,
        `service: ${t.service} · grade ${t.grade}`,
        `region: ${t.region}`,
        ...(t.deps.length > 0
          ? [
              `linked to: ${t.deps.slice(0, 3).map((d) => `${d.id} (${d.kind})`).join(', ')}` +
                (t.deps.length > 3 ? ` (+${t.deps.length - 3} more)` : ''),
            ]
          : []),
      ],
    },
    { placement: 'force', moats: MOATS },
  );

  // Live data pipeline: a SimulatedSource stands in for a real monitoring
  // backend (Azure Monitor, Prometheus, a WebSocket feed…), streaming batches of
  // correlated incidents that a MonitorFeed routes into the grid. Its group
  // levels [management group, subscription, resource group] reproduce the way a
  // real fault spreads (coarse groups rarer but wider), so dropping in a
  // WebSocketSource later needs no change to the visualization. Only resources
  // Resource Health reports on take part; the config scaffolding stays neutral.
  const simEntities: SimEntity[] = targets
    .filter((t) => t.monitored)
    .map((t) => ({
      id: t.name,
      baseline: t.base,
      groups: [t.mg, t.sub, t.rg],      resources: t.metrics.map((m) => m.id),
    }));

  // Latest severity per entity, tracked off the same stream for the HUD counts.
  const severity = new Map<string, number>();

  // Only the link kinds this estate actually contains reach the legend.
  const present = new Set<string>();
  for (const t of targets) for (const d of t.deps) present.add(d.kind);
  const wireKinds = LINK_KINDS.filter((k) => present.has(k.id));

  let grid: HexGrid | null = null;
  let source: SimulatedSource | null = null;
  let feed: MonitorFeed | null = null;
  let hudTimer = 0;
  let colorBy = 'health';
  let relations = true;
  let focusMode = false;
  const hiddenKinds = new Set<string>();
  let savedLayout: PlacementSnapshot | null = null;

  function drawLegend(): void {
    renderLegend(legend, colorBy, legends, relations ? wireKinds : [], hiddenKinds);
  }

  // The wire-kind rows in the legend double as switches for their kind.
  legend.addEventListener('click', (e) => {
    const row = (e.target as HTMLElement).closest('.wk');
    const kind = row?.getAttribute('data-kind');
    if (!kind) return;
    const show = hiddenKinds.has(kind);
    if (show) hiddenKinds.delete(kind);
    else hiddenKinds.add(kind);
    grid?.setLinkKindVisible(kind, show);
    drawLegend();
  });

  function applyColorBy(id: string): void {
    colorBy = id;
    const g = grid;
    if (!g) return;
    if (id === 'health') {
      g.setColorMode('health');
    } else {
      const tints = ds.tints(id);
      targets.forEach((t, i) => g.setTint(t.name, tints[i]));
      g.setColorMode('category');
    }
    setActiveColor(id);
    drawLegend();
  }

  // Zoomed in, every cell gets the bed of the resource group it lives in and a
  // wire to each resource it is attached to. Turning it off leaves the bare
  // honeycomb, which is the fair comparison for what the cues actually add.
  function applyRelations(id: string): void {
    relations = id === 'on';
    grid?.setRelations(relations);
    setActiveRelations(id);
    drawLegend();
  }

  // Hover focus is a mode rather than always-on: it redraws the map for every
  // cell the pointer touches, which flickers when you are only moving across.
  function applyFocusMode(id: string): void {
    focusMode = id === 'on';
    grid?.setFocusMode(focusMode);
    setActiveFocus(id);
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
      `색상: ${dim.label} · zoom ${g.scene.camera.zoom.toFixed(1)}<br>` +
      `<span style="opacity:.65">Resource Graph 스냅샷 ${estate.generated}` +
      `${estate.anonymized ? ' · 식별자 가명 처리됨' : ' · 실명'}</span>`;
  }

  // Build the containment grid and reset the sim. Each input's groupPath (the
  // management group › subscription › resource group it lives in) walls the
  // clusters, while its `deps` arrange the contents inside them.
  function mount(): void {
    if (hudTimer) clearInterval(hudTimer);
    feed?.stop();
    source?.stop();
    grid?.destroy();
    grid = new HexGrid(canvas, {
      workloads: compiled.workloads,
      placement: compiled.placement,
      moats: compiled.moats,
      cohesion: COHESION,
      linkK: LINK_K,
      anchorK: HUB_K,
      affinityWeights: compiled.affinityWeights,
      firstLayerZoom: 12,
      layout: savedLayout,
      onLayout: (snap) => {
        savedLayout = snap;
        void saveLayout(snap);
      },
      // Off for now: the zoomed-out view shows every cell, so the nesting and
      // the wiring that shapes it stay visible instead of folding into glyphs.
      aggregate: false,
      tweenRate: 4,
      relations,
      focusMode,
      linkStyles: LINK_STYLES,
    });
    for (const k of hiddenKinds) grid.setLinkKindVisible(k, false);
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
  const setActiveRelations = renderSegmented(
    relationControls,
    [
      { id: 'on', label: '바탕+연결선' },
      { id: 'off', label: '끄기' },
    ],
    applyRelations,
  );
  setActiveRelations('on');
  const setActiveFocus = renderSegmented(
    focusControls,
    [
      { id: 'on', label: '연결만 강조' },
      { id: 'off', label: '끄기' },
    ],
    applyFocusMode,
  );
  setActiveFocus('off');
  savedLayout = await loadLayout();
  mount();
}

// A missing snapshot is a setup problem, not a crash — say what to run.
void main().catch((err: unknown) => {
  const hud = document.getElementById('hud');
  if (hud) {
    hud.innerHTML =
      `<b class="crit">데이터 없음</b><br><span style="opacity:.8">${String(err)}</span>`;
  }
  console.error(err);
});
