# Design system

How SOC looks and behaves, decided before the first component is drawn. The MVP
cuts features, never this
([ADR-0013](../architecture/decisions/0013-narrow-vertical-slice-for-the-mvp.md)).

## The reference

The operator's reference is a video by Dilum Sanjaya, published on X on
2026-10-03: "WareTrack", a warehouse operations console whose author describes
it as built with React and React Three Fiber, and as "industrial software that
doesn't feel like industrial software". Its source is not published. What follows
is read from the video's frames and from the author's replies, and adapted to a
drone console and to Minty.

What SOC takes from it:

- **The scene never leaves.** A full-bleed 3D view is the application; everything
  else floats over it.
- **Cards, not pages.** White cards (dark in the dark theme) with a large radius
  and a soft shadow, over the scene.
- **An inspector that follows the selection.** The right-hand panel shows
  whatever is selected and crossfades when the selection changes.
- **The camera goes to things.** Selecting an entity flies the camera to frame it
  beside the inspector, in about one second.
- **Labels belong to entities.** Pill labels with a pointer above the entity;
  selection drawn as corner brackets with a soft glow on the ground.
- **One saturated accent on a calm ground.** The scene is light and quiet; the
  accent is spent on what matters.

## Layout

```
┌───────────────────────────────────────────────────────────────────────────┐
│ ◉ SOC   Farm ▾        / search                  ● LIVE 14:32:05    ☾   ◯ │  top bar
├────┬──────────────────────────────────────────────────────┬───────────────┤
│ ◇  │ ┌KPI┐ ┌KPI┐ ┌KPI┐                                    │ INSPECTOR     │
│ ◇  │                                                      │  selected     │
│ ◇  │                3D scene (persistent)                 │  entity, its  │
│ ◇  │                                                      │  state and    │
│ ◇  │                                         ┌───┐        │  its actions  │
│    │ ┌ operation stepper ──────────────┐     │ ± │ map    │               │
│    │ │ Planned › Preflight › Simulated │     │ ⟲ │ tools  │               │
│    │ └─────────────────────────────────┘     └───┘        │               │
└────┴──────────────────────────────────────────────────────┴───────────────┘
 navigation rail                          bottom: tables, log, flight controls
```

- **Navigation rail** (left): Fleet, Geofences, Waylines, Operations, Settings.
- **Top bar**: organization switcher, search (`/`): the organization's fleets
  and aircraft by name, model or serial, choosing one selects it; a live clock
  with the link state, nothing while the live topics reach the console and a
  danger pill, Reconnecting, while they do not; theme, user.
- **KPI row** (top left): what matters now: aircraft online, operation state,
  next check failing.
- **Inspector** (right, 360 px): the selected entity, and nothing when nothing is
  selected. A header with the entity's colour, name, status and the close; its
  actions right under it (follow, register or edit, retire); the values that
  matter in flight as tiles, the figure large and what it is measured from
  small; then the rest folded in sections the user opens (identity, the wire,
  the model). The battery tile carries a bar in the status colours: success,
  warning under 50 %, danger under 20 %.
- **Bottom area**: the operation stepper, tables (Fleets, Flights, Events), and
  during a flight the flight controls, which never move (`FR-CMD-07`).
- **Map tools** (bottom right): zoom, rotate, back to the site overview.

## Colour

Minty is the palette (`CON-08`). Its hues are light: on white they reach 1.5 to
2.6:1, under the 4.5:1 text needs. So:

| Role | Light theme | Dark theme |
| --- | --- | --- |
| Page and fog | `#f8f9fa` | `#212529` |
| Card surface | `#ffffff` | `#2b3035` |
| Body text | `#5a5a5a` (6.9:1 on white), never Minty's `#888888` | `#eceeef` |
| Headings | `#343a40` | `#f8f9fa` |
| Accent: selection | primary `#78c2ad` | primary |
| Aircraft, one colour each, cased in `#343a40` | `#2ba58a` `#3a78d4` `#9b5de5` `#e0569a` `#5fa832` `#a8743f`, by the order SO first saw them; stale fades towards muted | `#5fd1b3` `#7aa7f0` `#c09bf5` `#f28cbd` `#8fd164` `#d3a06c` |
| Text on the primary fill (buttons) | `#1e3a33` (5.9:1); Bootstrap's emphasis `#304e45` reaches only 4.4:1 | the same |
| Waylines | info `#6cc3d5` with a dark casing | info |
| Geofence | success `#56cc9d` | success |
| Breach, danger | danger `#ff7851` | danger |
| Warning | warning `#ffce67`, cased | warning |
| Drafts | secondary `#f3969a`, dashed | secondary |

Status pills use a subtle background with emphasis text, as Bootstrap 5.3 derives
them from Minty: success `#ddf5eb` on `#22523f` (7.8:1) in light, `#11291f` on
`#9ae0c4` in dark. Text on a Minty fill is the dark emphasis colour, never white.

Every colour is a token in one file; nothing else holds a colour literal
(`NFR-UX-01`). A test computes every text token's contrast on every surface it
is used on (`NFR-UX-02`).

## Type

Montserrat for headings and numbers that matter (as Minty), the system stack for
body text. Numbers in tables and telemetry use tabular figures, so they do not
jitter as they change.

## The scene

**Terrain, calm rather than photographic.** The site model's imagery is stored as
luminance with the hillshade baked in, and tinted in the shader by theme with a
small share of the original. Contour lines are drawn in the fragment shader
(minor every 5 m, faint; index every 25 m, a little stronger). No lights on the
terrain; fog fades its edges into the page colour.

**Aircraft** are built in code from simple shapes (a body, four arms, four rotor
discs), matte, each in its own colour, the same dot beside its name in the lists,
the inspector and its label. A chevron in the casing's colour on its back points
where it heads. A thin stalk drops to the ground with a disc under it, a wedge on
the disc's rim pointing the heading too: height and heading are read at a glance,
from any angle, with no shadow maps.

**Geofences** are walls whose opacity fades upward, a ceiling outline, edges
drawn as lines. **Waylines** are lines of constant pixel width: solid for the part
flown, dashed for the rest, waypoints as numbered discs with a drop line.
**Tracks** are the flown path, thinner, in the aircraft's colour.

**Selection** draws corner brackets and a soft glow on the ground. No outline
post-processing.

**Labels**: rich labels (name, state, a value) only for hovered, selected or
alerting entities, at most 20; everything else a compact marker at constant
screen size.

**Camera**: perspective with a narrow field of view, pitched 45 to 55 degrees by
default, so the site reads almost isometric from afar and in depth up close.
Flights to an entity frame it beside the inspector.

## Motion

Interface transitions 150 to 300 ms; camera flights at most 1.2 s; numbers that
change count to their new value; all of it off under `prefers-reduced-motion`
(`NFR-UX-05`). Aircraft move by interpolating between samples, never beyond the
last one (`FR-TEL-02`).

## Rendering budget

- Frames only when something changed: the camera, data, or an animation in
  progress (`NFR-RES-01`).
- Device pixel ratio capped at 1.5.
- No post-processing pass, and no tone mapping: a colour on screen is its
  token's.
- Terrain grid of at most 256 × 256 vertices; imagery at most 2048 × 2048,
  single channel.
- One draw per kind of repeated part (instancing) for aircraft and waypoints.

## Safety in the interface

- The flight controls are in the same place on every flight screen and work
  while the rest fails (`FR-CMD-07`).
- Return home for every aircraft is a hold-to-confirm action; pause is one press.
- A banner states **SIMULATION** or **REAL FLIGHT** on every flight screen, in
  colours no other element uses.
- Stale values are visibly stale: dimmed, with their age, never a number that
  looks current (`FR-TEL-02`).
