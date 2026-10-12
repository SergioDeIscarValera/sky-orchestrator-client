# Telemetry recordings

Recorded telemetry streams, replayed as test inputs so an incident becomes a test
(`NFR-TEST-05`). Each file is JSON Lines: one object per sample a console
received, in the order received, following
[`recording.schema.json`](recording.schema.json): the sample as soc-cloud
broadcast it ([`telemetry.schema.json`](../broadcast/telemetry.schema.json)) and
when the browser got it, on the browser's clock.

The console's tests replay every recording here through its telemetry store and
the scene's placement (`apps/soc-web/src/telemetry/recordings.test.ts`), and hold
each to the honesty rules whatever it contains: a track never runs backwards,
nothing is drawn past the latest sample or glided across a gap, and no sample is
called live once its threshold has passed (`FR-TEL-02`, `FR-SAF-02`,
`NFR-REL-07`).

## A fixture, not a flight record

A recording here is a test input, not the record of a flight (`NFR-MNT-04`: no
flight records in git). It holds the samples a console received and nothing else:
no operator, no account, no organization's name. The ones kept so far come from
the console end to end's simulated dock. A real flight's stream joins only to
reproduce an incident, cut to the samples that show it and kept under 1 MB; the
flight's own record stays in the database.

## Recording one

The console end to end writes one when `SOC_E2E_RECORD` names a file:

```bash
SOC_E2E_RECORD=$PWD/contracts/recordings/<name>.jsonl \
  uv run --frozen pytest infra/e2e/tests -m lane -s
```

A recording from a real flight follows the same schema. Add a row below for each
one: what it holds and why it is kept.

| Recording | Recorded | What it holds |
| --- | --- | --- |
| [`2026-10-12-dock-flight-and-cut.jsonl`](2026-10-12-dock-flight-and-cut.jsonl) | 2026-10-12, by the console end to end: a dock speaking Sky Orchestrator's contract, soc-cloud, Realtime behind Kong, Chrome | 352 samples of one aircraft over 74 s: idle, then a minute circling Finca Norte at 5 Hz; the dock silent for 3.1 s; flying again, the browser's network cut for 10 s; back, live again. Every honesty rule is put to the test: stale and lost frames, and a gap drawn whole |
