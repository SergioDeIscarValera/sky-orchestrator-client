# soc-config

A service's configuration file and environment, held to
[`contracts/config/soc-config.schema.json`](../../contracts/config/soc-config.schema.json)
at start ([ADR-0019](../../docs/architecture/decisions/0019-one-configuration-contract-no-fallbacks.md)).

- The file holds exactly the keys whose `x-consumers` name the service, all
  required. No default is applied, nothing is coerced, a key given twice or NaN
  is refused, and the relations in `x-constraints` must hold.
- The environment holds the variables `x-environment` names for the service,
  each checked by its rule, plus every secret the file names by variable
  (`password_env`, `token_env`). Secrets are wrapped so they never print.
- Every problem, file and environment together, is reported at once, and the
  service does not start (`FR-SAF-05`, `NFR-SEC-03`).

## Using it

```python
import soc_config

settings = soc_config.start("soc-cloud")  # raises ConfigurationError
values = settings.configuration.values  # the service converts its typed view
password = settings.environment.secret("SOC_DB_PASSWORD_SOC_CLOUD").reveal()
```

Log `settings.configuration.fingerprint` and `contract_version` at start.

```bash
uv run soc-config example soc-cloud > soc-cloud.json   # defaults, null where none
uv run soc-config check soc-cloud soc-cloud.json       # refusals, or the fingerprint
```

The contract is read from `contracts/` relative to the package source, where
both the repository and the images keep it.

## Tests

```bash
uv run --frozen mypy libs/soc-config
uv run --frozen pytest libs/soc-config/tests
```

The contract's own consistency (every key has consumers, a unit and a valid
default, every rule and relation is implemented); for every consumer, a
complete file loads and each key removed is named; every bound, both sides;
the strictness rules; the environment rules both ways; the start with file and
environment refused together.

## Failure modes

- A service's typed view drifting from its keys: caught by the per-service test
  `ADR-0019` requires, not by this library.
- The contract missing from an image: the start fails reading it, before any
  connection.
