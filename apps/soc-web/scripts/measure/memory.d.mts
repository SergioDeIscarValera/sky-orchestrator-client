export interface HeapSample {
    readonly minute: number
    readonly bytes: number
}

export interface Session {
    readonly heap: readonly HeapSample[]
    readonly gpuBytes: number | null
}

export interface MemoryContext {
    readonly aircraft: number
    readonly site: string
    readonly gpu: string
}

export declare const HEAP_BUDGET_BYTES: number
export declare const HEAP_TREND_LIMIT: number
export declare const FROM_MINUTE: number
export declare const SESSION_MINUTES: number
export declare const GPU_BUDGET_BYTES: number

export declare function inMegabytes(bytes: number): string
export declare function heapTrend(samples: readonly HeapSample[]): number | null
export declare function memoryVerdict(
    session: Session,
    context: MemoryContext,
): { readonly ok: boolean; readonly report: string }
