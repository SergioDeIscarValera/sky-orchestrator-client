# Dependencies on other projects

What SOC needs from Sky Orchestrator (SO) and Virtual Origen (VO2), who delivers
it, and what waits for it. Status is updated in the same pull request that
starts relying on an item.

Sources: the integration exchange with both projects' maintainers on
2026-10-07, and SO's pull request #108, which assigned SO's identifiers.

## Sky Orchestrator

| ID | SO item | SO milestone | What it gives SOC | SOC requirements waiting on it | Status |
| --- | --- | --- | --- | --- | --- |
| `DEP-01` | FR-DEV-07, ADR-0038 | M4 | The stack's state over HTTP: simulator mode, link and its reason, aircraft connected, armed and seconds left, clock offset | `FR-LNK-08`, `FR-OPS-05` (`PF-MODE`, `PF-ARMED`, `PF-CLOCK`), `FR-OPS-06`, `FR-OPS-07`, `FR-SAF-04` | **Delivered**, SO PR #113: `GET /v1/status`, so-wayline API 1.3.0 |
| `DEP-02` | FR-FLT-11, NFR-SAF-07, ADR-0037 | M4 | `simulate_mission` (all three fields) must agree with the stack's mode; a real prepare only for a file flown to `ok` in simulation; refusals `319015`, `325001`, `314010`, `319004` | `FR-OPS-06`, `FR-OPS-09`, `NFR-SAF-05` | **Delivered**, SO PR #109 |
| `DEP-03` | FR-WAY-11 | M4 | `GET /v1/envelope`: the active device envelope, with its fingerprint | `FR-OPS-08`, `FR-WAY-08`, `FR-GEO-04` | **Delivered**, SO PR #110, so-wayline API 1.2.0 |
| `DEP-04` | FR-WAY-12 | M4 | `POST /v1/validations`: dry-run validation of a flight file | `FR-LNK-09`, `PF-SO-DRYRUN`, `NFR-COMP-02` | **Delivered**, SO PR #110, so-wayline API 1.2.0 |
| `DEP-05` | FR-FLT-12 | M4 | The cause of a pause in `break_point.break_reason`, as DJI's `FlighttaskBreakReasonEnum` | `FR-LOG-02` | **Delivered**, SO PR #112 |
| `DEP-06` | NFR-TEST-07 | M4 | The fake bridge image on GHCR, test only | `NFR-TEST-03` | **Delivered**, SO PR #111, from SO's first release after v0.4.0 |
| `DEP-07` | FR-TEL-01 at 5 Hz | M4 | OSD at 5 Hz measured on the phone | `NFR-PERF-01` in the field, `FR-SAF-01` reaction distance | Requested |
| `DEP-08` | FR-TEL-07 | M5, possibly earlier | Horizontal and vertical speed, pitch, roll, remaining flight time | `FR-TEL-03` | Requested |
| `DEP-09` | FR-TEL-08 | M5 | Remote controller link quality, once verified on the Mavic Air 2 | `FR-TEL-03` | Requested |
| `DEP-10` | FR-FLT-13 | M5 | `break_point` honoured after `return_home` | `FR-CMD-08` | Requested |
| `DEP-11` | M4 exit: first real flight | M4 | The aircraft cleared for real flight through SO | SOC's M5 | Pending in SO |

A stack whose status cannot be read has an unknown mode, and SOC refuses to
prepare (`FR-SAF-04`). With SO's link down, its status still carries the
deployment's simulator mode, so `simulate_mission` can always be set from it.

## Virtual Origen

| ID | VO2 item | Owner | What it gives SOC | SOC requirements waiting on it | Status |
| --- | --- | --- | --- | --- | --- |
| `DEP-20` | ADR 0059 and its gate test | VO2 | `private.is_member`, `has_role`, `current_member_orgs`, the `role` enum, and the columns SOC reads of `organizations`, `memberships`, `profiles` declared as a contract | `FR-AUT-*`, `NFR-SEC-01` | Proposed |
| `DEP-21` | `PGRST_DB_SCHEMAS` gains `soc` | Sergio, on the mini-PC | PostgREST serves schema `soc` | Every web read and write | Box step |
| `DEP-22` | GoTrue `ADDITIONAL_REDIRECT_URLS` gains SOC's origin | Sergio, on the mini-PC | Email links (password reset) that land on SOC | `FR-AUT-04` | Box step |
| `DEP-23` | Realtime Broadcast with private channels | SOC's M1 smoke test, on VO2's stack | The live path, measured on the box, surviving a recreate of the Realtime container; ES256 joins (VO2's `API_JWT_JWKS`, set in its hotfix 0.0.35) | `FR-TEL-01`, `NFR-PERF-01` | To measure |
| `DEP-24` | `TENANT_MAX_EVENTS_PER_SECOND` raised in VO2's Realtime environment | VO2, with Sergio | The tenant's limit (default 100, sends plus deliveries, shared with VO2) raised before SOC follows more than one aircraft | `NFR-RES-07` | Needed before M7 |
| `DEP-25` | Review of `realtime.messages` policies | VO2 and SOC | SOC's restrictive guard policies agreed with whatever VO2 has or adds on that table | `FR-TEL-01`, `NFR-SEC-01` | **Agreed**: VO2 has none; SOC's guards pass every other topic through (`database/migrations/0003`), as VO2 asked |

## What SOC gives back

| To | Item |
| --- | --- |
| SO | A real cloud client exercising `cloud_role: external`, and its end-to-end suite run against SO's published images |
| VO2 | A second consumer of the identity contract, held by VO2's gate test |
