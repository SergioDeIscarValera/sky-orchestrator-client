import { create } from 'zustand'

export type CameraCommand = 'overview' | 'closer' | 'farther' | 'frame' | 'fit'

/** A point of the scene, x east, y up, z south, in metres. */
export interface ScenePoint {
  readonly x: number
  readonly y: number
  readonly z: number
}

/** A box of the scene, from its least corner to its greatest, in metres. */
export interface SceneBox {
  readonly min: ScenePoint
  readonly max: ScenePoint
}

interface Commands {
  readonly last: {
    readonly command: CameraCommand
    readonly sequence: number
    /** What `frame` frames. */
    readonly subject?: ScenePoint
    /** What `fit` fits in view. */
    readonly box?: SceneBox
  } | null
  /** Every command but `fit`, which carries its box: see `fit`. */
  readonly send: (command: Exclude<CameraCommand, 'fit'>, subject?: ScenePoint) => void
  /** Frames the box whole in the view the cards leave free (FR-SCN-05); each call is a new command. */
  readonly fit: (box: SceneBox) => void
  /**
   * Whether the camera is mounted and takes commands. A command sent before it is, or while it is
   * not, is lost, so a sender waits for this; the controls set it once their subscription is in place.
   */
  readonly ready: boolean
  readonly setReady: (ready: boolean) => void
  /** The aircraft the camera follows, by `aircraftKey`, until unpinned or moved by the user. */
  readonly pinned: string | null
  readonly pin: (aircraft: string | null) => void
}

/** The map tools and the scene's entities ask; the controls, inside the canvas, act. */
export const useCameraCommands = create<Commands>()((set) => ({
  last: null,
  ready: false,
  setReady: (ready) => {
    set({ ready })
  },
  pinned: null,
  pin: (aircraft) => {
    set({ pinned: aircraft })
  },
  send: (command, subject) => {
    set(({ last }) => ({
      last: {
        command,
        sequence: (last?.sequence ?? 0) + 1,
        ...(subject === undefined ? {} : { subject }),
      },
    }))
  },
  fit: (box) => {
    set(({ last }) => ({
      last: { command: 'fit', sequence: (last?.sequence ?? 0) + 1, box },
    }))
  },
}))
