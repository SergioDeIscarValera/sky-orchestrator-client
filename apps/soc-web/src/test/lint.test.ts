// @vitest-environment node
import { ESLint } from 'eslint'

const eslint = new ESLint({ cwd: new URL('../..', import.meta.url).pathname })

const OURS = new Set(['no-restricted-syntax', 'no-restricted-properties'])

async function messages(code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: 'src/main.tsx' })
  return (result?.messages ?? [])
    .filter((message) => message.ruleId !== null && OURS.has(message.ruleId))
    .map((message) => message.message)
}

describe('the lint rules', () => {
  it.each([
    "export const accent = '#78c2ad'",
    'export const accent = `border-[#ff7851]`',
    "export const accent = 'rgb(120 194 173)'",
    "export const accent = 'oklch(0.7 0.1 170)'",
  ])('refuse a colour literal: %s', async (code) => {
    expect(await messages(code)).toContain(
      'Colours come from the design tokens in src/theme/theme.css (NFR-UX-01).',
    )
  })

  it.each([
    'export const id = crypto.randomUUID()',
    "export const write = () => navigator.clipboard.writeText('x')",
    'export const subtle = crypto.subtle',
  ])('refuse an API plain HTTP does not have: %s', async (code) => {
    expect(await messages(code)).toContainEqual(
      expect.stringContaining('Not available over plain HTTP from a LAN address'),
    )
  })

  it('accept the tokens and the element ids', async () => {
    expect(
      await messages("export const name = 'bg-primary-subtle'\nexport const root = '#root'"),
    ).toEqual([])
  })
})
