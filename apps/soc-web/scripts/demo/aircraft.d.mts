/** A position as the flights store it: [longitude, latitude]. */
export type Position = readonly [number, number]

/** DJI's flight modes the demo's aircraft reports, in the console's words (aircraft.mjs, MODES). */
export declare const MODES: Readonly<{
    readonly idle: 0
    readonly automaticTakeoff: 4
    readonly wayline: 5
    readonly automaticReturn: 9
    readonly automaticLanding: 10
}>

/** The share of a return home spent flying straight back above the takeoff point. */
export declare const CRUISE_SHARE: number
/** The battery reads this full at the start of each flight, and loses a percent per AIRBORNE_MS_PER_PERCENT. */
export declare const FULL_BATTERY_PCT: number
export declare const AIRBORNE_MS_PER_PERCENT: number

/** A point of the local plane: metres east, north and up of the takeoff point. */
export interface PlanePoint {
    readonly east: number
    readonly north: number
    readonly up: number
}

/** A pose: where the aircraft is, which way it faces, and the DJI mode it reports. */
export interface Pose extends PlanePoint {
    readonly heading: number
    readonly mode: number
}

/** A stored waypoint, as the flight's JSON holds it. */
export interface Waypoint {
    readonly position: Position
    readonly height_m: number
}

export interface Leg {
    readonly from: PlanePoint
    readonly to: PlanePoint
    /** Metres along the route at which the leg starts, and ends. */
    readonly start: number
    readonly end: number
    readonly length: number
    readonly heading: number
    readonly mode: number
}

export interface Route {
    readonly takeoff: Position
    readonly legs: readonly Leg[]
    readonly lengthM: number
}

export interface GroundMotion {
    readonly kind: 'ground'
    readonly home: Position
    readonly heading: number
    readonly airborneMs: number
}

export interface RouteMotion {
    readonly kind: 'route'
    readonly home: Position
    readonly route: Route
    readonly taskMs: number
    readonly progressMs: number
    readonly flightId: string
    readonly airborneMs: number
}

export interface ReturnMotion {
    readonly kind: 'return'
    readonly home: Position
    readonly from: Pose
    readonly sinceMs: number
    readonly homeMs: number
    readonly returnId: number
    readonly airborneMs: number
}

export type Motion = GroundMotion | RouteMotion | ReturnMotion

/** The stack, gateway and aircraft a sample names. */
export interface Identity {
    readonly stack: string
    readonly gatewaySn: string
    readonly aircraftSn: string
}

/** One sample, with exactly the keys of contracts/broadcast/telemetry.schema.json. */
export interface Sample {
    readonly stack: string
    readonly gateway_sn: string
    readonly aircraft_sn: string
    readonly taken_at_ms: number
    readonly sent_at_ms: number
    readonly latitude_deg: number
    readonly longitude_deg: number
    readonly height_m: number
    readonly heading_deg: number
    readonly home_distance_m: number
    readonly battery_pct: number
    readonly satellites: number
    readonly gps_quality: number
    readonly mode_code: number
}

/** The metres east and north of `origin` at which `position` lies. */
export declare function planeOf(
    origin: Position,
    position: Position,
): { east: number; north: number }
/** The position that lies `east` and `north` metres from `origin`. */
export declare function positionOf(origin: Position, east: number, north: number): Position

/** A flight's route from its stored waypoints, or null when it has none. */
export declare function routeOf(waypoints: unknown): Route | null
/** The pose on a route at a fraction (0 to 1) of its length. */
export declare function routePoseOf(route: Route, fraction: number): Pose
/** The pose of a return home that began at `from`, at a fraction (0 to 1) of its time. */
export declare function returnPoseOf(from: Pose, fraction: number): Pose

export declare function groundMotion(
    home: Position,
    options?: { readonly heading?: number; readonly airborneMs?: number },
): GroundMotion
export declare function routeMotion(route: Route, taskMs: number, flightId: string): RouteMotion
export declare function progressedMotion(
    motion: Motion,
    flightId: string,
    progressMs: number,
): Motion
export declare function returnMotion(
    motion: Motion,
    durationMs: number,
    returnId: number,
): ReturnMotion
export declare function landedMotion(motion: Motion): GroundMotion
export declare function tickedMotion(motion: Motion, tickMs: number): Motion
export declare function poseOf(motion: Motion): Pose
export declare function batteryOf(airborneMs: number): number

/** The sample the aircraft sends at `nowMs`, as soc-cloud broadcasts it. */
export declare function sampleOf(motion: Motion, identity: Identity, nowMs: number): Sample
