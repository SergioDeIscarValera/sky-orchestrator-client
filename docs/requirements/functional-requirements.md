# Functional requirements

Scope: the MVP defined in the [roadmap](../roadmap.md), plus what comes after it,
each requirement marked with its priority. The identifier scheme and the priority
meanings are defined in the requirements index.

The MVP is a **narrow vertical slice**: one operation with one wayline and one
fleet, from design to a real flight commanded from SOC, at production quality
([ADR-0013](../architecture/decisions/0013-narrow-vertical-slice-for-the-mvp.md)).

## Roles

Organizations, members and their roles come from Virtual Origen
([ADR-0005](../architecture/decisions/0005-one-database-shared-with-virtual-origen.md)).
SOC adds one role of its own, per operation.

| Role | Where it lives | What it allows in SOC |
| --- | --- | --- |
| `viewer` | VO2 membership | Read everything of the organization, live telemetry included |
| `editor` | VO2 membership | Also create and edit fleets, geofences, waylines and operations |
| `owner` | VO2 membership | The same as `editor` in SOC. Organization management stays in VO2 |
| `pilot` of an operation | SOC, per operation | Command that operation's aircraft. Requires `editor` or `owner` |
| `observer` of an operation | SOC, per operation | Follow the operation; no commands |

---

## FR-AUT — Access, roles and organization context

### FR-AUT-01 — Sign in with Virtual Origen accounts · MUST
A user signs in with the email and password of their Virtual Origen account. SOC
offers no sign-up, no invitation and no organization management: those stay in
Virtual Origen.

**Acceptance**: a VO2 user signs in on SOC's LAN origin and lands on their
organizations. The application contains no sign-up route or control, checked by
an end-to-end test.

### FR-AUT-02 — Organization first · MUST
The user picks an active organization once; the choice is remembered per device.
Every query, subscription and view is scoped to it. The 3D scene centres on the
organization's position.

**Acceptance**: switching organization replaces every fleet, geofence, wayline,
operation and telemetry stream in view with the other organization's, with no
reload of the page, and no row of the first organization remains in any store.

### FR-AUT-03 — Permissions follow roles · MUST
Writes require `editor` or above; flight commands also require being a `pilot`
of the operation (`FR-CMD-01`). Controls a user may not use are shown disabled
with the reason.

**Acceptance**: a database test per table and per RPC asserts each role's access,
including refusal for a member of another organization and for a member of a
soft-deleted organization.

### FR-AUT-04 — Session continuity · MUST
Tokens refresh without user action. An expired or revoked session returns the
user to sign-in and is never seen as a silent failure of a write or a command.

**Acceptance**: with the session revoked server side, the next write shows the
sign-in screen within 5 s and the attempted command is reported as not sent.

---

## FR-SCN — The 3D scene

### FR-SCN-01 — One persistent scene · MUST
A single interactive 3D scene fills the screen for the whole session. Panels
open, change and close over it; navigating never unmounts it.

**Acceptance**: navigating through every route keeps one WebGL context (counted
by an end-to-end test) and keeps the camera where the user left it.

### FR-SCN-02 — The organization's site · MUST
The scene shows the organization's terrain with its imagery, from the site model
baked for it (`FR-DEP-05`), centred on the organization's position. Without a
site model the scene shows a flat ground and grid and says so.

**Acceptance**: with a baked site model the terrain elevation under a surveyed
point is within the source's stated accuracy; without one, a banner names the
missing model.

### FR-SCN-03 — Camera · MUST
Orbit, pan, zoom and tilt with mouse, touch and keyboard. The camera never goes
below the terrain or beyond the site's bounds; a control returns it to the site
overview. Selecting an entity flies the camera to frame it beside the open panel.

**Acceptance**: the camera's position stays above the terrain surface under any
input sequence of a fuzz test; the fly-to frames the entity's bounding box
outside the panel's area.

### FR-SCN-04 — Entities in the scene · MUST
Fleets (a model of the aircraft, its heading, a stalk to the ground), takeoff and
home points, geofences (translucent walls and ceiling), waylines (the path, its
direction, numbered waypoints) and flown tracks.

**Acceptance**: a scene test renders each entity type from fixtures and compares
its world placement with the expected positions computed from latitude,
longitude and height, within 0.1 m.

### FR-SCN-05 — Select and pin · MUST
Clicking an entity selects it and opens its panel. Selecting a fleet pins it:
the camera follows it, keeping the user's chosen angle and distance, and the
user may orbit it and zoom round it while it flies, until unpinned or until the
user pans the camera away.

**Acceptance**: with a fleet pinned and moving at 15 m/s, its projected position
stays within the central fifth of the viewport over a 60 s replayed track.

### FR-SCN-06 — Labels on entities · MUST
Hovered, selected and alerting entities show a label with their name and key
state; all others show a compact marker. Labels never cover the entity they
describe.

**Acceptance**: no more than 20 rich labels exist at once; a selected fleet's
label shows name, height and battery.

### FR-SCN-07 — Drawing on the terrain · MUST
Tools place, drag, insert and delete points on the terrain surface, used by the
geofence and wayline designers. A point dropped outside the site is refused.

**Acceptance**: a click lands the point at the terrain intersection under the
cursor within one terrain cell.

### FR-SCN-08 — Theme · MUST
The scene follows the light or dark theme with the rest of the interface.

**Acceptance**: switching theme changes every scene colour to its token for that
theme, with no reload.

---

## FR-FLE — Fleets and the aircraft catalogue

A fleet is one registered aircraft: the operator's term, kept as the domain's
word ([glossary](glossary.md)).

### FR-FLE-01 — Aircraft catalogue · MUST
SOC carries the DJI aircraft supported by Mobile SDK V4 with their published
specifications: maximum horizontal, ascent and descent speed, maximum flight
time, service ceiling, wind resistance, weight, camera photo and video
resolution, zoom, and thermal capability. Each value cites its source; a value
DJI does not publish is empty
([ADR-0012](../architecture/decisions/0012-wire-identity-is-not-airframe-identity.md)).

**Acceptance**: a test checks every catalogue entry against its schema and that
every number has a source URL.

### FR-FLE-02 — Devices seen on the wire · MUST
Every `(gateway_sn, aircraft_sn)` that Sky Orchestrator announces is listed with
when it was first and last seen, whether it is online now, its wire model key and
firmware, and the fleet it belongs to, if any.

**Acceptance**: a topology announcement from a stack SOC has never seen produces
one new device within 2 s.

### FR-FLE-03 — Register a fleet · MUST
A fleet is registered from a device seen on the wire: name, model from the
catalogue, the serial printed on the airframe, optionally the controller's
serial, and the flight time it had before SOC.

**Acceptance**: a device already belonging to a live fleet cannot be registered
again; a missing model or name is refused with the field named.

### FR-FLE-04 — Fleet detail · MUST
Identity, the model's specifications, live status (online, battery, satellites,
mode), and its recent flights.

**Acceptance**: the detail of a fleet with fixtures shows each field and marks
live values with their age.

### FR-FLE-05 — Edit and retire · MUST
Name and airframe fields are editable. The wire identity can be changed only
while the fleet has no unfinished flight. Retiring a fleet hides it from new
operations and keeps its history.

**Acceptance**: changing the wire identity during an unfinished flight is
refused; a retired fleet's flights remain readable.

### FR-FLE-06 — Flight hours · COULD
A fleet's total flight time is the time it had before SOC plus the airborne time
of its real flights in SOC. Simulated time is shown separately and never added.

**Acceptance**: a fixture of three real flights and one simulated flight sums to
the expected seconds, the simulated flight excluded.

### FR-FLE-07 — Incident history · COULD
A fleet lists its incidents: safety events from its flights and incidents
entered by hand (damage, repairs).

**Acceptance**: deferred. The event log records what this needs from the first
release (`FR-LOG-01`).

---

## FR-LNK — The link with Sky Orchestrator

`soc-cloud` plays DJI's cloud party
([ADR-0004](../architecture/decisions/0004-soc-is-the-dji-cloud-party.md)).

### FR-LNK-01 — One connection per stack · MUST
For each configured Sky Orchestrator stack, `soc-cloud` holds one MQTT connection
as `cloud-client`, with a persistent session, and reconnects on its own. A
takeover of that session by another client is detected and reported.

**Acceptance**: killing the broker and bringing it back restores the
subscription within 10 s with no message lost at QoS 1; a second client with the
same credential produces a `link_displaced` event.

### FR-LNK-02 — Topology and presence · MUST
`update_topo` and the dock's OSD decide which aircraft are online. An aircraft is
online only while Sky Orchestrator lists it and reports it online.

**Acceptance**: dropping the aircraft from the topology marks its fleet offline
within 1 s of the message.

### FR-LNK-03 — Telemetry ingest · MUST
Each aircraft OSD becomes one telemetry sample carrying the time it was taken
(the message's `timestamp`). A field the message lacks is unavailable, never its
previous value.

**Acceptance**: an OSD missing `battery` yields a sample whose battery is
unavailable, not the previous sample's value.

### FR-LNK-04 — Answer the dock's file request · MUST
`flighttask_resource_get` is answered on `requests_reply` with the file of that
flight, from memory. A request for a flight SOC does not know is answered with a
non-zero result.

**Acceptance**: answered within 500 ms at p99 over 100 requests (the dock waits
1.5 s); an unknown flight gets a non-zero result.

### FR-LNK-05 — Serve flight files · MUST
`soc-cloud` serves each flight file over HTTP on Sky Orchestrator's network, at
an unguessable path, byte for byte
([ADR-0008](../architecture/decisions/0008-flight-files-served-on-sky-orchestrators-network.md)).

**Acceptance**: the downloaded bytes' MD5 equals the stored fingerprint; any
other path answers 404; no port is published on the host.

### FR-LNK-06 — Commands on the wire · MUST
Wire command intents (prepare, execute, pause, recovery, return home, undo) are
sent on `services` with `tid` = the intent's id and `bid` = the flight id. The
reply's result is recorded on the intent with its latency; no reply within
`command_reply_timeout_s` marks it timed out. A `319999` to an execute or a
recovery records an unknown outcome, not a refusal: Sky Orchestrator gave up
waiting for the phone, which may still have started (SO's ADR-0041); the
flight's progress settles it (`FR-LNK-07`).

**Acceptance**: each verb against Sky Orchestrator's fake bridge stack records
`accepted` with result 0; a redelivered intent is sent once.

### FR-LNK-07 — Flight progress · MUST
`flighttask_progress` updates the flight: status, percent, current waypoint,
breakpoint and result. Terminal results map to SOC end reasons (envelope breach,
low battery, link lost, pilot takeover, operator return, other).

**Acceptance**: each of Sky Orchestrator's end results (321514, 321773, 321775,
322282, 322283, 321000) maps to its end reason in a table-driven test.

### FR-LNK-08 — Stack status · MUST
`soc-cloud` reads each stack's status from Sky Orchestrator (SO's FR-DEV-07):
simulator mode, link state and its reason, aircraft connected, armed and the
seconds left, clock offset. An unknown value stays unknown.

**Acceptance**: a status with `simulator_mode: null` shows as unknown and blocks
any prepare (`FR-OPS-06`).

### FR-LNK-09 — Envelope and dry run · MUST
`soc-cloud` reads the stack's active flight envelope (SO's FR-WAY-11,
`GET /v1/envelope`) and asks Sky Orchestrator to judge a flight file without
storing it (SO's FR-WAY-12, `POST /v1/validations`).

**Acceptance**: a file SO refuses shows every problem SO named, with its waypoint
index, before any prepare is sent.

### FR-LNK-10 — Nothing malformed leaves · MUST
Every message published to Sky Orchestrator validates against its vendored DJI
schema first. One that does not is not sent, and its intent fails with the
validation error.

**Acceptance**: a deliberately malformed intent never reaches the broker in an
end-to-end test.

### FR-LNK-11 — Acknowledge topology · SHOULD
`update_topo` is answered with `status_reply`, as DJI clouds do.

**Acceptance**: each announcement gets one reply with result 0.

---

## FR-TEL — Telemetry

### FR-TEL-01 — Live telemetry · MUST
Every telemetry sample reaches the browsers of the fleet's organization's
members, and no one else's, within the budget of `NFR-PERF-01`
([ADR-0007](../architecture/decisions/0007-live-telemetry-over-realtime-broadcast.md)).

**Acceptance**: a member of another organization subscribing to the channel
receives nothing; a member receives every sample of a 60 s run in order.

### FR-TEL-02 — Age is always visible · MUST
Each live value shows its age. After `telemetry_stale_after_ms` (default 3000 ms)
the fleet is drawn as stale; after `telemetry_lost_after_ms` (default 10000 ms)
its position is no longer drawn as current. Motion is interpolated between
samples, never extrapolated past the latest one.

**Acceptance**: with the feed frozen, the stale state appears within 100 ms of
the threshold and no rendered position moves past the last sample.

### FR-TEL-03 — What is shown · MUST
Position, height above takeoff, heading, battery, satellites, positioning
quality, flight mode in words, distance from home. When Sky Orchestrator provides
them (SO's FR-TEL-07, FR-TEL-08): horizontal and vertical speed, pitch and roll,
remaining flight time, link quality. Anything not provided is shown as
unavailable.

**Acceptance**: a sample without speeds renders "unavailable" in their place,
never zero.

### FR-TEL-04 — History of each flight · MUST
Samples of every flight are stored at no more than 1 Hz per aircraft, written in
batches.

**Acceptance**: a 10 minute flight at 5 Hz stores 600 ± 1 samples, in no more
than one insert per `telemetry_batch_s` per aircraft.

### FR-TEL-05 — The flown track · MUST
A flight's recorded samples are drawn as its track, during and after the flight.

**Acceptance**: after a replayed flight, the track's vertices equal the stored
samples' positions.

---

## FR-GEO — Geofences

### FR-GEO-01 — Draw a geofence · MUST
A polygon drawn on the terrain, vertex by vertex, editable, with one maximum
height above the takeoff point. Area and perimeter are shown while drawing.

**Acceptance**: a self-intersecting polygon cannot be saved, and the offending
edges are highlighted.

### FR-GEO-02 — Reusable · MUST
Geofences are listed, renamed, duplicated and retired, and any number of
operations can use one. A flight keeps a snapshot of the geofence it flew with.

**Acceptance**: editing a geofence after a flight leaves that flight's snapshot
unchanged.

### FR-GEO-03 — Generate from waylines · MUST
For an operation without a geofence, one is generated around its waylines and
takeoff points with a margin between 5 and 100 m, previewed live as the margin
changes, with at most `geofence_max_vertices` vertices.

**Acceptance**: for the golden cases, every waypoint and every leg lies inside
the generated polygon at no less than the margin, and the vertex count is within
the bound.

### FR-GEO-04 — Valid geofence · MUST
A geofence is valid when its polygon is simple with at least three vertices and a
positive area, and its maximum height is positive and within the stack's
envelope ceiling.

**Acceptance**: one fixture per invalid case, each refused with its own reason.

---

## FR-WAY — Waylines and flight files

### FR-WAY-01 — Takeoff point · MUST
A wayline starts from a takeoff point placed on the terrain and climbs straight
up from it to its default height before anything else: its first waypoint is
right above the takeoff. It never climbs or descends on a slant, which costs the
aircraft more energy: every leg is level or straight up or down. Going up, it
climbs where it is, then flies level; going down, it flies level, then descends
where it arrives. A wayline is
geometry only: the operation that flies it gives it its geofence, its speed, the
height it climbs to over the takeoff and its return home (`FR-OPS-01`).

**Acceptance**: every golden bake's first waypoint is right above its takeoff,
and no leg of any golden bake or flight is on a slant;
a wayline without a takeoff point is refused, naming it; a
takeoff outside the operation's geofence is refused when the operation is
planned (`FR-OPS-03`).

### FR-WAY-02 — Route tool · MUST
An ordered polyline flown in the order drawn, with its direction shown. Once
drawn, its points move and its legs bend, as every primitive's place and figures
change after it is drawn.

**Acceptance**: the baked wayline visits the route's points in drawn order.

### FR-WAY-03 — Points tool · MUST
Points of interest, visited in the order the bake chooses.

**Acceptance**: the bake visits every point exactly once.

### FR-WAY-04 — Circle tool · SHOULD
A centre and a radius, set with the pointer or typed exactly, previewed live as
the radius changes, with direction and a number of points derived from
`max_arc_spacing_m`.

**Acceptance**: every generated point lies at the radius within 0.1 m, and no arc
between consecutive points exceeds the spacing.

### FR-WAY-05 — Grid tool · SHOULD
An area and two spacings, between lines and between points, previewed live as
they change, covered in a back-and-forth pattern at an angle that minimises the
number of lines unless one is given.

**Acceptance**: for the golden areas, lines are parallel at the requested spacing
within 0.1 m and every point lies inside the area.

### FR-WAY-06 — Heights · MUST
A wayline has a default height above takeoff; any point may override it. No
height flown exceeds the operation's geofence ceiling.

**Acceptance**: a point above the ceiling is refused with its index.

### FR-WAY-07 — Bake · MUST
The bake turns the takeoff point and all drawn primitives into one ordered
wayline: routes, circles and grids keep their internal order with the entry and
direction that shorten the transit; points of interest are ordered by nearest
neighbour improved by 2-opt; points closer than 0.5 m merge. The result shows
its waypoint count and distance. The same design always bakes to the same
wayline. The operation's flight of it splits legs longer than `max_leg_m`,
estimates its duration at the operation's speed and names every violation; the
bake's own waypoints fly as baked.

**Acceptance**: the golden vectors in `contracts/geometry/` bake and fly
identically in TypeScript, and the Python validator accepts their results.

### FR-WAY-08 — Validation · MUST
A wayline flown by an operation keeps every point and every leg inside the
operation's geofence, its heights within the ceiling, and its waypoint count, leg
lengths, total distance and speed within the stack's envelope.
Each violation names its rule and its waypoint. Sky Orchestrator's own verdict
(`FR-LNK-09`) is shown next to SOC's.

**Acceptance**: one fixture per rule, each refused with its rule and index.

### FR-WAY-09 — Reusable · MUST
Waylines are saved with their design and their baked result, listed, duplicated
and retired. Loading an existing wayline into an operation uses its baked result
as saved.

**Acceptance**: a loaded wayline's waypoints equal the saved ones without
re-baking.

### FR-WAY-10 — Speed · MUST
A wayline flies at one speed, set in the operation when its fleet is assigned
(`FR-OPS-01`). Left blank it is the stack's limit, or the model's maximum where
that is lower; a speed given instead is no higher than the stack's limit or the
model's maximum, whichever is lower. Sky Orchestrator flies the speed it is given
in metres per second, capped by its envelope's `max_horizontal_speed_ms`.

**Acceptance**: a blank speed is saved as the lower of the two limits; a speed
above either limit is refused naming the limit.

### FR-WAY-11 — Flight file · MUST
The flight file is a KMZ in the WPML subset Sky Orchestrator accepts, built
deterministically from the operation's flight of the baked wayline
([ADR-0008](../architecture/decisions/0008-flight-files-served-on-sky-orchestrators-network.md)).

**Acceptance**: golden files for the reference waylines are byte-identical on
every build and accepted by Sky Orchestrator's dry run.

### FR-WAY-12 — Waypoint actions · COULD
Hover, take a photo and set the gimbal pitch at a waypoint, in the subset Sky
Orchestrator flies (SO's FR-BRG-09): once per waypoint visit, never repeated on a
resume (`DEP-13`).

**Acceptance**: deferred. The wayline's waypoint shape reserves an action list.

---

## FR-OPS — Operations

### FR-OPS-01 — Create an operation · MUST
An operation has a name, a height, a geofence (chosen or generated), assignments
of waylines to fleets, and operators (pilots and observers from the
organization's members). The geofence holds for the operation and every wayline
in it. The height is what each aircraft climbs to over its takeoff before the
transit, Sky Orchestrator's takeoff security height. Each assignment sets the
speed its fleet flies its wayline at (`FR-WAY-10`), and every flight ends
returning home. In the MVP an operation has exactly one assignment; within an
operation a wayline and a fleet appear at most once.

**Acceptance**: a second assignment is refused in the MVP with the reason; the
same fleet twice is refused by the database; an operation planned without a
height, or an assignment without a speed, is refused naming it; the console saves
no definition without a geofence.

### FR-OPS-02 — One state machine · MUST
An operation moves through declared states, by declared transitions only, each
recorded with its cause and its author:

```
draft → planned → preparing → simulating → simulated → ready → launching
      → in_flight ⇄ paused → returning → completed | aborted | failed
cancelled from draft, planned, preparing, simulated or ready
```

`returning` covers the time between the end of the flight task and the aircraft
standing on the ground.

**Acceptance**: a table-driven test covers every pair of states, asserting each
legal transition and refusing every other one, in the database and in
`soc-operations`.

### FR-OPS-03 — Planned · MUST
An operation becomes `planned` only when its geofence and wayline are valid
(`FR-GEO-04`, `FR-WAY-08`), its fleet is registered and live, and it has at least
one pilot.

**Acceptance**: one fixture per missing condition, each refused with it named.

### FR-OPS-04 — Preparation · MUST
In `preparing`, the assigned fleets' live telemetry is shown and the preflight
checks (`FR-OPS-05`) are evaluated continuously, each with its measured value and
its state: pass, fail or unknown.

**Acceptance**: a check changes state within one telemetry sample of its input
crossing the threshold.

### FR-OPS-05 — Preflight checks · MUST
The checks, each blocking unless marked:

| Check | Passes when |
| --- | --- |
| `PF-LINK` | The fleet's stack is connected and its dock OSD is fresh |
| `PF-ONLINE` | The aircraft is online in the topology |
| `PF-FRESH` | The aircraft's telemetry is fresh |
| `PF-GNSS` | Satellites and positioning quality reach `min_satellites` and `min_gps_quality` |
| `PF-BATTERY` | Battery reaches `min_battery_start_pct` |
| `PF-GROUNDED` | The aircraft is on the ground |
| `PF-INSIDE` | The aircraft is inside the geofence |
| `PF-TAKEOFF` | The aircraft is within `takeoff_tolerance_m` of the wayline's takeoff point |
| `PF-WAYLINE` | SOC's validation passes |
| `PF-SO-DRYRUN` | Sky Orchestrator's dry run accepts the flight file |
| `PF-ENVELOPE` | The geofence lies inside the stack's device envelope (`FR-OPS-08`) |
| `PF-MODE` | The stack's simulator mode is known |
| `PF-SIMULATOR` | The phone's simulator agrees with the stack's mode: on in simulator mode, off in real mode (`simulator_active` in the stack's status) |
| `PF-ARMED` | The operator armed the phone, with at least `min_arming_left_s` left |
| `PF-IDLE` | The stack has no unfinished flight |
| `PF-CLOCK` | The stack's clock offset is within its bound (warning, not blocking) |

**Acceptance**: one test per check for pass, fail and unknown.

### FR-OPS-06 — Simulated pass · MUST
From `preparing` with every blocking check passing and the stack in simulator
mode, the operation flies its flight file in Sky Orchestrator's simulator:
prepare with `simulate_mission` (`is_enable` 1, with the latitude and longitude
SO requires and does not apply), then execute. `ok` leads to
`simulated`; anything else back to `preparing` with the reason
([ADR-0011](../architecture/decisions/0011-simulate-then-fly-the-same-file.md)).
The pass records the phone's `config_fingerprint` from the stack's status: the
phone judges the file against its own envelope at load, in the simulator too,
so the pass proves the phone accepts the file under that configuration.

**Acceptance**: against the fake bridge stack, a simulated pass reaches
`simulated`; an aborted one returns to `preparing` with its end reason.

### FR-OPS-07 — Ready · MUST
An operation is `ready` while: its simulation of this exact file ended `ok`, the
stack reports real mode, the phone's `config_fingerprint` is the one recorded at
that simulation, and every blocking check passes. A different or unknown
fingerprint means the phone's configuration changed since the pass, envelope
included: simulate again. A change to the
wayline, the geofence or the fleet makes a new file and returns the operation to
`planned`.

**Acceptance**: editing the wayline of a `simulated` operation returns it to
`planned` and discards the readiness; a stack status with another
`config_fingerprint` than the pass's keeps the operation from `ready`, naming
both.

### FR-OPS-08 — Inside the device envelope · MUST
The geofence, at its ceiling, lies inside the stack's device envelope: its
circle and its height limit (SO's FR-WAY-11). Unknown envelope fails the check.
The envelope SOC can read is so-wayline's (`/v1/envelope`); the phone enforces
its own, which is set equal to it by hand and compared before a real flight
(dependencies, "Two envelopes").

**Acceptance**: a geofence one metre outside the circle fails `PF-ENVELOPE`
naming the vertex.

### FR-OPS-09 — Launch · MUST
From `ready`, after explicit confirmation by a pilot, the real flight is prepared
with the same file and executed. Refusals are shown with their meaning, told
apart by the method that drew them (SO's ADR-0037): `314010` on a prepare, "this
file has not completed a simulation on this stack, lies outside the phone's own
envelope, or asks a return height the aircraft did not take: the phone's record
names which" (`DEP-29`); `314010` on an execute, "arm
the phone, release the aircraft held from the phone's console, or confirm real
flight on the phone's screen, and retry" (`DEP-12`; a phone whose app build has
no simulator pass cannot fly real, SO's ADR-0040; SO does not say which before
the MVP, `DEP-26`); `316010` on an execute, told apart by the stack's status: "the
link to the phone is down", "turn the phone's simulator off", or in simulator
mode "turn the phone's simulator on"; `319999` on an execute, "the outcome is not known yet": SOC reads the flight's
progress and the stack's status, and a task still `PREPARED` is executed again
or undone, while a moving one is flying (`DEP-27`); `319015` "the stack's mode
is not known yet"; `319004` "the
task was prepared under the other mode: cancel it and prepare again"; `314003`
"Sky Orchestrator refused the file".

**Acceptance**: against the fake bridge stack in real mode, a launch reaches
`in_flight`; a refusal returns to `ready` with the meaning shown.

### FR-OPS-10 — Completion · MUST
When the flight has ended and the aircraft is on the ground, the operation ends
`completed`, `aborted` or `failed` with its end reason, and its record closes.

**Acceptance**: the record accepts no further change after closing, enforced by
the database.

### FR-OPS-11 — Operator history · COULD
Each member can see the operations they took part in and their flight time as
pilot.

**Acceptance**: a fixture's member sees exactly their operations and the summed
time of their real flights as pilot.

### FR-OPS-12 — Several assignments · COULD
Several waylines and fleets in one operation, each fleet with its own wayline.

**Acceptance**: deferred. The schema already allows several assignments.

### FR-OPS-13 — Launch in the simulator · MUST
From `simulated`, with the stack in simulator mode and every blocking check
passing, a pilot may launch the operation in Sky Orchestrator's simulator, after
explicit confirmation, to rehearse the flight before the real one
([ADR-0027](../architecture/decisions/0027-a-launch-in-the-simulator-rehearses-the-flight.md)).
The file of its simulated pass is prepared again with `simulate_mission`
(`is_enable` 1), then executed, and the flight is commanded as a real one is:
paused, resumed, sent home, stopped, taken over from the controller (FR-CMD).
Its operation moves through `launching`, `in_flight`, `paused` and `returning`,
and once the aircraft stands on the ground it is `simulated` again, however the
flight ended. A launch in the simulator neither starts nor closes the record:
`started_at` is set by the launch from `ready` only, the simulated pass that
made the operation `simulated` still makes it `ready` in real mode, and a stop
belongs to the flight it stopped. Its wayline, geofence and fleet cannot change
until it lands.

**Acceptance**: against the database with soc-operations running, a launch in
the simulator is paused, resumed and stopped, lands back in `simulated` with no
`started_at`, and the real launch after it closes `completed`; a launch refused,
or ended before take-off, is `simulated` again.

---

## FR-CMD — Commands to aircraft in flight

### FR-CMD-01 — Who commands · MUST
Only a `pilot` of the operation, with `editor` or above in the organization, can
command its aircraft. Everyone else sees the controls disabled with the reason.

**Acceptance**: the command RPC refuses an observer, a viewer and a member of
another organization, each in its own test.

### FR-CMD-02 — Pause and resume · MUST
Pause holds an aircraft where it is; resume continues from the breakpoint. Each
applies to one fleet or to every fleet of the operation.

**Acceptance**: against the fake bridge stack, a paused flight resumes and ends
`ok`, its waypoint index never going back.

### FR-CMD-03 — Return home · MUST
Return home ends the flight and brings the aircraft home, for one fleet or all.

**Acceptance**: the flight ends `canceled` with the operator's return as its end
reason (`322283`).

### FR-CMD-04 — Stop the operation · MUST
Stop sends every aircraft of the operation home and ends the operation
`aborted`.

**Acceptance**: every flight of the operation receives `return_home`, and the
operation ends `aborted` once they have landed.

### FR-CMD-05 — Cancel before execution · MUST
A flight prepared but not executing can be cancelled.

**Acceptance**: `flighttask_undo` is sent and the flight ends cancelled.

### FR-CMD-06 — Feedback · MUST
Each command shows its progress from requested to sent to accepted, refused or
timed out, with the meaning of DJI's result and who sent it, to everyone watching
the operation.

**Acceptance**: a second browser on the same operation sees the command and its
outcome without refreshing.

### FR-CMD-07 — Safety controls always within reach · MUST
Pause all and return all home are visible on every screen of an operation in
flight, reachable from the keyboard, one action away plus a hold-to-confirm, and
usable while any other part of the interface is failing.

**Acceptance**: with telemetry, the event log and every other panel failing in a
test, both controls still send their commands.

### FR-CMD-08 — Resume after a return home · COULD
Resume a flight ended by an operator's return home from its last breakpoint,
after landing (SO's FR-FLT-13).

**Acceptance**: deferred until Sky Orchestrator honours `break_point`.

---

## FR-SAF — Safety behaviour

Sky Orchestrator's device-side envelope is the authority that stops an aircraft.
Everything here is defence in depth on top of it, never in its place.

### FR-SAF-01 — Cloud geofence · MUST
Every telemetry sample of an executing flight is checked against the flight's
geofence snapshot. The first sample outside the polygon or above the ceiling
sends `return_home`, once, and records a `SAFETY` event; a sample inside the
warning band records a warning
([ADR-0010](../architecture/decisions/0010-the-cloud-geofence-is-enforced-where-telemetry-arrives.md)).

**Acceptance**: a replayed track crossing the boundary sends exactly one
`return_home` within 100 ms of the first outside sample's arrival.

### FR-SAF-02 — Never stale as live · MUST
No value older than its threshold is presented as current anywhere: scene,
panels or checks (`FR-TEL-02`).

**Acceptance**: freezing the feed turns every dependent check to unknown, not
pass.

### FR-SAF-03 — Never invented · MUST
SOC never fills a missing measurement with a default, a previous value or an
estimate presented as a measurement.

**Acceptance**: a code search test finds no default for a telemetry field in the
mapping, and the fixture without fields shows unavailable.

### FR-SAF-04 — The mode is reported, never assumed · MUST
Every flight records whether it was simulated or real as the stack reported it.
With the mode unknown, nothing is prepared.

**Acceptance**: a prepare with the stack's mode unknown is refused before
reaching the wire.

### FR-SAF-05 — Fail closed · MUST
A missing or invalid safety setting (thresholds, served organizations, stack
endpoints) stops the service at start, naming the setting.

**Acceptance**: removing each safety key in turn fails the start with its name.

### FR-SAF-06 — Telemetry lost in flight · MUST
Telemetry going stale during a flight raises an alarm in the console and a
`SAFETY` event, and SOC takes no automatic action: link loss belongs to the
device-side policy.

**Acceptance**: freezing the feed mid-flight produces the event once and no
command.

---

## FR-LOG — The operation log

### FR-LOG-01 — Append-only log · MUST
Every operation keeps an append-only log of events: time, kind, severity, source,
the member who caused it if any, the fleet and the flight.

**Acceptance**: an update or delete on a log row is refused by the database for
every role, service role included.

### FR-LOG-02 — What is logged · MUST
Lifecycle transitions; commands with their author and outcome; flight status
changes and end reasons; take-offs, automatic returns and landings from the
flight mode; cloud geofence warnings and breaches; telemetry going stale and
fresh again; fleets going offline and online; the check results at simulation
and at launch.

**Acceptance**: a flight replayed through the fake bridge stack produces the
expected sequence of event kinds.

### FR-LOG-03 — Live in the console · MUST
During an operation the log streams into the console as events happen.

**Acceptance**: an event appears in a second browser within 1 s of being
recorded.

---

## FR-REP — Reports and replay

### FR-REP-01 — Operation report · COULD
After an operation: who flew what, when; per flight the planned wayline against
the flown track, duration, distance, maximum height, battery used, and the event
timeline.

**Acceptance**: deferred. Its inputs are recorded from the MVP (`FR-TEL-04`,
`FR-LOG-01`).

### FR-REP-02 — Replay · COULD
Play a past flight back in the scene on a timeline: the aircraft's pose, its
track and the log in step.

**Acceptance**: deferred.

---

## FR-DEP — Deployment and operability

### FR-DEP-01 — One stack · MUST
One compose project brings up `soc-web`, `soc-cloud` and `soc-operations` with
health checks, joined to Virtual Origen's and Sky Orchestrator's networks.

**Acceptance**: from nothing, every container is healthy within 60 s on the
mini-PC.

### FR-DEP-02 — Migrations · MUST
SOC's runner applies `database/migrations` in order with its own ledger, refuses
an edited applied migration by checksum, and never runs concurrently with itself.

**Acceptance**: running it twice applies nothing the second time; an edited
migration fails the run naming it.

### FR-DEP-03 — Configuration is declared · MUST
Every tunable named in these documents is declared once with its default, unit
and allowed range, and every service validates its configuration against that
declaration at start.

**Acceptance**: a test asserts every key read in code is declared, and every
declared key is read.

### FR-DEP-04 — One web image, any address · MUST
The web image reads its Supabase address and public key when its container
starts, so the same image runs on any host.

**Acceptance**: one built image serves two containers configured for two
addresses, each talking to its own.

### FR-DEP-05 — Site model baking · MUST
A tool bakes an organization's site model (terrain and imagery) from configured
sources into the assets the web loads, recording sources and licences.

**Acceptance**: baking the reference area twice produces identical assets and
their provenance file.

### FR-DEP-06 — Releases · MUST
Each release publishes the images to GHCR from its tag. Deploying is a command on
the mini-PC that refuses while any flight is unfinished.

**Acceptance**: the deploy command exits non-zero, changing nothing, while a
flight is `in_flight`.

---

## Changelog

| Date | Change |
| --- | --- |
| 2026-10-07 | Initial set, MVP scope, after the integration answers of Sky Orchestrator and Virtual Origen. |
