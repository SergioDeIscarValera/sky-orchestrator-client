-- Command intents (ADR-0006, IR-CMD): a row asks soc-cloud to put one DJI service
-- on the wire. It is announced to soc-cloud when it commits, claimed at most once,
-- expires instead of running late, moves forward only, and every change reaches
-- the organization's members on its state topic (ADR-0007).

create type soc.command_verb as enum (
  'prepare', 'execute', 'pause', 'recovery', 'return_home', 'undo'
);

create type soc.command_status as enum (
  'pending', 'sent', 'accepted', 'refused', 'failed', 'timed_out', 'expired'
);

create table soc.command_intents (
  id                uuid primary key default gen_random_uuid(),
  client_request_id uuid not null,
  organization_id   uuid not null references public.organizations (id) on delete cascade,
  operation_id      uuid not null,
  flight_id         uuid not null,
  gateway_sn        text not null check (gateway_sn ~ '^[A-Za-z0-9]+$'),
  verb              soc.command_verb not null,
  payload           jsonb not null default '{}' check (jsonb_typeof(payload) = 'object'),
  requested_by      uuid references public.profiles (id) on delete set null,
  requested_at      timestamptz not null default now(),
  status            soc.command_status not null default 'pending',
  request_meta      jsonb not null default '{}' check (jsonb_typeof(request_meta) = 'object'),
  result            integer,
  sent_at           timestamptz,
  replied_at        timestamptz,
  unique (organization_id, client_request_id),
  check ((sent_at is not null) = (status in ('sent', 'accepted', 'refused', 'timed_out'))),
  check ((replied_at is not null) = (status in ('accepted', 'refused'))),
  check ((result is not null) = (status in ('accepted', 'refused')))
);

create index command_intents_pending on soc.command_intents (requested_at)
  where status = 'pending';
create index command_intents_flight on soc.command_intents (flight_id);
create index command_intents_recent on soc.command_intents (organization_id, requested_at desc);

-- IR-CMD-01: pending → sent → accepted | refused | timed_out; pending → expired or
-- failed. What was asked never changes; who asked may only be forgotten, when
-- their profile is deleted.
create function soc.command_intent_moves_forward()
returns trigger
language plpgsql
set search_path = soc, pg_temp
as $$
begin
  if (new.id, new.client_request_id, new.organization_id, new.operation_id,
      new.flight_id, new.gateway_sn, new.verb, new.payload, new.requested_at,
      new.request_meta)
     is distinct from
     (old.id, old.client_request_id, old.organization_id, old.operation_id,
      old.flight_id, old.gateway_sn, old.verb, old.payload, old.requested_at,
      old.request_meta) then
    raise exception 'command intent %: what was asked never changes', old.id
      using errcode = 'check_violation';
  end if;
  if new.requested_by is distinct from old.requested_by and new.requested_by is not null then
    raise exception 'command intent %: who asked never changes', old.id
      using errcode = 'check_violation';
  end if;
  if new.status is distinct from old.status and not (
       (old.status = 'pending' and new.status in ('sent', 'expired', 'failed'))
    or (old.status = 'sent' and new.status in ('accepted', 'refused', 'timed_out'))
  ) then
    raise exception 'command intent %: % cannot become %', old.id, old.status, new.status
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger command_intent_moves_forward
  before update on soc.command_intents
  for each row execute function soc.command_intent_moves_forward();

-- Delivered to soc-cloud's LISTEN only if the inserting transaction commits.
create function soc.announce_command_intent()
returns trigger
language plpgsql
set search_path = soc, pg_temp
as $$
begin
  perform pg_notify('soc_command_intents', new.id::text);
  return null;
end;
$$;

create trigger announce_command_intent
  after insert on soc.command_intents
  for each row execute function soc.announce_command_intent();

-- Every insert and change to the members watching, at commit (ADR-0007).
create function soc.broadcast_command_intent()
returns trigger
language plpgsql
security definer
set search_path = soc, pg_temp
as $$
begin
  perform realtime.send(
    jsonb_build_object(
      'id', new.id,
      'operation_id', new.operation_id,
      'flight_id', new.flight_id,
      'verb', new.verb,
      'status', new.status,
      'result', new.result,
      'requested_by', new.requested_by,
      'requested_at', new.requested_at,
      'sent_at', new.sent_at,
      'replied_at', new.replied_at
    ),
    'command_intent',
    'org:' || new.organization_id || ':soc:state',
    true
  );
  return null;
end;
$$;

create trigger broadcast_command_intent
  after insert or update on soc.command_intents
  for each row execute function soc.broadcast_command_intent();

-- soc-cloud's verbs. Each is one conditional update: run twice, the second does
-- nothing and returns no row. The clock is the database's, so a late claim is
-- judged by the same clock that stamped the request.
create function soc.claim_command_intent(intent uuid, ttl_s integer)
returns setof soc.command_intents
language sql
set search_path = soc, pg_temp
as $$
  update soc.command_intents
     set status = case
                    when requested_at < now() - make_interval(secs => ttl_s)
                    then 'expired'::soc.command_status
                    else 'sent'::soc.command_status
                  end,
         sent_at = case
                     when requested_at < now() - make_interval(secs => ttl_s) then null
                     else now()
                   end
   where id = intent and status = 'pending'
  returning *;
$$;

create function soc.fail_command_intent(intent uuid)
returns setof soc.command_intents
language sql
set search_path = soc, pg_temp
as $$
  update soc.command_intents set status = 'failed'
   where id = intent and status = 'pending'
  returning *;
$$;

create function soc.record_command_reply(intent uuid, dji_result integer)
returns setof soc.command_intents
language sql
set search_path = soc, pg_temp
as $$
  update soc.command_intents
     set status = case when dji_result = 0 then 'accepted'::soc.command_status
                       else 'refused'::soc.command_status end,
         result = dji_result,
         replied_at = now()
   where id = intent and status = 'sent'
  returning *;
$$;

create function soc.time_out_command_intent(intent uuid)
returns setof soc.command_intents
language sql
set search_path = soc, pg_temp
as $$
  update soc.command_intents set status = 'timed_out'
   where id = intent and status = 'sent'
  returning *;
$$;

alter table soc.command_intents enable row level security;

grant usage on type soc.command_verb, soc.command_status to authenticated, soc_cloud, soc_operations;

grant select on soc.command_intents to authenticated;
create policy members_read_their_commands on soc.command_intents
  for select to authenticated
  using ((select soc.is_live_member(organization_id)));

grant select, update (status, result, sent_at, replied_at) on soc.command_intents to soc_cloud;
create policy soc_cloud_reads_commands on soc.command_intents
  for select to soc_cloud using (true);
create policy soc_cloud_records_commands on soc.command_intents
  for update to soc_cloud using (true) with check (true);

grant select, insert on soc.command_intents to soc_operations;
create policy soc_operations_reads_commands on soc.command_intents
  for select to soc_operations using (true);
create policy soc_operations_requests_commands on soc.command_intents
  for insert to soc_operations with check (status = 'pending');

revoke execute on function soc.claim_command_intent(uuid, integer) from public;
revoke execute on function soc.fail_command_intent(uuid) from public;
revoke execute on function soc.record_command_reply(uuid, integer) from public;
revoke execute on function soc.time_out_command_intent(uuid) from public;
grant execute on function soc.claim_command_intent(uuid, integer) to soc_cloud;
grant execute on function soc.fail_command_intent(uuid) to soc_cloud;
grant execute on function soc.record_command_reply(uuid, integer) to soc_cloud;
grant execute on function soc.time_out_command_intent(uuid) to soc_cloud;
