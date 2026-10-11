# soc-check

SOC's images and stack, built from the repository and run as the mini-PC runs
them: read-only, as user 10001, within their limits.

```bash
uv run --frozen mypy infra/check
uv run --frozen pytest infra/check/tests -m "not lane"   # gate: the helpers
uv run --frozen pytest infra/check/tests -m lane         # lane: builds and runs the images, needs Docker
```

On the container lane:

- every image runs as an unprivileged user;
- `soc-cloud` and `soc-operations` without their configuration refuse to start
  with status 2 and one `configuration_refused` line;
- the migration image applies the migrations once, then nothing;
- `soc-operations` comes up healthy on a read-only root within 60 s and stays
  under **64 MiB at rest** (`NFR-RES-04`): 37.9 MiB measured on 2026-10-10;
- `soc-web` refuses to start without its address and key, with the service role
  key or with an address that has a path, each named in one
  `configuration_refused` line that never repeats the key; once started it is
  healthy, serves `/config.json` uncached and the console with its headers
  (the policy connects only to its Supabase, no inline script or style,
  `frame-ancestors 'none'`, no-referrer, nosniff, no server version), caches the
  built files for good, falls back to the console on any route, and stays under
  **16 MiB at rest** (2.3 MiB measured on 2026-10-11); one image serves two
  addresses (`FR-DEP-04`);
- the compose project is valid with its example files.

The stack check against Sky Orchestrator's released images arrives here next;
it needs read access to SO's packages on GHCR.
