-- Who may join SOC's private Broadcast topics, org:<organization id>:soc:<stream>
-- (ADR-0007). Realtime checks these policies on realtime.messages when a client
-- joins; the service role bypasses them and is the only sender.
--
-- The restrictive guards keep SOC's topics member-only whatever permissive
-- policies exist on the table, and pass every other topic through untouched, so
-- they never stand in the way of Virtual Origen's own channels.

create policy soc_members_receive on realtime.messages
  as permissive
  for select
  to authenticated
  using (
    realtime.messages.extension = 'broadcast'
    and (select realtime.topic()) like 'org:%:soc:%'
    and split_part((select realtime.topic()), ':', 2) = any (
      select organization::text from unnest((select soc.live_member_orgs())) as organization
    )
  );

create policy soc_guard_receive on realtime.messages
  as restrictive
  for select
  to authenticated
  using (
    realtime.messages.topic not like 'org:%:soc:%'
    or split_part(realtime.messages.topic, ':', 2) = any (
      select organization::text from unnest((select soc.live_member_orgs())) as organization
    )
  );

create policy soc_guard_receive_anonymous on realtime.messages
  as restrictive
  for select
  to anon
  using (realtime.messages.topic not like 'org:%:soc:%');

create policy soc_guard_send on realtime.messages
  as restrictive
  for insert
  to anon, authenticated
  with check (realtime.messages.topic not like 'org:%:soc:%');
