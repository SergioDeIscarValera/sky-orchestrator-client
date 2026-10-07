# ADR-0005 — One database shared with Virtual Origen, schema `soc`

- **Status**: Accepted
- **Date**: 2026-10-07

## Context

SOC's users are Virtual Origen's (VO2) users, and SOC works inside VO2's
organizations: an organization is a farm, with members, roles (`owner`, `editor`,
`viewer`), a position and a time zone. Since VO2's ADR 0052 (2026-09-05) a single
self-hosted Supabase on the mini-PC is VO2's only database: Postgres 17.6,
GoTrue v2.189 with ES256 tokens, PostgREST v14.12, Realtime v2.102.3, Storage
v1.60.4, behind Kong on the LAN and a Cloudflare Tunnel outside it.

Facts from VO2's maintainers on 2026-10-07 that shape the decision:

- Membership checks live in schema `private`: `is_member(org)`,
  `has_role(org, role)` and `current_member_orgs()`. `is_member` does not check
  whether the organization itself is soft-deleted.
- Deletion is soft (`deleted_at`); authenticated users hold no `DELETE`.
- VO2's migration runner keeps its ledger in `vo_migrations`, and the event
  trigger that enables row-level security automatically covers `public` only.
- The Realtime publication emits inserts and updates only, for the whole
  database.
- VO2 runs with no retries against its only database: load SOC puts on Postgres
  is load on a farm's control loop.

## Decision

**SOC lives in VO2's database, in its own schema `soc`, and treats a small part
of VO2's schema as a contract.**

- Read-only use of `public.organizations`, `public.memberships`,
  `public.profiles`, the `role` enum and the three `private` helpers, declared as
  a contract on VO2's side (VO2's ADR 0059, proposed) and held there by a gate
  test.
- **SOC never writes `public`.** Organizations and memberships are managed in
  VO2.
- Every `soc` table enables row-level security explicitly and checks membership
  through the helpers, plus the organization's own `deleted_at`, never through
  the existence of a foreign key.
- Security-definer functions fix `search_path = soc, public, private, pg_temp`
  and qualify every object anyway.
- SOC's own roles (the operators of an operation) live in `soc`, referencing
  `memberships(organization_id, profile_id)`. VO2's `role` enum is not extended.
- SOC's migrations are applied by SOC's runner, with its ledger in schema
  `soc_migrations`, which PostgREST does not expose. The two runners never run at
  the same time.
- PostgREST exposes `soc` through `PGRST_DB_SCHEMAS`, an environment setting on
  the mini-PC that VO2's releases preserve.

## Alternatives considered

**A second Supabase for SOC.** Clean isolation, but a different set of accounts
(or a single sign-on bridge to build), and a second stack of two to three
gigabytes on a mini-PC that already runs one.

**SOC tables in `public`.** Shared ownership of one namespace, collisions, and
VO2's MCP server, which reads `public`, would see SOC's data.

**Extending VO2's `role` enum with a pilot role.** It ripples through VO2's
helpers, web, invitation flow and MCP for a concept only SOC uses.

## Consequences

- Login, organizations and members come for free and stay consistent with VO2.
- Every SOC container has memory and CPU limits, connection pools stay small,
  and telemetry history is written in batches (`NFR-RES-*`).
- A VO2 release can restart Kong for a few seconds; every SOC client reconnects
  on its own (`NFR-REL-06`).
- VO2's lack of an offsite backup applies to SOC's records too (`RISK-08`).
- Delete events never arrive through Realtime; SOC deletes softly as VO2 does.
