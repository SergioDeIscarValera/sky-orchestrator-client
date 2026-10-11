/// <reference types="vitest/config" />
import { readFileSync } from 'node:fs'
import { extname, resolve, sep } from 'node:path'

import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type Connect, type Plugin } from 'vite'

import { faviconSvg } from './src/theme/favicon.ts'

/** soc-web's configuration file, or null when it is not given or not JSON: the console then says so. */
function settingsFile(path: string | undefined): unknown {
  if (path === undefined) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

const serveConfiguration: Connect.NextHandleFunction = (_request, response) => {
  response.setHeader('content-type', 'application/json')
  response.setHeader('cache-control', 'no-store')
  response.end(
    JSON.stringify({
      supabase_url: process.env.SOC_WEB_SUPABASE_URL ?? null,
      supabase_key: process.env.SOC_WEB_SUPABASE_KEY ?? null,
      settings: settingsFile(process.env.SOC_CONFIG_FILE),
    }),
  )
}

/**
 * In development and in `vite preview`, /config.json comes from the environment
 * and soc-web's file, as the image writes it at start (FR-DEP-04, ADR-0023).
 */
function runtimeConfiguration(): Plugin {
  return {
    name: 'soc-runtime-configuration',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/config.json', serveConfiguration)
    },
    configurePreviewServer(server) {
      server.middlewares.use('/config.json', serveConfiguration)
    },
  }
}

/**
 * The console's favicon, drawn from the theme's tokens (NFR-UX-01): served at
 * /favicon.svg in development and emitted as the same file in the build.
 */
function favicon(): Plugin {
  const svg = (): string =>
    faviconSvg(readFileSync(new URL('./src/theme/theme.css', import.meta.url), 'utf8'))
  return {
    name: 'soc-favicon',
    configureServer(server) {
      server.middlewares.use('/favicon.svg', (_request, response) => {
        response.setHeader('content-type', 'image/svg+xml')
        response.end(svg())
      })
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'favicon.svg', source: svg() })
    },
  }
}

const SITE_TYPES: Readonly<Record<string, string>> = {
  '.json': 'application/json',
  '.f32': 'application/octet-stream',
  '.png': 'image/png',
}

const serveSiteModel: Connect.NextHandleFunction = (request, response) => {
  const root = process.env.SOC_SITE_DIR
  const wanted = decodeURIComponent((request.url ?? '').split('?')[0] ?? '')
  const file = root === undefined ? null : resolve(root, `.${wanted}`)
  const type = file === null ? undefined : SITE_TYPES[extname(file)]
  if (
    root === undefined ||
    file === null ||
    type === undefined ||
    !file.startsWith(resolve(root) + sep)
  ) {
    response.statusCode = 404
    response.end()
    return
  }
  try {
    const body = readFileSync(file)
    response.setHeader('content-type', type)
    response.setHeader('cache-control', 'no-cache')
    response.end(body)
  } catch {
    response.statusCode = 404
    response.end()
  }
}

/**
 * In development and in `vite preview`, /site/<organization>/ serves the baked
 * site models in SOC_SITE_DIR, as the image serves its volume (ADR-0018); without
 * it, every site is missing and the scene keeps its flat ground.
 */
function siteModels(): Plugin {
  return {
    name: 'soc-site-models',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/site/', serveSiteModel)
    },
    configurePreviewServer(server) {
      server.middlewares.use('/site/', serveSiteModel)
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), runtimeConfiguration(), favicon(), siteModels()],
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
