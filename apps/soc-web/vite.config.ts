/// <reference types="vitest/config" />
import { readFileSync } from 'node:fs'

import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

/** soc-web's configuration file, or null when it is not given or not JSON: the console then says so. */
function settingsFile(path: string | undefined): unknown {
  if (path === undefined) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/**
 * In development, /config.json comes from the environment and soc-web's file, as
 * the image writes it at start (FR-DEP-04, ADR-0023).
 */
function runtimeConfiguration(): Plugin {
  return {
    name: 'soc-runtime-configuration',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/config.json', (_request, response) => {
        response.setHeader('content-type', 'application/json')
        response.setHeader('cache-control', 'no-store')
        response.end(
          JSON.stringify({
            supabase_url: process.env.SOC_WEB_SUPABASE_URL ?? null,
            supabase_key: process.env.SOC_WEB_SUPABASE_KEY ?? null,
            settings: settingsFile(process.env.SOC_CONFIG_FILE),
          }),
        )
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), runtimeConfiguration()],
  build: { target: 'baseline-widely-available', sourcemap: false, manifest: true },
  test: {
    environment: 'happy-dom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    // A worker keeps the modules it imported for the next file (ADR-0022): the
    // setup resets what a test leaves in the page, and no module holds a
    // test's state.
    pool: 'threads',
    isolate: false,
  },
})
