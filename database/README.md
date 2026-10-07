# Database

Schema `soc` in Virtual Origen's database
([ADR-0005](../docs/architecture/decisions/0005-one-database-shared-with-virtual-origen.md)).

| Path | Contents | Arrives |
| --- | --- | --- |
| `migrations/` | Ordered SQL migrations, applied by SOC's runner with its ledger in schema `soc_migrations` | M1 |
| `tests/` | Policy, RPC and migration tests against an ephemeral Postgres with Virtual Origen's contract surface loaded | M1 |
| `fixtures/` | The minimum of Virtual Origen's schema SOC depends on, for tests | M1 |

Rules every migration follows:

- Row-level security enabled explicitly on every table: Virtual Origen's trigger
  covers `public` only.
- Membership through `private.is_member`, `private.has_role` and
  `private.current_member_orgs`, plus the organization's own `deleted_at`.
- Nothing written to `public`.
- Security-definer functions fix `search_path = soc, public, private, pg_temp`
  and qualify every object.
- Soft deletes only; delete events never reach Realtime.
- No migration runs at the same time as one of Virtual Origen's.
