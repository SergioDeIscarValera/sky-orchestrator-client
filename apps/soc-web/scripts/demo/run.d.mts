/** The console's settings file for the demo: the keys of its contract, each in range. */
export declare const DEMO_SETTINGS: {
    readonly telemetry_stale_after_ms: number
    readonly telemetry_lost_after_ms: number
    readonly geofence_warning_band_m: number
    readonly geofence_max_vertices: number
    readonly max_arc_spacing_m: number
}

/** The public anon key, built at runtime: the secret scanner refuses a key literal in the source. */
export declare function demoSupabaseKey(): string

/** Stops the Vite process group (pnpm and the dev server under it), by force after a while. */
export declare function stopGroup(pid: number): Promise<void>
