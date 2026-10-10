# soc-migrate

Applies [`database/migrations`](../../database/README.md) to schema `soc` in
Virtual Origen's database (`FR-DEP-02`).

```bash
SOC_MIGRATE_DSN=postgresql://postgres:…@db:5432/postgres \
SOC_DB_PASSWORD_SOC_CLOUD=… SOC_DB_PASSWORD_SOC_OPERATIONS=… \
  uv run --frozen soc-migrate            # apply, then set the service roles' passwords
uv run --frozen soc-migrate --dry-run    # applied and pending, nothing changed
```

It connects as `postgres`, the role Virtual Origen's own runner uses; secrets come
from the environment, never from arguments.

## What it does

1. Takes `pg_advisory_lock(hashtext('soc-migrations'))`, so two runs never
   overlap. Virtual Origen's runner takes no such lock: never run this during a
   Virtual Origen release.
2. Creates its ledger, `soc_migrations.applied`, in a schema PostgREST does not
   expose.
3. Plans: every applied migration must still exist with the same name and the
   same SHA-256; the ledger must have no gap. Anything else stops the run before
   it changes anything.
4. Applies each pending migration and its ledger row in one transaction.
5. Sets the passwords of `soc_cloud` and `soc_operations` as SCRAM-SHA-256
   verifiers computed here, so no plaintext password crosses the connection or
   reaches a log. A password must be at least 32 letters and digits.

## Failure modes

| Failure | What happens |
| --- | --- |
| A migration edited after it was applied | Refused, naming it; nothing changes. Write a new migration. |
| A migration fails | Its transaction rolls back with its ledger row; earlier migrations stay applied; the run exits 1. |
| The runner dies mid-migration | Postgres rolls the transaction back; the next run plans from the ledger. |
| Another run holds the lock | This run waits until it is released. |
| A password missing or weak | Refused before connecting, naming the variable. |
| Running beside a Virtual Origen release | Lock waits on the public tables SOC references; see step 1. |

## Tests

`tests/` are gate tests (`NFR-TEST-01`): discovery, planning and the SCRAM verifier
against one Postgres computed. The runner against a real database is tested in
the database lane, [`database/tests`](../../database/README.md).
