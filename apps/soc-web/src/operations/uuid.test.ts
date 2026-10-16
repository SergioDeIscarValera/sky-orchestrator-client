// @vitest-environment node
import { z } from '../schema'
import { uuidV4 } from './uuid'

const VERSION_4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('the client request ids a transition or a command is asked with (FR-OPS-09, FR-CMD-06)', () => {
  it('is a version 4 UUID, as the database column takes it', () => {
    const id = uuidV4()
    expect(id).toMatch(VERSION_4)
    expect(z.safeParse(z.uuid(), id).success).toBe(true)
  })

  it('sets the version and the variant bits of the random bytes it is given', () => {
    expect(uuidV4(() => new Uint8Array(16))).toBe('00000000-0000-4000-8000-000000000000')
    expect(uuidV4((bytes) => bytes.fill(0xff))).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff')
    expect(uuidV4((bytes) => bytes.fill(0xab))).toBe('abababab-abab-4bab-abab-abababababab')
  })

  it('draws its bytes from the platform generator, which plain HTTP has', () => {
    const generator = vi.spyOn(crypto, 'getRandomValues')
    try {
      expect(uuidV4()).toMatch(VERSION_4)
      expect(generator).toHaveBeenCalledOnce()
      expect(generator.mock.calls[0]?.[0]).toBeInstanceOf(Uint8Array)
      expect(generator.mock.calls[0]?.[0]?.byteLength).toBe(16)
    } finally {
      generator.mockRestore()
    }
  })

  it('is new each time: a request is asked once, with an id no other request holds', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => uuidV4()))
    expect(ids.size).toBe(1000)
  })
})
