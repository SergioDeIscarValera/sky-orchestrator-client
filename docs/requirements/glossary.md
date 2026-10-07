# Glossary

DJI vocabulary first, then Sky Orchestrator's and Virtual Origen's, then SOC's
own. Use these terms exactly; ambiguity here becomes ambiguity in the code.

## DJI

**Cloud API** — DJI's MQTT interface between a dock (or a remote controller) and
a cloud platform. SOC is the cloud platform; Sky Orchestrator is the dock.

**Dock / Dock 2** — DJI's "drone in a box". Sky Orchestrator emulates one.

**Gateway** — The device holding the MQTT connection for itself and its
sub-devices. Here the emulated dock, identified by `gateway_sn`.

**Sub-device** — A device reached through a gateway: the aircraft, `aircraft_sn`.

**Topology** — The gateway's announcement of itself and its sub-devices
(`update_topo` on `sys/product/{gateway_sn}/status`).

**OSD** — Properties a device pushes at a fixed rate on
`thing/product/{sn}/osd`: the aircraft's position, height, heading, battery,
positioning; the dock's sub-device state.

**State** — Properties a device pushes only when they change, such as firmware.

**`mode_code`** — DJI's number for what the aircraft is doing: on the ground,
taking off, flying a wayline, returning home (9), landing (10), and so on.

**Services / `services_reply`** — Cloud-to-dock commands and their replies.

**Requests / `requests_reply`** — Dock-to-cloud requests and their replies.
`flighttask_resource_get` is one.

**Events** — Dock-to-cloud notifications. `flighttask_progress` is one.

**`tid`** — Transaction id: correlates a message with its reply. SOC uses the
command intent's id.

**`bid`** — Business id: correlates the messages of one business operation. SOC
uses the flight's id.

**Flight task** — DJI's unit of execution: one file flown once, identified by its
`flight_id`.

**`flighttask_prepare` / `_execute` / `_pause` / `_recovery` / `_undo`** —
Prepare a task with its file, start it, hold it, resume it, cancel it before it
starts.

**`return_home`** — Return to the home point. In Sky Orchestrator, the stop: it
ends the task.

**Breakpoint** — Where a paused task will resume: waypoint index and progress
within the leg.

**`simulate_mission`** — The prepare's flag saying the task is flown in the
simulator.

**KMZ** — A ZIP archive holding a wayline: `wpmz/template.kml` and
`wpmz/waylines.wpml`.

**WPML** — DJI's XML vocabulary for waylines, inside a KMZ.

## Sky Orchestrator

**Sky Orchestrator (SO)** — The sibling project that emulates a DJI Dock 2 and
flies a Mavic Air 2 through an Android application on DJI Mobile SDK V4.

**SO stack** — One deployment of Sky Orchestrator: one broker, one emulated dock,
one aircraft, one phone.

**Cloud role** — Which party answers the dock's cloud-side requests. SOC needs
`cloud_role: external`.

**`cloud-client`** — The one MQTT credential a cloud uses on an SO stack. One
connection at a time.

**Device envelope** — SO's flight limits enforced on the phone: a circle around a
centre, a ceiling, distances, speeds, waypoint counts.

**Simulator mode** — An SO deployment flying DJI's simulator. Real flight needs
two keys: SO's server setting and a confirmation on the phone.

**Arming** — The operator's confirmation on the phone that lets a mission start,
valid for a limited time.

**Dry run** — SO judging a wayline file as it would at prepare, storing nothing.

**Fake bridge** — SO's application runtime over a simulated aircraft, used in
tests instead of the phone.

## Virtual Origen

**Virtual Origen (VO2)** — The sibling project that manages the farm and owns
the users, the organizations and the database SOC lives in.

**Organization** — A farm, with a position, a time zone and members.

**Membership** — A user's role in an organization: `owner`, `editor` or
`viewer`.

## SOC

**Fleet** — One registered aircraft: the operator's term. A fleet pairs a wire
identity (`gateway_sn`, `aircraft_sn`) with an airframe (model, serial).

**Aircraft model** — An entry of SOC's catalogue of DJI aircraft supported by
Mobile SDK V4, with their published specifications.

**Device** — A `(gateway_sn, aircraft_sn)` SOC has seen on the wire, registered
as a fleet or not.

**Geofence** — A polygon and a ceiling above the takeoff point: the prism an
aircraft must stay inside during an operation.

**Warning band** — A strip inside the geofence's boundary where SOC warns
without acting.

**Wayline** — The route an aircraft flies: a takeoff point and an ordered list of
waypoints with heights, one speed. Reusable across operations.

**Primitive** — Something drawn with a wayline tool before baking: points of
interest, a route, a circle, a grid.

**Bake** — Turning a takeoff point and its primitives into one ordered wayline.

**Flight file** — The KMZ SOC builds from a baked wayline, kept byte for byte.

**Operation** — A planned piece of work: a geofence, assignments of waylines to
fleets, operators, and its lifecycle from draft to completion.

**Assignment** — One wayline flown by one fleet within an operation.

**Operator** — A member taking part in an operation, as `pilot` (may command) or
`observer`.

**Preparation** — The operation state in which live telemetry is shown and the
preflight checks are evaluated continuously.

**Preflight check** — One condition that must hold before a simulated pass or a
launch, with its measured value: pass, fail or unknown.

**Simulated pass** — The operation's flight file flown in SO's simulator before
the real flight.

**Flight** — One flight task in SOC's records: one fleet, one file, simulated or
real.

**Command intent** — A row asking a backend service to do something on the wire,
annotated with the outcome.

**Cloud geofence** — SOC's check of every telemetry sample against the flight's
geofence, which returns the aircraft home on a breach.

**Site model** — The organization's terrain and imagery, baked once and served as
static assets.

**Scene** — The persistent 3D view.

**Inspector** — The panel showing the selected entity.

**Pin** — Making the camera follow a fleet.
