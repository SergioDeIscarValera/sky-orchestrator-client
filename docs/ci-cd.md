# CI/CD

The pipelines make the rules in [CONTRIBUTING](../CONTRIBUTING.md) and the
requirements enforceable. A convention nothing checks is a preference.

## Lanes

| Lane | When | Cost | Bound |
| --- | --- | --- | --- |
| **Gate** | Every commit (pre-commit) and every pull request | Free locally, seconds in CI | Under 2 s per unit (`NFR-TEST-01`) |
| **Database** | Pull requests touching `database/`, `infra/migrate/` or a library whose tests use it | Ephemeral Postgres and Realtime from the production images | About a minute (`NFR-TEST-02`) |
| **End to end** | Pull requests touching what it runs, and every release | Supabase and Sky Orchestrator in containers | Minutes (`NFR-TEST-03`) |
| **Field sessions** | Before a release is flown | The aircraft and the operator | A runbook, recorded |

SOC has no model in it, so it has no eval lane (`NFR-TEST-06`).

## What runs today

`ci.yml`, one job named `Gate`, on pull requests into `main` and `develop` and by
hand:

| Step | Requirement |
| --- | --- |
| Relative Markdown links resolve | Documentation integrity |
| Traceability matrix equals the requirements | `tools/check_traceability.py` |
| No file over 512 KB | `NFR-MNT-04` |
| Tooling gate tests | `NFR-TEST-01` |
| Python workspace synced from its lockfile, uv 0.12.23 | `NFR-PORT-02` |
| Python lint and format over the whole repository | `NFR-MNT-06` |
| Strict types for `tools/` at Python 3.12, and for `database` | `NFR-MNT-06` |
| One gate per Python unit, its strict types then its tests: `soc-migrate`, `soc-config`, `soc-log`, `soc-supervision`, `soc-db` and `soc-realtime` (without their `database` tests) | `NFR-MNT-06`, `NFR-TEST-01` |
| Database lane: `database`'s tests and the `database`-marked tests of `soc-db` and `soc-realtime`, against Postgres and Realtime v2.102.3, when `database/`, `infra/migrate/`, those libraries or a library they use, or the lockfile change | `NFR-TEST-02` |
| Secret scan over the full history (gitleaks) | `NFR-SEC-04` |

`pr-policy.yml`, one job named `Pull request policy`: changelog label, branch
name and direction, version admissibility on release branches, title and commits
linted, description present.

`release.yml`: tag, release, back-merge, on a release or hotfix merged into
`main`.

Each unit adds its gate as a step of `Gate` when it arrives: `soc-web` (type
check, lint, unit tests, bundle budget), each Python unit (type check and gate
tests in its locked environment, one unit at a time, so two units never share a
module namespace), `database` (migration and policy tests, in the database lane).
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

`tools/tests/test_workflows.py` holds these rules: a second job, a push trigger,
a job without a timeout or an expression interpolated into a script fails the
gate and has to be argued for in review.

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
