# Broadcast payloads

What travels on SOC's private Realtime topics (ADR-0007), as JSON Schema. The
producer validates against them in its tests; the console reads them as typed.

| Topic | Event | Schema | Produced by |
| --- | --- | --- | --- |
| `org:<id>:soc:telemetry` | `sample` | [`telemetry.schema.json`](telemetry.schema.json), 1.0.0 | `soc-cloud`, at most `broadcast_max_rate_hz` per aircraft, the latest sample winning |
| `org:<id>:soc:state` | `stack`, `device`, `fleet`, `command_intent` | arrives with the console that reads them | The database's triggers (migrations `0004`, `0007`) |

Only members of the organization join its topics (migration `0003`); the
services send with the service role key.
