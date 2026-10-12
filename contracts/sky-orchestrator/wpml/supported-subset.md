# Supported WPML subset

The part of DJI's WPML that `so-wayline` accepts at ingest (`FR-WAY-03`), and
what becomes of each element. Anything not listed here is refused, with the
element's path and line. Nothing is skipped because it looked harmless.

This page and `services/so-wayline/src/so_wayline/wpml.py` describe the same
thing. `services/so-wayline/tests/test_subset_doc.py` holds them equal: every
path below is read by the code, and the code reads nothing else. The reference
wayline in `services/so-wayline/tests/fixtures/reference/` uses every one.

## Which file

A KMZ holds `wpmz/template.kml`, the planning file, and `wpmz/waylines.wpml`,
the execution file. **The execution file is what is flown, and what this page
covers.** `template.kml` is parsed with the same hardened parser and read for
two things only, its `wpml:templateType`, which must be `waypoint`, and its
`Document/name` ([ADR-0014](../../docs/architecture/decisions/0014-execution-file-height-modes.md)).

The WPML namespace is read from the document, and must be
`http://www.dji.com/wpmz/1.0.x`. KML's is `http://www.opengis.net/kml/2.2`. An
element in any other namespace is refused.

## Two kinds of refusal

- **`value_malformed`**: not DJI's format. A number that is not one, a value DJI
  does not define, a waypoint index out of order.
- **`value_unsupported`**: DJI's format, and not something this system flies.
  The message names what is accepted, so a client learns what to change.

An element missing where this page says it is required is `element_missing`,
given twice where once is allowed, `element_repeated`.

## What each element becomes

- **Flown**: it becomes part of the mission plan, as the last column says.
- **Checked**: it is held to the stated values and nothing else is done with it,
  because what it controls is fixed by the system rather than by the file.
- **Recorded**: validated and not flown. Either it is metadata, or what it
  controls is decided by the system itself for a reason the table states, such
  as the return height, which comes from the application's own configuration.
  The KMZ is stored byte for byte, so every value is kept; the ones an
  investigation reaches for first (author and times, drone and payload, DJI's
  distance and duration, the return and above-ground heights) are also copied
  into the wayline's metadata (`IR-WAY-01`).

## Conventions the translation settles once

- `wpml:takeOffRefPoint` is **latitude, longitude, height**. A waypoint's
  `coordinates` are **longitude, latitude**, KML's order. Swapping either moves
  the point by hundreds of kilometres and is caught by the geofence, not by the
  parser, so the golden plan pins both.
- `wpml:waypointSpeed` is the speed **from** its waypoint to the next. The plan's
  `speed_ms` is the speed on the leg **into** its waypoint. Placemark *i*'s speed
  goes on waypoint *i + 1*; the last placemark's is not flown; the leg into
  waypoint 0 flies at `wpml:autoFlightSpeed`.
- Headings run from −180 to 180 in WPML and from 0 up to 360 in the plan.
- Heights are metres above the takeoff point, the only frame accepted in the MVP
  ([ADR-0017](../../docs/architecture/decisions/0017-relative-heights-only-in-the-mvp.md)).

## The document

### `/kml`

| Element | Required | Accepted | Becomes |
| --- | --- | --- | --- |
| `Document` | yes | once | the wayline |

### `/kml/Document`

| Element | Required | Accepted | Becomes |
| --- | --- | --- | --- |
| `wpml:author` | no | any text | recorded |
| `wpml:createTime` | no | any text | recorded |
| `wpml:updateTime` | no | any text | recorded |
| `wpml:missionConfig` | yes | once | below |
| `Folder` | yes | once: one wayline per file | below |

### `/kml/Document/wpml:missionConfig`

| Element | Required | Accepted | Becomes |
| --- | --- | --- | --- |
| `wpml:flyToWaylineMode` | yes | `safely` | checked: the aircraft always climbs to the security height before the transit (`FR-BRG-12`) |
| `wpml:finishAction` | yes | `goHome`, `noAction`, `autoLand` | flown: `finish_action` `return_home`, `hold`, `land`. `gotoFirstWaypoint` is refused |
| `wpml:exitOnRCLost` | yes | `executeLostAction` | checked: the phone is on the controller, so with the controller's link lost nothing can continue the mission; DJI's failsafe owns it (`FR-SAF-04`). `goContinue` is refused |
| `wpml:executeRCLostAction` | yes | `goBack` | checked: the aircraft's own failsafe returns home. `landing` and `hover` are refused |
| `wpml:takeOffSecurityHeight` | yes | above 0, at most 120 m | flown: `takeoff_security_height_m`; held to `max_height_m` |
| `wpml:takeOffRefPoint` | yes | latitude,longitude,height | flown: `reference_point`, where the transit ends (ADR-0014). The height is recorded |
| `wpml:takeOffRefPointAGLHeight` | no | a number | recorded |
| `wpml:globalTransitionalSpeed` | yes | above 0, at most 15 m/s | checked against `max_horizontal_speed_ms`; the transit flies at `speed_ms` |
| `wpml:globalRTHHeight` | no | a number | recorded: the application sets the return height from its own configuration |
| `wpml:droneInfo` | no | once | recorded |
| `wpml:droneInfo/wpml:droneEnumValue` | yes, in `droneInfo` | an integer | recorded |
| `wpml:droneInfo/wpml:droneSubEnumValue` | no | an integer | recorded |
| `wpml:payloadInfo` | no | once | recorded |
| `wpml:payloadInfo/wpml:payloadEnumValue` | yes, in `payloadInfo` | an integer | recorded |
| `wpml:payloadInfo/wpml:payloadSubEnumValue` | no | an integer | recorded |
| `wpml:payloadInfo/wpml:payloadPositionIndex` | no | an integer | recorded |

### `/kml/Document/Folder`

| Element | Required | Accepted | Becomes |
| --- | --- | --- | --- |
| `wpml:templateId` | yes | `0` | checked |
| `wpml:executeHeightMode` | yes | `relativeToStartPoint` | checked. `WGS84` is refused as `height_mode_wgs84`, `realTimeFollowSurface` as `height_mode_follow_surface`, each with its reason (`FR-WAY-09`) |
| `wpml:waylineId` | yes | `0` | checked |
| `wpml:distance` | no | a number, 0 or more | recorded; the service computes its own |
| `wpml:duration` | no | a number, 0 or more | recorded |
| `wpml:autoFlightSpeed` | yes | above 0, at most 15 m/s | flown: `speed_ms`; held to `max_horizontal_speed_ms` |
| `wpml:realTimeFollowSurfaceByFov` | no | `0` | checked |
| `Placemark` | yes, one or more | in flight order | a waypoint each; held to `max_waypoints` |

### `/kml/Document/Folder/Placemark`

| Element | Required | Accepted | Becomes |
| --- | --- | --- | --- |
| `Point` | yes | once | below |
| `Point/coordinates` | yes | longitude,latitude; a third value is refused, the height is `wpml:executeHeight` | flown: `latitude_deg`, `longitude_deg` |
| `wpml:index` | yes | 0, 1, 2 and so on, in document order | flown: `index` |
| `wpml:executeHeight` | yes | 0 to 120 m above the takeoff point | flown: `height_m`; held to `max_height_m` |
| `wpml:waypointSpeed` | yes | above 0, at most 15 m/s | flown: `speed_ms` on the **next** waypoint, left out when it equals `autoFlightSpeed`; held to `max_horizontal_speed_ms` |
| `wpml:waypointHeadingParam` | yes | once | below |
| `wpml:waypointHeadingParam/wpml:waypointHeadingMode` | yes | `fixed`, `smoothTransition` | `fixed`: no heading, the aircraft keeps the one it has. `smoothTransition`: flown, `heading_deg` from the angle below. `followWayline`, `manually` and `towardPOI` are refused |
| `wpml:waypointHeadingParam/wpml:waypointHeadingAngle` | with `smoothTransition` | −180 to 180 | flown: `heading_deg`, from 0 up to 360 |
| `wpml:waypointHeadingParam/wpml:waypointHeadingAngleEnable` | no | `0`, `1` | recorded |
| `wpml:waypointHeadingParam/wpml:waypointPoiPoint` | no | three numbers | recorded: points of interest are not flown |
| `wpml:waypointHeadingParam/wpml:waypointHeadingPathMode` | no | `clockwise`, `counterClockwise`, `followBadArc` | recorded: the aircraft turns the shorter way |
| `wpml:waypointTurnParam` | yes | once | below |
| `wpml:waypointTurnParam/wpml:waypointTurnMode` | yes | `toPointAndStopWithDiscontinuityCurvature` | checked: the aircraft flies straight to each waypoint and stops there. The curved modes are refused |
| `wpml:waypointTurnParam/wpml:waypointTurnDampingDist` | no | 0 or more | recorded: nothing to damp when every waypoint is a stop |
| `wpml:useStraightLine` | no | `0`, `1` | recorded: every leg is straight |
| `wpml:isRisky` | no | `0`, `1` | recorded |
| `wpml:waypointGimbalHeadingParam` | no | once | below |
| `wpml:waypointGimbalHeadingParam/wpml:waypointGimbalPitchAngle` | no | `0` | checked: the gimbal moves by `gimbalRotate` actions only |
| `wpml:waypointGimbalHeadingParam/wpml:waypointGimbalYawAngle` | no | `0` | checked, as above |
| `wpml:actionGroup` | no | any number | its actions, in order, on arrival |

### `/kml/Document/Folder/Placemark/wpml:actionGroup`

| Element | Required | Accepted | Becomes |
| --- | --- | --- | --- |
| `wpml:actionGroupId` | yes | an integer | checked |
| `wpml:actionGroupStartIndex` | yes | this placemark's index | checked: a group runs at its own waypoint only |
| `wpml:actionGroupEndIndex` | yes | this placemark's index | checked, as above |
| `wpml:actionGroupMode` | yes | `sequence` | checked |
| `wpml:actionTrigger` | yes | once | below |
| `wpml:actionTrigger/wpml:actionTriggerType` | yes | `reachPoint` | checked: actions run on arrival. Timed and distance triggers are refused |
| `wpml:action` | yes, one or more | in order | an entry in the waypoint's `actions` each |

### `/kml/Document/Folder/Placemark/wpml:actionGroup/wpml:action`

| Element | Required | Accepted | Becomes |
| --- | --- | --- | --- |
| `wpml:actionId` | yes | an integer | checked |
| `wpml:actionActuatorFunc` | yes | `hover`, `rotateYaw`, `gimbalRotate`, `takePhoto` | flown: `hover`, `rotate`, `gimbal_pitch`, `take_photo`. Every other DJI action is refused |
| `wpml:actionActuatorFuncParam` | for `hover`, `rotateYaw`, `gimbalRotate` | once | its parameters, below |

### `/kml/Document/Folder/Placemark/wpml:actionGroup/wpml:action/wpml:actionActuatorFuncParam`

Which parameters are read depends on the action. A parameter that belongs to
another action is refused as outside the subset.

| Element | Required | Accepted | Becomes |
| --- | --- | --- | --- |
| `wpml:hoverTime` | `hover`: yes | above 0, at most 60 s | flown: `hover` `seconds` |
| `wpml:aircraftHeading` | `rotateYaw`: yes | −180 to 180 | flown: `rotate` `heading_deg`, from 0 up to 360 |
| `wpml:aircraftPathMode` | `rotateYaw`: no | `clockwise`, `counterClockwise` | recorded: the aircraft turns the shorter way |
| `wpml:gimbalHeadingYawBase` | `gimbalRotate`: no | `north`, `aircraft` | recorded: no yaw is rotated |
| `wpml:gimbalRotateMode` | `gimbalRotate`: yes | `absoluteAngle` | checked |
| `wpml:gimbalPitchRotateEnable` | `gimbalRotate`: yes | `1` | checked: a pitch rotation is the only gimbal action flown |
| `wpml:gimbalPitchRotateAngle` | `gimbalRotate`: yes | −90 to 0 | flown: `gimbal_pitch` `pitch_deg`, 0 horizontal, negative downward |
| `wpml:gimbalRollRotateEnable` | `gimbalRotate`: no | `0` | checked |
| `wpml:gimbalRollRotateAngle` | `gimbalRotate`: no | a number | recorded: roll is not rotated |
| `wpml:gimbalYawRotateEnable` | `gimbalRotate`: no | `0` | checked |
| `wpml:gimbalYawRotateAngle` | `gimbalRotate`: no | a number | recorded: yaw is not rotated |
| `wpml:gimbalRotateTimeEnable` | `gimbalRotate`: no | `0` | checked |
| `wpml:gimbalRotateTime` | `gimbalRotate`: no | 0 or more | recorded |
| `wpml:payloadPositionIndex` | `gimbalRotate`, `takePhoto`: no | `0` | checked: one payload |
| `wpml:fileSuffix` | `takePhoto`: no | any text | recorded |
| `wpml:payloadLensIndex` | `takePhoto`: no | any text | recorded |
| `wpml:useGlobalPayloadLensIndex` | `takePhoto`: no | `0`, `1` | recorded |

## Changing this page

A new element is a change to this page, to `wpml.py`, to the reference wayline
and to its golden plan, in one pull request. If what the element controls cannot
be expressed in the mission plan, and the system does not decide it itself for a
reason the table can state, it is refused, not recorded.
