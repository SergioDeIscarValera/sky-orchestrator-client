-- The organizations a user may open in SOC (FR-AUT-02, IR-ORG-01): their live
-- memberships of live organizations, with their role, and the position and time
-- zone that centre the scene and set its clock. Security invoker: Virtual
-- Origen's policies on its tables apply as well.

create function soc.member_organizations()
returns table (
  id        uuid,
  name      text,
  role      public.role,
  latitude  double precision,
  longitude double precision,
  timezone  text
)
language sql
stable
security invoker
set search_path = soc, public, pg_temp
as $$
  select o.id, o.name, m.role, o.latitude::double precision, o.longitude::double precision,
         o.timezone
  from public.memberships m
  join public.organizations o on o.id = m.organization_id
  where m.profile_id = auth.uid()
    and m.deleted_at is null
    and o.deleted_at is null
  order by o.name, o.id;
$$;

revoke execute on function soc.member_organizations() from public, anon;
grant execute on function soc.member_organizations() to authenticated;
