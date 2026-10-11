// @vitest-environment node
import { readFileSync } from 'node:fs'

import { WEB_CONSTRAINTS, WEB_KEYS } from './settings'

interface Key {
  readonly type: string
  readonly minimum: number
  readonly maximum: number
  readonly 'x-consumers': readonly string[]
}

const CONTRACT = JSON.parse(
  readFileSync(
    new URL('../../../../contracts/config/soc-config.schema.json', import.meta.url),
    'utf8',
  ),
) as {
  readonly properties: Readonly<Record<string, Key>>
  readonly 'x-constraints': readonly string[]
  readonly 'x-environment': Readonly<Record<string, { readonly 'x-consumers': readonly string[] }>>
}

const consoleKeys = Object.entries(CONTRACT.properties).filter(([, key]) =>
  key['x-consumers'].includes('soc-web'),
)

describe("the console's keys of the configuration contract (IR-CFG)", () => {
  it('are the keys the contract gives soc-web, with their types and ranges', () => {
    expect(WEB_KEYS).toEqual(
      Object.fromEntries(
        consoleKeys.map(([name, { type, minimum, maximum }]) => [name, { type, minimum, maximum }]),
      ),
    )
  })

  it("hold every relation the contract words between the console's keys", () => {
    const names = consoleKeys.map(([name]) => name)
    const between = CONTRACT['x-constraints'].filter((constraint) => {
      const mentioned = constraint.match(/[a-z_]+(?:\[\])?(?:\.[a-z_]+)?/g) ?? []
      return (
        mentioned.some((word) => names.includes(word)) &&
        mentioned.filter((word) => word.includes('_')).every((word) => names.includes(word))
      )
    })
    expect([...WEB_CONSTRAINTS]).toEqual(between)
  })

  it("come from the console's own file", () => {
    expect(CONTRACT['x-environment'].SOC_CONFIG_FILE?.['x-consumers']).toContain('soc-web')
  })
})
