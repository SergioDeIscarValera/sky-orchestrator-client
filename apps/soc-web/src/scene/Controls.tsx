import { CameraControls } from '@react-three/drei'
import { useThree } from '@react-three/fiber'
import type CameraControlsImpl from 'camera-controls'
import { useEffect, useRef } from 'react'
import { Vector3 } from 'three'

import {
  configureControls,
  coveredBy,
  flyTo,
  framePose,
  keepAboveTerrain,
  overviewPose,
} from './camera'
import { useView } from '../app/router'
import type { Site } from './site'
import { useCameraCommands } from './commands'
import { useReducedMotion } from './motion'

const CLOSER = 0.35
const FARTHER = -0.5

interface Props {
  readonly site: Site
  readonly organizationId: string
}

/** Orbit, pan, zoom and tilt within the site's limits; the map tools' commands. */
export function Controls({ site, organizationId }: Props) {
  const ref = useRef<CameraControlsImpl>(null)
  const invalidate = useThree((state) => state.invalidate)
  const size = useThree((state) => state.size)
  const { panel } = useView()
  const reducedMotion = useReducedMotion()

  useEffect(() => {
    const controls = ref.current
    if (controls === null) return
    configureControls(controls, site, reducedMotion)
    void flyTo(controls, overviewPose(site), site, false)
    invalidate()
  }, [site, organizationId, reducedMotion, invalidate])

  // No gesture takes the camera into the terrain, nor its target under it (FR-SCN-03).
  useEffect(() => {
    const controls = ref.current
    if (controls === null) return
    const keep = () => {
      keepAboveTerrain(controls, site)
    }
    controls.addEventListener('control', keep)
    return () => {
      controls.removeEventListener('control', keep)
    }
  }, [site])

  // The user taking the camera unpins whatever it followed (FR-SCN-05).
  useEffect(() => {
    const controls = ref.current
    if (controls === null) return
    const unpin = () => {
      useCameraCommands.getState().pin(null)
    }
    controls.addEventListener('controlstart', unpin)
    return () => {
      controls.removeEventListener('controlstart', unpin)
    }
  }, [])

  useEffect(
    () =>
      useCameraCommands.subscribe(({ last }, previous) => {
        if (last === previous.last) return
        const controls = ref.current
        if (controls === null || last === null) return
        const transition = !reducedMotion
        if (last.command === 'overview') {
          useCameraCommands.getState().pin(null)
          void flyTo(controls, overviewPose(site), site, transition)
        } else if (last.command === 'frame') {
          if (last.subject === undefined) return
          const camera = {
            position: controls.getPosition(new Vector3()),
            target: controls.getTarget(new Vector3()),
          }
          const { x, y, z } = last.subject
          const pose = framePose(new Vector3(x, y, z), camera, size, coveredBy(panel !== undefined))
          void flyTo(controls, pose, site, transition)
        } else {
          const share = last.command === 'closer' ? CLOSER : FARTHER
          void controls.dolly(controls.distance * share, transition)
          keepAboveTerrain(controls, site)
        }
        invalidate()
      }),
    [site, reducedMotion, invalidate, size, panel],
  )

  return <CameraControls ref={ref} makeDefault />
}
