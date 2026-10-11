// @vitest-environment node
import { readFileSync } from 'node:fs'

import { MODEL } from '../test/site'
import { SITE_MODEL, SiteModelError, loadSite, siteBase } from './siteModel'

interface Schema {
  readonly required?: readonly string[]
  readonly properties?: Readonly<Record<string, Schema>>
  readonly $ref?: string
  readonly $defs?: Readonly<Record<string, Schema>>
}

const CONTRACT = JSON.parse(
  readFileSync(new URL('../../../../contracts/site/site.schema.json', import.meta.url), 'utf8'),
) as Schema

/** Every object path the contract requires, its $refs followed. */
function requiredPaths(schema: Schema, prefix = ''): string[] {
  const resolved =
    schema.$ref === undefined
      ? schema
      : (CONTRACT.$defs?.[schema.$ref.split('/').at(-1) ?? ''] ?? {})
  return (resolved.required ?? []).flatMap((key) => {
    const child = resolved.properties?.[key] ?? {}
    return [`${prefix}${key}`, ...requiredPaths(child, `${prefix}${key}.`)]
  })
}

function paths(value: unknown, prefix = ''): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return []
  return Object.entries(value).flatMap(([key, child]) => [
    `${prefix}${key}`,
    ...paths(child, `${prefix}${key}.`),
  ])
}

/** A server that answers afresh on every request, as a response's body reads once. */
function answering(routes: Record<string, () => Response>): typeof fetch {
  return (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    return Promise.resolve(routes[url]?.() ?? new Response('', { status: 404 }))
  }
}

function grid(values: readonly number[]): ArrayBuffer {
  const buffer = new ArrayBuffer(values.length * 4)
  const view = new DataView(buffer)
  values.forEach((value, index) => {
    view.setFloat32(index * 4, value, true)
  })
  return buffer
}

const BASE = siteBase('org-1')

describe('a site model, as its contract says (ADR-0018)', () => {
  it('reads every field the contract requires, and refuses one it does not know', () => {
    expect(paths(MODEL).sort()).toEqual(requiredPaths(CONTRACT).sort())
    expect(SITE_MODEL.safeParse(MODEL).success).toBe(true)
    expect(SITE_MODEL.safeParse({ ...MODEL, extra: 1 }).success).toBe(false)
    expect(SITE_MODEL.safeParse({ ...MODEL, half_size_m: 6000 }).success).toBe(false)
  })
})

describe('loading a site model (FR-SCN-02)', () => {
  it('is none when the organization has no model', async () => {
    await expect(loadSite('org-1', answering({}))).resolves.toBeNull()
  })

  it('reads the heights little-endian, rows from north, and points at the imagery', async () => {
    const heights = [700, 695, 690, 695, 690, 685, 690, 685, 680]
    const loaded = await loadSite(
      'org-1',
      answering({
        [`${BASE}site.json`]: () => Response.json(MODEL),
        [`${BASE}elevation.f32`]: () => new Response(grid(heights)),
      }),
    )
    expect(Array.from(loaded?.heights ?? [])).toEqual(heights)
    expect(loaded?.imageryUrl).toBe('/site/org-1/imagery.png')
  })

  it.each([
    [
      'a model off its contract',
      { [`${BASE}site.json`]: () => Response.json({ ...MODEL, frame: 3 }) },
      'does not follow its contract',
    ],
    [
      'a grid of the wrong size',
      {
        [`${BASE}site.json`]: () => Response.json(MODEL),
        [`${BASE}elevation.f32`]: () => new Response(grid([1, 2])),
      },
      'holds 8 bytes, not the 36',
    ],
    [
      'a server error',
      { [`${BASE}site.json`]: () => new Response('', { status: 500 }) },
      'answered HTTP 500',
    ],
  ])('refuses %s rather than draw a wrong ground', async (_name, routes, message) => {
    await expect(loadSite('org-1', answering(routes))).rejects.toThrow(SiteModelError)
    await expect(loadSite('org-1', answering(routes))).rejects.toThrow(message)
  })
})
