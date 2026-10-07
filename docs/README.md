# Documentation

| Document | What it answers |
| --- | --- |
| [Requirements](requirements/README.md) | Index, identifier scheme, writing rules |
| [Functional requirements](requirements/functional-requirements.md) | What SOC does |
| [Non-functional requirements](requirements/non-functional-requirements.md) | How well, under which assumptions and constraints |
| [Information requirements](requirements/information-requirements.md) | Data, ownership, units, retention |
| [Dependencies](requirements/dependencies.md) | What SOC needs from Sky Orchestrator and Virtual Origen |
| [Traceability matrix](requirements/traceability.md) | Requirement → unit → milestone → test |
| [Glossary](requirements/glossary.md) | DJI, SO, VO2 and SOC vocabulary |
| [Architecture overview](architecture/overview.md) | How the pieces fit |
| [Decision records](architecture/decisions/README.md) | Why they fit that way |
| [Design system](design/README.md) | How SOC looks and behaves |
| [Risk register](risks.md) | What is most likely to go wrong, and its trigger |
| [Roadmap](roadmap.md) | Milestones and exit criteria |
| [CI/CD](ci-cd.md) | Lanes, pipelines, the minutes budget |
| [GitHub governance](github-governance.md) | Branch and tag rules, merge method, automation |

## Reading order

**New to the project**: [README](../README.md) → [glossary](requirements/glossary.md)
→ [architecture overview](architecture/overview.md) →
[ADR-0004](architecture/decisions/0004-soc-is-the-dji-cloud-party.md) and
[ADR-0005](architecture/decisions/0005-one-database-shared-with-virtual-origen.md),
which explain where SOC sits between its two neighbours.

**About to write code**: the requirements of your area, the
[contributing guide](../CONTRIBUTING.md), then the units section of the
[information requirements](requirements/information-requirements.md). That last
one is not optional.

**About to touch the interface**: the [design system](design/README.md) first.

**Something went wrong around a flight**: the [risk register](risks.md), then the
operation's log and the flight's records.

## Rules

1. Documentation lives with the code, in git, in English.
2. A requirement changes through a pull request that also updates the
   traceability matrix; `tools/check_traceability.py` holds them equal.
3. Decision records are immutable: superseded, never edited to say otherwise.
4. Every unit's README covers its scope, its contract, its configuration and its
   **enumerated failure modes** (`NFR-SAF-03`).
