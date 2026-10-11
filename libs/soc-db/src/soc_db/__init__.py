"""A service's one direct Postgres connection, supervised (ADR-0006, ADR-0017).

    database = Database(target, listeners={"soc_intents": on_intent}, on_connected=sweep)
    async with asyncio.TaskGroup() as group:
        group.create_task(database.run())
        ...
    async with database.transaction() as connection:
        await connection.execute(...)

On every (re)connection it listens on every channel first, then calls
`on_connected`, so an intent committed while it was away is found by the sweep
and none is missed. Notifications reach their handler one at a time, in order.
Statements share the connection one at a time.
"""

from __future__ import annotations

from soc_db.database import Database, DatabaseUnavailableError, NotificationHandler, Target

__all__ = ["Database", "DatabaseUnavailableError", "NotificationHandler", "Target"]
