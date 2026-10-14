export interface FakeSupabase {
    /** The address the console takes as its Supabase URL: `http://127.0.0.1:<port>`. */
    readonly url: string
    /** Stops the server and drops its connections; the fleets go with it. */
    close(): Promise<void>
}

/**
 * Starts the fake on 127.0.0.1 at `port`; 0 takes a free one. `telemetry` holds the rows of
 * soc.telemetry_samples it answers the track read with, each with its `flight_id`.
 */
export declare function startFakeSupabase(options?: {
    readonly port?: number
    readonly telemetry?: readonly Readonly<Record<string, unknown>>[]
}): Promise<FakeSupabase>

/** A JWT-shaped string with a placeholder signature: the console reads only its payload. */
export declare function unsignedJwt(payload: Readonly<Record<string, unknown>>): string
