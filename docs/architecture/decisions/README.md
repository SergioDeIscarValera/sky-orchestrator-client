# Architecture decision records

One file per decision, [MADR](https://adr.github.io/madr/)-flavoured, kept short.

Rules:

- Numbers are permanent and sequential: `NNNN-kebab-title.md`.
- A decision is never edited to say something different. A new record supersedes
  it, and the old one's status says `Superseded by ADR-NNNN`.
- Status: `Proposed`, `Accepted`, `Superseded by ADR-NNNN`, `Deprecated`.
- A decision forced by a fact found in Sky Orchestrator or Virtual Origen says so,
  and names the fact.
- **A record links only to other records and to external sources.** Living
  documents (requirements, roadmap, design system) are named in plain text: a
  permanent link into a moving document rots silently, and the directory stays
  readable on its own.

| ADR | Title | Status |
| --- | --- | --- |
| [0001](0001-record-architecture-decisions.md) | Record architecture decisions | Accepted |
| [0002](0002-monorepo-and-service-boundaries.md) | Monorepo layout and service boundaries | Accepted |
| [0003](0003-git-flow-and-conventional-commits.md) | Git Flow with scoped one-line conventional commits | Accepted |
| [0004](0004-soc-is-the-dji-cloud-party.md) | SOC is the DJI cloud party of Sky Orchestrator | Accepted |
| [0005](0005-one-database-shared-with-virtual-origen.md) | One database shared with Virtual Origen, schema `soc` | Accepted |
| [0006](0006-the-web-talks-to-supabase-and-commands-are-intents.md) | The web talks to Supabase directly, and commands are intents | Accepted |
| [0007](0007-live-telemetry-over-realtime-broadcast.md) | Everything live travels as Realtime Broadcast on private channels | Accepted |
| [0008](0008-flight-files-served-on-sky-orchestrators-network.md) | Flight files are built by SOC, kept as bytes and served on SO's network | Accepted |
| [0009](0009-geometry-generators-validators-and-golden-vectors.md) | Geometry: generators in the web, validators in the services, golden vectors between them | Accepted; where legs are split superseded by ADR-0024 |
| [0010](0010-the-cloud-geofence-is-enforced-where-telemetry-arrives.md) | The cloud geofence is enforced where telemetry arrives | Accepted |
| [0011](0011-simulate-then-fly-the-same-file.md) | Simulate, then fly the same file | Accepted |
| [0012](0012-wire-identity-is-not-airframe-identity.md) | Wire identity is not airframe identity | Accepted |
| [0013](0013-narrow-vertical-slice-for-the-mvp.md) | Narrow vertical slice for the MVP | Accepted |
| [0014](0014-units-and-reference-frames.md) | Units and reference frames match Sky Orchestrator | Accepted |
| [0015](0015-lan-first-deployment.md) | LAN-first deployment on the mini-PC | Accepted |
| [0016](0016-web-stack.md) | Web stack: React, React Three Fiber, a persistent scene rendered on demand | Accepted; its test environment superseded by ADR-0020 |
| [0017](0017-backend-stack.md) | Backend stack: small asyncio services, one database connection each | Accepted |
| [0018](0018-the-site-model-is-baked-once.md) | The site model is baked once and served as static assets | Accepted |
| [0019](0019-one-configuration-contract-no-fallbacks.md) | One configuration contract, a file per service, no fallbacks | Accepted |
| [0020](0020-web-tests-on-happy-dom-and-zod-mini.md) | The web's unit tests run on happy-dom; its schemas use Zod's mini build | Accepted |
| [0021](0021-the-scene-camera-and-ground.md) | The scene's camera keeps its own limits; its ground is plain three.js | Accepted |
| [0022](0022-web-test-files-share-their-workers-modules.md) | The web's test files share their worker's modules | Accepted |
| [0023](0023-the-console-reads-its-own-configuration-file.md) | The console reads its own configuration file, checked before it starts | Accepted |
| [0024](0024-a-wayline-is-geometry-the-operation-flies-it.md) | A wayline is geometry; the operation flies it | Accepted |
| [0025](0025-checks-are-judged-from-what-soc-cloud-records.md) | The preflight checks are judged from what soc-cloud records | Accepted |
