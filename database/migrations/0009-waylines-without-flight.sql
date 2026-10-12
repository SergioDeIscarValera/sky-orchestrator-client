-- Waylines without flight (IR-WAY, FR-WAY-09, FR-WAY-10; 2026-10-12). A wayline is
-- geometry: its name, takeoff point, default height, design and the waypoints baked
-- from it, with their heights, and the metrics of that bake. Its speed, its climb,
-- its finish, its geofence and any estimate of its duration belong to the operation
-- that flies it (M4). So the speed column goes, and metrics needs the waypoint count
-- and the distance, not a duration. 0008 is released and stays as it was; every other
-- column, check, trigger, broadcast and policy of it stands. The live waylines that
-- 0.4.0 saved are converted in place, by the last statement here: their design moves
-- to schema 2.0.0 and their metrics lose duration_s. Retired waylines are not touched.

-- The insert and update grants of 0008 name speed_ms, so they are revoked while the
-- column still exists, then granted again without it, as 0008 grants every other one.
revoke insert (organization_id, name, takeoff, default_height_m, speed_ms, design,
               waypoints, metrics, bake_version)
  on soc.waylines from authenticated;
revoke update (name, takeoff, default_height_m, speed_ms, design, waypoints, metrics,
               bake_version, deleted_at)
  on soc.waylines from authenticated;

-- The column's check (wayline_speed_positive) goes with it.
alter table soc.waylines drop column speed_ms;

grant insert (organization_id, name, takeoff, default_height_m, design,
              waypoints, metrics, bake_version)
  on soc.waylines to authenticated;
grant update (name, takeoff, default_height_m, design, waypoints, metrics,
              bake_version, deleted_at)
  on soc.waylines to authenticated;

-- A key that is missing reads as NULL, and a CHECK passes NULL: each key is tested
-- with IS NOT DISTINCT FROM so a missing number refuses the row.
alter table soc.waylines drop constraint wayline_metrics_object;
alter table soc.waylines add constraint wayline_metrics_object check (
  jsonb_typeof(metrics) = 'object'
  and jsonb_typeof(metrics -> 'waypoint_count') is not distinct from 'number'
  and jsonb_typeof(metrics -> 'distance_m') is not distinct from 'number'
);

-- Live waylines 0.4.0 saved (design schema 1.x) move to schema 2.0.0: their design
-- loses the three keys the operation now owns (speed_ms, takeoff_security_height_m,
-- finish_action) and their metrics lose duration_s. The waypoints and bake_version
-- stay as they are: 0.4.0 never knew the stack's envelope, so no leg was ever split,
-- and the saved waypoints are the 2.0.0 bake. Retired waylines are not touched:
-- wayline_changes refuses any change to one, so the where clause leaves them out.
-- It runs after the metrics check above, since the check it replaced refuses metrics
-- without duration_s.
update soc.waylines
   set design = (design - 'speed_ms' - 'takeoff_security_height_m' - 'finish_action')
                || jsonb_build_object('schema_version', '2.0.0'),
       metrics = metrics - 'duration_s'
 where deleted_at is null and design ->> 'schema_version' like '1.%';
