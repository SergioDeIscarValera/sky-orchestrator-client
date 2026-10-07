# ADR-0006 — The web talks to Supabase directly, and commands are intents

- **Status**: Accepted
- **Date**: 2026-10-07

## Context

The web edits fleets, geofences, waylines and operations, asks for operation
transitions that need backend work (build a flight file, prepare, execute), and
sends commands to aircraft in flight (pause, resume, return home). Viewers must
never command, every command must be attributable afterwards, and a pause must
reach the wire within `NFR-PERF-02`'s 300 ms at p95.

Virtual Origen solved the same shape with its ADRs 0003 and 0011: the web reads
and writes Supabase directly under row-level security, and an action on hardware
is a row of intent the backend executes and annotates. Its backend learns of new
intents through Realtime postgres changes.

Read in Realtime v2.102.3's source, the version on the mini-PC: the postgres
changes poller waits 500 ms between polls when idle and runs on one thread per
tenant, shared with Virtual Origen. Supabase's published p95 for postgres changes
is 184 to 618 ms at 500 clients. That path alone can spend the whole command
budget.

## Decision

**No backend HTTP API for the browser.** The web reads and writes schema `soc`
through PostgREST, under row-level security.

**Anything with an effect outside the database is an intent, created by an RPC
that notifies its executor in the same transaction.**

- The web calls a security-definer RPC. It checks the caller's role in the
  organization and, for flight commands, that the caller is a pilot of that
  operation; inserts one intent row with an idempotency key from the browser; and
  calls `pg_notify` with the row's id. Postgres delivers the notification only if
  the transaction commits.
- The executing service holds one direct connection to Postgres on which it
  `LISTEN`s. On every (re)connection it listens first, then sweeps the pending
  intents, so nothing committed while it was away is missed.
- Claiming an intent is one conditional update (`pending` to `sent`), so an
  intent runs at most once. An intent older than `command_intent_ttl_s` when
  claimed is marked `expired` instead: a pause that arrives a minute late must
  not run.
- The executor records the outcome on the row: `accepted`, `refused`, `failed`,
  `timed_out`, with DJI's result code. A trigger broadcasts each change to the
  organization's private channel (ADR-0007), so every browser watching sees it.

| Intent | Created by | Executed by |
| --- | --- | --- |
| Operation transition (prepare checks, simulate, launch, finish) | A member, through an RPC | `soc-operations` |
| Wire command (prepare, execute, pause, recovery, return home, undo) | `soc-operations`, or a pilot for in-flight verbs | `soc-cloud` |

## Alternatives considered

**Intent rows picked up through Realtime postgres changes**, as Virtual Origen
does. The same durability, and up to half a second of idle polling in front of
every command, on a poller shared with the farm.

**An HTTP API on `soc-cloud` with Supabase JWT verification.** Tens of
milliseconds faster than a notification, and a second authorization surface to
keep equal to the row-level security, a port on the LAN, and no record unless
written anyway.

**Commands as Realtime Broadcast from the browser.** Fast, but nothing durable,
no sender identity in the message, and an authorization checked once per join.

## Consequences

- One authorization model, the database's, for reads, writes and commands.
- A command survives a restart of its executor, runs at most once, and expires
  rather than running late.
- Every command names who asked for it, when, from which session, and what DJI
  answered.
- Each service keeps one direct Postgres connection with a least-privilege role
  (ADR-0017), on Virtual Origen's network.
- Command latency is measured from the rows themselves: requested, sent,
  replied (`NFR-OBS-04`).
