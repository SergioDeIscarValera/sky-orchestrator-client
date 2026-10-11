# Applications

| Application | What it is | Arrives |
| --- | --- | --- |
| [`soc-web`](soc-web/README.md) | The console: one persistent 3D scene of the farm with floating panels, from fleet registration to the flight console | M1 |

`soc-web` talks only to Supabase
([ADR-0006](../docs/architecture/decisions/0006-the-web-talks-to-supabase-and-commands-are-intents.md)).
Its stack is in
[ADR-0016](../docs/architecture/decisions/0016-web-stack.md), its look in the
[design system](../docs/design/README.md).

Every application directory holds its code, tests, Dockerfile, configuration and
a README with scope, configuration and failure modes.
