export interface FakeSupabase {
    /** The address the console takes as its Supabase URL: `http://127.0.0.1:<port>`. */
    readonly url: string
    /** Stops the server and drops its connections; the fleets go with it. */
    close(): Promise<void>
}

/** Starts the fake on 127.0.0.1 at `port`; 0 takes a free one. */
export declare function startFakeSupabase(options?: {
    readonly port?: number
}): Promise<FakeSupabase>

/** A JWT-shaped string with a placeholder signature: the console reads only its payload. */
export declare function unsignedJwt(payload: Readonly<Record<string, unknown>>): string
