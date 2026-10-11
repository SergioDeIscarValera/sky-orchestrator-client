import { create } from 'zustand'

export type CameraCommand = 'overview' | 'closer' | 'farther'

interface Commands {
  readonly last: { readonly command: CameraCommand; readonly sequence: number } | null
  readonly send: (command: CameraCommand) => void
}

/** The map tools, outside the canvas, ask; the controls, inside it, act. */
export const useCameraCommands = create<Commands>()((set) => ({
  last: null,
  send: (command) => {
    set(({ last }) => ({ last: { command, sequence: (last?.sequence ?? 0) + 1 } }))
  },
}))
