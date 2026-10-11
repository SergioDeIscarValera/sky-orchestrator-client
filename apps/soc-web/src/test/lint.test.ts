// @vitest-environment node
import { readFileSync } from 'node:fs'

import { Linter } from 'eslint/universal'

import { consoleRules } from '../../lint-rules.js'

const linter = new Linter({ configType: 'flat' })
const OURS = Object.keys(consoleRules)

function messages(code: string): string[] {
  return linter
    .verify(
      code,
      [
        {
          files: ['**/*.jsx'],
          languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
          rules: consoleRules,
        },
      ],
      'src/main.jsx',
    )
    .filter((message) => message.ruleId !== null && OURS.includes(message.ruleId))
    .map((message) => message.message)
}

describe('the project configuration', () => {
  it('applies the console rules to every source file', () => {
    const configuration = readFileSync(new URL('../../eslint.config.js', import.meta.url), 'utf8')
    expect(configuration).toMatch(/files: \['\*\*\/\*\.\{ts,tsx\}'\],[^]*?rules: consoleRules,/)
  })
})

describe('the lint rules', () => {
  it.each([
    "export const accent = '#78c2ad'",
    'export const accent = `border-[#ff7851]`',
    "export const accent = 'rgb(120 194 173)'",
    "export const accent = 'oklch(0.7 0.1 170)'",
  ])('refuse a colour literal: %s', (code) => {
    expect(messages(code)).toContain(
      'Colours come from the design tokens in src/theme/theme.css (NFR-UX-01).',
    )
  })

  it.each([
    'export const id = crypto.randomUUID()',
    "export const write = () => navigator.clipboard.writeText('x')",
    'export const subtle = crypto.subtle',
  ])('refuse an API plain HTTP does not have: %s', (code) => {
    expect(messages(code)).toContainEqual(
      expect.stringContaining('Not available over plain HTTP from a LAN address'),
    )
  })

  it.each([
    'export const join = (auth) => auth.signUp({})',
    'export const guest = (auth) => auth.signInAnonymously()',
    'export const link = (auth) => auth.signInWithOtp({})',
  ])('refuse any way to create an account: %s', (code) => {
    expect(messages(code)).toContain(
      "SOC offers no sign-up: accounts are Virtual Origen's (FR-AUT-01).",
    )
  })

  it('refuse a modal Radix menu, whose inline style the CSP refuses', () => {
    expect(messages('export const Menu = () => <DropdownMenu.Root>x</DropdownMenu.Root>')).toEqual([
      expect.stringContaining('give it modal={false}'),
    ])
    expect(
      messages('export const Menu = () => <DropdownMenu.Root modal={false}>x</DropdownMenu.Root>'),
    ).toEqual([])
  })

  it('accept the tokens and the element ids', () => {
    expect(
      messages("export const name = 'bg-primary-subtle'\nexport const root = '#root'"),
    ).toEqual([])
  })
})
