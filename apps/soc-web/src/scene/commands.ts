import { create } from 'zustand'

export type CameraCommand = 'overview' | 'closer' | 'farther' | 'frame'

/** A point of the scene, x east, y up, z south, in metres. */
export interface ScenePoint {
  readonly x: number
  readonly y: number
  readonly z: number
}

interface Commands {
  readonly last: {
    readonly command: CameraCommand
    readonly sequence: number
    /** What `frame` frames. */
    readonly subject?: ScenePoint
  } | null
  readonly send: (command: CameraCommand, subject?: ScenePoint) => void
}

/** The map tools and the scene's entities ask; the controls, inside the canvas, act. */
export const useCameraCommands = create<Commands>()((set) => ({
  last: null,
  send: (command, subject) => {
    set(({ last }) => ({
      last: {
        command,
        sequence: (last?.sequence ?? 0) + 1,
        ...(subject === undefined ? {} : { subject }),
      },
    }))
  },
}))
