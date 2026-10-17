# Infrastructure

Everything that runs SOC on the farm's mini-PC beside Virtual Origen and Sky
Orchestrator ([ADR-0015](../docs/architecture/decisions/0015-lan-first-deployment.md)).

| Path | Contents | Arrives |
| --- | --- | --- |
| [`compose/`](compose/compose.yaml) | The `sky-orchestrator-client` compose project: `soc-migrate`, `soc-cloud`, `soc-operations` and `soc-web`, each read-only, unprivileged, with memory and CPU limits; the services joined to `supabase-local_default` and `sky-orchestrator_default`; only the console publishes a port, 8088 | M1, here |
| `migrate/` | SOC's migration runner and its ledger | M1 |
| [`check/`](check/README.md) | The images built and run as the mini-PC runs them; the stack check, everything up from nothing, healthy within 60 s, tested, removed | M1, the images here |
| [`deploy/`](deploy/deploy.py) | The deploy command, which refuses while a flight is unfinished (`FR-DEP-06`); [upgrading](#upgrading-on-the-mini-pc) | M1, here |
| [`site/`](site/README.md) | The site model baking tool, `soc-site` | M2, here |
| [`e2e/`](e2e/README.md) | The console end to end: Virtual Origen's platform behind Kong, `soc-cloud`, a dock on the wire and the console's image, worked in Chrome; M2's exit criteria measured | M2, here |

What SOC never does on the mini-PC: add services to Virtual Origen's or Sky
Orchestrator's compose projects, publish a port Virtual Origen or Sky
Orchestrator already uses (5432, 1883, 8000, 8443, 8080, 8081; a gate test holds
the console's 8088 apart from them), or name an image `virtual-origen-*`.

## Images

Each unit has its own Dockerfile, built from the repository root:

| Image | Dockerfile |
| --- | --- |
| `soc-cloud` | `services/soc-cloud/Dockerfile` |
| `soc-operations` | `services/soc-operations/Dockerfile` |
| `soc-migrate` | `infra/migrate/Dockerfile` |
| `soc-web` | `apps/soc-web/Dockerfile` |

`python:3.14.8-slim-trixie` and uv 0.12.23, both pinned by digest
(`NFR-SEC-08`); the locked workspace synced for the one package, compiled to
bytecode; the repository's layout kept under `/app`, so each package finds the
contracts beside it; user 10001; `MALLOC_ARENA_MAX=2`; a health check in bash
over `/dev/tcp`, no extra process (ADR-0017).

```bash
docker build -f services/soc-cloud/Dockerfile -t soc-cloud:local .
```

`soc-web` is built on `node:24.21.0-trixie-slim` (its build, budget and search
for secrets run in the image build) and served by
`nginxinc/nginx-unprivileged:1.30.5-alpine3.24-slim`, both pinned by digest, as
user 10001:10001. It writes `/config.json` and its security headers into a 4 MB
`/tmp` at start, from `SOC_WEB_SUPABASE_URL`, `SOC_WEB_SUPABASE_KEY` and its own
configuration file (`SOC_CONFIG_FILE`, ADR-0023), and refuses to start on a bad
address, any key but the public one, or a file it cannot read. 19.5 MB, 2.3
MiB at rest.

## Deploying on the mini-PC

The whole deployment beside Virtual Origen and Sky Orchestrator, in order, is [`docs/mini-pc-deployment.md`](../docs/mini-pc-deployment.md). This section is SOC's part on its own.

Bake each organization's site model first, from the repository root. A model is optional: an organization without one gets a flat ground (ADR-0018).

1. Fetch IGN's elevation and imagery for the organization's area; this step needs the internet: `uv run soc-site fetch --latitude <latitude> --longitude <longitude> --half-size-m 1000 --sources site/sources`.
2. Bake the model, offline and the same bytes every time: `uv run soc-site bake --sources site/sources --out site/model`.
3. Copy the model into the compose project: `mkdir -p infra/compose/site/<organization-id> && cp site/model/* infra/compose/site/<organization-id>/`. Make the folder before `docker compose up`, or Docker creates `site/` as root; the files must be world-readable, since soc-web reads them as user 10001.

Then deploy the stack:

```bash
cd infra/compose
cp .env.example .env                               # the version, the networks
cp migrate.env.example migrate.env                 # and fill every secret
cp soc-cloud.env.example soc-cloud.env
cp soc-operations.env.example soc-operations.env
cp soc-web.env.example soc-web.env                 # the address browsers reach Supabase at
uv run soc-config example soc-cloud > soc-cloud.json             # fill the blanks
uv run soc-config example soc-operations > soc-operations.json
uv run soc-config example soc-web > soc-web.json                 # the console's thresholds
uv run soc-config check soc-cloud soc-cloud.json
docker compose up -d
```

The console then answers on the mini-PC's LAN address, port 8088. The filled
files are ignored by git. `soc-migrate` runs first and the services
start only once it has succeeded; never run it during Virtual Origen's own
deploy. The console starts only once `soc-web-check` has accepted
`soc-web.json` with `soc-config check soc-web` (ADR-0023); `docker compose logs
soc-web-check` names every problem of a file it refused.

## Upgrading on the mini-PC

Each upgrade goes through the deploy command, run from the checkout at the new tag:

```bash
cd /srv/sky-orchestrator-client
git fetch --tags && git checkout v0.5.0
python3 infra/deploy/deploy.py v0.5.0
```

It runs the steps in this order and stops at the first failure, with the reason on stderr and exit status 1: it refuses while a flight is unfinished, writes `SOC_VERSION` into `infra/compose/.env`, pulls the version's images, runs `soc-migrate`, and starts the stack with `docker compose up -d --wait`. On success it says what it deployed. The first install is Phase 2 of the [runbook](../docs/mini-pc-deployment.md), which stays as written.

It refuses, changing nothing, while any flight is unfinished: any row of `soc.flights` whose `ended_at` is null, read through `docker exec supabase-db psql`. It lists each one with its id, mode, operation and state. When that read fails it refuses too, since nothing then proves that no aircraft is flying.

A flight that a fault left unended can be overridden, but only after the operator has checked on the ground that its aircraft is not flying:

```bash
python3 infra/deploy/deploy.py v0.5.0 --ignore-flight <flight-uuid>
```

Repeat `--ignore-flight` for each unfinished flight. The override names every unfinished flight or none: naming some of them refuses, and so does an id that is not an unfinished flight. `--dry-run` runs the same checks and prints the commands it would run, writing and starting nothing.

A stop after `.env` is written, at a failed pull, migration or start, leaves `SOC_VERSION` at the new version, and the message names the version it was. Fix the cause and run the command again, which is safe to repeat: the migrations already applied are skipped. Or put the old line back before any other `docker compose` command, so nothing starts the new version by accident.
