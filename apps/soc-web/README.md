# soc-web

The console: one persistent 3D scene of the farm with floating panels
([ADR-0016](../../docs/architecture/decisions/0016-web-stack.md), the
[design system](../../docs/design/README.md)). It talks only to Supabase
([ADR-0006](../../docs/architecture/decisions/0006-the-web-talks-to-supabase-and-commands-are-intents.md)).

## What runs today

- **Its configuration, read at start** (`FR-DEP-04`): `/config.json` gives the
  Supabase address and the public key. A missing file, an address with a path,
  or a key for any role but `anon` (the service role key above all,
  `NFR-SEC-02`) stops the console on a page naming every problem. The console's
  own file, with its telemetry thresholds and geometry limits, named by
  `SOC_CONFIG_FILE`, is checked the same way before it starts (ADR-0023).
- **Sign-in with a Virtual Origen account** (`FR-AUT-01`): email and password,
  and nothing to create an account with; a lint rule refuses `signUp`,
  `signInAnonymously` and `signInWithOtp` anywhere in the source. The session
  is kept in local storage and refreshed by Supabase's client.
- **Organization first** (`FR-AUT-02`): the user's live organizations come from
  `soc.member_organizations()`. One opens directly; several are offered with the
  user's role and the organization's position; the choice is remembered per user
  on this device. The top bar switches organization, and every query about
  another organization is dropped from the cache when it does.
- **The shell**: the top bar (the organization, search, the clock in the
  organization's time zone with UTC on hover, the theme, the account menu with
  sign-out), the navigation rail, the inspector and the map tools, each a
  landmark, over the scene. Light and dark themes, remembered per browser.
- **The persistent scene** (`FR-SCN-01`), loaded in its own chunk: until a site
  model is baked, a flat ground with a 50 m and a 250 m grid over a 2 km site
  centred on the organization, reaching into fog in the page colour, and a note
  that says the ground is flat, or that the organization has no position. Its
  colours are the theme's tokens, followed without a reload (`FR-SCN-08`): the
  system's light or dark, as it changes, until the user picks one with the
  toggle, which this device then keeps. The
  camera orbits, pans, zooms and tilts within the site, never under the ground,
  and the map tools bring it closer, farther, or back to the overview; with
  reduced motion it cuts instead of flying (ADR-0021). It renders only when
  something changes: no frame while idle (`NFR-RES-01`).
- **The farm's terrain** (`FR-SCN-02`, ADR-0018), when its site model has been
  baked with `soc-site` and served at `/site/<organization>/`: IGN's ground and
  PNOA's imagery, its hillshade baked in, tinted between the theme's darkest and
  lightest tokens with a fifth of the original, and contours every 5 m and,
  stronger, every 25 m, faded out on level ground. The whole grid is drawn near
  and every fourth vertex beyond 2.5 km, where the full grid only cost the frame.
  The scene's origin is the model's, so the aircraft and the ground share one
  frame. Over it the camera's target never goes under the ground, and the
  camera looks more steeply down rather than go into a hill behind it, staying
  as high over the ground beneath it as the flat ground allows at its lowest
  (`FR-SCN-03`). IGN's attribution sits at the foot of the scene. A model that fails to
  load is named in the note, and the ground stays flat. In development Vite
  serves the models in `SOC_SITE_DIR`.
- **The view in the URL** (`NFR-UX-03`): the rail opens and closes a panel
  beside it, kept as `?panel=` with the selection (`?fleet=<id>`, or an
  aircraft as `?gateway=<sn>&aircraft=<sn>`), so a link shared on the LAN opens
  the same view; a value the console cannot read is left out, and Escape
  closes the open panel (`NFR-UX-04`). The panels' content arrives with their
  milestones, each saying when.
- **The organization kept live** (ADR-0007): while an organization is open,
  the console listens on its private topic `org:<id>:soc:state`, where the
  database's triggers announce each change to a stack, a device, a fleet or a
  command intent, and reads again only what the change touched. Realtime does
  not replay what was broadcast while the console was away, so every join of
  the topic, the first one included, reads everything again.
- **The fleets' data** (`FR-FLE-02`, `FR-FLE-03`, `FR-FLE-05`): the catalogue,
  read once a session; the devices the organization's stacks have announced,
  with their stack's link; the live fleets; registering, changing (the wire
  identity too) and retiring a fleet, each settled once the fleets were read
  again. A refusal names the field the database's constraint is about.
- **The geofences' and waylines' data** (`FR-GEO-02`, `FR-WAY-09`): the
  organization's geofences and waylines in name order, read again on each change
  of the state topic; creating, changing and retiring each, as an editor or an
  owner. A position the console cannot read or write is refused, never guessed,
  and a retired row changes no more.
- **The fleet panel** (`FR-FLE-02`): the organization's aircraft in one list,
  each with its colour: its fleets first, with their model and presence, then the
  aircraft its stacks announced that are in no fleet, marked _Not registered_. An
  editor's actions are on the row: _Register_ opens an aircraft's registration
  and the pencil a fleet's edit, in the inspector, the form kept in the URL. A
  row selects, a second click lets go. An
  aircraft is _Online_ or _Offline_ only while its stack is connected: otherwise
  it reads as the stack's state, since a stack out of reach says nothing about
  now (`FR-LNK-02`).
- **The inspector** follows the selection and fades it in. Its header names the
  selection with its colour and presence, the close beside it; its actions sit
  right under it: _Follow_, then a fleet's _Edit_ and _Retire_ or an aircraft's
  _Register as a fleet_. Then the live values, and the rest folded in sections
  the user opens. A fleet: its identity, what its stack last said of it (stack,
  wire model, firmware, last seen), and its model's published figures, each
  linked to the DJI page it was read on, _Not published_ where DJI does not say
  (`FR-FLE-04`). An aircraft seen: _Not registered_ and the stack that announced
  it, or the fleet it flies as; folded, its gateway, wire model, stack,
  firmware, and when it was first and last seen. Times are in the
  organization's time zone. A link to a fleet retired or of another
  organization says so and offers to clear the selection.
- **The search** (`FR-SCN-05`, `NFR-UX-04`) in the top bar, on `/`: the
  organization's fleets by name, model or serial, then the aircraft in no fleet
  by serial, gateway or stack, accents and case aside, the best match first and
  what matched marked. Choosing one, by Enter or a click, selects it, so the
  inspector shows it and the scene follows it; leaving the field selects
  nothing. Escape closes the results, then clears the text, then steps back as
  anywhere else.
- **Registering, editing and retiring a fleet** (`FR-FLE-03`, `FR-FLE-05`), in
  the inspector, never in a dialog. An aircraft seen registers as a fleet with a
  name, a model from the catalogue, the airframe serial, optionally the
  controller's, and the flight time it had before SOC. The form refuses, field
  by field, what the database would, and shows the field the database names
  when it refuses anyway, such as an aircraft another console registered
  meanwhile. Editing writes only what changed, the aircraft on the wire as
  well, chosen among the aircraft seen in no fleet. Retiring asks once more, then
  shows the aircraft free again. A viewer sees the buttons with the reason they
  do nothing.
- **Live telemetry** (`FR-TEL-01`, `FR-TEL-02`, `FR-TEL-03`): while an
  organization is open the console listens on its private topic
  `org:<id>:soc:telemetry`, keeps the samples that follow the contract
  (`contracts/broadcast/telemetry.schema.json`) and drops one the aircraft took
  before the latest. The inspector shows a fleet's or an aircraft's live values
  with their age: live, then stale and lost at the thresholds of the console's
  file, each crossed when it is reached. The mode, height, battery, satellites,
  heading and distance from home are tiles in two columns, the battery with a
  bar that turns warning under 50 % and danger under 20 %, the heading with an
  arrow turned to it; the position and the takeoff point follow. What a sample
  lacks reads as unavailable, never zero; what Sky Orchestrator does not send
  yet has no tile until it does. A sample's age counts from when it was due: its
  arrival, less any delay beyond the link's usual transit over the last 30 s,
  so a sample a cut held up reads as old as it is when it arrives (`FR-SAF-02`).
  Stale or lost, the values are the last known: the section says so and greys
  them.
- **The link** (`NFR-REL-07`): the console's live topics, watched through
  Realtime's heartbeat every 5 s, each channel's status and the browser's
  offline and online events. Cut off, the top bar says Reconnecting beside the
  clock and every presence reads unknown, since the console knows them as of the
  cut. Back, the socket reconnects at once, every channel rejoins and what the
  console shows is read again.
- **The aircraft in the scene** (`FR-SCN-04`, `FR-TEL-02`): every aircraft of
  the organization with telemetry, built in code in its own colour and cased, a
  chevron on its back and a wedge on its ground disc pointing its heading, the
  same colour beside its name in the fleet panel, the inspector and its label (six
  colours, by the order its stacks first announced it; stale, the colour fades),
  a stalk dropping to a disc on the ground, placed on the local
  frame (ADR-0009) and kept a few dozen pixels across however far the camera is.
  It flies at the ground of its takeoff point plus its height above takeoff
  (ADR-0014), never under the ground beneath it, and stands on that ground while
  idle; its disc and ring lie on the slope under them. Its takeoff point is where
  it last stood idle (DJI's mode 0, which so-gateway sends whenever the aircraft
  is not flying); first seen in flight, the scene assumes the ground under that
  first position, and the inspector's _Takeoff point_ says it was not seen.
  It glides from one sample to the next over their interval and stops at the
  latest, never past it, above any ridge crossed between them; samples a stale
  threshold or more apart, by the aircraft's own clock, are a gap, and it is
  drawn where it is rather than glided across what was not seen; stale it turns
  muted, lost it is only a muted disc where it was last known. All aircraft are
  four draws. The scene draws frames only while one glides or crosses a
  threshold.
- **Selecting an aircraft in the scene** (`FR-SCN-05`, `FR-SCN-06`): a click
  selects its fleet, or the aircraft when it is in none, as its row in the fleet
  panel does; a soft ring marks it on the ground. The selected, the hovered and
  the alerting (stale or lost) carry a pill label above them with their name,
  height and battery; at most 20 at once. A click on the bare ground, the
  inspector's close button or Escape clears the selection; with nothing
  selected there is no inspector, and the scene has the whole width.
- **Following the selected aircraft** (`FR-SCN-05`): a selection, from the
  scene, the panel or a shared link, is followed. The camera flies in to frame
  it in the middle of the view the cards leave free, then moves with it; the
  user may orbit it and come closer or farther, the camera turning round the
  aircraft itself. Panning the map, _Following_ in the inspector,
  or the overview lets go; the same button follows it again.
- **A development replay** with `?replay` (development builds and the
  measurement build of `pnpm measure` only): a synthetic aircraft stands idle for
  2 s, takes off straight up to 40 m, then circles the organization at 15 m/s,
  sampled at 5 Hz, to look at and measure the scene without a stack.
  `?replay=2` flies two, and up to four, each from its own point of the circle.
  `pnpm budget` fails a build that ships it.
- **The scene's statistics** with `?stats` (`NFR-OBS-05`): frames rendered, the
  frame time at p95 while it moves, the delivery of telemetry at p95 from
  soc-cloud's broadcast to the browser (`NFR-PERF-01`, honest only with the
  mini-PC's and the browser's clocks both on NTP), draw calls, triangles,
  geometries and textures, and what the scene holds on the GPU in bytes
  (`NFR-RES-03`): its buffers and textures, each counted once, an image as RGBA
  with its mipmaps; the sampler is then `window.socScene`.

The other panels' content arrives with their milestones ([roadmap](../../docs/roadmap.md)).

## How it is built

| Directory           | What it holds                                                                                                                                                                                                                                                                                                                                               |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/config`        | The runtime configuration and its checks                                                                                                                                                                                                                                                                                                                    |
| `src/backend`       | `Backend`, everything the web asks of Supabase, and its Supabase implementation for the fleets and the plans; every position is converted once, in `positions.ts`; components see only the interface                                                                                                                                                        |
| `src/account`       | The session (`useAccountState`), sign-in, sign-out, the account menu                                                                                                                                                                                                                                                                                        |
| `src/organizations` | The organization gate, the picker, the switcher, the per-device choice, and `organizationKey`, which every organization's query key starts with                                                                                                                                                                                                             |
| `src/telemetry`     | The telemetry sample and its contract, the console's store of each aircraft's latest samples and takeoff point, their freshness and their words, the development replay (`replay.ts`)                                                                                                                                                                       |
| `src/fleets`        | The catalogue's, devices' and fleets' queries and writes; `useLiveState`, which keeps the open organization's queries current from its state topic; the fleet panel, the fleet's and the aircraft's details, and their formatting                                                                                                                           |
| `src/plans`         | The geofences' and waylines' queries and writes, under the organization's key; the live state keeps them current through the `STALE` table in `src/fleets/data.ts`                                                                                                                                                                                          |
| `src/app`           | The application, the shell, the scene's region (loaded lazily), the shared card layout and styles                                                                                                                                                                                                                                                           |
| `src/scene`         | The scene: the site and its ground, the baked terrain, the camera and its limits (`flyTo`), the aircraft and their labels, the palette from the tokens, the frame sampler and the statistics overlay, the map tools                                                                                                                                         |
| `src/geometry`      | The geometry engine (ADR-0009): the local frame and its inverse; the plane's predicates, exact on Shewchuk's orientation (robust-predicates); Sky Orchestrator's metric and envelope; the circle and grid tools; the geofence grown round the waylines; the bake. Each held to its golden vectors in `contracts/geometry/`, which libs/soc-geo checks again |
| `src/theme`         | The tokens, the theme switch and the favicon drawn from them                                                                                                                                                                                                                                                                                                |
| `src/test`          | The fakes the tests use: `FakeBackend` for components, `FakeSupabase` behind `fetch` for the Supabase implementation                                                                                                                                                                                                                                        |

A query about one organization's data uses `organizationKey(id, ...)`, so that
switching organization drops it (`FR-AUT-02`).

## Working on it

Node 24.21.0 and pnpm 12.10.1 (through corepack, as `packageManager` says):

```bash
cd apps/soc-web
corepack enable
pnpm install
uv run soc-config example soc-web > soc-web.json
SOC_WEB_SUPABASE_URL=http://192.168.1.40:8000 \
SOC_WEB_SUPABASE_KEY=<the anon or publishable key> \
SOC_CONFIG_FILE=$PWD/soc-web.json \
pnpm dev          # http://localhost:5173
```

In development, Vite serves `/config.json` from those two variables and the
console's own file, named by `SOC_CONFIG_FILE` (`uv run soc-config example
soc-web > soc-web.json` starts one), as the image writes it when its container
starts (ADR-0023). Without them the console starts on the page that names what
is missing. Schema `soc` must be in Supabase's
`PGRST_DB_SCHEMAS` for the organizations to load (`DEP-21`).

**Looking at the console without the mini-PC.** `pnpm demo` starts the console at
`http://localhost:5199` on an in-memory fake of Supabase, so the design can be seen on a laptop.
Sign in with any email and any password; the demo has no secret. Finca Norte (owner) has three
aircraft on stack `lab`: one online in a fleet, one online in no fleet, and one whose stack is
`unreachable`. It has one fleet, which can be edited and retired, and the aircraft in no fleet can
be registered. Almendral (viewer) has no aircraft and no fleets. Fleets change in memory, and a
restart resets them. Realtime is not faked: there is no live telemetry, and a change made elsewhere
shows once the console reads again; `http://localhost:5199/?replay` flies the development replay
around Finca Norte, idle for 2 s, then taking off and circling, listed in the fleet panel as
REPLAYUAV, to select, follow or register; `?replay=2` flies two, both listed there. `SOC_DEMO_PORT` moves the fake off `54399`. Ctrl-C stops both.

**Measuring the frame time (`NFR-PERF-06`).** `pnpm measure` does the following:

- It builds the console in the measurement mode: production React, with the replay kept.
- It serves the build with `vite preview` at `http://localhost:4199`, against the demo's fake Supabase.
- It drives Chrome at 1920×1080 along a scripted 60 s camera path: orbit, follow, back to the overview, closer, orbit and tilt, farther, orbit.
- Two aircraft of the replay fly at 5 Hz throughout. The first is selected, so its inspector updates at every sample.

The scene's own frame sampler measures every frame of the path. The script prints the frames, the p95 and worst frame times, and the GPU. It says whether the p95 is within 20 ms and exits 1 when it is not.

Run it on mains power: on battery the laptop slows down. Its options:

- `--site <dir>` serves the baked site models in that directory, as `SOC_SITE_DIR` does.
- `--theme dark` measures the dark theme.
- `--chrome <path>` names Chrome when it is not on the `PATH`.
- `--headed` shows the browser while it runs.
- `--shots <dir>` saves a screenshot after each step. Screenshots cost frames, and the report says they were taken.
- `--serve` only serves the build, to look at by hand.

The frame-time run also reads what the scene holds on the GPU at its end and fails
over 256 MB (`NFR-RES-03`).

**Measuring the memory (`NFR-RES-02`).** `pnpm measure:memory` builds and serves
the same way, then holds the console open on the replay's two aircraft at 5 Hz, the
first selected and followed, for 70 minutes. Each minute it collects the garbage
through the DevTools protocol and reads the JavaScript heap, so the figure is what
the console keeps. It passes with the heap at most 150 MB at minute 70 and its
least-squares trend from minute 10 at most 5 % an hour, and the GPU within 256 MB.
`--minutes <n>` runs a shorter session, whose report says it does not decide the
requirement; `--site <dir>` holds it over a baked terrain.

Measuring on `pnpm dev` overstates the frame time. React's development mode adds work to every render of the inspector: 23 to 27 ms there, against 17.6 ms on the production build.

| Script                          | What it checks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm typecheck`                | Strict TypeScript, app and tests apart (tests may use Node's API, the app may not)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `pnpm lint`                     | Type-aware rules, the hooks rules, and SOC's five in `lint-rules.js`: no colour literal outside the tokens (`NFR-UX-01`), no API plain HTTP lacks (`NFR-PORT-04`), no way to create an account (`FR-AUT-01`), no modal menu (`NFR-SEC-07`), no camera move outside `flyTo` (`FR-SCN-03`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `pnpm format:check`             | Prettier, with Tailwind's class order                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `pnpm test`                     | Vitest on happy-dom ([ADR-0020](../../docs/architecture/decisions/0020-web-tests-on-happy-dom-and-zod-mini.md)), its files sharing their worker's modules ([ADR-0022](../../docs/architecture/decisions/0022-web-test-files-share-their-workers-modules.md)), under 2 s on mains power: sign-in, organization first, sign-out, the scene's ground, palette, sampler and region, a 2,000-step fuzz of the camera's limits, the configuration's checks, the Supabase implementation against a fake GoTrue, PostgREST and Realtime channel, the fleets' queries, writes and live invalidation, the fleet panel, the inspector, the fleet forms and the search, the telemetry's contract, store, freshness and words, every recorded flight replayed through the store and the scene (`NFR-TEST-05`), the scene's GPU accounting, the aircraft's placement on the golden vectors, their glide and a 2,000-case fuzz that none is drawn past its latest sample, the contrast of every text token on every surface in both themes (`NFR-UX-02`), the lint rules themselves |
| `pnpm build` then `pnpm budget` | The initial JavaScript ≤ 250 KB gzip and the 3D chunk ≤ 450 KB (`NFR-PERF-05`), read from Vite's manifest; no development code shipped; every aircraft colour kept in both themes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `pnpm measure`                  | The frame time ≤ 20 ms at p95 (`NFR-PERF-06`) on the production build, along the scripted 60 s path; it needs Chrome and a GPU, so it runs by hand, not in CI                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `pnpm measure:memory`           | The JavaScript heap ≤ 150 MB after 70 minutes of live telemetry and its trend ≤ 5 % an hour (`NFR-RES-02`), and the GPU's share ≤ 256 MB (`NFR-RES-03`); by hand, like `pnpm measure`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `pnpm secrets`                  | No secret in the built files: no JWT, no Supabase secret key and no service's secret variable (`NFR-SEC-02`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

## The image

`apps/soc-web/Dockerfile`, built from the repository root, builds the console
on Node 24.21.0 (the build fails over the loading budget or with a secret in
the built files) and serves it with an unprivileged nginx, as user
10001:10001, on port 8080 inside the container (8088 on the mini-PC):

```bash
docker build -f apps/soc-web/Dockerfile -t soc-web:local .
docker run --rm --read-only --tmpfs /tmp:size=4m -p 8088:8080 \
  -v $PWD/soc-web.json:/etc/soc/soc-web.json:ro -e SOC_CONFIG_FILE=/etc/soc/soc-web.json \
  -e SOC_WEB_SUPABASE_URL=http://192.168.1.40:8000 \
  -e SOC_WEB_SUPABASE_KEY=<the anon or publishable key> soc-web:local
```

At start, `nginx/soc-web.sh` checks both variables as the web does and that the
console's file can be read, writes `/config.json` (the address, the key and the
file as it is) and the security headers into `/tmp/soc-web`, logs one
`service_started` line and hands over to nginx (`FR-DEP-04`). The headers
(`NFR-SEC-07`): a Content Security Policy that loads scripts and styles from the
console only and connects only to the configured Supabase (HTTP and WebSocket),
`frame-ancestors 'none'`, no referrer, `nosniff`, and no server version. The
built files are cached for a year, `index.html` and `/config.json` never. `/site/`
serves the organization's site model from the folder mounted read-only at
`/srv/site` (ADR-0018), with its ETag and `Cache-Control: no-cache`, GET and HEAD
only; a model it does not have answers 404, never the console. Any other path
answers with the console, for the routes the panels add.

A Radix menu is non-modal here: a modal one injects an inline `<style>` the
policy refuses, so a lint rule asks for `modal={false}`. Dialogs, when they
come, need the same care.

## Tokens

Every colour, radius, shadow and typeface is in `src/theme/theme.css`, as
Tailwind 4 theme variables; the dark theme overrides them under
`[data-theme='dark']`. Minty's hues are fills; text on a subtle is the matching
emphasis colour, and text on the primary fill is `on-primary` (`#1e3a33`,
5.9:1), since Bootstrap's primary emphasis reaches only 4.4:1 there. The subtle
and emphasis pairs are Bootstrap 5.3's derivation from Minty. The light theme's
muted text is `#687179`, not Bootstrap's `#6c757d`, which reaches only 4.45:1
on the page colour.

The favicon (`/favicon.svg`) is the brand's dot: `src/theme/favicon.ts` reads
`--color-primary` and `--color-casing` from the light theme's `@theme` block and
writes the SVG, which `vite.config.ts` serves in development and emits in the
build. `index.html` declares it, so browsers that take an SVG icon stop asking
for `/favicon.ico`.

## Failure modes

| Failure                                                                     | What happens                                                                                                                                                        |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local storage unavailable (a private window, blocked storage)               | The theme follows the system; the session and the organization are not remembered across reloads                                                                    |
| A colour written outside the token file                                     | `pnpm lint` fails, in the hooks and in CI                                                                                                                           |
| A token change that drops text below 4.5:1                                  | `pnpm test` fails, naming the pair and the theme                                                                                                                    |
| An API that needs a secure context                                          | `pnpm lint` fails: the console is served over plain HTTP on the LAN                                                                                                 |
| `/config.json` missing, not JSON, or refused                                | The console does not start; one page names every problem, nothing talks to Supabase                                                                                 |
| The console's file missing a key, out of range, or breaking a relation      | `soc-web-check` refuses it and the console does not start; served anyway, the browser refuses it on the startup page, naming each key (ADR-0023)                    |
| The service role key given as the key                                       | Refused at start, before any request: it must never reach a browser                                                                                                 |
| Supabase does not answer at sign-in                                         | The sign-in names the address it tried                                                                                                                              |
| Wrong email or password, too many attempts, unconfirmed email               | The sign-in says which, also when CORS hides GoTrue's error code from the browser                                                                                   |
| Schema `soc` not served by PostgREST (`DEP-21`)                             | The organizations page names the missing setting, with a button to try again                                                                                        |
| `soc.member_organizations` missing                                          | The organizations page says SOC's migrations are not applied                                                                                                        |
| The account has no live organization                                        | A page says so and offers sign-out; nothing opens                                                                                                                   |
| The remembered organization is no longer the user's                         | The picker opens again                                                                                                                                              |
| The session ends on the server (revoked, refresh expired)                   | The console returns to sign-in and forgets everything it fetched                                                                                                    |
| An organization's time zone unknown to the browser                          | The clock shows the device's zone and says so on hover                                                                                                              |
| A browser without WebGL 2                                                   | The scene's place says so; the panels keep working                                                                                                                  |
| The scene fails while drawing                                               | Its place says what stopped and asks for a reload; the panels keep working                                                                                          |
| A camera move that skips the camera's limits                                | `pnpm lint` refuses it outside `src/scene/camera.ts`; `flyTo` constrains it                                                                                         |
| The container's address or key missing or refused                           | It exits with status 2 and one `configuration_refused` line naming each problem, never the key; compose shows it down                                               |
| A modal menu or another inline style                                        | The policy blocks it in the browser; `pnpm lint` refuses modal menus before that                                                                                    |
| A module mock in a test                                                     | `pnpm lint` refuses it: test files share their worker's modules, so it would leak into the next file (ADR-0022)                                                     |
| A stack out of reach, displaced or still connecting                         | Its aircraft read as the stack's state, never as the online flag it last reported                                                                                   |
| A link to a fleet retired, unknown, or of another organization              | The inspector says so and offers to clear the selection                                                                                                             |
| The state topic drops and rejoins                                           | Everything the console read of the organization is read again on the rejoin                                                                                         |
| A telemetry sample that breaks the contract, or one taken before the latest | Dropped: the console shows the latest sample that follows the contract, and a track never runs backwards                                                            |
| No sample for `telemetry_stale_after_ms`, then `telemetry_lost_after_ms`    | The aircraft's live values read as stale, then lost, within a few milliseconds of each threshold                                                                    |
| The browser's network cut, or the socket dead without closing               | The top bar says Reconnecting at once (offline) or within two 5 s heartbeats; every presence reads unknown; the aircraft go stale, then lost                        |
| The network back                                                            | The socket reconnects at once, every channel rejoins, and what the console shows is fetched again; the aircraft are drawn where they are, not glided across the gap |
| Samples held up by a cut and delivered late, all at once                    | Each reads as old as it is, from when it was due: stale or lost on arrival, never live (FR-SAF-02)                                                                  |
| A missing measurement                                                       | Null from the wire to the screen, never a default: a search of the mapping's syntax fails the gate if one is written (FR-SAF-03)                                    |
| No site model for the organization (a 404)                                  | The flat ground and grid, and a note saying so                                                                                                                      |
| A site model off its contract, or a grid of the wrong size                  | The note names the problem and the ground stays flat; nothing wrong is drawn                                                                                        |
| An aircraft whose sample has no position                                    | It is not drawn; the inspector says the position is unavailable                                                                                                     |
| An aircraft below the ground under it, idle, or without a height            | It is drawn on the ground beneath it; the inspector shows the height above takeoff or that it is unavailable                                                        |
| An aircraft first seen in flight                                            | Its takeoff level is assumed to be the ground under its first position; the inspector's takeoff point says it was not seen                                          |
| An aircraft beyond the site model's edge                                    | It is drawn over the height of the nearest edge, so crossing it makes no jump                                                                                       |
| A viewer's change or retirement of a fleet                                  | Row security leaves the row untouched without an error; the console counts the rows returned and says nothing changed                                               |
| A fleet's write the database refuses                                        | The refusal names the field its constraint is about: the name, the model, the airframe serial, the aircraft, its stack                                              |
| A viewer opens a fleet or an aircraft seen                                  | Edit, Retire and Register stay focusable, say why they do nothing, and open nothing; the database refuses the write anyway                                          |
| A geofence or a wayline the database refuses                                | The refusal names the field its constraint is about: the name, the polygon, the height or the margin; the takeoff, the speeds, the waypoints or the bake version    |
| A stored position that is not two numbers in range                          | The read fails, saying the position is not valid; nothing is shown in its place. A position to write is refused before any request is sent                          |
| A viewer's geofence or wayline write                                        | An insert is refused, saying the role may not change it; a change or a retirement touches no row and says nothing changed                                           |
| A change or a retirement of a retired geofence or wayline                   | Refused, saying it does not change: it stays retired in the database and in no list                                                                                 |
