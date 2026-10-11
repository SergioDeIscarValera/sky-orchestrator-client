# ADR-0020 — The web's unit tests run on happy-dom; its schemas use Zod's mini build

- **Status**: Accepted
- **Date**: 2026-10-11

## Context

ADR-0016 chose jsdom for the web's unit tests and Zod 4.6.5 for its schemas. With
the sign-in, the organization choice and the Supabase client in, both were
measured on the operator's laptop (Node 24.21.0, 12 cores):

- The suite, 92 tests in 10 files, took 2.3 to 2.6 s with jsdom 30.1.2, over
  the 2 s every unit's gate tests must stay under. More than half of it was
  building the jsdom environment for each file. The same tests on happy-dom
  20.14.6 took 1.6 s, with no test changed.
- Zod's classic build added about 16 KB gzip to the initial JavaScript. Its mini
  build, in the same package and version, validates the same way through
  functions instead of methods; with its English messages loaded it brought the
  initial JavaScript from 187.0 to 170.8 KB gzip, against a budget of 250.

Before either, the lint test alone took 2.5 s: it linted through the whole
ESLint configuration, which builds a TypeScript program, to test rules that
need no type information. The console's rules now live in `lint-rules.js`,
without imports; the configuration and the test both read them there, and the
test takes 60 ms.

## Decision

- **happy-dom 20.14.6** is the environment of the web's unit tests, replacing
  jsdom. Tests that need no DOM declare the Node environment.
- **Zod's mini build** (`zod/mini`, Zod 4.6.5) with its English locale, through
  one module, `src/schema.ts`, that every schema imports.
- Browser behaviour that a simulated DOM cannot show stays with Playwright, as
  ADR-0016 says: real WebGL, real CORS, the LAN origin.

## Alternatives considered

**Keep jsdom and relax the gate's budget for the web.** A requirement bent to fit
a tool, for a closer imitation of the browser that these tests do not use.

**Keep jsdom and fewer test files.** The environment is built once per file in
parallel; fewer files means less parallelism, not less work.

**Zod's classic build.** Method chains read better, for 16 KB gzip on every
first load of the console.

## Consequences

- The gate stays under 2 s for the web as for every other unit.
- happy-dom implements less of the DOM than jsdom; a test that needs a missing
  API moves to Playwright rather than back to jsdom.
- Schemas are written as `z.nullable(z.number())`, `z.string().check(...)`.
