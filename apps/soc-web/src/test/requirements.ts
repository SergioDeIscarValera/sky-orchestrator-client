import { readFileSync } from 'node:fs'

const REQUIREMENTS = new URL(
  '../../../../docs/requirements/functional-requirements.md',
  import.meta.url,
)

/** FR-OPS-05's table of preflight checks: each id in the table's order, and the ones it marks not blocking. */
export function checksOfTable(): { readonly ids: string[]; readonly notBlocking: string[] } {
  const section = readFileSync(REQUIREMENTS, 'utf8')
    .split('### FR-OPS-05')[1]
    ?.split('**Acceptance**')[0]
  if (section === undefined) throw new Error('FR-OPS-05 is not in the requirements')
  const rows = [...section.matchAll(/^\| `(PF-[A-Z-]+)` \| (.+) \|$/gm)]
  return {
    ids: rows.map((row) => row[1] ?? ''),
    notBlocking: rows.filter((row) => /not blocking/.test(row[2] ?? '')).map((row) => row[1] ?? ''),
  }
}
