# Database

Schema `soc` in Virtual Origen's database
([ADR-0005](../docs/architecture/decisions/0005-one-database-shared-with-virtual-origen.md)),
its migrations and their tests.

| Path | Contents |
| --- | --- |
| `migrations/` | Ordered SQL, `NNNN-kebab-name.sql`, applied by [`infra/migrate`](../infra/migrate/README.md) |
| `fixtures/` | What the tests need of the platform SOC does not own, reproduced faithfully (below) |
| `src/soc_database/` | The test harness: an ephemeral Postgres, tenancy helpers, acting as a user; `RealtimeStack`, Postgres and Realtime v2.102.3 on a private network with its tokens |
| `tests/` | The container lane (`NFR-TEST-02`) |

## What exists

| Migration | Creates |
| --- | --- |
| `0001-soc-schema` | Schema `soc`; `soc.live_member_orgs()`, `soc.is_live_member(org)`, `soc.has_live_role(org, role)`: Virtual Origen's membership helpers, plus the organization's own `deleted_at` |
| `0002-service-roles` | `soc_cloud` and `soc_operations`: login, `NOINHERIT`, three connections each, 5 s statement and 2 s lock timeouts, no password until the runner sets one |
| `0003-realtime-authorization` | Who may join SOC's private Broadcast topics `org:<id>:soc:<stream>`: members of that live organization; restrictive guards that keep SOC's topics member-only, refuse anonymous readers and every client send, and pass any other topic through |
| `0004-command-intents` | `soc.command_intents` (`IR-CMD`): announced to `soc-cloud` with `pg_notify('soc_command_intents', id)` at commit, broadcast on `org:<id>:soc:state` on every change, forward-only (`IR-CMD-01`); `soc-cloud` claims (or expires, past `command_intent_ttl_s`), records the reply, times out, or fails one through four functions; members read their organization's, `soc-operations` requests, nobody else writes |
| `0005-member-organizations` | `soc.member_organizations()`: the caller's live memberships of live organizations, with their role, the organization's position and time zone, by name; what the web offers at sign-in (`FR-AUT-02`). Security invoker, signed-in users only |
| `0006-aircraft-models` | `soc.aircraft_models` (`IR-MOD`): the catalogue of `contracts/catalogue`, each published figure with its source; `soc.load_aircraft_models(catalogue)` upserts and never removes, run only by migrations; every signed-in user reads it, nobody writes it |
| `0007-fleets` | `soc.stacks`, `soc.devices`, `soc.fleets` (`IR-STK`, `IR-DEV`, `IR-FLE`): `soc-cloud` records each stack's link and organization, the devices it announces (online only while listed and reported online, `FR-LNK-02`) and their firmware through three functions; a fleet is registered from a device its organization's stack has seen, by an editor, once among live fleets; retiring is final and timed by the database; every change broadcast on `org:<id>:soc:state` |

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
