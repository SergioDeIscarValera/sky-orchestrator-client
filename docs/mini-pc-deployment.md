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

0.2. **A backup of the database.** No automated backup exists for VO2 or SOC (SOC's RISK-08, VO2's ADR 0052). Take one before SOC's migrations change the database.

The dump takes only shared locks, so the farm keeps reading and writing. Before starting it, check two things:
- no VO2 release is in progress (step 2.6's command);
- VO2's retention is not about to drop partitions: `docker logs vo-retention --since 15m | grep -i purga` must print nothing. A purge queued behind the dump would hold up new samples until the dump ends.

```bash
sudo mkdir -p /srv/backups && sudo chown "$USER": /srv/backups         # sudo
docker exec supabase-db pg_dumpall -U postgres --globals-only > /srv/backups/globals-$(date +%F).sql
docker exec supabase-db pg_dump -U postgres -Fc postgres > /srv/backups/postgres-$(date +%F).dump
chmod 600 /srv/backups/*                     # every user's and role's password hash is inside
docker exec -i supabase-db pg_restore --list < /srv/backups/postgres-$(date +%F).dump | head
```

Never add `-t` to these `docker exec` commands: a TTY corrupts the binary dump.

Check:
- `pg_restore --list` prints the archive's table of contents;
- both files are copied off the mini-PC, to the laptop. That is the only offsite copy there will be.

0.3. **Packages and tools.** SO's and SOC's images are private on GHCR:
- Create a classic GitHub token with `read:packages` only.
- Log in once with `docker login ghcr.io -u SergioDeIscarValera`, the token as the password.
- Cloning the two private repositories needs a second token: a fine-grained one with Contents read-only, limited to `sky-orchestrator` and `sky-orchestrator-client`. Type it as the password at `git clone`. Never put it in the remote URL.
- Install adb for SO's phone link: `sudo apt install android-tools-adb` (**sudo**).
- git and python3 must be on the mini-PC.

0.4. **The database owner can create roles.** SOC's migrations create two login roles as `postgres`:

```bash
docker exec supabase-db psql -U postgres -c '\du postgres'
```

Check: the attributes are `Create role, Create DB, Replication, Bypass RLS`. `postgres` is not a superuser on this image, `supabase/postgres:17.6.1.136`, and SOC's container lane creates its roles there with these rights.

0.5. **The clocks.**
- On the mini-PC, `timedatectl` must say `System clock synchronized: yes`.
- On the phone, set the date and time to automatic.
- Why it matters: so-bridge measures the phone's offset and sets its deadlines in the phone's clock, so an unsynchronized clock does not cause refusals. Synchronized clocks make SO's records, the phone's and SOC's logs line up. On 2026-10-11 the phone ran about 510 ms behind the server. SOC's PF-CLOCK check shows the offset.

0.6. **The tunnel publishes only VO2's API.** In Cloudflare Zero Trust, open Tunnels, then Public Hostnames. Check there is exactly one entry: `api.virtualorigen.dpdns.org` → `http://kong:8000`. Once Phase 2 exposes schema `soc`, SOC's tables are reachable through it, guarded by row-level security, as VO2's are.

## Phase 1: Sky Orchestrator v0.4.4

1.1. **The checkout at the tag, and a helper for its compose.**

```bash
sudo mkdir -p /srv/sky-orchestrator && sudo chown "$USER": /srv/sky-orchestrator   # sudo
git clone https://github.com/SergioDeIscarValera/sky-orchestrator.git /srv/sky-orchestrator
git -C /srv/sky-orchestrator checkout v0.4.4
dc() { SO_VERSION=v0.4.4 docker compose -f /srv/sky-orchestrator/infra/compose/compose.yaml \
  -f /srv/sky-orchestrator/infra/compose/compose.release.yaml "$@"; }
```

Every SO compose command on the mini-PC goes through `dc`. It needs both files and the version: without the release file, compose tries to build `:local` images, and the mini-PC has none.

1.2. **Configuration.** Start from SO's examples:
- `cp infra/compose/.env.example infra/compose/.env`;
- fill each of the four `infra/config/*.json` with `python3 tools/device_config.py template --consumer <service>`;
- copy so-fleet's real dock and aircraft identities from the laptop's `so-fleet.json`.

Nothing secret comes from the laptop: its secrets were printed into a local research transcript on 2026-10-16, and the phone is set up again in 1.3. Generate every secret fresh, each 32 or more letters and digits (`openssl rand -hex 24`):
- `SO_MQTT_PASSWORD_SO_GATEWAY`, `SO_MQTT_PASSWORD_SO_FLEET`, `SO_MQTT_PASSWORD_SO_WAYLINE`, `SO_MQTT_PASSWORD_SO_BRIDGE` and `SO_MQTT_PASSWORD_CLOUD_CLIENT`;
- `SO_WAYLINE_API_TOKEN`.

`SO_BRIDGE_SECRET` is set by 1.3.

| File | Setting |
| --- | --- |
| `infra/compose/.env` | `COMPOSE_PROFILES=phone` (never `builtin-cloud`), `SO_BIND=127.0.0.1`, `SO_MQTT_PORT=1884`, `SO_WAYLINE_PORT=8091`, `SO_BRIDGE_URL=http://phone-link:8765`, `SO_PHONE_ADB_TARGET=<phone IP>:5555`, `SO_PHONE_ADB_KEY_DIR=/home/<user>/.android`, `SO_PHONE_ADB_USER=$(id -u):$(id -g)` of the operator |
| `so-gateway.json`, `so-fleet.json`, `so-wayline.json` | `"cloud_role": "external"` |
| `so-wayline.json` | the envelope: `geofence_center` at the site, `geofence_radius_m` 50, `max_height_m` 30, `max_horizontal_speed_ms` 3.0 |
| `so-bridge.json` | `simulator_mode` true |
| `so-bridge.real.json`, a copy of `so-bridge.json` | `simulator_mode` false: real mode, for A2 at the desk and for Part B at the site |

Run `chmod 600 infra/compose/.env`. The checkout, `.env` and `infra/config/` belong to the operator's user.

To rotate a secret later on a running stack, edit `.env`, then run `dc up -d`. Compose recreates mosquitto and every service whose environment changed. Then give soc-cloud its new values and recreate it.

1.3. **The phone, in this order.** The phone and the mini-PC must be on the same Wi-Fi with client isolation off. Give the phone a DHCP reservation.

1. **adb.** Plug the phone in by USB once and accept the mini-PC's key on its screen. Then:
   ```bash
   adb -s <usb serial> tcpip 5555 && adb connect <phone IP>:5555
   ```
   A phone restart turns adb's TCP mode off: plug the phone in again and repeat.
2. **The application.** Install the debug APK that SO builds on the laptop from the v0.4.4 tag. It must be a debug build, because session.sh and the clearance write through `run-as`:
   ```bash
   adb -s <phone IP>:5555 install -r <apk>
   ```
3. **The site configuration**, from `/srv/sky-orchestrator`:
   ```bash
   python3 tools/device_config.py template > so-config.json    # then add "geofence_center" at the site
   adb push so-config.json /data/local/tmp/so-config.json
   adb shell run-as io.github.sergiodeiscarvalera.skyorchestrator.msdkv4 cp /data/local/tmp/so-config.json files/so-config.json
   adb shell rm /data/local/tmp/so-config.json
   ```
   The defaults are already 50 m, 30 m and 3.0 m/s. The file holds a location, so it never goes into git. It must be final before 4.2, because it sets the phone's `config_fingerprint`. Nothing compares it with `so-wayline.json`, so check both by eye.
4. **The bridge secret:**
   ```bash
   ADB_TARGET=<phone IP>:5555 apps/so-msdk-v4/scripts/bridge.sh secret
   ```
   This puts a new secret on the phone and keeps it in `apps/so-msdk-v4/scripts/.bridge-secret`. Copy that value into `.env`'s `SO_BRIDGE_SECRET`.
5. **Start the application only after the controller is cabled.** A running application does not see the product arrive.

1.4. **Up.**

```bash
dc up -d
dc ps
TOKEN=$(grep '^SO_WAYLINE_API_TOKEN=' /srv/sky-orchestrator/infra/compose/.env | cut -d= -f2)
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8091/v1/status
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8091/v1/envelope
dc logs phone-link | tail -3        # "connected to"
```

Check:
- every service is healthy. phone-link is healthy only while the phone is connected, which is why 1.3 comes first;
- `docker network ls` lists `sky-orchestrator_default`;
- `/v1/status` says `simulator_mode` true and the link up, and `aircraft_online` true once the aircraft and controller are on;
- `/v1/envelope` returns the four values of step 1.2.

1.5. **What SOC needs from SO.** Note three values for Phase 2:
- `SO_MQTT_PASSWORD_CLOUD_CLIENT` from SO's `.env`;
- `SO_WAYLINE_API_TOKEN` from SO's `.env`;
- the dock's identity from `so-fleet.json`.

## Phase 2: SOC

2.1. **The checkout at the tag.**

```bash
sudo mkdir -p /srv/sky-orchestrator-client && sudo chown "$USER": /srv/sky-orchestrator-client   # sudo
git clone https://github.com/SergioDeIscarValera/sky-orchestrator-client.git /srv/sky-orchestrator-client   # the fine-grained token of 0.3
git -C /srv/sky-orchestrator-client checkout <SOC tag>
cd /srv/sky-orchestrator-client/infra/compose
```

The tag is SOC's release for the mini-PC (see "Before the first deploy"). Every file below lives in `infra/compose`, mode 600, owned by the operator's user, and git ignores it.

2.2. **The farm's organization.** SOC acts for the farm's VO2 organization only: **Origen**, `70458d25-9fb9-4ae8-8b43-7adf7ba95ee2`. Confirm it on the box. The list also holds the personal organizations VO2 creates at every sign-up, named "Finca de <name>":

```bash
docker exec supabase-db psql -U postgres -Atc \
  "select id, name from public.organizations where deleted_at is null"
```

2.3. **Environment files.** Copy each `*.example` to its name without `.example`, then fill it. VO2's values come from `/srv/virtual-origen/repo/infra/supabase-local/.env`. Read it with sudo if your user cannot.

| File | Values |
| --- | --- |
| `.env` | `SOC_VERSION=<SOC tag>`; the network names and `SOC_WEB_PORT=8088` as in the example |
| `migrate.env` | `SOC_MIGRATE_DSN=postgresql://postgres:<POSTGRES_PASSWORD, percent-encoded>@db:5432/postgres`; `SOC_DB_PASSWORD_SOC_CLOUD` and `SOC_DB_PASSWORD_SOC_OPERATIONS`, each from `openssl rand -hex 24` |
| `soc-cloud.env` | `SOC_DB_PASSWORD_SOC_CLOUD` as in migrate.env; `SOC_SUPABASE_URL=http://kong:8000`; `SOC_SUPABASE_SERVICE_ROLE_KEY` = VO2's `SERVICE_ROLE_KEY`; `SOC_MQTT_PASSWORD_FARM` = SO's `SO_MQTT_PASSWORD_CLOUD_CLIENT`; `SOC_SO_API_TOKEN_FARM` = SO's `SO_WAYLINE_API_TOKEN` |
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

VO2's releases start on their own when a VO2 release pull request is merged into main (VO2's ADR 0057), so merge none while SOC migrates.

```bash
gh run list --repo SergioDeIscarValera/virtual-origen-v2 --workflow release.yml --limit 1 \
  --json status,conclusion,createdAt          # status must not be in_progress or queued
docker compose run --rm soc-migrate
docker exec supabase-db psql -U postgres -Atc "select count(*) from soc_migrations.applied"
```

Check: the count equals the number of files in `database/migrations` at the tag (10 at v0.5.0).

2.7. **PostgREST serves `soc` (DEP-21).** In `/srv/virtual-origen/repo/infra/supabase-local/.env`, append `,soc` to `PGRST_DB_SCHEMAS` and keep the schemas already listed. Use sudo if your user cannot write the file. VO2's releases never overwrite it. Then:

```bash
cd /srv/virtual-origen/repo/infra/supabase-local
docker compose up -d --dry-run --no-deps rest studio   # must not mention supabase-db
docker compose up -d --no-deps rest studio
docker restart supabase-kong          # otherwise Kong answers 502 to the old rest
```

`--no-deps` keeps compose from recreating a dependency whose configuration drifted; `db` drifted once. The Kong restart cuts VO2's web, MCP and Realtime for about 5 s.

Check both sides:
- SOC: `curl -s -H "apikey: <ANON_KEY>" -H 'Accept-Profile: soc' 'http://192.168.1.201:8000/rest/v1/stacks?limit=1'` answers without `PGRST106` (schema must be one of). A permission error is expected, since the anonymous key may read nothing of `soc`: only `PGRST106` means the schema is not served.
- VO2: `curl -s http://192.168.1.201:8080/health/data-layer` is still OK, and VO2's web loads.

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

2.10. **Password reset links (DEP-22), optional.** Sign-in by password works without it. For email links that land on the console, append `,http://192.168.1.201:8088/**` to `ADDITIONAL_REDIRECT_URLS` in the same VO2 `.env`. The glob is there because reset links carry a path; GoTrue v2.189.0's matching is untested, so try a reset once. Then, in VO2's directory:

```bash
docker compose up -d --no-deps auth
docker restart supabase-kong          # otherwise /auth/v1 answers 502 and every login fails, VO2's too
```

## Phase 3: checks on the mini-PC

SO's session commands run from `/srv/sky-orchestrator`, with `S` defined once:

```bash
cd /srv/sky-orchestrator
export ADB_TARGET=<phone IP>:5555
S=apps/so-msdk-v4/scripts/session.sh
```

3.1. **Register the fleet** in the console: the dock and the aircraft that SO's so-fleet announces.

3.2. **Live telemetry.** Run `$S sim_start`. The aircraft shows Live in the console.

Then run `docker restart realtime-dev.supabase-realtime`. Check: the console reconnects on its own, and the aircraft is Live again (`NFR-REL-06`). Finish with `$S sim_stop`.

VO2's Realtime clients drop for a moment too. Its backend resubscribes within about 15 to 30 s, and its web reconnects on its own. If nothing reconnects within a minute and Kong logs 502 on `/realtime`, run `docker restart supabase-kong`: the Realtime container may have a new IP.

3.3. **Broadcast latency on the mini-PC** (M1's open criterion, `DEP-23`): p95 ≤ 150 ms from soc-cloud to a member's browser. SOC's measurement for the mini-PC is listed under "Before the first deploy".

## Phase 4: the first operation, in the simulator, on the mini-PC

This phase is SO's `docs/first-real-flight.md` Part A, flown by SOC. A simulated completion counts only while this deployment's so-fleet holds it (SO's NFR-SAF-07), in its volume `so-fleet-data`. Do it in this order.

4.1. **Define the operation in the console.**
- A geofence inside SO's 50 m circle, its ceiling at most 30 m.
- A wayline inside the geofence.
- The operation's height at most 30 m.
- Leave the speed blank: it takes the stack's 3 m/s.

4.2. **Plan, Prepare, Simulate.**
1. Plan, then Prepare. The 16 checks pass.
2. Start the simulator and arm, just before simulating: the arming has a time limit. The simulator starts at the geofence centre.
   ```bash
   $S sim_start && $S arm
   ```
3. Simulate. The simulated flight ends ok, and the operation waits in `simulated`.
4. Stop the simulator: `$S sim_stop`.

**Do not change the definition afterwards.** The real flight must fly the same bytes (the KMZ's MD5), and any change makes a new file.

4.3. **SO's clearance** (its A1), from `/srv/sky-orchestrator`:

```bash
pkg=io.github.sergiodeiscarvalera.skyorchestrator.msdkv4
mkdir -p records && for f in $(adb -s $ADB_TARGET shell "run-as $pkg ls files/flight-records/" | tr -d '\r'); do
  adb -s $ADB_TARGET shell "run-as $pkg cat files/flight-records/$f" > records/$f; done
python3 tools/clearance.py records/*.jsonl > so-clearance.json
adb -s $ADB_TARGET shell "run-as $pkg sh -c 'cat > files/so-clearance.json.tmp && mv files/so-clearance.json.tmp files/so-clearance.json'" < so-clearance.json
```

Check: `clearance.py` exits 0 and lists the commit of `git -C /srv/sky-orchestrator rev-parse 'v0.4.4^{commit}'`.

Then restart the application. The simulator is already stopped, which is required: a restart with it running makes the aircraft demand a restart (diagnostic 8012). Check: `$S status` says `build_cleared=true`.

4.4. **SO's refusals again (A2), propellers off.** SOC's Launch drives the execute rows. A refused launch returns the operation to `ready` with SO's meaning shown, and the pilot can launch again.

Start: `SO_BRIDGE_CONFIG=../config/so-bridge.real.json dc up -d so-bridge`. Then check that `/v1/status` says `simulator_mode` false.

| Row | First | Expected |
| --- | --- | --- |
| so-bridge real, phone simulator on | `$S sim_start` | The launch is refused with `316010` (simulator in real mode). If a SOC check holds the launch back first, record that SOC refused it and go on. |
| Simulator off, no confirmation | `$S sim_stop` | The launch is refused with `314010` (real flight not confirmed, not armed). If a SOC check holds it back first, such as the arming, read `$S status` instead: its preflight must name `real_flight_not_confirmed` and `not_armed`. |
| `$S takeoff` | | `refused: console flying is for the simulator only` |
| The key | | Tap Enable REAL flight… on the phone and confirm. `$S status` says `real_flight=confirmed build_cleared=true`. Restart the application: `$S status` says `real_flight=off`. |

End: run `dc up -d so-bridge`, which puts so-bridge back in simulator mode. The operation returns to `simulated` and waits there. Never arm in real mode at the desk.

4.5. **Part B is M5 itself.** Follow SO's `docs/first-real-flight.md` Part B in full: it is the authority for the flight. Its outline:
- **Before leaving:** the weather, the batteries, and both envelopes checked.
- **On the site:**
  1. A ping first.
  2. Propellers on, the aircraft at the geofence centre.
  3. `SO_BRIDGE_CONFIG=../config/so-bridge.real.json dc up -d so-bridge`, then check `/v1/status`.
  4. Restart the application with the simulator off, after the controller is cabled.
  5. The operator confirms real flight on the phone.
  6. The arming, on the site, which sets the home point. The operation moves to `ready`.
  7. The console's Launch: Part B's step 7.
- **Taking over:** the selector to Sport or Tripod takes the aircraft back.
- **After:** as Part B says.

## Rules while the three run

- **Never during a flight:**
  - deploy, restart or update SO or SOC;
  - migrate either database;
  - run `docker compose down` on any of the three;
  - merge a VO2 release pull request. It deploys on its own, and `sync-stack.sh` may restart Kong and recreate Supabase services, cutting the console's REST, sign-in and Realtime.
- **VO2's `JWT_SECRET` rotation** (pending in VO2) changes `ANON_KEY` and `SERVICE_ROLE_KEY`. On the same day, put the new values in `soc-web.env` and `soc-cloud.env` and run `docker compose up -d --force-recreate soc-web soc-cloud`.
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
