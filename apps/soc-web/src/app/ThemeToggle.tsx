import { Moon, Sun } from 'lucide-react'

import { chooseTheme, useTheme, type Theme } from '../theme/theme'

/** Switches the theme and keeps the choice on this device; until then the system's is followed. */
export function ThemeToggle() {
  const theme = useTheme()
  const next: Theme = theme === 'dark' ? 'light' : 'dark'

  return (
    <button
      type="button"
      className="rounded-pill text-muted hover:bg-primary-subtle hover:text-primary-emphasis grid size-9 place-items-center transition-colors duration-200"
      aria-label={`Switch to the ${next} theme`}
      onClick={() => {
        chooseTheme(next)
      }}
    >
      {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
    </button>
  )
}
