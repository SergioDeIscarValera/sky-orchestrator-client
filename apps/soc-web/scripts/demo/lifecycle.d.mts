import type { Identity, Position, Sample } from './aircraft.mjs'
import type { Db, Row } from './operation-tables.mjs'

/** The demo's timings in milliseconds (lifecycle.mjs, TIMINGS). */
export interface Timings {
    readonly claimMs: number
    readonly decideMs: number
    readonly commandStepMs: number
    readonly progressTickMs: number
    readonly taskMs: number
    readonly telemetryTickMs: number
    readonly takeOffMs: number
    readonly landMs: number
    readonly returnHomeMs: number
    readonly readyMs: number
}

export declare const TIMINGS: Readonly<Timings>

/** The demo's stack as soc-operations reads it: its mode, its phone's simulator, its configuration; null where unknown. */
export interface StackState {
    readonly simulatorMode: boolean | null
    readonly simulatorActive: boolean | null
    readonly configFingerprint: string | null
}

/** The status soc-cloud records for the demo's stack (soc.stacks.status), in the mode given. */
export declare function stackStatus(simulatorMode: boolean): Readonly<Record<string, unknown>>

/** The moves the module makes, each as [from, to]. */
export declare const MOVES: ReadonlyArray<readonly [string, string]>

/** The sixteen preflight check ids, in the console's order. */
export declare const PF_CHECK_IDS: readonly string[]

export interface JudgedCheck {
    readonly check_id: string
    readonly state: string
    readonly blocking: boolean
    readonly value: unknown
    readonly detail: string
    readonly evaluated_at: string
}

/** The sixteen checks, as judged at `evaluatedAt` for a stack in the state given: every one passes, but the mode checks. */
export declare function judgeChecks(evaluatedAt: string, stack: StackState): JudgedCheck[]

export interface Lifecycle {
    /** A transition request was inserted: it is claimed and decided on its timers. */
    transitionAsked(requestId: string): void
    /** A pilot's command was inserted: it is sent and answered on its timers. */
    commandAsked(intentId: string): void
    /** Clears every timer, so nothing runs after it. */
    close(): void
}

/** The demo's aircraft: where it is named, and its takeoff point, where it stands before its first flight. */
export interface DemoAircraft extends Identity {
    readonly organizationId: string
    readonly home: Position
}

/** Where the lifecycle sends each sample of the aircraft, and stores the rows of a flight's track. */
export interface Telemetry {
    readonly send: (organization: string, sample: Sample) => void
    readonly store: (row: Row) => void
}

export interface LifecycleOptions {
    readonly db: Db
    readonly roles: { readonly canEdit: (organization: string, profile?: string) => boolean }
    readonly timings?: Partial<Timings>
    readonly onError?: (error: unknown) => void
    readonly aircraft?: DemoAircraft | null
    readonly telemetry?: Telemetry
}

/** soc-operations and soc-cloud on the database, on the demo's timers. */
export declare function createLifecycle(options: LifecycleOptions): Lifecycle

export type { Row }
