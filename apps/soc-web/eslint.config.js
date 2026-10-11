import js from '@eslint/js'
import { defineConfig, globalIgnores } from 'eslint/config'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import globals from 'globals'
import tseslint from 'typescript-eslint'

const HEX_COLOUR = '/#[0-9a-fA-F]{3,8}(?![0-9a-zA-Z_-])/'
const FUNCTIONAL_COLOUR = '/\\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\\(/'
const TOKENS_ONLY = 'Colours come from the design tokens in src/theme/theme.css (NFR-UX-01).'
const PLAIN_HTTP = 'Not available over plain HTTP from a LAN address (ADR-0015, NFR-PORT-04).'

export const colourLiterals = [
  { selector: `Literal[value=${HEX_COLOUR}]`, message: TOKENS_ONLY },
  { selector: `Literal[value=${FUNCTIONAL_COLOUR}]`, message: TOKENS_ONLY },
  { selector: `TemplateElement[value.raw=${HEX_COLOUR}]`, message: TOKENS_ONLY },
  { selector: `TemplateElement[value.raw=${FUNCTIONAL_COLOUR}]`, message: TOKENS_ONLY },
]

export const secureContextApis = [
  { object: 'navigator', property: 'clipboard', message: PLAIN_HTTP },
  { object: 'navigator', property: 'serviceWorker', message: PLAIN_HTTP },
  { object: 'navigator', property: 'credentials', message: PLAIN_HTTP },
  { object: 'navigator', property: 'geolocation', message: PLAIN_HTTP },
  { object: 'navigator', property: 'storage', message: PLAIN_HTTP },
  { object: 'crypto', property: 'subtle', message: PLAIN_HTTP },
  { object: 'crypto', property: 'randomUUID', message: PLAIN_HTTP },
  { object: 'window', property: 'showSaveFilePicker', message: PLAIN_HTTP },
]

export default defineConfig([
  globalIgnores(['dist', 'node_modules']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.strictTypeChecked,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      'no-restricted-syntax': ['error', ...colourLiterals],
      'no-restricted-properties': ['error', ...secureContextApis],
    },
  },
  {
    files: ['src/test/lint.test.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  {
    files: ['scripts/**/*.mjs', 'eslint.config.js'],
    extends: [js.configs.recommended],
    languageOptions: { globals: globals.node },
  },
])
