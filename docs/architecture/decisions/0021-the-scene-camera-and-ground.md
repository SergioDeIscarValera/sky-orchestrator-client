# ADR-0021 — The scene's camera keeps its own limits; its ground is plain three.js

- **Status**: Accepted
- **Date**: 2026-10-11

## Context

The first scene is a flat ground with its grid, a camera the operator orbits,
pans, zooms and tilts, and map tools that send it back to the overview. Four
facts came up while building and measuring it:

- **camera-controls applies its limits to gestures only.** A fuzz test of 2,000
  random operations against camera-controls 3.1.2 (the version drei 10.7.9
  uses) put the camera 225 m under the ground on its second step, through
  `setLookAt`. The limits on the polar angle, the distance and the target's
  boundary hold for rotate, dolly and truck, never for the programmatic moves.
- **React Three Fiber tone-maps by default.** With ACES filmic tone mapping the
  surface token, white, was drawn as a grey, so the scene's colours were not
  the tokens' (`NFR-UX-01`).
- **@react-three/test-renderer 9.1.1 ships CommonJS as its main entry**, with no
  exports map, and so does React Three Fiber 9.8.1. Under Vitest it loads a
  second copy of three.js beside the scene's; making Vite resolve both to their
  ES modules cost 0.5 s of the 2 s gate.
- In Chrome with the laptop's GPUs (Intel UHD, NVIDIA RTX 3050 Ti) at 1920×1080,
  orbiting for 5 s gave a frame time of 17.2 ms at p95, and 30 s of idle gave 0
  frames; on SwiftShader, software rendering, 42 to 52 ms.

## Decision

- **camera-controls 3.1.2 is a direct dependency**, the same version drei
  resolves, so the console configures and tests the instance drei creates.
- **The console moves the camera only through `flyTo`** in
  `src/scene/camera.ts`, which brings a pose within the limits before
  `setLookAt`. A lint rule refuses `setLookAt`, `setTarget`, `setPosition`,
  `moveTo`, `fitToBox`, `fitToSphere` and `setOrbitPoint` anywhere else. The
  fuzz test holds the camera at least 3.4 m above the ground and its target on
  the site.
- **No tone mapping** (`flat`): a token's colour is the colour on screen.
- **Static geometry is built in plain three.js**: the ground and its grids are a
  `Group` made by `createGround`, painted by `paintGround`, and mounted as a
  primitive, tested in Node with the scene's own three.js. The test renderer
  arrives with the first entity whose React tree needs it, with its two-copies
  problem solved then.

## Alternatives considered

**Trust camera-controls' limits.** They hold for the user and not for the fly-to
of `FR-SCN-03`, the move that would take the camera wherever an entity is.

**Keep the test renderer and alias the packages to their ES modules.** Correct,
and a quarter of the gate's time for one test file of a static ground.

**Keep tone mapping and pre-compensate the colours.** Colours computed away from
the tokens, in a second place.

## Consequences

- A camera move the console makes is constrained like a gesture; a new kind of
  move goes into `camera.ts` with its case in the fuzz test.
- Lighting and tone mapping, if a site model ever needs them, are a new record.
- Frame time is the time between frames while the scene moves, sampled by the
  scene itself and shown with `?stats`.
