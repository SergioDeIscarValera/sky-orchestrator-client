/// <reference types="vitest/config" />
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

/** In development, /config.json comes from the environment, as the image writes it at start (FR-DEP-04). */
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
  },
})
