# soc-realtime

Realtime Broadcast on private channels, from the backend
([ADR-0007](../../docs/architecture/decisions/0007-live-telemetry-over-realtime-broadcast.md),
[ADR-0017](../../docs/architecture/decisions/0017-backend-stack.md)): SOC's own
Phoenix client on `websockets`, and Realtime's HTTP batch endpoint on `aiohttp`
for when the socket is down.

```python
endpoint = Endpoint("http://kong:8000/realtime/v1", service_role_key)
socket = RealtimeSocket(endpoint, [f"org:{org}:soc:telemetry", f"org:{org}:soc:state"])
broadcaster = Broadcaster(socket, HttpBroadcast(endpoint, http_session))

group.create_task(socket.run())
route = await broadcaster.send([Message(f"org:{org}:soc:telemetry", "sample", sample)])
```

- **The socket** speaks Phoenix protocol 1.0.0 (JSON objects), which Realtime
  v2.102.3 serves and realtime-js 2.117 still supports. It joins every topic as
  a private channel with the service role key as the access token, beats every
  25 s, and runs under `soc-supervision`: a close, a heartbeat reply missing for
  10 s, or `phx_error`/`phx_close` on a joined topic replaces it and joins every
  topic again.
- **The HTTP fallback** posts a batch to `/api/broadcast` (through the gateway,
  `/realtime/v1/api/broadcast`), private, with the key as `apikey` and bearer.
  A refusal or an unreachable endpoint is logged and reported, never raised:
  live telemetry is best effort, and the console shows its age.
- **The broadcaster** sends on the socket while the topic is joined and through
  HTTP otherwise, and counts each route (`socket`, `http`, `dropped`), the
  numbers `NFR-RES-07` and `NFR-OBS-04` are logged from.
- `Endpoint(base, key)` takes the gateway's `…/realtime/v1` or Realtime's own
  `…/socket`, and derives both URLs as realtime-js does. The key never prints.
- `soc_realtime.testing.FakePhoenix` is the fake server the tests use, shipped
  for the tests of the services that broadcast.

## Tests

```bash
uv run --frozen mypy libs/soc-realtime
uv run --frozen pytest libs/soc-realtime/tests -m "not lane"   # gate
uv run --frozen pytest libs/soc-realtime/tests -m lane         # lane, needs Docker
```

The gate, against the fake server: URLs, join frames, broadcast frames, refused
joins, replacement on close, on a missed heartbeat and on a failed channel,
frames that are not SOC's ignored; against a local HTTP server: the batch, a
refusal, an unreachable endpoint; the broadcaster's routes and counts.

The lane, against Realtime v2.102.3 and the production Postgres image with SOC's
migrations (`soc_database.realtime.RealtimeStack`): a member receives what the
service sends by socket, by HTTP and by `realtime.send()` from SQL once its
transaction commits; a stranger, a member of a deleted organization and an
anonymous client are refused; a member's own send is dropped; the socket joins
again after Realtime restarts. `soc_realtime.testing.Subscriber` plays the
member's browser.

A message sent with `realtime.send()` reaches members with Realtime's message
`id` added to its payload; the web ignores it.

## Failure modes

- A message sent on a socket that dies in the same instant is lost; the next
  goes through HTTP until the socket is back.
- Realtime counts sends and deliveries against the tenant's
  `max_events_per_second`, shared with Virtual Origen: coalescing per aircraft
  (`broadcast_max_rate_hz`) is the caller's job, before this library.
- Only the box shows VO2's tenant settings, its ES256 keys and the latency: the
  M1 viability session measures them (`DEP-23`).
