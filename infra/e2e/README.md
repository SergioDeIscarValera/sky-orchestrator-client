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
minutes instead of the lane's one.

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
3. The pilot registers it from its row's _Register_, through the form, as _Norte 1_, and the database holds
   that fleet with its gateway and aircraft (`FR-FLE-03`).
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
7. The fleet panel closes, and the map tools stay where they were, bottom
   right, as the design system puts them: they once jumped to the top.

Both latencies come from this machine's one clock: the dock stamps each OSD with
it, and the driver reads it as Chrome hands it each frame.
