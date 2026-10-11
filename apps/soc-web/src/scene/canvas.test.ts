// @vitest-environment node
import { CANVAS_SETTINGS } from './canvas'

describe("the scene's rendering rules (ADR-0016, NFR-RES-01)", () => {
  it('renders on demand, capped at a pixel ratio of 1.5, on the low-power GPU', () => {
    expect(CANVAS_SETTINGS.frameloop).toBe('demand')
    expect(Math.max(...CANVAS_SETTINGS.dpr)).toBe(1.5)
    expect(CANVAS_SETTINGS.gl.powerPreference).toBe('low-power')
  })

  it("leaves the tokens' colours as they are, with no tone mapping", () => {
    expect(CANVAS_SETTINGS.flat).toBe(true)
  })
})
