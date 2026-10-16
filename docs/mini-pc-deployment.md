# Deploying Virtual Origen, Sky Orchestrator and SOC on the mini-PC

The runbook that puts the three systems together on the farm's mini-PC before the
first real flight (M5). It was agreed on 2026-10-16 by the three projects:
Virtual Origen (VO2), Sky Orchestrator (SO) and SOC.

Sergio runs every command on the mini-PC. Lines marked **sudo** need it. Each step
ends with what to check before the next one.

## What runs where

| System | Compose project | Directory on the mini-PC | Host ports | Docker network |
| --- | --- | --- | --- | --- |
| VO2 database (Supabase) | `supabase-local` | `/srv/virtual-origen/repo/infra/supabase-local` | 0.0.0.0: 5432, 8000, 8443, 1883 (VO2's broker) | `supabase-local_default` |
| VO2 farm services | `virtual-origen` | `/srv/virtual-origen/stack` | 0.0.0.0: 8080 (vo-api), 8081 (vo-web, the farm's emergency web) | joins `supabase-local_default` |
| SO | `sky-orchestrator` | `/srv/sky-orchestrator` (a checkout at its tag) | 127.0.0.1: 1884 (broker, desk tools only), 8091 (so-wayline) | `sky-orchestrator_default` |
| SOC | `sky-orchestrator-client` | `/srv/sky-orchestrator-client` (a checkout at its tag) | 0.0.0.0: 8088 (the console) | soc-cloud joins both networks; soc-operations joins VO2's; soc-web joins neither |

The mini-PC's LAN address is `192.168.1.201`. The console is at
`http://192.168.1.201:8088`, and the browser reaches Supabase at
`http://192.168.1.201:8000`.

Inside Docker, soc-cloud reaches:
- VO2's Kong at `kong:8000` and Postgres at `db:5432`;
- SO's broker at `mosquitto:1883`;
- so-wayline at `so-wayline:8081`.

so-wayline downloads flight files from `http://soc-cloud:8090` on SO's network.

Ports that never move:
- VO2's 1883 is compiled into its 16 field boards and set on the switch Pi.
- 8081 is the farm's emergency web.

So SO publishes on 127.0.0.1 only, on 1884 and 8091, and SOC only on 8088.

**Order**:
- Up: VO2, then SO, then SOC.
- Down: SOC first, then SO, then VO2.
- Docker cannot remove a network while another project's containers are attached to it.

## Phase 0: before touching anything

0.1. **Inventory.** Write down what the mini-PC has. Nobody has measured it yet: VO2's limits sum to about 2.9 GB, Supabase is estimated at 2 to 3 GB, SO idles at about 150 MiB, and SOC is limited to 256 MiB in steady state.

```bash
hostname; free -h; nproc; df -h /
docker version --format '{{.Server.Version}}'; docker compose version
docker ps --format '{{.Names}}\t{{.Image}}' | sort
docker stats --no-stream --format 'table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}'
```

Check: VO2's containers run its released version (v0.0.41 on 2026-10-16), and there is room for about 450 MiB more.

The console's URL and the browser's Supabase address both name `192.168.1.201`, so give the mini-PC a DHCP reservation in the farm's router, and the phone one too (step 1.3).

0.2. **A backup of the database.** No automated backup exists for VO2 or SOC (SOC's RISK-08, VO2's ADR 0052). Take one before SOC's migrations change the database:

```bash
sudo mkdir -p /srv/backups && sudo chown "$USER": /srv/backups         # sudo
docker exec supabase-db pg_dumpall -U postgres --globals-only > /srv/backups/globals-$(date +%F).sql
docker exec supabase-db pg_dump -U postgres -Fc postgres > /srv/backups/postgres-$(date +%F).dump
```

Check: both files are larger than zero.

0.3. **Packages and tools.** SO's and SOC's images are private on GHCR:
- Create a classic GitHub token with `read:packages` only.
- Log in once with `docker login ghcr.io -u SergioDeIscarValera`, the token as the password.
- Install adb for SO's phone link: `sudo apt install android-tools-adb` (**sudo**).
- git and python3 must be on the mini-PC.

0.4. **The database owner can create roles.** SOC's migrations create two login roles as `postgres`:

```bash
docker exec supabase-db psql -U postgres -c '\du postgres'
```

Check: the attributes include `Create role`. SOC's container lane does this on the same image, `supabase/postgres:17.6.1.136`.

0.5. **The clocks.**
- On the mini-PC, `timedatectl` must say `System clock synchronized: yes`.
- On the phone, set the date and time to automatic.
- Why it matters:
  - SO refuses a start that arrives more than 3 s late;
  - on 2026-10-11 the phone ran about 510 ms behind the server;
  - SOC's PF-CLOCK check shows the offset.

0.6. **The tunnel publishes only VO2's API.** In Cloudflare Zero Trust, open Tunnels, then Public Hostnames. Check there is exactly one entry: `api.virtualorigen.dpdns.org` → `http://kong:8000`. Once Phase 2 exposes schema `soc`, SOC's tables are reachable through it, guarded by row-level security, as VO2's are.

## Phase 1: Sky Orchestrator v0.4.4

1.1. **The checkout at the tag.**

```bash
sudo mkdir -p /srv/sky-orchestrator && sudo chown "$USER": /srv/sky-orchestrator   # sudo
git clone https://github.com/SergioDeIscarValera/sky-orchestrator.git /srv/sky-orchestrator
git -C /srv/sky-orchestrator checkout v0.4.4
```

1.2. **Configuration.** Copy the laptop's files: `infra/compose/.env` and `infra/config/*.json`. They already carry `SO_BRIDGE_SECRET`, which must equal the phone's, and so-fleet's real dock and aircraft identities.

The laptop's `.env` secrets were printed into a local research transcript on 2026-10-16. Generate new ones for the mini-PC, keeping `SO_BRIDGE_SECRET` unless the phone is set up again with a new one:
- the MQTT passwords, including `SO_MQTT_PASSWORD_CLOUD_CLIENT`;
- `SO_WAYLINE_API_TOKEN`.

Then change these values:

| File | Setting |
| --- | --- |
| `infra/compose/.env` | `COMPOSE_PROFILES=phone` (never `builtin-cloud`), `SO_BIND=127.0.0.1`, `SO_MQTT_PORT=1884`, `SO_WAYLINE_PORT=8091`, `SO_PHONE_ADB_TARGET=<phone IP>:5555`, `SO_PHONE_ADB_KEY_DIR=/home/<user>/.android`, `SO_PHONE_ADB_USER=<uid>:<gid>` |
| `so-gateway.json`, `so-fleet.json`, `so-wayline.json` | `"cloud_role": "external"` |
| `so-wayline.json` | the envelope: `geofence_center` at the site, `geofence_radius_m` 50, `max_height_m` 30, `max_horizontal_speed_ms` 3.0 |
| `so-bridge.json` | `simulator_mode` true |

Run `chmod 600 infra/compose/.env`. The checkout, `.env` and `infra/config/` belong to the operator's user.

1.3. **The phone.**
- Install the APK built from the v0.4.4 tag; SO builds it on the laptop.
- In the phone's own site configuration, set the same values as so-wayline.json: the centre at the site, 50 m and 30 m. Nothing compares the two files, so check both by eye.
- Connect the phone by USB once and accept the mini-PC's adb key on its screen. Then:

```bash
adb -s <usb serial> tcpip 5555 && adb connect <phone IP>:5555
```

The phone and the mini-PC must be on the same Wi-Fi, with client isolation off. Keep the phone's address fixed with a DHCP reservation. A phone restart turns adb's TCP mode off: plug the phone in again and repeat the two commands.

1.4. **Up.**

```bash
cd /srv/sky-orchestrator
SO_VERSION=v0.4.4 docker compose -f infra/compose/compose.yaml -f infra/compose/compose.release.yaml up -d
SO_VERSION=v0.4.4 docker compose -f infra/compose/compose.yaml -f infra/compose/compose.release.yaml ps
```

Check:
- every service is healthy;
- `docker network ls` lists `sky-orchestrator_default`;
- SO's runbook curl answers on `127.0.0.1:8091/v1/status`;
- `/v1/envelope` returns the four values of step 1.2.

1.5. **What SOC needs from SO.** Note three values for Phase 2:
- `SO_MQTT_PASSWORD_CLOUD_CLIENT` from SO's `.env`;
- `SO_WAYLINE_API_TOKEN` from SO's `.env`;
- the dock's identity from `so-fleet.json`.

## Phase 2: SOC

2.1. **The checkout at the tag.**

```bash
sudo mkdir -p /srv/sky-orchestrator-client && sudo chown "$USER": /srv/sky-orchestrator-client   # sudo
git clone https://github.com/SergioDeIscarValera/sky-orchestrator-client.git /srv/sky-orchestrator-client
git -C /srv/sky-orchestrator-client checkout <SOC tag>
cd /srv/sky-orchestrator-client/infra/compose
```

The tag is SOC's release for the mini-PC (see "Before the first deploy"). Every file below lives in `infra/compose`, mode 600, owned by the operator's user, and git ignores it.

2.2. **The farm's organization.** SOC acts for the farm's VO2 organization only:

```bash
docker exec supabase-db psql -U postgres -Atc \
  "select id, name from public.organizations where deleted_at is null"
```

2.3. **Environment files.** Copy each `*.example` to its name without `.example`, then fill it. VO2's values come from `/srv/virtual-origen/repo/infra/supabase-local/.env`. That file is root's: read it with `sudo cat` (**sudo**).

| File | Values |
| --- | --- |
| `.env` | `SOC_VERSION=<SOC tag>`; the network names and `SOC_WEB_PORT=8088` as in the example |
| `migrate.env` | `SOC_MIGRATE_DSN=postgresql://postgres:<POSTGRES_PASSWORD, percent-encoded>@db:5432/postgres`; `SOC_DB_PASSWORD_SOC_CLOUD` and `SOC_DB_PASSWORD_SOC_OPERATIONS`, each from `openssl rand -hex 24` |
| `soc-cloud.env` | `SOC_DB_PASSWORD_SOC_CLOUD` as in migrate.env; `SOC_SUPABASE_URL=http://kong:8000`; `SOC_SUPABASE_SERVICE_ROLE_KEY` = the service role key VO2's services use (`SERVICE_ROLE_KEY`, or `SERVICE_ROLE_KEY_ASYMMETRIC` once VO2 signs with ES256); `SOC_MQTT_PASSWORD_FARM` = SO's `SO_MQTT_PASSWORD_CLOUD_CLIENT`; `SOC_SO_API_TOKEN_FARM` = SO's `SO_WAYLINE_API_TOKEN` |
| `soc-operations.env` | `SOC_DB_PASSWORD_SOC_OPERATIONS` as in migrate.env |
| `soc-web.env` | `SOC_WEB_SUPABASE_URL=http://192.168.1.201:8000`; `SOC_WEB_SUPABASE_KEY` = VO2's `ANON_KEY`, the public key VO2's own web is built with; the service role key is refused |

Percent-encode the Postgres password. An unencoded special character once broke VO2's URL parsing and leaked the password into a log.

2.4. **Configuration files.** soc-config ships in soc-cloud's image, so the mini-PC needs no Python tooling:

```bash
IMAGE=ghcr.io/sergiodeiscarvalera/sky-orchestrator-client/soc-cloud:<SOC tag>
for unit in soc-cloud soc-operations soc-web; do
  docker run --rm --entrypoint soc-config "$IMAGE" example "$unit" > "$unit.json"
done
```

Fill the blanks:
- `served_organizations`, in soc-cloud.json and soc-operations.json: `["<organization id>"]`.
- `stacks`, in soc-cloud.json:

```json
[{
  "name": "farm",
  "organization": "<organization id>",
  "broker": {"host": "mosquitto", "port": 1883, "username": "cloud-client",
             "password_env": "SOC_MQTT_PASSWORD_FARM", "client_id": "cloud-client"},
  "api": {"url": "http://so-wayline:8081", "token_env": "SOC_SO_API_TOKEN_FARM"},
  "flight_files_url": "http://soc-cloud:8090"
}]
```

Then check each file:

```bash
for unit in soc-cloud soc-operations soc-web; do
  docker run --rm -v "$PWD:/etc/soc:ro" --entrypoint soc-config "$IMAGE" check "$unit" "/etc/soc/$unit.json"
done
```

Check: all three are accepted.

2.5. **The farm's site model** (optional; without one the ground is flat). Fetching needs the internet, so run it on the laptop from SOC's repository, then copy the model over:

```bash
uv run soc-site fetch --latitude <lat> --longitude <lon> --half-size-m 1000 --sources site/sources
uv run soc-site bake --sources site/sources --out site/model
ssh <mini-PC> mkdir -p /srv/sky-orchestrator-client/infra/compose/site/<organization id>
scp site/model/* <mini-PC>:/srv/sky-orchestrator-client/infra/compose/site/<organization id>/
```

The files must be world-readable. Create the folder before `docker compose up`, or Docker creates it as root.

2.6. **Migrations.** Never migrate while a VO2 release runs: until both runners hold the shared lock, nothing else stops them overlapping.

```bash
gh run list --repo SergioDeIscarValera/virtual-origen-v2 --workflow release.yml --limit 1   # not in progress
docker compose run --rm soc-migrate
docker exec supabase-db psql -U postgres -Atc "select count(*) from soc_migrations.applied"
```

Check: the count equals the number of files in `database/migrations` at the tag (10 at v0.5.0).

2.7. **PostgREST serves `soc` (DEP-21).** In `/srv/virtual-origen/repo/infra/supabase-local/.env` (root's file: edit it with `sudoedit`, **sudo**), append `,soc` to `PGRST_DB_SCHEMAS` and keep the schemas already listed. VO2's releases never overwrite this file. Then:

```bash
cd /srv/virtual-origen/repo/infra/supabase-local
docker compose up -d rest studio
docker restart supabase-kong          # otherwise Kong answers 502 to the old rest
```

This comes after the migrations because PostgREST must find schema `soc` when it starts.

2.8. **Up.**

```bash
cd /srv/sky-orchestrator-client/infra/compose
time docker compose up -d --wait
docker compose ps
docker stats --no-stream $(docker compose ps -q)
```

Check:
- every container is healthy within 60 s and within its limits (M1's criterion `FR-DEP-01`, `NFR-RES-05`);
- `docker compose logs soc-web-check` is empty of problems.

2.9. **The console.** From a laptop on the farm's Wi-Fi, open `http://192.168.1.201:8088` and sign in with a VO2 account. Check:
- the farm's organization is offered;
- the dock and its aircraft appear in the fleet panel once the phone is connected.

Then confirm the stack was read:

```bash
docker exec supabase-db psql -U postgres -Atc \
  "select name, link_state, status is not null, envelope is not null from soc.stacks"
```

Check: `connected`, `t`, `t`.

2.10. **Password reset links (DEP-22), optional.** Sign-in by password works without it. For email links that land on the console, append `,http://192.168.1.201:8088` to `ADDITIONAL_REDIRECT_URLS` in the same VO2 `.env` (`sudoedit`, **sudo**). Then run `docker compose up -d auth` there.

## Phase 3: checks on the mini-PC

3.1. **Register the fleet** in the console: the dock and the aircraft that SO's so-fleet announces.

3.2. **Live telemetry.** With the phone in DJI's simulator, the aircraft shows Live in the console. Then run `docker restart realtime-dev.supabase-realtime`. Check: the console reconnects on its own and the aircraft is Live again (`NFR-REL-06`).

3.3. **Broadcast latency on the mini-PC** (M1's open criterion, `DEP-23`): p95 ≤ 150 ms from soc-cloud to a member's browser. SOC's measurement for the mini-PC is listed under "Before the first deploy".

## Phase 4: the first operation, in the simulator, on the mini-PC

This phase is SO's `docs/first-real-flight.md` Part A, flown by SOC. A simulated completion counts only when this deployment's so-fleet holds it (SO's NFR-SAF-07). Do it in this order:

4.1. **Define it in the console.**
- A geofence inside SO's 50 m circle, its ceiling at most 30 m.
- A wayline inside the geofence.
- The operation's height at most 30 m.
- Leave the speed blank: it takes the stack's 3 m/s.

4.2. **Plan, Prepare, Simulate.** The 16 checks pass, then the simulated flight ends ok. **Do not change the definition afterwards.** The real flight must fly the same bytes (the KMZ's MD5), and any change makes a new file. The operation waits in `simulated`.

4.3. **SO's clearance.** Follow SO's Part A:
- run `tools/clearance.py` over the phone's flight records;
- write `so-clearance.json` to the phone;
- run `$S sim_stop` before every application restart (otherwise diagnostic 8012);
- restart the application. Check: `$S status` says `build_cleared=true`.

4.4. **SO's refusals again (A2), propellers off.** SOC's Launch drives the execute rows. A refused launch returns the operation to `ready` with SO's meaning shown, and the pilot can launch again.

| Row | Expected |
| --- | --- |
| so-bridge real, phone simulator on | Refused `316010` (simulator in real mode). If a SOC check holds the launch back first, record that SOC refused it and go on. |
| Simulator off, no confirmation | Refused `314010` (real flight not confirmed, not armed) |
| `$S takeoff` | Refused |
| The key turns; a restart takes it away | As SO's runbook says |

A2 ends with so-bridge back in simulator mode. The operation returns to `simulated` and waits there. Never arm in real mode at the desk.

4.5. **Part B is M5 itself, at the site with propellers on:**
- set `simulator_mode` false and restart so-bridge;
- the operator confirms real flight on the phone and arms it;
- the operation moves to `ready`;
- the pilot launches from the console.

## Rules while the three run

- **Never during a flight:**
  - deploy, restart or update SO or SOC;
  - migrate either database;
  - run `docker compose down` on any of the three.
- **Never run `down -v` on SO.** Its volume `so-fleet-data` holds the simulated completion that clears the real flight.
- **Stopping and restarting:**
  - stop SOC before SO or VO2;
  - if SO's network is ever recreated, recreate soc-cloud and soc-operations with `docker compose up -d --force-recreate soc-cloud soc-operations`;
  - after a reboot, the restart policies bring everything back.
- **SO's desk tools.** `infra/fly.py` and `telemetry_check.py` cannot run while soc-cloud is connected: the broker uses `cloud-client` as the client id, and a second connection takes the session over.
- **VO2's broker:** stay out of `virtual-origen/#` on it. It is anonymous on the LAN.

## Before the first deploy

| Owner | Item | Why |
| --- | --- | --- |
| SO | v0.4.4 tagged: v0.4.3 with the waypoint index fixed (#135), its APK and its runbook | The mini-PC runs it |
| SOC | A release with:<br>• the shared migration lock<br>• SO v0.4.4 re-vendored and the route check over the whole execution<br>• the deploy command that refuses while a flight is unfinished (`FR-DEP-06`)<br>• the Broadcast measurement for the mini-PC | Phase 2's tag |
| VO2 | The shared lock in `apply-migrations.sh` | Until then, the rule in 2.6 |
| VO2 | ADR 0059 and its gate test (`DEP-20`) | The contract SOC reads |
| VO2 and Sergio | Automated backups:<br>• `pg_dumpall --globals-only`<br>• a full `pg_dump`<br>• `infra/supabase-local/volumes/storage`<br>with a tested restore | `RISK-08`; step 0.2 covers the first deploy only |
| VO2 | `TENANT_MAX_EVENTS_PER_SECOND` passed through VO2's compose (`DEP-24`) | Before M7, when SOC follows more than one aircraft |
