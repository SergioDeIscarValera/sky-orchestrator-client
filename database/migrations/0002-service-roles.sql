-- The services' own login roles (ADR-0017): least privilege on schema soc only,
-- three connections at most each, and timeouts so a SOC fault cannot hold locks
-- the farm's control loop waits on. Postgres is reachable from the LAN, so the
-- roles start with no password; the migration runner sets one from SOC's
-- environment, as a SCRAM verifier.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'soc_cloud') then
    create role soc_cloud login noinherit connection limit 3;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'soc_operations') then
    create role soc_operations login noinherit connection limit 3;
  end if;
end
$$;

alter role soc_cloud set search_path = soc, pg_temp;
alter role soc_cloud set statement_timeout = '5s';
alter role soc_cloud set lock_timeout = '2s';
alter role soc_cloud set idle_in_transaction_session_timeout = '10s';

alter role soc_operations set search_path = soc, pg_temp;
alter role soc_operations set statement_timeout = '5s';
alter role soc_operations set lock_timeout = '2s';
alter role soc_operations set idle_in_transaction_session_timeout = '10s';

grant usage on schema soc to soc_cloud, soc_operations;
