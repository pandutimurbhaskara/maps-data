# osm-maps

Self-hostable clone of CARTO Workspace Maps on OpenStreetMap + DuckDB.
Design: `docs/superpowers/specs/` · Reverse-engineering evidence: `docs/re/`.

## Run

```bash
# data (once): demo grid over Tokyo, or a real OSM extract
cd server
go run ./cmd/seed -out ../data.duckdb
# or: curl -fLo ../extract.osm.pbf https://download.geofabrik.de/europe/monaco-latest.osm.pbf
#     go run ./cmd/osm-ingest -pbf ../extract.osm.pbf -out ../data.duckdb

# terminal 1: API on :8080
go run ./cmd/mapsd -data ../data.duckdb -meta ../meta.duckdb

# terminal 2: web on :5173
cd web && npm install && npm run dev
```

Open http://localhost:5173/maps → **New map**. The builder has four tabs:

- **Sources**: add a table or a SQL query.
- **Layers**: style each layer, and colour it by a column or by an H3 aggregate.
- **Widgets**: live statistics for the current viewport. A category widget filters the map.
- **Parameters**: `{{name}}` placeholders in SQL sources, with controls.

Changes autosave. **Preview** opens the read-only viewer.

To run as a single process instead (it serves the built app on :8080):

```bash
cd web && npm run build
cd ../server && go run ./cmd/mapsd -data ../data.duckdb -meta ../meta.duckdb -web ../web/dist
```

If `go run` fails with `IO Error: Could not get working directory`, your shell sits in a directory that was deleted and recreated (for example by a `git checkout`). Run `cd` into the folder again.

## Test

```bash
cd server && go test ./... -race
cd web && npm test               # unit
cd web && npm run test:contract  # real @carto/api-client against a live mapsd
```

Map data © OpenStreetMap contributors (ODbL). Palettes: CARTOColors (CC BY 4.0).
