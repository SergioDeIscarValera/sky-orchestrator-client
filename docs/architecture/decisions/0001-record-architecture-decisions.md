# ADR-0001 — Record architecture decisions

- **Status**: Accepted
- **Date**: 2026-10-07

## Context

Sky Orchestrator Client (SOC) is built across two languages, three deploy units,
one database schema it does not host, and two neighbouring projects it depends
on: Sky Orchestrator, which flies the aircraft, and Virtual Origen, which owns the
users, the organizations and the database. Most of the hard choices here are
forced by facts that live in those projects, not in this code: what the DJI wire
carries, what Sky Orchestrator refuses, what the shared database already does.

Six months from now the code will show what was decided. Nothing will show why,
or which alternatives were rejected and on what evidence, which is exactly what
is needed when a decision has to be revisited.

## Decision

Every decision that is expensive to reverse, or that would otherwise be
re-litigated, gets a numbered record in this directory before the code that
depends on it is written.

A decision qualifies if any of these hold:

- Two plausible designs exist and the requirements do not settle the choice.
- A constraint from Sky Orchestrator or Virtual Origen forces a design that
  would otherwise look wrong.
- Reversing it later means touching more than one deploy unit.
- Someone is likely to propose the alternative again.

Records are immutable. Changing course means a new record that supersedes the
old one.

## Consequences

- A small, permanent cost per decision.
- Requirements cite a rationale instead of repeating it.
- A change can be rejected by pointing at a record, and a record can be
  challenged on its own terms rather than in a diff.
