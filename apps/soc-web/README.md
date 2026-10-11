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
  sign-out), the navigation rail, the inspector, and the place where the scene
  arrives, each a landmark. Light and dark themes, remembered per browser.

The scene and the panels' content arrive next ([roadmap](../../docs/roadmap.md),
M1).

## How it is built

| Directory           | What it holds                                                                                                                                   |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/config`        | The runtime configuration and its checks                                                                                                        |
| `src/backend`       | `Backend`, everything the web asks of Supabase, and its Supabase implementation; components see only the interface                              |
| `src/account`       | The session (`useAccountState`), sign-in, sign-out, the account menu                                                                            |
| `src/organizations` | The organization gate, the picker, the switcher, the per-device choice, and `organizationKey`, which every organization's query key starts with |
| `src/app`           | The application, the shell, the shared card layout and styles                                                                                   |
| `src/theme`         | The tokens and the theme switch                                                                                                                 |
| `src/test`          | The fakes the tests use: `FakeBackend` for components, `FakeSupabase` behind `fetch` for the Supabase implementation                            |

A query about one organization's data uses `organizationKey(id, ...)`, so that
switching organization drops it (`FR-AUT-02`).

## Working on it

Node 24.21.0 and pnpm 12.10.1 (through corepack, as `packageManager` says):

```bash
cd apps/soc-web
corepack enable
pnpm install
SOC_WEB_SUPABASE_URL=http://192.168.1.40:8000 \
SOC_WEB_SUPABASE_KEY=<the anon or publishable key> \
pnpm dev          # http://localhost:5173
```

In development, Vite serves `/config.json` from those two variables, as the
image writes it when its container starts. Without them the console starts on
the page that names what is missing. Schema `soc` must be in Supabase's
`PGRST_DB_SCHEMAS` for the organizations to load (`DEP-21`).

| Script                          | What it checks                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm typecheck`                | Strict TypeScript, app and tests apart (tests may use Node's API, the app may not)                                                                                                                                                                                                                                                                                        |
| `pnpm lint`                     | Type-aware rules, the hooks rules, and SOC's four in `lint-rules.js`: no colour literal outside the tokens (`NFR-UX-01`), no API plain HTTP lacks (`NFR-PORT-04`), no way to create an account (`FR-AUT-01`), no modal menu (`NFR-SEC-07`)                                                                                                                                |
| `pnpm format:check`             | Prettier, with Tailwind's class order                                                                                                                                                                                                                                                                                                                                     |
| `pnpm test`                     | Vitest on happy-dom ([ADR-0020](../../docs/architecture/decisions/0020-web-tests-on-happy-dom-and-zod-mini.md)), under 2 s: sign-in, organization first, sign-out, the configuration's checks, the Supabase implementation against a fake GoTrue and PostgREST, the contrast of every text token on every surface in both themes (`NFR-UX-02`), the lint rules themselves |
| `pnpm build` then `pnpm budget` | The initial JavaScript ≤ 250 KB gzip and the 3D chunk ≤ 450 KB (`NFR-PERF-05`), read from Vite's manifest                                                                                                                                                                                                                                                                 |

## The image

`apps/soc-web/Dockerfile`, built from the repository root, builds the console
on Node 24.21.0 (the build fails over the loading budget or with a secret in
the built files) and serves it with an unprivileged nginx, as user
10001:10001, on port 8080 inside the container (8088 on the mini-PC):

```bash
docker build -f apps/soc-web/Dockerfile -t soc-web:local .
docker run --rm --read-only --tmpfs /tmp:size=4m -p 8088:8080 \
  -e SOC_WEB_SUPABASE_URL=http://192.168.1.40:8000 \
  -e SOC_WEB_SUPABASE_KEY=<the anon or publishable key> soc-web:local
```

At start, `nginx/soc-web.sh` checks both variables as the web does, writes
`/config.json` and the security headers into `/tmp/soc-web`, logs one
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

## Failure modes

| Failure                                                       | What happens                                                                                                          |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Local storage unavailable (a private window, blocked storage) | The theme follows the system; the session and the organization are not remembered across reloads                      |
| A colour written outside the token file                       | `pnpm lint` fails, in the hooks and in CI                                                                             |
| A token change that drops text below 4.5:1                    | `pnpm test` fails, naming the pair and the theme                                                                      |
| An API that needs a secure context                            | `pnpm lint` fails: the console is served over plain HTTP on the LAN                                                   |
| `/config.json` missing, not JSON, or refused                  | The console does not start; one page names every problem, nothing talks to Supabase                                   |
| The service role key given as the key                         | Refused at start, before any request: it must never reach a browser                                                   |
| Supabase does not answer at sign-in                           | The sign-in names the address it tried                                                                                |
| Wrong email or password, too many attempts, unconfirmed email | The sign-in says which, also when CORS hides GoTrue's error code from the browser                                     |
| Schema `soc` not served by PostgREST (`DEP-21`)               | The organizations page names the missing setting, with a button to try again                                          |
| `soc.member_organizations` missing                            | The organizations page says SOC's migrations are not applied                                                          |
| The account has no live organization                          | A page says so and offers sign-out; nothing opens                                                                     |
| The remembered organization is no longer the user's           | The picker opens again                                                                                                |
| The session ends on the server (revoked, refresh expired)     | The console returns to sign-in and forgets everything it fetched                                                      |
| An organization's time zone unknown to the browser            | The clock shows the device's zone and says so on hover                                                                |
| The container's address or key missing or refused             | It exits with status 2 and one `configuration_refused` line naming each problem, never the key; compose shows it down |
| A modal menu or another inline style                          | The policy blocks it in the browser; `pnpm lint` refuses modal menus before that                                      |
