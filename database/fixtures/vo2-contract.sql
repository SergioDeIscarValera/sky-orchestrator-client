-- Virtual Origen's identity and tenancy surface, as SOC's database tests load it.
--
-- The contract of VO2's ADR 0059 (proposed): the role enum, the identity tables
-- with the columns SOC reads, the private membership helpers and their grants,
-- and the select policies the web reads the tables through. Reproduced from
-- virtual-origen-v2 at ad7d36ab25b6c36b3ce544c275886e8c3b630822, from
-- supabase/migrations:
--   20260718100200_enums.sql                      role, sync_origin
--   20260718100400_identity_and_orgs.sql          profiles, organizations, memberships
--   20260719090000_harden_function_execute_grants.sql  role_rank
--   20260718101000_rls_functions.sql              is_member, has_role, shares_org
--   20260721110000_create_private_schema.sql      schema private and its usage grant
--   20260721110100_move_rls_helpers_to_private.sql  the helpers moved to private
--   20260802100000_member_orgs_initplan_rls.sql   current_member_orgs
--   20260718101100_rls_policies.sql               the select policies
-- Columns SOC never reads (avatar_url, settings, origin, timestamps beyond
-- deleted_at) are kept where they carry a constraint SOC must respect.

create extension if not exists citext with schema extensions;

create type public.role as enum ('owner', 'editor', 'viewer');
create type public.sync_origin as enum ('local', 'online');

create table public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  email        extensions.citext,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz,
  origin       public.sync_origin not null default 'local'
);

create table public.organizations (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  owner_id   uuid not null references public.profiles (id) on delete restrict,
  latitude   numeric,
  longitude  numeric,
  timezone   text,
  settings   jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  origin     public.sync_origin not null default 'local',
  constraint organizations_latitude_range  check (latitude  is null or latitude  between -90  and 90),
  constraint organizations_longitude_range check (longitude is null or longitude between -180 and 180)
);

create table public.memberships (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  profile_id      uuid not null references public.profiles (id) on delete cascade,
  role            public.role not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz,
  origin          public.sync_origin not null default 'local',
  constraint memberships_org_profile_unique unique (organization_id, profile_id)
);

create or replace function public.role_rank(r public.role)
returns integer
language sql
immutable
set search_path = public, pg_temp
as $$
  select case r
           when 'viewer' then 1
           when 'editor' then 2
           when 'owner'  then 3
         end;
$$;

create schema if not exists private;
grant usage on schema private to anon, authenticated, service_role;

create or replace function private.is_member(org uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from memberships m
    where m.organization_id = org
      and m.profile_id = auth.uid()
      and m.deleted_at is null
  );
$$;

create or replace function private.has_role(org uuid, min_role role)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from memberships m
    where m.organization_id = org
      and m.profile_id = auth.uid()
      and m.deleted_at is null
      and role_rank(m.role) >= role_rank(min_role)
  );
$$;

create or replace function private.shares_org(other uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from memberships me
    join memberships them on them.organization_id = me.organization_id
    where me.profile_id = auth.uid() and me.deleted_at is null
      and them.profile_id = other   and them.deleted_at is null
  );
$$;

create or replace function private.current_member_orgs()
returns uuid[]
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(array_agg(m.organization_id), array[]::uuid[])
  from memberships m
  where m.profile_id = auth.uid()
    and m.deleted_at is null;
$$;
grant execute on function private.current_member_orgs() to anon, authenticated, service_role;

alter table public.profiles      enable row level security;
alter table public.organizations enable row level security;
alter table public.memberships   enable row level security;

create policy profiles_select on public.profiles for select
  using ((id = auth.uid() or private.shares_org(id)) and deleted_at is null);
create policy organizations_select on public.organizations for select
  using (private.is_member(id) and deleted_at is null);
create policy memberships_select on public.memberships for select
  using (private.is_member(organization_id) and deleted_at is null);

grant select on public.profiles, public.organizations, public.memberships to authenticated;
