## What changed

<!-- One paragraph: what behaves differently after this pull request. If it is
     stacked on another pull request, say which one merges first. -->

## Requirements

<!-- Requirement IDs implemented, changed or affected, and the decision records
     relied on or added. -->

- Refs:

## Evidence it works

<!-- Not "tests pass". The measurable outcome: the metric, log line, test or
     session that shows the behaviour changed as intended (NFR-OBS-03). -->

## Failure modes considered

<!-- Where does this break, and what happens then? Required for anything that
     can command an aircraft or show its state (NFR-SAF-03). Write "not
     safety-relevant" when it is not. -->

## Checklist

- [ ] Small commits, one domain each, each standing on its own (ADR-0003)
- [ ] Gate tests in this pull request: deterministic, offline, under 2 s
- [ ] A fix carries the test that failed before it
- [ ] Traceability matrix updated for every requirement touched
- [ ] Contract change, if any, versioned with both sides updated here
- [ ] Failure modes in the unit's README updated if safety-relevant
- [ ] Documentation updated in this pull request, not the next one
- [ ] No secrets, no binaries, no build output, no flight records
- [ ] I can explain why this is correct and exactly where it would break
