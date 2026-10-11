# Contributing

Conventions are enforced by tooling, not by memory. A rule here that no hook or
pipeline checks is a gap to close, not a rule to remember. The reasoning behind
branching and commits is in
[ADR-0003](docs/architecture/decisions/0003-git-flow-and-conventional-commits.md).

---

## Branching: Git Flow

```
main       ──●───────────────────●──────────────●──────▶   released, tagged
              ╲                 ╱ ╲            ╱
release/       ╲   ●───●───────●   ╲          ╱
                ╲ ╱                 ╲        ╱ hotfix/v0.1.1
develop    ──●───●───●───●───●───●───●──────●───────────▶   integration
              ╲     ╱     ╲     ╱
feature/       ●───●        ●───●
```

| Branch | From | Into | Purpose |
| --- | --- | --- | --- |
| `main` | — | — | Released state, tagged. Never committed to directly. |
| `develop` | `main` | — | Integration. The default branch. |
| `feature/<scope>/<slug>` | `develop` | `develop` | One unit of work |
| `bugfix/<scope>/<slug>` | `develop` | `develop` | One fix, not yet released |
| `release/vX.Y.Z` | `develop` | `main` | Stabilisation of a release |
| `hotfix/vX.Y.Z` | `main` | `main` | A fix against released state |
| `backmerge/vX.Y.Z` | `main` | `develop` | Carries a release back; opened automatically |
| `dependabot/<ecosystem>/<name>` | `develop` | `develop` | A dependency update Dependabot opens |

Every arrow is a pull request on GitHub. Merged branches are deleted
automatically on GitHub; `python3 tools/prune_branches.py` deletes their local
copies.

`<scope>` is the unit the work belongs to, from the closed list below; `<slug>`
is kebab case.

```
feature/cloud/resource-request-answers
feature/web/geofence-editor
bugfix/operations/simulation-gate-reset
```

### Scopes

`web` · `cloud` · `operations` · `libs` · `database` · `contracts` · `infra` ·
`tools` · `repo`

The list is closed and lives in `tools/lint_commits.py`. `docs` and `ci` are
types: a documentation change is scoped to what it documents, `docs(cloud)`, or
to the repository, `docs(repo)`.

---

## Commits: one line, scoped, in English

```
<type>(<scope>): <subject>
```

That is the whole message. No body, no footers, no trailers, no
`Co-authored-by`. The reasoning goes in the pull request description.

| Type | Use |
| --- | --- |
| `feat` | New behaviour |
| `fix` | Corrected behaviour |
| `docs` | Documentation only |
| `test` | Tests only |
| `refactor` | No behaviour change |
| `perf` | Performance |
| `build` | Build system, dependencies |
| `ci` | Pipelines |
| `chore` | Everything else |
| `revert` | Reverts a previous commit |

Rules, all enforced by `tools/lint_commits.py`: one line; scope from the list;
subject imperative, lower case start, no trailing full stop, 10 to 72
characters; header at most 100; a breaking change marked with `!` after the
scope.

```
feat(cloud): answer the dock's resource request from memory
fix(web): stop interpolating past the last telemetry sample
feat(contracts)!: rename the telemetry broadcast event
```

### Small, ordered, self-contained

- One domain per commit. A change to `database` and `web` is two commits, the
  database first.
- **Every commit stands on its own**: no broken import, no reference or link to a
  file that arrives later.
- Tests land with the code they test.
- A commit that needs a paragraph to justify it is probably two commits.

## Definition of done

- [ ] It works, and you can explain **why it is correct and where it would
      break**.
- [ ] Gate tests in the same commit as the code: deterministic, offline, under
      2 s.
- [ ] A fix ships the test that failed before it.
- [ ] Failure modes in the unit's README if it can command an aircraft or show
      its state (`NFR-SAF-03`).
- [ ] Traceability matrix updated for every requirement touched.
- [ ] A contract change versioned, both sides updated in the same pull request.
- [ ] The measurable outcome named (`NFR-OBS-03`).
- [ ] No secrets, binaries, build output or flight records.
- [ ] Documentation updated in the same change.

## Code

- Names carry intent; a comment says only why something non-obvious must be so
  (`NFR-MNT-06`).
- SOLID, one responsibility per class or function, composition over inheritance.
- Python: typed, strict type checking, `ruff`. TypeScript: strict mode, ESLint.
- Units in names: `height_m`, never `height`
  ([ADR-0014](docs/architecture/decisions/0014-units-and-reference-frames.md)).
- Deterministic work is code with tests, never judgement (`NFR-MNT-05`).

## Safety rules for code that can command an aircraft

1. **The device decides.** Sky Orchestrator's device-side envelope stops the
   aircraft; SOC's checks are defence in depth (`NFR-SAF-01`).
2. **Fail closed.** A missing or unparseable safety setting stops the service
   (`FR-SAF-05`).
3. **Never stale as live, never invented.** Mark a value stale or unavailable
   (`FR-SAF-02`, `FR-SAF-03`).
4. **The mode is reported, never assumed** (`FR-SAF-04`).
5. **One automatic action**: `return_home` on a geofence breach, nothing else
   (`NFR-SAF-04`).

---

## Local setup

```bash
git clone https://github.com/SergioDeIscarValera/sky-orchestrator-client.git
cd sky-orchestrator-client
git switch develop

pip install pre-commit
pre-commit install --install-hooks
pre-commit install --hook-type commit-msg

python3 -m unittest discover -s tools/tests

uv sync --frozen --all-packages              # the Python workspace, CPython 3.14
uv run --frozen mypy libs/soc-config         # a unit's gate: its types,
uv run --frozen pytest libs/soc-config/tests # then its tests
uv run --frozen pytest database/tests        # the container lane, needs Docker

cd apps/soc-web && corepack enable && pnpm install   # the web, Node 24.21.0
```

The hooks refuse commits on `main` and `develop`, and messages that break the
convention. Each unit's README adds its own setup.

---

## Pull requests: the only way anything lands

| Pull request | Base | Merge method |
| --- | --- | --- |
| `feature/*`, `bugfix/*`, `dependabot/*` | `develop` | Merge commit |
| `release/vX.Y.Z`, `hotfix/vX.Y.Z` | `main` | Merge commit, then the tag is automatic |
| `backmerge/vX.Y.Z` | `develop` | Merge commit |

Merge commits only: squash and rebase are disabled, so the small commits stay in
history. A pull request built on another one says so in its description and
merges after it.

Merge with `python3 tools/merge_when_green.py <number>`: it waits for the checks
and merges only when every check passed and every check the rulesets require
reported. The free private plan does not enforce the rulesets, so nothing else
stops a red pull request from merging.

The template asks for the requirements, the evidence and the failure modes.
Since commits are one line, the description is where the reasoning lives.

Do not use `--no-verify`.

## Releases

```bash
python3 tools/next_version.py                  # what the commits imply
git switch develop && git pull
git switch -c release/v0.2.0 && git push -u origin release/v0.2.0
```

1. Stabilise on the branch: fixes only.
2. Update `CHANGELOG.md` by hand from the merged pull requests.
3. Open the pull request into `main`; merge it with a merge commit.
4. The release workflow verifies the version, tags it, publishes the release,
   pushes the service images to GHCR at the tag, and opens the back-merge into
   `develop`. Merge that with a merge commit.

Never open a pull request from `main`: automatic branch deletion would delete it.
