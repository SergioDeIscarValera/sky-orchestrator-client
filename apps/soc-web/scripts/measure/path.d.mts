export interface Viewport {
    readonly width: number
    readonly height: number
}

export type Step =
    | {
          readonly action: 'orbit'
          readonly seconds: number
          readonly across: number
          readonly down: number
      }
    | { readonly action: 'follow'; readonly seconds: number }
    | { readonly action: 'tool'; readonly label: string; readonly seconds: number }

export interface Arguments {
    readonly site: string | null
    readonly chrome: string | null
    readonly theme: 'light' | 'dark'
    readonly shots: string | null
    readonly headed: boolean
    readonly serve: boolean
    readonly memory: boolean
    readonly minutes: number
}

export interface Run {
    readonly frames: number
    readonly p95Ms: number | null
    readonly worstMs: number | null
}

export interface Context {
    readonly seconds: number
    readonly theme: string
    readonly site: string
    readonly gpu: string
    readonly shots?: boolean
    /** What the scene held on the GPU at the end, in bytes (NFR-RES-03). */
    readonly gpuBytes?: number | null
}

export declare const BUDGET_MS: number
export declare const VIEWPORT: Viewport
export declare const AIRCRAFT: number
export declare const SETTLE_MS: number
export declare const PATH: readonly Step[]
export declare function pathSeconds(path?: readonly Step[]): number
export declare function measuredUrl(base: string): string
export declare function dragCentre(viewport?: Viewport): { x: number; y: number }
export declare function orbitMoves(
    step: Extract<Step, { action: 'orbit' }>,
    viewport?: Viewport,
): { x: number; y: number }[]
export declare function parseArguments(argv: readonly string[]): Arguments
export declare function chromePath(
    given: string | null,
    path?: string,
    exists?: (file: string) => boolean,
): string
export declare function verdict(run: Run | null, context: Context): { ok: boolean; report: string }
