# Aircraft catalogue

The DJI aircraft Mobile SDK V4 supports, with DJI's published specifications
(`FR-FLE-01`, `IR-MOD`). It is a contract: the database loads it, the console
offers its models when a fleet is registered, and the panels show its figures.

| File | Contents |
| --- | --- |
| `aircraft-models.schema.json` | The shape of the catalogue, version 1.0.0 |
| `aircraft-models.json` | The models, sorted by `model` |

## Rules

- **Every published value carries its source**: `{"value": ..., "source": "https://..."}`,
  the DJI page the value was read on. Third-party sites are not sources.
- **A value DJI does not publish is `null`**, never an estimate (`IR-MOD-01`).
- Units are SOC's (ADR-0014): speeds in m/s, flight time in seconds, heights in
  metres above sea level, weight in grams; a conversion from DJI's unit is
  arithmetic only (km/h ÷ 3.6, minutes × 60).
- `msdk_v4_support` is `partial` where DJI's Mobile SDK V4 reference says a
  feature is not supported by that model, with the restriction in
  `support_notes` and its source; an "only supported by" list does not count.
- Which figure, where DJI gives several: the highest speed of any mode, near sea
  level and without wind; the flight time without wind and with the payload
  that gives the longest (a hovering time alone is not a flight time); the
  service ceiling, or the maximum flight altitude where that is what DJI calls
  it (a maximum takeoff altitude is not one); the takeoff weight with batteries
  and without payload; the largest still image; the video resolution with the
  most pixels, at its highest frame rate.
- **A range is reduced to its safe side**: wind resistance published as
  8.5–10.5 m/s is 8.5 (`NFR-SAF-06`). A bound such as `< 249 g` is not a value
  and stays `null`.
- `msdk_v4_enum` is the Android `dji.common.product.Model` constant exactly as
  written, mixed case included (`Spark`, `Phantom_3_4K`), or `null` where the
  enum has none for that model.

## Changing it

A migration is immutable once applied, so a changed catalogue is a new one:

```bash
python3 tools/catalogue_migration.py --render > database/migrations/NNNN-aircraft-catalogue-X-Y.sql
uv run --frozen python tools/catalogue_migration.py --check
```

The check, in the hooks and in CI, validates the file against its schema, finds
every published value without an https source, and fails until the newest
migration that loads the catalogue embeds the file as it is. Models are
upserted, never removed: a fleet keeps the model it was registered with.
