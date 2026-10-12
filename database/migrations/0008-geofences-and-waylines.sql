-- Geofences and waylines (IR-GEO, IR-WAY; FR-GEO-01, FR-GEO-02, FR-GEO-04,
-- FR-WAY-09, IR-WAY-01). The web reads and writes them through PostgREST under
-- these policies, which follow the fleets' (ADR-0006); soc-cloud and
-- soc-operations read every row. The database holds what a valid one is made of:
-- a polygon ring, positive heights and speed, a baked result that is a list of
-- positions with heights. Whether a ring is simple is checked by the validators
-- in code (FR-GEO-04), not here. Every change reaches the organization's state
-- topic (ADR-0007).

create type soc.geofence_origin as enum ('drawn', 'generated');

-- A position is [longitude, latitude], GeoJSON order (the canonical units). Each
-- check is a CASE that tests before it casts, so anything that is not a position
-- answers false and never raises.
create function soc.is_position(value jsonb)
returns boolean
language sql
immutable
set search_path = soc, pg_temp
as $$
  select case
    when jsonb_typeof(value) is distinct from 'array' then false
    when jsonb_array_length(value) is distinct from 2 then false
    when jsonb_typeof(value -> 0) is distinct from 'number' then false
    when jsonb_typeof(value -> 1) is distinct from 'number' then false
    else (value ->> 0)::numeric between -180 and 180
     and (value ->> 1)::numeric between -90 and 90
  end;
$$;

-- A ring: at least three positions, not closed (the last is not the first).
-- Whether it is simple is the validators' check (FR-GEO-04), so a ring that
-- crosses itself passes here.
create function soc.is_ring(value jsonb)
returns boolean
language sql
immutable
set search_path = soc, pg_temp
as $$
  select case
    when jsonb_typeof(value) is distinct from 'array' then false
    when jsonb_array_length(value) < 3 then false
    when not (select bool_and(soc.is_position(vertex))
                from jsonb_array_elements(value) as vertex) then false
    else (value -> 0) is distinct from (value -> (jsonb_array_length(value) - 1))
  end;
$$;

-- The baked waypoints: a non-empty list of objects, each with a position and a
-- numeric height_m above zero (metres above the takeoff point).
create function soc.is_baked_waypoints(value jsonb)
returns boolean
language sql
immutable
set search_path = soc, pg_temp
as $$
  select case
    when jsonb_typeof(value) is distinct from 'array' then false
    when jsonb_array_length(value) = 0 then false
    else not exists (
      select 1
        from jsonb_array_elements(value) as waypoint
       where not (case
         when jsonb_typeof(waypoint) is distinct from 'object' then false
         when jsonb_typeof(waypoint -> 'height_m') is distinct from 'number' then false
         else soc.is_position(waypoint -> 'position')
          and (waypoint ->> 'height_m')::numeric > 0
       end)
    )
  end;
$$;

-- IR-GEO: a margin exactly when generated, from 5 to 100 m.
create table soc.geofences (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  name            text not null constraint geofence_name_given check (btrim(name) <> ''),
  polygon         jsonb not null constraint geofence_polygon_ring check (soc.is_ring(polygon)),
  max_height_m    numeric not null
                    constraint geofence_max_height_positive check (max_height_m > 0),
  origin          soc.geofence_origin not null,
  margin_m        numeric,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz,
  constraint geofence_margin_when_generated check (
    (origin = 'generated') = (margin_m is not null)
    and (margin_m is null or margin_m between 5 and 100)
  )
);

-- IR-WAY-01: the design and its baked waypoints are saved together. Nothing here
-- recomputes the bake: a saved wayline keeps the waypoints it was saved with until
-- an editor writes new ones.
create table soc.waylines (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  name             text not null constraint wayline_name_given check (btrim(name) <> ''),
  takeoff          jsonb not null
                     constraint wayline_takeoff_position check (soc.is_position(takeoff)),
  default_height_m numeric not null
                     constraint wayline_default_height_positive check (default_height_m > 0),
  speed_ms         numeric not null
                     constraint wayline_speed_positive check (speed_ms > 0),
  design           jsonb not null
                     constraint wayline_design_object check (jsonb_typeof(design) = 'object'),
  waypoints        jsonb not null
                     constraint wayline_waypoints_baked check (soc.is_baked_waypoints(waypoints)),
  -- A key that is missing reads as NULL, and a CHECK passes NULL: each key is
  -- tested with IS NOT DISTINCT FROM so a missing number refuses the row.
  metrics          jsonb not null constraint wayline_metrics_object check (
                     jsonb_typeof(metrics) = 'object'
                     and jsonb_typeof(metrics -> 'waypoint_count') is not distinct from 'number'
                     and jsonb_typeof(metrics -> 'distance_m') is not distinct from 'number'
                     and jsonb_typeof(metrics -> 'duration_s') is not distinct from 'number'
                   ),
  bake_version     text not null
                     constraint wayline_bake_version_given check (btrim(bake_version) <> ''),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  deleted_at       timestamptz
);

create index geofences_by_organization on soc.geofences (organization_id)
  where deleted_at is null;
create index waylines_by_organization on soc.waylines (organization_id)
  where deleted_at is null;

-- FR-GEO-02, FR-WAY-09: retiring is final and keeps the row as it was; the time is
-- the database's (as for fleets, FR-FLE-05).
create function soc.geofence_changes()
returns trigger
language plpgsql
set search_path = soc, pg_temp
as $$
begin
  if old.deleted_at is not null then
    raise exception 'geofence %: a retired geofence does not change', old.id
      using errcode = 'check_violation';
  end if;
  new.deleted_at := case when new.deleted_at is null then null else now() end;
  new.updated_at := now();
  return new;
end;
$$;

create trigger geofence_changes
  before update on soc.geofences
  for each row execute function soc.geofence_changes();

create function soc.geofence_starts_live()
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

create trigger geofence_starts_live
  before insert on soc.geofences
  for each row execute function soc.geofence_starts_live();

create function soc.wayline_changes()
returns trigger
language plpgsql
set search_path = soc, pg_temp
as $$
begin
  if old.deleted_at is not null then
    raise exception 'wayline %: a retired wayline does not change', old.id
      using errcode = 'check_violation';
  end if;
  new.deleted_at := case when new.deleted_at is null then null else now() end;
  new.updated_at := now();
  return new;
end;
$$;

create trigger wayline_changes
  before update on soc.waylines
  for each row execute function soc.wayline_changes();

create function soc.wayline_starts_live()
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

create trigger wayline_starts_live
  before insert on soc.waylines
  for each row execute function soc.wayline_starts_live();

-- Every insert and change reaches the organization's state topic (ADR-0007).
create function soc.broadcast_geofence()
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
      'origin', new.origin,
      'updated_at', new.updated_at,
      'deleted_at', new.deleted_at
    ),
    'geofence',
    'org:' || new.organization_id || ':soc:state',
    true
  );
  return null;
end;
$$;

create trigger broadcast_geofence
  after insert or update on soc.geofences
  for each row execute function soc.broadcast_geofence();

create function soc.broadcast_wayline()
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
      'updated_at', new.updated_at,
      'deleted_at', new.deleted_at
    ),
    'wayline',
    'org:' || new.organization_id || ':soc:state',
    true
  );
  return null;
end;
$$;

create trigger broadcast_wayline
  after insert or update on soc.waylines
  for each row execute function soc.broadcast_wayline();

alter table soc.geofences enable row level security;
alter table soc.waylines enable row level security;

grant usage on type soc.geofence_origin to authenticated, soc_cloud, soc_operations;

grant select on soc.geofences, soc.waylines to authenticated;
create policy members_read_their_geofences on soc.geofences
  for select to authenticated
  using ((select soc.is_live_member(organization_id)));
create policy members_read_their_waylines on soc.waylines
  for select to authenticated
  using ((select soc.is_live_member(organization_id)));

-- FR-AUT-03: writes need editor or above. organization_id is granted at the insert
-- only: a row cannot be moved, whichever organization the editor belongs to. The
-- update's with check tests the organization it is written to, not the move.
grant insert (organization_id, name, polygon, max_height_m, origin, margin_m)
  on soc.geofences to authenticated;
grant update (name, polygon, max_height_m, origin, margin_m, deleted_at)
  on soc.geofences to authenticated;
create policy editors_register_geofences on soc.geofences
  for insert to authenticated
  with check ((select soc.has_live_role(organization_id, 'editor')));
create policy editors_change_geofences on soc.geofences
  for update to authenticated
  using ((select soc.has_live_role(organization_id, 'editor')))
  with check ((select soc.has_live_role(organization_id, 'editor')));

grant insert (organization_id, name, takeoff, default_height_m, speed_ms, design,
              waypoints, metrics, bake_version)
  on soc.waylines to authenticated;
grant update (name, takeoff, default_height_m, speed_ms, design, waypoints, metrics,
              bake_version, deleted_at)
  on soc.waylines to authenticated;
create policy editors_register_waylines on soc.waylines
  for insert to authenticated
  with check ((select soc.has_live_role(organization_id, 'editor')));
create policy editors_change_waylines on soc.waylines
  for update to authenticated
  using ((select soc.has_live_role(organization_id, 'editor')))
  with check ((select soc.has_live_role(organization_id, 'editor')));

grant select on soc.geofences, soc.waylines to soc_cloud, soc_operations;
create policy services_read_geofences on soc.geofences
  for select to soc_cloud, soc_operations using (true);
create policy services_read_waylines on soc.waylines
  for select to soc_cloud, soc_operations using (true);
