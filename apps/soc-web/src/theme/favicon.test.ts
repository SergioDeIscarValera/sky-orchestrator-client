// @vitest-environment node
import { readFileSync } from 'node:fs'

import { faviconSvg } from './favicon'

const CSS = readFileSync(new URL('./theme.css', import.meta.url), 'utf8')
const LIGHT = CSS.slice(CSS.indexOf('@theme {'), CSS.indexOf('\n}', CSS.indexOf('@theme {')))

function token(name: string): string {
  const value = new RegExp(`--color-${name}:\\s*([^;]+);`).exec(LIGHT)?.[1]?.trim()
  if (value === undefined) throw new Error(`theme.css has no --color-${name} in its @theme block`)
  return value
}

const PRIMARY = token('primary')
const CASING = token('casing')
const SVG = faviconSvg(CSS)

/** theme.css with one token taken out of the light theme; the dark theme keeps its own. */
function withoutLightToken(name: string): string {
  const line = new RegExp(`^\\s*--color-${name}:.*\\n`, 'm')
  return CSS.replace(LIGHT, () => LIGHT.replace(line, ''))
}

describe('the favicon (NFR-UX-01)', () => {
  it('is an SVG document with a 32 by 32 viewBox', () => {
    expect(SVG.startsWith('<svg ')).toBe(true)
    expect(SVG).toContain('xmlns="http://www.w3.org/2000/svg"')
    expect(SVG).toMatch(/^<svg\b[^>]*\bviewBox="0 0 32 32"/)
    expect(SVG.trimEnd().endsWith('</svg>')).toBe(true)
  })

  it('draws the brand dot: a disc in the primary token, and its ring in the casing token', () => {
    const [disc, ring, ...rest] = SVG.match(/<circle\b[^>]*\/>/g) ?? []
    expect(rest).toEqual([])
    expect(disc).toContain(`fill="${PRIMARY}"`)
    expect(ring).toContain(`stroke="${CASING}"`)
  })

  it('uses exactly the primary and casing tokens, and no other colour', () => {
    expect(new Set(SVG.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [])).toEqual(new Set([PRIMARY, CASING]))
    const paints = [...SVG.matchAll(/\s(?:fill|stroke)="([^"]*)"/g)].map(([, paint]) => paint)
    expect(new Set(paints)).toEqual(new Set([PRIMARY, CASING, 'none']))
  })

  it('paints with the tokens it is given, so the icon follows the theme', () => {
    const swapped = CSS.replace(LIGHT, () =>
      LIGHT.replace(`--color-primary: ${PRIMARY};`, `--color-primary: ${CASING};`).replace(
        `--color-casing: ${CASING};`,
        `--color-casing: ${PRIMARY};`,
      ),
    )
    const icon = faviconSvg(swapped)
    expect(icon).toContain(`fill="${CASING}"`)
    expect(icon).toContain(`stroke="${PRIMARY}"`)
  })

  it.each(['primary', 'casing'])(
    'throws an error naming --color-%s when the light theme does not declare it',
    (name) => {
      expect(() => faviconSvg(withoutLightToken(name))).toThrow(`--color-${name}`)
    },
  )

  it('does not fall back to a dark override of the casing token', () => {
    expect(CSS).toMatch(/\[data-theme='dark'\] \{[^}]*--color-casing:/)
    expect(() => faviconSvg(withoutLightToken('casing'))).toThrow('--color-casing')
  })

  it('refuses a token that is not a six-digit hex colour, rather than writing it into the markup', () => {
    const hostile = CSS.replace(LIGHT, () =>
      LIGHT.replace(/--color-primary:\s*[^;]+;/, () => '--color-primary: "><script>;'),
    )
    expect(() => faviconSvg(hostile)).toThrow('--color-primary')
  })

  it('throws when the CSS has no @theme block, or the block is not closed', () => {
    expect(() => faviconSvg('body { margin: 0; }')).toThrow('no @theme block')
    expect(() => faviconSvg(LIGHT)).toThrow('unclosed')
  })
})

describe('the page', () => {
  it('declares the icon, so the browser stops asking for /favicon.ico', () => {
    const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8')
    expect(html).toContain('<link rel="icon" type="image/svg+xml" href="/favicon.svg" />')
  })
})
