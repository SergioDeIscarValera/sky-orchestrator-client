# Sky Orchestrator's contracts, vendored

What SOC speaks to Sky Orchestrator with, copied byte for byte from its
repository at one commit, and held there:

| Path | Contract |
| --- | --- |
| `mqtt/` | The DJI Cloud API messages: one JSON Schema per message in a directory per topic kind, the shared envelope, the generated examples, and `dji-methods.json`, the catalogue of DJI's methods |
| `wayline/openapi.yaml` | so-wayline's HTTP API: status, envelope, validations |
| `msdk/geodesy-cases.json` | The distances every implementation of Sky Orchestrator's geodesy reproduces within 10⁻⁶ m: its sphere and haversine, which SOC's validators measure SO's limits in (ADR-0009, `libs/soc-geo`) |
| `msdk/mission-plan.schema.json`, `msdk/examples/mission-plan.square.json` | The mission plan so-wayline turns a flight file into: what SOC's bake produces field for field (`contracts/geometry/design.schema.json`) |
| `wpml/supported-subset.md` | The WPML subset Sky Orchestrator accepts, which SOC's flight files keep to (`FR-WAY-11`) |
| `stack/compose/`, `stack/mosquitto/`, `stack/tests/fixtures/replay/` | The released stack SOC's end to end runs with the fake bridge (SO's ADR-0039): `compose.yaml` with its release overlay, the broker's configuration, ACL and entrypoint, and the recorded flight the compose file mounts into the fake bridge, in upstream's layout so `../mosquitto` and `../tests/fixtures/replay` resolve (a missing mount source would make Docker create it, owned by root, in the checkout); the entrypoint keeps its executable bit, which `--check` holds |
| `config/so-config.schema.json` | The configuration contract the stack's services and the fake bridge read their files by, which the end to end writes them from |
| `vendored.json` | Where the files came from: the repository, the commit, its `git describe` and date |
| `vendored.sha256` | The SHA-256 of every file, in `sha256sum`'s format: `sha256sum -c vendored.sha256` checks them |

Pinned at Sky Orchestrator's **v0.4.3** (2026-10-14, `3477c38`). Like v0.4.2 it
publishes what SOC builds on: `simulate_mission` (`DEP-02`), the stack's status,
envelope and validations (`DEP-01`, `DEP-03`, `DEP-04`), the break reason
(`DEP-05`), the fake bridge image (`DEP-06`), real flight behind two keys and a
cleared build (SO's ADR-0040), deadlines on start and resume (`DEP-27`) and
`media_count` (`DEP-13`). It adds the prepare's `rth_altitude` as the task's
return height (`DEP-29`, SO's ADR-0042: `flighttask_prepare` 1.2.0 says so, and
the mission plan 1.1.0 carries `return_height_m`), and the fake bridge's
`FAKE_BRIDGE_REAL`, a phone ready for real flight in a client's CI (`DEP-28`,
the compose file passes it). No DJI wire shape changed.

## Rules

- **Pinned by commit, not by `x-version`.** A schema's shape has changed upstream
  without its version moving, so only the bytes are trusted.
- **Never edited here.** `tools/vendor_sky_orchestrator.py --check` fails in the
  hooks and in CI on any byte that differs from `vendored.sha256`, any file missing,
  any file added by hand. The whitespace hooks skip this directory.
- **What is left out**: Sky Orchestrator's internal buses (`mqtt/internal/`), the
  phone bridge's own API and messages (`msdk/` but the three files above), its
  infrastructure but the released stack's compose and broker files, and its prose,
  whose links point into its own tree; `wpml/supported-subset.md` is the one prose
  file kept, since it is the contract.
- **Closed and open.** What the dock sends is closed (`additionalProperties:
  false`); what a cloud sends is held to types and required fields. SOC validates
  everything it publishes against these before it leaves (`FR-LNK-10`).
- The schemas reference each other relatively (`../dji-envelope.schema.json`), so
  the layout under `mqtt/` is kept exactly.

## Updating the pin

```bash
python3 tools/vendor_sky_orchestrator.py --source ../sky-orchestrator --commit v0.4.2
python3 tools/vendor_sky_orchestrator.py --check
git diff --stat contracts/sky-orchestrator
```

A new pin is its own pull request: the diff of the schemas is what reviewers read,
and every consumer's tests run against it.
