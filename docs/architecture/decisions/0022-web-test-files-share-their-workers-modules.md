# ADR-0022 — The web's test files share their worker's modules

- **Status**: Accepted
- **Date**: 2026-10-11

## Context

The fleet panel brought the web's suite to 180 tests in 22 files. Most of what
the suite spends is not in the tests:

- On CI's runner the suite went from 7.2 s (130 tests, 18 files) to 10.7 s
  (180 tests, 22 files); the panel's two files cost 3 s.
- On the operator's laptop on mains power it took 1.77 s before the fleet
  panel and about 1.9 s after it. On battery the same laptop took 3.1 to 3.4 s.
- Vitest's own breakdown puts about 30 % of the time in imports, 25 % in
  building the environment and 12 % in the setup, against 18 % in the tests.
  Each file that renders the console imports it whole, about 600 ms of modules:
  `lucide-react` and `radix-ui` load every icon and every primitive from their
  barrels, and the console's own tree comes after.

Vitest isolates each file by default: every file in a worker imports its
modules again. Measured on the laptop, on battery, with CI's worker counts and
its own (Vitest 5.0.3, happy-dom 20.14.6). The absolute times are higher than
on mains; the ratios are what matter:

| Workers | Isolated (forks) | Shared modules (threads, `isolate: false`) |
| --- | --- | --- |
| 4 | 5.4 to 5.5 s | 3.1 to 3.6 s |
| 2 | 9.0 to 9.8 s | 4.4 to 4.6 s |
| 12 | 3.1 to 3.4 s | 2.9 to 3.0 s |

Pre-bundling `lucide-react` and `radix-ui` through Vitest's dependency optimizer
saved about 70 ms an importing file and nothing on the whole suite.

## Decision

The web's tests run in threads that keep the modules they imported from one
file to the next (`pool: 'threads'`, `isolate: false`). Each file still gets its
own environment and its own setup. For that to be safe:

- The setup resets what a test leaves in the page after each test: the
  rendered tree, local storage, the theme, inline styles and the URL.
- No module holds a test's state. A module-level cache is keyed by what it
  depends on, as the palette's is keyed by the theme, so a file that changes the
  input sees a fresh value.
- Tests do not mock modules (`vi.mock`): a mock in one file would leak into the
  next file in the worker.

## Alternatives considered

**Keep isolation and accept a slower gate.** The gate is the one feedback loop
every commit pays for, and its budget is what keeps it a gate.

**Merge the console's test files.** That pays the imports fewer times, but it
also takes parallelism away (ADR-0020) and makes the files harder to read.

**Import icons and primitives by their own paths.** That saves part of the
imports at the cost of every component's imports, and the console's own tree
remains.

## Consequences

- On a CI-sized worker count the suite takes about half as long.
- A test that leaks state into a module now shows up as another file's failure.
  The fix is to key or reset that state, never to bring isolation back for one
  file.
- An effect's cleanup runs after the page shows the change that caused it, so a
  test that checks a cleanup waits for it. Two such checks raced, and once
  showed it under shared modules; both now wait.
