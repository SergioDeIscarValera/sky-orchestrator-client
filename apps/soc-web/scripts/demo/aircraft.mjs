// The demo's aircraft in the air, as soc-cloud would report it. Pure: no clock and no timer. The
// lifecycle (lifecycle.mjs) moves the aircraft's motion on its own timers and telemetry ticks, and reads
// each sample from here, so a run is deterministic and the samples follow the flight the operation stores.
//
// A flight's path starts on the ground at its takeoff point (the first waypoint's position), climbs straight
// up to the first waypoint's height, then flies through the waypoints in order. Its length is measured in
// metres in three dimensions, so the task's fraction (elapsed over taskMs) is the fraction of the distance
// flown: the aircraft flies the whole path, climb included, at a steady speed. Positions are metres east and
// north of the takeoff point, on a plane tangent to the earth there, with the WGS 84 length of a degree at
// its latitude: well under a metre of error across a wayline's few kilometres.
//
// DJI's modes are the console's words (src/telemetry/format.ts): 0 idle, 4 automatic takeoff, 5 wayline,
// 9 automatic return, 10 automatic landing. A return home (and the landing after a completed task) flies
// straight back above the takeoff point, then descends onto it.

/** DJI's flight modes the demo's aircraft reports, in the console's words (src/telemetry/format.ts). */
export const MODES = Object.freeze({
  idle: 0,
  automaticTakeoff: 4,
  wayline: 5,
  automaticReturn: 9,
  automaticLanding: 10,
})

/** The share of a return home spent flying straight back above the takeoff point; the rest descends. */
export const CRUISE_SHARE = 2 / 3

/** The battery reads full at the start of each flight, and loses a percent for each of these in the air. */
export const FULL_BATTERY_PCT = 96
export const AIRBORNE_MS_PER_PERCENT = 6000

/** A healthy fix: the satellites and the positioning quality the demo's aircraft always reports. */
const SATELLITES = 18
const GPS_QUALITY = 5

const DEGREES = Math.PI / 180

const clamp01 = (value) => Math.min(1, Math.max(0, value))

/** How far through a span an elapsed time is, from 0 to 1; a span of no length is already through. */
const fractionOf = (elapsed, span) => (span > 0 ? clamp01(elapsed / span) : 1)

/** A heading from true north, clockwise, in -180 to 180 degrees, of a direction `east` and `north`. */
const headingOf = (east, north) => Math.atan2(east, north) / DEGREES

/** Metres in a degree of latitude and of longitude at a latitude (the WGS 84 series). */
function metresPerDegree(latitudeDeg) {
  const latitude = latitudeDeg * DEGREES
  return {
    latitude:
      111_132.92 -
      559.82 * Math.cos(2 * latitude) +
      1.175 * Math.cos(4 * latitude) -
      0.0023 * Math.cos(6 * latitude),
    longitude:
      111_412.84 * Math.cos(latitude) -
      93.5 * Math.cos(3 * latitude) +
      0.118 * Math.cos(5 * latitude),
  }
}

/** The metres east and north of `origin` at which a position lies; both are [longitude, latitude]. */
export function planeOf(origin, [longitude, latitude]) {
  const metres = metresPerDegree(origin[1])
  return {
    east: (longitude - origin[0]) * metres.longitude,
    north: (latitude - origin[1]) * metres.latitude,
  }
}

/** The position, [longitude, latitude], that lies `east` and `north` metres from `origin`. */
export function positionOf(origin, east, north) {
  const metres = metresPerDegree(origin[1])
  return [origin[0] + east / metres.longitude, origin[1] + north / metres.latitude]
}

/**
 * A flight's path as the aircraft flies it, from its stored waypoints (`{ position, height_m }`, the
 * first at the takeoff point): the ground at the takeoff point, then each waypoint at its height. Each leg
 * has its start and end along the path in metres, its heading (a vertical leg takes the heading of the
 * next horizontal leg) and its mode: the climb from the ground is automatic takeoff, the rest wayline.
 * `lengthM` is the whole path. Null when the flight has no waypoint.
 */
export function routeOf(waypoints) {
  if (!Array.isArray(waypoints) || waypoints.length === 0) return null
  const takeoff = waypoints[0].position
  const points = [
    { east: 0, north: 0, up: 0 },
    ...waypoints.map(({ position, height_m: up }) => ({ ...planeOf(takeoff, position), up })),
  ]
  const legs = []
  let start = 0
  for (let index = 0; index + 1 < points.length; index += 1) {
    const from = points[index]
    const to = points[index + 1]
    const east = to.east - from.east
    const north = to.north - from.north
    const horizontal = Math.hypot(east, north)
    const length = Math.hypot(horizontal, to.up - from.up)
    legs.push({
      from,
      to,
      start,
      end: start + length,
      length,
      heading: horizontal > 0 ? headingOf(east, north) : null,
      mode: index === 0 && horizontal === 0 && length > 0 ? MODES.automaticTakeoff : MODES.wayline,
    })
    start += length
  }
  // A vertical leg faces the next horizontal leg; one with none after it faces the last one before it.
  let following = null
  for (let index = legs.length - 1; index >= 0; index -= 1) {
    const leg = legs[index]
    if (leg.heading === null) leg.heading = following
    else following = leg.heading
  }
  let previous = 0
  for (const leg of legs) {
    if (leg.heading === null) leg.heading = previous
    else previous = leg.heading
  }
  return { takeoff, legs, lengthM: start }
}

/**
 * The pose on a route at `fraction` (0 to 1) of its length: metres east, north and up from the takeoff
 * point, the heading of the leg it is on, and its DJI mode. On the ground at the takeoff point it is idle,
 * and once airborne it flies the mode of its leg.
 */
export function routePoseOf(route, fraction) {
  if (route.lengthM === 0) return { east: 0, north: 0, up: 0, heading: 0, mode: MODES.idle }
  const distance = clamp01(fraction) * route.lengthM
  const leg =
    route.legs.find((each) => each.length > 0 && distance < each.end) ??
    route.legs.findLast((each) => each.length > 0)
  const along = clamp01((distance - leg.start) / leg.length)
  const east = leg.from.east + along * (leg.to.east - leg.from.east)
  const north = leg.from.north + along * (leg.to.north - leg.from.north)
  const up = leg.from.up + along * (leg.to.up - leg.from.up)
  return { east, north, up, heading: leg.heading, mode: up > 0 ? leg.mode : MODES.idle }
}

/**
 * The pose of a return home that began at `from` (a pose), at `fraction` of its time: it flies straight
 * back above the takeoff point at the height it had, for CRUISE_SHARE of the time, then descends onto the
 * takeoff point. It is automatic return while it flies back and automatic landing while it descends, and
 * idle on the ground. Its heading is the direction back to the takeoff point, once it has one.
 */
export function returnPoseOf(from, fraction) {
  const progress = clamp01(fraction)
  const heading =
    Math.hypot(from.east, from.north) > 0 ? headingOf(-from.east, -from.north) : from.heading
  if (progress <= CRUISE_SHARE) {
    const remaining = clamp01(1 - progress / CRUISE_SHARE)
    return {
      east: from.east * remaining,
      north: from.north * remaining,
      up: from.up,
      heading,
      mode: from.up > 0 ? MODES.automaticReturn : MODES.idle,
    }
  }
  const remaining = clamp01(1 - (progress - CRUISE_SHARE) / (1 - CRUISE_SHARE))
  const up = from.up * remaining
  return {
    east: 0,
    north: 0,
    up,
    heading,
    mode: up > 0 ? MODES.automaticLanding : MODES.idle,
  }
}

/**
 * The aircraft's motion: what it stands on, flies or returns along. Each kind holds its own data:
 * `ground` (standing at `home`, facing `heading`), `route` (flying `route` for `flightId`, `progressMs` of
 * its `taskMs` done) and `return` (returning from `from` over `homeMs`, `sinceMs` of it gone, numbered
 * `returnId`). Every kind holds `airborneMs`, the time in the air of the flight it last flew.
 */
/** The aircraft standing on the ground at `home` ([longitude, latitude]), facing `heading`. */
export function groundMotion(home, { heading = 0, airborneMs = 0 } = {}) {
  return { kind: 'ground', home, heading, airborneMs }
}

/** The aircraft at the start of a task that flies `route`: on the ground at the route's takeoff point. */
export function routeMotion(route, taskMs, flightId) {
  return {
    kind: 'route',
    home: route.takeoff,
    route,
    taskMs,
    progressMs: 0,
    flightId,
    airborneMs: 0,
  }
}

/** The route motion moved to `progressMs` of its task, when it is the flight's; any other is kept. */
export function progressedMotion(motion, flightId, progressMs) {
  return motion.kind === 'route' && motion.flightId === flightId
    ? { ...motion, progressMs }
    : motion
}

/** The aircraft returning home from where it is, over `durationMs`, numbered `returnId`. */
export function returnMotion(motion, durationMs, returnId) {
  return {
    kind: 'return',
    home: motion.home,
    from: poseOf(motion),
    sinceMs: 0,
    homeMs: durationMs,
    returnId,
    airborneMs: motion.airborneMs,
  }
}

/** The motion once a return home is over: the aircraft stands on the ground at its takeoff point. */
export function landedMotion(motion) {
  return groundMotion(motion.home, {
    heading: poseOf(motion).heading,
    airborneMs: motion.airborneMs,
  })
}

/**
 * The motion one telemetry tick later: the time in the air grows while the aircraft is airborne, and a
 * return home goes on by the tick. A route's progress is not moved here: the lifecycle sets it.
 */
export function tickedMotion(motion, tickMs) {
  const airborneMs = motion.airborneMs + (poseOf(motion).up > 0 ? tickMs : 0)
  if (motion.kind !== 'return') return { ...motion, airborneMs }
  return {
    ...motion,
    airborneMs,
    sinceMs: Math.min(motion.homeMs, motion.sinceMs + tickMs),
  }
}

/** The aircraft's pose at this moment of its motion: metres east, north and up, heading and mode. */
export function poseOf(motion) {
  if (motion.kind === 'route') {
    return routePoseOf(motion.route, fractionOf(motion.progressMs, motion.taskMs))
  }
  if (motion.kind === 'return') {
    return returnPoseOf(motion.from, fractionOf(motion.sinceMs, motion.homeMs))
  }
  return { east: 0, north: 0, up: 0, heading: motion.heading, mode: MODES.idle }
}

/** The battery's whole percent after `airborneMs` in the air: never below 0. */
export function batteryOf(airborneMs) {
  return Math.max(0, FULL_BATTERY_PCT - Math.floor(airborneMs / AIRBORNE_MS_PER_PERCENT))
}

/**
 * The sample the aircraft sends at `nowMs`, as soc-cloud broadcasts it (contracts/broadcast/
 * telemetry.schema.json): exactly the contract's keys, with the position, the height above takeoff and
 * the rest in Sky Orchestrator's units. `aircraft` names its stack, its gateway and its aircraft. It is
 * taken and sent at the same moment, the demo's clock stamping both.
 */
export function sampleOf(motion, { stack, gatewaySn, aircraftSn }, nowMs) {
  const pose = poseOf(motion)
  const [longitude, latitude] = positionOf(motion.home, pose.east, pose.north)
  return {
    stack,
    gateway_sn: gatewaySn,
    aircraft_sn: aircraftSn,
    taken_at_ms: nowMs,
    sent_at_ms: nowMs,
    latitude_deg: latitude,
    longitude_deg: longitude,
    height_m: pose.up,
    heading_deg: pose.heading,
    home_distance_m: Math.hypot(pose.east, pose.north),
    battery_pct: batteryOf(motion.airborneMs),
    satellites: SATELLITES,
    gps_quality: GPS_QUALITY,
    mode_code: pose.mode,
  }
}
