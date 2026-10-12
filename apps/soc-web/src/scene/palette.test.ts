import { act, renderHook } from '@testing-library/react'

import { readPalette, usePalette } from './palette'

const AIRCRAFT = ['teal', 'royalblue', 'mediumpurple', 'hotpink', 'olivedrab', 'peru']
const LIGHT = {
  page: 'white',
  surface: 'ivory',
  border: 'gainsboro',
  muted: 'gray',
  primary: 'teal',
  casing: 'darkslategray',
  ...Object.fromEntries(AIRCRAFT.map((colour, index) => [`aircraft-${String(index + 1)}`, colour])),
}
const DARK = {
  ...LIGHT,
  page: 'black',
  surface: 'dimgray',
  border: 'slategray',
  muted: 'silver',
  primary: 'teal',
  casing: 'whitesmoke',
}

function theme(name: 'light' | 'dark', tokens: typeof LIGHT): void {
  const root = document.documentElement
  for (const [token, value] of Object.entries(tokens)) {
    root.style.setProperty(`--color-${token}`, value)
  }
  root.dataset.theme = name
}

describe("the scene's palette (FR-SCN-08)", () => {
  it('reads the design tokens of the current theme', () => {
    theme('light', LIGHT)
    expect(readPalette()).toEqual({
      page: 'white',
      ground: 'ivory',
      gridMinor: 'gainsboro',
      gridMajor: 'gray',
      accent: 'teal',
      casing: 'darkslategray',
      aircraft: AIRCRAFT,
    })
  })

  it('follows a change of theme without a reload', async () => {
    theme('light', LIGHT)
    const { result } = renderHook(() => usePalette())
    expect(result.current.page).toBe('white')
    await act(async () => {
      theme('dark', DARK)
      await Promise.resolve()
    })
    expect(result.current).toMatchObject({ page: 'black', ground: 'dimgray' })
  })

  it('reads the tokens again for a theme changed while nothing watched', () => {
    theme('light', LIGHT)
    const first = renderHook(() => usePalette())
    first.unmount()
    theme('dark', DARK)
    expect(renderHook(() => usePalette()).result.current.page).toBe('black')
  })
})
