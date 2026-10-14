import type { Timings } from './lifecycle.mjs'

export interface FakeSupabase {
    /** The address the console takes as its Supabase URL: `http://127.0.0.1:<port>`. */
    readonly url: string
    /** Stops the lifecycle's timers and the server, and drops its connections; the fleets and operations go with it. */
    close(): Promise<void>
}

/** Starts the fake on 127.0.0.1 at `port`; 0 takes a free one. `timings` overrides the demo's TIMINGS. */
export declare function startFakeSupabase(options?: {
    readonly port?: number
    readonly timings?: Partial<Timings>
}): Promise<FakeSupabase>

/** A JWT-shaped string with a placeholder signature: the console reads only its payload. */
export declare function unsignedJwt(payload: Readonly<Record<string, unknown>>): string
