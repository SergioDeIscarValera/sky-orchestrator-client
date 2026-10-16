/** A row of one of the operations' tables, as the fake holds it. */
export type Row = Record<string, unknown>

export interface LogOptions {
    readonly actor?: string | null
    readonly flight?: string | null
    readonly fleet?: string | null
    readonly command?: string | null
    readonly severity?: string
    readonly occurred?: string
}

export interface CheckInput {
    readonly check_id: string
    readonly state: string
    readonly blocking: boolean
    readonly value?: unknown
    readonly detail: string
    readonly evaluated_at: string
}

export interface ProgressFields {
    readonly result?: number | null
    readonly percent?: number | null
    readonly waypoint?: number | null
    readonly breakPoint?: Row | null
    readonly endReason?: string | null
}

export interface Db {
    rows(name: string): Row[]
    isOpen(operation: string): boolean
    changed(name: string, row: Row): void
    insertRow(name: string, row: Row): Row
    updateRow(name: string, row: Row, changes: Row): Row
    log(operation: string, kind: string, source: string, payload?: Row, options?: LogOptions): Row
    move(
        operation: string,
        to: string,
        cause: string,
        source: string,
        actor?: string | null,
        reason?: string | null,
    ): Row
    recordChecks(operation: string, checks: readonly CheckInput[]): number
    recordProgress(flight: string, status: string, fields?: ProgressFields): { changed: boolean }
    recordMoment(flight: string, moment: string, at: string, mode: number): void
    claimTransition(request: string): Row | null
    decideTransition(request: string, outcome: string, reasons?: readonly string[]): Row | null
    claimCommand(intent: string): Row | null
    replyCommand(intent: string, result: number): Row | null
    requestTransition(ask: {
        readonly operation: string
        readonly wanted: string
        readonly clientRequest: string
        readonly me: string
    }): { readonly row: Row; readonly created: boolean }
    requestCommand(ask: {
        readonly flight: string
        readonly wanted: string
        readonly clientRequest: string
        readonly me: string
    }): { readonly row: Row; readonly created: boolean }
}

export interface OperationTablesOptions {
    readonly rows: (name: string) => Row[]
    readonly publish: (organizationId: string, event: string, payload: Row) => void
    readonly roles: { readonly canEdit: (organization: string, profile?: string) => boolean }
    readonly now?: () => string
}

/** The database's side of the operations: the functions and triggers of migrations 0004 and 0010. */
export declare function createOperationTables(options: OperationTablesOptions): Db

/** A refusal the database raises: its SQLSTATE, the HTTP status it maps to, and its message. */
export declare class DatabaseError extends Error {
    readonly code: string
    readonly status: number
    readonly payload: {
        readonly code: string
        readonly message: string
        readonly details: null
        readonly hint: null
    }
}

/** The closed list of log kinds: each one's severity, its sources and its payload keys. */
export declare const EVENT_KINDS: Readonly<
    Record<
        string,
        {
            readonly severity: string
            readonly sources: readonly string[]
            readonly payload: readonly string[]
            readonly requirement: string
        }
    >
>
/** Each move of contracts/operations/lifecycle.json, as `from>to`. */
export declare const OPERATION_MOVES: ReadonlySet<string>
/** The states an operation ends in. */
export declare const TERMINAL: ReadonlySet<string>
