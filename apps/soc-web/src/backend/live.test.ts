import { openLive } from './live'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('a live subscription opened above the regions (FR-CMD-07)', () => {
  it('is the subscription it opens, and stops it', () => {
    const stop = vi.fn()
    openLive('telemetry', () => stop)()
    expect(stop).toHaveBeenCalledOnce()
  })

  it('reports one that throws as it opens, and leaves a stop that does nothing', () => {
    const failure = new Error('the socket is closed')
    const report = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const stop = openLive('telemetry', () => {
      throw failure
    })
    expect(report).toHaveBeenCalledWith('The telemetry subscription did not open', failure)
    expect(() => {
      stop()
    }).not.toThrow()
  })
})
