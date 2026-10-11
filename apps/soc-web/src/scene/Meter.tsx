import { useFrame } from '@react-three/fiber'

import { sampler } from './sampler'

/** Runs on rendered frames only, so it never asks for one. */
export function Meter() {
  useFrame((state, deltaS) => {
    sampler.record(deltaS * 1000, state.gl.info)
  })
  return null
}
