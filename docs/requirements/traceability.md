# Traceability matrix

Every requirement maps to the unit that implements it, the milestone that
delivers it, and the test that proves it. A requirement with no test reference is
not implemented, whatever the code says.

Milestones are defined in the [roadmap](../roadmap.md). Test identifiers follow
`<unit>/<path>::<test>` and are filled in as the tests are written; `—` means not
yet. `tools/check_traceability.py` holds this table equal to the requirement
documents: one row per requirement, the same priority, no row for anything else.

## Functional

| ID | Priority | Unit | Milestone | Test | Status |
| --- | --- | --- | --- | --- | --- |
| FR-AUT-01 | MUST | soc-web, database | M1 | — | Planned |
| FR-AUT-02 | MUST | soc-web, database | M1 | — | Planned |
| FR-AUT-03 | MUST | soc-web, database | M1 | — | Planned |
| FR-AUT-04 | MUST | soc-web, database | M1 | — | Planned |
| FR-SCN-01 | MUST | soc-web | M1 | — | Planned |
| FR-SCN-02 | MUST | soc-web | M2 | — | Planned |
| FR-SCN-03 | MUST | soc-web | M2 | — | Planned |
| FR-SCN-04 | MUST | soc-web | M2, M3, M4 | — | Planned |
| FR-SCN-05 | MUST | soc-web | M2 | — | Planned |
| FR-SCN-06 | MUST | soc-web | M2 | — | Planned |
| FR-SCN-07 | MUST | soc-web | M3 | — | Planned |
| FR-SCN-08 | MUST | soc-web | M1 | — | Planned |
| FR-FLE-01 | MUST | contracts, database | M2 | — | Planned |
| FR-FLE-02 | MUST | soc-cloud, database | M2 | — | Planned |
| FR-FLE-03 | MUST | soc-web, database | M2 | — | Planned |
| FR-FLE-04 | MUST | soc-web, database | M2 | — | Planned |
| FR-FLE-05 | MUST | soc-web, database | M2 | — | Planned |
| FR-FLE-06 | COULD | database, soc-web | M6 | — | Planned |
| FR-FLE-07 | COULD | database, soc-web | M6 | — | Planned |
| FR-LNK-01 | MUST | soc-cloud | M1 | — | Planned |
| FR-LNK-02 | MUST | soc-cloud | M1 | — | Planned |
| FR-LNK-03 | MUST | soc-cloud | M1 | — | Planned |
| FR-LNK-04 | MUST | soc-cloud | M1 | — | Planned |
| FR-LNK-05 | MUST | soc-cloud | M1 | — | Planned |
| FR-LNK-06 | MUST | soc-cloud | M4 | — | Planned |
| FR-LNK-07 | MUST | soc-cloud | M4 | — | Planned |
| FR-LNK-08 | MUST | soc-cloud | M4 | — | Planned |
| FR-LNK-09 | MUST | soc-cloud | M4 | — | Planned |
| FR-LNK-10 | MUST | soc-cloud | M1 | — | Planned |
| FR-LNK-11 | SHOULD | soc-cloud | M1 | — | Planned |
| FR-TEL-01 | MUST | soc-cloud, soc-web | M2 | — | Planned |
| FR-TEL-02 | MUST | soc-web | M2 | — | Planned |
| FR-TEL-03 | MUST | soc-web | M2 | — | Planned |
| FR-TEL-04 | MUST | soc-cloud, database | M4 | — | Planned |
| FR-TEL-05 | MUST | soc-web | M4 | — | Planned |
| FR-GEO-01 | MUST | soc-web, libs, database | M3 | — | Planned |
| FR-GEO-02 | MUST | soc-web, libs, database | M3 | — | Planned |
| FR-GEO-03 | MUST | soc-web, libs, database | M3 | — | Planned |
| FR-GEO-04 | MUST | soc-web, libs, database | M3 | — | Planned |
| FR-WAY-01 | MUST | soc-web, libs | M3 | — | Planned |
| FR-WAY-02 | MUST | soc-web, libs | M3 | — | Planned |
| FR-WAY-03 | MUST | soc-web, libs | M3 | — | Planned |
| FR-WAY-04 | SHOULD | soc-web, libs | M3 | — | Planned |
| FR-WAY-05 | SHOULD | soc-web, libs | M3 | — | Planned |
| FR-WAY-06 | MUST | soc-web, libs | M3 | — | Planned |
| FR-WAY-07 | MUST | soc-web, libs | M3 | — | Planned |
| FR-WAY-08 | MUST | soc-web, libs, soc-cloud | M3, M4 | — | Planned |
| FR-WAY-09 | MUST | soc-web, libs | M3 | — | Planned |
| FR-WAY-10 | MUST | soc-web, libs | M3 | — | Planned |
| FR-WAY-11 | MUST | soc-operations | M3 | — | Planned |
| FR-WAY-12 | COULD | soc-operations, soc-web | M7 | — | Planned |
| FR-OPS-01 | MUST | soc-operations, soc-web, database | M4 | — | Planned |
| FR-OPS-02 | MUST | soc-operations, soc-web, database | M4 | — | Planned |
| FR-OPS-03 | MUST | soc-operations, soc-web, database | M4 | — | Planned |
| FR-OPS-04 | MUST | soc-operations, soc-web, database | M4 | — | Planned |
| FR-OPS-05 | MUST | soc-operations, soc-web, database | M4 | — | Planned |
| FR-OPS-06 | MUST | soc-operations, soc-web, database | M4 | — | Planned |
| FR-OPS-07 | MUST | soc-operations, soc-web, database | M4 | — | Planned |
| FR-OPS-08 | MUST | soc-operations, soc-web, database | M4 | — | Planned |
| FR-OPS-09 | MUST | soc-operations, soc-web, database | M4 | — | Planned |
| FR-OPS-10 | MUST | soc-operations, soc-web, database | M4 | — | Planned |
| FR-OPS-11 | COULD | database, soc-web | M6 | — | Planned |
| FR-OPS-12 | COULD | soc-operations, soc-web, database | M7 | — | Planned |
| FR-CMD-01 | MUST | soc-web, database, soc-cloud | M4 | — | Planned |
| FR-CMD-02 | MUST | soc-web, database, soc-cloud | M4 | — | Planned |
| FR-CMD-03 | MUST | soc-web, database, soc-cloud | M4 | — | Planned |
| FR-CMD-04 | MUST | soc-web, database, soc-cloud | M4 | — | Planned |
| FR-CMD-05 | MUST | soc-web, database, soc-cloud | M4 | — | Planned |
| FR-CMD-06 | MUST | soc-web, database, soc-cloud | M4 | — | Planned |
| FR-CMD-07 | MUST | soc-web, database, soc-cloud | M4 | — | Planned |
| FR-CMD-08 | COULD | soc-operations, soc-cloud | M7 | — | Planned |
| FR-SAF-01 | MUST | soc-cloud, libs | M4 | — | Planned |
| FR-SAF-02 | MUST | soc-web, soc-operations | M2 | — | Planned |
| FR-SAF-03 | MUST | soc-cloud, soc-web | M2 | — | Planned |
| FR-SAF-04 | MUST | soc-cloud, soc-operations | M4 | — | Planned |
| FR-SAF-05 | MUST | soc-cloud, soc-operations | M1 | — | Planned |
| FR-SAF-06 | MUST | soc-operations, soc-web | M4 | — | Planned |
| FR-LOG-01 | MUST | soc-operations, soc-cloud, database, soc-web | M4 | — | Planned |
| FR-LOG-02 | MUST | soc-operations, soc-cloud, database, soc-web | M4 | — | Planned |
| FR-LOG-03 | MUST | soc-operations, soc-cloud, database, soc-web | M4 | — | Planned |
| FR-REP-01 | COULD | soc-web, database | M6 | — | Planned |
| FR-REP-02 | COULD | soc-web | M6 | — | Planned |
| FR-DEP-01 | MUST | infra | M1 | — | Planned |
| FR-DEP-02 | MUST | infra | M1 | — | Planned |
| FR-DEP-03 | MUST | infra | M1 | — | Planned |
| FR-DEP-04 | MUST | infra | M1 | — | Planned |
| FR-DEP-05 | MUST | infra | M2 | — | Planned |
| FR-DEP-06 | MUST | infra, repository | M1 | — | Planned |

## Non-functional

| ID | Priority | Unit | Milestone | Test | Status |
| --- | --- | --- | --- | --- | --- |
| NFR-PERF-01 | MUST | soc-cloud, soc-web | M2 | — | Planned |
| NFR-PERF-02 | MUST | soc-web, database, soc-cloud | M4 | — | Planned |
| NFR-PERF-03 | MUST | soc-cloud | M1 | — | Planned |
| NFR-PERF-04 | MUST | soc-cloud, libs | M4 | — | Planned |
| NFR-PERF-05 | MUST | soc-web | M1 | — | Planned |
| NFR-PERF-06 | MUST | soc-web | M1 | — | Planned |
| NFR-PERF-07 | SHOULD | soc-cloud | M4 | — | Planned |
| NFR-RES-01 | MUST | soc-web | M1 | — | Planned |
| NFR-RES-02 | MUST | soc-web | M2 | — | Planned |
| NFR-RES-03 | MUST | soc-web | M2 | — | Planned |
| NFR-RES-04 | MUST | soc-cloud, soc-operations | M1 | — | Planned |
| NFR-RES-05 | MUST | soc-web, soc-cloud, soc-operations, infra | M1 | — | Planned |
| NFR-RES-06 | MUST | soc-cloud, soc-operations | M4 | — | Planned |
| NFR-RES-07 | MUST | soc-cloud | M2 | — | Planned |
| NFR-REL-01 | MUST | soc-cloud, soc-operations | M4 | — | Planned |
| NFR-REL-02 | MUST | soc-cloud | M4 | — | Planned |
| NFR-REL-03 | MUST | soc-cloud, soc-operations | M1 | — | Planned |
| NFR-REL-04 | MUST | soc-cloud, soc-operations | M1 | — | Planned |
| NFR-REL-05 | SHOULD | soc-cloud, soc-operations | M5 | — | Planned |
| NFR-REL-06 | MUST | soc-cloud, soc-operations | M1 | — | Planned |
| NFR-REL-07 | MUST | soc-web | M2 | — | Planned |
| NFR-SAF-01 | MUST | repository | M4 | — | Planned |
| NFR-SAF-02 | MUST | soc-cloud, soc-web | M2 | — | Planned |
| NFR-SAF-03 | MUST | soc-cloud, soc-operations, soc-web | M1 | — | Planned |
| NFR-SAF-04 | MUST | soc-cloud, soc-operations | M4 | — | Planned |
| NFR-SAF-05 | MUST | soc-operations | M4 | — | Planned |
| NFR-SAF-06 | MUST | soc-cloud, soc-operations | M1 | — | Planned |
| NFR-SEC-01 | MUST | database, soc-web, soc-cloud, infra | M1 | — | Planned |
| NFR-SEC-02 | MUST | database, soc-web, soc-cloud, infra | M1 | — | Planned |
| NFR-SEC-03 | MUST | database, soc-web, soc-cloud, infra | M1 | — | Planned |
| NFR-SEC-04 | MUST | repository | M0 | `.github/workflows/ci.yml` (gitleaks over the full history), `.pre-commit-config.yaml` (gitleaks on what is staged) | Done: secret scan in CI on every pull request and before every commit |
| NFR-SEC-05 | MUST | soc-cloud | M1 | — | Planned |
| NFR-SEC-06 | MUST | soc-cloud | M4 | — | Planned |
| NFR-SEC-07 | MUST | soc-web, infra | M1 | — | Planned |
| NFR-SEC-08 | MUST | repository | M0 | `tools/tests/test_workflows.py::EveryWorkflow` | Partial: every action pinned to a released version and held by a test; lockfiles with hashes arrive with each unit in M1 |
| NFR-COMP-01 | MUST | soc-cloud, soc-operations, contracts | M1 | — | Planned |
| NFR-COMP-02 | MUST | soc-operations | M3 | — | Planned |
| NFR-COMP-03 | MUST | soc-cloud, soc-web, contracts | M4 | — | Planned |
| NFR-COMP-04 | MUST | infra | M4 | — | Planned |
| NFR-UX-01 | MUST | soc-web | M1 | — | Planned |
| NFR-UX-02 | MUST | soc-web | M1 | — | Planned |
| NFR-UX-03 | MUST | soc-web | M1 | — | Planned |
| NFR-UX-04 | MUST | soc-web | M1 | — | Planned |
| NFR-UX-05 | MUST | soc-web | M1 | — | Planned |
| NFR-UX-06 | MUST | soc-web | M1 | — | Planned |
| NFR-UX-07 | MUST | soc-web | M2 | — | Planned |
| NFR-UX-08 | MUST | soc-web | M1 | — | Planned |
| NFR-MNT-01 | MUST | repository | M1 | — | Planned |
| NFR-MNT-02 | MUST | repository | M1 | — | Planned |
| NFR-MNT-03 | MUST | repository | M0 | — | Planned |
| NFR-MNT-04 | MUST | repository | M0 | `.github/workflows/ci.yml` (no file over 512 KB), `.pre-commit-config.yaml` (large files, private keys) | Done for size and keys; build output kept out by `.gitignore` |
| NFR-MNT-05 | MUST | libs, soc-web, tools | M0, M3 | — | Planned |
| NFR-MNT-06 | MUST | repository | M1 | — | Planned |
| NFR-TEST-01 | MUST | repository | M0 | `tools/tests/*` | Done for the tooling: 113 tests in under 0.1 s, in pre-commit and CI; each unit adds its gate from M1 |
| NFR-TEST-02 | MUST | database | M1 | — | Planned |
| NFR-TEST-03 | MUST | infra | M4 | — | Planned |
| NFR-TEST-04 | MUST | repository | M0 | — | Planned |
| NFR-TEST-05 | MUST | soc-cloud | M2 | — | Planned |
| NFR-TEST-06 | MUST | repository | M0 | — | Done: no model in SOC, no eval suite; stated in `docs/ci-cd.md` |
| NFR-OBS-01 | MUST | soc-cloud, soc-operations, soc-web | M1 | — | Planned |
| NFR-OBS-02 | MUST | soc-cloud, soc-operations, soc-web | M1 | — | Planned |
| NFR-OBS-03 | MUST | repository | M0 | `.github/PULL_REQUEST_TEMPLATE.md`, `pr-policy.yml` (description present) | Done: every pull request names its evidence |
| NFR-OBS-04 | MUST | soc-cloud | M2 | — | Planned |
| NFR-OBS-05 | SHOULD | soc-web | M2 | — | Planned |
| NFR-PORT-01 | MUST | infra, soc-web | M1 | — | Planned |
| NFR-PORT-02 | MUST | repository | M0 | ADR-0016, ADR-0017 | Partial: every version chosen and argued; lockfiles and digests arrive with each unit in M1 |
| NFR-PORT-03 | MUST | infra | M5 | — | Planned |
| NFR-PORT-04 | MUST | infra, soc-web | M1 | — | Planned |
| NFR-PORT-05 | MUST | infra, soc-web | M1 | — | Planned |
