-- A launch in the simulator (M5; FR-OPS-13, ADR-0027).
--
-- A simulated operation launches again in Sky Orchestrator's simulator while its stack is
-- in simulator mode: the prepare of its simulated pass, then an execute, and its flight
-- commanded as a real one is (FR-CMD): paused, resumed, sent home, stopped, taken over
-- from the controller. Once its aircraft stands on the ground, the operation is simulated
-- again (contracts/operations/lifecycle.json 1.1.0). A launch in the simulator neither
-- starts nor closes the record: started_at is the real flight's, and the operation is
-- launched as many times as its pilots rehearse.

-- --- The lifecycle's three new moves ------------------------------------------------

insert into soc.operation_moves (from_state, to_state) values
  ('simulated', 'launching'), ('launching', 'simulated'), ('returning', 'simulated');

-- --- started_at: a launch from ready, never one in the simulator ---------------------

create or replace function soc.move_operation(
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
         started_at = case when to_state = 'launching' and current.state = 'ready'
                           then coalesce(started_at, now()) else started_at end,
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

-- --- What a launch in the simulator names stays as it is until it lands -----------------

-- A real flight flies its own file and snapshot, so an edit while it is in the air waits
-- for no one: the operation closes on landing. A launch in the simulator comes back to
-- simulated instead, still holding its file, so what it names is fixed until then, as
-- while a flight is prepared.
create or replace function soc.dependents_follow()
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
  -- While a flight of it is prepared from its file, or flown in the simulator, what it
  -- names stays as it is.
  select o.id into flying
    from soc.operations o
    left join soc.assignments a on a.operation_id = o.id
   where (o.state in ('simulating', 'launching')
          or (o.state in ('in_flight', 'paused', 'returning') and exists (
                select 1 from soc.flights f
                 where f.operation_id = o.id and f.ended_at is null and f.mode = 'simulated')))
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
