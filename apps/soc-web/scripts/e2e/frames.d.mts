export interface Sample {
    readonly topic: string
    readonly aircraftSn: string
    readonly takenAtMs: number
    readonly sentAtMs: number
}

export interface Summary {
    readonly count: number
    readonly p50: number | null
    readonly p95: number | null
    readonly p99: number | null
    readonly worst: number | null
}

export declare function sampleOf(frame: string | Uint8Array): Sample | null
export declare function percentile(values: readonly number[], fraction: number): number | null
export declare function summary(latencies: readonly number[]): Summary
