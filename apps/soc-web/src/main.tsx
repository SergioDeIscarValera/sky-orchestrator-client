import '@fontsource/montserrat/latin-600.css'
import './theme/theme.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { Shell } from './app/Shell'
import { applyTheme, preferredTheme } from './theme/theme'

applyTheme(preferredTheme())

const root = document.getElementById('root')
if (root === null) throw new Error('index.html has no #root element')

createRoot(root).render(
  <StrictMode>
    <Shell />
  </StrictMode>,
)
