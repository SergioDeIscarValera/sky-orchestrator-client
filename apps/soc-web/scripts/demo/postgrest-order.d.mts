/** The rows in the order PostgREST's `order` parameter names, or as stored when it names none. */
export function ordered<T extends Record<string, unknown>>(
    rows: readonly T[],
    order: string | null,
): T[]
