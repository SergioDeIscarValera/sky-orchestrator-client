# Database

Schema `soc` in Virtual Origen's database
([ADR-0005](../docs/architecture/decisions/0005-one-database-shared-with-virtual-origen.md)),
its migrations and their tests.

| Path | Contents |
| --- | --- |
| `migrations/` | Ordered SQL, `NNNN-kebab-name.sql`, applied by [`infra/migrate`](../infra/migrate/README.md) |
| `fixtures/` | What the tests need of the platform SOC does not own, reproduced faithfully (below) |
| `src/soc_database/` | The test harness: an ephemeral Postgres, tenancy helpers, acting as a user |
| `tests/` | The database lane (`NFR-TEST-02`) |

## What exists

| Migration | Creates |
| --- | --- |
| `0001-soc-schema` | Schema `soc`; `soc.live_member_orgs()`, `soc.is_live_member(org)`, `soc.has_live_role(org, role)`: Virtual Origen's membership helpers, plus the organization's own `deleted_at` |
| `0002-service-roles` | `soc_cloud` and `soc_operations`: login, `NOINHERIT`, three connections each, 5 s statement and 2 s lock timeouts, no password until the runner sets one |
| `0003-realtime-authorization` | Who may join SOC's private Broadcast topics `org:<id>:soc:<stream>`: members of that live organization; restrictive guards that keep SOC's topics member-only, refuse anonymous readers and every client send, and pass any other topic through |

## Rules every migration follows

- Row-level security enabled explicitly on every table: Virtual Origen's trigger
  covers `public` only.
- Membership through `soc.*` helpers, never through the existence of a foreign
  key: soft-deleted memberships stay in the table.
- A foreign key to `public.memberships` is `ON DELETE CASCADE`: Virtual Origen
  deletes users and organizations by cascade, and SOC must not block it.
- Nothing written to `public`.
- Security-definer functions fix `search_path = soc, public, private, pg_temp` and
  qualify every object.
- Restrictive policies pass every topic or row that is not SOC's through.
- Soft deletes only; delete events never reach Realtime.
- Never applied while a Virtual Origen release is migrating.

## The fixtures

The tests run against the production images, `supabase/postgres:17.6.1.136`, with
what the other parts of the platform would have created loaded first. Each
generated fixture names the image digests it came from.

| Fixture | What | Source |
| --- | --- | --- |
| `auth-functions.sql` | `auth.uid()`, `role()`, `email()`, `jwt()` as GoTrue v2.189.0 leaves them: they read the JSON claims PostgREST sets, which the image's own versions do not | `generate-auth-functions.sh`, a throwaway GoTrue migrating a throwaway Postgres |
| `realtime-schema.sql` | The `realtime` schema as Realtime v2.102.3 creates it, with the role that owns `realtime.messages` and its grant to `postgres` | `generate-realtime-schema.sh`, a throwaway Realtime migrating a throwaway Postgres |
| `vo2-contract.sql` | Virtual Origen's identity and tenancy surface (VO2's ADR 0059, proposed), loaded as `postgres` as VO2's own runner creates it | Hand-copied from VO2's migrations at `ad7d36a`, each object's source named |

A generator runs only when the platform's versions change; its output is
committed and reviewed like code.

## Running

```bash
uv sync --frozen --all-packages
uv run --frozen pytest database/tests        # needs Docker; about ten seconds
```

The harness starts its own container on a random loopback port and removes it;
it never touches a running Supabase.
