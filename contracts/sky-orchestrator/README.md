# Sky Orchestrator's contracts, vendored

What SOC speaks to Sky Orchestrator with, copied byte for byte from its
repository at one commit, and held there:

| Path | Contract |
| --- | --- |
| `mqtt/` | The DJI Cloud API messages: one JSON Schema per message in a directory per topic kind, the shared envelope, the generated examples, and `dji-methods.json`, the catalogue of DJI's methods |
| `wayline/openapi.yaml` | so-wayline's HTTP API: status, envelope, validations |
| `vendored.json` | Where the files came from: the repository, the commit, its `git describe` and date |
| `vendored.sha256` | The SHA-256 of every file, in `sha256sum`'s format: `sha256sum -c vendored.sha256` checks them |

Pinned at Sky Orchestrator's **v0.4.2** (2026-10-11). Like v0.4.1 it publishes
what SOC builds on: `simulate_mission` (`DEP-02`), the stack's status, envelope
and validations (`DEP-01`, `DEP-03`, `DEP-04`), the break reason (`DEP-05`), the
fake bridge image (`DEP-06`). It adds real flight behind two keys and a cleared
build (SO's ADR-0040), deadlines on start and resume with `319999` as an unknown
outcome (`DEP-27`), `media_count` (`DEP-13`) and `simulator_in_real_mode`. From
v0.4.1 only `/v1/status`'s `link.changed_at_ms` gained a description: when the
link became what it is, up or down. The wayline API stays 1.3.0 and no DJI wire
shape changed.

## Rules

- **Pinned by commit, not by `x-version`.** A schema's shape has changed upstream
  without its version moving, so only the bytes are trusted.
- **Never edited here.** `tools/vendor_sky_orchestrator.py --check` fails in the
  hooks and in CI on any byte that differs from `vendored.sha256`, any file missing,
  any file added by hand. The whitespace hooks skip this directory.
- **What is left out**: Sky Orchestrator's internal buses (`mqtt/internal/`) and
  its prose, whose links point into its own tree.
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
