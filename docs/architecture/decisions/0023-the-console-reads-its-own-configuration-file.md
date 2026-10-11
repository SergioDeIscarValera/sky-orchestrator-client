# ADR-0023 — The console reads its own configuration file, checked before it starts

- **Status**: Accepted
- **Date**: 2026-10-11

## Context

ADR-0019 gives each consumer of the configuration contract a file holding
exactly its keys, all required, checked by `soc-config` before the consumer
starts. The contract names `soc-web` as the consumer of five keys: the
telemetry's stale and lost thresholds (`FR-TEL-02`), the geofence's warning band
and vertex limit, and the wayline's arc spacing. Until now nothing gave them to
the console. Its container wrote only the Supabase address and public key into
`/config.json`, and the contract gave `SOC_CONFIG_FILE` to the two Python
services only.

The thresholds are about safety. `soc-operations` raises the telemetry lost
alarm after `telemetry_lost_after_ms`; a console that drew a feed as current
past that point would contradict it. The console needs the same values the
services have, from the same kind of file, refused the same way.

The console's container serves static files from nginx on Alpine. It has no
Python, so `soc-config`, the contract's one implementation, cannot run inside
it.

## Decision

- **`soc-web` has a configuration file**, like every consumer. The contract
  gives it `SOC_CONFIG_FILE` (version 2.1.0), and `soc-config example soc-web`
  starts one.
- **A one-shot `soc-web-check` runs `soc-config check soc-web`** on the file
  before the console starts. It uses soc-cloud's image, which carries
  `soc-config`, and reaches no network. The console depends on it completing
  successfully, so a refused file keeps the console down. Its log names every
  problem.
- **The console's entrypoint refuses a file it cannot read** and embeds the file
  as it is in `/config.json`, under `settings`. In development Vite does the
  same.
- **The browser checks the file again**: the five keys with their types and
  ranges, and the relation between the two thresholds. A test holds that
  mirror equal to the contract. A file the browser refuses stops the console on
  the startup page, which names every key.

## Alternatives considered

**Defaults in the browser.** A deployment's thresholds would differ between the
console and the services without anyone having written them down. ADR-0019
rejected defaults applied at load for this reason.

**The thresholds in the database**, written by `soc-operations`, read by the
console through PostgREST. That keeps one copy at run time, but it adds a table,
a policy and a writer for five numbers. It also makes the console depend on
`soc-operations` having started.

**Validate in the console's entrypoint with `jq` or `njs`.** A second
implementation of the contract's rules, in shell or nginx JavaScript, tested
apart from the first.

**Only the browser's check.** It cannot see what `JSON.parse` erases: a key
given twice, `5.0` read as 5. `soc-config` refuses both.

## Consequences

- The deployment fills one more file, `soc-web.json`, next to soc-cloud's and
  soc-operations'.
- The stack's memory limits add 64 MB for a container that exits before the
  console starts: 448 MB of the 512 MB budget (`NFR-RES-05`).
- A key added for `soc-web` in the contract fails the mirror's test until the
  browser reads it too.
