# soc-operations

SOC's operations
([ADR-0002](../../docs/architecture/decisions/0002-monorepo-and-service-boundaries.md),
[ADR-0017](../../docs/architecture/decisions/0017-backend-stack.md)): the
operation lifecycle and its state machine, the preflight checks, the simulation
gate, and the flight files `soc-cloud` serves.

## What runs today

The skeleton the operations plug into, and the flight file builder:

| Part | Module |
| --- | --- |
| Settings: the contract's keys for `soc-operations` as a typed view, the environment; fail closed | `settings.py` |
| The database link, supervised, as `soc_operations`, which may request commands (`soc.command_intents`) | `service.py`, through `soc-db` |
| `/health` and `/ready` on `SOC_HEALTH_PORT` (`NFR-OBS-02`) | `service.py`, through `soc-supervision` |
| The process: JSON logs, SIGTERM and SIGINT stop it cleanly | `__main__.py` |
| A flight's file: built, fingerprinted and read back (FR-WAY-11) | `flight_files.py` |

The operations, their transitions and the intents they execute (ADR-0006)
arrive with the operations data model in M4 ([roadmap](../../docs/roadmap.md)).

## Flight files

`flight_files.py` turns a flight, the baked wayline as its operation flies it
(`$defs.flight` of `contracts/geometry/design.schema.json`), into the KMZ that Sky
Orchestrator's dock downloads (FR-WAY-11,
[ADR-0008](../../docs/architecture/decisions/0008-flight-files-served-on-sky-orchestrators-network.md)).
`soc-cloud` serves the bytes; this module builds them, fingerprints them and reads
them back.

| Function | Does |
| --- | --- |
| `build(flight, name=...)` | The KMZ's bytes for a flight, or a `ValueError` naming what the subset cannot fly |
| `fingerprint(kmz)` | The MD5 hex digest, as Sky Orchestrator's plan records it (`fingerprint_md5`) |
| `read(kmz)` | The flight's fields back from a KMZ this module wrote; the round-trip tests use it |

**What is written.** Two files, laid out as DJI's WPML has them:

- `wpmz/template.kml`: the wayline's name, the mission config, and a folder with
  `templateType` `waypoint` and `templateId` `0`. Sky Orchestrator reads only the
  name and the template type from it.
- `wpmz/waylines.wpml`: the mission config and one folder, with a placemark per
  waypoint in flight order. This is the file that is flown.

Every element is in the subset Sky Orchestrator accepts
([`supported-subset.md`](../../contracts/sky-orchestrator/wpml/supported-subset.md)).

**Conventions**, settled once here:

- A flight's positions are `[longitude, latitude]`. A placemark's `coordinates` are
  `longitude,latitude`, with no height. `takeOffRefPoint` is `latitude,longitude,0`:
  DJI's order is translated in this module and nowhere else.
- Heights are metres above the takeoff point (`executeHeight`). The security height
  is `takeOffSecurityHeight`.
- Speeds are metres per second. `globalTransitionalSpeed` and `autoFlightSpeed`
  carry the wayline's speed. Placemark *i*'s `waypointSpeed` is the speed on the leg
  out of waypoint *i*: the next waypoint's `speed_ms` when it has one, else the
  wayline's. The transit into waypoint 0 flies at the wayline's speed.
- `finish_action` maps to DJI's finish action: `return_home` to `goHome`, `hold` to
  `noAction`, `land` to `autoLand`.
- Headings are `fixed`, and turns are `toPointAndStopWithDiscontinuityCurvature`:
  the aircraft flies straight to each waypoint and stops there.
- Numbers are Python's shortest `repr`, in plain decimal and never in scientific
  notation, so `float(text)` gives back the value exactly.

**Determinism.** The same flight and name give the same bytes. The entries are in a
fixed order with a fixed timestamp (1980-01-01 00:00:00), with fixed attributes, and
no comment and no extra fields. They are stored rather than deflated: no zlib release
can move a byte, and a flight file is a few kilobytes.

**Refused, nothing written** (`ValueError`, naming the problem): no waypoint; an
index out of order; a position that is not two finite numbers in range; a height
not in (0, 120] m; a speed not in (0, 15] m/s, the wayline's or a waypoint's; a
takeoff security height not in (0, 120] m; a finish action other than the three;
actions on a waypoint, which the file does not write until FR-WAY-12; a speed into
waypoint 0 that differs from the wayline's, which the file cannot carry; a name that
is empty or holds a character XML cannot carry; a flight with any violation (FR-WAY-08),
each named with its rule and waypoint: a flight file is only ever built from a clean
flight.

**Read back, refused:** a DOCTYPE or an entity declaration, malformed XML, and a KMZ
that does not hold the two files in order.

**Not this module's job.** The stack's envelope is not checked here: the flight
reports what breaks it as violations, which refuse the build, and the preflight
(FR-OPS-03) checks the envelope again when it arrives with the operations.

**Sky Orchestrator's verdict** (NFR-COMP-02). `soc_operations.so_acceptance` builds
every golden case and runs so-wayline's own `ingest.validate` on it, from Sky
Orchestrator's checkout and in its own interpreter, under three envelopes: a
permissive one, Sky Orchestrator's defaults, and one tight enough to break every
rule. Each reference file must be `VALID` under the permissive one, and every
refusal must be the one `soc_geo.limits` predicts for the flight, rule by rule and
waypoint by waypoint. Nothing of Sky Orchestrator's stack is touched:

```bash
uv run --frozen python -m soc_operations.so_acceptance \
  --so-root ../sky-orchestrator --so-python <python with lxml and jsonschema-rs>
```

On 2026-10-12, against Sky Orchestrator's `develop` at `5172e08` (v0.4.2), both
reference files were `VALID`, and all four refusing cases agreed, 45 findings in
all. The HTTP dry run (`POST /v1/validations`) runs the same `ingest.validate`; it
joins the end-to-end suite with the stack session.

**Golden files.** `contracts/flight-files/` holds two reference waylines as text:
each one's flight, the two XML files it builds, and the KMZ's SHA-256 and fingerprint.
`tests/test_flight_files.py` rebuilds each and requires the same bytes. The subset
tests read `contracts/sky-orchestrator/wpml/supported-subset.md` and hold every element
written, every required element of a parent written, and every value to the page's
own tables. How a deliberate change regenerates a golden case is in
[its README](../../contracts/flight-files/README.md).

## Running it

```bash
uv run soc-config example soc-operations > /etc/soc/soc-operations.json
SOC_CONFIG_FILE=/etc/soc/soc-operations.json ... uv run soc-operations
```

## Tests

```bash
uv run --frozen mypy services/soc-operations
uv run --frozen pytest services/soc-operations/tests -m "not lane"   # gate
uv run --frozen pytest services/soc-operations/tests -m lane         # lane, needs Docker
```

`tests/test_so_acceptance.py` holds the acceptance check itself to a reduced Sky
Orchestrator checkout: a refusal SOC did not predict, an acceptance where SOC
predicts a refusal, and a checkout that does not run each fail it.

The settings read exactly the keys the contract gives `soc-operations`, each
removed key stops the start naming it, no secret shows; a refused configuration
exits with status 2 and one line naming every problem; on the container lane the
service comes up ready on the production Postgres image as `soc_operations`.

## Failure modes

| Failure | What happens |
| --- | --- |
| A missing or invalid setting or variable | The process exits with status 2 before opening any connection, naming every problem |
| Postgres unreachable, or the password refused | The database link stays down, retried up to every 10 s; `/ready` answers 503 naming the error |
| A bug in a supervised part | The process ends with status 1 and a `service_failed` line |
| SIGTERM | The link closes and the process exits with status 0 |
| A flight the subset cannot fly | `flight_files.build` raises `ValueError` naming it; no file is made |
| A change to the builder moves a byte of a flight file | The golden tests fail; a deliberate change regenerates the golden case in the same commit |
| A flight with violations | `flight_files.build` refuses it, naming each rule and waypoint; no file is made |
