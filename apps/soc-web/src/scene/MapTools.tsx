import { Minus, Plus, Scan } from 'lucide-react'

import { useCameraCommands, type CameraCommand } from './commands'

const TOOLS: readonly { command: CameraCommand; label: string; Icon: typeof Plus }[] = [
  { command: 'closer', label: 'Closer', Icon: Plus },
  { command: 'farther', label: 'Farther', Icon: Minus },
  { command: 'overview', label: 'Back to the site overview', Icon: Scan },
]

export function MapTools() {
  const send = useCameraCommands((state) => state.send)
  return (
    <div
      role="toolbar"
      aria-label="Map tools"
      className="rounded-card bg-surface shadow-card pointer-events-auto flex flex-col gap-1 p-2"
    >
      {TOOLS.map(({ command, label, Icon }) => (
        <button
          key={command}
          type="button"
          title={label}
          aria-label={label}
          onClick={() => {
            send(command)
          }}
          className="text-muted hover:bg-primary-subtle hover:text-primary-emphasis grid size-9 place-items-center rounded-xl transition-colors duration-200"
        >
          <Icon size={18} aria-hidden />
        </button>
      ))}
    </div>
  )
}
