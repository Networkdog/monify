// Build the Estate Monitor dataset from an Azure Resource Graph dump.
//
// The demo used to invent its estate. This reads a real one instead: an NDJSON
// dump of the Resource Graph tables (one JSON record per line, as returned by
// `az graph query`) and folds it into the compact file the demo loads.
//
// What comes from the dump: the containment tree (management groups →
// subscriptions → resource groups → resources), every resource's type, and the
// wiring between them — which is not modelled anywhere in Resource Graph as
// links, but is sitting in plain sight inside each resource's `properties` as
// ARM resource ids (a NIC's `virtualMachine.id`, a disk's `managedBy`, a private
// endpoint's `privateLinkServiceId`, …). Scanning for those ids recovers the
// real dependency graph across every resource type without a rule per type.
// Live metrics stay simulated — a snapshot has no time series in it.
//
// Identifiers are pseudonymised by default: the shape, counts, types, wiring and
// health distribution are kept exactly, while subscription / resource-group /
// resource / management-group / service names are replaced by stable codenames
// and every GUID is dropped. Pass --real to keep the originals (local use only).
//
//   node tools/build-estate.mjs --dump <dir> [--out public/estate.json] [--real]

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

// ── Resource type catalog ────────────────────────────────────────────────────
//
// [code, display name, kind, centrality, monitored]. `kind` also types the wires
// drawn to a resource (a link's kind is the kind of what it points at), and
// `centrality` is how shared a resource is inside its cluster (1 = the thing
// everything else attaches to), which is what pulls it to the middle.
// `monitored` marks the resources Azure Resource Health reports on; the rest are
// the config scaffolding — they still shape the map and carry the wiring, but
// they are drawn neutral and take no part in the status roll-up.
// Types missing from this table are dropped: the estate is full of alert rules,
// snapshots and extensions that say nothing about how the estate is put together.
// Image galleries are left out for a different reason — every disk and machine
// built from one points at it, so a single gallery arrives as a star of nine
// thousand links that is about the image supply chain, not about what runs.
const TYPES = {
  // Compute
  'microsoft.compute/virtualmachines': ['VM', 'Virtual Machine', 'compute', 0.1, true],
  'microsoft.compute/virtualmachinescalesets': ['VMSS', 'VM Scale Set', 'compute', 0.12, true],
  'microsoft.containerservice/managedclusters': ['AKS', 'AKS Cluster', 'compute', 0.15, true],
  'microsoft.sqlvirtualmachine/sqlvirtualmachines': ['SQLVM', 'SQL on VM', 'compute', 0.12, true],
  // Web / apps
  'microsoft.web/sites': ['APP', 'App Service', 'web', 0.1, true],
  'microsoft.web/serverfarms': ['PLAN', 'App Service Plan', 'web', 0.45, true],
  'microsoft.app/containerapps': ['CAPP', 'Container App', 'web', 0.1, true],
  'microsoft.app/managedenvironments': ['CENV', 'Container Apps Env', 'web', 0.6, true],
  'microsoft.logic/workflows': ['LOGIC', 'Logic App', 'web', 0.15, true],
  'microsoft.apimanagement/service': ['APIM', 'API Management', 'web', 0.6, true],
  // Data
  'microsoft.sql/servers': ['SQL', 'Azure SQL Server', 'data', 0.2, true],
  'microsoft.sql/servers/databases': ['SQLDB', 'Azure SQL DB', 'data', 0.15, true],
  'microsoft.sql/managedinstances': ['MI', 'SQL Managed Instance', 'data', 0.25, true],
  'microsoft.sql/managedinstances/databases': ['MIDB', 'Managed Instance DB', 'data', 0.15, true],
  'microsoft.dbforpostgresql/flexibleservers': ['PG', 'PostgreSQL', 'data', 0.18, true],
  'microsoft.dbformysql/flexibleservers': ['MYSQL', 'MySQL', 'data', 0.18, true],
  'microsoft.documentdb/databaseaccounts': ['COS', 'Cosmos DB', 'data', 0.2, true],
  'microsoft.cache/redis': ['RDS', 'Redis Cache', 'data', 0.22, true],
  'microsoft.cache/redisenterprise': ['RDSE', 'Redis Enterprise', 'data', 0.22, true],
  'microsoft.search/searchservices': ['SRCH', 'AI Search', 'data', 0.25, true],
  'microsoft.databricks/workspaces': ['DBX', 'Databricks', 'data', 0.3, true],
  'microsoft.datafactory/factories': ['ADF', 'Data Factory', 'data', 0.3, true],
  'microsoft.synapse/workspaces': ['SYN', 'Synapse', 'data', 0.3, true],
  // Storage
  'microsoft.storage/storageaccounts': ['STG', 'Storage Account', 'storage', 0.4, true],
  'microsoft.compute/disks': ['DISK', 'Managed Disk', 'storage', 0.05, false],
  'microsoft.compute/diskencryptionsets': ['DES', 'Disk Encryption Set', 'storage', 0.5, false],
  'microsoft.netapp/netappaccounts': ['ANF', 'NetApp Files', 'storage', 0.4, true],
  'microsoft.containerregistry/registries': ['ACR', 'Container Registry', 'storage', 0.5, true],
  // Integration
  'microsoft.servicebus/namespaces': ['SB', 'Service Bus', 'integration', 0.3, true],
  'microsoft.eventhub/namespaces': ['EH', 'Event Hub', 'integration', 0.3, true],
  'microsoft.eventgrid/topics': ['EGT', 'Event Grid Topic', 'integration', 0.3, true],
  'microsoft.relay/namespaces': ['RELAY', 'Relay', 'integration', 0.3, true],
  // Security / identity
  'microsoft.keyvault/vaults': ['KV', 'Key Vault', 'security', 0.55, true],
  'microsoft.managedidentity/userassignedidentities': ['MSI', 'Managed Identity', 'security', 0.6, false],
  'microsoft.network/firewallpolicies': ['FWP', 'Firewall Policy', 'security', 0.7, false],
  'microsoft.network/applicationgatewaywebapplicationfirewallpolicies': ['WAF', 'WAF Policy', 'security', 0.6, false],
  'microsoft.network/frontdoorwebapplicationfirewallpolicies': ['FDWAF', 'Front Door WAF', 'security', 0.6, false],
  // Monitor
  'microsoft.operationalinsights/workspaces': ['LAW', 'Log Analytics', 'monitor', 0.55, true],
  'microsoft.insights/components': ['AI', 'Application Insights', 'monitor', 0.4, false],
  'microsoft.monitor/accounts': ['AMW', 'Monitor Workspace', 'monitor', 0.5, true],
  'microsoft.dashboard/grafana': ['GRAF', 'Managed Grafana', 'monitor', 0.4, true],
  'microsoft.recoveryservices/vaults': ['RSV', 'Recovery Services Vault', 'monitor', 0.5, true],
  'microsoft.dataprotection/backupvaults': ['BV', 'Backup Vault', 'monitor', 0.5, true],
  'microsoft.automation/automationaccounts': ['AA', 'Automation Account', 'monitor', 0.45, true],
  // Network
  'microsoft.network/virtualnetworks': ['VNET', 'Virtual Network', 'network', 0.92, false],
  'microsoft.network/networkinterfaces': ['NIC', 'Network Interface', 'network', 0.2, false],
  'microsoft.network/networksecuritygroups': ['NSG', 'Network Security Group', 'network', 0.5, false],
  'microsoft.network/publicipaddresses': ['PIP', 'Public IP', 'network', 0.25, false],
  'microsoft.network/privateendpoints': ['PE', 'Private Endpoint', 'network', 0.35, false],
  'microsoft.network/routetables': ['RT', 'Route Table', 'network', 0.5, false],
  'microsoft.network/loadbalancers': ['LB', 'Load Balancer', 'network', 0.6, true],
  'microsoft.network/applicationgateways': ['AGW', 'Application Gateway', 'network', 0.6, true],
  'microsoft.network/privatednszones': ['PDNS', 'Private DNS Zone', 'network', 0.7, false],
  'microsoft.network/natgateways': ['NAT', 'NAT Gateway', 'network', 0.6, true],
  'microsoft.network/trafficmanagerprofiles': ['TM', 'Traffic Manager', 'network', 0.6, true],
  'microsoft.cdn/profiles': ['CDN', 'Front Door / CDN', 'network', 0.6, true],
  'microsoft.network/networksecurityperimeters': ['NSP', 'Network Security Perimeter', 'network', 0.7, false],
  // Connectivity — the backbone every spoke hangs off
  'microsoft.network/virtualhubs': ['VHUB', 'Virtual WAN Hub', 'connectivity', 1.0, true],
  'microsoft.network/virtualwans': ['VWAN', 'Virtual WAN', 'connectivity', 1.0, true],
  'microsoft.network/azurefirewalls': ['FW', 'Azure Firewall', 'connectivity', 0.95, true],
  'microsoft.network/virtualnetworkgateways': ['VNGW', 'VPN / ER Gateway', 'connectivity', 0.9, true],
  'microsoft.network/expressroutecircuits': ['ER', 'ExpressRoute Circuit', 'connectivity', 0.9, true],
  'microsoft.network/connections': ['CONN', 'Gateway Connection', 'connectivity', 0.85, true],
  // AI
  'microsoft.cognitiveservices/accounts': ['AOAI', 'Azure AI Services', 'ai', 0.3, true],
  'microsoft.machinelearningservices/workspaces': ['AML', 'Machine Learning', 'ai', 0.35, true],
  'microsoft.bing/accounts': ['BING', 'Bing Search', 'ai', 0.3, true],
};

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { dump: '', out: 'public/estate.json', real: false, report: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dump') out.dump = argv[++i];
    else if (argv[i] === '--out') out.out = argv[++i];
    else if (argv[i] === '--real') out.real = true;
    else if (argv[i] === '--report') out.report = true;
  }
  if (!out.dump) {
    console.error(
      'usage: node tools/build-estate.mjs --dump <dir> [--out public/estate.json] [--real] [--report]',
    );
    process.exit(2);
  }
  return out;
}

async function* records(file) {
  if (!fs.existsSync(file)) return;
  const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      yield JSON.parse(line);
    } catch {
      /* a truncated tail line is not worth failing the build over */
    }
  }
}

// ── Pseudonyms ───────────────────────────────────────────────────────────────
//
// Stable codenames, so the same dump always yields the same map and a reader can
// still follow "which subscription is this" across screenshots — without any of
// it pointing back at the tenant it came from.

const WORDS = [
  'atlas', 'borealis', 'cinder', 'delta', 'ember', 'fjord', 'gale', 'harbor',
  'indigo', 'juniper', 'kestrel', 'lumen', 'meridian', 'nimbus', 'onyx', 'pallas',
  'quarry', 'ridge', 'summit', 'tundra', 'umber', 'vertex', 'willow', 'xenon',
  'yarrow', 'zephyr', 'amber', 'basalt', 'cobalt', 'dune', 'echo', 'flint',
  'granite', 'halcyon', 'ivory', 'jasper', 'kelp', 'larkspur', 'monsoon', 'nova',
  'orchid', 'prism', 'quartz', 'rowan', 'slate', 'thistle', 'ulmus', 'verdant',
];

function fnv1a(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** A codename generator that never hands out the same name twice. */
function codenames(prefix) {
  const taken = new Map();
  const used = new Set();
  return (original) => {
    let name = taken.get(original);
    if (name) return name;
    const h = fnv1a(original);
    let i = 0;
    do {
      const w = WORDS[(h + i * 7) % WORDS.length];
      const n = ((h >>> 8) + i * 13) % 100;
      name = `${prefix}${w}${String(n).padStart(2, '0')}`;
      i++;
    } while (used.has(name));
    used.add(name);
    taken.set(original, name);
    return name;
  };
}

// ── ARM ids ──────────────────────────────────────────────────────────────────

const ID_RE = /^\/subscriptions\/[^/]+\/resourcegroups\/[^/]+\/providers\/[^/]+\/[^/]+\/[^/]+/i;

/**
 * Collect every ARM resource id reachable inside a value. Resource Graph has no
 * link table, so this is where the estate's wiring actually lives: a NIC points
 * at its VM and subnet, a private endpoint at the service it fronts, a VM at its
 * disks. Sub-resource ids (a subnet, an ip configuration) are resolved to the
 * resource that owns them by the caller.
 */
function collectIds(value, out, depth = 0) {
  if (out.size >= 48 || depth > 6) return;
  if (typeof value === 'string') {
    if (value.length > 40 && ID_RE.test(value)) out.add(value.toLowerCase());
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectIds(v, out, depth + 1);
    return;
  }
  if (value && typeof value === 'object') {
    for (const k in value) collectIds(value[k], out, depth + 1);
  }
}

/** Longest known-resource prefix of an ARM id: `…/virtualNetworks/x/subnets/y` → the VNet. */
function resolveId(id, known) {
  if (known.has(id)) return id;
  let cur = id;
  for (let i = 0; i < 4; i++) {
    const cut = cur.lastIndexOf('/', cur.lastIndexOf('/') - 1);
    if (cut <= 0) return null;
    cur = cur.slice(0, cut);
    if (known.has(cur)) return cur;
  }
  return null;
}

/**
 * The hub a spoke hangs off, read from the name of the network it peers with.
 * A Virtual WAN hub connection shows up on the spoke as a peering named
 * `HV_<hub>_<guid>` to the hub's managed network, so the hub's own name is right
 * there even when the hub itself lives in a subscription outside the dump.
 */
function hubLabel(remoteId) {
  const name = remoteId.split('/').pop() ?? '';
  const m = /^HV_(.+?)_[0-9a-f-]{8,}$/i.exec(name);
  return (m ? m[1] : name).replace(/[-_]+$/, '');
}

// ── Build ────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const dump = (f) => path.join(opts.dump, f);
  const t0 = Date.now();

  // 1) Containers: subscriptions carry the management-group chain and the tags
  //    that say what service they belong to; resource groups carry their region.
  const subs = new Map();
  const rgLoc = new Map();
  const rgDisplay = new Map();
  for await (const c of records(dump('resourcecontainers.ndjson'))) {
    const type = (c.type ?? '').toLowerCase();
    if (type === 'microsoft.resources/subscriptions') {
      const chain = c.properties?.managementGroupAncestorsChain ?? [];
      const tags = c.tags ?? {};
      subs.set((c.subscriptionId ?? '').toLowerCase(), {
        name: c.name ?? c.subscriptionId,
        // The chain arrives leaf-first; the demo wants it root-first.
        mgPath: chain.map((m) => m.displayName || m.name).reverse(),
        env: (tags.Environment ?? tags.environment ?? '').toLowerCase() || 'unset',
        service: tags.Service ?? tags.service ?? '',
        grade: tags.ServiceGrade ?? tags.serviceGrade ?? '',
      });
    } else if (type === 'microsoft.resources/subscriptions/resourcegroups') {
      rgLoc.set((c.id ?? '').toLowerCase(), c.location ?? '');
      // Resource Graph lower-cases the `resourceGroup` column; the container
      // record is the only place the name keeps the casing it was created with.
      rgDisplay.set((c.id ?? '').toLowerCase(), c.name ?? '');
    }
  }

  // 2) Resources: keep the ones that say something about how the estate is built,
  //    and remember every ARM id they mention for the wiring pass.
  const kept = [];
  const byId = new Map();
  const rawLinks = [];
  const droppedByType = new Map();
  // Votes for which hub each subscription hangs off, tallied from its networks.
  const hubVotes = new Map();
  let scanned = 0;
  let dropped = 0;
  let orphaned = 0;
  for await (const r of records(dump('resources.ndjson'))) {
    scanned++;
    const type = (r.type ?? '').toLowerCase();
    const spec = TYPES[type];
    if (!spec) {
      dropped++;
      droppedByType.set(type, (droppedByType.get(type) ?? 0) + 1);
      continue;
    }
    const sub = subs.get((r.subscriptionId ?? '').toLowerCase());
    if (!sub || !r.resourceGroup) {
      dropped++;
      orphaned++;
      continue;
    }
    const id = (r.id ?? '').toLowerCase();
    const idx = kept.length;
    byId.set(id, idx);
    kept.push({
      id,
      name: r.name ?? '',
      spec,
      sub: (r.subscriptionId ?? '').toLowerCase(),
      rg: r.resourceGroup.toLowerCase(),
      location: r.location || rgLoc.get(`/subscriptions/${r.subscriptionId}/resourcegroups/${r.resourceGroup}`.toLowerCase()) || '',
    });
    const ids = new Set();
    if (r.managedBy) collectIds(r.managedBy, ids);
    collectIds(r.properties, ids);
    ids.delete(id);
    if (ids.size > 0) rawLinks.push([idx, [...ids]]);

    if (type === 'microsoft.network/virtualnetworks') {
      const sub = (r.subscriptionId ?? '').toLowerCase();
      for (const p of r.properties?.virtualNetworkPeerings ?? []) {
        const remote = p.properties?.remoteVirtualNetwork?.id;
        if (!remote) continue;
        const key = `${sub}\u0001${hubLabel(remote)}`;
        hubVotes.set(key, (hubVotes.get(key) ?? 0) + 1);
      }
    }
  }

  // A subscription's hub is whichever one most of its networks peer with.
  const hubOfSub = new Map();
  for (const [key, n] of hubVotes) {
    const [sub, hub] = key.split('\u0001');
    const cur = hubOfSub.get(sub);
    if (!cur || n > cur.n) hubOfSub.set(sub, { hub, n });
  }

  // 3) Wiring: resolve the collected ids against the resources actually kept.
  const known = new Set(byId.keys());
  const edges = [];
  const seen = new Set();
  const degree = new Int32Array(kept.length);
  for (const [from, ids] of rawLinks) {
    for (const raw of ids) {
      const target = resolveId(raw, known);
      if (!target) continue;
      const to = byId.get(target);
      if (to === undefined || to === from) continue;
      const key = from < to ? `${from}:${to}` : `${to}:${from}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push(from, to);
      degree[from]++;
      degree[to]++;
    }
  }

  // How shared a resource is, taken from how much of the estate points at it
  // rather than guessed per type. This is what pulls a resource toward the
  // middle of its cluster, and the honest answer is in the wiring: a subscription
  // VNet has a thousand things hanging off it, a managed disk has one. A fixed
  // per-type value instead sorts every cell by type radius, which turns a large
  // subscription into concentric rings of disks, machines and interfaces.
  const centralOf = (i) => {
    const byDegree = Math.min(1, Math.log1p(degree[i]) / Math.log1p(64));
    return Math.round(Math.max(byDegree, kept[i].spec[3] * 0.3) * 100) / 100;
  };

  // 4) Real health, where Azure reports any: it only covers compute, and mostly
  //    says "Unknown", but the handful of genuinely unavailable machines gives
  //    the wall real faults to open on before the simulator takes over.
  const health = new Map();
  for await (const h of records(dump('healthresources.ndjson'))) {
    const target = (h.properties?.targetResourceId ?? '').toLowerCase();
    const state = h.properties?.availabilityState ?? '';
    if (target && state) health.set(target, state);
  }
  const SEVERITY = { Unavailable: 0.95, Degraded: 0.6, Available: 0.05 };

  // 5) Names. Pseudonymised unless --real: the map keeps its shape either way.
  //    Resource names have to stay unique whichever mode this runs in — the
  //    visualization resolves every link by name, so two resources sharing one
  //    would silently rewire the estate.
  const usedNames = new Set();
  const unique = (base) => {
    let name = base;
    for (let i = 2; usedNames.has(name); i++) name = `${base}-${i}`;
    usedNames.add(name);
    return name;
  };
  const mgName = opts.real ? (s) => s : codenames('mg-');
  const svcName = opts.real ? (s) => s : codenames('svc-');
  const hubName = opts.real ? (s) => s : codenames('hub-');
  const subToken = codenames('');

  const mgDict = [];
  const mgIdx = new Map();
  const intern = (name) => {
    let i = mgIdx.get(name);
    if (i === undefined) {
      i = mgDict.length;
      mgIdx.set(name, i);
      mgDict.push(name);
    }
    return i;
  };

  // Levels every subscription shares — the tenant root, and usually one
  // company-wide group under it — say nothing about a resource, so they are
  // dropped rather than drawn as a wall around the entire estate.
  const paths = [...subs.values()].map((s) => s.mgPath);
  let common = 0;
  while (
    paths.every((p) => p.length > common + 1 && p[common] === paths[0][common])
  ) {
    common++;
  }

  const subList = [];
  const subIdx = new Map();
  const subTokens = [];
  for (const [id, s] of subs) {
    const path = s.mgPath.slice(common).map((m) => intern(mgName(m)));
    const token = subToken(s.name);
    const hub = hubOfSub.get(id)?.hub;
    subIdx.set(id, subList.length);
    subTokens.push(token);
    subList.push([
      opts.real ? s.name : `sub-${token}`,
      path,
      s.env,
      s.service ? svcName(s.service) : '',
      s.grade || '',
      hub ? hubName(hub) : '',
    ]);
  }

  const rgList = [];
  const rgIdx = new Map();
  const rgSeq = new Map();
  const subSeq = new Map();
  const resList = [];
  const typeDict = [];
  const typeIdx = new Map();
  const locDict = [];
  const locIdx = new Map();
  const internIn = (dict, idx, key) => {
    let i = idx.get(key);
    if (i === undefined) {
      i = dict.length;
      idx.set(key, i);
      dict.push(key);
    }
    return i;
  };

  // The dump lists a resource group's contents type by type — hundreds of disks,
  // then hundreds of interfaces — and a cluster grows from the middle outward,
  // so handing that order straight over draws a large subscription as concentric
  // rings of one type each. Interleave the types inside each group, keeping the
  // groups themselves in the order they appeared, so a cluster's contents arrive
  // mixed and the layout is free to arrange them by what they are wired to.
  const groupSeq = new Map();
  const typeSeq = new Map();
  const rank = new Int32Array(kept.length);
  const groupOf = new Int32Array(kept.length);
  for (let i = 0; i < kept.length; i++) {
    const gk = `${kept[i].sub}/${kept[i].rg}`;
    let g = groupSeq.get(gk);
    if (g === undefined) {
      g = groupSeq.size;
      groupSeq.set(gk, g);
    }
    groupOf[i] = g;
    const tk = `${g}\u0001${kept[i].spec[0]}`;
    const n = typeSeq.get(tk) ?? 0;
    typeSeq.set(tk, n + 1);
    rank[i] = n;
  }
  const order = Array.from(kept.keys()).sort(
    (a, b) => groupOf[a] - groupOf[b] || rank[a] - rank[b] || a - b,
  );
  const pos = new Int32Array(kept.length);
  for (let n = 0; n < order.length; n++) pos[order[n]] = n;
  for (let i = 0; i < edges.length; i++) edges[i] = pos[edges[i]];

  for (const oldIdx of order) {
    const r = kept[oldIdx];    const sKey = subIdx.get(r.sub);
    const rgKey = `${r.sub}/${r.rg}`;
    let g = rgIdx.get(rgKey);
    if (g === undefined) {
      g = rgList.length;
      rgIdx.set(rgKey, g);
      const n = (rgSeq.get(sKey) ?? 0) + 1;
      rgSeq.set(sKey, n);
      const real = rgDisplay.get(`/subscriptions/${r.sub}/resourcegroups/${r.rg}`) || r.rg;
      rgList.push([opts.real ? real : `rg-${subTokens[sKey]}-${String(n).padStart(2, '0')}`, sKey]);
    }
    const t = internIn(typeDict, typeIdx, r.spec[0]);
    const l = internIn(locDict, locIdx, r.location || 'global');
    const state = health.get(r.id);
    const base = state ? (SEVERITY[state] ?? -1) : -1;
    // Numbered inside its subscription, so a pseudonym reads like a name from
    // where it lives instead of a global counter.
    const seq = (subSeq.get(sKey) ?? 0) + 1;
    subSeq.set(sKey, seq);
    const label = unique(
      opts.real ? r.name : `${r.spec[0].toLowerCase()}-${subTokens[sKey]}-${String(seq).padStart(3, '0')}`,
    );
    resList.push([label, t, g, l, base, centralOf(oldIdx)]);
  }

  // The type dictionary is emitted with its full spec so the demo needs no copy.
  const typeSpecs = typeDict.map((code) => {
    const entry = Object.values(TYPES).find((v) => v[0] === code);
    return { code, name: entry[1], kind: entry[2], central: entry[3], monitored: entry[4] };
  });

  const data = {
    version: 1,
    anonymized: !opts.real,
    source: 'Azure Resource Graph snapshot',
    generated: new Date().toISOString().slice(0, 10),
    mgs: mgDict,
    locations: locDict,
    types: typeSpecs,
    subs: subList,
    rgs: rgList,
    res: resList,
    deps: edges,
  };

  fs.mkdirSync(path.dirname(opts.out), { recursive: true });
  fs.writeFileSync(opts.out, JSON.stringify(data));
  const mb = (fs.statSync(opts.out).size / 1024 / 1024).toFixed(2);

  const withHealth = resList.filter((r) => r[4] >= 0).length;
  console.log(`scanned   ${scanned} resources, dropped ${dropped} (${orphaned} orphaned, rest unmapped type)`);
  console.log(`kept      ${resList.length} resources in ${rgList.length} groups, ${subList.length} subscriptions`);
  console.log(`types     ${typeSpecs.length}   management groups ${mgDict.length}   regions ${locDict.length}`);
  console.log(`wiring    ${edges.length / 2} links`);
  console.log(`hubs      ${new Set([...hubOfSub.values()].map((v) => v.hub)).size} distinct, ${hubOfSub.size}/${subList.length} subscriptions attached`);
  console.log(`health    ${withHealth} resources carry a real availability state`);
  console.log(`wrote     ${opts.out} (${mb} MB, ${data.anonymized ? 'pseudonymised' : 'REAL NAMES'}) in ${Date.now() - t0}ms`);

  if (opts.report) {
    console.log(`\nleft out — types with no entry in the catalog (${dropped - orphaned} resources):`);
    for (const [t, c] of [...droppedByType].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(c).padStart(7)}  ${t}`);
    }
  }
}

await main();
