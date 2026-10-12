# Flight files: golden texts

The flight files of reference waylines, as text. The tests in
`services/soc-operations/tests/test_flight_files.py` rebuild each case and require the same
bytes ([ADR-0008](../../docs/architecture/decisions/0008-flight-files-served-on-sky-orchestrators-network.md),
FR-WAY-11). A KMZ is binary and stays out of git (NFR-MNT-04), so each case keeps the flight it
is built from, the two XML texts inside the KMZ, and the KMZ's own hashes.

| Case | Flight | Wayline name in the file |
| --- | --- | --- |
| `route-return-home/` | The route example's bake, from `contracts/geometry/examples/design.route.json`, flown from its takeoff at 20 m and 5 m/s: the climb right above the takeoff and four waypoints, one height above the rest, `return_home` | Route return home |
| `six-waypoints-land/` | Six waypoints, a speed into two of them (waypoints 1 and 3), `land` | Six waypoints land |

Each case holds:

- `flight.json`: the flight, the input to `flight_files.build`. It follows the `flight`
  definition of `contracts/geometry/design.schema.json`.
- `template.kml` and `waylines.wpml`: the two texts the builder writes into the KMZ. Both are
  UTF-8 with LF endings and a final newline.
- `kmz.sha256`: the KMZ's SHA-256, and its fingerprint (the MD5 that Sky Orchestrator's plan
  records as `fingerprint_md5`).

## Regenerating a case

A change to the builder that moves a byte fails these tests on purpose. When the change is
intended, rebuild the case from the builder, read the new texts against
`contracts/sky-orchestrator/wpml/supported-subset.md`, and commit the diff with the code that
caused it:

```bash
uv run --frozen python - <<'PY'
import hashlib, io, json, zipfile
from pathlib import Path
from soc_operations import flight_files

case, name = Path("contracts/flight-files/route-return-home"), "Route return home"
flight = json.loads((case / "flight.json").read_text(encoding="utf-8"))
kmz = flight_files.build(flight, name=name)
with zipfile.ZipFile(io.BytesIO(kmz)) as archive:
    (case / "template.kml").write_bytes(archive.read(flight_files.TEMPLATE_PATH))
    (case / "waylines.wpml").write_bytes(archive.read(flight_files.WAYLINES_PATH))
(case / "kmz.sha256").write_text(
    f"sha256: {hashlib.sha256(kmz).hexdigest()}\nfingerprint_md5: {flight_files.fingerprint(kmz)}\n",
    encoding="utf-8",
)
PY
```

Swap the case path and the name for the other case. The KMZ's entries are stored, not
deflated, so its bytes depend on the builder and on nothing installed: the same hashes on any
machine, in any Python with the same `zipfile` layout.
