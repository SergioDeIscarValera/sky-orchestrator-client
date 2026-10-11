# ADR-0019 — One configuration contract, a file per service, no fallbacks

- **Status**: Accepted
- **Date**: 2026-10-10

## Context

SOC's services act on aircraft: a threshold read wrong, or silently defaulted,
is a check that passes when it should not. A missing or invalid safety setting
must stop the service at start, naming it, and every tunable must be declared
once with its unit, range and default.

Sky Orchestrator solved the same problem in its ADR-0019 (one schema, no
fallbacks): a JSON Schema contract annotated with `x-consumers`, `x-unit`,
`x-safety` and `x-constraints`; each component's file holds exactly its keys, all
required, with no default applied and no coercion; addresses, ports and secrets
come from the environment, each checked by a rule. It has run that way in its
services and on the phone since its M1.

SOC differs in two ways. It has a variable number of Sky Orchestrator stacks,
each with its own broker credential and API token. And `soc-web` reads some of
the same thresholds as the services.

## Decision

**`contracts/config/soc-config.schema.json` declares every key and every
environment variable, once.**

- Each key names its consumers (`soc-cloud`, `soc-operations`, `soc-web`), its
  unit, its range and, where one is safe, the default a new file starts from.
  A key with no default is a safety key: an organization, an address.
- Each service's file holds exactly the keys that name it, **all required, no
  default applied at load, no coercion**: `"3000"` is not 3000, `true` is not 1,
  `5.0` is not 5. A key given twice, NaN or Infinity is refused. Every problem
  is reported at once, and a refusal stops the start.
- Relations between keys (`x-constraints`) are worded in the contract and
  implemented once in `soc-config`, which a test holds equal to the wording.
- **`x-environment` declares the environment** each service reads, with a rule
  per variable (`host`, `port`, `secret`, ...). Secrets come only from the
  environment; the file names a stack's credentials by variable (`password_env`,
  `token_env`), which are then required and checked like the declared ones.
- A loaded file has a fingerprint, the SHA-256 of its canonical form, logged at
  start with the contract version, so what ran is known afterwards.
- `soc-config example <consumer>` prints a new file from the defaults, `null`
  where there is none, and `soc-config check` accepts or refuses one.

## Alternatives considered

**Defaults applied at load.** Shorter files, and a deployment whose thresholds
nobody wrote down; a key renamed in the contract would silently fall back.

**Environment variables for everything.** One mechanism, and no structure for a
list of stacks; typed, ranged thresholds become strings parsed in each service.

**A typed model as the source** (msgspec or pydantic generating the schema). One
language owns a contract that the web reads too.

## Consequences

- Adding a key for a service makes it required by that service the same day.
- Each service keeps only its typed view of the values; a test per service holds
  the view's fields equal to the keys the contract gives it (`FR-DEP-03`).
- Two services read `served_organizations`: their files must agree, which the
  stack check verifies.
- Operators edit JSON; the example command and the refusal messages carry them.
