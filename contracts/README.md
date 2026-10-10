# Contracts

The interfaces between SOC's units and with its neighbours, versioned. An
implementation follows its contract; a contract change is a version bump with
both sides updated in the same pull request (`NFR-MNT-02`).

| Path | Contract | Arrives |
| --- | --- | --- |
| [`config/`](config/soc-config.schema.json) | Every configuration key and environment variable: type, unit, range, default, the units that read it (ADR-0019) | M1, here, 1.0.0 |
| `broadcast/` | The payloads on the private Realtime topics `org:<id>:soc:telemetry` and `org:<id>:soc:state` | M1 |
| `sky-orchestrator/` | Sky Orchestrator's DJI schemas and examples, vendored at a pinned SO version with their hashes | M1 |
| `results/` | The meaning shown to the operator for every DJI result code SO can return | M1 |
| `events/` | The closed list of operation event kinds | M4 |
| `catalogue/` | The aircraft models supported by Mobile SDK V4, with their sourced specifications | M2 |
| `geometry/` | Golden vectors both languages reproduce, SO's geodesy cases included; the design schema | M3 |
| `wpml/` | The WPML profile SOC writes, inside SO's accepted subset | M3 |
