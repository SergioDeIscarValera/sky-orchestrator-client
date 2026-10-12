// @vitest-environment node
import { geodeticAt, type Geodetic } from '../geometry/projection'
import { FLAT_SITE, type Site } from './site'
import { flownPath } from './waylinePath'

const FARM: Geodetic = { latitudeDeg: 41.6523, longitudeDeg: -4.7245 }
const at = (east: number, north: number) => geodeticAt(FARM, { eastM: east, northM: north })

/** Ground rising 1 m for every 10 m east. */
const SLOPE: Site = { ...FLAT_SITE, ground: (x) => x / 10 }

describe('a wayline as it flies (FR-WAY-07, ADR-0014)', () => {
  it('climbs over the takeoff, then flies each waypoint at its height above the takeoff', () => {
    const path = flownPath(
      {
        referencePoint: at(100, 0),
        takeoffSecurityHeightM: 20,
        waypoints: [
          { ...at(100, 50), heightM: 30 },
          { ...at(300, 50), heightM: 35 },
        ],
      },
      FARM,
      SLOPE,
    )
    const rounded = path.points.map((point) => point.map((value) => Math.round(value * 1e6) / 1e6))
    // The takeoff's ground is 10 m up the slope: every height is above it, not the ground below.
    expect(rounded).toEqual([
      [100, 10, -0],
      [100, 30, -0],
      [100, 40, -50],
      [300, 45, -50],
    ])
    expect(path.waypoints).toEqual(path.points.slice(2))
  })

  it('rises straight to the first waypoint where the climb is not known', () => {
    const path = flownPath(
      {
        referencePoint: at(0, 0),
        takeoffSecurityHeightM: null,
        waypoints: [{ ...at(0, 10), heightM: 30 }],
      },
      FARM,
      FLAT_SITE,
    )
    expect(path.points).toHaveLength(2)
  })
})
