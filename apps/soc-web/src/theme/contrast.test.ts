// @vitest-environment node
import { readFileSync } from 'node:fs'

const CSS = readFileSync(new URL('./theme.css', import.meta.url), 'utf8')
const AA_TEXT = 4.5
const HUES = ['primary', 'secondary', 'success', 'info', 'warning', 'danger'] as const

function declarations(block: string): Map<string, string> {
  const found = new Map<string, string>()
  for (const match of block.matchAll(/--color-([a-z-]+):\s*(#[0-9a-f]{6});/g)) {
    const [, name, value] = match
    if (name !== undefined && value !== undefined) found.set(name, value)
  }
  return found
}

function block(selector: string): string {
  const start = CSS.indexOf(selector)
  return CSS.slice(start, CSS.indexOf('\n}', start))
}

const light = declarations(block('@theme {'))
const dark = new Map([...light, ...declarations(block("[data-theme='dark'] {"))])

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255)
  const [r, g, b] = channels.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0)
}

function contrast(foreground: string, background: string): number {
  const [high, low] = [luminance(foreground), luminance(background)].sort((a, b) => b - a)
  return ((high ?? 0) + 0.05) / ((low ?? 0) + 0.05)
}

function pairs(): [string, string][] {
  const text = ['text', 'heading', 'muted'].flatMap((token) => [
    [token, 'page'] as [string, string],
    [token, 'surface'] as [string, string],
  ])
  const pills = HUES.map((hue) => [`${hue}-emphasis`, `${hue}-subtle`] as [string, string])
  return [...text, ...pills]
}

describe.each([
  ['light', light],
  ['dark', dark],
])('the %s theme', (_, tokens) => {
  it.each(pairs())('%s on %s meets WCAG AA', (foreground, background) => {
    const ratio = contrast(tokens.get(foreground) ?? '', tokens.get(background) ?? '')
    expect(ratio).toBeGreaterThanOrEqual(AA_TEXT)
  })
})

describe('the token file', () => {
  it('declares every token the contrast pairs read, in both themes', () => {
    for (const [foreground, background] of pairs()) {
      expect(light.has(foreground) && light.has(background)).toBe(true)
    }
    for (const name of ['page', 'surface', 'text', 'heading', 'muted']) {
      expect(declarations(block("[data-theme='dark'] {")).has(name)).toBe(true)
    }
  })

  it("keeps Minty's hues as fills, never as body text", () => {
    expect(contrast(light.get('primary') ?? '', light.get('surface') ?? '')).toBeLessThan(AA_TEXT)
  })
})
