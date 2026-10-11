# Contracts

The interfaces between SOC's units and with its neighbours, versioned. An
implementation follows its contract; a contract change is a version bump with
both sides updated in the same pull request (`NFR-MNT-02`).

| Path | Contract | Arrives |
| --- | --- | --- |
| [`config/`](config/soc-config.schema.json) | Every configuration key and environment variable: type, unit, range, default, the units that read it (ADR-0019) | M1, here, 2.1.0: each stack names its organization; the console reads its own file |
| [`broadcast/`](broadcast/README.md) | The payloads on the private Realtime topics `org:<id>:soc:telemetry` and `org:<id>:soc:state` | M2, here: telemetry 1.0.0; state with the console that reads it |
| [`sky-orchestrator/`](sky-orchestrator/README.md) | Sky Orchestrator's DJI schemas and examples and so-wayline's OpenAPI, vendored at a pinned commit with their hashes | M1, here, Sky Orchestrator v0.4.1 |
| `results/` | The meaning shown to the operator for every DJI result code SO can return | M4 |
| `events/` | The closed list of operation event kinds | M4 |
| [`catalogue/`](catalogue/README.md) | The aircraft models supported by Mobile SDK V4, with their sourced specifications | M2, here, 1.0.0 |
| `geometry/` | Golden vectors both languages reproduce, SO's geodesy cases included; the design schema | M3 |
| `wpml/` | The WPML profile SOC writes, inside SO's accepted subset | M3 |
