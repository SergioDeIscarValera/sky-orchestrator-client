# Traceability matrix

Every requirement maps to the unit that implements it, the milestone that
delivers it, and the test that proves it. A requirement with no test reference is
not implemented, whatever the code says.

Milestones are defined in the [roadmap](../roadmap.md). Test identifiers follow
`<unit>/<path>::<test>` and are filled in as the tests are written; `—` means not
yet. `tools/check_traceability.py` holds this table equal to the requirement
documents: one row per requirement, the same priority, no row for anything else.

## Functional

| ID | Priority | Unit | Milestone | Test | Status |
| --- | --- | --- | --- | --- | --- |
| FR-AUT-01 | MUST | soc-web, database | M1 | `apps/soc-web/src/account/account.test.tsx`, `apps/soc-web/lint-rules.js`, `apps/soc-web/src/backend/supabase.test.ts` | Partial: sign-in with email and password through GoTrue, its refusals named; no control and no call that creates an account, held by a test and a lint rule; the end-to-end check on the LAN origin arrives with Playwright |
| FR-AUT-02 | MUST | soc-web, database | M1 | `database/migrations/0005-member-organizations.sql`, `database/tests/test_member_organizations.py`, `apps/soc-web/src/organizations/organizations.test.tsx` | Partial: the user's live organizations offered with role and position, the choice remembered per user and device, switched from the top bar with every other organization's query dropped; the scene's centring and the streams arrive with them |
| FR-AUT-03 | MUST | soc-web, database | M1 | `database/tests/test_membership.py`, `database/tests/test_fleets.py` | Partial: role ranking and live membership tested; fleets written by editors and above only, read by every live member, tested per role; each new table adds its policies and their tests |
| FR-AUT-04 | MUST | soc-web, database | M1 | `apps/soc-web/src/account/account.test.tsx` | Partial: tokens refreshed by Supabase's client; a session ended on the server returns to sign-in and forgets what was fetched; the refused write and command arrive with the writes |
| FR-SCN-01 | MUST | soc-web | M1 | `apps/soc-web/src/app/SceneRegion.tsx`, `apps/soc-web/src/app/SceneRegion.test.tsx` | Partial: one scene region mounted for the session, kept when the organization changes, the panels over it; the count of WebGL contexts across routes arrives with the routes and the end-to-end suite |
| FR-SCN-02 | MUST | soc-web | M2 | `apps/soc-web/src/scene/ground.ts`, `apps/soc-web/src/scene/ground.test.ts`, `apps/soc-web/src/app/SceneRegion.test.tsx` | Partial: without a site model, a flat ground and grid centred on the organization and a note naming the missing model, or the missing position; the baked terrain arrives in M2 |
| FR-SCN-03 | MUST | soc-web | M2 | `apps/soc-web/src/scene/camera.ts`, `apps/soc-web/src/scene/camera.test.ts`, `apps/soc-web/lint-rules.js` | Partial: orbit, pan, zoom and tilt within the site, never under the ground, held by a 2,000-step fuzz test of camera-controls with SOC's limits; the map tools' overview, closer and farther; every programmatic move through `flyTo` (ADR-0021); fly-to an entity arrives with the entities |
| FR-SCN-04 | MUST | soc-web | M2, M3, M4 | — | Planned |
| FR-SCN-05 | MUST | soc-web | M2 | — | Planned |
| FR-SCN-06 | MUST | soc-web | M2 | — | Planned |
| FR-SCN-07 | MUST | soc-web | M3 | — | Planned |
| FR-SCN-08 | MUST | soc-web | M1 | `apps/soc-web/src/scene/palette.ts`, `apps/soc-web/src/scene/palette.test.ts`, `apps/soc-web/src/scene/ground.test.ts` | Done: every scene colour read from the theme's tokens and repainted when the theme changes, with no reload and no tone mapping; one frame per change in Chrome |
| FR-FLE-01 | MUST | contracts, database | M2 | `contracts/catalogue/`, `tools/catalogue_migration.py`, `database/migrations/0006-aircraft-models.sql`, `database/tests/test_aircraft_models.py` | Done: 38 models of Mobile SDK V4, 11 of them partial, every published figure with the DJI page it was read on and every unpublished one null; the file checked against its schema and its sources in the hooks and in CI, and loaded as it is by a migration, read by every signed-in user |
| FR-FLE-02 | MUST | soc-cloud, database | M2 | `database/migrations/0007-fleets.sql`, `database/tests/test_fleets.py`, `services/soc-cloud/src/soc_cloud/presence.py`, `services/soc-cloud/tests/test_presence_against_postgres.py` | Partial: every device a stack announces recorded by `soc-cloud` with first and last seen, its presence and its firmware, broadcast on change; its fleet column arrives with the fleet panels |
| FR-FLE-03 | MUST | soc-web, database | M2 | `database/migrations/0007-fleets.sql`, `database/tests/test_fleets.py` | Partial: a fleet registered from a device its organization's stack has seen, by an editor; a device with a live fleet refused again; a missing name, model or airframe serial refused by its named constraint; the registration panel arrives with the fleet panels |
| FR-FLE-04 | MUST | soc-web, database | M2 | — | Planned |
| FR-FLE-05 | MUST | soc-web, database | M2 | `database/migrations/0007-fleets.sql`, `database/tests/test_fleets.py` | Partial: name, model, serials and wire identity editable by editors; retiring final, timed by the database, the fleet kept and its device freed; the refusal during an unfinished flight arrives with the flights (M4) |
| FR-FLE-06 | COULD | database, soc-web | M6 | — | Planned |
| FR-FLE-07 | COULD | database, soc-web | M6 | — | Planned |
| FR-LNK-01 | MUST | soc-cloud | M1 | `services/soc-cloud/tests/test_stack_link.py`, `services/soc-cloud/tests/test_against_broker.py` | Partial: one supervised MQTT v5 link per stack as `cloud-client`, persistent session (QoS 1 messages wait while away), back within the backoff after a broker restart, a takeover logged as `link_displaced` and named in health; the operation event arrives with the event log (M4) |
| FR-LNK-02 | MUST | soc-cloud | M1 | `services/soc-cloud/tests/test_stack_link.py::test_an_aircraft_is_online_only_while_listed_and_reported_online`, `services/soc-cloud/tests/test_stack_link.py::test_dropping_the_aircraft_from_the_topology_takes_it_offline`, `services/soc-cloud/tests/test_against_broker.py`, `services/soc-cloud/tests/test_presence_against_postgres.py::test_an_aircraft_dropped_from_the_topology_is_offline_within_a_second` | Partial: online only while listed by `update_topo` and reported online by the dock's OSD, changes logged at once; fleets go offline with it in M2; the device row offline in the database 6 ms after the message (2026-10-11), held under 1 s on the lane |
| FR-LNK-03 | MUST | soc-cloud | M1 | `services/soc-cloud/tests/test_stack_link.py::test_a_value_the_osd_lacks_is_unavailable_not_remembered`, `services/soc-cloud/tests/test_against_broker.py::test_aircraft_osd_becomes_samples` | Done for the ingest: one sample per aircraft OSD at its own timestamp, a missing field unavailable; the fan-out arrives in M2 |
| FR-LNK-04 | MUST | soc-cloud | M1 | `services/soc-cloud/tests/test_stack_link.py`, `services/soc-cloud/tests/test_against_broker.py::test_file_requests_are_answered_within_half_a_second_at_p99`, `services/soc-cloud/tests/test_against_platform.py::test_the_dock_asks_for_a_flight_file_and_downloads_its_exact_bytes` | Done: answered on `requests_reply` from memory with the flight's URL and MD5, an unknown flight with a non-zero result and its reason, p99 under 500 ms over 100 requests |
| FR-LNK-05 | MUST | soc-cloud | M1 | `services/soc-cloud/tests/test_files.py`, `services/soc-cloud/tests/test_against_platform.py::test_the_dock_asks_for_a_flight_file_and_downloads_its_exact_bytes` | Partial: served byte for byte at `/files/<128-bit token>.kmz`, the downloaded MD5 equal to the offered fingerprint, every other path the same 404; no published port arrives with the compose stack |
| FR-LNK-06 | MUST | soc-cloud | M4 | `services/soc-cloud/tests/test_commands.py`, `services/soc-cloud/tests/test_against_platform.py::test_commands_reach_the_wire_through_pg_notify_within_50_ms_at_p95` | Partial: every verb's intent published on `services` with tid = intent and bid = flight, its reply recorded with its result, no reply timed out after `command_reply_timeout_s`; against Sky Orchestrator's fake bridge stack in the stack check |
| FR-LNK-07 | MUST | soc-cloud | M4 | — | Planned |
| FR-LNK-08 | MUST | soc-cloud | M4 | — | Planned |
| FR-LNK-09 | MUST | soc-cloud | M4 | — | Planned |
| FR-LNK-10 | MUST | soc-cloud | M1 | `services/soc-cloud/tests/test_wire.py`, `services/soc-cloud/tests/test_stack_link.py::test_a_reply_its_schema_refuses_is_not_sent` | Partial: every reply the link sends is held to Sky Orchestrator's vendored schema first and not sent if refused; commands arrive in M4 |
| FR-LNK-11 | SHOULD | soc-cloud | M1 | `services/soc-cloud/tests/test_stack_link.py::test_an_announcement_is_acknowledged_with_its_tid_and_bid`, `services/soc-cloud/tests/test_against_broker.py::test_an_announcement_is_acknowledged_and_presence_followed` | Done: each `update_topo` gets one `status_reply` with its tid and bid and result 0, held to its schema |
| FR-TEL-01 | MUST | soc-cloud, soc-web | M2 | `services/soc-cloud/src/soc_cloud/fanout.py`, `contracts/broadcast/telemetry.schema.json`, `services/soc-cloud/tests/test_against_platform.py::test_every_sample_reaches_the_farms_members_in_order_and_no_one_else` | Partial: every sample to its stack's organization's private topic, as the contract says; on the real Realtime a member receives all 50 samples of a 10 s run at 5 Hz in order and a member of another organization cannot join; the 60 s run and the browser's side arrive with the scene's aircraft |
| FR-TEL-02 | MUST | soc-web | M2 | — | Planned |
| FR-TEL-03 | MUST | soc-web | M2 | — | Planned |
| FR-TEL-04 | MUST | soc-cloud, database | M4 | — | Planned |
| FR-TEL-05 | MUST | soc-web | M4 | — | Planned |
| FR-GEO-01 | MUST | soc-web, libs, database | M3 | — | Planned |
| FR-GEO-02 | MUST | soc-web, libs, database | M3 | — | Planned |
| FR-GEO-03 | MUST | soc-web, libs, database | M3 | — | Planned |
| FR-GEO-04 | MUST | soc-web, libs, database | M3 | — | Planned |
| FR-WAY-01 | MUST | soc-web, libs | M3 | — | Planned |
| FR-WAY-02 | MUST | soc-web, libs | M3 | — | Planned |
| FR-WAY-03 | MUST | soc-web, libs | M3 | — | Planned |
| FR-WAY-04 | SHOULD | soc-web, libs | M3 | — | Planned |
| FR-WAY-05 | SHOULD | soc-web, libs | M3 | — | Planned |
| FR-WAY-06 | MUST | soc-web, libs | M3 | — | Planned |
| FR-WAY-07 | MUST | soc-web, libs | M3 | — | Planned |
| FR-WAY-08 | MUST | soc-web, libs, soc-cloud | M3, M4 | — | Planned |
| FR-WAY-09 | MUST | soc-web, libs | M3 | — | Planned |
| FR-WAY-10 | MUST | soc-web, libs | M3 | — | Planned |
| FR-WAY-11 | MUST | soc-operations | M3 | — | Planned |
| FR-WAY-12 | COULD | soc-operations, soc-web | M7 | — | Planned |
| FR-OPS-01 | MUST | soc-operations, soc-web, database | M4 | — | Planned |
| FR-OPS-02 | MUST | soc-operations, soc-web, database | M4 | — | Planned |
| FR-OPS-03 | MUST | soc-operations, soc-web, database | M4 | — | Planned |
| FR-OPS-04 | MUST | soc-operations, soc-web, database | M4 | — | Planned |
| FR-OPS-05 | MUST | soc-operations, soc-web, database | M4 | — | Planned |
| FR-OPS-06 | MUST | soc-operations, soc-web, database | M4 | — | Planned |
| FR-OPS-07 | MUST | soc-operations, soc-web, database | M4 | — | Planned |
| FR-OPS-08 | MUST | soc-operations, soc-web, database | M4 | — | Planned |
| FR-OPS-09 | MUST | soc-operations, soc-web, database | M4 | — | Planned |
| FR-OPS-10 | MUST | soc-operations, soc-web, database | M4 | — | Planned |
| FR-OPS-11 | COULD | database, soc-web | M6 | — | Planned |
| FR-OPS-12 | COULD | soc-operations, soc-web, database | M7 | — | Planned |
| FR-CMD-01 | MUST | soc-web, database, soc-cloud | M4 | — | Planned |
| FR-CMD-02 | MUST | soc-web, database, soc-cloud | M4 | — | Planned |
| FR-CMD-03 | MUST | soc-web, database, soc-cloud | M4 | — | Planned |
| FR-CMD-04 | MUST | soc-web, database, soc-cloud | M4 | — | Planned |
| FR-CMD-05 | MUST | soc-web, database, soc-cloud | M4 | — | Planned |
| FR-CMD-06 | MUST | soc-web, database, soc-cloud | M4 | `database/tests/test_command_intents.py::test_every_change_is_broadcast_on_the_organizations_state_topic` | Partial: every request and change of a command reaches the organization's state topic at commit; the console arrives in M4 |
| FR-CMD-07 | MUST | soc-web, database, soc-cloud | M4 | — | Planned |
| FR-CMD-08 | COULD | soc-operations, soc-cloud | M7 | — | Planned |
| FR-SAF-01 | MUST | soc-cloud, libs | M4 | — | Planned |
| FR-SAF-02 | MUST | soc-web, soc-operations | M2 | — | Planned |
| FR-SAF-03 | MUST | soc-cloud, soc-web | M2 | — | Planned |
| FR-SAF-04 | MUST | soc-cloud, soc-operations | M4 | — | Planned |
| FR-SAF-05 | MUST | soc-cloud, soc-operations | M1 | `libs/soc-config/tests/test_configuration.py::test_each_key_removed_is_named`, `libs/soc-config/tests/test_start.py::test_each_variable_removed_is_named`, `services/soc-cloud/tests/test_main.py`, `services/soc-operations/tests/test_settings.py`, `services/soc-operations/tests/test_main.py` | Partial: every missing or invalid key and variable refused by name, all at once; both services exit with status 2 before any connection, naming every problem |
| FR-SAF-06 | MUST | soc-operations, soc-web | M4 | — | Planned |
| FR-LOG-01 | MUST | soc-operations, soc-cloud, database, soc-web | M4 | — | Planned |
| FR-LOG-02 | MUST | soc-operations, soc-cloud, database, soc-web | M4 | — | Planned |
| FR-LOG-03 | MUST | soc-operations, soc-cloud, database, soc-web | M4 | — | Planned |
| FR-REP-01 | COULD | soc-web, database | M6 | — | Planned |
| FR-REP-02 | COULD | soc-web | M6 | — | Planned |
| FR-DEP-01 | MUST | infra | M1 | `tools/tests/test_compose.py`, `infra/check/tests/test_images.py`, `infra/check/tests/test_web_image.py` | Partial: one compose project runs `soc-migrate`, `soc-cloud`, `soc-operations` and `soc-web`, each with a health check, valid for `docker compose config`; the timed bring-up of the whole stack arrives with the stack check |
| FR-DEP-02 | MUST | infra | M1 | `database/tests/test_ledger_and_roles.py`, `infra/migrate/tests/*` | Done: ledger, checksums, advisory lock, SCRAM passwords; 26 gate tests and the container lane |
| FR-DEP-03 | MUST | contracts, soc-config | M1 | `libs/soc-config/tests/test_contract.py`, `libs/soc-config/tests/test_configuration.py`, `services/soc-cloud/tests/test_settings.py`, `services/soc-operations/tests/test_settings.py` | Partial: every key and variable declared once with unit, range and default, validated at start (ADR-0019); `soc-cloud` and `soc-operations` read exactly their keys; `soc-web` arrives next |
| FR-DEP-04 | MUST | infra | M1 | `apps/soc-web/nginx/soc-web.sh`, `infra/check/tests/test_web_image.py::test_one_image_serves_any_address`, `apps/soc-web/src/config/runtime.test.ts` | Done: the image writes `/config.json` and its policy from the environment at start, refusing a bad address or any key but the public one; one built image serves two containers configured for two addresses, each with its own |
| FR-DEP-05 | MUST | infra | M2 | — | Planned |
| FR-DEP-06 | MUST | infra, repository | M1 | `tools/tests/test_workflows.py::Release` | Partial: each release publishes `soc-cloud`, `soc-operations` and `soc-migrate` to GHCR at its tag, never moving one; the deploy command and its flight guard arrive with the flights (M4) |

## Non-functional

| ID | Priority | Unit | Milestone | Test | Status |
| --- | --- | --- | --- | --- | --- |
| NFR-PERF-01 | MUST | soc-cloud, soc-web | M2 | `services/soc-cloud/tests/test_against_platform.py::test_every_sample_reaches_the_farms_members_in_order_and_no_one_else` | Partial: from the dock's publish to a member's socket, 1.6 ms at p95 on one machine (2026-10-11), held at 150 ms on the lane; on the LAN with the box in the viability session |
| NFR-PERF-02 | MUST | soc-web, database, soc-cloud | M4 | `services/soc-cloud/tests/test_against_platform.py::test_commands_reach_the_wire_through_pg_notify_within_50_ms_at_p95` | Partial: from commit to claim p95 under 50 ms over 100 commands on the container lane; the click and the console arrive in M4, the box measurement in the viability session |
| NFR-PERF-03 | MUST | soc-cloud | M1 | — | Planned |
| NFR-PERF-04 | MUST | soc-cloud, libs | M4 | — | Planned |
| NFR-PERF-05 | MUST | soc-web | M1 | `apps/soc-web/scripts/budget.mjs` | Partial: the initial JavaScript (172.9 KB gzip) and the 3D chunk, loaded apart (244.4 KB gzip), held to their budgets in CI and in the image build; the load times on the LAN arrive with the viability session |
| NFR-PERF-06 | MUST | soc-web | M1 | `apps/soc-web/src/scene/sampler.ts`, `apps/soc-web/src/scene/sampler.test.ts` | Partial: the scene's frame-time sampler; orbiting for 5 s at 1920×1080 in Chrome gave 17.2 ms at p95 on an Intel UHD (TGL GT1, below the Iris Xe class of `ASM-02`) and 17.1 ms on an RTX 3050 Ti (2026-10-11), with no telemetry yet; the scripted 60 s with two aircraft on `ASM-02` arrives with the flight console |
| NFR-PERF-07 | SHOULD | soc-cloud | M4 | — | Planned |
| NFR-RES-01 | MUST | soc-web | M1 | `apps/soc-web/src/scene/canvas.ts`, `apps/soc-web/src/scene/canvas.test.ts`, `apps/soc-web/src/scene/Meter.tsx` | Partial: rendered on demand; in Chrome, 0 frames over 30 s of idle and one frame per theme change (2026-10-11); the frame counter in the end-to-end suite arrives with it |
| NFR-RES-02 | MUST | soc-web | M2 | — | Planned |
| NFR-RES-03 | MUST | soc-web | M2 | — | Planned |
| NFR-RES-04 | MUST | soc-cloud, soc-operations | M1 | `infra/check/tests/test_images.py::test_soc_operations_is_healthy_read_only_within_its_memory_at_rest` | Partial: `soc-operations` 37.9 MiB at rest in its image, held under 64 MiB on the container lane; `soc-cloud` and the load figures in the stack check |
| NFR-RES-05 | MUST | soc-web, soc-cloud, soc-operations, infra | M1 | `tools/tests/test_compose.py`, `infra/check/tests/test_web_image.py` | Partial: every container declares memory and CPU limits, 384 MB in all, held at 512 MB at most by a gate test; `soc-web` 2.3 MiB at rest (measured 2026-10-11), held under 16 MiB on the lane; the measurement under load arrives with the stack check |
| NFR-RES-06 | MUST | soc-cloud, soc-operations | M4 | — | Planned |
| NFR-RES-07 | MUST | soc-cloud | M2 | `services/soc-cloud/src/soc_cloud/fanout.py`, `services/soc-cloud/tests/test_fanout.py` | Partial: at most `broadcast_max_rate_hz` sends per aircraft, the latest sample winning, samples due together in one send; the tenant's counted events measured on the box |
| NFR-REL-01 | MUST | soc-cloud, soc-operations | M4 | `services/soc-cloud/tests/test_commands.py::test_the_sweep_runs_what_was_missed_and_settles_what_was_left_sent`, `services/soc-cloud/tests/test_against_platform.py::test_a_command_committed_while_soc_cloud_was_away_runs_once_or_expires` | Partial: across a `soc-cloud` restart no command is sent twice or dropped; the flight state arrives in M4 |
| NFR-REL-02 | MUST | soc-cloud | M4 | `services/soc-cloud/tests/test_commands.py::test_an_intent_announced_three_times_runs_once`, `database/tests/test_command_intents.py::test_a_claim_runs_once` | Done: an intent announced three times is published once; the claim is one conditional update |
| NFR-REL-03 | MUST | soc-cloud, soc-operations | M1 | `libs/soc-supervision/tests/test_supervisor.py`, `libs/soc-db/tests/test_against_postgres.py::test_a_terminated_backend_is_replaced_listened_and_swept_again`, `libs/soc-realtime/tests/test_socket.py`, `services/soc-cloud/tests/test_against_platform.py`, `services/soc-cloud/tests/test_against_broker.py::test_the_link_returns_after_the_broker_restarts` | Partial: one supervisor, backoff capped at 10 s and reset only after a stable link, under the database connection and the Realtime socket; `soc-cloud` comes up ready on the platform and its stack, and its broker link returns after Mosquitto restarts |
| NFR-REL-04 | MUST | soc-cloud, soc-operations | M1 | — | Planned |
| NFR-REL-05 | SHOULD | soc-cloud, soc-operations | M5 | — | Planned |
| NFR-REL-06 | MUST | soc-cloud, soc-operations | M1 | — | Planned |
| NFR-REL-07 | MUST | soc-web | M2 | — | Planned |
| NFR-SAF-01 | MUST | repository | M4 | — | Planned |
| NFR-SAF-02 | MUST | soc-cloud, soc-web | M2 | — | Planned |
| NFR-SAF-03 | MUST | soc-cloud, soc-operations, soc-web | M1 | — | Planned |
| NFR-SAF-04 | MUST | soc-cloud, soc-operations | M4 | — | Planned |
| NFR-SAF-05 | MUST | soc-operations | M4 | — | Planned |
| NFR-SAF-06 | MUST | soc-cloud, soc-operations | M1 | — | Planned |
| NFR-SEC-01 | MUST | database, soc-web, soc-cloud, infra | M1 | `database/tests/test_realtime_authorization.py`, `database/tests/test_membership.py`, `database/tests/test_fleets.py`, `libs/soc-realtime/tests/test_against_realtime.py` | Partial: live-membership helpers and Realtime authorization tested per role, and enforced by the real Realtime: strangers, deleted organizations and anonymous clients refused, member sends dropped; each table adds its policies |
| NFR-SEC-02 | MUST | database, soc-web, soc-cloud, infra | M1 | `apps/soc-web/scripts/secrets.mjs`, `apps/soc-web/src/test/secrets.test.ts`, `infra/check/tests/test_web_image.py`, `apps/soc-web/src/config/runtime.test.ts` | Done: the built files are searched for a JWT, a secret key and the services' secret variables in CI and in the image build; the image and the web both refuse to start with the service role key |
| NFR-SEC-03 | MUST | database, soc-web, soc-cloud, infra | M1 | `libs/soc-config/tests/test_configuration.py::test_served_organizations_are_distinct_uuids` | Partial: an empty or malformed allowlist stops the start; refusing intents outside it arrives with the services |
| NFR-SEC-04 | MUST | repository | M0 | `.github/workflows/ci.yml` (gitleaks over the full history), `.pre-commit-config.yaml` (gitleaks on what is staged) | Done: secret scan in CI on every pull request and before every commit |
| NFR-SEC-05 | MUST | soc-cloud | M1 | — | Planned |
| NFR-SEC-06 | MUST | soc-cloud | M4 | `services/soc-cloud/tests/test_files.py` | Partial: 128 random bits per path, served until `flight_file_grace_s` after the flight ends; Sky Orchestrator's network only arrives with the compose stack, the flight end with the operations (M4) |
| NFR-SEC-07 | MUST | soc-web, infra | M1 | `apps/soc-web/nginx/`, `infra/check/tests/test_web_image.py`, `apps/soc-web/lint-rules.js` | Partial: a strict policy (scripts and styles from the console only, connections to its own Supabase only, `frame-ancestors 'none'`), no-referrer, nosniff and no server version, checked on the running image, and no CSP violation in Chrome through sign-in, switch and theme; the header check against the deployed stack arrives with the stack check |
| NFR-SEC-08 | MUST | repository | M0 | `tools/tests/test_workflows.py::EveryWorkflow` | Partial: every action pinned to a released version and held by a test; lockfiles with hashes arrive with each unit in M1 |
| NFR-COMP-01 | MUST | soc-cloud, soc-operations, contracts | M1 | — | Planned |
| NFR-COMP-02 | MUST | soc-operations | M3 | — | Planned |
| NFR-COMP-03 | MUST | soc-cloud, soc-web, contracts | M4 | — | Planned |
| NFR-COMP-04 | MUST | infra | M4 | — | Planned |
| NFR-UX-01 | MUST | soc-web | M1 | `apps/soc-web/src/test/lint.test.ts`, `apps/soc-web/eslint.config.js` | Done: a lint rule refuses any colour literal outside `src/theme/theme.css`, held by its own test |
| NFR-UX-02 | MUST | soc-web | M1 | `apps/soc-web/src/theme/contrast.test.ts` | Done: every text token on every surface it is used on, and every emphasis on its subtle, at 4.5:1 or more in both themes |
| NFR-UX-03 | MUST | soc-web | M1 | — | Planned |
| NFR-UX-04 | MUST | soc-web | M1 | — | Planned |
| NFR-UX-05 | MUST | soc-web | M1 | `apps/soc-web/src/scene/motion.ts`, `apps/soc-web/src/scene/camera.ts`, `apps/soc-web/src/theme/theme.css` | Partial: interface transitions of 200 ms, camera moves damped over 0.25 s, and both off under `prefers-reduced-motion`; the count-up of changing numbers arrives with the panels |
| NFR-UX-06 | MUST | soc-web | M1 | — | Planned |
| NFR-UX-07 | MUST | soc-web | M2 | `apps/soc-web/src/app/clock.test.ts` | Partial: the clock in the organization's time zone, UTC on hover; units arrive with the panels |
| NFR-UX-08 | MUST | soc-web | M1 | — | Planned |
| NFR-MNT-01 | MUST | repository | M1 | — | Planned |
| NFR-MNT-02 | MUST | repository | M1 | — | Planned |
| NFR-MNT-03 | MUST | repository | M0 | — | Planned |
| NFR-MNT-04 | MUST | repository | M0 | `.github/workflows/ci.yml` (no file over 512 KB), `.pre-commit-config.yaml` (large files, private keys) | Done for size and keys; build output kept out by `.gitignore` |
| NFR-MNT-05 | MUST | libs, soc-web, tools | M0, M3 | — | Planned |
| NFR-MNT-06 | MUST | repository | M1 | — | Planned |
| NFR-TEST-01 | MUST | repository | M0 | `tools/tests/*`, `infra/migrate/tests/*`, `libs/*/tests/*`, `services/*/tests/*`, `apps/soc-web/src/**/*.test.*` | Done so far: tooling 174, soc-migrate 26, soc-config 195, soc-log 14, soc-supervision 18, soc-db 13, soc-realtime 17, soc-cloud 83, soc-operations 15, soc-check 7, soc-web 124 tests, each Python suite under 0.3 s and the web's under 2 s (ADR-0020), per unit in pre-commit and CI |
| NFR-TEST-02 | MUST | database | M1 | `database/tests/*`, `libs/soc-db/tests/test_against_postgres.py`, `libs/soc-realtime/tests/test_against_realtime.py`, `services/soc-cloud/tests/test_against_broker.py` | Done: an ephemeral Postgres from the production image with GoTrue's, Realtime's and VO2's surfaces loaded, the real Realtime v2.102.3 beside it, and Mosquitto 2.0.22 configured as Sky Orchestrator's broker; `soc-db`, `soc-realtime` and `soc-cloud` run their end-to-end tests there |
| NFR-TEST-03 | MUST | infra | M4 | — | Planned |
| NFR-TEST-04 | MUST | repository | M0 | — | Planned |
| NFR-TEST-05 | MUST | soc-cloud | M2 | — | Planned |
| NFR-TEST-06 | MUST | repository | M0 | — | Done: no model in SOC, no eval suite; stated in `docs/ci-cd.md` |
| NFR-OBS-01 | MUST | soc-cloud, soc-operations, soc-web | M1 | `libs/soc-log/tests/test_soc_log.py` | Partial: JSON lines with service, level, time and the correlation identifiers per task; the reconstruction test arrives with `soc-cloud` |
| NFR-OBS-02 | MUST | soc-cloud, soc-operations, soc-web | M1 | `libs/soc-supervision/tests/test_endpoint.py`, `services/soc-cloud/tests/test_against_platform.py`, `services/soc-operations/tests/test_against_postgres.py` | Partial: `/health` and `/ready` report every link with its state, age and error; `soc-cloud` reports the database, Realtime, the flight files and each stack; `soc-operations` its database |
| NFR-OBS-03 | MUST | repository | M0 | `.github/PULL_REQUEST_TEMPLATE.md`, `pr-policy.yml` (description present) | Done: every pull request names its evidence |
| NFR-OBS-04 | MUST | soc-cloud | M2 | `services/soc-cloud/src/soc_cloud/latency.py`, `services/soc-cloud/tests/test_latency.py`, `services/soc-cloud/tests/test_commands.py` | Done: every minute, one `latency` line with the count, p50, p95 and p99 of the telemetry's hold in `soc-cloud` and age at its read, and of each command's publish and reply, nearest-rank over measured values |
| NFR-OBS-05 | SHOULD | soc-web | M2 | `apps/soc-web/src/scene/StatsOverlay.tsx`, `apps/soc-web/src/app/SceneRegion.test.tsx` | Partial: with `?stats`, frames rendered, frame time at p95, draw calls, triangles, geometries and textures; GPU memory in bytes arrives with the site model's textures |
| NFR-PORT-01 | MUST | infra, soc-web | M1 | `infra/compose/compose.yaml`, `infra/check/tests/test_images.py` | Partial: the backend as a compose project of read-only images; on the mini-PC with the viability session |
| NFR-PORT-02 | MUST | repository | M0 | ADR-0016, ADR-0017 | Partial: every version chosen and argued; lockfiles and digests arrive with each unit in M1 |
| NFR-PORT-03 | MUST | infra | M5 | — | Planned |
| NFR-PORT-04 | MUST | infra, soc-web | M1 | `apps/soc-web/src/test/lint.test.ts` | Partial: a lint rule refuses the APIs plain HTTP lacks; the end-to-end check from a LAN address arrives with the image |
| NFR-PORT-05 | MUST | infra, soc-web | M1 | — | Planned |
