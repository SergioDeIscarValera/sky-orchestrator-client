# Infrastructure

Everything that runs SOC on the farm's mini-PC beside Virtual Origen and Sky
Orchestrator ([ADR-0015](../docs/architecture/decisions/0015-lan-first-deployment.md)).

| Path | Contents | Arrives |
| --- | --- | --- |
| `compose/` | The `sky-orchestrator-client` compose project: `soc-web`, `soc-cloud`, `soc-operations`, each with memory and CPU limits, joined to `supabase-local_default` and `sky-orchestrator_default` | M1 |
| `migrate/` | SOC's migration runner and its ledger | M1 |
| `check/` | The stack check: everything up from nothing, healthy within 60 s, tested, removed | M1 |
| `deploy/` | The deploy command, which refuses while a flight is unfinished | M1 |
| `site/` | The site model baking tool | M2 |

What SOC never does on the mini-PC: add services to Virtual Origen's or Sky
Orchestrator's compose projects, publish a port Virtual Origen already uses
(5432, 1883, 8000, 8443, 8080, 8081), or name an image `virtual-origen-*`.
