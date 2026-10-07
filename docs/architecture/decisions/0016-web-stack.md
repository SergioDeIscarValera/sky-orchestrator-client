# ADR-0016 — Web stack: React, React Three Fiber, a persistent scene rendered on demand

- **Status**: Accepted
- **Date**: 2026-10-07

## Context

`soc-web` is one persistent, interactive 3D scene with panels over it, live
telemetry, drawing tools, and a strict budget for memory, GPU and idle CPU
(`NFR-RES-*`, `NFR-PERF-05`, `NFR-PERF-06`). The operator's reference, "WareTrack",
is built with React and React Three Fiber, by its author's account. Virtual
Origen's web uses React 18, Vite 6, Tailwind 3, Radix and TanStack Query; SOC
shares its palette, not its code.

Every version below was read from the npm registry on 2026-10-07, and a smoke
application with these exact pins installed, type-checked, built, tested and
linted cleanly.

## Decision

| Slot | Choice | Version | Why |
| --- | --- | --- | --- |
| Runtime | Node.js LTS | 24.21.0 | Active LTS; move to 26 when it becomes LTS (2026-10-28) |
| Package manager | pnpm | 12.10.1 | Lockfile, workspaces, a one-day minimum release age kept on as a supply-chain guard |
| UI | React, React DOM | ~19.3.0 | R3F 9.8 accepts `>=19 <19.4`; React moves only together with R3F |
| 3D | three | 0.186.1 | With `@types/three` 0.186.0 |
| 3D in React | @react-three/fiber | 9.8.1 | The renderer of the reference; `frameloop="demand"` gives render-on-change |
| 3D helpers | @react-three/drei | 10.7.9 | Camera controls with fly-to, `Html`, lines, instancing; imported per component |
| Picking | three-mesh-bvh | 0.8.3 | The version drei 10 depends on; two copies break the type check |
| Scene and UI state | zustand | 5.0.15 | Telemetry reaches the scene through store subscriptions, not React renders |
| Server state | @tanstack/react-query | 5.104.1 | Caching, refetch on reconnect (`NFR-REL-07`) |
| Data | @supabase/supabase-js | 2.117.x | Auth, PostgREST, Realtime Broadcast |
| Routing | @tanstack/react-router | 1.170.41 | Search parameters typed and validated, so the URL carries panel and selection (`NFR-UX-03`) |
| Build | Vite, @vitejs/plugin-react | 8.3.3, 6.1.2 | three and drei in their own chunk |
| Language | TypeScript | 6.0.3, strict | 7.0 has no compiler API yet and typescript-eslint refuses it |
| Styling | Tailwind CSS with @tailwindcss/vite | 4.3.3 | Minty's tokens in one `@theme` file (`NFR-UX-01`); floor Chrome 111, Safari 16.4, Firefox 128 |
| Primitives | radix-ui | 1.7.0 | Accessible dialogs, menus, tooltips, tabs; one package |
| Icons | lucide-react | 1.52.0 | Named imports |
| Forms | react-hook-form, @hookform/resolvers, zod | 7.89.0, 5.9.1, 4.6.5 | The same schemas validate forms and search parameters |
| Geometry | robust-predicates | 3.0.3 | Exact orientation tests under SOC's own small algorithms (ADR-0009) |
| Unit tests | Vitest, Testing Library, jsdom | 5.0.3, 16.3.3, 30.1.2 | The scene graph through `@react-three/test-renderer` 9.1.1 |
| Browser tests | Playwright | 1.63.0 | Real WebGL; the LAN-origin check of `NFR-PORT-04` |
| Lint, format | ESLint, typescript-eslint, react-hooks, Prettier | 10.12.0, 8.71.1, 7.1.1, 3.9.9 | Type-aware rules; a rule against colour literals and secure-context APIs |
| Fonts | @fontsource/montserrat | latin subset | Vendored, no request leaves the LAN |
| Serving | nginxinc/nginx-unprivileged | 1.30.5-alpine3.24-slim, by digest | Non-root, about 10 MiB of memory; runtime configuration written at start (`FR-DEP-04`) |

**Rendering rules** (the design system): `frameloop="demand"`, device pixel ratio
capped at 1.5, `powerPreference: "low-power"`, no post-processing, instancing for
repeated parts, the site model's assets as described in ADR-0018.

## Alternatives considered

**Vanilla three.js without React.** Less abstraction, and a second UI framework
problem for the panels, which are most of the code.

**Cesium or a map engine.** A globe, tiles and terrain streaming: heavy, online by
nature, and not the calm stylised scene the design asks for (ADR-0018).

**React Router**, as Virtual Origen uses. Yearly breaking majors since v8 and
untyped search parameters; the console keeps its state in the URL.

**Biome or oxlint instead of ESLint.** Faster, without typescript-eslint's
type-aware rules.

**Tailwind 3.** Supports older browsers the console does not target.

## Consequences

- React upgrades wait for React Three Fiber.
- Newly published packages wait a day before pnpm installs them.
- Telemetry updates the scene without re-rendering React trees; the idle scene
  renders nothing.
- Dependabot proposes updates monthly; the pins above are the baseline.
