# Services

| Service | Owns | Arrives |
| --- | --- | --- |
| [`soc-cloud`](soc-cloud/README.md) | The DJI cloud party: one MQTT connection per Sky Orchestrator stack, topology and presence, telemetry fan-out and history, commands on the wire, answers to the dock's file requests, the flight file server, the cloud geofence | M1 |
| [`soc-operations`](soc-operations/README.md) | The operation lifecycle and its state machine, preflight checks, the simulation gate, flight file production | M1 |

Boundaries and the reason there are two:
[ADR-0002](../docs/architecture/decisions/0002-monorepo-and-service-boundaries.md).
Stack: [ADR-0017](../docs/architecture/decisions/0017-backend-stack.md).

Each service is an independent deploy unit with its own gate tests, Dockerfile,
configuration and README, including its **enumerated failure modes**
(`NFR-SAF-03`). Services never import each other; they meet in the database and
in `contracts/`.
