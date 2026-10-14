import type { Db, Row } from './operation-tables.mjs'

/** The demo's timings in milliseconds (lifecycle.mjs, TIMINGS). */
export interface Timings {
    readonly claimMs: number
    readonly decideMs: number
    readonly commandStepMs: number
    readonly progressTickMs: number
    readonly taskMs: number
    readonly takeOffMs: number
    readonly landMs: number
    readonly returnHomeMs: number
    readonly readyMs: number
}

export declare const TIMINGS: Readonly<Timings>

/** The demo's one stack as soc-cloud reports it: real mode, under one configuration. */
export declare const STACK: Readonly<{
    readonly simulatorMode: boolean
    readonly configFingerprint: string
}>

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

/** The sixteen checks, as judged at `evaluatedAt`: every one passes. */
export declare function judgeChecks(evaluatedAt: string): JudgedCheck[]

export interface Lifecycle {
    /** A transition request was inserted: it is claimed and decided on its timers. */
    transitionAsked(requestId: string): void
    /** A pilot's command was inserted: it is sent and answered on its timers. */
    commandAsked(intentId: string): void
    /** Clears every timer, so nothing runs after it. */
    close(): void
}

export interface LifecycleOptions {
    readonly db: Db
    readonly roles: { readonly canEdit: (organization: string, profile?: string) => boolean }
    readonly timings?: Partial<Timings>
    readonly onError?: (error: unknown) => void
}

/** soc-operations and soc-cloud on the database, on the demo's timers. */
export declare function createLifecycle(options: LifecycleOptions): Lifecycle

export type { Row }
