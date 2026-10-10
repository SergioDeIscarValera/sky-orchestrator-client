# soc-supervision

Keep one link up: connect, serve until lost, back off, again (`NFR-REL-03`). The
database connection, the Realtime socket and each MQTT link run under it.

```python
supervisor = Supervisor(
    "realtime",
    connect=open_socket,  # returns the link, raises when refused
    serve=use_until_lost,  # returns or raises when the link is lost
    disconnect=close_socket,  # always called after serve
    transient=(OSError, TimeoutError),
)
await supervisor.run()
supervisor.health  # Health(up, since, error)
```

- A transient error, alone or inside an exception group, marks the link down and
  is retried after 0.5, 1, 2, 4, 8, then every 10 s. A successful connection
  resets the delay.
- Any other error ends `run()` after disconnecting: a bug is not retried in a
  loop, and the container restarts with the cause in its log.
- `health` holds whether the link is up, since when (monotonic seconds) and the
  last error, for the health endpoint (`NFR-OBS-02`). A change of state is one
  log line, `link_up` or `link_down`; the same error repeating is not.

## Tests

```bash
uv run --frozen mypy libs/soc-supervision
uv run --frozen pytest libs/soc-supervision/tests
```
