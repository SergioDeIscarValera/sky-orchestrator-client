/** SOC draws its scene with WebGL 2 (NFR-PORT-05); without it the console says so. */
export function supportsWebGl2(): boolean {
  try {
    return document.createElement('canvas').getContext('webgl2') !== null
  } catch {
    return false
  }
}

export function wantsStats(search: string = window.location.search): boolean {
  return new URLSearchParams(search).has('stats')
}
