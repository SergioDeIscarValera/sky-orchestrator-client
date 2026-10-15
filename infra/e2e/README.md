# soc-e2e

The console end to end: SOC as an operator meets it, in Chrome, on Virtual
Origen's platform, with a dock on the wire. M2's exit criteria are measured
here, not assumed from the units' own tests.

```bash
uv run --frozen mypy infra/e2e
uv run --frozen pytest infra/e2e/tests -m "not lane"   # gate: the dock's messages, Kong's routes
uv run --frozen pytest infra/e2e/tests -m lane -s      # lane: needs Docker, Node and Chrome
```

The lane needs `apps/soc-web` installed (`pnpm install`), for playwright-core,
and a Chrome on the `PATH` (`google-chrome`, `chromium`) or named by
`SOC_E2E_CHROME`. Without a GPU, as on the runners, `SOC_E2E_SOFTWARE_GL=1`
draws WebGL on SwiftShader. `SOC_E2E_SAMPLES=3000` flies `NFR-PERF-01`'s ten
minutes instead of the lane's one. `SOC_E2E_RECORD=<file>` keeps every sample the
page receives as a recording (`contracts/recordings`, `NFR-TEST-05`).

## What runs

| Piece | What it is | Where |
| --- | --- | --- |
| Postgres, Realtime | `supabase/postgres:17.6.1.136`, `supabase/realtime:v2.102.3`, SOC's migrations | `soc_database.realtime.RealtimeStack` |
| GoTrue, PostgREST | `supabase/gotrue:v2.189.0`, `postgrest/postgrest:v14.12` with schemas `public,soc` (`DEP-21`) | `soc_e2e.platform` |
| Kong | `kong/kong:3.9.1`, routing `/auth/v1/`, `/rest/v1/` and `/realtime/v1/` as Supabase's `kong.yml` does, CORS on each | `soc_e2e.platform` |
| Mosquitto | `eclipse-mosquitto:2.0.22`, configured as Sky Orchestrator's broker | `soc_cloud.testing.EphemeralMosquitto` |
| soc-cloud | In this process, one stack `lab`, reaching Realtime through Kong as it does on the mini-PC | `soc_e2e.cloud` |
| The dock | so-gateway's side: `update_topo` every 0.5 s, then the aircraft's OSD at 5 Hz, idle for a second, then circling Finca Norte at 30 m; every message checked against SO's vendored schemas by the gate | `soc_e2e.dock` |
| The console | Its own image, `apps/soc-web/Dockerfile`, given Kong's address and the anon key | `soc_e2e.console.serving` |
| The browser | `apps/soc-web/scripts/e2e/console.mjs`: Chrome through playwright-core, speaking JSON lines with the test | `soc_e2e.console.browsing` |

Every service signs and checks tokens with one JWT secret. The pilot is a GoTrue
user created through its admin API, with a profile, and owns Finca Norte.

## What it checks

`test_console.py` follows an operator through the console:

1. The pilot signs in through GoTrue, and the console opens their only
   organization with the fleet panel.
2. The dock starts announcing. The aircraft appears in the fleet panel
   within **2 s** (`FR-FLE-02`).
3. The pilot selects it in the fleet panel and registers it from the inspector,
   through the form, as _Norte 1_, and the database holds that fleet with its
   gateway and aircraft (`FR-FLE-03`).
4. The dock flies. Every sample reaches the browser in order and the
   inspector's position changes. The scene draws frames
   (`FR-TEL-01`, `FR-SCN-04`). The aircraft, selected since its
   registration, is followed: its label holds still on the screen, within 40 px,
   while it flies (`FR-SCN-05`).
5. From the dock's publish to the browser's receipt of the frame, the latency
   is within **150 ms at p95 and 300 ms at p99** (`NFR-PERF-01`). That path
   starts before soc-cloud reads the OSD, so it bounds the requirement's own.
   The test also prints:
   - soc-cloud's broadcast to the browser;
   - soc-cloud's own hold;
   - the console's delivery figure from `?stats`.
6. The dock falls silent, and the inspector says Stale **3 s after the last
   sample, give or take 100 ms** (`FR-TEL-02`).
7. The inspector closes, and then the fleet panel does: the map tools stay where
   they were, bottom right, as the design system puts them: they once jumped to
   the top.
8. With nothing selected, `/`, the last six characters of the aircraft's serial and
   Enter in the top bar's search select its fleet again, and the scene follows it
   (`FR-SCN-05`).
9. The dock flies again and the browser's network is cut for **10 s**, while the
   fleet is renamed in the database (`NFR-REL-07`). Nothing reaches the page;
   the top bar says Reconnecting within a second, every presence reads unknown,
   and the inspector is no longer live. Back, the link, a live aircraft and the
   new name must each show within 10 s: 1,078, 1,168 and 30 ms on 2026-10-12.
   Chrome holds an open socket's frames while offline rather than closing it,
   as a network that drops packets would.

Both latencies come from this machine's one clock: the dock stamps each OSD with
it, and the driver reads it as Chrome hands it each frame.

## Against Sky Orchestrator's released stack (M4)

```bash
uv run --frozen pytest infra/e2e/tests -m "lane and sky_orchestrator" -s
```

`soc_e2e.so_stack.SoStack` brings up Sky Orchestrator's stack as SO's own
`infra/check.sh` does for its external cloud role:

- The compose files and the broker's configuration come vendored at
  `contracts/sky-orchestrator/stack`, and the images are those SO published at the
  vendored release, read from GHCR.
- The fake bridge stands in for the phone, and each service's file is written from
  the vendored configuration contract. The phone's envelope is set equal to
  so-wayline's, as the real phone is set by hand (`DEP-03`).
- Everything is its own: the compose project (`soc-e2e-so-*`), the loopback ports
  and the credentials, all removed with it. It never touches another stack on the
  machine.

soc-cloud and soc-operations run in this process on the platform. soc-cloud
serves the flight files on the stack network's gateway address, where
so-wayline's container fetches them.

| Test | What it holds |
| --- | --- |
| `test_so_stack_against_docker.py` | The stack comes up ready to fly in simulator mode, turns to real mode and back, launches the fake bridge as a phone ready for real flight and back (`DEP-28`), lets SOC's `cloud-client` hear its dock announce the aircraft, and reaches a server on its network's gateway |
| `test_operation_against_so.py`, the simulated path | A pilot plans and prepares an operation. The sixteen checks, judged on what soc-cloud reads, all pass, Sky Orchestrator's dry run included. The pilot simulates, then pauses and resumes the flight 50 times while it flies. The flight ends ok. Each of the 100 commands is measured: **4.1 ms p95 to the wire, 21.8 ms p95 to the reply** (`NFR-PERF-02` asks 300 ms and 1 s, on 2026-10-14). |
| `test_operation_against_so.py`, the real path | The stack is turned to real mode with the phone's simulator still on: PF-MODE passes, PF-SIMULATOR fails, and the launch is refused before anything reaches the wire. The fake bridge is then launched as a phone ready for real flight: the operation is ready, launches, is paused and resumed three times on its route, and completes once the aircraft has landed. Every move is in the log, from draft to completed. The return home climbs no higher than the route's highest waypoint (35 m), under an envelope of 100 m: the prepare's return height holds (`DEP-29`). |
| `test_operation_against_so.py`, the restarts | soc-cloud and then soc-operations are each stopped for 3 s and started again while the simulated flight flies, and again while the real one does (`NFR-REL-01`). Each flight ends ok and completed, its track is kept, and its prepare and its execute each went out once. |
| `test_console_operation_against_so.py` | The same flight worked in Chrome, through the console, as a pilot works it: planned and prepared, the checks judged until every blocking one passes, and simulated. The simulated flight is paused and resumed 50 times, 100 commands, each reply shown within **1 s at p95**, timed in the page from the command's confirmation (the end of its 1.5 s hold): **99 to 114 ms at p95** in four runs on 2026-10-15 (`NFR-PERF-02`). The stack turns to real, the operation launches, is paused and resumed once in the air, and completes. The log, as the console shows it, reads every move from draft to completed in order, and so do the database's moves; each move shows **32 ms or less** after the services recorded it, as in a second browser, since the page recorded none (`FR-LOG-03` asks 1 s). |
| `test_simulation_gate_against_so.py` | Sky Orchestrator's own gate behind SOC's (`NFR-SAF-05`, SO's NFR-SAF-07): with the stack in real mode and the phone ready for real flight, a real prepare of a valid flight file never simulated there, published straight onto the dock's services topic, is answered `314010`, and so-fleet logs `not_flown_in_simulation` with the file's MD5. SOC itself never sends one. |

`test_console_operation_against_so.py` flies the golden route at 1 m/s and at pace 1, where the database test flies it at 5 m/s and pace 2: 50 cycles of the console's pauses and resumes need more flight than the route's 23 s at 5 m/s. Its driver, `apps/soc-web/scripts/e2e/operation.mjs`, makes its first move as soon as the console's state channel has joined, as a pilot would. Realtime delivers to a join only a moment after it, and a change made in between used to be lost: three of the first six runs stopped so, the header still reading Draft. The console now reads its state again once delivery has begun (`onState`'s `JOIN_SETTLE_MS`), and this test holds it.

A pause is sent once the telemetry says the aircraft flies its wayline (mode 5):
during the take-off the application refuses it, `319046`, as Sky Orchestrator's
own `infra/fly.py` waits for the route.
