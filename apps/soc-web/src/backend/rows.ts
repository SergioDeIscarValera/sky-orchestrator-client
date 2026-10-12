import { z } from '../schema'
import { BackendError } from './backend'

/** The rows a table answered, each parsed by its schema; a row SOC cannot read is refused. */
export function rows<T>(schema: z.ZodMiniType<T>, data: unknown, what: string): T[] {
  const parsed = z.array(schema).safeParse(data)
  if (!parsed.success) throw new BackendError(`soc.${what} answered rows SOC cannot read`)
  return parsed.data
}
