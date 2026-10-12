import { Html } from '@react-three/drei'
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type CameraControlsImpl from 'camera-controls'
import { Vector3, type Group } from 'three'

import { aircraftKey, type Fleet } from '../backend/backend'
import { useSelect, useSelection, useView, type Selection } from '../app/router'
import { useSettings } from '../config/settings'
import { useAircraftColours } from '../fleets/colours'
import { Swatch } from '../fleets/Swatch'
import { useFleets } from '../fleets/data'
import type { Geodetic } from '../geometry/projection'
import { useTelemetryStore, useTrack } from '../telemetry/context'
import { useFreshness } from '../telemetry/freshness'
import {
  createAircraftParts,
  disposeAircraft,
  drawnAt,
  paintAircraft,
  writeAircraft,
  type Placement,
  type ToDraw,
} from './aircraft'
import {
  ARRIVED_M,
  FIELD_OF_VIEW_DEG,
  LONGEST_FLIGHT_MS,
  coveredBy,
  flyTo,
  follow,
  framePose,
} from './camera'
import { useCameraCommands } from './commands'
import { labelLines, richLabels } from './labels'
import { useReducedMotion } from './motion'
import { usePalette } from './palette'
import type { Site } from './site'

/** More aircraft than a farm flies at once. */
const CAPACITY = 32

type Placed = ReadonlyMap<string, Placement>

function selectedKey(selection: Selection | null, fleets: readonly Fleet[] | undefined) {
  if (selection === null) return null
  if (selection.kind === 'device') return aircraftKey(selection.gatewaySn, selection.aircraftSn)
  const fleet = fleets?.find(({ id }) => id === selection.fleetId)
  return fleet === undefined ? null : aircraftKey(fleet.gatewaySn, fleet.aircraftSn)
}

/**
 * The organization's aircraft, gliding from sample to sample (FR-SCN-04,
 * FR-TEL-02). A click selects one, as its row in the fleet panel does, and the
 * camera flies to frame it beside the inspector (FR-SCN-05); the selected, the
 * hovered and the alerting carry a label (FR-SCN-06). A frame is drawn when a
 * sample arrives, when one crosses a freshness threshold, and while an aircraft
 * glides; none otherwise (NFR-RES-01). Over a baked terrain each flies at its
 * takeoff point's ground plus its height, its stalk dropping to the ground under it
 * (ADR-0014).
 */
export function Aircraft({
  origin,
  site,
}: {
  readonly origin: Geodetic | null
  readonly site: Site
}) {
  const store = useTelemetryStore()
  const settings = useSettings()
  const palette = usePalette()
  const fleets = useFleets()
  const colourOf = useAircraftColours()
  const selection = useSelection()
  const { panel } = useView()
  const select = useSelect()
  const invalidate = useThree((state) => state.invalidate)
  const parts = useMemo(() => createAircraftParts(CAPACITY), [])
  const placed = useRef<Placed>(new Map())
  const [hovered, setHovered] = useState<string | null>(null)
  const [labelled, setLabelled] = useState<readonly string[]>([])
  const selected = selectedKey(selection, fleets.data)
  const pinned = useCameraCommands((state) => state.pinned)
  const reducedMotion = useReducedMotion()
  // Pinned, the camera first flies in to frame the aircraft, then moves with it.
  const pin = useRef<{
    key: string
    arriving: boolean
    since: number
    at: Vector3 | null
  } | null>(null)

  useEffect(
    () => () => {
      disposeAircraft(parts)
    },
    [parts],
  )

  useLayoutEffect(() => {
    paintAircraft(parts, palette)
    invalidate()
  }, [parts, palette, invalidate])

  useEffect(() => {
    let timers: ReturnType<typeof setTimeout>[] = []
    const schedule = () => {
      for (const timer of timers) clearTimeout(timer)
      timers = []
      const now = performance.now()
      for (const track of store.getState().tracks.values()) {
        for (const threshold of [settings.telemetryStaleAfterMs, settings.telemetryLostAfterMs]) {
          const wait = track.latest.dueAt + threshold - now
          if (wait > 0) timers.push(setTimeout(invalidate, wait))
        }
      }
      invalidate()
    }
    schedule()
    const stop = store.subscribe(schedule)
    return () => {
      stop()
      for (const timer of timers) clearTimeout(timer)
    }
  }, [store, settings, invalidate])

  // Selecting an aircraft follows it (FR-SCN-05): the camera flies in to frame it where
  // it is first drawn, a shared link possibly selecting it before its telemetry arrives,
  // then moves with it. Clearing the selection lets go.
  useEffect(() => {
    useCameraCommands.getState().pin(selected)
    invalidate()
  }, [selected, invalidate])

  useEffect(() => {
    pin.current =
      pinned === null ? null : { key: pinned, arriving: true, since: performance.now(), at: null }
    invalidate()
  }, [pinned, invalidate])

  // The organization's aircraft are another set once it changes: nothing stays pinned.
  useEffect(
    () => () => {
      useCameraCommands.getState().pin(null)
    },
    [origin],
  )

  useFrame((state) => {
    const now = performance.now()
    const aircraft: ToDraw[] = []
    const positions = new Map<string, Placement>()
    if (origin !== null) {
      for (const [key, track] of store.getState().tracks) {
        const drawn = drawnAt(track, origin, now, settings, site.ground)
        if (drawn === null) continue
        aircraft.push({ key, drawn, colour: colourOf(key) })
        positions.set(key, drawn.placement)
      }
    }
    placed.current = positions
    const controls = state.controls as CameraControlsImpl | null
    const pinnedAt = pin.current === null ? undefined : positions.get(pin.current.key)
    if (pin.current !== null && controls !== null && pinnedAt !== undefined) {
      const at = new Vector3(pinnedAt.x, pinnedAt.y, pinnedAt.z)
      if (pin.current.arriving) {
        const camera = {
          position: controls.getPosition(new Vector3()),
          target: controls.getTarget(new Vector3()),
        }
        const pose = framePose(at, camera, state.size, coveredBy(panel !== undefined))
        void flyTo(controls, pose, site, !reducedMotion)
        // A moving subject keeps the smoothing a few metres behind: the flight ends in time.
        const arrived =
          camera.target.distanceTo(pose.target) < ARRIVED_M ||
          now - pin.current.since > LONGEST_FLIGHT_MS
        if (arrived) pin.current.arriving = false
        invalidate()
      } else if (pin.current.at !== null) {
        follow(controls, pin.current.at, at, site, state.size, coveredBy(panel !== undefined))
      }
      pin.current.at = at
    }
    writeAircraft(
      parts,
      aircraft,
      state.camera.position,
      FIELD_OF_VIEW_DEG,
      state.size.height,
      palette,
      selected,
      site.ground,
    )
    const rich = richLabels(
      aircraft.map(({ key, drawn }) => ({ key, freshness: drawn.freshness })),
      selected,
      hovered,
    )
    if (rich.join('|') !== labelled.join('|')) setLabelled(rich)
    if (aircraft.some(({ drawn }) => drawn.gliding)) invalidate()
  })

  // Only the bodies and their casings are picked; their instances share the keys' order.
  const picked = (event: ThreeEvent<PointerEvent | MouseEvent>) =>
    event.instanceId === undefined ? undefined : parts.keys[event.instanceId]

  const choose = (event: ThreeEvent<MouseEvent>) => {
    event.stopPropagation()
    const key = picked(event)
    if (key === undefined) return
    const [gatewaySn = '', aircraftSn = ''] = key.split('/')
    const fleet = fleets.data?.find(
      (candidate) => candidate.gatewaySn === gatewaySn && candidate.aircraftSn === aircraftSn,
    )
    select(
      fleet === undefined
        ? { kind: 'device', gatewaySn, aircraftSn }
        : { kind: 'fleet', fleetId: fleet.id },
    )
  }

  return (
    <>
      <primitive
        object={parts.group}
        onClick={choose}
        onPointerOver={(event: ThreeEvent<PointerEvent>) => {
          event.stopPropagation()
          setHovered(picked(event) ?? null)
          document.body.style.cursor = 'pointer'
          invalidate()
        }}
        onPointerOut={() => {
          setHovered(null)
          document.body.style.cursor = ''
          invalidate()
        }}
      />
      {labelled.map((key) => (
        <AircraftLabel
          key={key}
          aircraft={key}
          colour={colourOf(key)}
          name={nameOf(key, fleets.data)}
          placed={placed}
          selected={key === selected}
        />
      ))}
    </>
  )
}

function nameOf(key: string, fleets: readonly Fleet[] | undefined): string {
  const [gatewaySn, aircraftSn] = key.split('/')
  const fleet = fleets?.find(
    (candidate) => candidate.gatewaySn === gatewaySn && candidate.aircraftSn === aircraftSn,
  )
  return fleet?.name ?? aircraftSn ?? key
}

/** A pill above the aircraft with a pointer down to it, never over it (FR-SCN-06). */
function AircraftLabel({
  aircraft,
  colour,
  name,
  placed,
  selected,
}: {
  readonly aircraft: string
  readonly colour: number
  readonly name: string
  readonly placed: RefObject<Placed>
  readonly selected: boolean
}) {
  const [gatewaySn = '', aircraftSn = ''] = aircraft.split('/')
  const track = useTrack(gatewaySn, aircraftSn)
  const { freshness } = useFreshness(track?.latest)
  const anchor = useRef<Group>(null)

  useFrame(() => {
    const position = placed.current.get(aircraft)
    if (position === undefined || anchor.current === null) return
    anchor.current.position.set(position.x, position.y, position.z)
  })

  if (track === undefined || freshness === null) return null
  const { title, detail } = labelLines(name, track.latest.sample, freshness)
  return (
    <group ref={anchor}>
      <Html zIndexRange={[20, 0]} className="pointer-events-none">
        <div className="flex -translate-x-1/2 -translate-y-[calc(100%+22px)] flex-col items-center">
          <div
            className={`rounded-pill shadow-card dark:border-border flex flex-col items-center px-3 py-1 whitespace-nowrap dark:border ${
              selected ? 'bg-primary text-on-primary' : 'bg-surface text-heading'
            }`}
          >
            <span className="flex items-center gap-1.5">
              <Swatch colour={colour} />
              <span className="font-heading text-xs font-semibold">{title}</span>
            </span>
            <span className="text-[11px] tabular-nums">{detail}</span>
          </div>
          <div
            className={`size-0 border-x-[6px] border-t-[7px] border-x-transparent ${
              selected ? 'border-t-primary' : 'border-t-surface'
            }`}
          />
        </div>
      </Html>
    </group>
  )
}
