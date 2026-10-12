import { useFrame, useThree } from '@react-three/fiber'
import { useEffect } from 'react'

import { gpuMemory } from './gpuMemory'
import { sampler } from './sampler'

/** Runs on rendered frames only, so it never asks for one; and lets the sampler read the GPU's share. */
export function Meter() {
  const scene = useThree((state) => state.scene)
  useEffect(() => {
    sampler.gpuMemory = () => gpuMemory(scene)
    return () => {
      sampler.gpuMemory = () => null
    }
  }, [scene])
  useFrame((state, deltaS) => {
    sampler.record(deltaS * 1000, state.gl.info)
  })
  return null
}
