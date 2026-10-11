# soc-web

The console: one persistent 3D scene of the farm with floating panels
([ADR-0016](../../docs/architecture/decisions/0016-web-stack.md), the
[design system](../../docs/design/README.md)). It talks only to Supabase
([ADR-0006](../../docs/architecture/decisions/0006-the-web-talks-to-supabase-and-commands-are-intents.md)).

## What runs today

- **Its configuration, read at start** (`FR-DEP-04`): `/config.json` gives the
  Supabase address and the public key. A missing file, an address with a path,
  or a key for any role but `anon` (the service role key above all,
  `NFR-SEC-02`) stops the console on a page naming every problem.
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
  colours are the theme's tokens, followed without a reload (`FR-SCN-08`). The
  camera orbits, pans, zooms and tilts within the site, never under the ground,
  and the map tools bring it closer, farther, or back to the overview; with
  reduced motion it cuts instead of flying (ADR-0021). It renders only when
  something changes: no frame while idle (`NFR-RES-01`).
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
- **The fleet panel** (`FR-FLE-02`): the organization's fleets with their model
  and presence, and apart, under _Seen on the wire_, the aircraft its stacks
  announced that are in no fleet; a row selects, a second click lets go. An
  aircraft is _Online_ or _Offline_ only while its stack is connected: otherwise
  it reads as the stack's state, since a stack out of reach says nothing about
  now (`FR-LNK-02`).
- **The inspector** follows the selection and fades it in. A fleet: its
  identity, what its stack last said of it (stack, wire model, firmware, last
  seen), and its model's published figures, each linked to the DJI page it was
  read on, _Not published_ where DJI does not say (`FR-FLE-04`). An aircraft
  seen: its gateway, wire model, stack, firmware, when it was first and last
  seen, and its fleet if it has one. Times are in the organization's time zone.
  A link to a fleet retired or of another organization says so and offers to
  clear the selection.
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
  file, each crossed when it is reached. What a sample lacks reads as
  unavailable, never zero.
- **The scene's statistics** with `?stats` (`NFR-OBS-05`): frames rendered, the
  frame time at p95 while it moves, draw calls, triangles, geometries and
  textures; the sampler is then `window.socScene`.

The other panels' content arrives with their milestones ([roadmap](../../docs/roadmap.md)).

## How it is built

| Directory           | What it holds                                                                                                                                                                                                                     |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/config`        | The runtime configuration and its checks                                                                                                                                                                                          |
| `src/backend`       | `Backend`, everything the web asks of Supabase, and its Supabase implementation; components see only the interface                                                                                                                |
| `src/account`       | The session (`useAccountState`), sign-in, sign-out, the account menu                                                                                                                                                              |
| `src/organizations` | The organization gate, the picker, the switcher, the per-device choice, and `organizationKey`, which every organization's query key starts with                                                                                   |
| `src/telemetry`     | The telemetry sample and its contract, the console's store of each aircraft's latest samples, their freshness and their words                                                                                                     |
| `src/fleets`        | The catalogue's, devices' and fleets' queries and writes; `useLiveState`, which keeps the open organization's queries current from its state topic; the fleet panel, the fleet's and the aircraft's details, and their formatting |
| `src/app`           | The application, the shell, the scene's region (loaded lazily), the shared card layout and styles                                                                                                                                 |
| `src/scene`         | The scene: the site, the camera and its limits (`flyTo`), the ground, the palette from the tokens, the frame sampler, the map tools                                                                                               |
| `src/theme`         | The tokens, the theme switch and the favicon drawn from them                                                                                                                                                                      |
| `src/test`          | The fakes the tests use: `FakeBackend` for components, `FakeSupabase` behind `fetch` for the Supabase implementation                                                                                                              |

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
shows once the console reads again. `SOC_DEMO_PORT` moves the fake off `54399`. Ctrl-C stops both.

| Script                          | What it checks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm typecheck`                | Strict TypeScript, app and tests apart (tests may use Node's API, the app may not)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `pnpm lint`                     | Type-aware rules, the hooks rules, and SOC's five in `lint-rules.js`: no colour literal outside the tokens (`NFR-UX-01`), no API plain HTTP lacks (`NFR-PORT-04`), no way to create an account (`FR-AUT-01`), no modal menu (`NFR-SEC-07`), no camera move outside `flyTo` (`FR-SCN-03`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `pnpm format:check`             | Prettier, with Tailwind's class order                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `pnpm test`                     | Vitest on happy-dom ([ADR-0020](../../docs/architecture/decisions/0020-web-tests-on-happy-dom-and-zod-mini.md)), its files sharing their worker's modules ([ADR-0022](../../docs/architecture/decisions/0022-web-test-files-share-their-workers-modules.md)), under 2 s on mains power: sign-in, organization first, sign-out, the scene's ground, palette, sampler and region, a 2,000-step fuzz of the camera's limits, the configuration's checks, the Supabase implementation against a fake GoTrue, PostgREST and Realtime channel, the fleets' queries, writes and live invalidation, the fleet panel, the inspector and the fleet forms, the telemetry's contract, store, freshness and words, the contrast of every text token on every surface in both themes (`NFR-UX-02`), the lint rules themselves |
| `pnpm build` then `pnpm budget` | The initial JavaScript ≤ 250 KB gzip and the 3D chunk ≤ 450 KB (`NFR-PERF-05`), read from Vite's manifest                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

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
built files are cached for a year, `index.html` and `/config.json` never. Any
other path answers with the console, for the routes the panels add.

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

| Failure                                                                     | What happens                                                                                                                                     |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Local storage unavailable (a private window, blocked storage)               | The theme follows the system; the session and the organization are not remembered across reloads                                                 |
| A colour written outside the token file                                     | `pnpm lint` fails, in the hooks and in CI                                                                                                        |
| A token change that drops text below 4.5:1                                  | `pnpm test` fails, naming the pair and the theme                                                                                                 |
| An API that needs a secure context                                          | `pnpm lint` fails: the console is served over plain HTTP on the LAN                                                                              |
| `/config.json` missing, not JSON, or refused                                | The console does not start; one page names every problem, nothing talks to Supabase                                                              |
| The console's file missing a key, out of range, or breaking a relation      | `soc-web-check` refuses it and the console does not start; served anyway, the browser refuses it on the startup page, naming each key (ADR-0023) |
| The service role key given as the key                                       | Refused at start, before any request: it must never reach a browser                                                                              |
| Supabase does not answer at sign-in                                         | The sign-in names the address it tried                                                                                                           |
| Wrong email or password, too many attempts, unconfirmed email               | The sign-in says which, also when CORS hides GoTrue's error code from the browser                                                                |
| Schema `soc` not served by PostgREST (`DEP-21`)                             | The organizations page names the missing setting, with a button to try again                                                                     |
| `soc.member_organizations` missing                                          | The organizations page says SOC's migrations are not applied                                                                                     |
| The account has no live organization                                        | A page says so and offers sign-out; nothing opens                                                                                                |
| The remembered organization is no longer the user's                         | The picker opens again                                                                                                                           |
| The session ends on the server (revoked, refresh expired)                   | The console returns to sign-in and forgets everything it fetched                                                                                 |
| An organization's time zone unknown to the browser                          | The clock shows the device's zone and says so on hover                                                                                           |
| A browser without WebGL 2                                                   | The scene's place says so; the panels keep working                                                                                               |
| The scene fails while drawing                                               | Its place says what stopped and asks for a reload; the panels keep working                                                                       |
| A camera move that skips the camera's limits                                | `pnpm lint` refuses it outside `src/scene/camera.ts`; `flyTo` constrains it                                                                      |
| The container's address or key missing or refused                           | It exits with status 2 and one `configuration_refused` line naming each problem, never the key; compose shows it down                            |
| A modal menu or another inline style                                        | The policy blocks it in the browser; `pnpm lint` refuses modal menus before that                                                                 |
| A module mock in a test                                                     | `pnpm lint` refuses it: test files share their worker's modules, so it would leak into the next file (ADR-0022)                                  |
| A stack out of reach, displaced or still connecting                         | Its aircraft read as the stack's state, never as the online flag it last reported                                                                |
| A link to a fleet retired, unknown, or of another organization              | The inspector says so and offers to clear the selection                                                                                          |
| The state topic drops and rejoins                                           | Everything the console read of the organization is read again on the rejoin                                                                      |
| A telemetry sample that breaks the contract, or one taken before the latest | Dropped: the console shows the latest sample that follows the contract, and a track never runs backwards                                         |
| No sample for `telemetry_stale_after_ms`, then `telemetry_lost_after_ms`    | The aircraft's live values read as stale, then lost, within a few milliseconds of each threshold                                                 |
| A viewer's change or retirement of a fleet                                  | Row security leaves the row untouched without an error; the console counts the rows returned and says nothing changed                            |
| A fleet's write the database refuses                                        | The refusal names the field its constraint is about: the name, the model, the airframe serial, the aircraft, its stack                           |
| A viewer opens a fleet or an aircraft seen                                  | Edit, Retire and Register stay focusable, say why they do nothing, and open nothing; the database refuses the write anyway                       |
