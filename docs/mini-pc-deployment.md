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
| SOC | `sky-orchestrator-client` | `/srv/sky-orchestrator-client/stack`, deployed by each release (ADR-0026) | 0.0.0.0: 8088 (the console) | soc-cloud joins both networks; soc-operations joins VO2's; soc-web joins neither |

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
- no VO2 deploy is running: `pgrep -af '[R]unner\.Worker'` prints nothing (step 2.7);
- VO2's retention is not about to drop partitions. A purge queued behind the dump would hold up new samples until the dump ends. `retention: purga ejecutada` is logged after the drop, so look at the cycle instead:
  ```bash
  docker logs -t vo-retention --since 30h 2>&1 | grep -E 'retention: (inicio de ciclo|ciclo completado)' | tail -1
  ```
  It must be a `ciclo completado` less than 20 h old: the next cycle starts 20.4 to 27.6 h after it.
  - If it says `inicio de ciclo`, a cycle is running: wait for `ciclo completado`.
  - If the last `ciclo completado` is older than 20 h, wait for the next one, then dump.

```bash
sudo mkdir -p /srv/backups && sudo chown "$USER": /srv/backups         # sudo
docker exec supabase-db pg_dumpall -U postgres --globals-only > /srv/backups/globals-$(date +%F).sql; echo "exit $?"
docker exec supabase-db pg_dump -U postgres -Fc postgres > /srv/backups/postgres-$(date +%F).dump; echo "exit $?"
chmod 600 /srv/backups/*                     # every user's and role's password hash is inside
docker exec -i supabase-db pg_restore --list < /srv/backups/postgres-$(date +%F).dump | head
```

Never add `-t` to these `docker exec` commands: a TTY corrupts the binary dump.

Check:
- both commands print `exit 0`. A pg_dump that fails partway still leaves a partial file, and `pg_restore --list` succeeds on a truncated one;
- `pg_restore --list` prints the archive's table of contents;
- both files are copied off the mini-PC, to the laptop. That is the only offsite copy there will be.

0.3. **Packages and tools.** SO's and SOC's images are private on GHCR:
- VO2 and SOC leave no login behind. Each deploys as its runner's user (`vo-runner`, `soc-runner`) with its workflow's own token, scoped to its repository, and logs out when the job ends.
- SO's Phase 1 pulls by hand: create a classic GitHub token with `read:packages` only, and log in once as the operator's user with `docker login ghcr.io -u SergioDeIscarValera --password-stdin`, pasting the token. Never put it on the command line or in a file. Log out (`docker logout ghcr.io`) once Phase 1 is up.
- Cloning the two private repositories needs a second token: a fine-grained one with Contents read-only, limited to `sky-orchestrator` and `sky-orchestrator-client`. Type it as the password at `git clone`. Never put it in the remote URL.
- Install adb for SO's phone link: `sudo apt install adb` (**sudo**); the package brings its udev rules.
- git, curl, openssl and python3 must be on the mini-PC.

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
2. **The application.** Install the debug APK that SO built on the laptop from the v0.4.4 tag, on a clean tree. It must be a debug build, because session.sh and the clearance write through `run-as`. Its BuildConfig names `fe6b57fb0388`, which is the commit clearance.py lists.
   - On the laptop: `/home/sergio/Documents/sky-orchestrator-apk/so-msdk-v4-v0.4.4-fe6b57fb0388-debug.apk`, with its `.sha256` beside it.
   - Its SHA-256 is `d9c1760a67300ea6b402773abb427e10377c34cf90cdaa9ee38f44633e4ec8ec`.
   ```bash
   scp <laptop>:/home/sergio/Documents/sky-orchestrator-apk/so-msdk-v4-v0.4.4-fe6b57fb0388-debug.apk* .
   sha256sum -c so-msdk-v4-v0.4.4-fe6b57fb0388-debug.apk.sha256
   adb -s <phone IP>:5555 install -r so-msdk-v4-v0.4.4-fe6b57fb0388-debug.apk
   ```
   Alternatively, install it from the laptop while the phone is on the laptop's adb.
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

SOC deploys itself on every release, as VO2 does (ADR-0026). The mini-PC gets, once:
- a user, `soc-runner`, and the stack's folder;
- the stack's env and configuration files, written by hand;
- an Actions runner for SOC's repository.

From then on a merged release deploys on its own, and a dispatch of release.yml with a tag deploys that tag: the first install, a redeploy, a rollback. The mini-PC keeps no GHCR credential: the job signs in with its own token and signs out when it ends.

2.1. **The runner's user and the folders.**

```bash
sudo useradd --create-home --shell /bin/bash soc-runner                     # sudo
sudo usermod -aG docker soc-runner                                          # sudo
sudo -u soc-runner docker version --format '{{.Server.Version}}'           # sudo
sudo install -d -o soc-runner -g soc-runner -m 0755 /srv/sky-orchestrator-client /srv/sky-orchestrator-client/stack   # sudo
sudo -u soc-runner git clone https://github.com/SergioDeIscarValera/sky-orchestrator-client.git /srv/sky-orchestrator-client/repo   # sudo; the fine-grained token of 0.3
sudo -u soc-runner git -C /srv/sky-orchestrator-client/repo checkout v0.5.2   # sudo
STACK=/srv/sky-orchestrator-client/stack REPO=/srv/sky-orchestrator-client/repo
soc() { docker compose -f "$STACK/compose.yaml" --project-directory "$STACK" "$@"; }
```

- `soc-runner` has no sudo and is in group `docker` only, like `vo-runner`.
- `stack` is where SOC runs from. Its env and configuration files are written here once and never by CI. Each deploy puts its tag's `compose.yaml` and `deploy.py` beside them.
- `repo` holds the examples and `set_env.py`. Nothing runs from it.
- Every SOC compose command on the mini-PC goes through `soc`, which exists once the first deploy has put `compose.yaml` in place (2.7).

2.2. **The farm's organization.** SOC acts for the farm's VO2 organization only: **Origen**, `70458d25-9fb9-4ae8-8b43-7adf7ba95ee2`. Confirm it on the box. The list also holds the personal organizations VO2 creates at every sign-up, named "Finca de <name>":

```bash
docker exec supabase-db psql -U postgres -Atc \
  "select id, name from public.organizations where deleted_at is null"
```

2.3. **Environment files.** They hold the secrets: mode 600, owned by `soc-runner`. The deploy job refuses any other owner or mode.

Every value goes through `set_env.py`, which reads it on stdin, so it is never on a command line or a screen. VO2's values come from its `.env`, which belongs to `vo-runner`, mode 600, and are read as that user. SO's come from the `.env` of step 1.2.

```bash
cd "$STACK"
for f in .env migrate.env soc-cloud.env soc-operations.env soc-web.env; do
  sudo -u soc-runner install -m 600 "$REPO/infra/compose/$f.example" "$f"   # sudo
done
set_env() { sudo -u soc-runner python3 "$REPO/infra/deploy/set_env.py" "$@"; }                   # sudo
vo() { sudo -u vo-runner grep "^$1=" /srv/virtual-origen/repo/infra/supabase-local/.env | cut -d= -f2-; }   # sudo
so() { grep "^$1=" /srv/sky-orchestrator/infra/compose/.env | cut -d= -f2-; }

printf '%s\n' v0.5.2 | set_env .env SOC_VERSION

# soc-migrate connects as VO2's owner role. The password is percent-encoded: an
# unencoded special character once broke VO2's URL parsing and leaked it into a log.
encoded=$(vo POSTGRES_PASSWORD | python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.stdin.read().strip(), safe=""))')
printf 'postgresql://postgres:%s@db:5432/postgres\n' "$encoded" | set_env migrate.env SOC_MIGRATE_DSN
unset encoded

# The two login roles' passwords, each in migrate.env and in its service's file.
cloud=$(openssl rand -hex 24) operations=$(openssl rand -hex 24)
printf '%s\n' "$cloud" | set_env migrate.env SOC_DB_PASSWORD_SOC_CLOUD
printf '%s\n' "$cloud" | set_env soc-cloud.env SOC_DB_PASSWORD_SOC_CLOUD
printf '%s\n' "$operations" | set_env migrate.env SOC_DB_PASSWORD_SOC_OPERATIONS
printf '%s\n' "$operations" | set_env soc-operations.env SOC_DB_PASSWORD_SOC_OPERATIONS
unset cloud operations

vo SERVICE_ROLE_KEY | set_env soc-cloud.env SOC_SUPABASE_SERVICE_ROLE_KEY

# The example names its stack "lab"; the farm's is "farm" (2.4).
sudo -u soc-runner sed -i 's/^SOC_MQTT_PASSWORD_LAB=/SOC_MQTT_PASSWORD_FARM=/; s/^SOC_SO_API_TOKEN_LAB=/SOC_SO_API_TOKEN_FARM=/' soc-cloud.env   # sudo
so SO_MQTT_PASSWORD_CLOUD_CLIENT | set_env soc-cloud.env SOC_MQTT_PASSWORD_FARM
so SO_WAYLINE_API_TOKEN | set_env soc-cloud.env SOC_SO_API_TOKEN_FARM

# The browser's Supabase address on the LAN, and VO2's public key, the one VO2's
# own web is built with. The service role key is refused.
printf '%s\n' http://192.168.1.201:8000 | set_env soc-web.env SOC_WEB_SUPABASE_URL
vo ANON_KEY | set_env soc-web.env SOC_WEB_SUPABASE_KEY

grep -nE '=(replace-with.*)?$' .env *.env | cut -d= -f1    # must print nothing
stat -c '%U:%G %a %n' .env *.env                           # each soc-runner:soc-runner 600
```

Check:
- each `set_env` printed `<file>: <key> set`. A refusal changes nothing and says why, never with the value;
- the `grep` prints nothing: no value is left blank or as the example's placeholder. It prints file, line and key only;
- `.env` keeps the example's network names and `SOC_WEB_PORT=8088`.

2.4. **Configuration files.** They name the variables that hold the secrets and hold none: mode 644, because the services read them as uid 10001.

```bash
cd "$STACK"
for unit in soc-cloud soc-operations soc-web; do
  sudo -u soc-runner install -m 644 "$REPO/infra/compose/$unit.json.example" "$unit.json"   # sudo
done
sudo -u soc-runner python3 - 70458d25-9fb9-4ae8-8b43-7adf7ba95ee2 <<'PY'   # sudo; the organization of 2.2
import json, sys

organization = sys.argv[1]
farm = {
    "name": "farm",
    "organization": organization,
    "broker": {"host": "mosquitto", "port": 1883, "username": "cloud-client",
               "password_env": "SOC_MQTT_PASSWORD_FARM", "client_id": "cloud-client"},
    "api": {"url": "http://so-wayline:8081", "token_env": "SOC_SO_API_TOKEN_FARM"},
    "flight_files_url": "http://soc-cloud:8090",
}
for name, blanks in (
    ("soc-cloud.json", {"served_organizations": [organization], "stacks": [farm]}),
    ("soc-operations.json", {"served_organizations": [organization]}),
):
    with open(name) as file:
        config = json.load(file)
    config.update(blanks)
    with open(name, "w") as file:
        json.dump(config, file, indent=2)
        file.write("\n")
    print(name, "filled")
PY
grep -c null soc-cloud.json soc-operations.json soc-web.json   # each 0
stat -c '%U:%G %a %n' *.json                                     # each soc-runner:soc-runner 644
```

Every deploy checks the three files with its tag's `soc-config` before it changes anything, and a refusal names the field.

2.5. **The farm's site model** (optional; without one the ground is flat). Fetching needs the internet, so run it on the laptop from SOC's repository, then copy the model over:

```bash
uv run soc-site fetch --latitude <lat> --longitude <lon> --half-size-m 1000 --sources site/sources
uv run soc-site bake --sources site/sources --out site/model
scp -r site/model <mini-PC>:site-model
```

Then, on the mini-PC:

```bash
sudo -u soc-runner install -d -m 0755 "$STACK/site" "$STACK/site/70458d25-9fb9-4ae8-8b43-7adf7ba95ee2"   # sudo
sudo install -o soc-runner -g soc-runner -m 0644 ~/site-model/* "$STACK/site/70458d25-9fb9-4ae8-8b43-7adf7ba95ee2/"   # sudo
```

The files must be world-readable: soc-web serves them as uid 10001.

2.6. **The runner.** It runs one job, `deploy` in release.yml, on `[self-hosted, minipc]`, as VO2's runner does for VO2.

A registration token comes from GitHub, Settings, Actions, Runners, **New self-hosted runner**, and expires within an hour. Sergio types it at `config.sh`'s prompt, in his own terminal; it is never put on a command line.

```bash
sudo -iu soc-runner                                  # sudo; the whole block as soc-runner
mkdir -p ~/actions-runner && cd ~/actions-runner
version=$(curl -sSL https://api.github.com/repos/actions/runner/releases/latest | grep -m1 '"tag_name"' | sed -E 's/.*"v([^"]+)".*/\1/')
tarball="actions-runner-linux-x64-$version.tar.gz"
curl -sSLO "https://github.com/actions/runner/releases/download/v$version/$tarball"
sha=$(curl -sSL "https://api.github.com/repos/actions/runner/releases/tags/v$version" | grep -o 'BEGIN SHA linux-x64 -->[0-9a-f]\{64\}' | grep -o '[0-9a-f]\{64\}$')
echo "$sha  $tarball" | sha256sum -c                  # must say OK
tar xzf "$tarball"
./config.sh --url https://github.com/SergioDeIscarValera/sky-orchestrator-client \
  --name minipc --labels self-hosted,minipc --work _work --replace   # asks for the token
exit
```

As a systemd service, so it comes back after a power cut:

```bash
cd /home/soc-runner/actions-runner
sudo ./svc.sh install soc-runner                    # sudo
sudo ./svc.sh start                                 # sudo
unit=actions.runner.SergioDeIscarValera-sky-orchestrator-client.minipc.service
systemctl is-enabled "$unit"; systemctl is-active "$unit"
sudo journalctl -u "$unit" -n 30 --no-pager | grep 'Listening for Jobs'   # sudo
```

Check:
- `sha256sum` said OK, and the service is `enabled` and `active`;
- in GitHub, Settings, Actions, Runners, `minipc` is Idle with the labels `self-hosted`, `minipc`, `Linux` and `X64`;
- `pgrep -af '[R]unner\.Worker'` now finds a deploy job of either project. `pgrep -u vo-runner` and `pgrep -u soc-runner` tell them apart.

2.7. **The first deploy.** It migrates the database and starts SOC. Never migrate while a VO2 release runs: until both projects' migrations take the shared lock, nothing else stops them overlapping.

VO2 deploys through its own runner (systemd unit `actions.runner.*`, user `vo-runner`). At VO2 v0.0.41 a release starts on a `v*` tag push or a manual dispatch. From VO2's next release on, merging a release pull request into main starts one too (VO2's ADR 0057). Until Phase 2 is over, merge nothing into VO2's main, push no `v*` tag and run no VO2 workflow by hand.

On the mini-PC:

```bash
pgrep -u vo-runner -af '[R]unner\.Worker'           # must print nothing: no VO2 deploy job is running
docker network inspect sky-orchestrator_default supabase-local_default --format '{{.Name}}'   # both exist
```

From the laptop, turn the switch on, then deploy the tag:

```bash
gh variable set SOC_MINIPC_DEPLOY_ENABLED --body true --repo SergioDeIscarValera/sky-orchestrator-client
gh workflow run release.yml --repo SergioDeIscarValera/sky-orchestrator-client --ref main -f tag=v0.5.2
gh run watch --repo SergioDeIscarValera/sky-orchestrator-client \
  "$(gh run list --repo SergioDeIscarValera/sky-orchestrator-client --workflow release.yml --event workflow_dispatch --limit 1 --json databaseId --jq '.[0].databaseId')"
```

The switch is the repository variable `SOC_MINIPC_DEPLOY_ENABLED`, also set in GitHub, Settings, Secrets and variables, Actions, Variables. While it is anything but `true`, the deploy job is skipped, grey, not failed: without a runner it would wait in the queue for 24 hours. To stop deploying for a while (maintenance, a new mini-PC), set it to `false`; the stack keeps running.

The job:
1. refuses a version that is not a release tag, and checks out the tag;
2. checks Docker and the stack's files, their owner and their modes;
3. puts the tag's `compose.yaml` and `deploy.py` into the stack;
4. signs in to GHCR with its own token, which reads packages only;
5. checks the three configuration files with the tag's `soc-config`;
6. runs `deploy.py`: no flight unfinished, `SOC_VERSION` set, pull, migrate, `up -d --wait`;
7. shows `soc ps`, and signs out of GHCR whatever happened.

Check:
- the run is green, and its summary ends with `deployed SOC v0.5.2`;
- on the mini-PC:
  ```bash
  docker exec supabase-db psql -U postgres -Atc "select count(*) from soc_migrations.applied"   # 10 at v0.5.2
  soc ps
  docker stats --no-stream $(soc ps -q)
  soc logs soc-web-check
  ```
- every container is healthy within 60 s and within its limits (M1's criterion `FR-DEP-01`, `NFR-RES-05`): the job's `up --wait` step shows the time;
- `soc logs soc-web-check` is empty of problems;
- the job signed out: `sudo -u soc-runner grep -c ghcr.io /home/soc-runner/.docker/config.json` prints 0, or says the file does not exist.

If the job fails, its log names the step and the cause. Fix it on the mini-PC and dispatch the same tag again: a deploy that stopped is safe to repeat.

2.8. **PostgREST serves `soc` (DEP-21).** Append `,soc` to `PGRST_DB_SCHEMAS` in `/srv/virtual-origen/repo/infra/supabase-local/.env`, keeping the schemas already listed. VO2's releases never overwrite it. The file and its directory belong to `vo-runner`, mode 600, so edit it and run compose as that user, as VO2's deploy does:

```bash
D=/srv/virtual-origen/repo/infra/supabase-local
pgrep -af '[R]unner\.Worker'                                     # must print nothing: no deploy, VO2's or SOC's
sudo -u vo-runner grep '^PGRST_DB_SCHEMAS=' "$D/.env"       # sudo; expect public,graphql_public
sudo -u vo-runner sed -i 's/^PGRST_DB_SCHEMAS=public,graphql_public$/PGRST_DB_SCHEMAS=public,graphql_public,soc/' "$D/.env"   # sudo
sudo -u vo-runner grep '^PGRST_DB_SCHEMAS=' "$D/.env"       # sudo; expect public,graphql_public,soc
stat -c '%U:%G %a' "$D/.env"                                # expect vo-runner:vo-runner 600
sudo -u vo-runner bash -c 'cd "$1" && docker compose up -d --dry-run --no-deps rest studio' _ "$D"   # sudo
sudo -u vo-runner bash -c 'cd "$1" && docker compose up -d --no-deps rest studio' _ "$D"             # sudo
docker restart supabase-kong          # otherwise Kong answers 502 to the old rest
docker inspect -f '{{.State.Health.Status}}' supabase-kong  # wait for healthy
```

- If the first grep shows anything else, stop: the sed is anchored to that exact value and would change nothing.
- Compose runs from VO2's directory, entered as `vo-runner`, so it loads VO2's compose file and never SOC's from the operator's current directory.
- The dry run must recreate only `supabase-rest` and `supabase-studio`. Anything else, above all `supabase-db`, means stop. `--no-deps` keeps compose from recreating a dependency whose configuration drifted; `db` drifted once.
- Never edit the file as root (`sudo nano`, `sudo sed`). A `.env` left owned by root makes VO2's next release fail in `sync-stack.sh`.
- Never run project `supabase-local` from another directory. Postgres's data is a bind mount at `./volumes/db/data`, so the same project elsewhere recreates `supabase-db` on an empty data directory.
- The Kong restart cuts VO2's web, MCP and Realtime for about 5 s, and the farm's seven backend services too: they reach Supabase at `http://kong:8000` with no fallback.

Check both sides:
- SOC: `curl -s -H "apikey: <ANON_KEY>" -H 'Accept-Profile: soc' 'http://192.168.1.201:8000/rest/v1/stacks?limit=1'` answers without `PGRST106` (schema must be one of). A permission error is expected, since the anonymous key may read nothing of `soc`: only `PGRST106` means the schema is not served.
- VO2: `curl -s http://192.168.1.201:8080/health/data-layer` is still OK, and VO2's web loads.

This comes after the first deploy because PostgREST must find schema `soc`, which the migrations create, when it starts. Until then the console signs in but reads nothing of `soc`.

2.9. **The console.** From a laptop on the farm's Wi-Fi, open `http://192.168.1.201:8088` and sign in with a VO2 account. Check:
- the farm's organization is offered;
- the dock and its aircraft appear in the fleet panel once the phone is connected.

Then confirm the stack was read:

```bash
docker exec supabase-db psql -U postgres -Atc \
  "select name, link_state, status is not null, envelope is not null from soc.stacks"
```

Check: `connected`, `t`, `t`.

2.10. **Password reset links (DEP-22), optional.** Sign-in by password works without it. For email links that land on the console, append `,http://192.168.1.201:8088/**` to `ADDITIONAL_REDIRECT_URLS` in the same VO2 `.env`, as `vo-runner` and with the same care as 2.8. The glob is there because reset links carry a path; GoTrue v2.189.0's matching is untested, so try a reset once. Then:

```bash
sudo -u vo-runner bash -c 'cd "$1" && docker compose up -d --dry-run --no-deps auth' _ "$D"   # sudo; only supabase-auth
sudo -u vo-runner bash -c 'cd "$1" && docker compose up -d --no-deps auth' _ "$D"             # sudo
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

Then run `docker restart realtime-dev.supabase-realtime`. Restart it only, never `up` or `--force-recreate`: a recreate can lose its `API_JWT_JWKS`, and then no VO2 user can sign in to Realtime. Check:
- the console reconnects on its own, and the aircraft is Live again (`NFR-REL-06`);
- `docker exec supabase-db psql -U postgres -Atc "select jwt_jwks is not null from _realtime.tenants where external_id='realtime-dev'"` prints `t`;
- VO2's web does not show "Sin conexión en vivo".

Finish with `$S sim_stop`.

VO2's Realtime clients drop for a moment too. Its backend resubscribes within about 15 to 30 s, and its web reconnects on its own. If nothing reconnects within a minute and Kong logs 502 on `/realtime`, run `docker restart supabase-kong`: the Realtime container may have a new IP.

3.3. **Broadcast latency on the mini-PC** (M1's open criterion, `DEP-23`): a member's samples arrive with p95 ≤ 150 ms, a non-member is refused, and both still hold after the Realtime container restarts. The probe runs in soc-cloud's image, so it reads soc-cloud's clock. Start the simulator as in 3.2 and wait until the aircraft is Live. Then, with `STACK` and `soc` as in 2.1, read the credentials at prompts, so they reach neither a file nor the shell's history:

```bash
export SOC_PROBE_ANON_KEY="$(sudo -u soc-runner sed -n 's/^SOC_WEB_SUPABASE_KEY=//p' "$STACK/soc-web.env")"
read -rp 'Member email: ' SOC_PROBE_EMAIL; read -rsp 'Member password: ' SOC_PROBE_PASSWORD; echo
read -rp 'Non-member email: ' SOC_PROBE_OUTSIDER_EMAIL; read -rsp 'Non-member password: ' SOC_PROBE_OUTSIDER_PASSWORD; echo
export SOC_PROBE_EMAIL SOC_PROBE_PASSWORD SOC_PROBE_OUTSIDER_EMAIL SOC_PROBE_OUTSIDER_PASSWORD
soc run --rm --no-deps -e SOC_PROBE_ANON_KEY -e SOC_PROBE_EMAIL -e SOC_PROBE_PASSWORD \
  -e SOC_PROBE_OUTSIDER_EMAIL -e SOC_PROBE_OUTSIDER_PASSWORD \
  --entrypoint soc-broadcast-probe soc-cloud \
  --supabase-url http://kong:8000 --organization 70458d25-9fb9-4ae8-8b43-7adf7ba95ee2
unset SOC_PROBE_ANON_KEY SOC_PROBE_EMAIL SOC_PROBE_PASSWORD SOC_PROBE_OUTSIDER_EMAIL SOC_PROBE_OUTSIDER_PASSWORD
```

The member belongs to Origen (2.2). The non-member is any VO2 user outside it, such as the owner of a personal "Finca de <name>" only. The run takes 10 minutes. Two minutes in, restart Realtime with `docker restart realtime-dev.supabase-realtime`. The probe needs no restart of its own: it reports the drop on stderr, joins again under backoff and carries on.

Pass when the exit status is 0. Check the JSON line on stdout: `outsider_refused` is `true`, `reconnects` is at least 1, and `p95_ms` is at most 150. Write `longest_gap_ms` down with the other figures: it is the silence the restart caused. A run that exits 1 prints each reason on stderr as a `probe_failed` line.

If the probe does not rejoin within a minute and Kong logs 502 on `/realtime`, Kong is holding the Realtime container's old address (see 3.2). Run `docker restart supabase-kong` and let the probe finish. That run may exit 0, but only with Kong's restart: report it as needing the restart. DEP-23 is met only by a run that rejoins without one.

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

- **Upgrading SOC** is a release: merging its pull request into main deploys it on the mini-PC once its images are published (ADR-0026). `deploy.py` refuses, changing nothing, while any flight is unfinished, then pulls, migrates and starts the version (`FR-DEP-06`; [upgrading on the mini-PC](../infra/README.md#upgrading-on-the-mini-pc)).
  - A deploy refused for a flight is not retried by itself: once the flight ends, dispatch release.yml with the same tag (2.7).
  - A rollback is a dispatch with the older tag. Migrations never run backwards: a rollback over a migration that changed a table needs the backup.
  - Until VO2's migrations take the shared lock, merge no SOC release while VO2's runner is busy (`pgrep -u vo-runner -af '[R]unner\.Worker'`), and the other way round.
  - The stack's files are `soc-runner`'s: edit them as that user, through `set_env.py` for a secret. A file left owned by root, or a secret readable by others, stops the next deploy before it changes anything.
- **While the repository is public** (RISK-17), approve no workflow run from a fork: it could run on the mini-PC's runner.
- **Never during a flight:**
  - deploy, restart or update SO or SOC;
  - migrate either database;
  - run `docker compose down` on any of the three;
  - merge into VO2's main, push a VO2 `v*` tag or run a VO2 workflow by hand. A release deploys on its own through the mini-PC's runner, and `sync-stack.sh` may restart Kong and recreate Supabase services, cutting the console's REST, sign-in and Realtime.
- **VO2's `JWT_SECRET` rotation** (pending in VO2) changes `ANON_KEY` and `SERVICE_ROLE_KEY`. On the same day, put the new values in `soc-web.env` and `soc-cloud.env` with `set_env.py` (2.3) and run `soc up -d --force-recreate soc-web soc-cloud`.
- **Never run `down -v` on SO.** Its volume `so-fleet-data` holds the simulated completion that clears the real flight.
- **Stopping and restarting:**
  - stop SOC before SO or VO2;
  - if SO's network is ever recreated, recreate soc-cloud and soc-operations with `soc up -d --force-recreate soc-cloud soc-operations`;
  - after a reboot, the restart policies bring everything back.
- **SO's desk tools.** `infra/fly.py` and `telemetry_check.py` cannot run while soc-cloud is connected: the broker uses `cloud-client` as the client id, and a second connection takes the session over.
- **VO2's broker:** stay out of `virtual-origen/#` on it. It is anonymous on the LAN.

## Before the first deploy

| Owner | Item | Why |
| --- | --- | --- |
| SO | v0.4.4 tagged: v0.4.3 with the waypoint index fixed (#135), its APK and its runbook | The mini-PC runs it |
| SOC | v0.5.2, released with:<br>• everything in v0.5.1: the shared migration lock, SO v0.4.4 re-vendored, the deploy command that refuses while a flight is unfinished (`FR-DEP-06`), the Broadcast measurement<br>• the deploy on every release through the mini-PC's runner (ADR-0026)<br>• the configuration examples and `set_env.py` | Phase 2's tag |
| VO2 | The shared lock in `apply-migrations.sh` | Until then, the rule in 2.7 |
| VO2 | ADR 0059 and its gate test (`DEP-20`) | The contract SOC reads |
| VO2 and Sergio | Automated backups:<br>• `pg_dumpall --globals-only`<br>• a full `pg_dump`<br>• `infra/supabase-local/volumes/storage`<br>with a tested restore | `RISK-08`; step 0.2 covers the first deploy only |
| VO2 | `TENANT_MAX_EVENTS_PER_SECOND` passed through VO2's compose (`DEP-24`) | Before M7, when SOC follows more than one aircraft |
