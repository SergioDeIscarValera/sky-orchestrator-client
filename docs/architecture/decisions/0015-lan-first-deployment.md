# ADR-0015 — LAN-first deployment on the mini-PC

- **Status**: Accepted
- **Date**: 2026-10-07

## Context

Flights happen at the farm, with the operator on site and the aircraft in sight.
The farm's internet connection drops. Sky Orchestrator's data path is LAN-only
by its own constraint, and Virtual Origen's database runs on the same mini-PC,
reachable through Kong on the LAN and through a Cloudflare Tunnel from outside.

Virtual Origen learnt two facts about serving a web application over plain HTTP
from a LAN address (its ADR 0032): APIs restricted to secure contexts, such as
`crypto.randomUUID` and service workers, do not exist there, and no test running
on `localhost` notices.

## Decision

- `soc-web` is served by an nginx container on the mini-PC and talks to Supabase
  through Kong on the LAN. **Nothing on the path from a click to an aircraft
  needs the internet**: web, database, services and SO are all on the mini-PC.
- The web uses no API restricted to secure contexts without a fallback, enforced
  by a lint rule and by an end-to-end check served from a LAN address.
- No service worker and no offline installation in the MVP: they need a secure
  context the LAN origin does not have.
- Remote access, through the tunnel or a hosted copy of the web, is post-MVP and
  needs its own record: it would put the internet on the path of a command.

## Alternatives considered

**The web hosted outside (as Virtual Origen's public web is) through the
tunnel.** Every telemetry message and every command would leave the farm and come
back, adding about 100 ms per request (Virtual Origen's measurement) and making
the internet a dependency of stopping an aircraft.

**HTTPS on the LAN with a local certificate authority.** It restores secure
contexts, but every operator device must trust that authority. Possible later;
not needed by anything in the MVP.

## Consequences

- An operator at the farm can fly with the internet down.
- GoTrue's allowed redirect URLs must include SOC's LAN origin, a step on the
  mini-PC.
- Watching a flight from outside the farm is not possible in the MVP.
