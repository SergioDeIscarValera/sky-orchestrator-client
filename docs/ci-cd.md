# CI/CD

The pipelines make the rules in [CONTRIBUTING](../CONTRIBUTING.md) and the
requirements enforceable. A convention nothing checks is a preference.

## Lanes

| Lane | When | Cost | Bound |
| --- | --- | --- | --- |
| **Gate** | Every commit (pre-commit) and every pull request | Free locally, seconds in CI | Under 2 s per unit (`NFR-TEST-01`) |
| **Database** | Pull requests touching `database/` or `contracts/` | An ephemeral Postgres | Minutes (`NFR-TEST-02`) |
| **End to end** | Pull requests touching what it runs, and every release | Supabase and Sky Orchestrator in containers | Minutes (`NFR-TEST-03`) |
| **Field sessions** | Before a release is flown | The aircraft and the operator | A runbook, recorded |

SOC has no model in it, so it has no eval lane (`NFR-TEST-06`).

## What runs today

`ci.yml`, one job named `Gate`, on pull requests into `main` and `develop` and by
hand:

| Step | Requirement |
| --- | --- |
| Relative Markdown links resolve | Documentation integrity |
| No file over 512 KB | `NFR-MNT-04` |
| Tooling gate tests | `NFR-TEST-01` |
| Secret scan over the full history (gitleaks) | `NFR-SEC-04` |

`pr-policy.yml`, one job named `Pull request policy`: changelog label, branch
name and direction, version admissibility on release branches, title and commits
linted, description present.

`release.yml`: tag, release, back-merge, on a release or hotfix merged into
`main`.

Each unit adds its gate as a step of `Gate` when it arrives: `soc-web` (type
check, lint, unit tests, bundle budget), each Python unit (type check, lint, gate
tests in its locked environment), `database` (migration and policy tests, in the
database lane).

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
`commit-msg`; branch name, file hygiene, links, gitleaks at CI's version and the
tooling tests on `pre-commit`. Each unit adds its gate when it arrives.

`--no-verify` is not an escape hatch.

## Deployment

The target is the mini-PC (`CON-01`), beside Virtual Origen and Sky Orchestrator.
From M1, each release publishes the services' and the web's images to GHCR from
its tag. Deploying is a command run on the mini-PC that refuses while any flight
is unfinished (`FR-DEP-06`). There is no automatic deployment: restarting the
services that hold the link to an aircraft in flight is a hazard, not a
convenience.
