-- Schema soc and membership as SOC means it: a live membership in a live
-- organization. Virtual Origen's helpers check the membership's deleted_at, not
-- the organization's (ADR-0005), so every SOC policy goes through these instead.

create schema soc;
revoke all on schema soc from public;
grant usage on schema soc to authenticated, service_role;

create function soc.live_member_orgs()
returns uuid[]
language sql
stable
security definer
set search_path = soc, public, private, pg_temp
as $$
  select coalesce(array_agg(o.id), array[]::uuid[])
  from public.organizations o
  where o.deleted_at is null
    and o.id = any (private.current_member_orgs());
$$;

create function soc.is_live_member(organization uuid)
returns boolean
language sql
stable
security definer
set search_path = soc, public, private, pg_temp
as $$
  select organization = any (soc.live_member_orgs());
$$;

create function soc.has_live_role(organization uuid, minimum public.role)
returns boolean
language sql
stable
security definer
set search_path = soc, public, private, pg_temp
as $$
  select private.has_role(organization, minimum)
     and exists (
       select 1 from public.organizations o
       where o.id = organization and o.deleted_at is null
     );
$$;

revoke execute on function soc.live_member_orgs() from public, anon;
revoke execute on function soc.is_live_member(uuid) from public, anon;
revoke execute on function soc.has_live_role(uuid, public.role) from public, anon;
grant execute on function soc.live_member_orgs() to authenticated, service_role;
grant execute on function soc.is_live_member(uuid) to authenticated, service_role;
grant execute on function soc.has_live_role(uuid, public.role) to authenticated, service_role;
