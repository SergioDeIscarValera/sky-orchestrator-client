# ADR-0026 — SOC deploys on the mini-PC through a self-hosted runner

- **Status**: Accepted
- **Date**: 2026-10-17

## Context

SOC runs on the farm's mini-PC beside Virtual Origen (VO2) and Sky Orchestrator
(SO) (ADR-0015). The mini-PC is on the farm's LAN behind a home router: nothing
outside can reach it, and GitHub cannot push to it.

A release already tags the version and publishes its images to GHCR (FR-DEP-06).
Until now someone then had to deploy it by hand on the mini-PC:

- a GHCR token with `read:packages` on the box, logged in for good;
- a checkout moved to the tag, then `infra/deploy/deploy.py`.

VO2 deploys on every release through a self-hosted Actions runner on the same
mini-PC (VO2's ADR 0026). Two deploy patterns on one box means two ways to get
each step wrong.

## Decision

**A release deploys itself on the mini-PC, the way VO2's does.**

- **A runner of SOC's own** on the mini-PC:
  - user `soc-runner`, in group `docker` and nothing else, with no sudo;
  - a systemd service, so it comes back after a power cut;
  - labels `self-hosted,minipc`, registered to this repository only.

  It runs one job: `deploy` in `.github/workflows/release.yml`. No other job in
  any workflow names a self-hosted runner.
- **A stable stack folder**, `/srv/sky-orchestrator-client/stack`, outside the
  runner's workspace:
  - the env files hold the secrets, mode 600, owned by `soc-runner`;
  - the configuration files name their secrets and hold none, mode 644;
  - all of them are written once, on the mini-PC, never by CI.

  Each deploy copies the tag's `compose.yaml` and `deploy.py` into it.
- **The job:**
  - runs when a release merges, once its images are published, or by hand
    (`workflow_dispatch`) with an existing tag, for the first install, a
    redeploy or a rollback;
  - checks the tag, the folder and the files' owner and modes;
  - signs in to GHCR with its own token (`packages: read`), and signs out
    whatever happens;
  - checks the configuration with the tag's `soc-config`;
  - runs `deploy.py`, which refuses while a flight is unfinished and changes
    nothing then.
- **A switch.** The job runs only while the repository variable
  `SOC_MINIPC_DEPLOY_ENABLED` is `true`. Without a runner, a job for
  `[self-hosted, minipc]` is not refused: it waits up to 24 hours in the queue.
- **One deploy at a time**, never cancelled: an interrupted `up` leaves the
  farm's stack in an unknown state.

The mini-PC keeps no GHCR credential and no deploy key.

## Alternatives considered

**Deploy by hand with `deploy.py`.** It works, and it stays the fallback
(`docs/mini-pc-deployment.md`). It needs a long-lived GHCR token on the box and
someone at the mini-PC for every release, and it is a second pattern beside VO2's.

**Push from a GitHub-hosted runner over SSH.** The router would have to forward
SSH to the farm's machine from the internet, or a tunnel would have to carry it.
A deploy key would live in GitHub's secrets. Both widen what can reach the box.

**A pull agent on the box (Watchtower or a timer).** It would restart services
during a flight, since it knows nothing of SOC's flights; and nothing would
report a failed deploy where the release is seen.

## Consequences

- A merged release is running on the farm a few minutes later, or its job says
  why not: a flight in progress, a missing file, a refused configuration.
- After a refusal for a flight, the deploy is not retried by itself: once the
  flight ends, dispatch the same tag.
- Rollback is a dispatch of the older tag. Its images stay on the box, and
  `deploy.py` migrates nothing backwards, so a rollback over a migration that
  changed a table needs the backup (RISK-08).
- **The accepted risk.** The runner runs what a workflow says, with access to
  Docker, which is root on the mini-PC. On a public repository anyone can open a
  pull request whose workflow names that runner.
  - VO2 accepted its runner because its repository is private, with one owner.
  - This repository is public for now, only because the private CI minutes ran
    out on 2026-10-17. It goes back to private.
  - While it is public:
    - every workflow run from a fork waits for approval
      (`all_external_contributors`); never approve one;
    - the runner's user has no sudo and only the stack folder is its own;
    - the job's token reads packages and contents only, and is logged out at
      the end;
    - the secrets live outside the runner's workspace, and the job never prints
      the interpolated configuration.
  - Revise this decision if the repository stays public after M5, or if GitHub
    ever lets a personal account limit a runner to one workflow.
