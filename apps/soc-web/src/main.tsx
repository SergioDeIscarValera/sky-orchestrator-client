import '@fontsource/montserrat/latin-600.css'
import './theme/theme.css'

import { QueryClient } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './app/App'
import { StartupProblem } from './app/StartupProblem'
import { supabaseBackend } from './backend/supabase'
import { ConfigurationError, loadRuntimeConfiguration } from './config/runtime'
import { applyTheme, followSystemTheme, preferredTheme } from './theme/theme'

applyTheme(preferredTheme())
followSystemTheme()

const element = document.getElementById('root')
if (element === null) throw new Error('index.html has no #root element')
const root = createRoot(element)

loadRuntimeConfiguration().then(
  (configuration) => {
    root.render(
      <StrictMode>
        <App
          backend={supabaseBackend(configuration)}
          queryClient={new QueryClient({ defaultOptions: { queries: { retry: 1 } } })}
          settings={configuration.settings}
        />
      </StrictMode>,
    )
  },
  (error: unknown) => {
    const problems = error instanceof ConfigurationError ? error.problems : [String(error)]
    root.render(<StartupProblem problems={problems} />)
  },
)
