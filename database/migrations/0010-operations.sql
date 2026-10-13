-- Operations (M4; IR-OPS, IR-ASG, IR-OPR, IR-FIL, IR-FLT, IR-FST, IR-EVT, IR-TEL, IR-TRQ;
-- FR-OPS, FR-CMD, FR-LOG, FR-SAF; ADR-0006, ADR-0010, ADR-0011, ADR-0025).
--
-- An operation flies waylines with fleets inside one geofence. Members define it and
-- ask it to move (transition requests); soc-operations moves it, through the only
-- moves contracts/operations/lifecycle.json allows, each written to its append-only
-- log in the same transaction. soc-cloud records what the stacks report: each
-- aircraft's latest sample, each stack's status and envelope, each flight's progress,
-- and the dry runs of flight files; soc-operations evaluates the preflight checks from
-- that record (ADR-0025). Every change reaches the organization's members on its state
-- topic at commit (ADR-0007), and each executor is announced its work by pg_notify.

-- --- Types ------------------------------------------------------------------------

create type soc.operation_state as enum (
  'draft', 'planned', 'preparing', 'simulating', 'simulated', 'ready', 'launching',
  'in_flight', 'paused', 'returning', 'completed', 'aborted', 'failed', 'cancelled'
);

create type soc.end_reason as enum (
  'completed', 'operator_stop', 'operator_return', 'geofence_breach', 'envelope_breach',
  'low_battery', 'link_lost', 'pilot_takeover', 'aircraft_fault', 'cancelled'
);

create type soc.operator_role as enum ('pilot', 'observer');
create type soc.flight_mode as enum ('simulated', 'real');
create type soc.flight_status as enum (
  'sent', 'in_progress', 'paused', 'ok', 'failed', 'canceled', 'rejected', 'timeout',
  'partially_done'
);
create type soc.event_severity as enum ('info', 'warning', 'error', 'safety');
create type soc.event_source as enum ('operator', 'soc-operations', 'soc-cloud', 'aircraft');
create type soc.transition as enum (
  'plan', 'prepare', 'unprepare', 'simulate', 'launch', 'stop', 'cancel'
);
create type soc.request_status as enum ('pending', 'running', 'accepted', 'refused', 'failed', 'expired');
create type soc.check_state as enum ('pass', 'fail', 'unknown');
create type soc.dry_run_status as enum ('pending', 'valid', 'rejected', 'failed');

-- --- The lifecycle (contracts/operations/lifecycle.json) ---------------------------

create table soc.operation_moves (
  from_state soc.operation_state not null,
  to_state   soc.operation_state not null,
  primary key (from_state, to_state)
);

insert into soc.operation_moves (from_state, to_state) values
  ('draft', 'planned'), ('draft', 'cancelled'),
  ('planned', 'preparing'), ('planned', 'cancelled'),
  ('preparing', 'planned'), ('preparing', 'simulating'), ('preparing', 'cancelled'),
  ('simulating', 'simulated'), ('simulating', 'preparing'),
  ('simulated', 'ready'), ('simulated', 'planned'), ('simulated', 'cancelled'),
  ('ready', 'simulated'), ('ready', 'launching'), ('ready', 'planned'), ('ready', 'cancelled'),
  ('launching', 'in_flight'), ('launching', 'ready'), ('launching', 'failed'),
  ('in_flight', 'paused'), ('in_flight', 'returning'),
  ('paused', 'in_flight'), ('paused', 'returning'),
  ('returning', 'completed'), ('returning', 'aborted'), ('returning', 'failed');

create function soc.is_terminal(state soc.operation_state)
returns boolean
language sql
immutable
as $$
  select state in ('completed', 'aborted', 'failed', 'cancelled');
$$;

-- IR-OPS-02: while a flight of it is prepared or flown, and once it is closed, what the
-- operation flies is fixed; an edit while preparing, simulated or ready puts it back to
-- planned instead (FR-OPS-07).
create function soc.is_frozen(state soc.operation_state)
returns boolean
language sql
immutable
as $$
  select state in ('simulating', 'launching', 'in_flight', 'paused', 'returning',
                   'completed', 'aborted', 'failed', 'cancelled');
$$;

-- --- Event kinds (contracts/events/events.json) -------------------------------------

create table soc.event_kinds (
  kind     text primary key,
  severity soc.event_severity not null,
  sources  soc.event_source[] not null,
  payload  text[] not null
);

insert into soc.event_kinds (kind, severity, sources, payload) values
  ('operation_created', 'info', array['operator']::soc.event_source[], array['name']::text[]),
  ('operation_state_changed', 'info', array['operator', 'soc-operations', 'soc-cloud']::soc.event_source[], array['from', 'to', 'cause']::text[]),
  ('operation_definition_changed', 'info', array['operator', 'soc-operations']::soc.event_source[], array['what']::text[]),
  ('transition_requested', 'info', array['operator']::soc.event_source[], array['transition']::text[]),
  ('transition_refused', 'warning', array['soc-operations']::soc.event_source[], array['transition', 'reasons']::text[]),
  ('checks_at_simulation', 'info', array['soc-operations']::soc.event_source[], array['checks']::text[]),
  ('checks_at_launch', 'info', array['soc-operations']::soc.event_source[], array['checks']::text[]),
  ('flight_prepared', 'info', array['soc-operations']::soc.event_source[], array['mode', 'md5']::text[]),
  ('flight_status_changed', 'info', array['soc-cloud']::soc.event_source[], array['status', 'percent', 'result']::text[]),
  ('flight_ended', 'info', array['soc-operations']::soc.event_source[], array['status', 'result', 'end_reason']::text[]),
  ('took_off', 'info', array['aircraft']::soc.event_source[], array['mode_code']::text[]),
  ('automatic_return', 'warning', array['aircraft']::soc.event_source[], array['mode_code']::text[]),
  ('landed', 'info', array['aircraft']::soc.event_source[], array['mode_code']::text[]),
  ('command_requested', 'info', array['operator', 'soc-operations', 'soc-cloud']::soc.event_source[], array['verb']::text[]),
  ('command_outcome', 'info', array['soc-cloud']::soc.event_source[], array['verb', 'status', 'result']::text[]),
  ('geofence_warning', 'warning', array['soc-cloud']::soc.event_source[], array['position', 'height_m', 'distance_to_boundary_m']::text[]),
  ('geofence_breach', 'safety', array['soc-cloud']::soc.event_source[], array['position', 'height_m', 'distance_outside_m', 'sampled_at']::text[]),
  ('telemetry_stale', 'safety', array['soc-cloud']::soc.event_source[], array['last_sampled_at']::text[]),
  ('telemetry_fresh', 'info', array['soc-cloud']::soc.event_source[], array['sampled_at']::text[]),
  ('fleet_offline', 'warning', array['soc-cloud']::soc.event_source[], array['aircraft_sn']::text[]),
  ('fleet_online', 'info', array['soc-cloud']::soc.event_source[], array['aircraft_sn']::text[]);

-- --- Same-organization keys on what an operation names -------------------------------

alter table soc.geofences add constraint geofences_id_organization unique (id, organization_id);
alter table soc.waylines add constraint waylines_id_organization unique (id, organization_id);
alter table soc.fleets add constraint fleets_id_organization unique (id, organization_id);

-- --- Operations, assignments, operators (IR-OPS, IR-ASG, IR-OPR) ---------------------

create table soc.operations (
  id                        uuid primary key default gen_random_uuid(),
  organization_id           uuid not null references public.organizations (id) on delete cascade,
  name                      text not null constraint operation_name_given check (btrim(name) <> ''),
  geofence_id               uuid,
  takeoff_security_height_m numeric constraint operation_height_positive
                              check (takeoff_security_height_m is null or takeoff_security_height_m > 0),
  state                     soc.operation_state not null default 'draft',
  end_reason                soc.end_reason,
  created_by                uuid references public.profiles (id) on delete set null,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  started_at                timestamptz,
  ended_at                  timestamptz,
  unique (id, organization_id),
  foreign key (geofence_id, organization_id) references soc.geofences (id, organization_id),
  constraint operation_ends_with_a_reason check (
    soc.is_terminal(state) = (ended_at is not null and end_reason is not null)
  )
);

create index operations_by_organization on soc.operations (organization_id, created_at desc);

create table soc.assignments (
  id              uuid primary key default gen_random_uuid(),
  operation_id    uuid not null,
  organization_id uuid not null,
  wayline_id      uuid not null,
  fleet_id        uuid not null,
  speed_ms        numeric constraint assignment_speed_positive check (speed_ms is null or speed_ms > 0),
  -- The wayline as this operation flies it (contracts/geometry/design.schema.json,
  -- $defs.flight): made by the console, the only generator (ADR-0009), from the
  -- wayline's bake, the operation's height, this speed and the stack's envelope;
  -- validated by soc-operations, which builds the flight file from it.
  flight          jsonb constraint assignment_flight_object
                    check (flight is null or jsonb_typeof(flight) = 'object'),
  created_at      timestamptz not null default now(),
  unique (id, organization_id),
  foreign key (operation_id, organization_id) references soc.operations (id, organization_id)
    on delete cascade,
  foreign key (wayline_id, organization_id) references soc.waylines (id, organization_id),
  foreign key (fleet_id, organization_id) references soc.fleets (id, organization_id),
  constraint assignment_wayline_once unique (operation_id, wayline_id),
  constraint assignment_fleet_once unique (operation_id, fleet_id)
);

create index assignments_by_wayline on soc.assignments (wayline_id);
create index assignments_by_fleet on soc.assignments (fleet_id);

create table soc.operators (
  operation_id    uuid not null,
  organization_id uuid not null,
  profile_id      uuid not null,
  role            soc.operator_role not null,
  primary key (operation_id, profile_id),
  foreign key (operation_id, organization_id) references soc.operations (id, organization_id)
    on delete cascade,
  foreign key (organization_id, profile_id)
    references public.memberships (organization_id, profile_id) on delete cascade
);

-- --- Flight files, flights and their progress (IR-FIL, IR-FLT, IR-FST) ---------------

-- IR-FIL-01: the bytes are kept as built and never rebuilt; md5 and size are the
-- bytes' own, checked here. The token is the serving path's secret (ADR-0008, NFR-SEC-06):
-- 128 random bits as soc-cloud serves them, 32 lower-case hexadecimal characters.
create table soc.flight_files (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  operation_id    uuid not null,
  wayline_id      uuid not null,
  bytes           bytea not null,
  md5             text not null constraint flight_file_md5_of_bytes check (md5 = md5(bytes)),
  size_bytes      integer not null
                    constraint flight_file_size_of_bytes check (size_bytes = octet_length(bytes)),
  profile_version text not null constraint flight_file_profile_given check (btrim(profile_version) <> ''),
  token           text not null unique
                    constraint flight_file_token_unguessable check (token ~ '^[0-9a-f]{32}$'),
  created_at      timestamptz not null default now(),
  unique (id, organization_id),
  foreign key (operation_id, organization_id) references soc.operations (id, organization_id)
    on delete cascade,
  foreign key (wayline_id, organization_id) references soc.waylines (id, organization_id)
);

create table soc.flights (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null,
  operation_id       uuid not null,
  assignment_id      uuid not null,
  fleet_id           uuid not null,
  gateway_sn         text not null check (gateway_sn ~ '^[A-Za-z0-9]+$'),
  aircraft_sn        text not null check (aircraft_sn ~ '^[A-Za-z0-9]+$'),
  mode               soc.flight_mode not null,
  file_id            uuid not null,
  geofence_snapshot  jsonb not null constraint flight_geofence_snapshot check (
                       jsonb_typeof(geofence_snapshot) = 'object'
                       and soc.is_ring(geofence_snapshot -> 'polygon')
                       and jsonb_typeof(geofence_snapshot -> 'max_height_m') is not distinct from 'number'
                     ),
  envelope_snapshot  jsonb not null
                       constraint flight_envelope_snapshot check (jsonb_typeof(envelope_snapshot) = 'object'),
  config_fingerprint text,
  prepared_at        timestamptz not null default now(),
  executed_at        timestamptz,
  took_off_at        timestamptz,
  landed_at          timestamptz,
  -- When soc-cloud sent its return home on a geofence breach, once per flight (FR-SAF-01).
  breached_at        timestamptz,
  ended_at           timestamptz,
  end_reason         soc.end_reason,
  unique (id, organization_id),
  foreign key (operation_id, organization_id) references soc.operations (id, organization_id)
    on delete cascade,
  foreign key (assignment_id, organization_id) references soc.assignments (id, organization_id),
  foreign key (fleet_id, organization_id) references soc.fleets (id, organization_id),
  foreign key (file_id, organization_id) references soc.flight_files (id, organization_id)
    on delete cascade,
  constraint flight_ends_with_a_reason check ((ended_at is null) = (end_reason is null))
);

create index flights_by_operation on soc.flights (operation_id, prepared_at desc);
create index flights_unended_by_aircraft on soc.flights (aircraft_sn) where ended_at is null;

create table soc.flight_states (
  flight_id              uuid primary key references soc.flights (id) on delete cascade,
  organization_id        uuid not null,
  status                 soc.flight_status not null,
  result                 integer,
  percent                integer check (percent is null or percent between 0 and 100),
  current_waypoint_index integer check (current_waypoint_index is null or current_waypoint_index >= 0),
  break_point            jsonb check (break_point is null or jsonb_typeof(break_point) = 'object'),
  -- How the task ended, once it has, as soc-cloud reads it: from DJI's result and break
  -- reason, and from the returns it sent itself (a geofence breach, FR-SAF-01).
  end_reason             soc.end_reason,
  updated_at             timestamptz not null default now(),
  constraint flight_state_ends_when_finished check (
    end_reason is null
    or status in ('ok', 'failed', 'canceled', 'rejected', 'timeout', 'partially_done')
  )
);

-- The command intents of 0004 name operations and flights that exist from here on.
alter table soc.command_intents
  add constraint command_intent_operation foreign key (operation_id) references soc.operations (id)
    on delete cascade,
  add constraint command_intent_flight foreign key (flight_id) references soc.flights (id)
    on delete cascade;

-- --- The log (IR-EVT, FR-LOG-01) -----------------------------------------------------

-- No key to profiles: the log is never changed, not even to forget who acted.
create table soc.operation_events (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  operation_id    uuid not null references soc.operations (id) on delete cascade,
  flight_id       uuid references soc.flights (id) on delete cascade,
  fleet_id        uuid,
  command_id      uuid references soc.command_intents (id) on delete cascade,
  occurred_at     timestamptz not null,
  recorded_at     timestamptz not null default clock_timestamp(),
  kind            text not null references soc.event_kinds (kind),
  severity        soc.event_severity not null,
  source          soc.event_source not null,
  actor_id        uuid,
  payload         jsonb not null default '{}'
                    constraint operation_event_payload_object check (jsonb_typeof(payload) = 'object')
);

create index operation_events_by_operation on soc.operation_events (operation_id, recorded_at);
create index operation_events_safety on soc.operation_events (organization_id, recorded_at)
  where severity = 'safety';

-- FR-LOG-01: appended, never changed nor removed, by any role. The one way a log goes
-- is with its organization, once Virtual Origen has erased it: its cascade reaches here
-- with the organization already gone, and SOC never blocks it.
create function soc.operation_event_is_kept()
returns trigger
language plpgsql
set search_path = soc, pg_temp
as $$
begin
  if tg_op = 'DELETE' and not exists (
    select 1 from public.organizations where id = old.organization_id
  ) then
    return old;
  end if;
  raise exception 'the operation log is append-only: % refused', tg_op
    using errcode = 'insufficient_privilege';
end;
$$;

create trigger operation_event_is_kept
  before update or delete on soc.operation_events
  for each row execute function soc.operation_event_is_kept();
create trigger operation_events_are_kept
  before truncate on soc.operation_events
  for each statement execute function soc.operation_event_is_kept();

-- IR-OPS-02: an organization erased takes its operations, their flights and their log. Its
-- cascade reaches the waylines, fleets and geofences before the operations that name them,
-- so the first of those it removes takes the organization's operations first; otherwise
-- they would still name what is being removed. Removed while its organization lives, a
-- wayline, fleet or geofence an operation names is refused by the key, as before.
create function soc.organization_erased_takes_operations()
returns trigger
language plpgsql
security definer
set search_path = soc, pg_temp
as $$
begin
  if not exists (select 1 from public.organizations where id = old.organization_id) then
    delete from soc.operations where organization_id = old.organization_id;
  end if;
  return old;
end;
$$;

create trigger organization_erased_takes_operations
  before delete on soc.waylines
  for each row execute function soc.organization_erased_takes_operations();
create trigger organization_erased_takes_operations
  before delete on soc.fleets
  for each row execute function soc.organization_erased_takes_operations();
create trigger organization_erased_takes_operations
  before delete on soc.geofences
  for each row execute function soc.organization_erased_takes_operations();

-- IR-EVT-01, IR-EVT-02: an entry is what the contract lists for its kind: a source it
-- names, every payload key it names, and its severity, which a writer may raise (a
-- refused command is logged as a warning) but never lower; safety is only a safety
-- kind's, and a safety kind's only.
create function soc.operation_event_severity()
returns trigger
language plpgsql
set search_path = soc, pg_temp
as $$
declare
  listed soc.event_severity;
  allowed soc.event_source[];
  keys text[];
begin
  select severity, sources, payload into listed, allowed, keys
    from soc.event_kinds where kind = new.kind;
  if not found then
    return new;
  end if;
  if not new.source = any (allowed) then
    raise exception 'event %: % is not one of its sources', new.kind, new.source
      using errcode = 'check_violation', constraint = 'operation_event_source_listed';
  end if;
  if not new.payload ?& keys then
    raise exception 'event %: its payload lacks one of %', new.kind, keys
      using errcode = 'check_violation', constraint = 'operation_event_payload_keys';
  end if;
  if array_position(enum_range(null::soc.event_severity), new.severity)
     < array_position(enum_range(null::soc.event_severity), listed) then
    raise exception 'event %: % is below its severity, %', new.kind, new.severity, listed
      using errcode = 'check_violation', constraint = 'operation_event_severity_floor';
  end if;
  if new.severity = 'safety' and listed <> 'safety' then
    raise exception 'event %: safety is reserved for safety events', new.kind
      using errcode = 'check_violation', constraint = 'operation_event_safety_reserved';
  end if;
  if listed = 'safety' and new.severity <> 'safety' then
    raise exception 'event %: is a safety event', new.kind
      using errcode = 'check_violation', constraint = 'operation_event_safety_reserved';
  end if;
  return new;
end;
$$;

create trigger operation_event_severity
  before insert on soc.operation_events
  for each row execute function soc.operation_event_severity();

-- The one way to append, for the definer functions below and both services. A kind
-- outside the list fails on its key; an operation that does not exist fails here.
-- FR-OPS-10: a closed operation's record takes nothing more. Its log takes only the
-- entry of the move that closed it, written while that move is under way.
create function soc.is_open(operation uuid)
returns boolean
language sql
stable
security definer
set search_path = soc, pg_temp
as $$
  select exists (
    select 1 from soc.operations o
     where o.id = operation
       and (not soc.is_terminal(o.state)
            or current_setting('soc.moving_operation', true) = operation::text)
  );
$$;

create function soc.log_event(
  operation uuid,
  event_kind text,
  event_source soc.event_source,
  event_payload jsonb default '{}',
  actor uuid default null,
  flight uuid default null,
  fleet uuid default null,
  command uuid default null,
  occurred timestamptz default null,
  event_severity soc.event_severity default null
)
returns soc.operation_events
language plpgsql
security definer
set search_path = soc, pg_temp
as $$
declare
  logged soc.operation_events;
begin
  if not exists (select 1 from soc.operations where id = operation) then
    raise exception 'operation % does not exist', operation using errcode = 'no_data_found';
  end if;
  if not soc.is_open(operation) then
    raise exception 'operation %: closed, its log takes nothing more', operation
      using errcode = 'check_violation', constraint = 'operation_closed';
  end if;
  insert into soc.operation_events (
    organization_id, operation_id, flight_id, fleet_id, command_id, occurred_at, kind,
    severity, source, actor_id, payload
  )
  select o.organization_id, o.id, flight, fleet, command, coalesce(occurred, clock_timestamp()),
         event_kind,
         coalesce(event_severity, (select k.severity from soc.event_kinds k where k.kind = event_kind),
                  'info'),
         event_source, actor, coalesce(event_payload, '{}')
    from soc.operations o
   where o.id = operation
  returning * into logged;
  if not found then
    raise exception 'operation % does not exist', operation using errcode = 'no_data_found';
  end if;
  return logged;
end;
$$;

-- --- Telemetry history and the latest sample (IR-TEL, ADR-0025) ----------------------

create table soc.telemetry_samples (
  flight_id           uuid not null references soc.flights (id) on delete cascade,
  sampled_at          timestamptz not null,
  organization_id     uuid not null,
  fleet_id            uuid not null,
  received_at         timestamptz not null,
  longitude           double precision not null,
  latitude            double precision not null,
  height_m            real not null,
  heading_deg         real,
  horizontal_speed_ms real,
  vertical_speed_ms   real,
  pitch_deg           real,
  roll_deg            real,
  battery_pct         smallint,
  satellites          smallint,
  gps_quality         smallint,
  mode_code           smallint,
  home_distance_m     real,
  primary key (flight_id, sampled_at)
);

create index telemetry_samples_time on soc.telemetry_samples using brin (sampled_at);

-- The latest sample of each aircraft, as broadcast (contracts/broadcast/telemetry.schema.json),
-- kept so soc-operations judges the checks on what the console shows (ADR-0025).
create table soc.aircraft_samples (
  aircraft_sn     text primary key check (aircraft_sn ~ '^[A-Za-z0-9]+$'),
  gateway_sn      text not null references soc.stacks (gateway_sn) on delete cascade,
  organization_id uuid not null,
  sample          jsonb not null constraint aircraft_sample_object check (jsonb_typeof(sample) = 'object'),
  sampled_at      timestamptz not null,
  received_at     timestamptz not null
);

-- --- Checks, dry runs, transition requests (FR-OPS-05, FR-LNK-09, IR-TRQ) -------------

create table soc.operation_checks (
  operation_id    uuid not null references soc.operations (id) on delete cascade,
  organization_id uuid not null,
  check_id        text not null constraint operation_check_named check (check_id ~ '^PF-[A-Z-]+$'),
  state           soc.check_state not null,
  blocking        boolean not null,
  value           jsonb,
  detail          text,
  evaluated_at    timestamptz not null,
  primary key (operation_id, check_id)
);

create table soc.dry_runs (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  file_id         uuid not null,
  gateway_sn      text not null references soc.stacks (gateway_sn) on delete cascade,
  status          soc.dry_run_status not null default 'pending',
  verdict         jsonb check (verdict is null or jsonb_typeof(verdict) = 'object'),
  requested_at    timestamptz not null default now(),
  judged_at       timestamptz,
  foreign key (file_id, organization_id) references soc.flight_files (id, organization_id)
    on delete cascade,
  check ((status = 'pending') = (judged_at is null))
);

create index dry_runs_by_file on soc.dry_runs (file_id, gateway_sn, requested_at desc);

create table soc.transition_requests (
  id                uuid primary key default gen_random_uuid(),
  client_request_id uuid not null,
  organization_id   uuid not null,
  operation_id      uuid not null,
  transition        soc.transition not null,
  requested_by      uuid references public.profiles (id) on delete set null,
  requested_at      timestamptz not null default now(),
  request_meta      jsonb not null default '{}' check (jsonb_typeof(request_meta) = 'object'),
  status            soc.request_status not null default 'pending',
  reasons           jsonb check (reasons is null or jsonb_typeof(reasons) = 'array'),
  decided_at        timestamptz,
  unique (organization_id, client_request_id),
  foreign key (operation_id, organization_id) references soc.operations (id, organization_id)
    on delete cascade,
  check ((decided_at is not null) = (status in ('accepted', 'refused', 'failed', 'expired'))),
  check ((reasons is not null) = (status in ('refused', 'failed')))
);

create index transition_requests_pending on soc.transition_requests (requested_at)
  where status in ('pending', 'running');

-- --- The state machine (FR-OPS-02, IR-OPS-01) ----------------------------------------

-- The one way an operation's state moves: a listed move, its log entry written in the
-- same transaction. Granted to soc-operations; the triggers below call it too.
create function soc.move_operation(
  operation uuid,
  to_state soc.operation_state,
  cause text,
  event_source soc.event_source,
  actor uuid default null,
  reason soc.end_reason default null
)
returns soc.operations
language plpgsql
security definer
set search_path = soc, pg_temp
as $$
declare
  current soc.operations;
  moved soc.operations;
begin
  select * into current from soc.operations where id = operation for update;
  if not found then
    raise exception 'operation % does not exist', operation using errcode = 'no_data_found';
  end if;
  if not exists (
    select 1 from soc.operation_moves m
     where m.from_state = current.state and m.to_state = move_operation.to_state
  ) then
    raise exception 'operation %: % cannot become %', operation, current.state, to_state
      using errcode = 'check_violation', constraint = 'operation_moves_by_the_lifecycle';
  end if;
  perform set_config('soc.moving_operation', operation::text, true);
  update soc.operations
     set state = to_state,
         end_reason = case
                        when soc.is_terminal(to_state) then coalesce(
                          reason,
                          case to_state when 'completed' then 'completed'::soc.end_reason
                                        when 'cancelled' then 'cancelled'::soc.end_reason end)
                      end,
         ended_at = case when soc.is_terminal(to_state) then now() end,
         started_at = case when to_state = 'launching' then coalesce(started_at, now()) else started_at end,
         updated_at = now()
   where id = operation
  returning * into moved;
  perform soc.log_event(
    operation, 'operation_state_changed', event_source,
    jsonb_build_object('from', current.state, 'to', to_state, 'cause', cause)
      || case when moved.end_reason is null then '{}'::jsonb
              else jsonb_build_object('end_reason', moved.end_reason) end,
    actor
  );
  perform set_config('soc.moving_operation', '', true);
  return moved;
end;
$$;

-- What an editor may change, and what it does to the operation (FR-OPS-07, IR-OPS-02):
-- a change to what flies puts a preparing, simulated or ready operation back to
-- planned, its readiness gone with its file; from simulating on, nothing changes.
create function soc.definition_changed(operation uuid, what text, actor uuid)
returns void
language plpgsql
security definer
set search_path = soc, pg_temp
as $$
declare
  current soc.operation_state;
begin
  select state into current from soc.operations where id = operation for update;
  if not found then
    return;
  end if;
  if soc.is_terminal(current) then
    raise exception 'operation %: closed when it became %', operation, current
      using errcode = 'check_violation', constraint = 'operation_closed';
  end if;
  if soc.is_frozen(current) then
    raise exception 'operation %: its definition is fixed once it is %', operation, current
      using errcode = 'check_violation', constraint = 'operation_definition_frozen';
  end if;
  perform soc.log_event(operation, 'operation_definition_changed',
                        case when actor is null then 'soc-operations' else 'operator' end::soc.event_source,
                        jsonb_build_object('what', what), actor);
  if current in ('preparing', 'simulated', 'ready') then
    perform soc.move_operation(operation, 'planned', what || '_changed',
                               case when actor is null then 'soc-operations' else 'operator' end::soc.event_source,
                               actor);
  end if;
end;
$$;

create function soc.operation_changes()
returns trigger
language plpgsql
set search_path = soc, pg_temp
as $$
begin
  if new.id is distinct from old.id or new.organization_id is distinct from old.organization_id
     or (new.created_by is distinct from old.created_by and new.created_by is not null)
     or new.created_at is distinct from old.created_at then
    raise exception 'operation %: who made it, where and when never change', old.id
      using errcode = 'check_violation';
  end if;
  if (new.state, new.end_reason, new.started_at, new.ended_at)
     is distinct from (old.state, old.end_reason, old.started_at, old.ended_at)
     and current_setting('soc.moving_operation', true) is distinct from old.id::text then
    raise exception 'operation %: its state moves only by soc.move_operation', old.id
      using errcode = 'insufficient_privilege';
  end if;
  -- Virtual Origen deleting a profile forgets who made the operation, closed or not.
  if (new.*) is not distinct from (old.*) or (
       new.created_by is null and old.created_by is not null
       and (new.name, new.geofence_id, new.takeoff_security_height_m, new.state)
           is not distinct from (old.name, old.geofence_id, old.takeoff_security_height_m, old.state)
     ) then
    return new;
  end if;
  if soc.is_terminal(old.state) then
    raise exception 'operation %: closed when it became %', old.id, old.state
      using errcode = 'check_violation', constraint = 'operation_closed';
  end if;
  if (new.geofence_id, new.takeoff_security_height_m)
     is distinct from (old.geofence_id, old.takeoff_security_height_m) then
    if soc.is_frozen(old.state) then
      raise exception 'operation %: its definition is fixed once it is %', old.id, old.state
        using errcode = 'check_violation', constraint = 'operation_definition_frozen';
    end if;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create trigger operation_changes
  before update on soc.operations
  for each row execute function soc.operation_changes();

-- After the row: a geofence or height changed in a preparing, simulated or ready
-- operation puts it back to planned (FR-OPS-07).
create function soc.operation_definition_follows()
returns trigger
language plpgsql
security definer
set search_path = soc, pg_temp
as $$
begin
  if (new.geofence_id, new.takeoff_security_height_m)
     is distinct from (old.geofence_id, old.takeoff_security_height_m) then
    perform soc.definition_changed(new.id,
      case when new.geofence_id is distinct from old.geofence_id then 'geofence' else 'height' end,
      auth.uid());
  end if;
  return null;
end;
$$;

create trigger operation_definition_follows
  after update on soc.operations
  for each row execute function soc.operation_definition_follows();

-- A new operation starts as a draft, made by whoever inserts it, at the database's time.
create function soc.operation_starts_as_draft()
returns trigger
language plpgsql
set search_path = soc, pg_temp
as $$
begin
  new.state := 'draft';
  new.end_reason := null;
  new.started_at := null;
  new.ended_at := null;
  new.created_by := auth.uid();
  new.created_at := now();
  new.updated_at := now();
  return new;
end;
$$;

create trigger operation_starts_as_draft
  before insert on soc.operations
  for each row execute function soc.operation_starts_as_draft();

create function soc.operation_is_logged()
returns trigger
language plpgsql
security definer
set search_path = soc, pg_temp
as $$
begin
  perform soc.log_event(new.id, 'operation_created', 'operator',
                        jsonb_build_object('name', new.name), new.created_by);
  return null;
end;
$$;

create trigger operation_is_logged
  after insert on soc.operations
  for each row execute function soc.operation_is_logged();

-- FR-OPS-01: one assignment per operation in the MVP (FR-OPS-12 lifts it); what an
-- assignment names may change only while the operation's definition may.
create function soc.assignment_changes()
returns trigger
language plpgsql
security definer
set search_path = soc, pg_temp
as $$
declare
  operation uuid := coalesce(new.operation_id, old.operation_id);
begin
  if tg_op = 'INSERT' and exists (
    select 1 from soc.assignments where operation_id = new.operation_id
  ) then
    raise exception 'operation %: one assignment in the MVP', new.operation_id
      using errcode = 'check_violation', constraint = 'assignment_one_in_mvp';
  end if;
  if tg_op = 'UPDATE' and (new.id, new.operation_id, new.organization_id)
     is distinct from (old.id, old.operation_id, old.organization_id) then
    raise exception 'assignment %: it stays with its operation', old.id
      using errcode = 'check_violation';
  end if;
  perform soc.definition_changed(operation, 'assignment', auth.uid());
  return coalesce(new, old);
end;
$$;

create trigger assignment_changes
  before insert or update or delete on soc.assignments
  for each row execute function soc.assignment_changes();

-- Operators may change until the operation flies; who pilots never changes what flies.
create function soc.operator_changes()
returns trigger
language plpgsql
security definer
set search_path = soc, public, pg_temp
as $$
declare
  current soc.operation_state;
  operation uuid := coalesce(new.operation_id, old.operation_id);
begin
  -- A membership Virtual Origen removed takes its operators with it, whatever the state.
  if tg_op = 'DELETE' and not exists (
    select 1 from public.memberships
     where organization_id = old.organization_id and profile_id = old.profile_id
  ) then
    return old;
  end if;
  select state into current from soc.operations where id = operation;
  if not found then
    return coalesce(new, old);
  end if;
  if soc.is_terminal(current) then
    raise exception 'operation %: closed when it became %', operation, current
      using errcode = 'check_violation', constraint = 'operation_closed';
  end if;
  if current in ('launching', 'in_flight', 'paused', 'returning') then
    raise exception 'operation %: its operators are fixed once it is %', operation, current
      using errcode = 'check_violation', constraint = 'operation_definition_frozen';
  end if;
  if tg_op <> 'DELETE' and not exists (
    select 1 from public.memberships m
      join public.organizations o on o.id = m.organization_id
     where m.organization_id = new.organization_id and m.profile_id = new.profile_id
       and m.deleted_at is null and o.deleted_at is null
  ) then
    raise exception 'operation %: an operator is a live member of its organization', operation
      using errcode = 'check_violation', constraint = 'operator_live_member';
  end if;
  return coalesce(new, old);
end;
$$;

create trigger operator_changes
  before insert or update or delete on soc.operators
  for each row execute function soc.operator_changes();

-- What an operation names changing under it: a wayline, a geofence or a fleet edited
-- puts the operations that would fly it back to planned (FR-OPS-07). One in the air
-- flies its own file and snapshot, untouched.
create function soc.dependents_follow()
returns trigger
language plpgsql
security definer
set search_path = soc, pg_temp
as $$
declare
  operation uuid;
  what text := case tg_table_name when 'waylines' then 'wayline'
                                  when 'geofences' then 'geofence'
                                  else 'fleet' end;
  flying uuid;
begin
  -- While a flight of it is prepared from its file, what it names stays as it is.
  select o.id into flying
    from soc.operations o
    left join soc.assignments a on a.operation_id = o.id
   where o.state in ('simulating', 'launching')
     and case tg_table_name
           when 'waylines' then a.wayline_id = new.id
           when 'geofences' then o.geofence_id = new.id
           else a.fleet_id = new.id
         end
   limit 1;
  if found then
    raise exception 'the % is fixed while operation % prepares a flight of it', what, flying
      using errcode = 'check_violation', constraint = 'operation_definition_frozen';
  end if;
  for operation in
    select distinct o.id
      from soc.operations o
      left join soc.assignments a on a.operation_id = o.id
     where o.state in ('preparing', 'simulated', 'ready')
       and case tg_table_name
             when 'waylines' then a.wayline_id = new.id
             when 'geofences' then o.geofence_id = new.id
             else a.fleet_id = new.id
           end
  loop
    perform soc.definition_changed(operation, what, auth.uid());
  end loop;
  return null;
end;
$$;

create trigger wayline_dependents_follow
  after update on soc.waylines
  for each row when ((old.takeoff, old.default_height_m, old.design, old.waypoints, old.deleted_at)
                     is distinct from (new.takeoff, new.default_height_m, new.design, new.waypoints, new.deleted_at))
  execute function soc.dependents_follow();
create trigger geofence_dependents_follow
  after update on soc.geofences
  for each row when ((old.polygon, old.max_height_m, old.deleted_at)
                     is distinct from (new.polygon, new.max_height_m, new.deleted_at))
  execute function soc.dependents_follow();
create trigger fleet_dependents_follow
  after update on soc.fleets
  for each row when ((old.model, old.gateway_sn, old.aircraft_sn, old.deleted_at)
                     is distinct from (new.model, new.gateway_sn, new.aircraft_sn, new.deleted_at))
  execute function soc.dependents_follow();

-- FR-FLE-05's last part: a fleet's wire identity never moves while it has an unended flight.
create function soc.fleet_keeps_identity_in_flight()
returns trigger
language plpgsql
set search_path = soc, pg_temp
as $$
begin
  if (new.gateway_sn, new.aircraft_sn) is distinct from (old.gateway_sn, old.aircraft_sn)
     and exists (select 1 from soc.flights where fleet_id = old.id and ended_at is null) then
    raise exception 'fleet %: its aircraft is flying', old.id
      using errcode = 'check_violation', constraint = 'fleet_identity_in_flight';
  end if;
  return new;
end;
$$;

create trigger fleet_keeps_identity_in_flight
  before update on soc.fleets
  for each row execute function soc.fleet_keeps_identity_in_flight();

create function soc.operation_takes_no_more()
returns trigger
language plpgsql
security definer
set search_path = soc, pg_temp
as $$
declare
  operation uuid;
begin
  -- Each branch names only its own table's columns: PL/pgSQL resolves them when run.
  if tg_table_name = 'dry_runs' then
    select operation_id into operation from soc.flight_files where id = new.file_id;
  else
    operation := new.operation_id;
  end if;
  if not soc.is_open(operation) then
    raise exception 'operation %: closed, it takes no new %', operation, tg_table_name
      using errcode = 'check_violation', constraint = 'operation_closed';
  end if;
  return new;
end;
$$;

create trigger flight_needs_an_open_operation
  before insert on soc.flights
  for each row execute function soc.operation_takes_no_more();
create trigger flight_file_needs_an_open_operation
  before insert on soc.flight_files
  for each row execute function soc.operation_takes_no_more();
create trigger dry_run_needs_an_open_operation
  before insert on soc.dry_runs
  for each row execute function soc.operation_takes_no_more();
create trigger check_needs_an_open_operation
  before insert or update on soc.operation_checks
  for each row execute function soc.operation_takes_no_more();
create trigger request_needs_an_open_operation
  before insert on soc.transition_requests
  for each row execute function soc.operation_takes_no_more();

-- --- Transition requests (ADR-0006, IR-TRQ) ------------------------------------------

-- A member asks an operation to move. Plan, prepare, unprepare and cancel need editor
-- or above; simulate, launch and stop need a pilot of the operation who is an editor
-- or above (FR-CMD-01). The same client request id gives back the same request.
create function soc.request_transition(
  operation uuid,
  wanted soc.transition,
  client_request uuid,
  meta jsonb default '{}'
)
returns soc.transition_requests
language plpgsql
security definer
set search_path = soc, public, pg_temp
as $$
declare
  target soc.operations;
  asked soc.transition_requests;
  me uuid := auth.uid();
begin
  select * into target from soc.operations where id = operation;
  if not found or not soc.has_live_role(target.organization_id, 'editor') then
    raise exception 'operation %: an editor of its organization asks it to move', operation
      using errcode = 'insufficient_privilege';
  end if;
  if soc.is_terminal(target.state) then
    raise exception 'operation %: closed when it became %', operation, target.state
      using errcode = 'check_violation', constraint = 'operation_closed';
  end if;
  if wanted in ('simulate', 'launch', 'stop') and not exists (
    select 1 from soc.operators
     where operation_id = operation and profile_id = me and role = 'pilot'
  ) then
    raise exception 'operation %: only its pilots %', operation, wanted
      using errcode = 'insufficient_privilege';
  end if;
  select * into asked from soc.transition_requests
   where organization_id = target.organization_id and client_request_id = client_request;
  if found then
    return asked;
  end if;
  insert into soc.transition_requests (
    client_request_id, organization_id, operation_id, transition, requested_by, request_meta
  ) values (client_request, target.organization_id, operation, wanted, me, coalesce(meta, '{}'))
  returning * into asked;
  perform soc.log_event(operation, 'transition_requested', 'operator',
                        jsonb_build_object('transition', wanted, 'request', asked.id), me);
  return asked;
end;
$$;

create function soc.announce_transition_request()
returns trigger
language plpgsql
set search_path = soc, pg_temp
as $$
begin
  perform pg_notify('soc_transition_requests', new.id::text);
  return null;
end;
$$;

create trigger announce_transition_request
  after insert on soc.transition_requests
  for each row execute function soc.announce_transition_request();

-- A request moves forward only: pending → running → accepted | refused | failed;
-- pending → expired. What was asked never changes.
create function soc.transition_request_moves_forward()
returns trigger
language plpgsql
set search_path = soc, pg_temp
as $$
begin
  if (new.id, new.client_request_id, new.organization_id, new.operation_id, new.transition,
      new.requested_at, new.request_meta)
     is distinct from
     (old.id, old.client_request_id, old.organization_id, old.operation_id, old.transition,
      old.requested_at, old.request_meta)
     or (new.requested_by is distinct from old.requested_by and new.requested_by is not null) then
    raise exception 'transition request %: what was asked never changes', old.id
      using errcode = 'check_violation';
  end if;
  if new.status is distinct from old.status and not (
       (old.status = 'pending' and new.status in ('running', 'expired'))
    or (old.status = 'running' and new.status in ('accepted', 'refused', 'failed'))
  ) then
    raise exception 'transition request %: % cannot become %', old.id, old.status, new.status
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger transition_request_moves_forward
  before update on soc.transition_requests
  for each row execute function soc.transition_request_moves_forward();

-- soc-operations' verbs, each one conditional update judged by the database's clock.
create function soc.claim_transition_request(request uuid, ttl_s integer)
returns setof soc.transition_requests
language sql
set search_path = soc, pg_temp
as $$
  update soc.transition_requests
     set status = case when requested_at < now() - make_interval(secs => ttl_s)
                       then 'expired'::soc.request_status else 'running'::soc.request_status end,
         decided_at = case when requested_at < now() - make_interval(secs => ttl_s)
                           then now() end
   where id = request and status = 'pending'
  returning *;
$$;

create function soc.decide_transition_request(request uuid, outcome soc.request_status, why jsonb)
returns setof soc.transition_requests
language plpgsql
security definer
set search_path = soc, pg_temp
as $$
declare
  decided soc.transition_requests;
begin
  update soc.transition_requests
     set status = outcome,
         reasons = case when outcome in ('refused', 'failed') then coalesce(why, '[]'::jsonb) end,
         decided_at = now()
   where id = request and status = 'running'
  returning * into decided;
  if not found then
    return;
  end if;
  if outcome in ('refused', 'failed') and soc.is_open(decided.operation_id) then
    perform soc.log_event(decided.operation_id, 'transition_refused', 'soc-operations',
                          jsonb_build_object('transition', decided.transition,
                                             'request', decided.id,
                                             'reasons', decided.reasons),
                          null, null, null, null, null,
                          case when outcome = 'failed' then 'error'::soc.event_severity end);
  end if;
  return next decided;
end;
$$;

-- --- The organization's members, to name operators (FR-OPS-01, IR-OPR) --------------

-- Who an operation can name as its pilots and observers: the organization's live
-- members, with their role, to a member of that organization only.
create function soc.organization_members(organization uuid)
returns table (profile_id uuid, display_name text, email text, role public.role)
language sql
stable
security definer
set search_path = soc, public, pg_temp
as $$
  select m.profile_id, p.display_name, p.email::text, m.role
    from public.memberships m
    join public.profiles p on p.id = m.profile_id
   where m.organization_id = organization
     and m.deleted_at is null
     and p.deleted_at is null
     and soc.is_live_member(organization)
   order by coalesce(p.display_name, p.email::text);
$$;

-- FR-OPS-03, FR-CMD-01: how many of an operation's pilots can command, live members
-- with editor or above; for soc-operations, which reads no Virtual Origen table itself.
create function soc.commanding_pilots(operation uuid)
returns integer
language sql
stable
security definer
set search_path = soc, public, pg_temp
as $$
  select count(*)::integer
    from soc.operators p
    join public.memberships m
      on m.organization_id = p.organization_id and m.profile_id = p.profile_id
    join public.organizations o on o.id = p.organization_id
    join public.profiles f on f.id = p.profile_id
   where p.operation_id = operation and p.role = 'pilot'
     and m.deleted_at is null and o.deleted_at is null and f.deleted_at is null
     and m.role in ('owner', 'editor');
$$;

-- --- Pilots' commands (FR-CMD-01 to FR-CMD-05) ---------------------------------------

-- A pilot of the operation who is an editor or above commands its aircraft in flight.
-- The DJI data is built here, never taken from the browser.
create function soc.request_command(
  flight uuid,
  wanted soc.command_verb,
  client_request uuid,
  meta jsonb default '{}'
)
returns soc.command_intents
language plpgsql
security definer
set search_path = soc, public, pg_temp
as $$
declare
  target soc.flights;
  asked soc.command_intents;
  me uuid := auth.uid();
begin
  if wanted not in ('pause', 'recovery', 'return_home', 'undo') then
    raise exception 'a pilot asks pause, recovery, return_home or undo, not %', wanted
      using errcode = 'invalid_parameter_value';
  end if;
  select * into target from soc.flights where id = flight;
  if not found or not soc.has_live_role(target.organization_id, 'editor') or not exists (
    select 1 from soc.operators
     where operation_id = target.operation_id and profile_id = me and role = 'pilot'
  ) then
    raise exception 'flight %: only a pilot of its operation commands it', flight
      using errcode = 'insufficient_privilege';
  end if;
  if target.ended_at is not null then
    raise exception 'flight %: it has ended', flight
      using errcode = 'check_violation', constraint = 'command_flight_ended';
  end if;
  select * into asked from soc.command_intents
   where organization_id = target.organization_id and client_request_id = client_request;
  if found then
    return asked;
  end if;
  insert into soc.command_intents (
    client_request_id, organization_id, operation_id, flight_id, gateway_sn, verb, payload,
    requested_by, request_meta
  ) values (
    client_request, target.organization_id, target.operation_id, target.id, target.gateway_sn,
    wanted,
    case wanted when 'undo' then jsonb_build_object('flight_ids', jsonb_build_array(target.id::text))
                else '{}'::jsonb end,
    me, coalesce(meta, '{}')
  )
  returning * into asked;
  return asked;
end;
$$;

-- FR-CMD-06, FR-LOG-02: every command is logged when asked, by a pilot or by
-- soc-operations, and again when it settles; soc-operations hears each settling and
-- moves its flights and operations on it.
create function soc.command_intent_is_logged()
returns trigger
language plpgsql
security definer
set search_path = soc, pg_temp
as $$
declare
  fleet uuid;
begin
  select fleet_id into fleet from soc.flights where id = new.flight_id;
  if not soc.is_open(new.operation_id) then
    return null;
  end if;
  if tg_op = 'INSERT' then
    perform soc.log_event(new.operation_id, 'command_requested',
                          case when new.requested_by is not null then 'operator'
                               when new.status = 'sent' then 'soc-cloud'
                               else 'soc-operations' end::soc.event_source,
                          jsonb_build_object('verb', new.verb), new.requested_by, new.flight_id, fleet, new.id);
  elsif new.status is distinct from old.status and new.status <> 'sent' then
    perform soc.log_event(new.operation_id, 'command_outcome', 'soc-cloud',
                          jsonb_build_object('verb', new.verb, 'status', new.status, 'result', new.result),
                          null, new.flight_id, fleet, new.id, null,
                          case when new.status = 'accepted' then 'info' else 'warning' end::soc.event_severity);
    perform pg_notify('soc_command_outcomes', new.id::text);
  end if;
  return null;
end;
$$;

create trigger command_intent_is_logged
  after insert or update on soc.command_intents
  for each row execute function soc.command_intent_is_logged();

-- ADR-0008: where each stack's dock downloads flight files, from soc-cloud's
-- configuration, so the prepare soc-operations asks for carries the file's whole URL.
alter table soc.stacks add column flight_files_url text
  constraint stack_flight_files_url check (flight_files_url is null or flight_files_url ~ '^http://');

create function soc.record_stack_files_url(gateway text, url text)
returns void
language sql
security definer
set search_path = soc, pg_temp
as $$
  update soc.stacks set flight_files_url = url
   where gateway_sn = gateway and flight_files_url is distinct from url;
$$;

-- --- soc-cloud's record (ADR-0025) ---------------------------------------------------

create function soc.record_aircraft_sample(
  aircraft text, gateway text, latest jsonb, sampled timestamptz
)
returns void
language plpgsql
security definer
set search_path = soc, pg_temp
as $$
begin
  insert into soc.aircraft_samples (aircraft_sn, gateway_sn, organization_id, sample, sampled_at, received_at)
  select aircraft, gateway, s.organization_id, latest, sampled, now()
    from soc.stacks s where s.gateway_sn = gateway
  on conflict (aircraft_sn) do update set
    gateway_sn = excluded.gateway_sn,
    organization_id = excluded.organization_id,
    sample = excluded.sample,
    sampled_at = excluded.sampled_at,
    received_at = excluded.received_at
  where excluded.sampled_at >= soc.aircraft_samples.sampled_at;
  perform pg_notify('soc_aircraft_samples', aircraft);
end;
$$;

-- FR-LNK-08, FR-LNK-09: what the stack's API last said, null when it could not be
-- read (an unknown stays unknown), with when it was read. soc-operations is told when
-- either changes; the read time alone moving is not a change it needs.
alter table soc.stacks
  add column status_read_at timestamptz,
  add column envelope_read_at timestamptz;

create function soc.record_stack_status(gateway text, read jsonb)
returns void
language plpgsql
security definer
set search_path = soc, pg_temp
as $$
declare
  before jsonb;
begin
  select status into before from soc.stacks where gateway_sn = gateway for update;
  if not found then
    return;
  end if;
  update soc.stacks set status = read, status_read_at = now() where gateway_sn = gateway;
  if before is distinct from read then
    perform pg_notify('soc_stack_views', gateway);
  end if;
end;
$$;

create function soc.record_stack_envelope(gateway text, read jsonb)
returns void
language plpgsql
security definer
set search_path = soc, pg_temp
as $$
declare
  before jsonb;
begin
  select envelope into before from soc.stacks where gateway_sn = gateway for update;
  if not found then
    return;
  end if;
  update soc.stacks set envelope = read, envelope_read_at = now() where gateway_sn = gateway;
  if before is distinct from read then
    perform pg_notify('soc_stack_views', gateway);
  end if;
end;
$$;

-- The console hears of a stack when what it shows changes, not at every read.
create or replace function soc.broadcast_stack()
returns trigger
language plpgsql
security definer
set search_path = soc, pg_temp
as $$
begin
  if tg_op = 'UPDATE' and (new.name, new.organization_id, new.link_state, new.status, new.envelope)
     is not distinct from (old.name, old.organization_id, old.link_state, old.status, old.envelope) then
    return null;
  end if;
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

-- FR-LNK-07: the latest progress of a flight; a change of status is logged and
-- announced to soc-operations, which moves the operation. A task that ended on a return
-- home after soc-cloud sent one for a geofence breach ended because of the breach: the
-- dock names it as the operator's return (322283), only the flight knows why it was sent.
create function soc.record_flight_progress(
  flight uuid,
  reported soc.flight_status,
  dji_result integer,
  done_percent integer,
  waypoint integer,
  breakpoint jsonb,
  ended soc.end_reason default null
)
returns void
language plpgsql
security definer
set search_path = soc, pg_temp
as $$
declare
  target soc.flights;
  before soc.flight_status;
begin
  select * into target from soc.flights where id = flight;
  if not found then
    return;
  end if;
  if ended = 'operator_return' and target.breached_at is not null then
    ended := 'geofence_breach';
  end if;
  select status into before from soc.flight_states where flight_id = flight;
  insert into soc.flight_states (flight_id, organization_id, status, result, percent,
                                 current_waypoint_index, break_point, end_reason, updated_at)
  values (flight, target.organization_id, reported, dji_result, done_percent, waypoint, breakpoint,
          ended, now())
  on conflict (flight_id) do update set
    status = excluded.status, result = excluded.result, percent = excluded.percent,
    current_waypoint_index = excluded.current_waypoint_index, break_point = excluded.break_point,
    end_reason = excluded.end_reason, updated_at = excluded.updated_at;
  -- A progress after its flight ended, or its operation closed, is kept, not acted on.
  if before is distinct from reported and target.ended_at is null
     and soc.is_open(target.operation_id) then
    perform soc.log_event(target.operation_id, 'flight_status_changed', 'soc-cloud',
                          jsonb_build_object('status', reported, 'percent', done_percent,
                                             'result', dji_result,
                                             'break_point', breakpoint,
                                             'end_reason', ended),
                          null, flight, target.fleet_id);
    perform pg_notify('soc_flight_progress', flight::text);
  end if;
end;
$$;

-- Take-off, landing and the aircraft's own return, from its flight mode (FR-LOG-02).
create function soc.record_flight_moment(
  flight uuid, moment text, at timestamptz, mode integer
)
returns void
language plpgsql
security definer
set search_path = soc, pg_temp
as $$
declare
  target soc.flights;
begin
  if moment not in ('took_off', 'landed', 'automatic_return') then
    raise exception 'a flight moment is took_off, landed or automatic_return, not %', moment
      using errcode = 'invalid_parameter_value';
  end if;
  update soc.flights
     set took_off_at = case when moment = 'took_off' then coalesce(took_off_at, at) else took_off_at end,
         landed_at = case when moment = 'landed' then at else landed_at end
   where id = flight
  returning * into target;
  if not found or not soc.is_open(target.operation_id) then
    return;
  end if;
  perform soc.log_event(target.operation_id, moment, 'aircraft',
                        jsonb_build_object('mode_code', mode), null, flight, target.fleet_id,
                        null, at);
  perform pg_notify('soc_flight_progress', flight::text);
end;
$$;

-- FR-SAF-01, ADR-0010: soc-cloud's own return home, sent the moment a sample of an
-- executing flight is outside its geofence, recorded as the command it sent (already
-- sent, its reply settled by soc.record_command_reply) with the breach in the log, in one
-- transaction. Once per flight, and never for a flight that ended: a second breach of the
-- same flight records nothing, and the flight keeps when it was breached, so a restarted
-- soc-cloud never sends it twice.
create function soc.record_geofence_breach(
  flight uuid, intent uuid, outside jsonb, sampled timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = soc, pg_temp
as $$
declare
  target soc.flights;
begin
  update soc.flights set breached_at = sampled
   where id = flight and breached_at is null and ended_at is null
  returning * into target;
  if not found then
    return false;
  end if;
  insert into soc.command_intents (
    id, client_request_id, organization_id, operation_id, flight_id, gateway_sn, verb,
    payload, status, sent_at
  ) values (
    intent, intent, target.organization_id, target.operation_id, flight, target.gateway_sn,
    'return_home', '{}', 'sent', now()
  );
  if soc.is_open(target.operation_id) then
    perform soc.log_event(target.operation_id, 'geofence_breach', 'soc-cloud',
                          outside || jsonb_build_object('sampled_at', sampled),
                          null, flight, target.fleet_id, intent, sampled);
  end if;
  return true;
end;
$$;

-- FR-LNK-09: soc-cloud's verdict on a dry run, from pending only.
create function soc.record_dry_run(run uuid, outcome soc.dry_run_status, said jsonb)
returns setof soc.dry_runs
language plpgsql
security definer
set search_path = soc, pg_temp
as $$
declare
  judged soc.dry_runs;
begin
  if outcome = 'pending' then
    raise exception 'a dry run is judged valid, rejected or failed' using errcode = 'invalid_parameter_value';
  end if;
  update soc.dry_runs set status = outcome, verdict = said, judged_at = now()
   where id = run and status = 'pending'
  returning * into judged;
  if found then
    perform pg_notify('soc_dry_run_results', run::text);
    return next judged;
  end if;
end;
$$;

create function soc.announce_dry_run()
returns trigger
language plpgsql
set search_path = soc, pg_temp
as $$
begin
  perform pg_notify('soc_dry_runs', new.id::text);
  return null;
end;
$$;

create trigger announce_dry_run
  after insert on soc.dry_runs
  for each row execute function soc.announce_dry_run();

-- soc-operations' check results; only what changed is written and broadcast.
create function soc.record_checks(operation uuid, judged jsonb)
returns integer
language plpgsql
security definer
set search_path = soc, pg_temp
as $$
declare
  changed integer;
begin
  with incoming as (
    select o.organization_id, c.*
      from soc.operations o,
           jsonb_to_recordset(judged) as c(check_id text, state soc.check_state, blocking boolean,
                                           value jsonb, detail text, evaluated_at timestamptz)
     where o.id = operation
  ), written as (
    insert into soc.operation_checks (operation_id, organization_id, check_id, state, blocking,
                                      value, detail, evaluated_at)
    select operation, organization_id, check_id, state, blocking, value, detail, evaluated_at
      from incoming
    on conflict (operation_id, check_id) do update set
      state = excluded.state, blocking = excluded.blocking, value = excluded.value,
      detail = excluded.detail, evaluated_at = excluded.evaluated_at
    where (soc.operation_checks.state, soc.operation_checks.blocking, soc.operation_checks.value,
           soc.operation_checks.detail)
          is distinct from (excluded.state, excluded.blocking, excluded.value, excluded.detail)
    returning 1
  )
  select count(*) into changed from written;
  return changed;
end;
$$;

-- --- Broadcasts (ADR-0007): every change to the members watching, at commit ----------

create function soc.broadcast_operation()
returns trigger
language plpgsql
security definer
set search_path = soc, pg_temp
as $$
declare
  changed soc.operations;
  operation uuid;
begin
  -- Each branch names only its own table's columns: PL/pgSQL resolves them when run.
  if tg_table_name = 'operations' then
    operation := new.id;
  elsif tg_op = 'DELETE' then
    operation := old.operation_id;
  else
    operation := new.operation_id;
  end if;
  select * into changed from soc.operations where id = operation;
  if not found then
    return null;
  end if;
  perform realtime.send(
    jsonb_build_object(
      'id', changed.id,
      'state', changed.state,
      'end_reason', changed.end_reason,
      'updated_at', changed.updated_at
    ),
    'operation',
    'org:' || changed.organization_id || ':soc:state',
    true
  );
  return null;
end;
$$;

create trigger broadcast_operation
  after insert or update on soc.operations
  for each row execute function soc.broadcast_operation();
create trigger broadcast_assignment
  after insert or update or delete on soc.assignments
  for each row execute function soc.broadcast_operation();
create trigger broadcast_operator
  after insert or update or delete on soc.operators
  for each row execute function soc.broadcast_operation();

create function soc.broadcast_flight()
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
      'mode', new.mode,
      'executed_at', new.executed_at,
      'took_off_at', new.took_off_at,
      'landed_at', new.landed_at,
      'breached_at', new.breached_at,
      'ended_at', new.ended_at,
      'end_reason', new.end_reason
    ),
    'flight',
    'org:' || new.organization_id || ':soc:state',
    true
  );
  return null;
end;
$$;

create trigger broadcast_flight
  after insert or update on soc.flights
  for each row execute function soc.broadcast_flight();

create function soc.broadcast_flight_state()
returns trigger
language plpgsql
security definer
set search_path = soc, pg_temp
as $$
begin
  perform realtime.send(
    jsonb_build_object(
      'flight_id', new.flight_id,
      'status', new.status,
      'result', new.result,
      'percent', new.percent,
      'current_waypoint_index', new.current_waypoint_index,
      'break_point', new.break_point,
      'end_reason', new.end_reason,
      'updated_at', new.updated_at
    ),
    'flight_state',
    'org:' || new.organization_id || ':soc:state',
    true
  );
  return null;
end;
$$;

create trigger broadcast_flight_state
  after insert or update on soc.flight_states
  for each row execute function soc.broadcast_flight_state();

-- FR-LOG-03: the whole entry, so the console appends it without reading again.
create function soc.broadcast_operation_event()
returns trigger
language plpgsql
security definer
set search_path = soc, pg_temp
as $$
begin
  perform realtime.send(to_jsonb(new), 'operation_event',
                        'org:' || new.organization_id || ':soc:state', true);
  return null;
end;
$$;

create trigger broadcast_operation_event
  after insert on soc.operation_events
  for each row execute function soc.broadcast_operation_event();

create function soc.broadcast_transition_request()
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
      'transition', new.transition,
      'status', new.status,
      'reasons', new.reasons,
      'requested_by', new.requested_by,
      'requested_at', new.requested_at,
      'decided_at', new.decided_at
    ),
    'transition_request',
    'org:' || new.organization_id || ':soc:state',
    true
  );
  return null;
end;
$$;

create trigger broadcast_transition_request
  after insert or update on soc.transition_requests
  for each row execute function soc.broadcast_transition_request();

create function soc.broadcast_operation_check()
returns trigger
language plpgsql
security definer
set search_path = soc, pg_temp
as $$
begin
  perform realtime.send(to_jsonb(new), 'operation_check',
                        'org:' || new.organization_id || ':soc:state', true);
  return null;
end;
$$;

create trigger broadcast_operation_check
  after insert or update on soc.operation_checks
  for each row execute function soc.broadcast_operation_check();

-- --- Row security and grants ---------------------------------------------------------

alter table soc.operation_moves enable row level security;
alter table soc.event_kinds enable row level security;
alter table soc.operations enable row level security;
alter table soc.assignments enable row level security;
alter table soc.operators enable row level security;
alter table soc.flight_files enable row level security;
alter table soc.flights enable row level security;
alter table soc.flight_states enable row level security;
alter table soc.operation_events enable row level security;
alter table soc.telemetry_samples enable row level security;
alter table soc.aircraft_samples enable row level security;
alter table soc.operation_checks enable row level security;
alter table soc.dry_runs enable row level security;
alter table soc.transition_requests enable row level security;

grant usage on type soc.operation_state, soc.end_reason, soc.operator_role, soc.flight_mode,
  soc.flight_status, soc.event_severity, soc.event_source, soc.transition, soc.request_status,
  soc.check_state, soc.dry_run_status
  to authenticated, soc_cloud, soc_operations;

-- The lifecycle and the event kinds, readable by everyone who reads operations.
grant select on soc.operation_moves, soc.event_kinds to authenticated, soc_cloud, soc_operations;
create policy everyone_reads_the_lifecycle on soc.operation_moves
  for select to authenticated, soc_cloud, soc_operations using (true);
create policy everyone_reads_the_event_kinds on soc.event_kinds
  for select to authenticated, soc_cloud, soc_operations using (true);

-- Members read their organization's operations and everything that hangs on them.
grant select on soc.operations, soc.assignments, soc.operators, soc.flights, soc.flight_states,
  soc.operation_events, soc.telemetry_samples, soc.operation_checks, soc.transition_requests
  to authenticated;
-- A flight file's bytes and serving token never reach a browser (ADR-0008, NFR-SEC-06).
grant select (id, organization_id, operation_id, wayline_id, md5, size_bytes, profile_version,
              created_at)
  on soc.flight_files to authenticated;
create policy members_read_their_operations on soc.operations
  for select to authenticated using ((select soc.is_live_member(organization_id)));
create policy members_read_their_assignments on soc.assignments
  for select to authenticated using ((select soc.is_live_member(organization_id)));
create policy members_read_their_operators on soc.operators
  for select to authenticated using ((select soc.is_live_member(organization_id)));
create policy members_read_their_flight_files on soc.flight_files
  for select to authenticated using ((select soc.is_live_member(organization_id)));
create policy members_read_their_flights on soc.flights
  for select to authenticated using ((select soc.is_live_member(organization_id)));
create policy members_read_their_flight_states on soc.flight_states
  for select to authenticated using ((select soc.is_live_member(organization_id)));
create policy members_read_their_logs on soc.operation_events
  for select to authenticated using ((select soc.is_live_member(organization_id)));
create policy members_read_their_tracks on soc.telemetry_samples
  for select to authenticated using ((select soc.is_live_member(organization_id)));
create policy members_read_their_checks on soc.operation_checks
  for select to authenticated using ((select soc.is_live_member(organization_id)));
create policy members_read_their_requests on soc.transition_requests
  for select to authenticated using ((select soc.is_live_member(organization_id)));

-- FR-OPS-01, FR-AUT-03: editors define operations. organization_id is granted at the
-- insert only; the state is never granted: it moves by soc.move_operation.
grant insert (organization_id, name, geofence_id, takeoff_security_height_m)
  on soc.operations to authenticated;
grant update (name, geofence_id, takeoff_security_height_m) on soc.operations to authenticated;
create policy editors_create_operations on soc.operations
  for insert to authenticated
  with check ((select soc.has_live_role(organization_id, 'editor')));
create policy editors_change_operations on soc.operations
  for update to authenticated
  using ((select soc.has_live_role(organization_id, 'editor')))
  with check ((select soc.has_live_role(organization_id, 'editor')));

grant insert (operation_id, organization_id, wayline_id, fleet_id, speed_ms, flight)
  on soc.assignments to authenticated;
grant update (wayline_id, fleet_id, speed_ms, flight) on soc.assignments to authenticated;
grant delete on soc.assignments to authenticated;
create policy editors_assign on soc.assignments
  for insert to authenticated
  with check ((select soc.has_live_role(organization_id, 'editor')));
create policy editors_change_assignments on soc.assignments
  for update to authenticated
  using ((select soc.has_live_role(organization_id, 'editor')))
  with check ((select soc.has_live_role(organization_id, 'editor')));
create policy editors_remove_assignments on soc.assignments
  for delete to authenticated
  using ((select soc.has_live_role(organization_id, 'editor')));

grant insert (operation_id, organization_id, profile_id, role) on soc.operators to authenticated;
grant update (role) on soc.operators to authenticated;
grant delete on soc.operators to authenticated;
create policy editors_name_operators on soc.operators
  for insert to authenticated
  with check ((select soc.has_live_role(organization_id, 'editor')));
create policy editors_change_operators on soc.operators
  for update to authenticated
  using ((select soc.has_live_role(organization_id, 'editor')))
  with check ((select soc.has_live_role(organization_id, 'editor')));
create policy editors_remove_operators on soc.operators
  for delete to authenticated
  using ((select soc.has_live_role(organization_id, 'editor')));

-- soc-operations: reads everything, builds files and flights, asks dry runs and
-- commands, ends flights; moves operations only through its functions.
grant select on soc.operations, soc.assignments, soc.operators, soc.flight_files, soc.flights,
  soc.flight_states, soc.operation_events, soc.telemetry_samples, soc.aircraft_samples,
  soc.operation_checks, soc.dry_runs, soc.transition_requests
  to soc_operations;
grant insert on soc.flight_files, soc.flights, soc.dry_runs to soc_operations;
grant update (executed_at, ended_at, end_reason, config_fingerprint) on soc.flights to soc_operations;
grant update (status, decided_at) on soc.transition_requests to soc_operations;
create policy soc_operations_reads_operations on soc.operations
  for select to soc_operations using (true);
create policy soc_operations_reads_assignments on soc.assignments
  for select to soc_operations using (true);
create policy soc_operations_reads_operators on soc.operators
  for select to soc_operations using (true);
create policy soc_operations_keeps_files on soc.flight_files
  for all to soc_operations using (true) with check (true);
create policy soc_operations_keeps_flights on soc.flights
  for all to soc_operations using (true) with check (true);
create policy soc_operations_reads_flight_states on soc.flight_states
  for select to soc_operations using (true);
create policy soc_operations_reads_logs on soc.operation_events
  for select to soc_operations using (true);
create policy soc_operations_reads_tracks on soc.telemetry_samples
  for select to soc_operations using (true);
create policy soc_operations_reads_samples on soc.aircraft_samples
  for select to soc_operations using (true);
create policy soc_operations_reads_checks on soc.operation_checks
  for select to soc_operations using (true);
create policy soc_operations_asks_dry_runs on soc.dry_runs
  for all to soc_operations using (true) with check (true);
create policy soc_operations_takes_requests on soc.transition_requests
  for all to soc_operations using (true) with check (true);

-- soc-cloud: reads what it serves and watches, writes the track, records through its
-- functions.
grant select on soc.operations, soc.flight_files, soc.flights, soc.dry_runs, soc.flight_states
  to soc_cloud;
grant insert on soc.telemetry_samples to soc_cloud;
create policy soc_cloud_reads_operations on soc.operations
  for select to soc_cloud using (true);
create policy soc_cloud_reads_files on soc.flight_files
  for select to soc_cloud using (true);
create policy soc_cloud_reads_flights on soc.flights
  for select to soc_cloud using (true);
create policy soc_cloud_reads_dry_runs on soc.dry_runs
  for select to soc_cloud using (true);
create policy soc_cloud_reads_flight_states on soc.flight_states
  for select to soc_cloud using (true);
create policy soc_cloud_writes_tracks on soc.telemetry_samples
  for insert to soc_cloud with check (true);

-- Functions: nobody by default; each to whoever it is for.
revoke execute on function soc.is_terminal(soc.operation_state) from public;
revoke execute on function soc.is_frozen(soc.operation_state) from public;
revoke execute on function soc.is_open(uuid) from public;
revoke execute on function soc.log_event(uuid, text, soc.event_source, jsonb, uuid, uuid, uuid, uuid,
  timestamptz, soc.event_severity) from public;
revoke execute on function soc.move_operation(uuid, soc.operation_state, text, soc.event_source, uuid,
  soc.end_reason) from public;
revoke execute on function soc.definition_changed(uuid, text, uuid) from public;
revoke execute on function soc.request_transition(uuid, soc.transition, uuid, jsonb) from public;
revoke execute on function soc.claim_transition_request(uuid, integer) from public;
revoke execute on function soc.decide_transition_request(uuid, soc.request_status, jsonb) from public;
revoke execute on function soc.request_command(uuid, soc.command_verb, uuid, jsonb) from public;
revoke execute on function soc.record_aircraft_sample(text, text, jsonb, timestamptz) from public;
revoke execute on function soc.record_stack_status(text, jsonb) from public;
revoke execute on function soc.record_stack_envelope(text, jsonb) from public;
revoke execute on function soc.record_flight_progress(uuid, soc.flight_status, integer, integer,
  integer, jsonb, soc.end_reason) from public;
revoke execute on function soc.record_flight_moment(uuid, text, timestamptz, integer) from public;
revoke execute on function soc.record_dry_run(uuid, soc.dry_run_status, jsonb) from public;
revoke execute on function soc.record_geofence_breach(uuid, uuid, jsonb, timestamptz) from public;
revoke execute on function soc.record_checks(uuid, jsonb) from public;
revoke execute on function soc.commanding_pilots(uuid) from public;
revoke execute on function soc.organization_members(uuid) from public;
revoke execute on function soc.record_stack_files_url(text, text) from public;

grant execute on function soc.is_terminal(soc.operation_state) to authenticated, soc_cloud, soc_operations;
grant execute on function soc.is_frozen(soc.operation_state) to authenticated, soc_cloud, soc_operations;
grant execute on function soc.is_open(uuid) to soc_cloud, soc_operations;
grant execute on function soc.request_transition(uuid, soc.transition, uuid, jsonb) to authenticated;
grant execute on function soc.request_command(uuid, soc.command_verb, uuid, jsonb) to authenticated;
grant execute on function soc.organization_members(uuid) to authenticated;
grant execute on function soc.log_event(uuid, text, soc.event_source, jsonb, uuid, uuid, uuid, uuid,
  timestamptz, soc.event_severity) to soc_operations, soc_cloud;
grant execute on function soc.move_operation(uuid, soc.operation_state, text, soc.event_source, uuid,
  soc.end_reason) to soc_operations;
grant execute on function soc.definition_changed(uuid, text, uuid) to soc_operations;
grant execute on function soc.claim_transition_request(uuid, integer) to soc_operations;
grant execute on function soc.decide_transition_request(uuid, soc.request_status, jsonb) to soc_operations;
grant execute on function soc.record_checks(uuid, jsonb) to soc_operations;
grant execute on function soc.commanding_pilots(uuid) to soc_operations;
grant execute on function soc.record_aircraft_sample(text, text, jsonb, timestamptz) to soc_cloud;
grant execute on function soc.record_stack_status(text, jsonb) to soc_cloud;
grant execute on function soc.record_stack_envelope(text, jsonb) to soc_cloud;
grant execute on function soc.record_flight_progress(uuid, soc.flight_status, integer, integer,
  integer, jsonb, soc.end_reason) to soc_cloud;
grant execute on function soc.record_flight_moment(uuid, text, timestamptz, integer) to soc_cloud;
grant execute on function soc.record_dry_run(uuid, soc.dry_run_status, jsonb) to soc_cloud;
grant execute on function soc.record_geofence_breach(uuid, uuid, jsonb, timestamptz) to soc_cloud;
grant execute on function soc.record_stack_files_url(text, text) to soc_cloud;
