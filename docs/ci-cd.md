# CI/CD

The pipelines make the rules in [CONTRIBUTING](../CONTRIBUTING.md) and the
requirements enforceable. A convention nothing checks is a preference.

## Lanes

| Lane | When | Cost | Bound |
| --- | --- | --- | --- |
| **Gate** | Every commit (pre-commit) and every pull request | Free locally, seconds in CI | Under 2 s per unit (`NFR-TEST-01`) |
| **Container lane** | Pull requests touching `database/`, `infra/check/`, `infra/compose/`, `infra/e2e/`, `infra/migrate/`, `libs/`, `services/`, the `broadcast`, `catalogue`, `config`, `geometry` and `sky-orchestrator` contracts, or the web image's files | Ephemeral Postgres, Realtime and Mosquitto from the production images | About 3.5 minutes: 211 to 217 s, measured 2026-10-11 (`NFR-TEST-02`) |
| **End to end** | Pull requests touching what the container lane tests or the web | Virtual Origen's platform behind Kong, soc-cloud, a dock speaking Sky Orchestrator's contract, the console's image, the runner's Chrome (`infra/e2e`); Sky Orchestrator's own images once their packages can be read | About 1.5 minutes locally (`NFR-TEST-03`) |
| **Field sessions** | Before a release is flown | The aircraft and the operator | A runbook, recorded |

SOC has no model in it, so it has no eval lane (`NFR-TEST-06`).

## What runs today

`ci.yml`, one job named `Gate`, on pull requests into `main` and `develop` and by
hand:

| Step | Requirement |
| --- | --- |
| Relative Markdown links resolve | Documentation integrity |
| Traceability matrix equals the requirements | `tools/check_traceability.py` |
| Sky Orchestrator's vendored contracts equal their manifest | `FR-LNK-10`, `tools/vendor_sky_orchestrator.py` |
| No file over 512 KB | `NFR-MNT-04` |
| Tooling gate tests | `NFR-TEST-01` |
| Python workspace synced from its lockfile, uv 0.12.23 | `NFR-PORT-02` |
| Python lint and format over the whole repository | `NFR-MNT-06` |
| Strict types for `tools/` at Python 3.12, and for `database` | `NFR-MNT-06` |
| One gate per Python unit, its strict types then its tests: `soc-migrate`, `soc-config`, `soc-log`, `soc-supervision`, `soc-db`, `soc-realtime`, `soc-geo`, `soc-site`, `soc-cloud`, `soc-operations`, `soc-check` and `soc-e2e` (without their `lane` tests) | `NFR-MNT-06`, `NFR-TEST-01` |
| Container lane: `database`'s tests and the `lane`-marked tests of `soc-db`, `soc-realtime`, `soc-cloud`, `soc-operations` and `soc-check` (SOC's images built and run, the web's among them), against Postgres 17.6.1.136, Realtime v2.102.3 and Mosquitto 2.0.22, when `database/`, `infra/check/`, `infra/compose/`, `infra/e2e/`, `infra/migrate/`, `libs/`, `services/`, the `broadcast`, `catalogue`, `config`, `geometry` and `sky-orchestrator` contracts, the Python lockfile, `.dockerignore` or the web image's files (its Dockerfile, `nginx/`, its manifest, lockfile and `pnpm-workspace.yaml`) change | `NFR-TEST-02`, `NFR-SEC-07`, `FR-DEP-04` |
| Console end to end in Chrome (`infra/e2e`), when the container lane runs or the web changes: GoTrue, PostgREST and Realtime behind Kong 3.9.1, soc-cloud, a dock on the broker and the console's image; an aircraft announced appears within 2 s and is registered through the form, its telemetry reaches the browser within 150 ms at p95, and a silent dock reads Stale at the threshold, give or take 100 ms; WebGL on SwiftShader | `FR-FLE-02`, `FR-FLE-03`, `FR-TEL-01`, `FR-TEL-02`, `NFR-PERF-01`, `NFR-TEST-03` |
| `soc-web` gate, when the web changes: types, lint, format, unit tests, the build, its loading budget and the search of the built files for secrets, on Node 24.21.0 and pnpm 12.10.1 | `NFR-UX-01`, `NFR-UX-02`, `NFR-PORT-04`, `NFR-PERF-05`, `NFR-SEC-02` |
| Secret scan over the full history (gitleaks) | `NFR-SEC-04` |

The two change detectors (the container lane's and the web's) list the changed paths once and match them from that variable, not from a pipe, so a long list cannot make a match read as no match, and a failing `git diff` fails its step instead of skipping the lane. The `soc-web gate` runs every check after the install and then fails, naming each check that failed, so one red run shows every problem; only the install stops it, since nothing can run without it.

`pr-policy.yml`, one job named `Pull request policy`: changelog label, branch
name and direction, version admissibility on release branches, title and commits
linted, description present.

`release.yml`: tag, release, the service images published to GHCR at the tag
(`ghcr.io/<owner>/sky-orchestrator-client/<service>:vX.Y.Z`, never moved), and
the back-merge, on a release or hotfix merged into `main` (`FR-DEP-06`).

Each unit adds its gate as a step of `Gate` when it arrives: `soc-web` (type
check, lint, unit tests, bundle budget, secrets), each Python unit (type check and gate
tests in its locked environment, one unit at a time, so two units never share a
module namespace), `database` (migration and policy tests, in the container lane).
`tools/tests/test_workflows.py` fails while a workspace member has no gate in CI
and in the hooks, or while a unit's hook or the lane's path filter misses a
workspace unit it depends on.

## Minutes budget

The repository is private, so Actions minutes come from the account's free
allowance, **shared with Sky Orchestrator and Virtual Origen** (`CON-09`). Two
billing facts shape the workflows:

- **Every job is rounded up to a whole minute.** Five jobs of six seconds bill
  five minutes.
- **Every triggering event is a separate run.** A workflow on both `push` and
  `pull_request` bills twice for the same change.

So:

| Rule | Why |
| --- | --- |
| One job per workflow while the checks take seconds | One billed minute instead of one per check |
| Pull request triggers only, plus manual runs | A merge does not pay again for a tree its pull request gated |
| Slow lanes filtered by the paths they read | A documentation change does not start containers |
| Every job has a timeout | A hung job cannot burn the month |
| Every step guarded with `!cancelled()` | One red run shows every problem |
| Every job on `ubuntu-24.04`, by version | `ubuntu-latest` moves to Ubuntu 26 on 2026-10-19, on GitHub's date rather than in a pull request here |

`tools/tests/test_workflows.py` holds these rules: a second job, a push trigger,
a job without a timeout or on another runner image, or an expression
interpolated into a script fails the gate and has to be argued for in review.

What this costs, plainly: the tree on `develop` after a merge is not re-checked
as such. While the rulesets cannot require branches to be up to date, a manual
run of `Gate` on `develop` is the remedy.

## Local enforcement

`.pre-commit-config.yaml` runs the same scripts: the commit message linter on
`commit-msg`; branch name, file hygiene, links, gitleaks at CI's version, Python
lint, format and types, and the tooling tests on `pre-commit`. Each unit adds its
gate when it arrives.

`--no-verify` is not an escape hatch.

## Deployment

The target is the mini-PC (`CON-01`), beside Virtual Origen and Sky Orchestrator.
From M1, each release publishes the services' and the web's images to GHCR from
its tag. Deploying is a command run on the mini-PC that refuses while any flight
is unfinished (`FR-DEP-06`). There is no automatic deployment: restarting the
services that hold the link to an aircraft in flight is a hazard, not a
convenience.
