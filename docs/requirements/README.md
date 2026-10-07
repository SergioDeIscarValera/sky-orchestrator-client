# Requirements

Sky Orchestrator Client specifies three requirement families, in three
documents.

| Document | Family | Question answered |
| --- | --- | --- |
| [functional-requirements.md](functional-requirements.md) | FR | What must the system do? |
| [non-functional-requirements.md](non-functional-requirements.md) | NFR | How well must it do it, under which assumptions and constraints? |
| [information-requirements.md](information-requirements.md) | IR | What data exists, who owns it, what shape it has, how long it lives? |

Supporting documents: the [glossary](glossary.md) fixes vocabulary, the
[dependencies](dependencies.md) list what SOC needs from Sky Orchestrator and
Virtual Origen and where each item stands, and the
[traceability matrix](traceability.md) maps every requirement to the unit that
implements it, the milestone that delivers it and the test that proves it.

## Identifier scheme

```
FR-<AREA>-<NN>      functional
NFR-<CATEGORY>-<NN> non-functional
IR-<ENTITY>-<NN>    information
ASM-<NN>            assumption
CON-<NN>            constraint
DEP-<NN>            dependency on another project
```

Identifiers are permanent. A requirement that is dropped is marked `Withdrawn`
and keeps its number. Numbers are never reused, because commits, tests and
decision records cite them.

Requirements of the neighbouring projects are cited with their project:
"SO's FR-DEV-07", "VO2's ADR 0059". An identifier without a project is SOC's.

### Functional areas

| Code | Area |
| --- | --- |
| `AUT` | Access, roles and organization context |
| `SCN` | The 3D scene |
| `FLE` | Fleets and the aircraft catalogue |
| `LNK` | The link with Sky Orchestrator: SOC as the DJI cloud party |
| `TEL` | Telemetry, live and recorded |
| `GEO` | Geofences |
| `WAY` | Waylines and flight files |
| `OPS` | Operations and their lifecycle |
| `CMD` | Commands to aircraft in flight |
| `SAF` | Safety behaviour |
| `LOG` | The operation log |
| `REP` | Reports and replay |
| `DEP` | Deployment and operability |

### Non-functional categories

`PERF` performance · `RES` resource budgets · `REL` reliability · `SAF` safety ·
`SEC` security · `COMP` protocol compatibility · `UX` design and usability ·
`MNT` maintainability · `TEST` testability · `OBS` observability ·
`PORT` portability and deployment

## Priority

MoSCoW, scoped to the **MVP** defined in the [roadmap](../roadmap.md): a first
real test flight commanded from SOC.

| Priority | Meaning |
| --- | --- |
| `MUST` | The MVP is not the MVP without it. |
| `SHOULD` | Planned inside the MVP window, may slip one milestone. |
| `COULD` | Explicitly wanted, explicitly after the MVP. Recorded so the data model is ready for it. |
| `WONT` | Recorded so it stops being re-proposed, with the reason. |

## Writing rules

1. One requirement, one behaviour. If it needs "and", it is probably two.
2. Every requirement has **acceptance criteria a test can assert**.
3. Numbers are numbers: a latency names a percentile and a bound.
4. A requirement names an implementation only when the implementation is the
   requirement, and then it cites the decision record that forced it.
5. A requirement that changes gets a row in its document's changelog, not a
   silent edit.
6. An index links to its contents; the contents do not link back.

## Relationship to decision records

Requirements say **what** and **how well**. The
[decision records](../architecture/decisions/) say **why this design and not the
other one**. When a requirement exists only because of a constraint found in a
neighbouring project, it cites the record that documents it.
