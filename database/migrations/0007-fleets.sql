-- Sky Orchestrator stacks, the devices they announce, and the fleets registered
-- from them (IR-STK, IR-DEV, IR-FLE; FR-FLE-02, FR-FLE-03, FR-FLE-05, FR-LNK-02).
-- soc-cloud records what each stack reports through three functions; members
-- read their organization's; editors register, edit and retire fleets through
-- PostgREST under these policies (ADR-0006). Every change reaches the
-- organization's state topic (ADR-0007).

create type soc.link_state as enum ('connected', 'connecting', 'displaced', 'unreachable');

create table soc.stacks (
  gateway_sn      text primary key check (gateway_sn ~ '^[A-Za-z0-9]+$'),
  name            text not null check (name ~ '^[a-z][a-z0-9-]{0,30}$'),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  link_state      soc.link_state not null,
  status          jsonb check (status is null or jsonb_typeof(status) = 'object'),
  envelope        jsonb check (envelope is null or jsonb_typeof(envelope) = 'object'),
  updated_at      timestamptz not null default now(),
  unique (gateway_sn, organization_id)
);

create table soc.devices (
  gateway_sn       text not null references soc.stacks (gateway_sn) on delete cascade,
  aircraft_sn      text not null check (aircraft_sn ~ '^[A-Za-z0-9]+$'),
  domain           integer not null,
  type             integer not null,
  sub_type         integer not null,
  firmware_version text,
  online           boolean not null,
  first_seen_at    timestamptz not null default now(),
  last_seen_at     timestamptz not null default now(),
  primary key (gateway_sn, aircraft_sn)
);

-- The stack's organization is the fleet's: the composite key makes them one.
create table soc.fleets (
  id                       uuid primary key default gen_random_uuid(),
  organization_id          uuid not null,
  name                     text not null constraint fleet_name_given check (btrim(name) <> ''),
  model                    text not null references soc.aircraft_models (model),
  airframe_serial          text not null
                             constraint fleet_airframe_serial_given check (btrim(airframe_serial) <> ''),
  controller_serial        text,
  gateway_sn               text not null,
  aircraft_sn              text not null,
  flight_time_before_soc_s integer not null default 0 check (flight_time_before_soc_s >= 0),
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  deleted_at               timestamptz,
  foreign key (gateway_sn, organization_id)
    references soc.stacks (gateway_sn, organization_id) on delete cascade,
  foreign key (gateway_sn, aircraft_sn)
    references soc.devices (gateway_sn, aircraft_sn) on delete cascade
);

create unique index fleets_one_live_per_device on soc.fleets (gateway_sn, aircraft_sn)
  where deleted_at is null;
create index fleets_by_organization on soc.fleets (organization_id) where deleted_at is null;

-- FR-FLE-05: retiring is final and keeps the fleet as it was; the time is the
-- database's. The refusal to move the wire identity during an unfinished flight
-- arrives with the flights (M4).
create function soc.fleet_changes()
returns trigger
language plpgsql
set search_path = soc, pg_temp
as $$
begin
  if old.deleted_at is not null then
    raise exception 'fleet %: a retired fleet does not change', old.id
      using errcode = 'check_violation';
  end if;
  new.deleted_at := case when new.deleted_at is null then null else now() end;
  new.updated_at := now();
  return new;
end;
$$;

create trigger fleet_changes
  before update on soc.fleets
  for each row execute function soc.fleet_changes();

create function soc.fleet_is_registered_live()
returns trigger
language plpgsql
set search_path = soc, pg_temp
as $$
begin
  new.deleted_at := null;
  new.created_at := now();
  new.updated_at := now();
  return new;
end;
$$;

create trigger fleet_is_registered_live
  before insert on soc.fleets
  for each row execute function soc.fleet_is_registered_live();

-- soc-cloud's view of a stack: its name, its organization and its link.
create function soc.record_stack(
  gateway text, stack_name text, organization uuid, state soc.link_state
)
returns void
language sql
security definer
set search_path = soc, pg_temp
as $$
  insert into soc.stacks (gateway_sn, name, organization_id, link_state)
  values (gateway, stack_name, organization, state)
  on conflict (gateway_sn) do update set
    name = excluded.name,
    organization_id = excluded.organization_id,
    link_state = excluded.link_state,
    updated_at = now()
  where (soc.stacks.name, soc.stacks.organization_id, soc.stacks.link_state)
    is distinct from (excluded.name, excluded.organization_id, excluded.link_state);
$$;

-- FR-LNK-02: an aircraft is online only while its stack lists it and reports it
-- online. `announced` is [{aircraft_sn, domain, type, sub_type, online}]; a
-- device of this stack missing from it goes offline. Returns the online count.
create function soc.record_topology(gateway text, announced jsonb)
returns integer
language plpgsql
security definer
set search_path = soc, pg_temp
as $$
begin
  insert into soc.devices as device (gateway_sn, aircraft_sn, domain, type, sub_type, online)
  select gateway, entry->>'aircraft_sn', (entry->>'domain')::integer,
         (entry->>'type')::integer, (entry->>'sub_type')::integer,
         (entry->>'online')::boolean
  from jsonb_array_elements(announced) as entry
  on conflict (gateway_sn, aircraft_sn) do update set
    domain = excluded.domain,
    type = excluded.type,
    sub_type = excluded.sub_type,
    online = excluded.online,
    last_seen_at = now();

  update soc.devices set online = false
  where gateway_sn = gateway
    and online
    and aircraft_sn not in (
      select entry->>'aircraft_sn' from jsonb_array_elements(announced) as entry
    );

  return (select count(*) from soc.devices where gateway_sn = gateway and online);
end;
$$;

create function soc.record_firmware(gateway text, aircraft text, version text)
returns void
language sql
security definer
set search_path = soc, pg_temp
as $$
  update soc.devices set firmware_version = version
  where gateway_sn = gateway and aircraft_sn = aircraft
    and firmware_version is distinct from version;
$$;

-- Every change reaches the organization's state topic (ADR-0007).
create function soc.broadcast_stack()
returns trigger
language plpgsql
security definer
set search_path = soc, pg_temp
as $$
begin
  perform realtime.send(
    jsonb_build_object(
      'gateway_sn', new.gateway_sn,
      'name', new.name,
      'link_state', new.link_state,
      'updated_at', new.updated_at
    ),
    'stack',
    'org:' || new.organization_id || ':soc:state',
    true
  );
  return null;
end;
$$;

create trigger broadcast_stack
  after insert or update on soc.stacks
  for each row execute function soc.broadcast_stack();

create function soc.broadcast_device()
returns trigger
language plpgsql
security definer
set search_path = soc, pg_temp
as $$
begin
  perform realtime.send(
    jsonb_build_object(
      'gateway_sn', new.gateway_sn,
      'aircraft_sn', new.aircraft_sn,
      'online', new.online,
      'firmware_version', new.firmware_version,
      'last_seen_at', new.last_seen_at
    ),
    'device',
    'org:' || (select organization_id from soc.stacks where gateway_sn = new.gateway_sn)
      || ':soc:state',
    true
  );
  return null;
end;
$$;

create trigger broadcast_new_device
  after insert on soc.devices
  for each row execute function soc.broadcast_device();

create trigger broadcast_device_change
  after update on soc.devices
  for each row
  when (old.online is distinct from new.online
        or old.firmware_version is distinct from new.firmware_version)
  execute function soc.broadcast_device();

create function soc.broadcast_fleet()
returns trigger
language plpgsql
security definer
set search_path = soc, pg_temp
as $$
begin
  perform realtime.send(
    jsonb_build_object(
      'id', new.id,
      'name', new.name,
      'model', new.model,
      'gateway_sn', new.gateway_sn,
      'aircraft_sn', new.aircraft_sn,
      'updated_at', new.updated_at,
      'deleted_at', new.deleted_at
    ),
    'fleet',
    'org:' || new.organization_id || ':soc:state',
    true
  );
  return null;
end;
$$;

create trigger broadcast_fleet
  after insert or update on soc.fleets
  for each row execute function soc.broadcast_fleet();

alter table soc.stacks enable row level security;
alter table soc.devices enable row level security;
alter table soc.fleets enable row level security;

grant usage on type soc.link_state to authenticated, soc_cloud, soc_operations;

grant select on soc.stacks, soc.devices, soc.fleets to authenticated;
create policy members_read_their_stacks on soc.stacks
  for select to authenticated
  using ((select soc.is_live_member(organization_id)));
create policy members_read_their_devices on soc.devices
  for select to authenticated
  using (exists (
    select 1 from soc.stacks
    where stacks.gateway_sn = devices.gateway_sn
      and (select soc.is_live_member(stacks.organization_id))
  ));
create policy members_read_their_fleets on soc.fleets
  for select to authenticated
  using ((select soc.is_live_member(organization_id)));

-- FR-AUT-03: writes need editor or above.
grant insert (organization_id, name, model, airframe_serial, controller_serial,
              gateway_sn, aircraft_sn, flight_time_before_soc_s)
  on soc.fleets to authenticated;
grant update (name, model, airframe_serial, controller_serial, gateway_sn, aircraft_sn,
              flight_time_before_soc_s, deleted_at)
  on soc.fleets to authenticated;
create policy editors_register_fleets on soc.fleets
  for insert to authenticated
  with check ((select soc.has_live_role(organization_id, 'editor')));
create policy editors_change_fleets on soc.fleets
  for update to authenticated
  using ((select soc.has_live_role(organization_id, 'editor')))
  with check ((select soc.has_live_role(organization_id, 'editor')));

grant select on soc.stacks, soc.devices, soc.fleets to soc_cloud, soc_operations;
create policy services_read_stacks on soc.stacks
  for select to soc_cloud, soc_operations using (true);
create policy services_read_devices on soc.devices
  for select to soc_cloud, soc_operations using (true);
create policy services_read_fleets on soc.fleets
  for select to soc_cloud, soc_operations using (true);

revoke execute on function soc.record_stack(text, text, uuid, soc.link_state) from public;
revoke execute on function soc.record_topology(text, jsonb) from public;
revoke execute on function soc.record_firmware(text, text, text) from public;
grant execute on function soc.record_stack(text, text, uuid, soc.link_state) to soc_cloud;
grant execute on function soc.record_topology(text, jsonb) to soc_cloud;
grant execute on function soc.record_firmware(text, text, text) to soc_cloud;
