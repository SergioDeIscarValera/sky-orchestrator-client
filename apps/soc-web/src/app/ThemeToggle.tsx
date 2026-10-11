import { Moon, Sun } from 'lucide-react'
import { useState } from 'react'

import { applyTheme, preferredTheme, type Theme } from '../theme/theme'

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(() =>
    document.documentElement.dataset.theme === 'dark' ? 'dark' : preferredTheme(),
  )
  const next: Theme = theme === 'dark' ? 'light' : 'dark'

  return (
    <button
      type="button"
      className="rounded-pill text-muted hover:bg-primary-subtle hover:text-primary-emphasis grid size-9 place-items-center transition-colors duration-200"
      aria-label={`Switch to the ${next} theme`}
      onClick={() => {
        applyTheme(next)
        setTheme(next)
      }}
    >
      {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
    </button>
  )
}
