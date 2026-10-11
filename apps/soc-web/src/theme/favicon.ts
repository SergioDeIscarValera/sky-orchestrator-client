/*
 * The console's favicon: the brand's dot (src/app/Brand.tsx), filled with the
 * light theme's primary token and cased in its casing token, as the design
 * system's casing rule has it. The colours are read from theme.css each time,
 * so the icon holds no colour of its own (NFR-UX-01).
 */

const THEME = '@theme'
const HEX_COLOUR = /^#[0-9a-fA-F]{6}$/

/** The light theme's declarations: the @theme block, its nested rules included. */
function themeBlock(css: string): string {
  const start = css.indexOf(`${THEME} {`)
  if (start === -1) throw new Error('theme.css has no @theme block')
  let depth = 0
  for (let index = start + THEME.length; index < css.length; index += 1) {
    if (css[index] === '{') depth += 1
    if (css[index] === '}') {
      depth -= 1
      if (depth === 0) return css.slice(start, index + 1)
    }
  }
  throw new Error('theme.css has an unclosed @theme block')
}

function token(block: string, name: 'primary' | 'casing'): string {
  const value = new RegExp(`--color-${name}:\\s*([^;]+);`).exec(block)?.[1]?.trim()
  if (value === undefined) {
    throw new Error(`theme.css has no --color-${name} token in its @theme block`)
  }
  if (!HEX_COLOUR.test(value)) {
    throw new Error(`theme.css token --color-${name} is not a six-digit hex colour`)
  }
  return value
}

/** The favicon as an SVG document: a disc of the primary token, and a thin ring of the casing token. */
export function faviconSvg(css: string): string {
  const block = themeBlock(css)
  const primary = token(block, 'primary')
  const casing = token(block, 'casing')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
  <circle cx="16" cy="16" r="12" fill="${primary}"/>
  <circle cx="16" cy="16" r="13" fill="none" stroke="${casing}" stroke-width="2"/>
</svg>
`
}
