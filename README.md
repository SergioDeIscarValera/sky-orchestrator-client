# Sky Orchestrator Client

**Plan, prepare and fly drone operations over a live 3D model of the farm.**

Sky Orchestrator Client (SOC) is the ground-control console for
[Sky Orchestrator](https://github.com/SergioDeIscarValera/sky-orchestrator) (SO),
which emulates a DJI Dock 2 and flies a consumer DJI aircraft behind it. SOC plays
the other party of DJI's Cloud API, the cloud: it registers aircraft, draws
geofences and waylines on the farm's terrain, builds the flight files SO flies,
runs every operation through live preflight checks and a simulated pass, and
commands the aircraft in flight from one persistent 3D view.

Users, organizations and the database are
[Virtual Origen](https://github.com/SergioDeIscarValera/virtual-origen-v2)'s
(VO2): a VO2 account signs in, a VO2 organization is the farm.

> **Status: pre-alpha, M1 (platform and viability).** Requirements, decisions,
> conventions and pipelines are in place (v0.1.0); the database baseline and the
> shared Python libraries are landing, no service runs yet. The MVP is the first
> real flight commanded from SOC. See the [roadmap](docs/roadmap.md).

---

## Architecture

```
            Farm LAN · one mini-PC · no internet on the flight path

  browser ─── soc-web (React · Three.js) ──┐
                                            │ supabase-js
                    ┌───────────────────────▼──────────────────────┐
                    │ VO2's Supabase: Auth · PostgREST · Realtime  │
                    │ Postgres 17 · schema public (VO2) · soc      │
                    └─────▲───────────────────────────────▲────────┘
                          │                               │
                 ┌────────┴────────┐             ┌────────┴────────┐
                 │ soc-operations  │             │ soc-cloud       │── MQTT ──► SO stack
                 │ lifecycle,      │             │ DJI cloud party │◄─ HTTP ─── (dock downloads
                 │ checks, files   │             │ files, geofence │            flight files)
                 └─────────────────┘             └─────────────────┘
                                                        SO ─► phone ─► controller ─► aircraft
```

Four facts shape it, each with its decision record:

1. **SOC speaks to SO only as a DJI cloud does**, over DJI's wire and SO's
   documented HTTP surfaces
   ([ADR-0004](docs/architecture/decisions/0004-soc-is-the-dji-cloud-party.md)).
2. **One database, VO2's, in SOC's own schema `soc`**
   ([ADR-0005](docs/architecture/decisions/0005-one-database-shared-with-virtual-origen.md)).
3. **The web talks to the database directly; commands are intents** a service
   executes and records
   ([ADR-0006](docs/architecture/decisions/0006-the-web-talks-to-supabase-and-commands-are-intents.md)).
4. **Every real flight follows a simulated flight of the exact same file**
   ([ADR-0011](docs/architecture/decisions/0011-simulate-then-fly-the-same-file.md)).

The full picture: [architecture overview](docs/architecture/overview.md).

## Repository layout

| Path | Contents |
| --- | --- |
| [`apps/`](apps/) | `soc-web`: the console, one persistent 3D scene and its panels |
| [`services/`](services/) | `soc-cloud`, the DJI cloud party; `soc-operations`, the operation lifecycle |
| [`libs/`](libs/) | Python shared by the services: configuration, logs, data access, geometry validators |
| [`database/`](database/) | Schema `soc`: migrations, policies, RPCs and their tests |
| [`contracts/`](contracts/) | Interfaces between units: payloads, verbs, golden vectors, SO's vendored schemas |
| [`infra/`](infra/) | The compose stack for the mini-PC, the migration runner, live checks, the console end to end |
| [`tools/`](tools/) | Repository tooling: deterministic, tested |
| [`docs/`](docs/) | Requirements, architecture, decisions, design, risks, roadmap |

Each unit is a deploy unit with its own tests, README and enumerated failure
modes. Units meet only at `contracts/` and in the database.

## Documentation

| Document | What it answers |
| --- | --- |
| [Requirements](docs/requirements/README.md) | What SOC must do (FR), how well (NFR), with what data (IR) |
| [Dependencies](docs/requirements/dependencies.md) | What SOC needs from SO and VO2, and where each item stands |
| [Architecture overview](docs/architecture/overview.md) | How the pieces fit |
| [Decision records](docs/architecture/decisions/README.md) | Why they fit that way |
| [Design system](docs/design/README.md) | How SOC looks and behaves |
| [Risk register](docs/risks.md) | What is most likely to go wrong, and its trigger |
| [Roadmap](docs/roadmap.md) | Milestones and exit criteria |
| [CI/CD](docs/ci-cd.md) | Pipelines, lanes and the minutes budget |
| [GitHub governance](docs/github-governance.md) | Branch rules, merge method, automatic tagging |
| [Contributing](CONTRIBUTING.md) | Branching, commits, definition of done |

## Target environment

| Element | Value |
| --- | --- |
| Server | The farm's mini-PC: Ubuntu, x86_64, Docker Compose, shared with VO2 and SO |
| Database | VO2's self-hosted Supabase (Postgres 17, GoTrue, PostgREST, Realtime) |
| Aircraft | DJI Mavic Air 2 behind Sky Orchestrator |
| Console | A laptop on the farm's LAN, latest Chrome, Edge or Firefox with WebGL 2 |
| Network | LAN. The internet is not on the path from a click to an aircraft. |

## Safety

SOC commands an aircraft. Treat every default as wrong at least once.

- **The device decides.** Sky Orchestrator's envelope, enforced on the phone, is
  what stops the aircraft. SOC's checks, its geofence included, are defence in
  depth on top of it.
- **The pilot on the remote controller outranks SOC**, always, and stays ready to
  take over.
- **A real flight needs SO's two keys** and a completed simulation of the same
  file; SOC checks it and SO checks it again.
- **SOC's only autonomous action is a return home** when an aircraft leaves its
  geofence.
- **Nothing stale is shown as live, and no missing value is invented.**

The operator remains responsible for complying with aviation regulation (in
Spain, AESA's rules and the UAS geographical zones), including visual line of
sight, registration and airspace. Nothing in this repository grants permission to
fly.

## Out of scope

- Hosting or modifying Sky Orchestrator or Virtual Origen: SOC uses their
  documented interfaces.
- Remote operation from outside the farm, in the MVP.
- Live video, payload control and manual stick control.
- Aircraft that Mobile SDK V4 does not support.

## Licence

[MIT](LICENSE).

SOC is an independent project, not affiliated with, endorsed by or supported by
SZ DJI Technology Co., Ltd. "DJI", "Mavic", "DJI Dock" and "DJI Cloud API" are
trademarks of their owner, used only to describe interoperability. Terrain and
imagery from Spain's IGN are used under CC BY 4.0 and attributed in the
application.
