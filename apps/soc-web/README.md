# soc-web

The console: one persistent 3D scene of the farm with floating panels
([ADR-0016](../../docs/architecture/decisions/0016-web-stack.md), the
[design system](../../docs/design/README.md)). It talks only to Supabase
([ADR-0006](../../docs/architecture/decisions/0006-the-web-talks-to-supabase-and-commands-are-intents.md)).

## What runs today

The shell the console grows into: the top bar (organization, search, the live
clock, the theme, the account), the navigation rail (Fleet, Geofences, Waylines,
Operations, Settings), the inspector, and the place where the scene arrives,
each a landmark. Light and dark themes, remembered per browser. Sign-in, the
organization, the scene and the panels' content arrive next
([roadmap](../../docs/roadmap.md), M1).

## Working on it

Node 24.21.0 and pnpm 12.10.1 (through corepack, as `packageManager` says):

```bash
cd apps/soc-web
corepack enable
pnpm install
pnpm dev          # http://localhost:5173
```

| Script                          | What it checks                                                                                                                                |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm typecheck`                | Strict TypeScript, app and tests apart (tests may use Node's API, the app may not)                                                            |
| `pnpm lint`                     | Type-aware rules, the hooks rules, and SOC's two: no colour literal outside the tokens (`NFR-UX-01`), no API plain HTTP lacks (`NFR-PORT-04`) |
| `pnpm format:check`             | Prettier, with Tailwind's class order                                                                                                         |
| `pnpm test`                     | Vitest: the shell, the contrast of every text token on every surface in both themes (`NFR-UX-02`), the lint rules themselves                  |
| `pnpm build` then `pnpm budget` | The initial JavaScript ≤ 250 KB gzip and the 3D chunk ≤ 450 KB (`NFR-PERF-05`), read from Vite's manifest                                     |

## Tokens

Every colour, radius, shadow and typeface is in `src/theme/theme.css`, as
Tailwind 4 theme variables; the dark theme overrides them under
`[data-theme='dark']`. Minty's hues are fills; text on them is the matching
emphasis colour. The subtle and emphasis pairs are Bootstrap 5.3's derivation
from Minty. The light theme's muted text is `#687179`, not Bootstrap's
`#6c757d`, which reaches only 4.45:1 on the page colour.

## Failure modes

| Failure                                                       | What happens                                                                        |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Local storage unavailable (a private window, blocked storage) | The theme follows the system preference and is not remembered; nothing else changes |
| A colour written outside the token file                       | `pnpm lint` fails, in the hooks and in CI                                           |
| A token change that drops text below 4.5:1                    | `pnpm test` fails, naming the pair and the theme                                    |
| An API that needs a secure context                            | `pnpm lint` fails: the console is served over plain HTTP on the LAN                 |
