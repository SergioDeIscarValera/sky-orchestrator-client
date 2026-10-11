# Architecture overview

How the parts fit. The reasons live in the
[decision records](decisions/README.md).

## System context

```
 Farm LAN · one mini-PC (Ubuntu, Docker Compose). No internet on the flight path.
┌─────────────────────────────────────────────────────────────────────────────────┐
│                                                                                 │
│  Operator's laptop                                                              │
│  ┌──────────────────────────┐   HTTP    ┌───────────┐                           │
│  │ browser: soc-web (SPA)   │◄─────────►│  soc-web  │ nginx, static, runtime    │
│  │ React · Three.js         │           │           │ configuration             │
│  └────────────┬─────────────┘           └───────────┘                           │
│               │ supabase-js: sign-in, PostgREST (schema soc), Realtime          │
│               ▼                                                                 │
│  ┌─────────────────────────────────────────────────────────┐                    │
│  │ Virtual Origen's Supabase (single instance)             │                    │
│  │ Kong · GoTrue · PostgREST · Realtime · Postgres 17      │                    │
│  │ schema public (VO2: users, organizations)  schema soc   │                    │
│  └───────▲─────────────────────────────▲───────────────────┘                    │
│          │ service role, LAN            │ service role, LAN                     │
│  ┌───────┴──────────┐            ┌──────┴───────────┐                           │
│  │ soc-operations   │            │ soc-cloud        │  MQTT as cloud-client     │
│  │ lifecycle,       │            │ DJI cloud party  │◄──────────────┐           │
│  │ checks, files    │            │ files on SO net  │──HTTP GET KMZ─┤           │
│  └──────────────────┘            └──────────────────┘               │           │
│                                                    ┌────────────────┴────────┐  │
│                                                    │ Sky Orchestrator stack  │  │
│                                                    │ mosquitto · so-gateway  │  │
│                                                    │ so-fleet · so-wayline   │  │
│                                                    │ so-bridge               │  │
│                                                    └────────────┬────────────┘  │
└─────────────────────────────────────────────────────────────────┼───────────────┘
                                                                  │ Wi-Fi, USB, radio
                                                   phone · remote controller · aircraft
```

## Units

| Unit | Role | Talks to |
| --- | --- | --- |
| `soc-web` | The console: one persistent 3D scene and its panels; serves each organization's baked site model read-only at `/site/<organization>/` | Supabase only ([ADR-0006](decisions/0006-the-web-talks-to-supabase-and-commands-are-intents.md)) |
| `soc-cloud` | The DJI cloud party for every SO stack ([ADR-0004](decisions/0004-soc-is-the-dji-cloud-party.md)) | SO's broker and HTTP surfaces; Supabase |
| `soc-operations` | Operation lifecycle, checks, flight files | Supabase only |
| `database` | Schema `soc` in VO2's database ([ADR-0005](decisions/0005-one-database-shared-with-virtual-origen.md)) | — |
| `soc-site` | Bakes an organization's terrain and imagery once, by hand ([ADR-0018](decisions/0018-the-site-model-is-baked-once.md)) | IGN's elevation and imagery services, at `fetch` only; writes the model `soc-web` serves |

`soc-cloud` is the only process that speaks to Sky Orchestrator; `soc-web` and
`soc-operations` never do. Units meet through the database and `contracts/`.

## The four paths

### Telemetry: aircraft to screen

```
aircraft ─► SO ─► thing/product/{aircraft_sn}/osd ─► soc-cloud
   soc-cloud ─► Realtime Broadcast, private topic org:<id>:soc:telemetry ─► browsers   (every sample)
   soc-cloud ─► soc.telemetry_samples, one COPY per aircraft every few seconds, 1 Hz   (executing flights)
   soc-cloud ─► cloud geofence check ─► return_home on a breach                (executing flights)
```

[ADR-0007](decisions/0007-live-telemetry-over-realtime-broadcast.md),
[ADR-0010](decisions/0010-the-cloud-geofence-is-enforced-where-telemetry-arrives.md).

### A command: click to aircraft

```
pilot clicks Pause
  soc-web ─► RPC soc.request_command(flight, 'pause', request id)   role and pilot checked
  database: soc.commands row, pending; pg_notify in the same transaction
  soc-cloud (LISTEN on its one connection) ─► claims the row, pending → sent
  soc-cloud ─► flighttask_pause on thing/product/{gateway_sn}/services   tid = command id
  SO ─► services_reply ─► soc-cloud ─► soc.commands: accepted | refused | timed_out
  trigger ─► realtime.send on org:<id>:soc:state ─► every browser on the operation
```

### An operation: plan to landing

```
draft ─► planned ─► preparing ─► simulating ─► simulated ─► ready ─► launching ─► in_flight ─► returning ─► completed
```

1. The web saves the geofence, the wayline and the assignment; the database
   checks what it can, `soc-operations` checks the rest.
2. In `preparing`, `soc-operations` evaluates the preflight checks from live
   state: telemetry, SO's stack status, SO's dry run of the flight file.
3. `soc-operations` builds the flight file (exact bytes, MD5) and asks
   `soc-cloud` to prepare it with `simulate_mission` set from SO's mode
   ([ADR-0011](decisions/0011-simulate-then-fly-the-same-file.md)). SO's dock
   downloads the file from `soc-cloud` on SO's network
   ([ADR-0008](decisions/0008-flight-files-served-on-sky-orchestrators-network.md)),
   and again at execute through `flighttask_resource_get`.
4. A simulated flight ending `ok` makes the operation `simulated`, recording the
   phone's `config_fingerprint`; a real launch needs the same one. The operator
   turns SO's two keys; with SO in real mode and the checks green, the operation is
   `ready`, and a pilot launches the same file.
5. Progress, the flight mode and the cloud geofence feed the operation's log
   until the aircraft is on the ground.

### Identity: who may see and do what

Virtual Origen's GoTrue signs users in; its memberships give roles per
organization; SOC's policies read them through VO2's `private` helpers and add the
operation's pilots ([ADR-0005](decisions/0005-one-database-shared-with-virtual-origen.md)).
The services act with the service role, for the organizations in their allowlist
only.

## Where state lives

| State | Owner | Durability |
| --- | --- | --- |
| Users, organizations, memberships | Virtual Origen | VO2's database |
| Fleets, geofences, waylines, operations | Members, through policies | `soc` schema |
| Devices, stacks, flight progress, telemetry history, command outcomes | `soc-cloud` | `soc` schema |
| Operation state, flights, flight files, check results | `soc-operations` | `soc` schema |
| The operation log | Every unit, append-only | `soc` schema |
| Live telemetry | `soc-cloud` | In flight only: Broadcast |
| The answer to the dock's file request | `soc-cloud` | In memory, rebuilt from the database at start |
| Flight task execution | Sky Orchestrator | SO's own stores |

Nothing that a restart could lose is held only in memory, except the file answer
cache, which is rebuilt from `soc.flight_files` when `soc-cloud` starts.

## Deployment

One compose project, `sky-orchestrator-client`, on the mini-PC: `soc-web`,
`soc-cloud`, `soc-operations`, each with memory and CPU limits, and two one-shot
jobs before them: `soc-migrate` and `soc-web-check`, which checks the console's
configuration file before `soc-web` starts ([ADR-0023](decisions/0023-the-console-reads-its-own-configuration-file.md)). `soc-cloud` joins
Virtual Origen's network (`supabase-local_default`, for Kong) and Sky
Orchestrator's (`sky-orchestrator_default`, for its broker and so that its dock
can download files). `soc-web` publishes one port on the LAN address; nothing
else is published ([ADR-0015](decisions/0015-lan-first-deployment.md)).

## What deliberately does not exist

- No backend API for the browser: the database is the interface.
- No second database and no second identity provider.
- No direct use of Sky Orchestrator's internals.
- No automatic deployment: a restart of `soc-cloud` mid-flight is a hazard.
- No autonomous action on an aircraft except a return home on a geofence breach.
