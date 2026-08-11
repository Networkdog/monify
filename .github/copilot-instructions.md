# monify — Project Guidelines

Scenario-specialized data visualizations on a vendored WebGL2 semantic-zoom
engine. TypeScript, ESM, no runtime dependencies.

## Architecture

| Path | Role |
|---|---|
| `src/core/**` | **Vendored** WebGL2 engine (Scene, Camera, TileCache, QuadRenderer, LiveStore). Treat as a third-party dependency. |
| `src/viz/**` | Visualizations. Each extends `VizBase` and implements `buildTile`. |
| `src/data/**` | Transport-agnostic monitoring feed (`DataSource` → `MonitorFeed` → `MonitorTarget`). |
| `src/color/**` | Palettes and scales. |
| `src/demo/**`, `demos/**` | Demo drivers and their HTML entry points. |
| `bench/**` | Performance harnesses. |

A visualization owns its data model and generates tile geometry procedurally in
`buildTile(z, x, y)`. The engine calls it synchronously before `draw()`.

**Do not edit `src/core/**` to fix a visualization problem.** It is excluded
from ESLint precisely because it is vendored. If core genuinely needs a change,
call it out explicitly rather than folding it into unrelated work.

The engine originates from the **singlescene** project
(`D:\Workspace\singlescene`), whose `docs/adr/` and
`.github/instructions/core-*.instructions.md` explain its design. monify's copy
has diverged, so use those documents for *rationale* and this repository's
`src/core/**` for *truth*. The constraints that bind visualization code —
camera-relative float64 coordinates, instanced batching, texture and text
budgets — are summarized in
[docs/workload-map.md §3.1](../docs/workload-map.md#31-engine-contract).

## Build and Test

```bash
npm test              # vitest run — tests/**/*.test.ts, node environment
npm run lint          # eslint src tests
npm run build         # tsc --noEmit && vite build  (library)
npm run dev           # vite dev server
```

Run `npm test`, `npm run lint`, and `npm run build` before considering a change
complete. All three must pass.

Benchmarks run through `vite-node` (PowerShell):

```powershell
$env:NODE_OPTIONS="--expose-gc --max-old-space-size=4096"
npx vite-node bench/store-bench.ts 1000000 0.01
```

## Module Documentation

Some modules have an authoritative design spec. **Read it before writing code in
that module** — the spec is the source of truth, and the code is written from it.

| Module | Spec |
|---|---|
| `src/viz/workload-map/**` | [docs/workload-map.md](../docs/workload-map.md) |

When code and its spec disagree, one of them is a bug. Fix both deliberately and
update the spec in the same change — never let them drift silently.

Architecture decisions live in [docs/adr/](../docs/adr/), one file per decision,
numbered and immutable once accepted. Record a new ADR when you choose between
real alternatives and give something up; amend the spec when you change what the
code does.

## Documentation Sync Rule

Update documentation **in the same change**, not afterwards:

| Change | Files to update |
|---|---|
| Store columns, rollups, invariants | `docs/workload-map.md` §5–§7 |
| Hot-path performance | re-run the benchmark, update `docs/workload-map.md` §9 with real output |
| An alternative was weighed and rejected | new `docs/adr/NNNN-*.md` |
| A constraint discovered in `src/core/**` | `docs/workload-map.md` §3.1 |
| Public API of a visualization | that module's spec, plus its barrel export |
| npm script or build config | this file |

## Conventions

- **Comments in English**, including in Korean-language conversations. Write a
  comment only for what the code cannot show on its own — the *why*, a
  non-obvious invariant, or a rejected alternative. Never restate the next line.
- **Performance claims must be measured**, never estimated. If you assert a
  speedup, show the benchmark output that produced the number.
- Prefer typed arrays and dense integer handles over per-object allocation on
  any path that scales with data size.
- `tsconfig.json` includes only `src`, `demos`, `tests`. `bench/**` is
  deliberately excluded — it uses Node APIs and would need `@types/node`. It is
  transpiled at runtime by `vite-node`, not typechecked by `npm run build`.
- ESLint enforces `eqeqeq`, `complexity` ≤ 25, `max-depth` ≤ 4, and bans
  `console.log` (`console.warn` / `console.error` are allowed).
- Tests use Vitest with `fast-check` available for property-based testing.
