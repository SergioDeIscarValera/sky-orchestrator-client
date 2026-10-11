# Dependencies on other projects

What SOC needs from Sky Orchestrator (SO) and Virtual Origen (VO2), who delivers
it, and what waits for it. Status is updated in the same pull request that
starts relying on an item.

Sources: the integration exchange with both projects' maintainers on
2026-10-07, and SO's pull request #108, which assigned SO's identifiers.

## Sky Orchestrator

SOC vendors Sky Orchestrator's wire contracts at a pinned commit,
[`contracts/sky-orchestrator/`](../../contracts/sky-orchestrator/README.md),
pinned to Sky Orchestrator's v0.4.2 tag, the release that publishes `DEP-01` to
`DEP-06`, `DEP-12`, `DEP-13` and `DEP-27`, and the real-flight keys of SO's
ADR-0040. Its images run SOC's stack check (`SO_VERSION=v0.4.2`).

| ID | SO item | SO milestone | What it gives SOC | SOC requirements waiting on it | Status |
| --- | --- | --- | --- | --- | --- |
| `DEP-01` | FR-DEV-07, ADR-0038 | M4 | The stack's state over HTTP: simulator mode, link and its reason, aircraft connected, armed and seconds left, clock offset | `FR-LNK-08`, `FR-OPS-05` (`PF-MODE`, `PF-SIMULATOR`, `PF-ARMED`, `PF-CLOCK`), `FR-OPS-06`, `FR-OPS-07`, `FR-SAF-04` | **Delivered**, SO PR #113: `GET /v1/status`, so-wayline API 1.3.0 |
| `DEP-02` | FR-FLT-11, NFR-SAF-07, ADR-0037 | M4 | `simulate_mission` (all three fields) must agree with the stack's mode; a real prepare only for a file flown to `ok` in simulation; refusals `319015`, `325001`, `314010`, `319004` | `FR-OPS-06`, `FR-OPS-09`, `NFR-SAF-05` | **Delivered**, SO PR #109 |
| `DEP-03` | FR-WAY-11 | M4 | `GET /v1/envelope`: so-wayline's envelope, the server's check of every flight file, with its fingerprint; the phone enforces its own, set equal to it by hand (see below) | `FR-OPS-08`, `FR-WAY-08`, `FR-GEO-04` | **Delivered**, SO PR #110, so-wayline API 1.2.0 |
| `DEP-04` | FR-WAY-12 | M4 | `POST /v1/validations`: dry-run validation of a flight file | `FR-LNK-09`, `PF-SO-DRYRUN`, `NFR-COMP-02` | **Delivered**, SO PR #110, so-wayline API 1.2.0 |
| `DEP-05` | FR-FLT-12 | M4 | The cause of a pause in `break_point.break_reason`, as DJI's `FlighttaskBreakReasonEnum` | `FR-LOG-02` | **Delivered**, SO PR #112 |
| `DEP-06` | NFR-TEST-07 | M4 | The fake bridge image on GHCR, test only | `NFR-TEST-03` | **Delivered**, SO PR #111; published in v0.4.1 (`ghcr.io/sergiodeiscarvalera/sky-orchestrator/fake-bridge:v0.4.1`) |
| `DEP-07` | FR-TEL-01 at 5 Hz | M4 | OSD at 5 Hz measured on the phone | `NFR-PERF-01` in the field, `FR-SAF-01` reaction distance | Requested |
| `DEP-08` | FR-TEL-07 | M5, possibly earlier | Horizontal and vertical speed, pitch, roll, remaining flight time | `FR-TEL-03` | Requested |
| `DEP-09` | FR-TEL-08 | M5 | Remote controller link quality, once verified on the Mavic Air 2 | `FR-TEL-03` | Requested |
| `DEP-10` | FR-FLT-13 | M5 | `break_point` honoured after `return_home` | `FR-CMD-08` | Requested |
| `DEP-11` | M4 exit: first real flight | M4 | The aircraft cleared for real flight through SO | SOC's M5 | Pending in SO: the real-flight ground check passed on the phone with the propellers off (SO PR #127); the first real flight waits for SOC's MVP |
| `DEP-12` | FR-SAF-06, bridge contract 1.6.0 | M4 | An execute while the operator holds the aircraft from the phone's console is refused `314010`, as an unarmed phone is: the operator acts on the phone, then SOC retries | `FR-OPS-09` | **Delivered**, SO PR #114 |
| `DEP-13` | FR-BRG-09 | M4 | `takePhoto` and `gimbalRotate` run once per waypoint visit, and a resume does not repeat a photo already taken; `flighttask_progress.ext.media_count` stays 0 | `FR-WAY-12` | **Delivered**, SO PR #115 |
| `DEP-26` | ADR-0040, bridge contract 1.8.0 | M4 | The phone's readiness for a real execute in `/v1/status` (real flight confirmed on the phone, build cleared by a simulator pass, simulator off), so SOC can check it before an execute instead of learning it from a `314010` | `FR-OPS-05`, `FR-OPS-09` | Not before the MVP (SO, 2026-10-11): the operator sees both on the phone's screen, and SOC's MVP does without them; Sergio's call if it ever needs them (bridge contract 1.9.0, wayline API 1.4.0) |
| `DEP-27` | ADR-0041, bridge contract 1.9.0 | M4 | A start or a resume carries a deadline 3 s ahead on the phone's clock and is refused `command_expired` past it, so nothing so-bridge gave up on can fly; an execute answered `319999` has an unknown outcome, which the flight's progress settles | `FR-LNK-06`, `FR-OPS-09` | **Delivered** on SO's `develop` (SO PR #128), in SO's next release |

SO's `infra/fly.py --stop-after S` sends `return_home` S seconds into a route: the
reference SOC's stop path is compared with.

### What SO's M4 phone session showed (2026-10-11)

Every M4 step passed in the simulator on the real Mavic Air 2, through the stack
on DJI's wire. What SOC's operation flow takes from it (M4):

- **After a `314010` on execute** (`DEP-12`, the operator holds the aircraft),
  the task stays `PREPARED`. SOC retries the execute once the operator releases,
  or sends `flighttask_undo`; a new prepare before either is refused `319016`,
  one task at a time (SO's FR-FLT-09).
- **`return_home`** ends the task `COMPLETED_ABORTED` with `322283`, and the task
  stays `RETURNING` until the aircraft is on the ground: near home it lands where
  it is, away from home the landing waits for the pilot's stick (SO's ADR-0018).
  SOC gives that state no timeout of its own.
- **`link.changed_at_ms`** in `/v1/status` means when the link became what it
  is, up or down (SO PR #121, described in v0.4.2), no longer every change of
  its health.
- **`flighttask_progress.ext.media_count`** will carry the number of files the
  camera wrote during the task from SO's bridge contract 1.7.0 (`DEP-13` records
  0 today; DJI's wire shape is unchanged). SOC reads nothing from it yet.
  Downloading the images is SO's M5, which suits SOC: it has no media
  requirement before then. SO #125 delivered it on SO's `develop`: the count is
  of files, not shots (a Mavic Air 2 set to JPEG+RAW counts 2 per photo), it
  never decreases within a task, and it stays 0 from an application older than
  1.7.0. SOC takes it with SO's next release.
- Measured on the phone: OSD at 5 Hz, 300 of 300 messages in 60 s for aircraft
  and dock; clock offset −504 ± 18 ms; a 31.9 s loss of the phone's Wi-Fi
  mid-mission survived, the task ending `COMPLETED_OK`; 13 photos, 13 files.

### What SO #126 changes for real flight (ADR-0040, 2026-10-11)

How SO unlocks real flight. It reaches SOC with SO's next release, and nothing
changes in simulator mode. In real mode (`simulator_mode: false` in
`/v1/status` and in so-bridge):

- **An execute is refused `314010`** while the phone lacks either of two
  conditions: the operator has confirmed real flight on the phone's screen since
  the app started (so-bridge preflight code `real_flight_not_confirmed`), and
  the app's build has a recorded simulator pass (`build_not_cleared`). The two
  codes replace `simulator_not_active` in bridge contract 1.8.0. A `314010` on
  execute therefore has three causes in real mode: the phone unarmed, the
  aircraft held from the phone's console (`DEP-12`), or real flight not
  unlocked on the phone. `/v1/status` says whether the phone is armed, not the
  other two, and SO will not say them before the MVP (`DEP-26`): with the phone
  armed, a `314010` on execute means real flight not confirmed, the build not
  cleared, or the aircraft held, and SOC's message names the three
  (`FR-OPS-09`).
- **A phone still in its simulator refuses the execute** (so-bridge code
  `simulator_in_real_mode`). The reply carries `316010` (`AIRCRAFT_NOT_DETECTED`),
  as a lost link does, and as a phone without its simulator does in simulator
  mode. `/v1/status` tells the three apart: `link.state` down; `simulator_mode`
  true with `simulator_active` false; `simulator_mode` false with
  `simulator_active` true. SOC checks the last two before it executes
  (`PF-SIMULATOR`).
- **A real prepare** still needs the same KMZ completed in simulation on this
  deployment (`NFR-SAF-07`, `314010` on the prepare), as before (`DEP-02`).

The first real flight waits for SOC's MVP, Sergio's call; SO's runbook for it is
`docs/first-real-flight.md` in SO's repository (`DEP-11`).

### Two envelopes, set equal by hand (SO, 2026-10-11)

`GET /v1/envelope` is not what the phone enforces:

- **so-wayline's envelope**, which `/v1/envelope` returns, is the server's check
  of every uploaded flight file and of `/v1/validations`.
- **The phone's device envelope** comes from its own `so-config.json`: its
  geofence centre, radius and heights (SO's FR-SAF-01, ADR-0012). The phone
  refuses a plan outside it, whatever the server judged; the prepare then
  answers `314010` and the phone's record names the distance. That is what
  refused SO's reference wayline, 1,103 km from the farm, on 2026-10-11.
- **SO cannot compare the two.** `application_in_force` in `/v1/envelope` is
  always null, because so-wayline never hears the phone's configuration, and
  the two fingerprints are computed differently. Today they differ:
  so-wayline's default centre is the synthetic 45.0/7.0, the phone's is the
  farm. SO's first-flight runbook sets so-wayline's centre, radius and maximum
  height to the phone's.

The phone judges every plan against its own envelope at load, in the simulator
too, and again at start from where the aircraft stands (SO's FR-SAF-01,
FR-WAY-10): with the simulator on and its own configuration it refused the
reference wayline at load on 2026-10-11 (SO #127). A simulated pass therefore
proves the phone accepts the file, provided its configuration is the same at the
real flight; `/v1/status`'s `config_fingerprint`, the SHA-256 of the phone's
whole configuration, shows that remotely. SOC records it at the pass and
requires the same value before the real prepare (`FR-OPS-06`, `FR-OPS-07`).

For SOC, `/v1/envelope` is necessary and not sufficient. `PF-ENVELOPE` and
`FR-WAY-08` check against it. Only the phone's own refusal can show a mismatch:
the simulated pass under the same fingerprint is the first guard, and the
runbook's comparison of the two envelopes by hand before the session the second
(`FR-OPS-08`). `FR-OPS-09` reads a `314010` on a prepare as either cause.

A stack whose status cannot be read has an unknown mode, and SOC refuses to
prepare (`FR-SAF-04`). With SO's link down, its status still carries the
deployment's simulator mode, so `simulate_mission` can always be set from it.

## Virtual Origen

| ID | VO2 item | Owner | What it gives SOC | SOC requirements waiting on it | Status |
| --- | --- | --- | --- | --- | --- |
| `DEP-20` | ADR 0059 and its gate test | VO2 | `private.is_member`, `has_role`, `current_member_orgs`, the `role` enum, and the columns SOC reads of `organizations`, `memberships`, `profiles` declared as a contract | `FR-AUT-*`, `NFR-SEC-01` | Proposed |
| `DEP-21` | `PGRST_DB_SCHEMAS` gains `soc` | Sergio, on the mini-PC | PostgREST serves schema `soc` | Every web read and write, from the organizations offered at sign-in (`soc.member_organizations`) | Box step; until it is done the web names it after sign-in |
| `DEP-22` | GoTrue `ADDITIONAL_REDIRECT_URLS` gains SOC's origin | Sergio, on the mini-PC | Email links (password reset) that land on SOC | `FR-AUT-04` | Box step |
| `DEP-23` | Realtime Broadcast with private channels | SOC's M1 smoke test, on VO2's stack | The live path, measured on the box, surviving a recreate of the Realtime container; ES256 joins (VO2's `API_JWT_JWKS`, set in its hotfix 0.0.35) | `FR-TEL-01`, `NFR-PERF-01` | Proven on the same Realtime and Postgres versions in the container lane; to measure on the box |
| `DEP-24` | `TENANT_MAX_EVENTS_PER_SECOND` raised in VO2's Realtime environment | VO2, with Sergio | The tenant's limit (default 100, sends plus deliveries, shared with VO2) raised before SOC follows more than one aircraft | `NFR-RES-07` | Needed before M7 |
| `DEP-25` | Review of `realtime.messages` policies | VO2 and SOC | SOC's restrictive guard policies agreed with whatever VO2 has or adds on that table | `FR-TEL-01`, `NFR-SEC-01` | **Agreed**: VO2 has none; SOC's guards pass every other topic through (`database/migrations/0003`), as VO2 asked |

## What SOC gives back

| To | Item |
| --- | --- |
| SO | A real cloud client exercising `cloud_role: external`, and its end-to-end suite run against SO's published images |
| VO2 | A second consumer of the identity contract, held by VO2's gate test |
