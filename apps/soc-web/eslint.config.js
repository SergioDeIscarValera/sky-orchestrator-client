import js from '@eslint/js'
import { defineConfig, globalIgnores } from 'eslint/config'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import globals from 'globals'
import tseslint from 'typescript-eslint'

import { cameraModuleRules, consoleRules } from './lint-rules.js'

export default defineConfig([
  globalIgnores(['dist', 'dist-measure', 'node_modules']),
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
    rules: consoleRules,
  },
  {
    files: ['src/scene/camera.ts'],
    rules: cameraModuleRules,
  },
  {
    files: ['src/test/lint.test.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  {
    files: ['scripts/**/*.mjs', 'eslint.config.js', 'lint-rules.js'],
    extends: [js.configs.recommended],
    languageOptions: { globals: globals.node },
  },
])
