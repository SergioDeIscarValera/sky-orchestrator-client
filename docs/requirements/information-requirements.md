# Information requirements

What data exists, who owns it, what shape it has, and how long it lives.

Every entity has exactly one **owner**: the unit that creates it and decides its
state. Others read it through the database's contract, never by writing it.
Where an attribute exists on DJI's wire, this document uses DJI's name.

All SOC data lives in schema `soc` of Virtual Origen's database. From Virtual
Origen, SOC only reads `public.organizations`, `public.memberships` and
`public.profiles` ([ADR-0005](../architecture/decisions/0005-one-database-shared-with-virtual-origen.md)).

---

## Canonical units and reference frames

Read this before writing code that touches a coordinate or a height. The frames
are Sky Orchestrator's ([ADR-0014](../architecture/decisions/0014-units-and-reference-frames.md)).

| Quantity | Canonical representation |
| --- | --- |
| Horizontal position | WGS84 latitude and longitude, decimal degrees, IEEE-754 double |
| **Height** | Metres above the **takeoff point**. The only height sent to Sky Orchestrator. Named `height_m`. |
| Terrain elevation | Metres above mean sea level, from the site model, display only. Named `elevation_m`. |
| Local plane | East and north metres on the tangent plane at the organization's position, named `east_m`, `north_m` |
| Distance, length | Metres |
| Speed | Metres per second |
| Heading | Degrees clockwise from true north, 0 to 360 |
| Pitch, roll | Degrees, signed, −180 to 180 |
| Battery | Integer percent, 0 to 100 |
| Time | `timestamptz` in the database; Unix milliseconds UTC on DJI's wire and in broadcasts |
| Duration | Seconds, unless the name ends in `_ms` |
| Identifiers | Lowercase UUID v4 unless DJI defines them (serial numbers) |
| Polygon | Ring of `[longitude, latitude]` pairs, GeoJSON order, not closed (the last vertex is not the first repeated) |

Rules:

1. No bare number for a physical quantity: the unit is in the name or the schema.
2. Conversions live in one tested module per language, held equal by the golden
   vectors in `contracts/geometry/`.
3. GeoJSON order (`[longitude, latitude]`) is used for polygons and waypoints in
   storage; DJI's order is translated in exactly one place, the flight file
   builder.

---

## IR-ORG — Organization (read only, Virtual Origen's)

`public.organizations`: `id`, `name`, `owner_id`, `latitude`, `longitude`,
`timezone`, `deleted_at`. `public.memberships`: `id`, `organization_id`,
`profile_id`, `role`, `deleted_at`. `public.profiles`: `id`, `display_name`,
`email`, `deleted_at`. Held as a contract by Virtual Origen's ADR 0059.

**IR-ORG-01**: an organization with `deleted_at` set gives no access in SOC, even
to its members: SOC checks it, because Virtual Origen's `is_member` does not.

---

## IR-MOD — Aircraft model

Owner: the catalogue in `contracts/catalogue/aircraft-models.json`, loaded by a
migration. Retention: permanent. Read only for every user.

| Attribute | Type | Notes |
| --- | --- | --- |
| `model_key` | text | Primary key, kebab case, e.g. `mavic-air-2` |
| `display_name` | text | |
| `msdk_v4_enum` | text, nullable | The Mobile SDK V4 `Model` value |
| `msdk_v4_support` | enum | `full`, `partial` |
| `support_notes` | text | |
| `max_horizontal_speed_ms` | numeric, nullable | |
| `max_ascent_speed_ms`, `max_descent_speed_ms` | numeric, nullable | |
| `max_flight_time_s` | integer, nullable | No wind, DJI's figure |
| `max_service_ceiling_m` | numeric, nullable | Above sea level |
| `max_wind_resistance_ms` | numeric, nullable | |
| `weight_g` | integer, nullable | |
| `camera` | jsonb | Sensor, photo resolution, video resolution and frame rate, zoom |
| `thermal` | jsonb | Integrated or supported through payloads, resolution |
| `source_urls` | text[] | Where every value came from |

**IR-MOD-01**: a value DJI does not publish is `null`, never an estimate.

---

## IR-STK — Sky Orchestrator stack

Owner: `soc-cloud`, from its configuration and what each stack reports.
Retention: while configured.

| Attribute | Type | Notes |
| --- | --- | --- |
| `gateway_sn` | text | Primary key, the emulated dock's serial |
| `name` | text | From configuration |
| `organization_id` | uuid | The organization the stack serves |
| `link_state` | enum | `connected`, `connecting`, `displaced`, `unreachable` |
| `status` | jsonb | Sky Orchestrator's stack status (SO's FR-DEV-07), as last read, with its read time |
| `envelope` | jsonb | The active device envelope (SO's FR-WAY-11), with its fingerprint |
| `updated_at` | timestamptz | |

**IR-STK-01**: credentials and endpoints are configuration, never rows.

---

## IR-DEV — Device seen on the wire

Owner: `soc-cloud`. Retention: permanent.

| Attribute | Type | Notes |
| --- | --- | --- |
| `gateway_sn`, `aircraft_sn` | text | Primary key together |
| `domain`, `type`, `sub_type` | integer | DJI's, as announced |
| `firmware_version` | text, nullable | From `state` |
| `online` | boolean | From the topology and the dock's OSD (`FR-LNK-02`) |
| `first_seen_at`, `last_seen_at` | timestamptz | |

**IR-DEV-01**: the wire identity is never used to infer an aircraft's model
([ADR-0012](../architecture/decisions/0012-wire-identity-is-not-airframe-identity.md)).

---

## IR-FLE — Fleet

Owner: members with `editor` or above, through the database's policies.
Retention: permanent; retiring is a soft delete.

| Attribute | Type | Notes |
| --- | --- | --- |
| `id` | uuid | |
| `organization_id` | uuid | |
| `name` | text | |
| `model_key` | text | `IR-MOD` |
| `airframe_serial` | text | As printed on the aircraft |
| `controller_serial` | text, nullable | Recorded only |
| `gateway_sn`, `aircraft_sn` | text | Wire identity, unique among live fleets |
| `flight_time_before_soc_s` | integer | Default 0 |
| `created_at`, `updated_at`, `deleted_at` | timestamptz | |

**IR-FLE-01**: total flight time is derived: `flight_time_before_soc_s` plus the
airborne time of the fleet's real flights. It is never stored as a counter that
could disagree with the flights.

---

## IR-GEO — Geofence

Owner: members with `editor` or above. Retention: permanent; soft delete.

| Attribute | Type | Notes |
| --- | --- | --- |
| `id` | uuid | |
| `organization_id` | uuid | |
| `name` | text | |
| `polygon` | jsonb | Ring, see the units table |
| `max_height_m` | numeric | Above the takeoff point |
| `origin` | enum | `drawn`, `generated` |
| `margin_m` | numeric, nullable | Set when generated, 5 to 100 |
| `created_at`, `updated_at`, `deleted_at` | timestamptz | |

**IR-GEO-01**: a flight keeps its own snapshot of the geofence it flew with
(`IR-FLT`); editing a geofence never changes a flown record.

---

## IR-WAY — Wayline

Owner: members with `editor` or above. Retention: permanent; soft delete.

| Attribute | Type | Notes |
| --- | --- | --- |
| `id` | uuid | |
| `organization_id` | uuid | |
| `name` | text | |
| `takeoff` | jsonb | `[longitude, latitude]` |
| `default_height_m` | numeric | |
| `speed_ms` | numeric | |
| `design` | jsonb | The primitives as drawn: points, routes, circles, grids, with their parameters, in `contracts/geometry/design.schema.json` |
| `waypoints` | jsonb | The baked result: `[{position: [lon, lat], height_m, actions: []}]` |
| `metrics` | jsonb | Waypoint count, distance, estimated duration, from the bake |
| `bake_version` | text | Version of the bake that produced `waypoints` |
| `created_at`, `updated_at`, `deleted_at` | timestamptz | |

**IR-WAY-01**: `design` and `waypoints` are stored together. A loaded wayline
flies its saved `waypoints`; changing the bake never changes a saved wayline.

---

## IR-OPS — Operation

Owner: members with `editor` or above for the definition; `soc-operations` for
the state. Retention: permanent.

| Attribute | Type | Notes |
| --- | --- | --- |
| `id` | uuid | |
| `organization_id` | uuid | |
| `name` | text | |
| `geofence_id` | uuid, nullable | Null while a draft has none |
| `state` | enum | Per `FR-OPS-02` |
| `end_reason` | enum, nullable | `completed`, `operator_stop`, `operator_return`, `geofence_breach`, `envelope_breach`, `low_battery`, `link_lost`, `pilot_takeover`, `aircraft_fault`, `cancelled` |
| `created_by` | uuid | A profile |
| `created_at`, `started_at`, `ended_at` | timestamptz | |

**IR-OPS-01**: every state change is an event in the operation log
(`IR-EVT`) with its cause and author; the current state never disagrees with the
log, because both are written in one transaction.

**IR-OPS-02**: an operation that has flown is never deleted; its definition is
frozen once it leaves `ready`.

## IR-ASG — Assignment

A wayline flown by a fleet within an operation. Owner: as `IR-OPS`.

| Attribute | Type | Notes |
| --- | --- | --- |
| `id` | uuid | |
| `operation_id` | uuid | |
| `wayline_id`, `fleet_id` | uuid | Each unique within the operation |

## IR-OPR — Operator

A member taking part in an operation. Owner: as `IR-OPS`.

| Attribute | Type | Notes |
| --- | --- | --- |
| `operation_id` | uuid | |
| `organization_id`, `profile_id` | uuid | Referencing a membership |
| `role` | enum | `pilot`, `observer` |

---

## IR-FLT — Flight

One DJI flight task: one fleet flying one file, simulated or real. Owner:
`soc-operations`; its progress, `IR-FST`, is `soc-cloud`'s. Retention: permanent.

| Attribute | Type | Notes |
| --- | --- | --- |
| `id` | uuid | Also DJI's `flight_id` and the `bid` of its messages |
| `operation_id`, `assignment_id`, `fleet_id` | uuid | |
| `gateway_sn`, `aircraft_sn` | text | The wire identity flown under |
| `mode` | enum | `simulated`, `real`, as the stack reported it at prepare (`FR-SAF-04`) |
| `file_id` | uuid | `IR-FIL` |
| `geofence_snapshot` | jsonb | Polygon and ceiling at prepare (`IR-GEO-01`) |
| `envelope_snapshot` | jsonb | The stack's envelope at prepare |
| `prepared_at`, `executed_at`, `ended_at` | timestamptz | |
| `took_off_at`, `landed_at` | timestamptz, nullable | From the flight mode |
| `end_reason` | enum, nullable | As `IR-OPS` |

## IR-FST — Flight state

The latest progress of a flight, from `flighttask_progress`. Owner: `soc-cloud`.

| Attribute | Type | Notes |
| --- | --- | --- |
| `flight_id` | uuid | Primary key |
| `status` | enum | DJI's: `sent`, `in_progress`, `paused`, `ok`, `failed`, `canceled`, `rejected`, `timeout`, `partially_done` |
| `result` | integer | DJI's result code |
| `percent` | integer | 0 to 100 |
| `current_waypoint_index` | integer | |
| `break_point` | jsonb, nullable | DJI's, with its reason once Sky Orchestrator sends one (SO's FR-FLT-12) |
| `updated_at` | timestamptz | |

## IR-FIL — Flight file

Owner: `soc-operations`. Retention: as long as any flight that used it.

| Attribute | Type | Notes |
| --- | --- | --- |
| `id` | uuid | |
| `organization_id`, `wayline_id` | uuid | |
| `bytes` | bytea | The exact KMZ |
| `md5` | text | Of `bytes` |
| `size_bytes` | integer | |
| `profile_version` | text | Version of the WPML profile written |
| `token` | text | The unguessable serving path, 128 random bits or more |
| `created_at` | timestamptz | |

**IR-FIL-01**: the bytes are never rebuilt for an existing flight. What flew is
what is kept ([ADR-0008](../architecture/decisions/0008-flight-files-served-on-sky-orchestrators-network.md)).

---

## IR-CMD — Command intent

Owner: the requester creates it (a pilot through an RPC, or `soc-operations`);
`soc-cloud` owns its outcome columns. Retention: permanent.

| Attribute | Type | Notes |
| --- | --- | --- |
| `id` | uuid | Also DJI's `tid` |
| `client_request_id` | uuid | The browser's idempotency key, unique per organization |
| `organization_id`, `operation_id`, `flight_id` | uuid | |
| `gateway_sn` | text | |
| `verb` | enum | `prepare`, `execute`, `pause`, `recovery`, `return_home`, `undo` |
| `payload` | jsonb | The DJI `data` sent |
| `requested_by` | uuid, nullable | The pilot; null when `soc-operations` asked |
| `requested_at` | timestamptz | |
| `status` | enum | `pending`, `sent`, `accepted`, `refused`, `failed`, `timed_out`, `expired` |
| `request_meta` | jsonb | The session and address the request came from |
| `result` | integer, nullable | DJI's |
| `sent_at`, `replied_at` | timestamptz, nullable | |

**IR-CMD-01**: a command moves forward only (`pending → sent → accepted |
refused | timed_out`; `pending → expired` when claimed after
`command_intent_ttl_s`; `failed` before sending); the database refuses any other
change.

---

## IR-EVT — Operation event

Owner: the emitting unit. Store: append-only. Retention: permanent.

| Attribute | Type | Notes |
| --- | --- | --- |
| `id` | uuid | |
| `organization_id`, `operation_id` | uuid | |
| `flight_id`, `fleet_id`, `command_id` | uuid, nullable | |
| `occurred_at` | timestamptz | When it happened, from its source |
| `recorded_at` | timestamptz | When SOC wrote it |
| `kind` | text | A closed list in `contracts/events/` |
| `severity` | enum | `info`, `warning`, `error`, `safety` |
| `source` | enum | `operator`, `soc-operations`, `soc-cloud`, `aircraft` |
| `actor_id` | uuid, nullable | The member who caused it |
| `payload` | jsonb | Triggering values |

**IR-EVT-01**: `safety` is reserved for `FR-SAF-*` events, so a filter on it is
exact.

**IR-EVT-02**: event kinds are a closed list in `contracts/`; a new kind is a
contract change.

---

## IR-TEL — Telemetry sample

Owner: `soc-cloud`. Store: one table, primary key `(flight_id, sampled_at)`, a
BRIN index on `sampled_at`, written with `COPY`; monthly partitions only once
retention needs to drop old months. Retention: the samples of a flight are kept
with the flight (about 1,800 rows per 30 minute flight); samples outside flights
are not stored.

| Attribute | Type | Notes |
| --- | --- | --- |
| `flight_id` | uuid | |
| `organization_id`, `fleet_id` | uuid | |
| `sampled_at` | timestamptz | The OSD's own timestamp (`FR-LNK-03`) |
| `received_at` | timestamptz | When `soc-cloud` received it |
| `longitude`, `latitude` | double precision | |
| `height_m` | real | |
| `heading_deg` | real, nullable | |
| `horizontal_speed_ms`, `vertical_speed_ms` | real, nullable | When Sky Orchestrator sends them |
| `pitch_deg`, `roll_deg` | real, nullable | Likewise |
| `battery_pct` | smallint, nullable | |
| `satellites` | smallint, nullable | |
| `gps_quality` | smallint, nullable | DJI's 0 to 5 |
| `mode_code` | smallint, nullable | DJI's aircraft mode |
| `home_distance_m` | real, nullable | |

**IR-TEL-01**: stored at no more than 1 Hz per flight; live delivery carries
every sample.

**IR-TEL-02**: a missing field is `null`. The flight's mode (`IR-FLT`) says
whether the samples came from the simulator.

---

## IR-SIT — Site model

Owner: the baking tool (`FR-DEP-05`). Retention: until re-baked.

| Attribute | Type | Notes |
| --- | --- | --- |
| `organization_id` | uuid | |
| `bounds` | jsonb | South-west and north-east corners |
| `origin` | jsonb | The tangent plane's origin |
| `elevation_asset`, `imagery_asset` | text | Paths of the served assets |
| `grid` | jsonb | Size and spacing of the elevation grid |
| `sources` | jsonb | Datasets, dates and licences |
| `baked_at` | timestamptz | |

## IR-INC — Incident · reserved

Reserved for `FR-FLE-07`: automatic incidents derived from `safety` events and
incidents entered by hand. Not built in the MVP.

---

## IR-CFG — Configuration

Schema: `contracts/config/soc-config.schema.json`, the single source of every key
with its type, unit, range, default and the units that read it (`FR-DEP-03`).

| Key | Default | Notes |
| --- | --- | --- |
| `served_organizations` | none | Required. Fail closed (`NFR-SEC-03`) |
| `stacks` | none | Required by `soc-cloud`: each stack's name, broker, file server and HTTP endpoints, credentials by environment variable name |
| `telemetry_stale_after_ms` | 3000 | `FR-TEL-02` |
| `telemetry_lost_after_ms` | 10000 | `FR-TEL-02` |
| `telemetry_batch_s` | 5 | `FR-TEL-04`, `NFR-RES-06` |
| `command_reply_timeout_s` | 10 | `FR-LNK-06` |
| `command_intent_ttl_s` | 10 | An intent claimed later than this expires instead of running (ADR-0006) |
| `geofence_warning_band_m` | 5 | `FR-SAF-01` |
| `geofence_max_vertices` | 32 | `FR-GEO-03` |
| `min_satellites` | 12 | `PF-GNSS`; Sky Orchestrator's own default |
| `min_gps_quality` | 4 | `PF-GNSS` |
| `min_battery_start_pct` | 50 | `PF-BATTERY` |
| `takeoff_tolerance_m` | 10 | `PF-TAKEOFF` |
| `min_arming_left_s` | 120 | `PF-ARMED` |
| `max_arc_spacing_m` | 10 | `FR-WAY-04` |
| `flight_file_grace_s` | 600 | `NFR-SEC-06` |
| `broadcast_max_rate_hz` | 25 | `NFR-RES-07` |

**IR-CFG-01**: the safety-relevant keys have no permissive fallback; a missing
one stops the service (`FR-SAF-05`).

---

## Cross-cutting rules

**IR-X-01 — One owner per entity**, named above.

**IR-X-02 — Correlation is designed in.** The operation and flight identifiers
thread through flights, commands, events, telemetry and logs.

**IR-X-03 — Append-only where history matters.** Events, command outcomes and
operation transitions are never rewritten.

**IR-X-04 — Retention is declared per entity.** An entity without a retention
bound is a defect against `NFR-REL-05`.

**IR-X-05 — Personal data.** SOC stores member identifiers (who commanded what),
read from Virtual Origen. It stores no other personal data; anything more needs
this document updated first.

---

## Changelog

| Date | Change |
| --- | --- |
| 2026-10-07 | Initial set, MVP scope. |
