# M1: Data API, Maps API and viewer (OSM + DuckDB) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Go service (`mapsd`) with two halves. The first serves a CARTO-v3-compatible Data API (instantiation → TileJSON → MVT and H3 tiles) from a sandboxed DuckDB database built from OpenStreetMap. The second is a workspace API for maps and datasets. On top sits a React app with the `/maps` list page and a read-only viewer that renders maps with `@deck.gl/carto` over an OSM basemap.

**Architecture:** `server/` is one Go module. `internal/duck` opens DuckDB with the spatial, h3 and json extensions and the sandbox settings. `internal/source` compiles request params into a filtered SQL relation. `internal/describe` produces the schema, bounds and tilestats. `internal/tiles` encodes MVT (via DuckDB `ST_AsMVT`) and CARTO spatial tiles (protobuf). `internal/mapsapi` holds the `/v3/maps` handlers. `internal/store` and `internal/workspace` hold the maps CRUD over a second DuckDB file. `web/` is a Vite React app that talks to the server through the same origin. The SDK contract test in `web/contract` proves wire compatibility with `@carto/api-client`.

**Tech Stack:**
- Server: Go 1.24 with `github.com/duckdb/duckdb-go/v2` (DuckDB ≥ 1.4, CGO) and `google.golang.org/protobuf/encoding/protowire`. Tests use `github.com/paulmach/orb/encoding/mvt`.
- Web: Node 24 with npm, React 19, react-router 7, deck.gl 9.3.x, `@carto/api-client`, `maplibre-gl`, Vitest 3, Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-14-osm-duckdb-maps-design.md` (evidence: `docs/re/2026-10-14-carto-maps-findings-ledger.md`)

## Global Constraints

- DuckDB library version must be ≥ `v1.4.0`, because `ST_AsMVT`, `ST_AsMVTGeom` and `ST_TileEnvelope` first ship in 1.4.0. Task 1 fails the build otherwise.
- `CGO_ENABLED=1` (duckdb-go is a CGO driver). On macOS the Xcode Command Line Tools must be installed.
- On first run DuckDB downloads the `spatial`, `json` and `h3` (community) extensions into `~/.duckdb/extensions`, so network access is needed once. CI must cache that directory.
- Data DB: opened `READ_ONLY`, with `SET enable_external_access = false` then `SET lock_configuration = true`, after the extensions load. Meta DB: a separate file, read-write.
- Connection name exposed to clients: `osm`. MVT layer name: `default`. MVT extent 4096, buffer 256, EPSG:3857. Data is stored in EPSG:4326.
- Tile format advertised in TileJSON: `formatTiles=mvt`. Never implement CARTO's proprietary "binary" vector format.
- Identifiers from requests must match `^[A-Za-z_][A-Za-z0-9_]*$`. Table names may be `schema.table`.
- Per-request query timeout default 15 s. Max features per vector tile default 200 000.
- Web package manager: **npm** (commit `package-lock.json`). All `@deck.gl/*` packages pinned to the same `~9.3.3`.
- The map must always show "© OpenStreetMap contributors".
- Do not copy CARTO code, schema text, strings, icons or CSS. Do not use the CARTO name in the product.
- Commits: Conventional Commits, lowercase imperative, no trailing period, **no AI attribution trailers** (workspace rule).

## Review Focus

1. A `q` ending in a `-- comment`: wrapping it as a subquery must not swallow the closing `)`. Expected: the query runs normally. Test in Task 5.
2. User SQL that tries `read_csv('/etc/hosts')`, `getenv('HOME')`, `ATTACH`, `SET …` or DDL. Expected: an error, never data. Tests in Tasks 1, 2 and 9.
3. Sixteen parallel tile requests against one pooled DuckDB. Expected: all return 200, with no "database is locked" or corrupted results. Test in Task 9.
4. Non-ASCII OSM names (Japanese). Expected: they survive MVT property encoding and `stringSearch` filters byte-for-byte. Seed row `東京駅` in Task 3, tests in Tasks 5 and 7.
5. Map-list search text containing `%` or `_`. Expected: matched literally, not as LIKE wildcards. Test in Task 10.

## File Structure

```
.gitignore
server/
  go.mod
  cmd/mapsd/main.go            # wiring, flags, SPA serving       (Task 12)
  cmd/mapsd/main_test.go
  cmd/osm-ingest/main.go       # .osm.pbf → data.duckdb           (Task 4)
  cmd/seed/main.go             # deterministic demo data          (Task 3)
  internal/duck/               # open DuckDB + sandbox            (Task 1)
  internal/sqlguard/           # SELECT-only validation           (Task 2)
  internal/seed/               # demo_points table                (Task 3)
  internal/testdb/             # test helper: seeded sandboxed DB (Task 3)
  internal/ingest/             # OSM raw → points/lines/polygons  (Task 4)
  internal/source/             # params → filtered SQL relation   (Task 5)
  internal/describe/           # schema, bounds, tilestats        (Task 6)
  internal/tiles/              # tile math, MVT, H3 spatial tiles (Tasks 7–8)
  internal/httpx/              # JSON/error writers               (Task 9)
  internal/mapsapi/            # /v3/maps handlers                (Task 9)
  internal/store/              # maps + datasets persistence      (Task 10)
  internal/auth/               # M1 dev auth middleware           (Task 11)
  internal/workspace/          # /api/workspace + public map      (Task 11)
web/
  package.json, tsconfig.json, vite.config.ts, vitest.contract.config.ts, index.html
  contract/globalSetup.ts, contract/sdk.contract.test.ts         (Task 13)
  src/main.tsx, src/App.tsx, src/styles.css, src/test-setup.ts  (Task 13)
  src/lib/mapDoc.ts, src/lib/workspaceApi.ts(+test)              (Task 14)
  src/pages/MapsPage.tsx(+test)                                  (Task 14)
  src/lib/layersFromDoc.ts(+test), src/map/basemaps.ts(+test),
  src/map/deckLayers.ts, src/pages/ViewerPage.tsx                (Task 15)
```

---

### Task 1: Go module, DuckDB open helper, capability and sandbox tests

**Files:**
- Create: `.gitignore`, `server/go.mod`, `server/internal/duck/duck.go`
- Test: `server/internal/duck/duck_test.go`

**Interfaces:**
- Produces: `duck.Options{Path string; ReadOnly bool; Sandbox bool; MemoryLimit string; Threads int}` and `duck.Open(o duck.Options) (*sql.DB, error)`.

- [ ] **Step 1: Initialise the repo and module**

```bash
cd /Users/pandu/job/ventaris-moovin/explore/maps
git init
cat > .gitignore <<'EOF'
*.duckdb
*.duckdb.wal
*.osm.pbf
node_modules/
web/dist/
EOF
mkdir -p server && cd server
go mod init osm-maps/server
go get github.com/duckdb/duckdb-go/v2@latest golang.org/x/mod@latest github.com/paulmach/orb@latest
```

If `github.com/duckdb/duckdb-go/v2` fails to resolve, the driver still lives at its old path. Use `github.com/marcboeker/go-duckdb/v2` instead, and change the import in every file of this plan.

- [ ] **Step 2: Write the failing tests**

`server/internal/duck/duck_test.go`:

```go
package duck_test

import (
	"context"
	"database/sql"
	"path/filepath"
	"sync"
	"testing"

	"github.com/paulmach/orb/encoding/mvt"
	"golang.org/x/mod/semver"

	"osm-maps/server/internal/duck"
)

func open(t *testing.T, o duck.Options) *sql.DB {
	t.Helper()
	db, err := duck.Open(o)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

func TestVersionAndFunctions(t *testing.T) {
	db := open(t, duck.Options{})
	var v string
	if err := db.QueryRow("SELECT library_version FROM pragma_version()").Scan(&v); err != nil {
		t.Fatal(err)
	}
	if semver.Compare(v, "v1.4.0") < 0 {
		t.Fatalf("DuckDB %s is older than v1.4.0; ST_AsMVT needs 1.4", v)
	}
	for _, fn := range []string{
		"st_asmvt", "st_asmvtgeom", "st_tileenvelope", "st_readosm", "st_transform",
		"st_makeenvelope", "h3_latlng_to_cell", "h3_cell_to_parent", "h3_get_resolution",
		"h3_cell_to_lat", "h3_cell_to_lng", "json_serialize_sql",
	} {
		var n int
		if err := db.QueryRow("SELECT count(*) FROM duckdb_functions() WHERE lower(function_name) = ?", fn).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n == 0 {
			t.Errorf("function %s is not available", fn)
		}
	}
}

// Pins the exact ST_AsMVT / ST_AsMVTGeom / ST_TileEnvelope call shape used by internal/tiles.
func TestMVTFunctionSignatures(t *testing.T) {
	db := open(t, duck.Options{})
	var tile []byte
	err := db.QueryRow(`
SELECT ST_AsMVT({'__geom': ST_AsMVTGeom(g, ST_Extent(ST_TileEnvelope(0, 0, 0)), 4096, 256, true), 'name': 'tokyo'}, 'default', 4096, '__geom')
FROM (SELECT ST_Transform(ST_Point(139.76, 35.68), 'EPSG:4326', 'EPSG:3857', always_xy := true) AS g)`).Scan(&tile)
	if err != nil {
		t.Fatal(err)
	}
	layers, err := mvt.Unmarshal(tile)
	if err != nil {
		t.Fatal(err)
	}
	if len(layers) != 1 || layers[0].Name != "default" || len(layers[0].Features) != 1 {
		t.Fatalf("unexpected tile: %+v", layers)
	}
	if got := layers[0].Features[0].Properties["name"]; got != "tokyo" {
		t.Fatalf("name = %v, want tokyo", got)
	}
}

func TestSandbox(t *testing.T) {
	path := filepath.Join(t.TempDir(), "data.duckdb")
	rw, err := duck.Open(duck.Options{Path: path})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := rw.Exec("CREATE TABLE t AS SELECT 1 AS x"); err != nil {
		t.Fatal(err)
	}
	if err := rw.Close(); err != nil {
		t.Fatal(err)
	}

	db := open(t, duck.Options{Path: path, ReadOnly: true, Sandbox: true})
	db.SetMaxOpenConns(4)
	ctx := context.Background()

	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			var s string
			if err := db.QueryRowContext(ctx, "SELECT ST_AsText(ST_Point(1, 2))").Scan(&s); err != nil || s != "POINT (1 2)" {
				t.Errorf("spatial on a pooled connection: %q, %v", s, err)
			}
		}()
	}
	wg.Wait()

	for name, q := range map[string]string{
		"read local file": "SELECT * FROM read_csv('/etc/hosts')",
		"read env":        "SELECT getenv('HOME')",
		"unlock config":   "SET enable_external_access = true",
		"write":           "CREATE TABLE u (x INTEGER)",
		"attach":          "ATTACH '" + filepath.Join(t.TempDir(), "other.duckdb") + "' AS other",
	} {
		if _, err := db.ExecContext(ctx, q); err == nil {
			t.Errorf("%s: expected an error from %q", name, q)
		}
	}
}
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd server && go test ./internal/duck/ -v`
Expected: FAIL to compile with `undefined: duck.Open`.

- [ ] **Step 4: Implement `duck.Open`**

`server/internal/duck/duck.go`:

```go
// Package duck opens DuckDB databases with the extensions osm-maps needs.
package duck

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"fmt"
	"net/url"
	"strconv"
	"sync"

	"github.com/duckdb/duckdb-go/v2"
)

// Options configures one DuckDB database instance.
type Options struct {
	Path        string // database file; "" means in-memory
	ReadOnly    bool
	Sandbox     bool   // after loading extensions: disable external access, lock configuration
	MemoryLimit string // e.g. "2GB"; "" keeps DuckDB's default
	Threads     int    // 0 keeps DuckDB's default
}

var extensions = []string{
	"INSTALL spatial", "LOAD spatial",
	"INSTALL json", "LOAD json",
	"INSTALL h3 FROM community", "LOAD h3",
}

var sandbox = []string{
	"SET enable_external_access = false",
	"SET lock_configuration = true",
}

// Open returns a pooled *sql.DB. Extensions and sandbox settings are database-global,
// so they are applied once, by the first connection the pool creates.
func Open(o Options) (*sql.DB, error) {
	var (
		mu   sync.Mutex
		done bool
	)
	connector, err := duckdb.NewConnector(dsn(o), func(ex driver.ExecerContext) error {
		mu.Lock()
		defer mu.Unlock()
		if done {
			return nil
		}
		stmts := extensions
		if o.Sandbox {
			stmts = append(append([]string{}, extensions...), sandbox...)
		}
		for _, s := range stmts {
			if _, err := ex.ExecContext(context.Background(), s, nil); err != nil {
				return fmt.Errorf("duck: %s: %w", s, err)
			}
		}
		done = true
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("duck: open %q: %w", o.Path, err)
	}
	return sql.OpenDB(connector), nil
}

func dsn(o Options) string {
	q := url.Values{}
	if o.ReadOnly {
		q.Set("access_mode", "READ_ONLY")
	}
	if o.MemoryLimit != "" {
		q.Set("memory_limit", o.MemoryLimit)
	}
	if o.Threads > 0 {
		q.Set("threads", strconv.Itoa(o.Threads))
	}
	if len(q) == 0 {
		return o.Path
	}
	return o.Path + "?" + q.Encode()
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd server && go mod tidy && go test ./internal/duck/ -v`
Expected: PASS for all three tests.

If `TestMVTFunctionSignatures` fails with a binder error, the DuckDB signature differs from PostGIS. Run `SELECT function_name, parameters, parameter_types FROM duckdb_functions() WHERE function_name ILIKE 'st_asmvt%'`, adjust **only the SQL in this test** to the reported signature, and record the exact form. Task 7 copies it verbatim.

If only the `read env` case fails, `getenv` is not blocked by the sandbox. In that case add `getenv` to the deny check in Task 2, and keep this case so it documents the gap.

- [ ] **Step 6: Commit**

```bash
git add .gitignore server/go.mod server/go.sum server/internal/duck
git commit -m "feat(server): open duckdb with spatial, h3 and sandbox settings"
```

---

### Task 2: SELECT-only SQL guard

**Files:**
- Create: `server/internal/sqlguard/guard.go`
- Test: `server/internal/sqlguard/guard_test.go`

**Interfaces:**
- Consumes: `duck.Open`.
- Produces: `sqlguard.ErrNotSelect` and `sqlguard.ValidateSelect(ctx context.Context, db *sql.DB, q string) error` (nil iff `q` is exactly one SELECT statement; any rejection wraps `ErrNotSelect`).

- [ ] **Step 1: Write the failing test**

`server/internal/sqlguard/guard_test.go`:

```go
package sqlguard_test

import (
	"context"
	"errors"
	"testing"

	"osm-maps/server/internal/duck"
	"osm-maps/server/internal/sqlguard"
)

func TestValidateSelect(t *testing.T) {
	db, err := duck.Open(duck.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	ctx := context.Background()

	for _, q := range []string{
		"SELECT 1",
		"select 1;",
		"WITH a AS (SELECT 1 AS x) SELECT * FROM a",
		"SELECT * FROM t WHERE x > $min",
		"SELECT 1 -- trailing comment",
	} {
		if err := sqlguard.ValidateSelect(ctx, db, q); err != nil {
			t.Errorf("ValidateSelect(%q) = %v, want nil", q, err)
		}
	}
	for _, q := range []string{
		"", "   ",
		"DROP TABLE t",
		"SELECT 1; DROP TABLE t",
		"SELECT 1; SELECT 2",
		"COPY t TO 'x.csv'",
		"ATTACH 'x.duckdb'",
		"INSTALL httpfs",
		"SET threads = 1",
		"CREATE TABLE x AS SELECT 1",
		"SELECT (",
	} {
		if err := sqlguard.ValidateSelect(ctx, db, q); !errors.Is(err, sqlguard.ErrNotSelect) {
			t.Errorf("ValidateSelect(%q) = %v, want ErrNotSelect", q, err)
		}
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && go test ./internal/sqlguard/ -v`
Expected: FAIL with `undefined: sqlguard.ValidateSelect`.

- [ ] **Step 3: Implement the guard**

`server/internal/sqlguard/guard.go`:

```go
// Package sqlguard accepts only single SELECT statements, using DuckDB's own parser.
package sqlguard

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

var ErrNotSelect = errors.New("only a single SELECT statement is allowed")

// ValidateSelect parses q with json_serialize_sql, which serializes SELECT statements
// only and reports everything else (DDL, COPY, SET, ATTACH, syntax errors) as an error.
func ValidateSelect(ctx context.Context, db *sql.DB, q string) error {
	if strings.TrimSpace(q) == "" {
		return fmt.Errorf("%w: empty query", ErrNotSelect)
	}
	var out string
	if err := db.QueryRowContext(ctx, "SELECT json_serialize_sql(?::VARCHAR)", q).Scan(&out); err != nil {
		return fmt.Errorf("%w: %v", ErrNotSelect, err)
	}
	var r struct {
		Error        bool              `json:"error"`
		ErrorMessage string            `json:"error_message"`
		Statements   []json.RawMessage `json:"statements"`
	}
	if err := json.Unmarshal([]byte(out), &r); err != nil {
		return fmt.Errorf("sqlguard: decode parser output: %w", err)
	}
	if r.Error {
		return fmt.Errorf("%w: %s", ErrNotSelect, r.ErrorMessage)
	}
	if len(r.Statements) != 1 {
		return fmt.Errorf("%w: got %d statements", ErrNotSelect, len(r.Statements))
	}
	return nil
}
```

If Task 1 showed that `getenv` is not sandboxed, add this before `return nil`:

```go
	if strings.Contains(strings.ToLower(out), `"getenv"`) {
		return fmt.Errorf("%w: getenv is not allowed", ErrNotSelect)
	}
```

Also add `"SELECT getenv('HOME')"` to the `bad` list in the test.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server && go test ./internal/sqlguard/ -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/internal/sqlguard
git commit -m "feat(server): reject anything but a single select statement"
```

---

### Task 3: Deterministic demo data and test DB helper

**Files:**
- Create: `server/internal/seed/seed.go`, `server/internal/testdb/testdb.go`, `server/cmd/seed/main.go`
- Test: `server/internal/seed/seed_test.go`

**Interfaces:**
- Consumes: `duck.Open`.
- Produces:
  - `seed.Demo(ctx context.Context, db *sql.DB) error`, which creates `demo_points(id BIGINT, name VARCHAR, category VARCHAR, value DOUBLE, ts TIMESTAMP, geom GEOMETRY, h3 UBIGINT)` with 400 rows. `id` runs 0..399 and `value = id`. `category = ['cafe','shop','park','school'][id % 4 + 1]`. `name = '東京駅'` for id 0, `'poi-<id>'` otherwise. `ts = 2026-01-01 00:00 + id hours`. Points sit on a 20×20 grid from lon 139.70 / lat 35.65 in 0.005° steps. `h3` is res 12.
  - `testdb.Data(t testing.TB) *sql.DB`: a seeded, READ_ONLY, sandboxed DB.
  - The CLI `go run ./cmd/seed -out data.duckdb`.

- [ ] **Step 1: Write the failing test**

`server/internal/seed/seed_test.go`:

```go
package seed_test

import (
	"context"
	"testing"

	"osm-maps/server/internal/duck"
	"osm-maps/server/internal/seed"
)

func TestDemo(t *testing.T) {
	db, err := duck.Open(duck.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := seed.Demo(context.Background(), db); err != nil {
		t.Fatal(err)
	}
	var n, cats, res int
	if err := db.QueryRow(`SELECT count(*), count(DISTINCT category), min(h3_get_resolution(h3)) FROM demo_points`).Scan(&n, &cats, &res); err != nil {
		t.Fatal(err)
	}
	if n != 400 || cats != 4 || res != 12 {
		t.Fatalf("count=%d categories=%d res=%d, want 400 4 12", n, cats, res)
	}
	var name string
	if err := db.QueryRow(`SELECT name FROM demo_points WHERE id = 0`).Scan(&name); err != nil {
		t.Fatal(err)
	}
	if name != "東京駅" {
		t.Fatalf("name = %q", name)
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && go test ./internal/seed/ -v`
Expected: FAIL with `undefined: seed.Demo`.

- [ ] **Step 3: Implement the seed, the CLI and the test helper**

`server/internal/seed/seed.go`:

```go
// Package seed creates deterministic demo tables for tests and local development.
package seed

import (
	"context"
	"database/sql"
	"fmt"
)

const demoPointsSQL = `
CREATE OR REPLACE TABLE demo_points AS
SELECT
  i * 20 + j AS id,
  CASE WHEN i * 20 + j = 0 THEN '東京駅' ELSE 'poi-' || (i * 20 + j) END AS name,
  ['cafe', 'shop', 'park', 'school'][((i * 20 + j) % 4) + 1] AS category,
  (i * 20 + j)::DOUBLE AS value,
  TIMESTAMP '2026-01-01 00:00:00' + to_hours(i * 20 + j) AS ts,
  ST_Point(139.70 + j * 0.005, 35.65 + i * 0.005) AS geom,
  h3_latlng_to_cell(35.65 + i * 0.005, 139.70 + j * 0.005, 12)::UBIGINT AS h3
FROM range(20) r1(i), range(20) r2(j)`

// Demo creates demo_points: 400 points on a 20x20 grid over central Tokyo.
func Demo(ctx context.Context, db *sql.DB) error {
	if _, err := db.ExecContext(ctx, demoPointsSQL); err != nil {
		return fmt.Errorf("seed: demo_points: %w", err)
	}
	return nil
}
```

`server/internal/testdb/testdb.go`:

```go
// Package testdb builds throwaway DuckDB data databases for tests.
package testdb

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"

	"osm-maps/server/internal/duck"
	"osm-maps/server/internal/seed"
)

// Data returns a READ_ONLY, sandboxed database containing the seed.Demo tables.
func Data(t testing.TB) *sql.DB {
	t.Helper()
	path := filepath.Join(t.TempDir(), "data.duckdb")
	rw, err := duck.Open(duck.Options{Path: path})
	if err != nil {
		t.Fatal(err)
	}
	if err := seed.Demo(context.Background(), rw); err != nil {
		t.Fatal(err)
	}
	if err := rw.Close(); err != nil {
		t.Fatal(err)
	}
	db, err := duck.Open(duck.Options{Path: path, ReadOnly: true, Sandbox: true})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}
```

`server/cmd/seed/main.go`:

```go
// Command seed writes the deterministic demo tables into a DuckDB file.
package main

import (
	"context"
	"flag"
	"log"

	"osm-maps/server/internal/duck"
	"osm-maps/server/internal/seed"
)

func main() {
	out := flag.String("out", "data.duckdb", "DuckDB file to create or update")
	flag.Parse()
	db, err := duck.Open(duck.Options{Path: *out})
	if err != nil {
		log.Fatal(err)
	}
	defer db.Close()
	if err := seed.Demo(context.Background(), db); err != nil {
		log.Fatal(err)
	}
	log.Printf("seeded demo_points into %s", *out)
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server && go test ./internal/seed/ -v && go build ./...`
Expected: PASS, and the build succeeds.

- [ ] **Step 5: Commit**

```bash
git add server/internal/seed server/internal/testdb server/cmd/seed
git commit -m "feat(server): add deterministic demo data and test db helper"
```

---

### Task 4: OSM ingestion

**Files:**
- Create: `server/internal/ingest/ingest.go`, `server/cmd/osm-ingest/main.go`
- Test: `server/internal/ingest/ingest_test.go`

**Interfaces:**
- Consumes: `duck.Open`.
- Produces:
  - `ingest.BuildDerived(ctx, db *sql.DB) error`. It needs `osm_raw(kind VARCHAR, id BIGINT, tags MAP(VARCHAR,VARCHAR), refs BIGINT[], lat DOUBLE, lon DOUBLE)` and creates:
    - `osm_points(osm_id, name, amenity, shop, tourism, tags, geom POINT, h3 UBIGINT res 12)`
    - `osm_lines(osm_id, name, highway, railway, waterway, tags, geom)`
    - `osm_polygons(osm_id, name, building, landuse, leisure, tags, geom)`
  - `ingest.LoadPBF(ctx, db, pbfPath string) error`.
  - The CLI `go run ./cmd/osm-ingest -pbf file.osm.pbf -out data.duckdb`.

- [ ] **Step 1: Write the failing tests**

`server/internal/ingest/ingest_test.go`:

```go
package ingest_test

import (
	"context"
	"os"
	"testing"

	"osm-maps/server/internal/duck"
	"osm-maps/server/internal/ingest"
)

func TestBuildDerived(t *testing.T) {
	db, err := duck.Open(duck.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	db.SetMaxOpenConns(1) // the in-memory raw table must be visible to BuildDerived's connection
	for _, q := range []string{
		`CREATE TABLE osm_raw (kind VARCHAR, id BIGINT, tags MAP(VARCHAR, VARCHAR), refs BIGINT[], lat DOUBLE, lon DOUBLE)`,
		`INSERT INTO osm_raw VALUES
		  ('node', 1, MAP {}, NULL, 35.0, 139.0),
		  ('node', 2, MAP {}, NULL, 35.0, 139.001),
		  ('node', 3, MAP {}, NULL, 35.001, 139.001),
		  ('node', 4, MAP {'amenity': 'cafe', 'name': 'Kissa'}, NULL, 35.0005, 139.0005),
		  ('way', 10, MAP {'building': 'yes', 'name': 'Hall'}, [1, 2, 3, 1], NULL, NULL),
		  ('way', 11, MAP {'highway': 'residential'}, [1, 2], NULL, NULL),
		  ('way', 12, MAP {'highway': 'service', 'building': 'roof', 'area': 'no'}, [1, 2, 3, 1], NULL, NULL)`,
	} {
		if _, err := db.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	if err := ingest.BuildDerived(context.Background(), db); err != nil {
		t.Fatal(err)
	}

	var name, amenity string
	var n int
	if err := db.QueryRow(`SELECT count(*), any_value(name), any_value(amenity) FROM osm_points`).Scan(&n, &name, &amenity); err != nil {
		t.Fatal(err)
	}
	if n != 1 || name != "Kissa" || amenity != "cafe" {
		t.Fatalf("points: n=%d name=%q amenity=%q", n, name, amenity)
	}

	var id int64
	var typ string
	if err := db.QueryRow(`SELECT count(*), any_value(osm_id), any_value(CAST(ST_GeometryType(geom) AS VARCHAR)) FROM osm_polygons`).Scan(&n, &id, &typ); err != nil {
		t.Fatal(err)
	}
	if n != 1 || id != 10 || typ != "POLYGON" {
		t.Fatalf("polygons: n=%d id=%d type=%s", n, id, typ)
	}

	if err := db.QueryRow(`SELECT count(*) FROM osm_lines WHERE CAST(ST_GeometryType(geom) AS VARCHAR) = 'LINESTRING' AND osm_id IN (11, 12)`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 2 {
		t.Fatalf("lines: n=%d, want 2", n)
	}
}

// Set OSM_PBF to a small extract (e.g. Geofabrik monaco-latest.osm.pbf) to run.
func TestLoadPBF(t *testing.T) {
	pbf := os.Getenv("OSM_PBF")
	if pbf == "" {
		t.Skip("OSM_PBF not set")
	}
	db, err := duck.Open(duck.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	if err := ingest.LoadPBF(context.Background(), db, pbf); err != nil {
		t.Fatal(err)
	}
	for _, table := range []string{"osm_points", "osm_lines", "osm_polygons"} {
		var n int
		if err := db.QueryRow("SELECT count(*) FROM " + table).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n == 0 {
			t.Errorf("%s is empty", table)
		}
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && go test ./internal/ingest/ -v`
Expected: FAIL with `undefined: ingest.BuildDerived`.

- [ ] **Step 3: Implement the ingestion**

`server/internal/ingest/ingest.go`:

```go
// Package ingest turns an OpenStreetMap .osm.pbf extract into map-ready DuckDB tables.
package ingest

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
)

// LoadPBF reads pbfPath into osm_raw with ST_ReadOSM, then builds the derived tables.
func LoadPBF(ctx context.Context, db *sql.DB, pbfPath string) error {
	q := `CREATE OR REPLACE TABLE osm_raw AS
SELECT kind::VARCHAR AS kind, id, tags, refs, lat, lon FROM ST_ReadOSM(` + quoteLiteral(pbfPath) + `)`
	if _, err := db.ExecContext(ctx, q); err != nil {
		return fmt.Errorf("ingest: read %s: %w", pbfPath, err)
	}
	return BuildDerived(ctx, db)
}

func quoteLiteral(s string) string { return "'" + strings.ReplaceAll(s, "'", "''") + "'" }

// Multipolygon relations are not assembled (spec §4.5); closed ways only.
var derivedSQL = []string{
	`CREATE OR REPLACE TEMP MACRO osm_is_area(t) AS
	   (map_contains(t, 'building') OR map_contains(t, 'landuse') OR map_contains(t, 'leisure')
	    OR map_contains(t, 'amenity') OR map_contains(t, 'natural') OR coalesce(t['area'], '') = 'yes')
	   AND coalesce(t['area'], '') <> 'no'`,

	`CREATE OR REPLACE TABLE osm_points AS
	 SELECT id AS osm_id, tags['name'] AS name, tags['amenity'] AS amenity, tags['shop'] AS shop,
	        tags['tourism'] AS tourism, tags, ST_Point(lon, lat) AS geom,
	        h3_latlng_to_cell(lat, lon, 12)::UBIGINT AS h3
	 FROM osm_raw WHERE kind = 'node' AND cardinality(tags) > 0`,

	`CREATE OR REPLACE TEMP TABLE osm_way_lines AS
	 WITH refs AS (
	   SELECT id AS way_id, UNNEST(refs) AS node_id, generate_subscripts(refs, 1) AS ord
	   FROM osm_raw WHERE kind = 'way'
	 )
	 SELECT r.way_id, ST_MakeLine(list(ST_Point(n.lon, n.lat) ORDER BY r.ord)) AS line, count(*) AS n
	 FROM refs r JOIN osm_raw n ON n.kind = 'node' AND n.id = r.node_id
	 GROUP BY r.way_id HAVING count(*) >= 2`,

	`CREATE OR REPLACE TABLE osm_polygons AS
	 SELECT w.id AS osm_id, w.tags['name'] AS name, w.tags['building'] AS building,
	        w.tags['landuse'] AS landuse, w.tags['leisure'] AS leisure, w.tags,
	        ST_MakePolygon(l.line) AS geom
	 FROM osm_raw w JOIN osm_way_lines l ON l.way_id = w.id
	 WHERE w.kind = 'way' AND l.n >= 4 AND w.refs[1] = w.refs[-1] AND osm_is_area(w.tags)`,

	`CREATE OR REPLACE TABLE osm_lines AS
	 SELECT w.id AS osm_id, w.tags['name'] AS name, w.tags['highway'] AS highway,
	        w.tags['railway'] AS railway, w.tags['waterway'] AS waterway, w.tags, l.line AS geom
	 FROM osm_raw w JOIN osm_way_lines l ON l.way_id = w.id
	 WHERE w.kind = 'way' AND NOT (l.n >= 4 AND w.refs[1] = w.refs[-1] AND osm_is_area(w.tags))`,

	`CREATE INDEX IF NOT EXISTS osm_points_geom ON osm_points USING RTREE (geom)`,
	`CREATE INDEX IF NOT EXISTS osm_lines_geom ON osm_lines USING RTREE (geom)`,
	`CREATE INDEX IF NOT EXISTS osm_polygons_geom ON osm_polygons USING RTREE (geom)`,
	`ANALYZE`,
}

// BuildDerived turns osm_raw into osm_points, osm_lines and osm_polygons.
// It runs on one connection because the temp macro and temp table are connection-scoped.
func BuildDerived(ctx context.Context, db *sql.DB) error {
	conn, err := db.Conn(ctx)
	if err != nil {
		return fmt.Errorf("ingest: %w", err)
	}
	defer conn.Close()
	for _, q := range derivedSQL {
		if _, err := conn.ExecContext(ctx, q); err != nil {
			return fmt.Errorf("ingest: %s: %w", firstLine(q), err)
		}
	}
	return nil
}

func firstLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return s[:i]
	}
	return s
}
```

`server/cmd/osm-ingest/main.go`:

```go
// Command osm-ingest converts an .osm.pbf extract into a DuckDB data database.
package main

import (
	"context"
	"flag"
	"log"

	"osm-maps/server/internal/duck"
	"osm-maps/server/internal/ingest"
)

func main() {
	pbf := flag.String("pbf", "", "path to an .osm.pbf extract (e.g. Geofabrik)")
	out := flag.String("out", "data.duckdb", "DuckDB file to write")
	flag.Parse()
	if *pbf == "" {
		log.Fatal("-pbf is required")
	}
	db, err := duck.Open(duck.Options{Path: *out})
	if err != nil {
		log.Fatal(err)
	}
	defer db.Close()
	if err := ingest.LoadPBF(context.Background(), db, *pbf); err != nil {
		log.Fatal(err)
	}
	for _, table := range []string{"osm_points", "osm_lines", "osm_polygons"} {
		var n int64
		if err := db.QueryRow("SELECT count(*) FROM " + table).Scan(&n); err != nil {
			log.Fatal(err)
		}
		log.Printf("%s: %d rows", table, n)
	}
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && go test ./internal/ingest/ -v`
Expected: `TestBuildDerived` passes and `TestLoadPBF` is skipped.

If `tags['name']` scans as a list (for example `[Kissa]`) rather than a string, this DuckDB build returns lists from map subscripts. Replace every `tags['x']` / `t['x']` / `w.tags['x']` with `map_extract_value(<map>, 'x')`.

- [ ] **Step 5: Run against a real extract**

```bash
curl -fsSLo /tmp/monaco.osm.pbf https://download.geofabrik.de/europe/monaco-latest.osm.pbf
cd server && OSM_PBF=/tmp/monaco.osm.pbf go test ./internal/ingest/ -run TestLoadPBF -v
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/internal/ingest server/cmd/osm-ingest
git commit -m "feat(server): ingest osm pbf into points, lines and polygons"
```

---
### Task 5: Source compiler and filters

**Files:**
- Create: `server/internal/source/source.go`, `server/internal/source/filters.go`
- Test: `server/internal/source/source_test.go`

**Interfaces:**
- Consumes: `testdb.Data` (tests only).
- Produces:
  - `source.ErrBadRequest` and `source.Ident(name string) (string, error)` (returns the `"quoted"` identifier).
  - `source.Type` (`TypeTable`, `TypeQuery`), `source.SpatialType` (`Geo`, `H3`), `source.DefaultAggregationResLevel = 4`.
  - `source.Source{Type; Name; Query; QueryParameters map[string]any; SpatialDataType; SpatialDataColumn; Columns []string; Filters Filters; FiltersOr bool; AggregationExp string; AggregationResLevel int}`.
  - `(Source).Validate() error`, `(Source).SpatialColumnName() string`, and `(Source).Relation() (rel string, args []any, err error)`. `rel` is a parenthesised SELECT usable after `FROM`; `args` are `sql.Named` values.
  - `source.Filters` = `map[string]map[string]FilterSpec`, `source.FilterSpec{Values []json.RawMessage; Params *StringSearchParams; Owner string}`, and `(Filters).SQL(or bool) (string, []any, error)`.

- [ ] **Step 1: Write the failing tests**

`server/internal/source/source_test.go`:

```go
package source_test

import (
	"database/sql"
	"encoding/json"
	"errors"
	"testing"

	"osm-maps/server/internal/source"
	"osm-maps/server/internal/testdb"
)

func count(t *testing.T, db *sql.DB, s source.Source) int {
	t.Helper()
	rel, args, err := s.Relation()
	if err != nil {
		t.Fatal(err)
	}
	var n int
	if err := db.QueryRow("SELECT count(*) FROM "+rel+" AS r", args...).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func filters(t *testing.T, js string) source.Filters {
	t.Helper()
	var f source.Filters
	if err := json.Unmarshal([]byte(js), &f); err != nil {
		t.Fatal(err)
	}
	return f
}

func table(f source.Filters) source.Source {
	return source.Source{Type: source.TypeTable, Name: "demo_points", SpatialDataType: source.Geo, Filters: f}
}

func TestFilters(t *testing.T) {
	db := testdb.Data(t)
	for _, tc := range []struct {
		name    string
		filters string
		or      bool
		want    int
	}{
		{"no filters", `{}`, false, 400},
		{"in strings", `{"category":{"in":{"values":["cafe"]}}}`, false, 100},
		{"in numbers", `{"id":{"in":{"values":[1,2,3]}}}`, false, 3},
		{"in empty", `{"id":{"in":{"values":[]}}}`, false, 0},
		{"between", `{"value":{"between":{"values":[[0,9]]}}}`, false, 10},
		{"between two ranges", `{"value":{"between":{"values":[[0,4],[10,14]]}}}`, false, 10},
		{"closed_open", `{"value":{"closed_open":{"values":[[0,10]]}}}`, false, 10},
		{"time", `{"ts":{"time":{"values":[[1767225600000,1767258000000]]}}}`, false, 10},
		{"stringSearch contains, case-insensitive", `{"name":{"stringSearch":{"values":["POI-1"]}}}`, false, 111},
		{"stringSearch exact", `{"name":{"stringSearch":{"values":["POI-1"],"params":{"mustStart":true,"mustEnd":true}}}}`, false, 1},
		{"stringSearch case-sensitive", `{"name":{"stringSearch":{"values":["POI-1"],"params":{"caseSensitive":true}}}}`, false, 0},
		{"stringSearch unicode", `{"name":{"stringSearch":{"values":["東京"]}}}`, false, 1},
		{"two columns and", `{"category":{"in":{"values":["cafe"]}},"value":{"between":{"values":[[0,9]]}}}`, false, 3},
		{"two columns or", `{"category":{"in":{"values":["cafe"]}},"value":{"between":{"values":[[0,9]]}}}`, true, 107},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := table(filters(t, tc.filters))
			s.FiltersOr = tc.or
			if got := count(t, db, s); got != tc.want {
				t.Fatalf("count = %d, want %d", got, tc.want)
			}
		})
	}
}

func TestBadRequests(t *testing.T) {
	for name, s := range map[string]source.Source{
		"unknown filter type": table(source.Filters{"value": {"nearly": {}}}),
		"bad filter column":   table(source.Filters{"x; drop": {"in": {}}}),
		"bad table name":      {Type: source.TypeTable, Name: "demo_points; drop", SpatialDataType: source.Geo},
		"three-part name":     {Type: source.TypeTable, Name: "a.b.c", SpatialDataType: source.Geo},
		"empty query":         {Type: source.TypeQuery, Query: " ; ", SpatialDataType: source.Geo},
		"reserved param name": {Type: source.TypeQuery, Query: "SELECT $__x", QueryParameters: map[string]any{"__x": 1}, SpatialDataType: source.Geo},
		"unsupported type":    {Type: "tileset", Name: "t", SpatialDataType: source.Geo},
		"unsupported spatial": {Type: source.TypeTable, Name: "t", SpatialDataType: "quadbin"},
		"bad spatial column":  {Type: source.TypeTable, Name: "t", SpatialDataType: source.Geo, SpatialDataColumn: "geom)"},
	} {
		if _, _, err := s.Relation(); !errors.Is(err, source.ErrBadRequest) {
			t.Errorf("%s: err = %v, want ErrBadRequest", name, err)
		}
	}
}

func TestQuerySources(t *testing.T) {
	db := testdb.Data(t)
	q := func(sql string, params map[string]any) source.Source {
		return source.Source{Type: source.TypeQuery, Query: sql, QueryParameters: params, SpatialDataType: source.Geo}
	}
	for name, tc := range map[string]struct {
		src  source.Source
		want int
	}{
		"scalar param":       {q("SELECT * FROM demo_points WHERE value >= $min", map[string]any{"min": 390.0}), 10},
		"array param":        {q("SELECT * FROM demo_points WHERE list_contains(CAST(CAST($cats AS JSON) AS VARCHAR[]), category)", map[string]any{"cats": []any{"cafe", "park"}}), 200},
		"unreferenced param": {q("SELECT * FROM demo_points", map[string]any{"unused": 1.0}), 400},
		"trailing semicolon": {q("SELECT * FROM demo_points;", nil), 400},
		"trailing comment":   {q("SELECT * FROM demo_points -- all rows", nil), 400},
		"query plus filter":  {func() source.Source { s := q("SELECT * FROM demo_points", nil); s.Filters = filters(t, `{"category":{"in":{"values":["shop"]}}}`); return s }(), 100},
	} {
		t.Run(name, func(t *testing.T) {
			if got := count(t, db, tc.src); got != tc.want {
				t.Fatalf("count = %d, want %d", got, tc.want)
			}
		})
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && go test ./internal/source/ -v`
Expected: FAIL to compile (`undefined: source.Source`).

- [ ] **Step 3: Implement `source.go`**

`server/internal/source/source.go`:

```go
// Package source compiles Data API source parameters into a filtered SQL relation.
package source

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"
)

var ErrBadRequest = errors.New("bad request")

var identRe = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

// Ident validates a SQL identifier and returns it double-quoted.
func Ident(name string) (string, error) {
	if !identRe.MatchString(name) {
		return "", fmt.Errorf("%w: invalid identifier %q", ErrBadRequest, name)
	}
	return `"` + name + `"`, nil
}

type Type string

const (
	TypeTable Type = "table"
	TypeQuery Type = "query"
)

type SpatialType string

const (
	Geo SpatialType = "geo"
	H3  SpatialType = "h3"
)

const DefaultAggregationResLevel = 4

// Source is one table or query source, as sent by the CARTO client (ledger A2).
type Source struct {
	Type                Type
	Name                string // table name, TypeTable only
	Query               string // SELECT, TypeQuery only; DuckDB named params $name
	QueryParameters     map[string]any
	SpatialDataType     SpatialType
	SpatialDataColumn   string
	Columns             []string
	Filters             Filters
	FiltersOr           bool
	AggregationExp      string
	AggregationResLevel int
}

// SpatialColumnName returns the spatial column, defaulting to geom (geo) or h3 (h3).
func (s Source) SpatialColumnName() string {
	if s.SpatialDataColumn != "" {
		return s.SpatialDataColumn
	}
	if s.SpatialDataType == H3 {
		return "h3"
	}
	return "geom"
}

func (s Source) Validate() error {
	switch s.Type {
	case TypeTable, TypeQuery:
	default:
		return fmt.Errorf("%w: unsupported source type %q", ErrBadRequest, s.Type)
	}
	switch s.SpatialDataType {
	case Geo, H3:
	default:
		return fmt.Errorf("%w: unsupported spatialDataType %q", ErrBadRequest, s.SpatialDataType)
	}
	if _, err := Ident(s.SpatialColumnName()); err != nil {
		return err
	}
	if s.AggregationResLevel < 0 || s.AggregationResLevel > 15 {
		return fmt.Errorf("%w: aggregationResLevel must be 0..15", ErrBadRequest)
	}
	return nil
}

// Relation returns "(SELECT * FROM <source> AS _src [WHERE <filters>])" and its named args.
func (s Source) Relation() (string, []any, error) {
	if err := s.Validate(); err != nil {
		return "", nil, err
	}
	var (
		from string
		args []any
	)
	switch s.Type {
	case TypeTable:
		parts := strings.Split(s.Name, ".")
		if len(parts) > 2 {
			return "", nil, fmt.Errorf("%w: invalid table name %q", ErrBadRequest, s.Name)
		}
		quoted := make([]string, len(parts))
		for i, p := range parts {
			q, err := Ident(p)
			if err != nil {
				return "", nil, err
			}
			quoted[i] = q
		}
		from = strings.Join(quoted, ".")
	case TypeQuery:
		q := strings.TrimRight(strings.TrimSpace(s.Query), "; \t\r\n")
		if q == "" {
			return "", nil, fmt.Errorf("%w: q is required", ErrBadRequest)
		}
		// Newlines keep a trailing "-- comment" from swallowing the closing parenthesis.
		from = "(\n" + q + "\n)"
		var err error
		if args, err = bindParams(q, s.QueryParameters); err != nil {
			return "", nil, err
		}
	}
	where, fargs, err := s.Filters.SQL(s.FiltersOr)
	if err != nil {
		return "", nil, err
	}
	args = append(args, fargs...)
	rel := "(SELECT * FROM " + from + " AS _src"
	if where != "" {
		rel += " WHERE " + where
	}
	return rel + ")", args, nil
}

// bindParams binds only the parameters the query references: DuckDB rejects unused named args.
// Arrays and objects are bound as JSON text; the query casts them (spec §4.2).
func bindParams(q string, params map[string]any) ([]any, error) {
	names := make([]string, 0, len(params))
	for k := range params {
		names = append(names, k)
	}
	sort.Strings(names)
	var args []any
	for _, k := range names {
		if !identRe.MatchString(k) || strings.HasPrefix(k, "__") {
			return nil, fmt.Errorf("%w: invalid query parameter name %q", ErrBadRequest, k)
		}
		if !regexp.MustCompile(`\$` + k + `\b`).MatchString(q) {
			continue
		}
		switch v := params[k].(type) {
		case []any, map[string]any:
			b, err := json.Marshal(v)
			if err != nil {
				return nil, fmt.Errorf("%w: query parameter %q: %v", ErrBadRequest, k, err)
			}
			args = append(args, sql.Named(k, string(b)))
		default:
			args = append(args, sql.Named(k, v))
		}
	}
	return args, nil
}
```

- [ ] **Step 4: Implement `filters.go`**

`server/internal/source/filters.go`:

```go
package source

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strings"
)

// Filters is the CARTO filter object: column -> filter type -> spec (ledger D8).
type Filters map[string]map[string]FilterSpec

type FilterSpec struct {
	Values []json.RawMessage    `json:"values"`
	Params *StringSearchParams `json:"params,omitempty"`
	Owner  string              `json:"owner,omitempty"`
}

type StringSearchParams struct {
	UseRegExp     bool `json:"useRegExp"`
	MustStart     bool `json:"mustStart"`
	MustEnd       bool `json:"mustEnd"`
	CaseSensitive bool `json:"caseSensitive"`
}

// SQL returns a WHERE expression (without "WHERE") and its named args (__f0, __f1, …).
// Clauses for different columns are joined with AND, or with OR when or is true.
func (f Filters) SQL(or bool) (string, []any, error) {
	var (
		clauses []string
		args    []any
	)
	next := func(v any) string {
		name := fmt.Sprintf("__f%d", len(args))
		args = append(args, sql.Named(name, v))
		return "$" + name
	}
	for _, col := range sortedKeys(f) {
		qc, err := Ident(col)
		if err != nil {
			return "", nil, err
		}
		for _, typ := range sortedKeys(f[col]) {
			c, err := filterClause(qc, typ, f[col][typ], next)
			if err != nil {
				return "", nil, err
			}
			clauses = append(clauses, "("+c+")")
		}
	}
	join := " AND "
	if or {
		join = " OR "
	}
	return strings.Join(clauses, join), args, nil
}

func filterClause(col, typ string, spec FilterSpec, next func(any) string) (string, error) {
	switch typ {
	case "in":
		vals, numeric, err := scalars(spec.Values)
		if err != nil {
			return "", err
		}
		if len(vals) == 0 {
			return "FALSE", nil
		}
		b, _ := json.Marshal(vals)
		if numeric {
			return fmt.Sprintf("list_contains(CAST(CAST(%s AS JSON) AS DOUBLE[]), CAST(%s AS DOUBLE))", next(string(b)), col), nil
		}
		return fmt.Sprintf("list_contains(CAST(CAST(%s AS JSON) AS VARCHAR[]), CAST(%s AS VARCHAR))", next(string(b)), col), nil
	case "between", "closed_open", "time":
		ranges, err := pairs(spec.Values)
		if err != nil {
			return "", err
		}
		if len(ranges) == 0 {
			return "FALSE", nil
		}
		expr, hi := col, "<="
		if typ == "time" {
			expr = "epoch_ms(CAST(" + col + " AS TIMESTAMP))"
		}
		if typ == "closed_open" {
			hi = "<"
		}
		ors := make([]string, len(ranges))
		for i, r := range ranges {
			ors[i] = fmt.Sprintf("%s >= %s AND %s %s %s", expr, next(r[0]), expr, hi, next(r[1]))
		}
		return strings.Join(ors, " OR "), nil
	case "stringSearch":
		strs, err := stringsOf(spec.Values)
		if err != nil {
			return "", err
		}
		if len(strs) == 0 {
			return "TRUE", nil
		}
		var p StringSearchParams
		if spec.Params != nil {
			p = *spec.Params
		}
		opts := "'i'"
		if p.CaseSensitive {
			opts = "''"
		}
		ors := make([]string, len(strs))
		for i, s := range strs {
			pat := s
			if !p.UseRegExp {
				pat = regexp.QuoteMeta(s)
			}
			if p.MustStart {
				pat = "^" + pat
			}
			if p.MustEnd {
				pat += "$"
			}
			ors[i] = fmt.Sprintf("regexp_matches(CAST(%s AS VARCHAR), %s, %s)", col, next(pat), opts)
		}
		return strings.Join(ors, " OR "), nil
	default:
		return "", fmt.Errorf("%w: unknown filter type %q", ErrBadRequest, typ)
	}
}

func scalars(raw []json.RawMessage) ([]any, bool, error) {
	vals := make([]any, 0, len(raw))
	numeric := len(raw) > 0
	for _, r := range raw {
		var v any
		if err := json.Unmarshal(r, &v); err != nil {
			return nil, false, fmt.Errorf("%w: filter value: %v", ErrBadRequest, err)
		}
		switch v.(type) {
		case float64:
		case string, bool:
			numeric = false
		default:
			return nil, false, fmt.Errorf("%w: filter values must be scalars", ErrBadRequest)
		}
		vals = append(vals, v)
	}
	return vals, numeric, nil
}

func pairs(raw []json.RawMessage) ([][2]float64, error) {
	out := make([][2]float64, 0, len(raw))
	for _, r := range raw {
		var p []float64
		if err := json.Unmarshal(r, &p); err != nil || len(p) != 2 {
			return nil, fmt.Errorf("%w: range filter values must be [min, max] number pairs", ErrBadRequest)
		}
		out = append(out, [2]float64{p[0], p[1]})
	}
	return out, nil
}

func stringsOf(raw []json.RawMessage) ([]string, error) {
	out := make([]string, 0, len(raw))
	for _, r := range raw {
		var s string
		if err := json.Unmarshal(r, &s); err != nil {
			return nil, fmt.Errorf("%w: stringSearch values must be strings", ErrBadRequest)
		}
		out = append(out, s)
	}
	return out, nil
}

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd server && go test ./internal/source/ -v`
Expected: PASS.

If `"unreferenced param"` fails because DuckDB still sees an unused named arg, the driver passes all args. Check that `bindParams` returns no arg for `unused`; the regex skip is what prevents it.

If `regexp_matches` rejects a bound pattern ("pattern must be constant"), inline the pattern as a SQL string literal instead: `"'" + strings.ReplaceAll(pat, "'", "''") + "'"`. The pattern is already escaped by `QuoteMeta` unless `useRegExp` is set.

- [ ] **Step 6: Commit**

```bash
git add server/internal/source
git commit -m "feat(server): compile table and query sources with carto filters"
```

---
### Task 6: Schema, bounds and tilestats

**Files:**
- Create: `server/internal/describe/describe.go`
- Test: `server/internal/describe/describe_test.go`

**Interfaces:**
- Consumes: `source.Source.Relation()` (in tests), `testdb.Data`.
- Produces. `rel` is the relation string from `Relation()`; `geomCol` / `cellCol` are **already quoted** identifiers.
  - `describe.Column{Name string \`json:"name"\`; Type string \`json:"type"\`}`. Type is one of `number`, `string`, `boolean`, `timestamp`, `geometry`, `unknown`.
  - `describe.Kind(dbType string) string`
  - `describe.Schema(ctx, db, rel string, args []any) ([]Column, error)`
  - `describe.GeometryType(ctx, db, rel, geomCol string, args []any) (string, error)` returns `"Point"`, `"LineString"`, `"Polygon"` or `""`.
  - `describe.GeoBounds(ctx, db, rel, geomCol string, args []any) ([4]float64, bool, error)` and `describe.H3Bounds(...)` with the same signature.
  - `describe.H3Resolution(ctx, db, rel, cellCol string, args []any) (int, bool, error)`
  - `describe.LayerName = "default"`, plus `describe.Tilestats`, `StatsLayer`, `Attribute`, `Category`, and `describe.Stats(ctx, db, rel string, args []any, cols []Column, geometry string) (Tilestats, error)`.

- [ ] **Step 1: Write the failing tests**

`server/internal/describe/describe_test.go`:

```go
package describe_test

import (
	"context"
	"math"
	"testing"

	"osm-maps/server/internal/describe"
	"osm-maps/server/internal/source"
	"osm-maps/server/internal/testdb"
)

func rel(t *testing.T, f source.Filters) (string, []any) {
	t.Helper()
	r, args, err := source.Source{Type: source.TypeTable, Name: "demo_points", SpatialDataType: source.Geo, Filters: f}.Relation()
	if err != nil {
		t.Fatal(err)
	}
	return r, args
}

func TestSchema(t *testing.T) {
	db := testdb.Data(t)
	r, args := rel(t, nil)
	cols, err := describe.Schema(context.Background(), db, r, args)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]string{}
	for _, c := range cols {
		got[c.Name] = c.Type
	}
	for name, want := range map[string]string{"id": "number", "name": "string", "category": "string", "value": "number", "ts": "timestamp", "h3": "number"} {
		if got[name] != want {
			t.Errorf("%s: type %q, want %q", name, got[name], want)
		}
	}
	if g := got["geom"]; g != "geometry" && g != "unknown" {
		t.Errorf("geom: type %q", g)
	}
}

func TestStatsAndBounds(t *testing.T) {
	db := testdb.Data(t)
	ctx := context.Background()
	r, args := rel(t, nil)

	stats, err := describe.Stats(ctx, db, r, args, []describe.Column{{Name: "category", Type: "string"}, {Name: "value", Type: "number"}}, "Point")
	if err != nil {
		t.Fatal(err)
	}
	l := stats.Layers[0]
	if stats.LayerCount != 1 || l.Layer != "default" || l.Count != 400 || l.Geometry != "Point" || l.AttributeCount != 2 {
		t.Fatalf("layer = %+v", l)
	}
	if cat := l.Attributes[0]; cat.Type != "String" || len(cat.Categories) != 4 || cat.Categories[0].Frequency != 100 {
		t.Errorf("category attribute = %+v", cat)
	}
	if v := l.Attributes[1]; v.Type != "Number" || v.Min == nil || *v.Min != 0 || v.Max == nil || *v.Max != 399 {
		t.Errorf("value attribute = %+v", v)
	}

	gt, err := describe.GeometryType(ctx, db, r, `"geom"`, args)
	if err != nil || gt != "Point" {
		t.Fatalf("GeometryType = %q, %v", gt, err)
	}
	b, ok, err := describe.GeoBounds(ctx, db, r, `"geom"`, args)
	if err != nil || !ok {
		t.Fatalf("GeoBounds: ok=%v err=%v", ok, err)
	}
	want := [4]float64{139.70, 35.65, 139.795, 35.745}
	for i := range b {
		if math.Abs(b[i]-want[i]) > 1e-9 {
			t.Fatalf("bounds = %v, want %v", b, want)
		}
	}

	res, ok, err := describe.H3Resolution(ctx, db, r, `"h3"`, args)
	if err != nil || !ok || res != 12 {
		t.Fatalf("H3Resolution = %d %v %v", res, ok, err)
	}
	hb, ok, err := describe.H3Bounds(ctx, db, r, `"h3"`, args)
	if err != nil || !ok || hb[0] < 139.69 || hb[2] > 139.80 {
		t.Fatalf("H3Bounds = %v %v %v", hb, ok, err)
	}
}

func TestEmptyRelation(t *testing.T) {
	db := testdb.Data(t)
	ctx := context.Background()
	r, args := rel(t, source.Filters{"id": {"in": {}}}) // "in" with no values matches nothing
	if _, ok, err := describe.GeoBounds(ctx, db, r, `"geom"`, args); err != nil || ok {
		t.Fatalf("GeoBounds on empty: ok=%v err=%v", ok, err)
	}
	if gt, err := describe.GeometryType(ctx, db, r, `"geom"`, args); err != nil || gt != "" {
		t.Fatalf("GeometryType on empty = %q, %v", gt, err)
	}
	if _, ok, err := describe.H3Resolution(ctx, db, r, `"h3"`, args); err != nil || ok {
		t.Fatalf("H3Resolution on empty: ok=%v err=%v", ok, err)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && go test ./internal/describe/ -v`
Expected: FAIL to compile (`undefined: describe.Schema`).

- [ ] **Step 3: Implement `describe.go`**

`server/internal/describe/describe.go`:

```go
// Package describe derives schema, bounds and tilestats for a source relation.
package describe

import (
	"context"
	"database/sql"
	"errors"
	"strings"
)

const LayerName = "default"

type Column struct {
	Name string `json:"name"`
	Type string `json:"type"`
}

// Kind maps a DuckDB type name to the schema type sent to clients.
func Kind(dbType string) string {
	t := strings.ToUpper(dbType)
	switch {
	case t == "BOOLEAN":
		return "boolean"
	case t == "GEOMETRY":
		return "geometry"
	case strings.HasPrefix(t, "DECIMAL"):
		return "number"
	case strings.HasPrefix(t, "TIMESTAMP"), t == "DATE", strings.HasPrefix(t, "TIME"):
		return "timestamp"
	case t == "VARCHAR", t == "UUID", strings.HasPrefix(t, "ENUM"):
		return "string"
	}
	switch t {
	case "TINYINT", "SMALLINT", "INTEGER", "BIGINT", "HUGEINT",
		"UTINYINT", "USMALLINT", "UINTEGER", "UBIGINT", "UHUGEINT", "FLOAT", "DOUBLE":
		return "number"
	}
	return "unknown"
}

// Schema returns the relation's columns without reading any rows.
func Schema(ctx context.Context, db *sql.DB, rel string, args []any) ([]Column, error) {
	rows, err := db.QueryContext(ctx, "SELECT * FROM "+rel+" AS _r LIMIT 0", args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	types, err := rows.ColumnTypes()
	if err != nil {
		return nil, err
	}
	cols := make([]Column, len(types))
	for i, ct := range types {
		cols[i] = Column{Name: ct.Name(), Type: Kind(ct.DatabaseTypeName())}
	}
	return cols, rows.Err()
}

func GeometryType(ctx context.Context, db *sql.DB, rel, geomCol string, args []any) (string, error) {
	var t sql.NullString
	err := db.QueryRowContext(ctx, "SELECT CAST(ST_GeometryType("+geomCol+") AS VARCHAR) FROM "+rel+" AS _r WHERE "+geomCol+" IS NOT NULL LIMIT 1", args...).Scan(&t)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	switch strings.ToUpper(t.String) {
	case "POINT", "MULTIPOINT":
		return "Point", nil
	case "LINESTRING", "MULTILINESTRING":
		return "LineString", nil
	case "POLYGON", "MULTIPOLYGON":
		return "Polygon", nil
	}
	return "", nil
}

func GeoBounds(ctx context.Context, db *sql.DB, rel, geomCol string, args []any) ([4]float64, bool, error) {
	return bounds(ctx, db, "SELECT ST_XMin(e), ST_YMin(e), ST_XMax(e), ST_YMax(e) FROM (SELECT ST_Extent_Agg("+geomCol+") AS e FROM "+rel+" AS _r)", args)
}

// H3Bounds is the bbox of the cell centres.
func H3Bounds(ctx context.Context, db *sql.DB, rel, cellCol string, args []any) ([4]float64, bool, error) {
	return bounds(ctx, db, "SELECT min(h3_cell_to_lng(c)), min(h3_cell_to_lat(c)), max(h3_cell_to_lng(c)), max(h3_cell_to_lat(c)) FROM (SELECT "+cellCol+" AS c FROM "+rel+" AS _r WHERE "+cellCol+" IS NOT NULL)", args)
}

func bounds(ctx context.Context, db *sql.DB, q string, args []any) ([4]float64, bool, error) {
	var v [4]sql.NullFloat64
	if err := db.QueryRowContext(ctx, q, args...).Scan(&v[0], &v[1], &v[2], &v[3]); err != nil {
		return [4]float64{}, false, err
	}
	if !v[0].Valid {
		return [4]float64{}, false, nil
	}
	return [4]float64{v[0].Float64, v[1].Float64, v[2].Float64, v[3].Float64}, true, nil
}

func H3Resolution(ctx context.Context, db *sql.DB, rel, cellCol string, args []any) (int, bool, error) {
	var r sql.NullInt64
	err := db.QueryRowContext(ctx, "SELECT h3_get_resolution("+cellCol+") FROM "+rel+" AS _r WHERE "+cellCol+" IS NOT NULL LIMIT 1", args...).Scan(&r)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, err
	}
	return int(r.Int64), r.Valid, nil
}

type Tilestats struct {
	LayerCount int          `json:"layerCount"`
	Layers     []StatsLayer `json:"layers"`
}

type StatsLayer struct {
	Layer          string      `json:"layer"`
	Count          int64       `json:"count"`
	Geometry       string      `json:"geometry,omitempty"`
	AttributeCount int         `json:"attributeCount"`
	Attributes     []Attribute `json:"attributes"`
}

type Attribute struct {
	Attribute  string     `json:"attribute"`
	Type       string     `json:"type"`
	Min        *float64   `json:"min,omitempty"`
	Max        *float64   `json:"max,omitempty"`
	Categories []Category `json:"categories,omitempty"`
}

type Category struct {
	Category  string `json:"category"`
	Frequency int64  `json:"frequency"`
}

// Stats computes the row count, min/max for numbers and the top 10 categories for strings/booleans.
func Stats(ctx context.Context, db *sql.DB, rel string, args []any, cols []Column, geometry string) (Tilestats, error) {
	sel := []string{"count(*)"}
	var numeric int
	for _, c := range cols {
		if c.Type == "number" {
			q := quote(c.Name)
			sel = append(sel, "min(CAST("+q+" AS DOUBLE))", "max(CAST("+q+" AS DOUBLE))")
			numeric++
		}
	}
	var count int64
	mins := make([]sql.NullFloat64, numeric)
	maxs := make([]sql.NullFloat64, numeric)
	dest := []any{&count}
	for k := 0; k < numeric; k++ {
		dest = append(dest, &mins[k], &maxs[k])
	}
	if err := db.QueryRowContext(ctx, "SELECT "+strings.Join(sel, ", ")+" FROM "+rel+" AS _r", args...).Scan(dest...); err != nil {
		return Tilestats{}, err
	}
	attrs := make([]Attribute, 0, len(cols))
	k := 0
	for _, c := range cols {
		a := Attribute{Attribute: c.Name, Type: statsType(c.Type)}
		switch c.Type {
		case "number":
			if mins[k].Valid {
				a.Min = &mins[k].Float64
			}
			if maxs[k].Valid {
				a.Max = &maxs[k].Float64
			}
			k++
		case "string", "boolean":
			cats, err := categories(ctx, db, rel, c.Name, args)
			if err != nil {
				return Tilestats{}, err
			}
			a.Categories = cats
		}
		attrs = append(attrs, a)
	}
	return Tilestats{LayerCount: 1, Layers: []StatsLayer{{
		Layer: LayerName, Count: count, Geometry: geometry, AttributeCount: len(attrs), Attributes: attrs,
	}}}, nil
}

func categories(ctx context.Context, db *sql.DB, rel, col string, args []any) ([]Category, error) {
	q := quote(col)
	rows, err := db.QueryContext(ctx, "SELECT CAST("+q+" AS VARCHAR) AS c, count(*) AS n FROM "+rel+" AS _r WHERE "+q+" IS NOT NULL GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 10", args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Category
	for rows.Next() {
		var c Category
		if err := rows.Scan(&c.Category, &c.Frequency); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func statsType(kind string) string {
	switch kind {
	case "number":
		return "Number"
	case "boolean":
		return "Boolean"
	case "timestamp":
		return "Date"
	}
	return "String"
}

func quote(name string) string { return `"` + strings.ReplaceAll(name, `"`, `""`) + `"` }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && go test ./internal/describe/ -v`
Expected: PASS.

If `h3` reports `unknown` (the driver names UBIGINT differently), print `ct.DatabaseTypeName()` for each column. Add the reported spelling to the `number` list in `Kind`.

- [ ] **Step 5: Commit**

```bash
git add server/internal/describe
git commit -m "feat(server): describe source schema, bounds and tilestats"
```

---
### Task 7: Tile math and MVT tiles

**Files:**
- Create: `server/internal/tiles/tilemath.go`, `server/internal/tiles/mvt.go`
- Test: `server/internal/tiles/tilemath_test.go`, `server/internal/tiles/mvt_test.go`

**Interfaces:**
- Consumes: `describe.Column`, `source.Source.Relation()` (tests), `testdb.Data`.
- Produces:
  - `tiles.TileBounds(z, x, y int) (minLon, minLat, maxLon, maxLat float64)`, `tiles.ValidTile(z, x, y int) bool`, `tiles.LonLatToTile(lon, lat float64, z int) (x, y int)`.
  - `tiles.MVTLayer = "default"`, `tiles.FeatureIDColumn = "_carto_feature_id"`, `tiles.ErrTooLarge`.
  - `tiles.MVTRequest{Relation string; Args []any; GeomColumn string /* quoted */; Props []describe.Column; FeatureID bool; Z, X, Y int; MaxFeatures int}`.
  - `tiles.MVT(ctx, db, r MVTRequest) ([]byte, error)`. It returns `nil, nil` for an empty tile.

- [ ] **Step 1: Write the failing tests**

`server/internal/tiles/tilemath_test.go`:

```go
package tiles_test

import (
	"math"
	"testing"

	"osm-maps/server/internal/tiles"
)

func near(a, b float64) bool { return math.Abs(a-b) < 1e-4 }

func TestTileBounds(t *testing.T) {
	w, s, e, n := tiles.TileBounds(0, 0, 0)
	if !near(w, -180) || !near(e, 180) || !near(s, -85.05113) || !near(n, 85.05113) {
		t.Fatalf("0/0/0 = %v %v %v %v", w, s, e, n)
	}
	w, s, e, n = tiles.TileBounds(1, 1, 0)
	if !near(w, 0) || !near(e, 180) || !near(s, 0) || !near(n, 85.05113) {
		t.Fatalf("1/1/0 = %v %v %v %v", w, s, e, n)
	}
}

func TestLonLatToTileRoundTrip(t *testing.T) {
	x, y := tiles.LonLatToTile(139.75, 35.7, 12)
	w, s, e, n := tiles.TileBounds(12, x, y)
	if 139.75 < w || 139.75 > e || 35.7 < s || 35.7 > n {
		t.Fatalf("point not inside its tile %d/%d: %v %v %v %v", x, y, w, s, e, n)
	}
}

func TestValidTile(t *testing.T) {
	for _, c := range [][3]int{{0, 0, 0}, {3, 7, 7}, {22, 0, 4194303}} {
		if !tiles.ValidTile(c[0], c[1], c[2]) {
			t.Errorf("%v should be valid", c)
		}
	}
	for _, c := range [][3]int{{-1, 0, 0}, {25, 0, 0}, {3, 8, 0}, {3, 0, -1}} {
		if tiles.ValidTile(c[0], c[1], c[2]) {
			t.Errorf("%v should be invalid", c)
		}
	}
}
```

`server/internal/tiles/mvt_test.go`:

```go
package tiles_test

import (
	"context"
	"errors"
	"testing"

	"github.com/paulmach/orb/encoding/mvt"

	"osm-maps/server/internal/describe"
	"osm-maps/server/internal/source"
	"osm-maps/server/internal/testdb"
	"osm-maps/server/internal/tiles"
)

func demoRequest(t *testing.T) tiles.MVTRequest {
	t.Helper()
	rel, args, err := source.Source{Type: source.TypeTable, Name: "demo_points", SpatialDataType: source.Geo}.Relation()
	if err != nil {
		t.Fatal(err)
	}
	return tiles.MVTRequest{
		Relation: rel, Args: args, GeomColumn: `"geom"`,
		Props:     []describe.Column{{Name: "name", Type: "string"}, {Name: "value", Type: "number"}},
		FeatureID: true, MaxFeatures: 1000,
	}
}

func TestMVTWorldTile(t *testing.T) {
	db := testdb.Data(t)
	b, err := tiles.MVT(context.Background(), db, demoRequest(t))
	if err != nil {
		t.Fatal(err)
	}
	layers, err := mvt.Unmarshal(b)
	if err != nil {
		t.Fatal(err)
	}
	if len(layers) != 1 || layers[0].Name != tiles.MVTLayer {
		t.Fatalf("layers = %+v", layers)
	}
	fs := layers[0].Features
	if len(fs) != 400 {
		t.Fatalf("features = %d, want 400", len(fs))
	}
	var tokyo bool
	for _, f := range fs {
		if _, ok := f.Properties[tiles.FeatureIDColumn]; !ok {
			t.Fatal("missing _carto_feature_id")
		}
		if _, ok := f.Properties["value"].(float64); !ok {
			t.Fatalf("value is %T, want float64", f.Properties["value"])
		}
		if f.Properties["name"] == "東京駅" {
			tokyo = true
		}
	}
	if !tokyo {
		t.Fatal("unicode name 東京駅 not found in tile properties")
	}
}

func TestMVTZoomedTile(t *testing.T) {
	db := testdb.Data(t)
	r := demoRequest(t)
	r.Z = 14
	r.X, r.Y = tiles.LonLatToTile(139.70, 35.65, 14)
	b, err := tiles.MVT(context.Background(), db, r)
	if err != nil {
		t.Fatal(err)
	}
	layers, err := mvt.Unmarshal(b)
	if err != nil {
		t.Fatal(err)
	}
	if n := len(layers[0].Features); n == 0 || n >= 400 {
		t.Fatalf("z14 features = %d, want 0 < n < 400", n)
	}
}

func TestMVTEmptyTile(t *testing.T) {
	db := testdb.Data(t)
	r := demoRequest(t)
	r.Z, r.X, r.Y = 10, 0, 0 // Arctic Ocean at the antimeridian, far from Tokyo
	b, err := tiles.MVT(context.Background(), db, r)
	if err != nil || len(b) != 0 {
		t.Fatalf("empty tile: len=%d err=%v", len(b), err)
	}
}

func TestMVTTooLarge(t *testing.T) {
	db := testdb.Data(t)
	r := demoRequest(t)
	r.MaxFeatures = 10
	if _, err := tiles.MVT(context.Background(), db, r); !errors.Is(err, tiles.ErrTooLarge) {
		t.Fatalf("err = %v, want ErrTooLarge", err)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && go test ./internal/tiles/ -v`
Expected: FAIL to compile (`undefined: tiles.TileBounds`).

- [ ] **Step 3: Implement the tile math**

`server/internal/tiles/tilemath.go`:

```go
// Package tiles encodes vector (MVT) and spatial-index (H3) tiles from DuckDB.
package tiles

import "math"

const maxZoom = 24

// TileBounds returns the WGS84 bounding box of an XYZ (slippy map) tile.
func TileBounds(z, x, y int) (minLon, minLat, maxLon, maxLat float64) {
	n := math.Exp2(float64(z))
	minLon = float64(x)/n*360 - 180
	maxLon = float64(x+1)/n*360 - 180
	maxLat = tileLat(float64(y), n)
	minLat = tileLat(float64(y+1), n)
	return
}

func tileLat(y, n float64) float64 {
	return math.Atan(math.Sinh(math.Pi*(1-2*y/n))) * 180 / math.Pi
}

func ValidTile(z, x, y int) bool {
	if z < 0 || z > maxZoom {
		return false
	}
	n := 1 << z
	return x >= 0 && x < n && y >= 0 && y < n
}

// LonLatToTile returns the XYZ tile containing a WGS84 point at zoom z.
func LonLatToTile(lon, lat float64, z int) (x, y int) {
	n := math.Exp2(float64(z))
	r := lat * math.Pi / 180
	x = int(math.Floor((lon + 180) / 360 * n))
	y = int(math.Floor((1 - math.Log(math.Tan(r)+1/math.Cos(r))/math.Pi) / 2 * n))
	return
}
```

- [ ] **Step 4: Implement the MVT encoder**

`server/internal/tiles/mvt.go`. Use the `ST_AsMVT` call shape that Task 1 pinned:

```go
package tiles

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"math"
	"strings"

	"osm-maps/server/internal/describe"
)

const (
	MVTLayer        = describe.LayerName
	FeatureIDColumn = "_carto_feature_id"
	mvtExtent       = 4096
	mvtBuffer       = 256
	defaultMax      = 200_000
)

var ErrTooLarge = errors.New("tile too large")

type MVTRequest struct {
	Relation    string
	Args        []any
	GeomColumn  string // quoted
	Props       []describe.Column
	FeatureID   bool
	Z, X, Y     int
	MaxFeatures int
}

// MVT returns one Mapbox Vector Tile (layer "default", EPSG:3857), or nil when the tile is empty.
func MVT(ctx context.Context, db *sql.DB, r MVTRequest) ([]byte, error) {
	minLon, minLat, maxLon, maxLat := TileBounds(r.Z, r.X, r.Y)
	bx := (maxLon - minLon) * mvtBuffer / mvtExtent
	by := (maxLat - minLat) * mvtBuffer / mvtExtent
	max := r.MaxFeatures
	if max <= 0 {
		max = defaultMax
	}

	fields := []string{"'__geom': __g"}
	for _, c := range r.Props {
		fields = append(fields, fmt.Sprintf("'%s': %s", c.Name, mvtValue(`"`+c.Name+`"`, c.Type)))
	}
	if r.FeatureID {
		// Stable per geometry and below 2^53, so JavaScript reads it exactly.
		fields = append(fields, "'"+FeatureIDColumn+"': CAST(hash(ST_AsWKB(__orig)) % 9007199254740991 AS DOUBLE)")
	}

	q := fmt.Sprintf(`
WITH src AS (
  SELECT *, %[1]s AS __orig FROM %[2]s AS _r
  WHERE %[1]s IS NOT NULL AND ST_Intersects(%[1]s, ST_MakeEnvelope($__xmin, $__ymin, $__xmax, $__ymax))
  LIMIT %[3]d
), clipped AS (
  SELECT *, ST_AsMVTGeom(ST_Transform(__orig, 'EPSG:4326', 'EPSG:3857', always_xy := true),
                         ST_Extent(ST_TileEnvelope($__z, $__x, $__y)), %[4]d, %[5]d, true) AS __g
  FROM src
)
SELECT (SELECT count(*) FROM src),
       (SELECT ST_AsMVT({%[6]s}, '%[7]s', %[4]d, '__geom') FROM clipped WHERE __g IS NOT NULL)`,
		r.GeomColumn, r.Relation, max+1, mvtExtent, mvtBuffer, strings.Join(fields, ", "), MVTLayer)

	args := append(append([]any{}, r.Args...),
		sql.Named("__xmin", minLon-bx), sql.Named("__ymin", math.Max(minLat-by, -90)),
		sql.Named("__xmax", maxLon+bx), sql.Named("__ymax", math.Min(maxLat+by, 90)),
		sql.Named("__z", r.Z), sql.Named("__x", r.X), sql.Named("__y", r.Y))

	var (
		n    int64
		tile []byte
	)
	if err := db.QueryRowContext(ctx, q, args...).Scan(&n, &tile); err != nil {
		return nil, err
	}
	if n > int64(max) {
		return nil, fmt.Errorf("%w: more than %d features; aggregate the source or zoom in", ErrTooLarge, max)
	}
	return tile, nil
}

func mvtValue(col, kind string) string {
	switch kind {
	case "number":
		return "CAST(" + col + " AS DOUBLE)"
	case "boolean":
		return col
	}
	return "CAST(" + col + " AS VARCHAR)"
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd server && go test ./internal/tiles/ -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/internal/tiles
git commit -m "feat(server): encode mvt tiles with duckdb st_asmvt"
```

---
### Task 8: CARTO spatial tile encoder and H3 tiles

**Files:**
- Create: `server/internal/tiles/spatialtile.go`, `server/internal/tiles/h3.go`
- Test: `server/internal/tiles/spatialtile_test.go`, `server/internal/tiles/h3_test.go`

**Interfaces:**
- Consumes: `describe.Kind`, `source.ErrBadRequest`, `source.Source.Relation()` (tests), `testdb.Data`.
- Produces:
  - `tiles.SpatialTile{Cells []uint64; Props []map[string]string; NumericProps map[string][]float64}`, `(SpatialTile).Encode() []byte`, `tiles.DecodeSpatialTile(b []byte) (SpatialTile, error)`.
  - `tiles.H3Res(cell uint64) int`, `tiles.ParseH3(s string) (uint64, error)`.
  - `tiles.H3Request{Relation string; Args []any; CellColumn string /* quoted */; AggregationExp string; AggregationResLevel int; DataRes int; Tile uint64}`.
  - `tiles.H3Tile(ctx, db, r H3Request) (SpatialTile, error)`.

Wire format, from ledger A6. It was read from the minified `cartoSpatialTile` loader (deck.gl 9.3.3, readers `aS`, `cS`, `_0e`, `eh`, `rS`, `th`, `nS`, `rm`). "bytes" fields hold **raw little-endian arrays**, not packed varints:

```
Tile        { 1: scheme (varint, ignored by the client)   2: Cells }
Cells       { 1: Indices   2: repeated Props (exactly one per cell, index-aligned)   3: repeated NumericProp }
Indices     { 1: bytes = little-endian uint64[] }
Props       { 1: repeated KV }          KV      { 1: key string   2: value string }
NumericProp { 1: key string   2: Doubles }   Doubles { 1: bytes = little-endian float64[] }
```

- [ ] **Step 1: Pin the wire format against the shipped client**

Run this once `web/` exists (Task 13). Until then, keep it as a recorded check:

```bash
grep -rn "cartoSpatialTile\|BigUint64Array" web/node_modules/@deck.gl/carto/dist/index.js | head
```

Expected: readers whose field numbers match the table above. If any number differs, change the constants in `spatialtile.go` and the golden bytes in Step 2.

- [ ] **Step 2: Write the failing tests**

`server/internal/tiles/spatialtile_test.go`:

```go
package tiles_test

import (
	"encoding/hex"
	"math"
	"reflect"
	"testing"

	"osm-maps/server/internal/tiles"
)

func TestSpatialTileGolden(t *testing.T) {
	got := hex.EncodeToString(tiles.SpatialTile{Cells: []uint64{1}}.Encode())
	// Tile.2 len 14 { Cells.1 len 10 { Indices.1 len 8: 01 00.. } Cells.2 len 0 (empty props for cell 0) }
	want := "120e0a0a0a080100000000000000" + "1200"
	if got != want {
		t.Fatalf("encoding = %s, want %s", got, want)
	}
}

func TestSpatialTileRoundTrip(t *testing.T) {
	in := tiles.SpatialTile{
		Cells:        []uint64{0x8a2f5a32a8a7fff, 0x8a2f5a32a8b7fff},
		Props:        []map[string]string{{"cat": "cafe", "名前": "東京"}, {}},
		NumericProps: map[string][]float64{"n": {3, 4}, "avg": {1.5, math.NaN()}},
	}
	out, err := tiles.DecodeSpatialTile(in.Encode())
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(out.Cells, in.Cells) || !reflect.DeepEqual(out.Props, in.Props) {
		t.Fatalf("cells/props = %v %v", out.Cells, out.Props)
	}
	if !reflect.DeepEqual(out.NumericProps["n"], []float64{3, 4}) || out.NumericProps["avg"][0] != 1.5 || !math.IsNaN(out.NumericProps["avg"][1]) {
		t.Fatalf("numeric = %v", out.NumericProps)
	}
}
```

`server/internal/tiles/h3_test.go`:

```go
package tiles_test

import (
	"context"
	"errors"
	"testing"

	"osm-maps/server/internal/source"
	"osm-maps/server/internal/testdb"
	"osm-maps/server/internal/tiles"
)

func TestParseH3(t *testing.T) {
	c, err := tiles.ParseH3("832a10fffffffff")
	if err != nil || tiles.H3Res(c) != 3 {
		t.Fatalf("ParseH3 = %x res %d, %v", c, tiles.H3Res(c), err)
	}
	for _, bad := range []string{"", "zz", "0", "ffffffffffffffff"} {
		if _, err := tiles.ParseH3(bad); !errors.Is(err, source.ErrBadRequest) {
			t.Errorf("ParseH3(%q) err = %v", bad, err)
		}
	}
}

func TestH3Tile(t *testing.T) {
	db := testdb.Data(t)
	ctx := context.Background()
	rel, args, err := source.Source{Type: source.TypeTable, Name: "demo_points", SpatialDataType: source.H3}.Relation()
	if err != nil {
		t.Fatal(err)
	}
	var parent uint64
	var want int
	if err := db.QueryRow(`SELECT h3_cell_to_parent(h3, 6)::UBIGINT FROM demo_points WHERE id = 0`).Scan(&parent); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`SELECT count(*) FROM demo_points WHERE h3_cell_to_parent(h3, 6)::UBIGINT = ?`, parent).Scan(&want); err != nil {
		t.Fatal(err)
	}

	tile, err := tiles.H3Tile(ctx, db, tiles.H3Request{
		Relation: rel, Args: args, CellColumn: `"h3"`,
		AggregationExp: "count(*) AS n, any_value(category) AS cat", AggregationResLevel: 4,
		DataRes: 12, Tile: parent,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(tile.Cells) == 0 || len(tile.Props) != len(tile.Cells) || len(tile.NumericProps["n"]) != len(tile.Cells) {
		t.Fatalf("tile shape: cells=%d props=%d n=%d", len(tile.Cells), len(tile.Props), len(tile.NumericProps["n"]))
	}
	sum := 0.0
	for i, c := range tile.Cells {
		if tiles.H3Res(c) != 10 {
			t.Fatalf("cell %x has res %d, want 10", c, tiles.H3Res(c))
		}
		if tile.Props[i]["cat"] == "" {
			t.Fatalf("cell %x has no cat", c)
		}
		sum += tile.NumericProps["n"][i]
	}
	if int(sum) != want {
		t.Fatalf("sum of n = %v, want %d", sum, want)
	}

	coarse, err := tiles.H3Tile(ctx, db, tiles.H3Request{Relation: rel, Args: args, CellColumn: `"h3"`, AggregationResLevel: 4, DataRes: 5, Tile: parent})
	if err != nil || len(coarse.Cells) != 0 {
		t.Fatalf("data coarser than tile: cells=%d err=%v", len(coarse.Cells), err)
	}
}
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd server && go get google.golang.org/protobuf@latest && go test ./internal/tiles/ -run 'Spatial|H3' -v`
Expected: FAIL to compile (`undefined: tiles.SpatialTile`).

- [ ] **Step 4: Implement the encoder and decoder**

`server/internal/tiles/spatialtile.go`:

```go
package tiles

import (
	"encoding/binary"
	"fmt"
	"math"
	"sort"

	"google.golang.org/protobuf/encoding/protowire"
)

// SpatialTile is a CARTO spatial-index tile (MIME application/vnd.carto-spatial-tile).
// Props must be nil or index-aligned with Cells; each NumericProps slice has len(Cells) values.
type SpatialTile struct {
	Cells        []uint64
	Props        []map[string]string
	NumericProps map[string][]float64
}

func appendMsg(b []byte, field protowire.Number, msg []byte) []byte {
	b = protowire.AppendTag(b, field, protowire.BytesType)
	return protowire.AppendBytes(b, msg)
}

func appendStr(b []byte, field protowire.Number, s string) []byte {
	b = protowire.AppendTag(b, field, protowire.BytesType)
	return protowire.AppendString(b, s)
}

func (t SpatialTile) Encode() []byte {
	idx := make([]byte, 0, 8*len(t.Cells))
	for _, c := range t.Cells {
		idx = binary.LittleEndian.AppendUint64(idx, c)
	}
	cells := appendMsg(nil, 1, appendMsg(nil, 1, idx))
	for i := range t.Cells {
		var props []byte
		if t.Props != nil {
			for _, k := range sortedKeys(t.Props[i]) {
				props = appendMsg(props, 1, appendStr(appendStr(nil, 1, k), 2, t.Props[i][k]))
			}
		}
		cells = appendMsg(cells, 2, props) // one (possibly empty) Props per cell keeps indices aligned
	}
	for _, k := range sortedKeys(t.NumericProps) {
		vals := make([]byte, 0, 8*len(t.NumericProps[k]))
		for _, v := range t.NumericProps[k] {
			vals = binary.LittleEndian.AppendUint64(vals, math.Float64bits(v))
		}
		cells = appendMsg(cells, 3, appendMsg(appendStr(nil, 1, k), 2, appendMsg(nil, 1, vals)))
	}
	return appendMsg(nil, 2, cells)
}

// DecodeSpatialTile is the inverse of Encode; used by tests and for debugging tiles.
func DecodeSpatialTile(b []byte) (SpatialTile, error) {
	t := SpatialTile{NumericProps: map[string][]float64{}}
	err := eachField(b, func(num protowire.Number, v []byte) error {
		if num != 2 {
			return nil
		}
		return eachField(v, func(num protowire.Number, v []byte) error {
			switch num {
			case 1:
				raw, err := bytesField1(v)
				for i := 0; i+8 <= len(raw); i += 8 {
					t.Cells = append(t.Cells, binary.LittleEndian.Uint64(raw[i:]))
				}
				return err
			case 2:
				props := map[string]string{}
				err := eachField(v, func(num protowire.Number, kv []byte) error {
					var k, val string
					err := eachField(kv, func(num protowire.Number, s []byte) error {
						if num == 1 {
							k = string(s)
						} else if num == 2 {
							val = string(s)
						}
						return nil
					})
					props[k] = val
					return err
				})
				t.Props = append(t.Props, props)
				return err
			case 3:
				var key string
				var vals []float64
				err := eachField(v, func(num protowire.Number, f []byte) error {
					if num == 1 {
						key = string(f)
						return nil
					}
					raw, err := bytesField1(f)
					for i := 0; i+8 <= len(raw); i += 8 {
						vals = append(vals, math.Float64frombits(binary.LittleEndian.Uint64(raw[i:])))
					}
					return err
				})
				t.NumericProps[key] = vals
				return err
			}
			return nil
		})
	})
	return t, err
}

// eachField calls fn for every length-delimited field and skips all other wire types.
func eachField(b []byte, fn func(protowire.Number, []byte) error) error {
	for len(b) > 0 {
		num, typ, n := protowire.ConsumeTag(b)
		if n < 0 {
			return fmt.Errorf("spatial tile: %w", protowire.ParseError(n))
		}
		b = b[n:]
		if typ != protowire.BytesType {
			n = protowire.ConsumeFieldValue(num, typ, b)
			if n < 0 {
				return fmt.Errorf("spatial tile: %w", protowire.ParseError(n))
			}
			b = b[n:]
			continue
		}
		v, n := protowire.ConsumeBytes(b)
		if n < 0 {
			return fmt.Errorf("spatial tile: %w", protowire.ParseError(n))
		}
		b = b[n:]
		if err := fn(num, v); err != nil {
			return err
		}
	}
	return nil
}

func bytesField1(msg []byte) ([]byte, error) {
	var out []byte
	err := eachField(msg, func(num protowire.Number, v []byte) error {
		if num == 1 {
			out = v
		}
		return nil
	})
	return out, err
}

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
```

- [ ] **Step 5: Implement the H3 tile query**

`server/internal/tiles/h3.go`:

```go
package tiles

import (
	"context"
	"database/sql"
	"fmt"
	"math"
	"strconv"
	"strings"

	"osm-maps/server/internal/describe"
	"osm-maps/server/internal/source"
)

// H3Res returns the resolution encoded in bits 52–55 of an H3 index.
func H3Res(cell uint64) int { return int(cell>>52) & 0xF }

// ParseH3 parses a hexadecimal H3 cell index (mode 1) from a tile URL.
func ParseH3(s string) (uint64, error) {
	v, err := strconv.ParseUint(s, 16, 64)
	if err != nil || (v>>59)&0xF != 1 {
		return 0, fmt.Errorf("%w: invalid H3 cell %q", source.ErrBadRequest, s)
	}
	return v, nil
}

type H3Request struct {
	Relation            string
	Args                []any
	CellColumn          string // quoted
	AggregationExp      string
	AggregationResLevel int
	DataRes             int
	Tile                uint64
}

// H3Tile aggregates the source into cells at min(tileRes + AggregationResLevel, DataRes)
// that descend from r.Tile. Numeric result columns become NumericProps, all others Props.
func H3Tile(ctx context.Context, db *sql.DB, r H3Request) (SpatialTile, error) {
	tileRes := H3Res(r.Tile)
	if r.DataRes < tileRes {
		return SpatialTile{}, nil
	}
	res := tileRes + r.AggregationResLevel
	if res > r.DataRes {
		res = r.DataRes
	}
	agg := strings.TrimSpace(r.AggregationExp)
	if agg == "" {
		agg = "1 AS __aggregationValue"
	}
	q := fmt.Sprintf(`SELECT h3_cell_to_parent(%[1]s, %[2]d)::UBIGINT AS __cell, %[3]s
FROM %[4]s AS _r
WHERE %[1]s IS NOT NULL AND h3_cell_to_parent(%[1]s, %[5]d)::UBIGINT = $__tile
GROUP BY 1 ORDER BY 1`, r.CellColumn, res, agg, r.Relation, tileRes)

	rows, err := db.QueryContext(ctx, q, append(append([]any{}, r.Args...), sql.Named("__tile", r.Tile))...)
	if err != nil {
		return SpatialTile{}, err
	}
	defer rows.Close()
	types, err := rows.ColumnTypes()
	if err != nil {
		return SpatialTile{}, err
	}
	numeric := make([]bool, len(types))
	t := SpatialTile{NumericProps: map[string][]float64{}}
	for i := 1; i < len(types); i++ {
		if numeric[i] = describe.Kind(types[i].DatabaseTypeName()) == "number"; numeric[i] {
			t.NumericProps[types[i].Name()] = nil
		}
	}
	vals := make([]any, len(types))
	ptrs := make([]any, len(types))
	for i := range vals {
		ptrs[i] = &vals[i]
	}
	for rows.Next() {
		if err := rows.Scan(ptrs...); err != nil {
			return SpatialTile{}, err
		}
		cell, ok := vals[0].(uint64)
		if !ok {
			return SpatialTile{}, fmt.Errorf("h3 tile: unexpected cell type %T", vals[0])
		}
		t.Cells = append(t.Cells, cell)
		props := map[string]string{}
		for i := 1; i < len(vals); i++ {
			name := types[i].Name()
			if numeric[i] {
				f, ok := toFloat(vals[i])
				if !ok {
					f = math.NaN()
				}
				t.NumericProps[name] = append(t.NumericProps[name], f)
			} else if vals[i] != nil {
				props[name] = fmt.Sprint(vals[i])
			}
		}
		t.Props = append(t.Props, props)
	}
	return t, rows.Err()
}

func toFloat(v any) (float64, bool) {
	switch x := v.(type) {
	case float64:
		return x, true
	case float32:
		return float64(x), true
	case int64:
		return float64(x), true
	case int32:
		return float64(x), true
	case int16:
		return float64(x), true
	case int8:
		return float64(x), true
	case uint64:
		return float64(x), true
	case uint32:
		return float64(x), true
	case uint16:
		return float64(x), true
	case uint8:
		return float64(x), true
	case interface{ Float64() float64 }: // duckdb.Decimal
		return x.Float64(), true
	case fmt.Stringer: // *big.Int (HUGEINT, e.g. sum of BIGINT) and other numeric wrappers
		f, err := strconv.ParseFloat(x.String(), 64)
		return f, err == nil
	}
	return 0, false
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd server && go mod tidy && go test ./internal/tiles/ -v`
Expected: PASS for all tile tests (including Task 7's).

- [ ] **Step 7: Commit**

```bash
git add server/go.mod server/go.sum server/internal/tiles
git commit -m "feat(server): encode h3 spatial tiles in the carto protobuf format"
```

---
### Task 9: Data API handlers (`/v3/maps/{conn}/{type}`)

**Files:**
- Create: `server/internal/httpx/httpx.go`, `server/internal/mapsapi/params.go`, `server/internal/mapsapi/handler.go`
- Test: `server/internal/mapsapi/handler_test.go`

**Interfaces:**
- Consumes: everything from Tasks 2 and 5–8.
- Produces:
  - `httpx.WriteJSON(w, status int, v any)`, `httpx.WriteError(w, status int, msg string)`. The error body is `{"error": msg, "status": status}`.
  - `mapsapi.ParseParams(r *http.Request) (url.Values, error)` and `mapsapi.SourceFrom(typ string, v url.Values) (source.Source, error)`.
  - `mapsapi.Server{Conns map[string]*sql.DB; DataVersion string; QueryTimeout time.Duration; MaxFeatures int}` and `(*Server).Register(mux *http.ServeMux)`. It registers:
    - `GET|POST /v3/maps/{conn}/{type}`: instantiation, or TileJSON when `format=tilejson`
    - `GET /v3/maps/{conn}/{type}/{z}/{x}/{y}`: MVT
    - `GET /v3/maps/{conn}/{type}/{cell}`: H3 spatial tile

- [ ] **Step 1: Write the failing tests**

`server/internal/mapsapi/handler_test.go`:

```go
package mapsapi_test

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/paulmach/orb/encoding/mvt"

	"osm-maps/server/internal/mapsapi"
	"osm-maps/server/internal/testdb"
	"osm-maps/server/internal/tiles"
)

func newServer(t *testing.T, maxFeatures int) (*httptest.Server, *sql.DB) {
	t.Helper()
	db := testdb.Data(t)
	mux := http.NewServeMux()
	(&mapsapi.Server{Conns: map[string]*sql.DB{"osm": db}, DataVersion: "test-v1", QueryTimeout: 10 * time.Second, MaxFeatures: maxFeatures}).Register(mux)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv, db
}

func get(t *testing.T, u string) (*http.Response, []byte) {
	t.Helper()
	res, err := http.Get(u)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	b, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	return res, b
}

type instantiation struct {
	Tilejson struct {
		URL []string `json:"url"`
	} `json:"tilejson"`
	Schema []struct{ Name, Type string } `json:"schema"`
}

type tilejson struct {
	Tiles         []string  `json:"tiles"`
	Bounds        []float64 `json:"bounds"`
	MaxResolution *int      `json:"maxresolution"`
	Tilestats     struct {
		Layers []struct {
			Count int `json:"count"`
		} `json:"layers"`
	} `json:"tilestats"`
}

func instantiate(t *testing.T, srv *httptest.Server, typ string, v url.Values) tilejson {
	t.Helper()
	res, body := get(t, srv.URL+"/v3/maps/osm/"+typ+"?"+v.Encode())
	if res.StatusCode != 200 {
		t.Fatalf("instantiate: %d %s", res.StatusCode, body)
	}
	var inst instantiation
	if err := json.Unmarshal(body, &inst); err != nil {
		t.Fatal(err)
	}
	if len(inst.Tilejson.URL) != 1 || !strings.Contains(inst.Tilejson.URL[0], "format=tilejson") || !strings.Contains(inst.Tilejson.URL[0], "cache=test-v1") {
		t.Fatalf("tilejson url = %v", inst.Tilejson.URL)
	}
	res, body = get(t, inst.Tilejson.URL[0])
	if res.StatusCode != 200 {
		t.Fatalf("tilejson: %d %s", res.StatusCode, body)
	}
	var tj tilejson
	if err := json.Unmarshal(body, &tj); err != nil {
		t.Fatal(err)
	}
	return tj
}

func tileURL(tmpl string, z, x, y int) string {
	r := strings.NewReplacer("{z}", fmt.Sprint(z), "{x}", fmt.Sprint(x), "{y}", fmt.Sprint(y))
	return r.Replace(tmpl)
}

func TestVectorTableFlow(t *testing.T) {
	srv, _ := newServer(t, 1000)
	tj := instantiate(t, srv, "table", url.Values{"name": {"demo_points"}, "columns": {"name,value,_carto_feature_id"}, "v": {"3.4"}, "client": {"test"}})
	if len(tj.Tiles) != 1 || !strings.Contains(tj.Tiles[0], "formatTiles=mvt") || !strings.Contains(tj.Tiles[0], "/{z}/{x}/{y}?") {
		t.Fatalf("tiles = %v", tj.Tiles)
	}
	if tj.Tilestats.Layers[0].Count != 400 || len(tj.Bounds) != 4 {
		t.Fatalf("tilestats/bounds = %+v %v", tj.Tilestats, tj.Bounds)
	}
	res, body := get(t, tileURL(tj.Tiles[0], 0, 0, 0))
	if res.StatusCode != 200 || res.Header.Get("Content-Type") != "application/vnd.mapbox-vector-tile" {
		t.Fatalf("tile: %d %s", res.StatusCode, res.Header.Get("Content-Type"))
	}
	layers, err := mvt.Unmarshal(body)
	if err != nil || len(layers[0].Features) != 400 {
		t.Fatalf("decoded tile: %v %v", layers, err)
	}
	if res, _ := get(t, tileURL(tj.Tiles[0], 10, 0, 0)); res.StatusCode != http.StatusNoContent {
		t.Fatalf("empty tile status = %d, want 204", res.StatusCode)
	}
}

func TestQueryWithParametersAndPOST(t *testing.T) {
	srv, _ := newServer(t, 1000)
	tj := instantiate(t, srv, "query", url.Values{"q": {"SELECT * FROM demo_points WHERE value >= $min"}, "queryParameters": {`{"min":390}`}})
	if tj.Tilestats.Layers[0].Count != 10 {
		t.Fatalf("count = %d, want 10", tj.Tilestats.Layers[0].Count)
	}
	body, _ := json.Marshal(map[string]any{"q": "SELECT * FROM demo_points", "spatialDataType": "geo", "filters": map[string]any{"category": map[string]any{"in": map[string]any{"values": []string{"cafe"}}}}})
	res, err := http.Post(srv.URL+"/v3/maps/osm/query", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("POST instantiate = %d", res.StatusCode)
	}
}

func TestRejections(t *testing.T) {
	srv, _ := newServer(t, 1000)
	for name, tc := range map[string]struct {
		path   string
		v      url.Values
		status int
	}{
		"non-select":         {"/v3/maps/osm/query", url.Values{"q": {"DROP TABLE demo_points"}}, 400},
		"stacked statements": {"/v3/maps/osm/query", url.Values{"q": {"SELECT 1 AS geom; DROP TABLE demo_points"}}, 400},
		"sandboxed file":     {"/v3/maps/osm/query", url.Values{"q": {"SELECT * FROM read_csv('/etc/hosts')"}}, 400},
		"unknown connection": {"/v3/maps/nope/table", url.Values{"name": {"demo_points"}}, 404},
		"unknown table":      {"/v3/maps/osm/table", url.Values{"name": {"missing"}}, 400},
		"unknown column":     {"/v3/maps/osm/table", url.Values{"name": {"demo_points"}, "columns": {"nope"}}, 400},
		"missing geom":       {"/v3/maps/osm/query", url.Values{"q": {"SELECT 1 AS x"}}, 400},
		"tileset type":       {"/v3/maps/osm/tileset", url.Values{"name": {"demo_points"}}, 400},
		"bad tile coords":    {"/v3/maps/osm/table/3/99/0", url.Values{"name": {"demo_points"}}, 400},
	} {
		res, body := get(t, srv.URL+tc.path+"?"+tc.v.Encode())
		if res.StatusCode != tc.status {
			t.Errorf("%s: status %d, want %d (%s)", name, res.StatusCode, tc.status, body)
		}
		if !strings.Contains(string(body), `"error"`) {
			t.Errorf("%s: body has no error field: %s", name, body)
		}
	}
}

func TestTooLarge(t *testing.T) {
	srv, _ := newServer(t, 10)
	res, _ := get(t, srv.URL+"/v3/maps/osm/table/0/0/0?name=demo_points")
	if res.StatusCode != 400 {
		t.Fatalf("status = %d, want 400", res.StatusCode)
	}
}

func TestH3Flow(t *testing.T) {
	srv, db := newServer(t, 1000)
	tj := instantiate(t, srv, "query", url.Values{
		"q": {"SELECT h3, value FROM demo_points"}, "spatialDataType": {"h3"}, "spatialDataColumn": {"h3"},
		"aggregationExp": {"sum(value) AS value_sum"}, "aggregationResLevel": {"4"},
	})
	if len(tj.Tiles) != 1 || !strings.Contains(tj.Tiles[0], "/{i}?") || tj.MaxResolution == nil || *tj.MaxResolution != 8 {
		t.Fatalf("h3 tilejson = %+v", tj)
	}
	var cell string
	if err := db.QueryRow(`SELECT printf('%x', h3_cell_to_parent(h3, 6)) FROM demo_points WHERE id = 0`).Scan(&cell); err != nil {
		t.Fatal(err)
	}
	res, body := get(t, strings.Replace(tj.Tiles[0], "{i}", cell, 1))
	if res.StatusCode != 200 || res.Header.Get("Content-Type") != "application/vnd.carto-spatial-tile" {
		t.Fatalf("h3 tile: %d %s", res.StatusCode, body)
	}
	st, err := tiles.DecodeSpatialTile(body)
	if err != nil || len(st.Cells) == 0 || len(st.NumericProps["value_sum"]) != len(st.Cells) {
		t.Fatalf("decoded h3 tile: cells=%d err=%v", len(st.Cells), err)
	}
}

func TestConcurrentTiles(t *testing.T) {
	srv, _ := newServer(t, 1000)
	var wg sync.WaitGroup
	errs := make(chan string, 16)
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			z := 12 + i%3
			x, y := tiles.LonLatToTile(139.72, 35.67, z)
			res, err := http.Get(fmt.Sprintf("%s/v3/maps/osm/table/%d/%d/%d?name=demo_points&columns=name", srv.URL, z, x, y))
			if err != nil {
				errs <- err.Error()
				return
			}
			res.Body.Close()
			if res.StatusCode != 200 {
				errs <- fmt.Sprintf("status %d", res.StatusCode)
			}
		}(i)
	}
	wg.Wait()
	close(errs)
	for e := range errs {
		t.Error(e)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && go test ./internal/mapsapi/ -v`
Expected: FAIL to compile (`undefined: mapsapi.Server`).

- [ ] **Step 3: Implement `httpx`**

`server/internal/httpx/httpx.go`:

```go
// Package httpx holds the JSON response helpers shared by the HTTP handlers.
package httpx

import (
	"encoding/json"
	"net/http"
)

func WriteJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func WriteError(w http.ResponseWriter, status int, msg string) {
	WriteJSON(w, status, map[string]any{"error": msg, "status": status})
}
```

- [ ] **Step 4: Implement the parameter parsing**

`server/internal/mapsapi/params.go`:

```go
package mapsapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"osm-maps/server/internal/source"
)

// ParseParams merges the query string with a JSON object body (the client POSTs long requests, ledger A3).
func ParseParams(r *http.Request) (url.Values, error) {
	v := r.URL.Query()
	if r.Method != http.MethodPost {
		return v, nil
	}
	var body map[string]any
	dec := json.NewDecoder(io.LimitReader(r.Body, 1<<20))
	dec.UseNumber()
	if err := dec.Decode(&body); err != nil && !errors.Is(err, io.EOF) {
		return nil, fmt.Errorf("%w: body must be a JSON object: %v", source.ErrBadRequest, err)
	}
	for k, val := range body {
		switch t := val.(type) {
		case string:
			v.Set(k, t)
		case json.Number:
			v.Set(k, t.String())
		case bool:
			v.Set(k, strconv.FormatBool(t))
		case nil:
		default:
			b, _ := json.Marshal(t)
			v.Set(k, string(b))
		}
	}
	return v, nil
}

// SourceFrom builds a source.Source from request parameters (ledger A2).
func SourceFrom(typ string, v url.Values) (source.Source, error) {
	s := source.Source{
		Type:                source.Type(typ),
		Name:                v.Get("name"),
		Query:               v.Get("q"),
		SpatialDataType:     source.SpatialType(v.Get("spatialDataType")),
		SpatialDataColumn:   v.Get("spatialDataColumn"),
		AggregationExp:      v.Get("aggregationExp"),
		AggregationResLevel: source.DefaultAggregationResLevel,
		FiltersOr:           strings.EqualFold(v.Get("filtersLogicalOperator"), "or"),
	}
	if s.SpatialDataType == "" {
		s.SpatialDataType = source.Geo
	}
	if c := v.Get("columns"); c != "" {
		for _, name := range strings.Split(c, ",") {
			if name = strings.TrimSpace(name); name != "" {
				s.Columns = append(s.Columns, name)
			}
		}
	}
	if q := v.Get("queryParameters"); q != "" && q != "null" {
		if err := json.Unmarshal([]byte(q), &s.QueryParameters); err != nil {
			return s, fmt.Errorf("%w: queryParameters must be a JSON object of named parameters", source.ErrBadRequest)
		}
	}
	if f := v.Get("filters"); f != "" && f != "null" {
		if err := json.Unmarshal([]byte(f), &s.Filters); err != nil {
			return s, fmt.Errorf("%w: filters: %v", source.ErrBadRequest, err)
		}
	}
	if a := v.Get("aggregationResLevel"); a != "" {
		n, err := strconv.Atoi(a)
		if err != nil {
			return s, fmt.Errorf("%w: aggregationResLevel must be an integer", source.ErrBadRequest)
		}
		s.AggregationResLevel = n
	}
	return s, s.Validate()
}
```

- [ ] **Step 5: Implement the handlers**

`server/internal/mapsapi/handler.go`:

```go
// Package mapsapi serves the CARTO-v3-compatible map instantiation, TileJSON and tile endpoints.
package mapsapi

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"osm-maps/server/internal/describe"
	"osm-maps/server/internal/httpx"
	"osm-maps/server/internal/source"
	"osm-maps/server/internal/sqlguard"
	"osm-maps/server/internal/tiles"
)

type Server struct {
	Conns        map[string]*sql.DB
	DataVersion  string // emitted as cache=<DataVersion>; changes whenever the data file changes
	QueryTimeout time.Duration
	MaxFeatures  int
}

func (s *Server) Register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v3/maps/{conn}/{type}", s.handleSource)
	mux.HandleFunc("POST /v3/maps/{conn}/{type}", s.handleSource)
	mux.HandleFunc("GET /v3/maps/{conn}/{type}/{z}/{x}/{y}", s.handleMVT)
	mux.HandleFunc("GET /v3/maps/{conn}/{type}/{cell}", s.handleH3)
}

var errQuery = errors.New("query failed")

type prepared struct {
	src       source.Source
	rel       string
	args      []any
	schema    []describe.Column
	spatial   string // quoted spatial column
	props     []describe.Column
	featureID bool
}

func (s *Server) begin(w http.ResponseWriter, r *http.Request) (context.Context, context.CancelFunc, *sql.DB, url.Values, bool) {
	timeout := s.QueryTimeout
	if timeout <= 0 {
		timeout = 15 * time.Second
	}
	ctx, cancel := context.WithTimeout(r.Context(), timeout)
	db, ok := s.Conns[r.PathValue("conn")]
	if !ok {
		httpx.WriteError(w, http.StatusNotFound, "connection not found")
		return ctx, cancel, nil, nil, false
	}
	v, err := ParseParams(r)
	if err != nil {
		s.fail(ctx, w, err)
		return ctx, cancel, nil, nil, false
	}
	return ctx, cancel, db, v, true
}

func (s *Server) prepare(ctx context.Context, db *sql.DB, typ string, v url.Values) (prepared, error) {
	src, err := SourceFrom(typ, v)
	if err != nil {
		return prepared{}, err
	}
	if src.Type == source.TypeQuery {
		if err := sqlguard.ValidateSelect(ctx, db, src.Query); err != nil {
			return prepared{}, err
		}
	}
	if src.AggregationExp != "" {
		if err := sqlguard.ValidateSelect(ctx, db, "SELECT "+src.AggregationExp); err != nil {
			return prepared{}, err
		}
	}
	rel, args, err := src.Relation()
	if err != nil {
		return prepared{}, err
	}
	schema, err := describe.Schema(ctx, db, rel, args)
	if err != nil {
		return prepared{}, queryError(err)
	}
	byName := make(map[string]describe.Column, len(schema))
	for _, c := range schema {
		byName[c.Name] = c
	}
	spatial := src.SpatialColumnName()
	if _, ok := byName[spatial]; !ok {
		return prepared{}, fmt.Errorf("%w: spatial column %q not found", source.ErrBadRequest, spatial)
	}
	p := prepared{src: src, rel: rel, args: args, schema: schema, spatial: `"` + spatial + `"`}
	for _, name := range src.Columns {
		switch name {
		case tiles.FeatureIDColumn:
			p.featureID = true
		case spatial:
		default:
			c, ok := byName[name]
			if !ok {
				return prepared{}, fmt.Errorf("%w: unknown column %q", source.ErrBadRequest, name)
			}
			p.props = append(p.props, c)
		}
	}
	return p, nil
}

func (s *Server) handleSource(w http.ResponseWriter, r *http.Request) {
	ctx, cancel, db, v, ok := s.begin(w, r)
	defer cancel()
	if !ok {
		return
	}
	p, err := s.prepare(ctx, db, r.PathValue("type"), v)
	if err != nil {
		s.fail(ctx, w, err)
		return
	}
	if v.Get("format") != "tilejson" {
		q := cloneValues(v)
		q.Set("format", "tilejson")
		q.Set("cache", s.DataVersion)
		httpx.WriteJSON(w, http.StatusOK, map[string]any{
			"tilejson": map[string]any{"url": []string{baseURL(r) + r.URL.Path + "?" + q.Encode()}},
			"schema":   p.schema,
		})
		return
	}
	tj, err := s.tileJSON(ctx, db, r, v, p)
	if err != nil {
		s.fail(ctx, w, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, tj)
}

func (s *Server) tileJSON(ctx context.Context, db *sql.DB, r *http.Request, v url.Values, p prepared) (map[string]any, error) {
	q := cloneValues(v)
	q.Del("format")
	q.Set("cache", s.DataVersion)
	base := baseURL(r) + r.URL.Path
	tj := map[string]any{"tilejson": "3.0.0", "schema": p.schema}

	var (
		b        [4]float64
		hasBound bool
		geometry string
		err      error
	)
	switch p.src.SpatialDataType {
	case source.Geo:
		if geometry, err = describe.GeometryType(ctx, db, p.rel, p.spatial, p.args); err != nil {
			return nil, queryError(err)
		}
		if b, hasBound, err = describe.GeoBounds(ctx, db, p.rel, p.spatial, p.args); err != nil {
			return nil, queryError(err)
		}
		q.Set("formatTiles", "mvt") // the client switches to its MVT decoder on this (ledger A4)
		tj["tiles"] = []string{base + "/{z}/{x}/{y}?" + q.Encode()}
		tj["minzoom"], tj["maxzoom"] = 0, 22
		fields := make(map[string]string, len(p.props))
		for _, c := range p.props {
			fields[c.Name] = c.Type
		}
		tj["vector_layers"] = []map[string]any{{"id": tiles.MVTLayer, "fields": fields}}
	case source.H3:
		res, _, err := describe.H3Resolution(ctx, db, p.rel, p.spatial, p.args)
		if err != nil {
			return nil, queryError(err)
		}
		if b, hasBound, err = describe.H3Bounds(ctx, db, p.rel, p.spatial, p.args); err != nil {
			return nil, queryError(err)
		}
		maxRes := res - p.src.AggregationResLevel
		if maxRes < 0 {
			maxRes = 0
		}
		tj["tiles"] = []string{base + "/{i}?" + q.Encode()}
		tj["minresolution"], tj["maxresolution"], tj["scheme"] = 0, maxRes, "h3"
	}
	stats, err := describe.Stats(ctx, db, p.rel, p.args, p.props, geometry)
	if err != nil {
		return nil, queryError(err)
	}
	tj["tilestats"] = stats
	if hasBound {
		tj["bounds"] = b[:]
		tj["center"] = []float64{(b[0] + b[2]) / 2, (b[1] + b[3]) / 2, 0}
	}
	return tj, nil
}

func (s *Server) handleMVT(w http.ResponseWriter, r *http.Request) {
	ctx, cancel, db, v, ok := s.begin(w, r)
	defer cancel()
	if !ok {
		return
	}
	z, errZ := strconv.Atoi(r.PathValue("z"))
	x, errX := strconv.Atoi(r.PathValue("x"))
	y, errY := strconv.Atoi(r.PathValue("y"))
	if errZ != nil || errX != nil || errY != nil || !tiles.ValidTile(z, x, y) {
		httpx.WriteError(w, http.StatusBadRequest, "invalid tile coordinates")
		return
	}
	p, err := s.prepare(ctx, db, r.PathValue("type"), v)
	if err != nil {
		s.fail(ctx, w, err)
		return
	}
	if p.src.SpatialDataType != source.Geo {
		httpx.WriteError(w, http.StatusBadRequest, "vector tiles need spatialDataType=geo")
		return
	}
	b, err := tiles.MVT(ctx, db, tiles.MVTRequest{
		Relation: p.rel, Args: p.args, GeomColumn: p.spatial, Props: p.props, FeatureID: p.featureID,
		Z: z, X: x, Y: y, MaxFeatures: s.MaxFeatures,
	})
	if err != nil {
		s.fail(ctx, w, queryErrorUnlessKnown(err))
		return
	}
	if len(b) == 0 {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	w.Header().Set("Content-Type", "application/vnd.mapbox-vector-tile")
	_, _ = w.Write(b)
}

func (s *Server) handleH3(w http.ResponseWriter, r *http.Request) {
	ctx, cancel, db, v, ok := s.begin(w, r)
	defer cancel()
	if !ok {
		return
	}
	cell, err := tiles.ParseH3(r.PathValue("cell"))
	if err != nil {
		s.fail(ctx, w, err)
		return
	}
	p, err := s.prepare(ctx, db, r.PathValue("type"), v)
	if err != nil {
		s.fail(ctx, w, err)
		return
	}
	if p.src.SpatialDataType != source.H3 {
		httpx.WriteError(w, http.StatusBadRequest, "cell tiles need spatialDataType=h3")
		return
	}
	dataRes, ok, err := describe.H3Resolution(ctx, db, p.rel, p.spatial, p.args)
	if err != nil {
		s.fail(ctx, w, queryError(err))
		return
	}
	if !ok {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	t, err := tiles.H3Tile(ctx, db, tiles.H3Request{
		Relation: p.rel, Args: p.args, CellColumn: p.spatial, AggregationExp: p.src.AggregationExp,
		AggregationResLevel: p.src.AggregationResLevel, DataRes: dataRes, Tile: cell,
	})
	if err != nil {
		s.fail(ctx, w, queryError(err))
		return
	}
	if len(t.Cells) == 0 {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	w.Header().Set("Content-Type", "application/vnd.carto-spatial-tile")
	_, _ = w.Write(t.Encode())
}

// queryError turns a DuckDB error caused by user input into a 400 with its first line only.
func queryError(err error) error {
	msg := err.Error()
	if i := strings.IndexByte(msg, '\n'); i >= 0 {
		msg = msg[:i]
	}
	if len(msg) > 300 {
		msg = msg[:300]
	}
	return fmt.Errorf("%w: %s", errQuery, msg)
}

func queryErrorUnlessKnown(err error) error {
	if errors.Is(err, tiles.ErrTooLarge) {
		return err
	}
	return queryError(err)
}

func (s *Server) fail(ctx context.Context, w http.ResponseWriter, err error) {
	switch {
	case ctx.Err() != nil:
		httpx.WriteError(w, http.StatusRequestTimeout, "query timed out")
	case errors.Is(err, source.ErrBadRequest), errors.Is(err, sqlguard.ErrNotSelect),
		errors.Is(err, errQuery), errors.Is(err, tiles.ErrTooLarge):
		httpx.WriteError(w, http.StatusBadRequest, err.Error())
	default:
		log.Printf("mapsapi: %v", err)
		httpx.WriteError(w, http.StatusInternalServerError, "internal error")
	}
}

func cloneValues(v url.Values) url.Values {
	out := make(url.Values, len(v))
	for k, vs := range v {
		out[k] = append([]string(nil), vs...)
	}
	return out
}

// baseURL is the origin the client used; with the Vite proxy (changeOrigin off) that is the dev server.
func baseURL(r *http.Request) string {
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	if p := r.Header.Get("X-Forwarded-Proto"); p == "http" || p == "https" {
		scheme = p
	}
	host := r.Host
	if h := r.Header.Get("X-Forwarded-Host"); h != "" {
		host = h
	}
	return scheme + "://" + host
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd server && go test ./internal/mapsapi/ -v -race`
Expected: PASS, including `TestConcurrentTiles` under `-race`.

- [ ] **Step 7: Commit**

```bash
git add server/internal/httpx server/internal/mapsapi
git commit -m "feat(server): serve carto v3 instantiation, tilejson, mvt and h3 tiles"
```

---
### Task 10: Maps and datasets store (meta DuckDB)

**Files:**
- Create: `server/internal/store/store.go`, `server/internal/store/duckstore.go`
- Test: `server/internal/store/duckstore_test.go`

**Interfaces:**
- Consumes: `duck.Open`.
- Produces:
  - `store.ErrNotFound`, `store.ErrInvalid`.
  - `store.Map{ID, Title, Description string; Tags []string; Privacy string; Collaborative bool; OwnerID string; CreatedAt, UpdatedAt time.Time; ThumbnailURL *string; Views int64; KeplerMapConfig json.RawMessage}`. JSON tags are camelCase per spec §4.3. `keplerMapConfig` is omitted when empty, which is the case for list summaries.
  - `store.MapPatch{Title, Description, Privacy *string; Tags *[]string; Collaborative *bool; KeplerMapConfig json.RawMessage}`.
  - `store.ListQuery{Page, PageSize int; Search, OrderBy string /* updated_at|title */; Desc bool; Privacy, OwnerID, ViewerID string}` and `store.Page{Total, Current, PageSize, TotalPages int}` (JSON `total,current,pageSize,totalPages`).
  - `store.Store` interface: `ListMaps`, `CreateMap`, `GetMap`, `UpdateMap`, `DeleteMap`, `ListDatasets`, `PutDataset`, `DeleteDataset` (signatures below).
  - `store.OpenDuck(ctx, path string) (*DuckStore, error)`. `DuckStore` has a `Now func() time.Time` field for tests and a `Close() error` method.

- [ ] **Step 1: Write the failing tests**

`server/internal/store/duckstore_test.go`:

```go
package store_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"testing"
	"time"

	"osm-maps/server/internal/store"
)

func open(t *testing.T) *store.DuckStore {
	t.Helper()
	s, err := store.OpenDuck(context.Background(), filepath.Join(t.TempDir(), "meta.duckdb"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	clock := time.Date(2026, 10, 14, 0, 0, 0, 0, time.UTC)
	s.Now = func() time.Time { clock = clock.Add(time.Second); return clock }
	return s
}

func create(t *testing.T, s *store.DuckStore, owner, title, privacy string) store.Map {
	t.Helper()
	m, err := s.CreateMap(context.Background(), store.Map{OwnerID: owner, Title: title, Privacy: privacy, KeplerMapConfig: json.RawMessage(`{"version":"v1","config":{}}`)})
	if err != nil {
		t.Fatal(err)
	}
	return m
}

func ptr[T any](v T) *T { return &v }

func TestCreateGetUpdateDelete(t *testing.T) {
	s := open(t)
	ctx := context.Background()
	m := create(t, s, "alice", "First", "")
	if m.ID == "" || m.Privacy != "private" || len(m.Tags) != 0 {
		t.Fatalf("created = %+v", m)
	}
	got, err := s.GetMap(ctx, m.ID)
	if err != nil || got.Title != "First" || string(got.KeplerMapConfig) != `{"version":"v1","config":{}}` {
		t.Fatalf("get = %+v, %v", got, err)
	}

	upd, err := s.UpdateMap(ctx, m.ID, store.MapPatch{Title: ptr("Renamed"), Tags: ptr([]string{"osm"})})
	if err != nil {
		t.Fatal(err)
	}
	if upd.Title != "Renamed" || upd.Tags[0] != "osm" || upd.Description != "" || !upd.UpdatedAt.After(got.UpdatedAt) {
		t.Fatalf("updated = %+v", upd)
	}

	if _, err := s.PutDataset(ctx, m.ID, json.RawMessage(`{"id":"ds1","type":"table","source":"demo_points"}`)); err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteMap(ctx, m.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.GetMap(ctx, m.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("get after delete: %v", err)
	}
	if ds, err := s.ListDatasets(ctx, m.ID); err != nil || len(ds) != 0 {
		t.Fatalf("datasets after delete: %v %v", ds, err)
	}
	if err := s.DeleteMap(ctx, m.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("second delete: %v", err)
	}
	if _, err := s.UpdateMap(ctx, "missing", store.MapPatch{Title: ptr("x")}); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("update missing: %v", err)
	}
}

func TestListMaps(t *testing.T) {
	s := open(t)
	ctx := context.Background()
	for i := 0; i < 13; i++ {
		create(t, s, "alice", fmt.Sprintf("Map %02d", i), "private")
	}
	create(t, s, "bob", "Bob private", "private")
	create(t, s, "bob", "Bob shared", "shared")
	create(t, s, "bob", "100%_literal", "public")

	maps, page, err := s.ListMaps(ctx, store.ListQuery{ViewerID: "alice", PageSize: 12, Desc: true})
	if err != nil {
		t.Fatal(err)
	}
	if page.Total != 15 || page.TotalPages != 2 || page.Current != 1 || len(maps) != 12 {
		t.Fatalf("page = %+v len=%d", page, len(maps))
	}
	if maps[0].Title != "100%_literal" || maps[0].KeplerMapConfig != nil {
		t.Fatalf("first (newest) = %+v", maps[0])
	}
	if _, p2, _ := s.ListMaps(ctx, store.ListQuery{ViewerID: "alice", PageSize: 12, Page: 2, Desc: true}); p2.Current != 2 {
		t.Fatalf("page 2 = %+v", p2)
	}

	byTitle, _, _ := s.ListMaps(ctx, store.ListQuery{ViewerID: "alice", OrderBy: "title", PageSize: 3})
	if byTitle[0].Title != "100%_literal" || byTitle[1].Title != "Bob shared" || byTitle[2].Title != "Map 00" {
		t.Fatalf("title order = %q %q %q", byTitle[0].Title, byTitle[1].Title, byTitle[2].Title)
	}

	for search, want := range map[string]int{"map 0": 10, "%": 1, "_": 1, "nothing": 0} {
		_, p, err := s.ListMaps(ctx, store.ListQuery{ViewerID: "alice", Search: search})
		if err != nil || p.Total != want {
			t.Errorf("search %q: total %d, want %d (%v)", search, p.Total, want, err)
		}
	}
	if _, p, _ := s.ListMaps(ctx, store.ListQuery{ViewerID: "alice", Privacy: "public"}); p.Total != 1 {
		t.Errorf("privacy=public total = %d", p.Total)
	}
	if _, p, _ := s.ListMaps(ctx, store.ListQuery{ViewerID: "alice", OwnerID: "alice"}); p.Total != 13 {
		t.Errorf("owner=alice total = %d", p.Total)
	}
}

func TestDatasets(t *testing.T) {
	s := open(t)
	ctx := context.Background()
	m := create(t, s, "alice", "M", "")
	for _, doc := range []string{`{"id":"a","label":"A"}`, `{"id":"b","label":"B"}`, `{"id":"a","label":"A2"}`} {
		if _, err := s.PutDataset(ctx, m.ID, json.RawMessage(doc)); err != nil {
			t.Fatal(err)
		}
	}
	ds, err := s.ListDatasets(ctx, m.ID)
	if err != nil || len(ds) != 2 || string(ds[0]) != `{"id":"a","label":"A2"}` {
		t.Fatalf("datasets = %s, %v", ds, err)
	}
	if _, err := s.PutDataset(ctx, m.ID, json.RawMessage(`{"label":"no id"}`)); !errors.Is(err, store.ErrInvalid) {
		t.Fatalf("no id: %v", err)
	}
	if _, err := s.PutDataset(ctx, "missing", json.RawMessage(`{"id":"x"}`)); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("missing map: %v", err)
	}
	if err := s.DeleteDataset(ctx, m.ID, "b"); err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteDataset(ctx, m.ID, "b"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("second delete: %v", err)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && go test ./internal/store/ -v`
Expected: FAIL to compile (`undefined: store.OpenDuck`).

- [ ] **Step 3: Implement the types and interface**

`server/internal/store/store.go`:

```go
// Package store persists maps and their datasets.
package store

import (
	"context"
	"encoding/json"
	"errors"
	"time"
)

var (
	ErrNotFound = errors.New("not found")
	ErrInvalid  = errors.New("invalid")
)

type Map struct {
	ID              string          `json:"id"`
	Title           string          `json:"title"`
	Description     string          `json:"description"`
	Tags            []string        `json:"tags"`
	Privacy         string          `json:"privacy"`
	Collaborative   bool            `json:"collaborative"`
	OwnerID         string          `json:"ownerId"`
	CreatedAt       time.Time       `json:"createdAt"`
	UpdatedAt       time.Time       `json:"updatedAt"`
	ThumbnailURL    *string         `json:"thumbnailUrl"`
	Views           int64           `json:"views"`
	KeplerMapConfig json.RawMessage `json:"keplerMapConfig,omitempty"`
}

type MapPatch struct {
	Title, Description, Privacy *string
	Tags                        *[]string
	Collaborative               *bool
	KeplerMapConfig             json.RawMessage
}

type ListQuery struct {
	Page, PageSize int
	Search         string
	OrderBy        string // "updated_at" (default) or "title"
	Desc           bool
	Privacy        string
	OwnerID        string
	ViewerID       string // sees own maps plus shared and public ones
}

type Page struct {
	Total      int `json:"total"`
	Current    int `json:"current"`
	PageSize   int `json:"pageSize"`
	TotalPages int `json:"totalPages"`
}

type Store interface {
	ListMaps(ctx context.Context, q ListQuery) ([]Map, Page, error)
	CreateMap(ctx context.Context, m Map) (Map, error)
	GetMap(ctx context.Context, id string) (Map, error)
	UpdateMap(ctx context.Context, id string, p MapPatch) (Map, error)
	DeleteMap(ctx context.Context, id string) error
	ListDatasets(ctx context.Context, mapID string) ([]json.RawMessage, error)
	PutDataset(ctx context.Context, mapID string, doc json.RawMessage) (json.RawMessage, error) // upsert by doc.id
	DeleteDataset(ctx context.Context, mapID, datasetID string) error
}
```

- [ ] **Step 4: Implement `DuckStore`**

`server/internal/store/duckstore.go`:

```go
package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"

	"osm-maps/server/internal/duck"
)

var schemaSQL = []string{
	`CREATE TABLE IF NOT EXISTS maps (
	   id VARCHAR PRIMARY KEY,
	   owner_id VARCHAR NOT NULL,
	   title VARCHAR NOT NULL,
	   description VARCHAR NOT NULL DEFAULT '',
	   tags VARCHAR NOT NULL DEFAULT '[]',
	   privacy VARCHAR NOT NULL DEFAULT 'private',
	   collaborative BOOLEAN NOT NULL DEFAULT false,
	   kepler_map_config VARCHAR NOT NULL,
	   thumbnail_url VARCHAR,
	   views BIGINT NOT NULL DEFAULT 0,
	   created_at TIMESTAMPTZ NOT NULL,
	   updated_at TIMESTAMPTZ NOT NULL)`,
	`CREATE TABLE IF NOT EXISTS datasets (
	   map_id VARCHAR NOT NULL,
	   id VARCHAR NOT NULL,
	   doc VARCHAR NOT NULL,
	   created_at TIMESTAMPTZ NOT NULL,
	   updated_at TIMESTAMPTZ NOT NULL,
	   PRIMARY KEY (map_id, id))`,
}

const summaryCols = "id, owner_id, title, description, tags, privacy, collaborative, thumbnail_url, views, created_at, updated_at"

type DuckStore struct {
	db  *sql.DB
	Now func() time.Time
}

func OpenDuck(ctx context.Context, path string) (*DuckStore, error) {
	db, err := duck.Open(duck.Options{Path: path})
	if err != nil {
		return nil, err
	}
	for _, q := range schemaSQL {
		if _, err := db.ExecContext(ctx, q); err != nil {
			db.Close()
			return nil, fmt.Errorf("store: migrate: %w", err)
		}
	}
	return &DuckStore{db: db, Now: func() time.Time { return time.Now().UTC() }}, nil
}

func (s *DuckStore) Close() error { return s.db.Close() }

type scanner interface{ Scan(...any) error }

func scanMap(row scanner, withConfig bool) (Map, error) {
	var (
		m    Map
		tags string
		cfg  string
	)
	dest := []any{&m.ID, &m.OwnerID, &m.Title, &m.Description, &tags, &m.Privacy, &m.Collaborative, &m.ThumbnailURL, &m.Views, &m.CreatedAt, &m.UpdatedAt}
	if withConfig {
		dest = append(dest, &cfg)
	}
	if err := row.Scan(dest...); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return Map{}, ErrNotFound
		}
		return Map{}, err
	}
	if err := json.Unmarshal([]byte(tags), &m.Tags); err != nil {
		return Map{}, fmt.Errorf("store: tags: %w", err)
	}
	if withConfig {
		m.KeplerMapConfig = json.RawMessage(cfg)
	}
	return m, nil
}

func (s *DuckStore) ListMaps(ctx context.Context, q ListQuery) ([]Map, Page, error) {
	if q.Page < 1 {
		q.Page = 1
	}
	if q.PageSize < 1 || q.PageSize > 100 {
		q.PageSize = 12
	}
	where := []string{"(owner_id = $viewer OR privacy IN ('shared', 'public'))"}
	args := []any{sql.Named("viewer", q.ViewerID)}
	if q.OwnerID != "" {
		where = append(where, "owner_id = $owner")
		args = append(args, sql.Named("owner", q.OwnerID))
	}
	if q.Privacy != "" {
		where = append(where, "privacy = $privacy")
		args = append(args, sql.Named("privacy", q.Privacy))
	}
	if q.Search != "" {
		where = append(where, "contains(lower(title), lower($search))") // literal match: no LIKE wildcards
		args = append(args, sql.Named("search", q.Search))
	}
	w := strings.Join(where, " AND ")

	var total int
	if err := s.db.QueryRowContext(ctx, "SELECT count(*) FROM maps WHERE "+w, args...).Scan(&total); err != nil {
		return nil, Page{}, err
	}
	order := "updated_at"
	if q.OrderBy == "title" {
		order = "lower(title)"
	}
	dir := "ASC"
	if q.Desc {
		dir = "DESC"
	}
	rows, err := s.db.QueryContext(ctx, fmt.Sprintf("SELECT %s FROM maps WHERE %s ORDER BY %s %s, id LIMIT %d OFFSET %d",
		summaryCols, w, order, dir, q.PageSize, (q.Page-1)*q.PageSize), args...)
	if err != nil {
		return nil, Page{}, err
	}
	defer rows.Close()
	maps := []Map{}
	for rows.Next() {
		m, err := scanMap(rows, false)
		if err != nil {
			return nil, Page{}, err
		}
		maps = append(maps, m)
	}
	page := Page{Total: total, Current: q.Page, PageSize: q.PageSize, TotalPages: (total + q.PageSize - 1) / q.PageSize}
	return maps, page, rows.Err()
}

func (s *DuckStore) CreateMap(ctx context.Context, m Map) (Map, error) {
	if len(m.KeplerMapConfig) == 0 {
		return Map{}, fmt.Errorf("%w: keplerMapConfig is required", ErrInvalid)
	}
	now := s.Now()
	m.ID, m.CreatedAt, m.UpdatedAt = uuid.NewString(), now, now
	if m.Tags == nil {
		m.Tags = []string{}
	}
	if m.Privacy == "" {
		m.Privacy = "private"
	}
	tags, _ := json.Marshal(m.Tags)
	_, err := s.db.ExecContext(ctx, `INSERT INTO maps (id, owner_id, title, description, tags, privacy, collaborative, kepler_map_config, thumbnail_url, views, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
		m.ID, m.OwnerID, m.Title, m.Description, string(tags), m.Privacy, m.Collaborative, string(m.KeplerMapConfig), m.ThumbnailURL, now, now)
	if err != nil {
		return Map{}, err
	}
	return m, nil
}

func (s *DuckStore) GetMap(ctx context.Context, id string) (Map, error) {
	return scanMap(s.db.QueryRowContext(ctx, "SELECT "+summaryCols+", kepler_map_config FROM maps WHERE id = ?", id), true)
}

func (s *DuckStore) UpdateMap(ctx context.Context, id string, p MapPatch) (Map, error) {
	sets := []string{"updated_at = ?"}
	args := []any{s.Now()}
	add := func(col string, v any) { sets = append(sets, col+" = ?"); args = append(args, v) }
	if p.Title != nil {
		add("title", *p.Title)
	}
	if p.Description != nil {
		add("description", *p.Description)
	}
	if p.Privacy != nil {
		add("privacy", *p.Privacy)
	}
	if p.Tags != nil {
		b, _ := json.Marshal(*p.Tags)
		add("tags", string(b))
	}
	if p.Collaborative != nil {
		add("collaborative", *p.Collaborative)
	}
	if len(p.KeplerMapConfig) > 0 {
		add("kepler_map_config", string(p.KeplerMapConfig))
	}
	res, err := s.db.ExecContext(ctx, "UPDATE maps SET "+strings.Join(sets, ", ")+" WHERE id = ?", append(args, id)...)
	if err != nil {
		return Map{}, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return Map{}, ErrNotFound
	}
	return s.GetMap(ctx, id)
}

func (s *DuckStore) DeleteMap(ctx context.Context, id string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, "DELETE FROM datasets WHERE map_id = ?", id); err != nil {
		return err
	}
	res, err := tx.ExecContext(ctx, "DELETE FROM maps WHERE id = ?", id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return tx.Commit()
}

func (s *DuckStore) ListDatasets(ctx context.Context, mapID string) ([]json.RawMessage, error) {
	rows, err := s.db.QueryContext(ctx, "SELECT doc FROM datasets WHERE map_id = ? ORDER BY created_at, id", mapID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []json.RawMessage{}
	for rows.Next() {
		var doc string
		if err := rows.Scan(&doc); err != nil {
			return nil, err
		}
		out = append(out, json.RawMessage(doc))
	}
	return out, rows.Err()
}

func (s *DuckStore) PutDataset(ctx context.Context, mapID string, doc json.RawMessage) (json.RawMessage, error) {
	var head struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(doc, &head); err != nil || head.ID == "" {
		return nil, fmt.Errorf("%w: a dataset needs a string id", ErrInvalid)
	}
	var exists bool
	if err := s.db.QueryRowContext(ctx, "SELECT count(*) > 0 FROM maps WHERE id = ?", mapID).Scan(&exists); err != nil {
		return nil, err
	}
	if !exists {
		return nil, ErrNotFound
	}
	now := s.Now()
	_, err := s.db.ExecContext(ctx, `INSERT INTO datasets (map_id, id, doc, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
ON CONFLICT (map_id, id) DO UPDATE SET doc = excluded.doc, updated_at = excluded.updated_at`,
		mapID, head.ID, string(doc), now, now)
	if err != nil {
		return nil, err
	}
	return doc, nil
}

func (s *DuckStore) DeleteDataset(ctx context.Context, mapID, datasetID string) error {
	res, err := s.db.ExecContext(ctx, "DELETE FROM datasets WHERE map_id = ? AND id = ?", mapID, datasetID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd server && go get github.com/google/uuid@latest && go test ./internal/store/ -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/go.mod server/go.sum server/internal/store
git commit -m "feat(server): persist maps and datasets in a duckdb meta store"
```

---
### Task 11: Workspace HTTP API, dev auth and public map endpoint

**Files:**
- Create: `server/internal/auth/auth.go`, `server/internal/workspace/handler.go`
- Test: `server/internal/workspace/handler_test.go`

**Interfaces:**
- Consumes: `store.Store`, `store.DuckStore`, `httpx`.
- Produces:
  - `auth.WithUser(ctx, id string) context.Context`, `auth.UserID(ctx) string`, `auth.Dev(userID string, next http.Handler) http.Handler`.
  - `workspace.DefaultMapConfig` (JSON string), `workspace.Connection{Name, Provider string}`, `workspace.Handler{Store store.Store; Connections []Connection}`, `(*Handler).Register(mux *http.ServeMux, prefix string)`. Routes under `prefix` (the app uses `/api/workspace`):
    - `GET /maps`, `POST /maps`
    - `GET|PATCH|DELETE /maps/{id}`
    - `GET|POST /maps/{id}/datasets`, `PATCH|DELETE /maps/{id}/datasets/{dsId}`
    - `GET /connections`
    - plus the unprefixed `GET /v3/maps/public/{id}`

- [ ] **Step 1: Write the failing tests**

`server/internal/workspace/handler_test.go`:

```go
package workspace_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"osm-maps/server/internal/auth"
	"osm-maps/server/internal/store"
	"osm-maps/server/internal/workspace"
)

type env struct {
	srv   *httptest.Server
	store *store.DuckStore
}

func newEnv(t *testing.T) env {
	t.Helper()
	st, err := store.OpenDuck(context.Background(), filepath.Join(t.TempDir(), "meta.duckdb"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	mux := http.NewServeMux()
	(&workspace.Handler{Store: st, Connections: []workspace.Connection{{Name: "osm", Provider: "duckdb"}}}).Register(mux, "/api/workspace")
	// Tests pick the user per request with X-Test-User; production uses auth.Dev (M1) or sessions (M3).
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mux.ServeHTTP(w, r.WithContext(auth.WithUser(r.Context(), r.Header.Get("X-Test-User"))))
	})
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return env{srv: srv, store: st}
}

func (e env) do(t *testing.T, user, method, path string, body any) (int, map[string]any) {
	t.Helper()
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, e.srv.URL+path, rd)
	req.Header.Set("X-Test-User", user)
	req.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	var out map[string]any
	if len(raw) > 0 && raw[0] == '{' {
		_ = json.Unmarshal(raw, &out)
	} else if len(raw) > 0 && raw[0] == '[' {
		var arr []any
		_ = json.Unmarshal(raw, &arr)
		out = map[string]any{"items": arr}
	}
	return res.StatusCode, out
}

func TestMapsLifecycle(t *testing.T) {
	e := newEnv(t)
	status, m := e.do(t, "alice", "POST", "/api/workspace/maps", map[string]any{})
	if status != 201 || m["title"] != "Untitled map" || m["privacy"] != "private" {
		t.Fatalf("create: %d %v", status, m)
	}
	cfg := m["keplerMapConfig"].(map[string]any)
	if cfg["version"] != "v1" {
		t.Fatalf("default config = %v", cfg)
	}
	id := m["id"].(string)

	status, list := e.do(t, "alice", "GET", "/api/workspace/maps?page=1&page_size=12&order_by=updated_at&order_direction=DESC", nil)
	data := list["data"].([]any)
	page := list["meta"].(map[string]any)["page"].(map[string]any)
	if status != 200 || len(data) != 1 || page["total"].(float64) != 1 || page["totalPages"].(float64) != 1 {
		t.Fatalf("list: %d %v", status, list)
	}
	if _, has := data[0].(map[string]any)["keplerMapConfig"]; has {
		t.Fatal("list items must not include keplerMapConfig")
	}

	if status, m = e.do(t, "alice", "PATCH", "/api/workspace/maps/"+id, map[string]any{"title": "Tokyo POIs"}); status != 200 || m["title"] != "Tokyo POIs" {
		t.Fatalf("patch: %d %v", status, m)
	}
	if status, _ = e.do(t, "alice", "PATCH", "/api/workspace/maps/"+id, map[string]any{"title": ""}); status != 400 {
		t.Fatalf("empty title: %d", status)
	}
	if status, _ = e.do(t, "bob", "GET", "/api/workspace/maps/"+id, nil); status != 404 {
		t.Fatalf("other user reads private map: %d, want 404", status)
	}
	if status, _ = e.do(t, "bob", "DELETE", "/api/workspace/maps/"+id, nil); status != 404 {
		t.Fatalf("other user deletes private map: %d, want 404", status)
	}
	if status, _ = e.do(t, "", "GET", "/api/workspace/maps", nil); status != 401 {
		t.Fatalf("anonymous list: %d, want 401", status)
	}
	if status, _ = e.do(t, "alice", "GET", "/api/workspace/maps?order_by=views", nil); status != 400 {
		t.Fatalf("bad order_by: %d, want 400", status)
	}
	if status, _ = e.do(t, "alice", "DELETE", "/api/workspace/maps/"+id, nil); status != 204 {
		t.Fatalf("delete: %d", status)
	}
}

func TestDatasetsAndPublicMap(t *testing.T) {
	e := newEnv(t)
	_, m := e.do(t, "alice", "POST", "/api/workspace/maps", map[string]any{"title": "Public demo"})
	id := m["id"].(string)
	base := "/api/workspace/maps/" + id + "/datasets"

	status, ds := e.do(t, "alice", "POST", base, map[string]any{"type": "table", "connectionName": "osm", "source": "demo_points", "label": "Points"})
	if status != 201 || ds["id"] == nil {
		t.Fatalf("create dataset: %d %v", status, ds)
	}
	dsID := ds["id"].(string)
	for name, body := range map[string]map[string]any{
		"bad type":       {"type": "tileset", "connectionName": "osm", "source": "x"},
		"bad connection": {"type": "table", "connectionName": "bigquery", "source": "x"},
		"empty source":   {"type": "query", "connectionName": "osm", "source": ""},
	} {
		if status, _ := e.do(t, "alice", "POST", base, body); status != 400 {
			t.Errorf("%s: %d, want 400", name, status)
		}
	}
	if status, ds = e.do(t, "alice", "PATCH", base+"/"+dsID, map[string]any{"label": "Renamed"}); status != 200 || ds["label"] != "Renamed" || ds["source"] != "demo_points" {
		t.Fatalf("patch dataset: %d %v", status, ds)
	}
	if status, _ = e.do(t, "bob", "POST", base, map[string]any{"type": "table", "connectionName": "osm", "source": "x"}); status != 404 {
		t.Fatalf("other user adds dataset: %d, want 404", status)
	}

	if status, _ = e.do(t, "", "GET", "/v3/maps/public/"+id, nil); status != 404 {
		t.Fatalf("public endpoint on private map: %d, want 404", status)
	}
	if _, err := e.store.UpdateMap(context.Background(), id, store.MapPatch{Privacy: ptr("public")}); err != nil {
		t.Fatal(err)
	}
	status, pub := e.do(t, "", "GET", "/v3/maps/public/"+id, nil)
	if status != 200 || pub["title"] != "Public demo" || len(pub["datasets"].([]any)) != 1 || pub["keplerMapConfig"] == nil {
		t.Fatalf("public map: %d %v", status, pub)
	}
	if status, _ = e.do(t, "alice", "DELETE", base+"/"+dsID, nil); status != 204 {
		t.Fatalf("delete dataset: %d", status)
	}
	if status, conns := e.do(t, "alice", "GET", "/api/workspace/connections", nil); status != 200 || len(conns["items"].([]any)) != 1 {
		t.Fatalf("connections: %d %v", status, conns)
	}
}

func ptr[T any](v T) *T { return &v }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && go test ./internal/workspace/ -v`
Expected: FAIL to compile (`undefined: workspace.Handler`).

- [ ] **Step 3: Implement the dev auth**

`server/internal/auth/auth.go`:

```go
// Package auth carries the authenticated user id through request contexts.
package auth

import (
	"context"
	"net/http"
)

type ctxKey struct{}

func WithUser(ctx context.Context, id string) context.Context {
	return context.WithValue(ctx, ctxKey{}, id)
}

// UserID returns the authenticated user, or "" for anonymous requests.
func UserID(ctx context.Context) string {
	id, _ := ctx.Value(ctxKey{}).(string)
	return id
}

// Dev authenticates every request as one fixed user. M1 only; M3 replaces it with sessions.
func Dev(userID string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		next.ServeHTTP(w, r.WithContext(WithUser(r.Context(), userID)))
	})
}
```

- [ ] **Step 4: Implement the workspace handlers**

`server/internal/workspace/handler.go`:

```go
// Package workspace serves the maps and datasets REST API used by the web app.
package workspace

import (
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"strconv"
	"strings"

	"github.com/google/uuid"

	"osm-maps/server/internal/auth"
	"osm-maps/server/internal/httpx"
	"osm-maps/server/internal/store"
)

// DefaultMapConfig is the keplerMapConfig of a new, empty map (centred on Tokyo Station).
const DefaultMapConfig = `{"version":"v1","config":{"mapState":{"latitude":35.681,"longitude":139.767,"zoom":11,"pitch":0,"bearing":0},"visState":{"layers":[]},"basemapConfig":{"styleId":"positron"}}}`

const maxBody = 5 << 20

type Connection struct {
	Name     string `json:"name"`
	Provider string `json:"provider"`
}

type Handler struct {
	Store       store.Store
	Connections []Connection
}

func (h *Handler) Register(mux *http.ServeMux, prefix string) {
	mux.HandleFunc("GET "+prefix+"/maps", h.authed(h.listMaps))
	mux.HandleFunc("POST "+prefix+"/maps", h.authed(h.createMap))
	mux.HandleFunc("GET "+prefix+"/maps/{id}", h.authed(h.getMap))
	mux.HandleFunc("PATCH "+prefix+"/maps/{id}", h.authed(h.patchMap))
	mux.HandleFunc("DELETE "+prefix+"/maps/{id}", h.authed(h.deleteMap))
	mux.HandleFunc("GET "+prefix+"/maps/{id}/datasets", h.authed(h.listDatasets))
	mux.HandleFunc("POST "+prefix+"/maps/{id}/datasets", h.authed(h.createDataset))
	mux.HandleFunc("PATCH "+prefix+"/maps/{id}/datasets/{dsId}", h.authed(h.patchDataset))
	mux.HandleFunc("DELETE "+prefix+"/maps/{id}/datasets/{dsId}", h.authed(h.deleteDataset))
	mux.HandleFunc("GET "+prefix+"/connections", h.authed(h.listConnections))
	mux.HandleFunc("GET /v3/maps/public/{id}", h.publicMap)
}

type handlerFunc func(w http.ResponseWriter, r *http.Request, user string)

func (h *Handler) authed(fn handlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user := auth.UserID(r.Context())
		if user == "" {
			httpx.WriteError(w, http.StatusUnauthorized, "authentication required")
			return
		}
		fn(w, r, user)
	}
}

func canRead(m store.Map, user string) bool {
	return m.OwnerID == user || m.Privacy == "shared" || m.Privacy == "public"
}

// loadMap returns the map if user may read it (and write it, when write is set).
// Unreadable maps answer 404 so their existence does not leak.
func (h *Handler) loadMap(w http.ResponseWriter, r *http.Request, user string, write bool) (store.Map, bool) {
	m, err := h.Store.GetMap(r.Context(), r.PathValue("id"))
	if err != nil || !canRead(m, user) {
		if err != nil && !errors.Is(err, store.ErrNotFound) {
			fail(w, err)
			return m, false
		}
		httpx.WriteError(w, http.StatusNotFound, "map not found")
		return m, false
	}
	if write && m.OwnerID != user {
		httpx.WriteError(w, http.StatusForbidden, "only the owner can change this map")
		return m, false
	}
	return m, true
}

func (h *Handler) listMaps(w http.ResponseWriter, r *http.Request, user string) {
	v := r.URL.Query()
	q := store.ListQuery{ViewerID: user, Search: v.Get("search"), OwnerID: v.Get("user_id"), OrderBy: "updated_at", Desc: true}
	var err error
	if q.Page, err = intParam(v.Get("page"), 1, 1, 1<<30); err != nil {
		badRequest(w, "page must be a positive integer")
		return
	}
	if q.PageSize, err = intParam(v.Get("page_size"), 12, 1, 100); err != nil {
		badRequest(w, "page_size must be 1..100")
		return
	}
	if s := v.Get("order_by"); s != "" {
		if s != "updated_at" && s != "title" {
			badRequest(w, "order_by must be updated_at or title")
			return
		}
		q.OrderBy = s
	}
	switch strings.ToUpper(v.Get("order_direction")) {
	case "", "DESC":
	case "ASC":
		q.Desc = false
	default:
		badRequest(w, "order_direction must be ASC or DESC")
		return
	}
	if p := v.Get("privacy"); p != "" {
		if !validPrivacy(p) {
			badRequest(w, "privacy must be private, shared or public")
			return
		}
		q.Privacy = p
	}
	maps, page, err := h.Store.ListMaps(r.Context(), q)
	if err != nil {
		fail(w, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"data": maps, "meta": map[string]any{"page": page}})
}

func (h *Handler) createMap(w http.ResponseWriter, r *http.Request, user string) {
	var body struct {
		Title           string          `json:"title"`
		Description     string          `json:"description"`
		Tags            []string        `json:"tags"`
		KeplerMapConfig json.RawMessage `json:"keplerMapConfig"`
		Collaborative   bool            `json:"collaborative"`
	}
	if !decode(w, r, &body) {
		return
	}
	if strings.TrimSpace(body.Title) == "" {
		body.Title = "Untitled map"
	}
	cfg := body.KeplerMapConfig
	if len(cfg) == 0 || string(cfg) == "null" {
		cfg = json.RawMessage(DefaultMapConfig)
	} else if !isObject(cfg) {
		badRequest(w, "keplerMapConfig must be a JSON object")
		return
	}
	m, err := h.Store.CreateMap(r.Context(), store.Map{
		OwnerID: user, Title: body.Title, Description: body.Description, Tags: body.Tags,
		Collaborative: body.Collaborative, KeplerMapConfig: cfg,
	})
	if err != nil {
		fail(w, err)
		return
	}
	httpx.WriteJSON(w, http.StatusCreated, m)
}

func (h *Handler) getMap(w http.ResponseWriter, r *http.Request, user string) {
	if m, ok := h.loadMap(w, r, user, false); ok {
		httpx.WriteJSON(w, http.StatusOK, m)
	}
}

func (h *Handler) patchMap(w http.ResponseWriter, r *http.Request, user string) {
	m, ok := h.loadMap(w, r, user, true)
	if !ok {
		return
	}
	var body struct {
		Title           *string         `json:"title"`
		Description     *string         `json:"description"`
		Tags            *[]string       `json:"tags"`
		KeplerMapConfig json.RawMessage `json:"keplerMapConfig"`
		Collaborative   *bool           `json:"collaborative"`
	}
	if !decode(w, r, &body) {
		return
	}
	if body.Title != nil && (strings.TrimSpace(*body.Title) == "" || len(*body.Title) > 255) {
		badRequest(w, "title must be 1..255 characters")
		return
	}
	if len(body.KeplerMapConfig) > 0 && !isObject(body.KeplerMapConfig) {
		badRequest(w, "keplerMapConfig must be a JSON object")
		return
	}
	// privacy changes go through POST /maps/{id}/privacy (M3), so it is not patchable here
	upd, err := h.Store.UpdateMap(r.Context(), m.ID, store.MapPatch{
		Title: body.Title, Description: body.Description, Tags: body.Tags,
		Collaborative: body.Collaborative, KeplerMapConfig: body.KeplerMapConfig,
	})
	if err != nil {
		fail(w, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, upd)
}

func (h *Handler) deleteMap(w http.ResponseWriter, r *http.Request, user string) {
	m, ok := h.loadMap(w, r, user, true)
	if !ok {
		return
	}
	if err := h.Store.DeleteMap(r.Context(), m.ID); err != nil {
		fail(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) listDatasets(w http.ResponseWriter, r *http.Request, user string) {
	m, ok := h.loadMap(w, r, user, false)
	if !ok {
		return
	}
	ds, err := h.Store.ListDatasets(r.Context(), m.ID)
	if err != nil {
		fail(w, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, ds)
}

func (h *Handler) createDataset(w http.ResponseWriter, r *http.Request, user string) {
	m, ok := h.loadMap(w, r, user, true)
	if !ok {
		return
	}
	var doc map[string]any
	if !decode(w, r, &doc) {
		return
	}
	if id, _ := doc["id"].(string); id == "" {
		doc["id"] = uuid.NewString()
	}
	h.saveDataset(w, r, m.ID, doc, http.StatusCreated)
}

func (h *Handler) patchDataset(w http.ResponseWriter, r *http.Request, user string) {
	m, ok := h.loadMap(w, r, user, true)
	if !ok {
		return
	}
	existing, err := h.Store.ListDatasets(r.Context(), m.ID)
	if err != nil {
		fail(w, err)
		return
	}
	dsID := r.PathValue("dsId")
	var doc map[string]any
	for _, raw := range existing {
		var d map[string]any
		if json.Unmarshal(raw, &d) == nil && d["id"] == dsID {
			doc = d
		}
	}
	if doc == nil {
		httpx.WriteError(w, http.StatusNotFound, "dataset not found")
		return
	}
	var patch map[string]any
	if !decode(w, r, &patch) {
		return
	}
	for k, v := range patch { // shallow merge; the id is fixed by the URL
		if k != "id" {
			doc[k] = v
		}
	}
	h.saveDataset(w, r, m.ID, doc, http.StatusOK)
}

func (h *Handler) saveDataset(w http.ResponseWriter, r *http.Request, mapID string, doc map[string]any, status int) {
	if msg := h.validateDataset(doc); msg != "" {
		badRequest(w, msg)
		return
	}
	raw, _ := json.Marshal(doc)
	saved, err := h.Store.PutDataset(r.Context(), mapID, raw)
	if err != nil {
		fail(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(saved)
}

func (h *Handler) validateDataset(doc map[string]any) string {
	if t, _ := doc["type"].(string); t != "table" && t != "query" {
		return "dataset type must be table or query"
	}
	conn, _ := doc["connectionName"].(string)
	known := false
	for _, c := range h.Connections {
		known = known || c.Name == conn
	}
	if !known {
		return "unknown connectionName"
	}
	if s, _ := doc["source"].(string); strings.TrimSpace(s) == "" {
		return "dataset source is required"
	}
	return ""
}

func (h *Handler) deleteDataset(w http.ResponseWriter, r *http.Request, user string) {
	m, ok := h.loadMap(w, r, user, true)
	if !ok {
		return
	}
	if err := h.Store.DeleteDataset(r.Context(), m.ID, r.PathValue("dsId")); err != nil {
		fail(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) listConnections(w http.ResponseWriter, r *http.Request, _ string) {
	httpx.WriteJSON(w, http.StatusOK, h.Connections)
}

// publicMap serves a public map with its datasets embedded, without authentication (ledger M11).
func (h *Handler) publicMap(w http.ResponseWriter, r *http.Request) {
	m, err := h.Store.GetMap(r.Context(), r.PathValue("id"))
	if err != nil || m.Privacy != "public" {
		if err != nil && !errors.Is(err, store.ErrNotFound) {
			fail(w, err)
			return
		}
		httpx.WriteError(w, http.StatusNotFound, "map not found")
		return
	}
	ds, err := h.Store.ListDatasets(r.Context(), m.ID)
	if err != nil {
		fail(w, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, struct {
		store.Map
		Datasets []json.RawMessage `json:"datasets"`
	}{m, ds})
}

func decode(w http.ResponseWriter, r *http.Request, dst any) bool {
	err := json.NewDecoder(io.LimitReader(r.Body, maxBody)).Decode(dst)
	if err != nil && !errors.Is(err, io.EOF) {
		badRequest(w, "request body must be JSON: "+err.Error())
		return false
	}
	if m, ok := dst.(*map[string]any); ok && *m == nil {
		*m = map[string]any{}
	}
	return true
}

func isObject(raw json.RawMessage) bool {
	var v map[string]any
	return json.Unmarshal(raw, &v) == nil
}

func intParam(s string, def, min, max int) (int, error) {
	if s == "" {
		return def, nil
	}
	n, err := strconv.Atoi(s)
	if err != nil || n < min || n > max {
		return 0, errors.New("out of range")
	}
	return n, nil
}

func validPrivacy(p string) bool { return p == "private" || p == "shared" || p == "public" }

func badRequest(w http.ResponseWriter, msg string) { httpx.WriteError(w, http.StatusBadRequest, msg) }

func fail(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, store.ErrNotFound):
		httpx.WriteError(w, http.StatusNotFound, "not found")
	case errors.Is(err, store.ErrInvalid):
		badRequest(w, err.Error())
	default:
		log.Printf("workspace: %v", err)
		httpx.WriteError(w, http.StatusInternalServerError, "internal error")
	}
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd server && go test ./internal/workspace/ -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/internal/auth server/internal/workspace
git commit -m "feat(server): add workspace maps api and public map endpoint"
```

---
### Task 12: `mapsd` server binary

**Files:**
- Create: `server/cmd/mapsd/main.go`
- Test: `server/cmd/mapsd/main_test.go`

**Interfaces:**
- Consumes: `duck.Open`, `store.OpenDuck`, `mapsapi.Server`, `workspace.Handler`, `auth.Dev`, `seed.Demo` (test).
- Produces:
  - The CLI `mapsd -addr 127.0.0.1:8080 -data data.duckdb -meta meta.duckdb [-dev-user dev-user] [-web web/dist] [-memory-limit 2GB] [-threads 4] [-query-timeout 15s]`.
  - `GET /healthz` → `200 ok`.
  - Inside the package, `newHandler(ctx, config) (http.Handler, func(), error)`.

- [ ] **Step 1: Write the failing test**

`server/cmd/mapsd/main_test.go`:

```go
package main

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"osm-maps/server/internal/duck"
	"osm-maps/server/internal/seed"
)

func TestServerWiring(t *testing.T) {
	dir := t.TempDir()
	data := filepath.Join(dir, "data.duckdb")
	rw, err := duck.Open(duck.Options{Path: data})
	if err != nil {
		t.Fatal(err)
	}
	if err := seed.Demo(context.Background(), rw); err != nil {
		t.Fatal(err)
	}
	rw.Close()

	web := filepath.Join(dir, "web")
	os.MkdirAll(filepath.Join(web, "assets"), 0o755)
	os.WriteFile(filepath.Join(web, "index.html"), []byte("<html>app</html>"), 0o644)
	os.WriteFile(filepath.Join(web, "assets", "app.js"), []byte("console.log(1)"), 0o644)

	h, cleanup, err := newHandler(context.Background(), config{
		Data: data, Meta: filepath.Join(dir, "meta.duckdb"), DevUser: "dev-user", Web: web, QueryTimeout: 10 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()
	srv := httptest.NewServer(h)
	defer srv.Close()

	for path, want := range map[string]string{
		"/healthz":                              "ok",
		"/api/workspace/maps":                   `"data":[]`,
		"/v3/maps/osm/table?name=demo_points":   `"tilejson"`,
		"/api/workspace/connections":            `"osm"`,
		"/assets/app.js":                        "console.log(1)",
		"/maps":                                 "<html>app</html>", // SPA fallback
		"/viewer/123":                           "<html>app</html>",
	} {
		res, err := http.Get(srv.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(res.Body)
		res.Body.Close()
		if res.StatusCode != 200 || !strings.Contains(string(body), want) {
			t.Errorf("%s: %d %q, want body containing %q", path, res.StatusCode, body, want)
		}
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && go test ./cmd/mapsd/ -v`
Expected: FAIL to compile (`undefined: newHandler`).

- [ ] **Step 3: Implement `main.go`**

`server/cmd/mapsd/main.go`:

```go
// Command mapsd serves the osm-maps Data API, workspace API and (optionally) the built web app.
package main

import (
	"context"
	"database/sql"
	"errors"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"syscall"
	"time"

	"osm-maps/server/internal/auth"
	"osm-maps/server/internal/duck"
	"osm-maps/server/internal/mapsapi"
	"osm-maps/server/internal/store"
	"osm-maps/server/internal/workspace"
)

type config struct {
	Addr, Data, Meta, DevUser, Web, MemoryLimit string
	Threads                                     int
	QueryTimeout                                time.Duration
}

func main() {
	var c config
	flag.StringVar(&c.Addr, "addr", "127.0.0.1:8080", "listen address")
	flag.StringVar(&c.Data, "data", "data.duckdb", "data DuckDB file (opened read-only)")
	flag.StringVar(&c.Meta, "meta", "meta.duckdb", "metadata DuckDB file (created if missing)")
	flag.StringVar(&c.DevUser, "dev-user", "dev-user", "user id every request runs as (M1 dev auth)")
	flag.StringVar(&c.Web, "web", "", "directory of the built web app to serve at /")
	flag.StringVar(&c.MemoryLimit, "memory-limit", "", "DuckDB memory_limit for the data DB, e.g. 2GB")
	flag.IntVar(&c.Threads, "threads", 0, "DuckDB threads for the data DB (0 = default)")
	flag.DurationVar(&c.QueryTimeout, "query-timeout", 15*time.Second, "per-request query timeout")
	flag.Parse()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, c); err != nil {
		log.Fatal(err)
	}
}

func run(ctx context.Context, c config) error {
	h, cleanup, err := newHandler(ctx, c)
	if err != nil {
		return err
	}
	defer cleanup()
	srv := &http.Server{Addr: c.Addr, Handler: h, ReadHeaderTimeout: 10 * time.Second}
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdown)
	}()
	log.Printf("mapsd listening on http://%s", c.Addr)
	if err := srv.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

func newHandler(ctx context.Context, c config) (http.Handler, func(), error) {
	fi, err := os.Stat(c.Data)
	if err != nil {
		return nil, nil, fmt.Errorf("data file: %w (create it with cmd/seed or cmd/osm-ingest)", err)
	}
	dataDB, err := duck.Open(duck.Options{Path: c.Data, ReadOnly: true, Sandbox: true, MemoryLimit: c.MemoryLimit, Threads: c.Threads})
	if err != nil {
		return nil, nil, err
	}
	if err := dataDB.PingContext(ctx); err != nil {
		dataDB.Close()
		return nil, nil, fmt.Errorf("data db: %w", err)
	}
	st, err := store.OpenDuck(ctx, c.Meta)
	if err != nil {
		dataDB.Close()
		return nil, nil, err
	}

	mux := http.NewServeMux()
	(&mapsapi.Server{
		Conns:        map[string]*sql.DB{"osm": dataDB},
		DataVersion:  strconv.FormatInt(fi.ModTime().UnixMilli(), 10),
		QueryTimeout: c.QueryTimeout,
		MaxFeatures:  200_000,
	}).Register(mux)
	(&workspace.Handler{Store: st, Connections: []workspace.Connection{{Name: "osm", Provider: "duckdb"}}}).Register(mux, "/api/workspace")
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("ok")) })
	if c.Web != "" {
		mux.Handle("GET /", spa(c.Web))
	}
	cleanup := func() {
		st.Close()
		dataDB.Close()
	}
	return auth.Dev(c.DevUser, mux), cleanup, nil
}

// spa serves files from dir and falls back to index.html for client-side routes.
func spa(dir string) http.Handler {
	files := http.FileServer(http.Dir(dir))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := filepath.Join(dir, filepath.Clean("/"+r.URL.Path))
		if st, err := os.Stat(p); err != nil || st.IsDir() {
			http.ServeFile(w, r, filepath.Join(dir, "index.html"))
			return
		}
		files.ServeHTTP(w, r)
	})
}
```

- [ ] **Step 4: Run all server tests**

Run: `cd server && go vet ./... && go test ./... -race`
Expected: PASS for every package. `TestLoadPBF` is skipped unless `OSM_PBF` is set.

- [ ] **Step 5: Smoke-run the binary**

```bash
cd server
go run ./cmd/seed -out /tmp/osm-maps-data.duckdb
go run ./cmd/mapsd -data /tmp/osm-maps-data.duckdb -meta /tmp/osm-maps-meta.duckdb &
sleep 3
curl -s localhost:8080/healthz; echo
curl -s 'localhost:8080/v3/maps/osm/table?name=demo_points&columns=name' | head -c 300; echo
kill %1
```

Expected: `ok`, then a JSON body starting with `{"schema":[` or `{"tilejson":`.

- [ ] **Step 6: Commit**

```bash
git add server/cmd/mapsd
git commit -m "feat(server): add mapsd binary wiring data, workspace and spa"
```

---
### Task 13: Web scaffold and SDK contract test

**Files:**
- Create: `web/package.json` (via npm), `web/tsconfig.json`, `web/vite.config.ts`, `web/vitest.contract.config.ts`, `web/index.html`, `web/src/main.tsx`, `web/src/App.tsx`, `web/src/styles.css`, `web/src/test-setup.ts`
- Test: `web/contract/globalSetup.ts`, `web/contract/sdk.contract.test.ts`

**Interfaces:**
- Consumes: the `mapsd` and `seed` CLIs (Tasks 3 and 12).
- Produces:
  - npm scripts `dev`, `build`, `test`, `test:contract`, `typecheck`.
  - A Vite dev proxy for `/api` and `/v3` to `http://127.0.0.1:8080`.
  - `App` with routes `/` → `/maps`, `/maps`, `/viewer/:id`, `/map/:id`. The pages are placeholders until Tasks 14–15.

- [ ] **Step 1: Create the package and install pinned dependencies**

```bash
mkdir -p /Users/pandu/job/ventaris-moovin/explore/maps/web && cd /Users/pandu/job/ventaris-moovin/explore/maps/web
cat > package.json <<'EOF'
{
  "name": "osm-maps-web",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:contract": "vitest run --config vitest.contract.config.ts"
  }
}
EOF
npm install react react-dom react-router maplibre-gl @carto/api-client h3-js \
  @deck.gl/core@~9.3.3 @deck.gl/layers@~9.3.3 @deck.gl/geo-layers@~9.3.3 @deck.gl/carto@~9.3.3 @deck.gl/mapbox@~9.3.3
npm install -D vite @vitejs/plugin-react typescript @types/react @types/react-dom @types/node \
  vitest@^3 jsdom @testing-library/react @testing-library/jest-dom
```

Then check that the SDK options this plan relies on exist in the installed versions:

```bash
grep -rl "authMode" node_modules/@carto/api-client/build | head -1      # optional; M3 uses it
grep -rn '"{i}"\|{i}' node_modules/@deck.gl/carto/dist/index.js | head -3 # H3 tile URL placeholder (ledger U4)
grep -rn "cartoSpatialTile" node_modules/@deck.gl/carto/dist/index.js | head -3   # Task 8 Step 1 wire-format check
```

If the H3 placeholder is not `{i}`, change `"/{i}?"` in `server/internal/mapsapi/handler.go` (and in the Task 9 test) to the placeholder the client uses.

- [ ] **Step 2: Add config files**

`web/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "esModuleInterop": true,
    "types": ["vitest/globals", "node"]
  },
  "include": ["src", "contract", "vite.config.ts", "vitest.contract.config.ts"]
}
```

`web/vite.config.ts`:

```ts
/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const api = 'http://127.0.0.1:8080';

export default defineConfig({
  plugins: [react()],
  // changeOrigin stays false: mapsd builds tile URLs from the Host header, so they point back at this dev server.
  server: { proxy: { '/api': { target: api }, '/v3': { target: api } } },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
```

`web/vitest.contract.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['contract/**/*.test.ts'],
    globalSetup: ['./contract/globalSetup.ts'],
    testTimeout: 60_000,
    hookTimeout: 300_000,
  },
});
```

`web/src/test-setup.ts`:

```ts
import '@testing-library/jest-dom/vitest';
```

- [ ] **Step 3: Add the app shell**

`web/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>osm-maps</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`web/src/main.tsx`:

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import 'maplibre-gl/dist/maplibre-gl.css';
import './styles.css';
import { App } from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
```

`web/src/App.tsx` (Tasks 14 and 15 replace the placeholders):

```tsx
import { Navigate, Route, Routes } from 'react-router';

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/maps" replace />} />
      <Route path="/maps" element={<p>Maps</p>} />
      <Route path="/viewer/:id" element={<p>Viewer</p>} />
      <Route path="/map/:id" element={<p>Public map</p>} />
    </Routes>
  );
}
```

`web/src/styles.css`:

```css
:root { font-family: system-ui, sans-serif; color: #1f2933; background: #f7f8f9; }
body { margin: 0; }
button { cursor: pointer; padding: 6px 14px; border-radius: 4px; border: 1px solid #0b62d6; background: #0b62d6; color: #fff; }
.maps-page { max-width: 1200px; margin: 0 auto; padding: 24px; }
.maps-page header { display: flex; justify-content: space-between; align-items: center; }
.toolbar { display: flex; gap: 8px; margin: 16px 0; }
.map-grid { list-style: none; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 16px; }
.map-card { display: block; background: #fff; border: 1px solid #e1e4e8; border-radius: 6px; color: inherit; text-decoration: none; }
.map-card .thumb { aspect-ratio: 16 / 9; background: #e9edf1 center / cover no-repeat; border-radius: 6px 6px 0 0; }
.map-card .meta { padding: 10px 12px; display: flex; justify-content: space-between; gap: 8px; }
.badge { font-size: 12px; padding: 1px 8px; border-radius: 10px; background: #eef2f6; }
.empty { text-align: center; padding: 48px 0; }
.viewer { position: fixed; inset: 0; display: flex; flex-direction: column; }
.viewer header { padding: 8px 16px; background: #102a43; color: #fff; }
.viewer header h1 { font-size: 16px; margin: 0; }
.viewer-map { flex: 1; }
```

- [ ] **Step 4: Write the contract test**

`web/contract/globalSetup.ts`:

```ts
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    apiBaseUrl: string;
  }
}

const serverDir = resolve(import.meta.dirname, '../../server');

// Builds mapsd, seeds a fresh data DB and serves it on a random port for the contract tests.
export default async function setup(project: TestProject) {
  const dir = mkdtempSync(join(tmpdir(), 'osm-maps-contract-'));
  const bin = join(dir, 'mapsd');
  execFileSync('go', ['build', '-o', bin, './cmd/mapsd'], { cwd: serverDir, stdio: 'inherit' });
  execFileSync('go', ['run', './cmd/seed', '-out', join(dir, 'data.duckdb')], { cwd: serverDir, stdio: 'inherit' });
  const port = 18000 + Math.floor(Math.random() * 1000);
  const proc = spawn(bin, ['-addr', `127.0.0.1:${port}`, '-data', join(dir, 'data.duckdb'), '-meta', join(dir, 'meta.duckdb')], {
    stdio: 'inherit',
  });
  const base = `http://127.0.0.1:${port}`;
  await waitForHealthy(`${base}/healthz`, 60_000);
  project.provide('apiBaseUrl', base);
  return () => {
    proc.kill('SIGTERM');
    rmSync(dir, { recursive: true, force: true });
  };
}

async function waitForHealthy(url: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`mapsd did not become healthy at ${url}`);
}
```

`web/contract/sdk.contract.test.ts`:

```ts
import { h3QuerySource, vectorQuerySource, vectorTableSource } from '@carto/api-client';
import { latLngToCell } from 'h3-js';
import { describe, expect, inject, it } from 'vitest';

// mapsd's M1 dev auth ignores the token; the SDK requires one unless authMode is 'session'.
const common = { apiBaseUrl: inject('apiBaseUrl'), connectionName: 'osm', accessToken: 'dev' };

describe('@carto/api-client against mapsd', () => {
  it('vectorTableSource instantiates and advertises MVT tiles', async () => {
    const tj = await vectorTableSource({ ...common, tableName: 'demo_points', columns: ['name', 'value'] });
    expect(tj.tiles[0]).toContain('formatTiles=mvt');
    expect(tj.tiles[0]).toContain('/{z}/{x}/{y}');
    expect(tj).toMatchObject({ tilestats: { layers: [{ count: 400 }] } });

    const res = await fetch(tj.tiles[0].replace('{z}', '0').replace('{x}', '0').replace('{y}', '0'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/vnd.mapbox-vector-tile');
    expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(0);
  });

  it('vectorQuerySource passes named queryParameters', async () => {
    const tj = await vectorQuerySource({
      ...common,
      sqlQuery: 'SELECT * FROM demo_points WHERE value >= $min',
      queryParameters: { min: 390 },
      columns: ['name'],
    });
    expect(tj).toMatchObject({ tilestats: { layers: [{ count: 10 }] } });
  });

  it('h3QuerySource serves cell-addressed spatial tiles', async () => {
    const tj = await h3QuerySource({
      ...common,
      sqlQuery: 'SELECT h3, value FROM demo_points',
      spatialDataColumn: 'h3',
      aggregationExp: 'sum(value) AS value_sum',
      aggregationResLevel: 4,
    });
    expect(tj.tiles[0]).toContain('/{i}');
    expect(tj).toMatchObject({ maxresolution: 8 });

    const cell = latLngToCell(35.65, 139.7, 6);
    const res = await fetch(tj.tiles[0].replace('{i}', cell));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/vnd.carto-spatial-tile');
  });
});
```

- [ ] **Step 5: Run the contract test**

Run: `cd web && npm run test:contract`
Expected: three tests PASS.

When a test fails, read the SDK request with `DEBUG`-style logging (`console.log(tj)`) and compare it with spec §4.2:

- If the SDK sends a parameter name the server ignores (for example a different name for query parameters), add it to `mapsapi.SourceFrom` and record the finding in the ledger table "Unknowns".
- If the TypeScript compiler rejects an option name above, use the name from `node_modules/@carto/api-client/build/*.d.ts`.

- [ ] **Step 6: Typecheck and commit**

```bash
cd web && npm run typecheck
cd .. && git add web/package.json web/package-lock.json web/tsconfig.json web/vite.config.ts web/vitest.contract.config.ts web/index.html web/src web/contract
git commit -m "test(web): prove @carto/api-client compatibility against mapsd"
```

---
### Task 14: Workspace API client and `/maps` list page

**Files:**
- Create: `web/src/lib/mapDoc.ts`, `web/src/lib/workspaceApi.ts`, `web/src/pages/MapsPage.tsx`
- Modify: `web/src/App.tsx` (the `/maps` route)
- Test: `web/src/lib/workspaceApi.test.ts`, `web/src/pages/MapsPage.test.tsx`

**Interfaces:**
- Consumes: the workspace API (Task 11).
- Produces:
  - In `mapDoc.ts`: types `Privacy`, `MapSummary`, `MapDoc`, `KeplerMapConfig`, `MapState`, `LayerDoc`, `DatasetDoc`.
  - In `workspaceApi.ts`:
    - `WORKSPACE = '/api/workspace'`, `ApiError`, `ListMapsParams`, `MapPage`
    - `listMapsUrl(p): string`, `listMaps(p, f?)`, `createMap(body?, f?)`, `getMap(id, f?)`, `getDatasets(id, f?)`, `getPublicMap(id, f?)`. Every function takes an optional `fetch` as its last argument.
  - `MapsPage({ fetcher?: typeof fetch })`.

- [ ] **Step 1: Add the shared types**

`web/src/lib/mapDoc.ts`:

```ts
// Subset of the map document (spec §4.4, ledger D1) that M1 reads. Unknown keys are preserved by the server.
export type Privacy = 'private' | 'shared' | 'public';
export type RGB = [number, number, number];

export interface MapSummary {
  id: string;
  title: string;
  description: string;
  tags: string[];
  privacy: Privacy;
  collaborative: boolean;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
  thumbnailUrl: string | null;
  views: number;
}

export interface MapState {
  latitude: number;
  longitude: number;
  zoom: number;
  pitch?: number;
  bearing?: number;
}

export interface LayerDoc {
  id: string;
  type: 'tileset' | 'h3' | string;
  config: {
    dataId: string;
    label?: string;
    color?: RGB;
    isVisible?: boolean;
    visConfig?: {
      opacity?: number;
      radius?: number;
      filled?: boolean;
      stroked?: boolean;
      strokeColor?: RGB | null;
      thickness?: number;
    };
  };
}

export interface KeplerMapConfig {
  version: 'v1';
  config: {
    mapState: MapState;
    visState?: { layers?: LayerDoc[] };
    basemapConfig?: { styleId?: string };
  };
}

export interface MapDoc extends MapSummary {
  keplerMapConfig: KeplerMapConfig;
}

export interface DatasetDoc {
  id: string;
  type: 'table' | 'query';
  label?: string;
  connectionName: string;
  source: string;
  geoColumn?: string | null;
  spatialIndex?: 'h3' | null;
  columns?: string[] | null;
  queryParameters?: Record<string, unknown> | null;
  aggregationExp?: string | null;
  aggregationResLevel?: number | null;
}
```

- [ ] **Step 2: Write the failing API-client test**

`web/src/lib/workspaceApi.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { ApiError, createMap, listMaps, listMapsUrl } from './workspaceApi';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('workspaceApi', () => {
  it('builds the list URL with CARTO-style snake_case params', () => {
    expect(listMapsUrl({})).toBe('/api/workspace/maps?page=1&page_size=12&order_by=updated_at&order_direction=DESC');
    expect(listMapsUrl({ page: 2, pageSize: 50, search: 'tokyo cafés', orderBy: 'title', orderDirection: 'ASC', privacy: 'public' })).toBe(
      '/api/workspace/maps?page=2&page_size=50&order_by=title&order_direction=ASC&search=tokyo+caf%C3%A9s&privacy=public',
    );
  });

  it('returns the parsed page', async () => {
    const f = vi.fn(async () => json({ data: [], meta: { page: { total: 0, current: 1, pageSize: 12, totalPages: 0 } } }));
    const page = await listMaps({}, f);
    expect(page.meta.page.total).toBe(0);
  });

  it('throws ApiError with the server message', async () => {
    const f = vi.fn(async () => json({ error: 'order_by must be updated_at or title', status: 400 }, 400));
    await expect(listMaps({}, f)).rejects.toEqual(new ApiError(400, 'order_by must be updated_at or title'));
  });

  it('POSTs JSON when creating a map', async () => {
    const f = vi.fn(async () => json({ id: 'm1' }, 201));
    await createMap({ title: 'T' }, f);
    expect(f).toHaveBeenCalledWith('/api/workspace/maps', expect.objectContaining({ method: 'POST', body: '{"title":"T"}' }));
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd web && npx vitest run src/lib/workspaceApi.test.ts`
Expected: FAIL with `Failed to resolve import "./workspaceApi"`.

- [ ] **Step 4: Implement the API client**

`web/src/lib/workspaceApi.ts`:

```ts
import type { DatasetDoc, MapDoc, MapSummary, Privacy } from './mapDoc';

export const WORKSPACE = '/api/workspace';

export interface PageMeta {
  total: number;
  current: number;
  pageSize: number;
  totalPages: number;
}

export interface MapPage {
  data: MapSummary[];
  meta: { page: PageMeta };
}

export interface ListMapsParams {
  page?: number;
  pageSize?: number;
  search?: string;
  orderBy?: 'updated_at' | 'title';
  orderDirection?: 'ASC' | 'DESC';
  privacy?: Privacy;
}

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type Fetch = typeof fetch;

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let msg = res.statusText;
    try {
      msg = ((await res.json()) as { error?: string }).error ?? msg;
    } catch {
      // body was not JSON; keep the status text
    }
    throw new ApiError(res.status, msg);
  }
  return (await res.json()) as T;
}

export function listMapsUrl(p: ListMapsParams = {}): string {
  const q = new URLSearchParams({
    page: String(p.page ?? 1),
    page_size: String(p.pageSize ?? 12),
    order_by: p.orderBy ?? 'updated_at',
    order_direction: p.orderDirection ?? 'DESC',
  });
  if (p.search) q.set('search', p.search);
  if (p.privacy) q.set('privacy', p.privacy);
  return `${WORKSPACE}/maps?${q}`;
}

export async function listMaps(p: ListMapsParams = {}, f: Fetch = fetch): Promise<MapPage> {
  return json<MapPage>(await f(listMapsUrl(p)));
}

export async function createMap(body: Partial<Pick<MapDoc, 'title' | 'description' | 'keplerMapConfig'>> = {}, f: Fetch = fetch): Promise<MapDoc> {
  return json<MapDoc>(
    await f(`${WORKSPACE}/maps`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  );
}

export async function getMap(id: string, f: Fetch = fetch): Promise<MapDoc> {
  return json<MapDoc>(await f(`${WORKSPACE}/maps/${encodeURIComponent(id)}`));
}

export async function getDatasets(id: string, f: Fetch = fetch): Promise<DatasetDoc[]> {
  return json<DatasetDoc[]>(await f(`${WORKSPACE}/maps/${encodeURIComponent(id)}/datasets`));
}

export async function getPublicMap(id: string, f: Fetch = fetch): Promise<MapDoc & { datasets: DatasetDoc[] }> {
  return json<MapDoc & { datasets: DatasetDoc[] }>(await f(`/v3/maps/public/${encodeURIComponent(id)}`));
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `cd web && npx vitest run src/lib/workspaceApi.test.ts`
Expected: PASS.

- [ ] **Step 6: Write the failing page test**

`web/src/pages/MapsPage.test.tsx`:

```tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import type { MapSummary } from '../lib/mapDoc';
import { MapsPage } from './MapsPage';

function summary(i: number): MapSummary {
  return {
    id: `m${i}`, title: `Map ${i}`, description: '', tags: [], privacy: i % 2 ? 'public' : 'private', collaborative: false,
    ownerId: 'dev-user', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-02T00:00:00Z', thumbnailUrl: null, views: 0,
  };
}

// Fake workspace API: `total` maps, 12 per page; POST creates "new-1".
function fakeApi(total: number) {
  const calls: string[] = [];
  const f = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    if (init?.method === 'POST') return new Response(JSON.stringify({ ...summary(99), id: 'new-1' }), { status: 201 });
    const page = Number(new URL(url, 'http://test').searchParams.get('page'));
    const start = (page - 1) * 12;
    const data = Array.from({ length: Math.max(0, Math.min(12, total - start)) }, (_, k) => summary(start + k + 1));
    return new Response(JSON.stringify({ data, meta: { page: { total, current: page, pageSize: 12, totalPages: Math.ceil(total / 12) } } }));
  });
  return { f, calls };
}

function renderPage(f: typeof fetch) {
  return render(
    <MemoryRouter initialEntries={['/maps']}>
      <Routes>
        <Route path="/maps" element={<MapsPage fetcher={f} />} />
        <Route path="/viewer/:id" element={<p>viewer page</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('MapsPage', () => {
  it('lists maps and loads more pages', async () => {
    const { f } = fakeApi(14);
    renderPage(f);
    expect(await screen.findByText('Map 1')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(12);
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('Map 14')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(14);
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });

  it('refetches when search, sort and permission filter change', async () => {
    const { f, calls } = fakeApi(3);
    renderPage(f);
    await screen.findByText('Map 1');
    fireEvent.change(screen.getByLabelText('Search maps'), { target: { value: 'tokyo' } });
    await waitFor(() => expect(calls.at(-1)).toContain('search=tokyo'));
    fireEvent.change(screen.getByLabelText('Sort'), { target: { value: 'title:ASC' } });
    await waitFor(() => expect(calls.at(-1)).toContain('order_by=title&order_direction=ASC'));
    fireEvent.change(screen.getByLabelText('Permissions'), { target: { value: 'public' } });
    await waitFor(() => expect(calls.at(-1)).toContain('privacy=public'));
  });

  it('shows the empty state and creates a first map', async () => {
    const { f, calls } = fakeApi(0);
    renderPage(f);
    fireEvent.click(await screen.findByRole('button', { name: 'Create your first map' }));
    expect(await screen.findByText('viewer page')).toBeInTheDocument();
    expect(calls).toContain('POST /api/workspace/maps');
  });

  it('shows API errors', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ error: 'boom' }), { status: 500 }));
    renderPage(f);
    expect(await screen.findByRole('alert')).toHaveTextContent('boom');
  });
});
```

- [ ] **Step 7: Run it to verify it fails**

Run: `cd web && npx vitest run src/pages/MapsPage.test.tsx`
Expected: FAIL with `Failed to resolve import "./MapsPage"`.

- [ ] **Step 8: Implement the page**

`web/src/pages/MapsPage.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import type { MapSummary } from '../lib/mapDoc';
import { createMap, listMaps, type ListMapsParams } from '../lib/workspaceApi';

type Sort = 'updated_at:DESC' | 'title:ASC';
type Permission = 'all' | 'shared' | 'public';

function query(page: number, search: string, sort: Sort, permission: Permission): ListMapsParams {
  const [orderBy, orderDirection] = sort.split(':') as [ListMapsParams['orderBy'], ListMapsParams['orderDirection']];
  return { page, pageSize: 12, search: search || undefined, orderBy, orderDirection, privacy: permission === 'all' ? undefined : permission };
}

export function MapsPage({ fetcher = fetch }: { fetcher?: typeof fetch }) {
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<Sort>('updated_at:DESC');
  const [permission, setPermission] = useState<Permission>('all');
  const [maps, setMaps] = useState<MapSummary[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(0);
  const [total, setTotal] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listMaps(query(1, search, sort, permission), fetcher).then(
      (res) => {
        if (cancelled) return;
        setMaps(res.data);
        setPage(1);
        setTotalPages(res.meta.page.totalPages);
        setTotal(res.meta.page.total);
        setError(null);
      },
      (e: Error) => !cancelled && setError(e.message),
    );
    return () => {
      cancelled = true;
    };
  }, [search, sort, permission, fetcher]);

  async function loadMore() {
    try {
      const res = await listMaps(query(page + 1, search, sort, permission), fetcher);
      setMaps((prev) => [...prev, ...res.data]);
      setPage(res.meta.page.current);
      setTotalPages(res.meta.page.totalPages);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function onCreate() {
    try {
      const m = await createMap({}, fetcher);
      navigate(`/viewer/${m.id}`);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const unfiltered = !search && permission === 'all';
  return (
    <main className="maps-page">
      <header>
        <h1>Maps</h1>
        <button onClick={onCreate}>New map</button>
      </header>
      <div className="toolbar">
        <input aria-label="Search maps" placeholder="Search" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select aria-label="Sort" value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
          <option value="updated_at:DESC">Last updated</option>
          <option value="title:ASC">A-Z</option>
        </select>
        <select aria-label="Permissions" value={permission} onChange={(e) => setPermission(e.target.value as Permission)}>
          <option value="all">All</option>
          <option value="shared">Shared</option>
          <option value="public">Public</option>
        </select>
      </div>
      {error && <p role="alert">{error}</p>}
      {total === 0 && unfiltered ? (
        <section className="empty">
          <p>You haven't created any maps yet</p>
          <button onClick={onCreate}>Create your first map</button>
        </section>
      ) : (
        <ul className="map-grid">
          {maps.map((m) => (
            <li key={m.id}>
              <MapCard map={m} />
            </li>
          ))}
        </ul>
      )}
      {page < totalPages && <button onClick={loadMore}>Load more</button>}
    </main>
  );
}

function MapCard({ map }: { map: MapSummary }) {
  return (
    <Link className="map-card" to={`/viewer/${map.id}`}>
      <div className="thumb" style={map.thumbnailUrl ? { backgroundImage: `url(${map.thumbnailUrl})` } : undefined} />
      <div className="meta">
        <strong>{map.title}</strong>
        <span className="badge">{map.privacy}</span>
      </div>
      <div className="meta">
        <small>Updated {new Date(map.updatedAt).toLocaleDateString()}</small>
      </div>
    </Link>
  );
}
```

Then wire the route in `web/src/App.tsx`: replace `<Route path="/maps" element={<p>Maps</p>} />` with `<Route path="/maps" element={<MapsPage />} />`, and add `import { MapsPage } from './pages/MapsPage';`.

- [ ] **Step 9: Run the tests to verify they pass**

Run: `cd web && npm test && npm run typecheck`
Expected: PASS, with no type errors.

- [ ] **Step 10: Commit**

```bash
git add web/src
git commit -m "feat(web): add maps list page with search, sort, filter and paging"
```

---
### Task 15: Read-only viewer (`/viewer/:id`, `/map/:id`)

**Files:**
- Create: `web/src/lib/layersFromDoc.ts`, `web/src/map/basemaps.ts`, `web/src/map/deckLayers.ts`, `web/src/pages/ViewerPage.tsx`
- Modify: `web/src/App.tsx` (the viewer routes)
- Test: `web/src/lib/layersFromDoc.test.ts`, `web/src/map/basemaps.test.ts`

**Interfaces:**
- Consumes: `KeplerMapConfig`, `DatasetDoc`, `LayerDoc` (Task 14), and `getMap`, `getDatasets`, `getPublicMap` (Task 14).
- Produces:
  - `layersFromDoc(doc: KeplerMapConfig, datasets: DatasetDoc[]): { layers: LayerDescriptor[]; warnings: string[] }` and `LayerDescriptor` (`kind: 'vector' | 'h3'`).
  - `basemapStyle(styleId?: string): string`, `toDeckLayer(d: LayerDescriptor)`.
  - `ViewerPage({ load })` with `loadPrivate` and `loadPublic`.

- [ ] **Step 1: Write the failing tests**

`web/src/lib/layersFromDoc.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { DatasetDoc, KeplerMapConfig, LayerDoc } from './mapDoc';
import { layersFromDoc } from './layersFromDoc';

const points: DatasetDoc = { id: 'p', type: 'table', connectionName: 'osm', source: 'osm_points', columns: ['name'] };
const hex: DatasetDoc = { id: 'h', type: 'query', connectionName: 'osm', source: 'SELECT h3 FROM osm_points', spatialIndex: 'h3', aggregationExp: 'count(*) AS n', aggregationResLevel: 5 };

const doc = (layers: LayerDoc[]): KeplerMapConfig => ({ version: 'v1', config: { mapState: { latitude: 0, longitude: 0, zoom: 1 }, visState: { layers } } });

describe('layersFromDoc', () => {
  it('maps tileset and h3 layers, top layer last for deck.gl', () => {
    const { layers, warnings } = layersFromDoc(
      doc([
        { id: 'top', type: 'h3', config: { dataId: 'h', color: [1, 2, 3], visConfig: { opacity: 0.5 } } },
        { id: 'bottom', type: 'tileset', config: { dataId: 'p', visConfig: { radius: 6, stroked: true, strokeColor: [9, 9, 9] } } },
      ]),
      [points, hex],
    );
    expect(warnings).toEqual([]);
    expect(layers.map((l) => l.id)).toEqual(['bottom', 'top']);
    expect(layers[0]).toMatchObject({
      kind: 'vector',
      source: { type: 'table', source: 'osm_points', spatialDataColumn: 'geom', columns: ['name'] },
      style: { fillColor: [18, 147, 154, 204], lineColor: [9, 9, 9, 255], stroked: true, pointRadius: 6 },
    });
    expect(layers[1]).toMatchObject({
      kind: 'h3',
      source: { type: 'query', spatialDataColumn: 'h3', aggregationExp: 'count(*) AS n', aggregationResLevel: 5 },
      style: { fillColor: [1, 2, 3, 128] },
    });
  });

  it('skips hidden layers and warns about missing datasets and unsupported types', () => {
    const { layers, warnings } = layersFromDoc(
      doc([
        { id: 'hidden', type: 'tileset', config: { dataId: 'p', isVisible: false } },
        { id: 'orphan', type: 'tileset', config: { dataId: 'nope' } },
        { id: 'heat', type: 'heatmapTile', config: { dataId: 'p' } },
        { id: 'mismatch', type: 'h3', config: { dataId: 'p' } },
      ]),
      [points],
    );
    expect(layers).toEqual([]);
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toContain('nope');
  });

  it('tolerates a document without visState', () => {
    expect(layersFromDoc({ version: 'v1', config: { mapState: { latitude: 0, longitude: 0, zoom: 1 } } }, [])).toEqual({ layers: [], warnings: [] });
  });
});
```

`web/src/map/basemaps.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { basemapStyle } from './basemaps';

describe('basemapStyle', () => {
  it('maps CARTO-style ids to OSM-based OpenFreeMap styles', () => {
    expect(basemapStyle('positron')).toBe('https://tiles.openfreemap.org/styles/positron');
    expect(basemapStyle('dark-matter')).toBe('https://tiles.openfreemap.org/styles/dark');
    expect(basemapStyle('voyager')).toBe('https://tiles.openfreemap.org/styles/liberty');
  });
  it('falls back to positron for unknown or Google ids', () => {
    expect(basemapStyle(undefined)).toBe(basemapStyle('positron'));
    expect(basemapStyle('google-roadmap')).toBe(basemapStyle('positron'));
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd web && npx vitest run src/lib/layersFromDoc.test.ts src/map/basemaps.test.ts`
Expected: FAIL with unresolved imports.

- [ ] **Step 3: Implement the pure mappings**

`web/src/lib/layersFromDoc.ts`:

```ts
import type { DatasetDoc, KeplerMapConfig, LayerDoc, RGB } from './mapDoc';

export type RGBA = [number, number, number, number];

export interface LayerStyle {
  fillColor: RGBA;
  lineColor: RGBA;
  filled: boolean;
  stroked: boolean;
  pointRadius: number;
  lineWidth: number;
}

export interface SourceArgs {
  type: 'table' | 'query';
  source: string;
  spatialDataColumn: string;
  columns?: string[];
  queryParameters?: Record<string, unknown>;
}

export type LayerDescriptor =
  | { kind: 'vector'; id: string; source: SourceArgs; style: LayerStyle }
  | { kind: 'h3'; id: string; source: SourceArgs & { aggregationExp: string; aggregationResLevel: number }; style: LayerStyle };

export const DEFAULT_COLOR: RGB = [18, 147, 154];
const DEFAULT_OPACITY = 0.8;

// M1 subset: tileset (vector) and h3 layers with a single colour (spec §4.4).
export function layersFromDoc(doc: KeplerMapConfig, datasets: DatasetDoc[]): { layers: LayerDescriptor[]; warnings: string[] } {
  const byId = new Map(datasets.map((d) => [d.id, d]));
  const layers: LayerDescriptor[] = [];
  const warnings: string[] = [];
  for (const layer of doc.config.visState?.layers ?? []) {
    if (layer.config.isVisible === false) continue;
    const ds = byId.get(layer.config.dataId);
    if (!ds) {
      warnings.push(`layer ${layer.id}: dataset ${layer.config.dataId} not found`);
      continue;
    }
    const isH3 = ds.spatialIndex === 'h3';
    const source: SourceArgs = {
      type: ds.type,
      source: ds.source,
      spatialDataColumn: ds.geoColumn ?? (isH3 ? 'h3' : 'geom'),
      ...(ds.columns?.length ? { columns: ds.columns } : {}),
      ...(ds.queryParameters ? { queryParameters: ds.queryParameters } : {}),
    };
    const style = styleOf(layer);
    if (layer.type === 'tileset' && !isH3) {
      layers.push({ kind: 'vector', id: layer.id, source, style });
    } else if (layer.type === 'h3' && isH3) {
      layers.push({
        kind: 'h3',
        id: layer.id,
        source: { ...source, aggregationExp: ds.aggregationExp ?? '1 AS __aggregationValue', aggregationResLevel: ds.aggregationResLevel ?? 4 },
        style,
      });
    } else {
      warnings.push(`layer ${layer.id}: type ${layer.type} over a ${isH3 ? 'h3' : 'geo'} dataset is not supported yet`);
    }
  }
  // kepler lists the top layer first; deck.gl draws later layers on top
  return { layers: layers.reverse(), warnings };
}

function styleOf(layer: LayerDoc): LayerStyle {
  const vis = layer.config.visConfig ?? {};
  const [r, g, b] = layer.config.color ?? DEFAULT_COLOR;
  const [sr, sg, sb] = vis.strokeColor ?? [r, g, b];
  return {
    fillColor: [r, g, b, Math.round((vis.opacity ?? DEFAULT_OPACITY) * 255)],
    lineColor: [sr, sg, sb, 255],
    filled: vis.filled ?? true,
    stroked: vis.stroked ?? false,
    pointRadius: vis.radius ?? 4,
    lineWidth: vis.thickness ?? 1,
  };
}
```

`web/src/map/basemaps.ts`:

```ts
// OSM-derived basemaps (OpenFreeMap, no key). Keys mirror the styleIds stored in map documents (ledger D11).
const BASEMAPS: Record<string, string> = {
  positron: 'https://tiles.openfreemap.org/styles/positron',
  'dark-matter': 'https://tiles.openfreemap.org/styles/dark',
  voyager: 'https://tiles.openfreemap.org/styles/liberty',
};

export const OSM_ATTRIBUTION = '© OpenStreetMap contributors';

export function basemapStyle(styleId?: string): string {
  return BASEMAPS[styleId ?? ''] ?? BASEMAPS.positron;
}
```

- [ ] **Step 4: Run them to verify they pass**

Run: `cd web && npx vitest run src/lib/layersFromDoc.test.ts src/map/basemaps.test.ts`
Expected: PASS.

- [ ] **Step 5: Implement the deck.gl adapter and the page**

`web/src/map/deckLayers.ts`:

```ts
import { h3QuerySource, h3TableSource, vectorQuerySource, vectorTableSource } from '@carto/api-client';
import { H3TileLayer, VectorTileLayer } from '@deck.gl/carto';
import type { LayerDescriptor } from '../lib/layersFromDoc';

// M1 dev auth ignores the token. M3 switches to authMode: 'session' (same-origin cookie, ledger A8).
const DEV_TOKEN = 'dev';

function common() {
  return { apiBaseUrl: window.location.origin, connectionName: 'osm', accessToken: DEV_TOKEN };
}

// worker: false keeps loaders in-page instead of fetching worker scripts from a CDN.
const loadOptions = { worker: false };

export function toDeckLayer(d: LayerDescriptor) {
  const { source: s, style } = d;
  const params = { spatialDataColumn: s.spatialDataColumn, ...(s.columns ? { columns: s.columns } : {}) };
  if (d.kind === 'vector') {
    const data =
      s.type === 'table'
        ? vectorTableSource({ ...common(), ...params, tableName: s.source })
        : vectorQuerySource({ ...common(), ...params, sqlQuery: s.source, queryParameters: s.queryParameters });
    return new VectorTileLayer({
      id: d.id, data, loadOptions, pickable: true,
      filled: style.filled, stroked: style.stroked,
      getFillColor: style.fillColor, getLineColor: style.lineColor,
      pointRadiusMinPixels: style.pointRadius, lineWidthMinPixels: style.lineWidth,
    });
  }
  const agg = { aggregationExp: d.source.aggregationExp, aggregationResLevel: d.source.aggregationResLevel };
  const data =
    s.type === 'table'
      ? h3TableSource({ ...common(), ...params, ...agg, tableName: s.source })
      : h3QuerySource({ ...common(), ...params, ...agg, sqlQuery: s.source, queryParameters: s.queryParameters });
  return new H3TileLayer({
    id: d.id, data, loadOptions, pickable: true,
    filled: style.filled, stroked: style.stroked,
    getFillColor: style.fillColor, getLineColor: style.lineColor, lineWidthMinPixels: style.lineWidth,
  });
}
```

`web/src/pages/ViewerPage.tsx`:

```tsx
import { MapboxOverlay } from '@deck.gl/mapbox';
import maplibregl from 'maplibre-gl';
import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router';
import { layersFromDoc } from '../lib/layersFromDoc';
import type { DatasetDoc, MapDoc } from '../lib/mapDoc';
import { getDatasets, getMap, getPublicMap } from '../lib/workspaceApi';
import { basemapStyle, OSM_ATTRIBUTION } from '../map/basemaps';
import { toDeckLayer } from '../map/deckLayers';

type Loaded = { doc: MapDoc; datasets: DatasetDoc[] };

export async function loadPrivate(id: string): Promise<Loaded> {
  const [doc, datasets] = await Promise.all([getMap(id), getDatasets(id)]);
  return { doc, datasets };
}

export async function loadPublic(id: string): Promise<Loaded> {
  const { datasets, ...doc } = await getPublicMap(id);
  return { doc, datasets };
}

export function ViewerPage({ load }: { load: (id: string) => Promise<Loaded> }) {
  const { id = '' } = useParams();
  const container = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    load(id).then(setState, (e: Error) => setError(e.message));
  }, [id, load]);

  useEffect(() => {
    if (!state || !container.current) return;
    const { mapState, basemapConfig } = state.doc.keplerMapConfig.config;
    const map = new maplibregl.Map({
      container: container.current,
      style: basemapStyle(basemapConfig?.styleId),
      center: [mapState.longitude, mapState.latitude],
      zoom: mapState.zoom,
      pitch: mapState.pitch ?? 0,
      bearing: mapState.bearing ?? 0,
      attributionControl: { compact: false, customAttribution: OSM_ATTRIBUTION },
    });
    const { layers, warnings } = layersFromDoc(state.doc.keplerMapConfig, state.datasets);
    warnings.forEach((w) => console.warn('[viewer]', w));
    map.addControl(new MapboxOverlay({ layers: layers.map(toDeckLayer) }));
    return () => map.remove();
  }, [state]);

  if (error) return <p role="alert">{error}</p>;
  return (
    <div className="viewer">
      <header>
        <h1>{state?.doc.title ?? 'Loading…'}</h1>
      </header>
      <div ref={container} className="viewer-map" />
    </div>
  );
}
```

Replace the viewer placeholders in `web/src/App.tsx` so the file reads:

```tsx
import { Navigate, Route, Routes } from 'react-router';
import { MapsPage } from './pages/MapsPage';
import { loadPrivate, loadPublic, ViewerPage } from './pages/ViewerPage';

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/maps" replace />} />
      <Route path="/maps" element={<MapsPage />} />
      <Route path="/viewer/:id" element={<ViewerPage load={loadPrivate} />} />
      <Route path="/map/:id" element={<ViewerPage load={loadPublic} />} />
    </Routes>
  );
}
```

- [ ] **Step 6: Run the unit tests, typecheck and build**

Run: `cd web && npm test && npm run build`
Expected: all unit tests PASS, with no type errors, and `web/dist/` is produced.

If `tsc` rejects an option name on `vectorTableSource` / `h3QuerySource` / the layers, use the names from `node_modules/@carto/api-client/build/*.d.ts` and `node_modules/@deck.gl/carto/dist/*.d.ts`. The contract test in Task 13 already passes these names at runtime.

- [ ] **Step 7: Manual end-to-end check in a browser**

```bash
# terminal 1 — data + server (Tokyo demo grid; or use osm-ingest with an extract)
cd server && go run ./cmd/seed -out /tmp/osm-maps-data.duckdb
go run ./cmd/mapsd -data /tmp/osm-maps-data.duckdb -meta /tmp/osm-maps-meta.duckdb
# terminal 2 — web
cd web && npm run dev
# terminal 3 — create a map with a vector layer and an H3 layer
ID=$(curl -s -X POST localhost:8080/api/workspace/maps -H 'content-type: application/json' -d '{
  "title": "Tokyo demo",
  "keplerMapConfig": {"version": "v1", "config": {
    "mapState": {"latitude": 35.7, "longitude": 139.75, "zoom": 12},
    "basemapConfig": {"styleId": "positron"},
    "visState": {"layers": [
      {"id": "pts", "type": "tileset", "config": {"dataId": "ds-points", "color": [230, 80, 60], "visConfig": {"opacity": 0.9, "radius": 4}}},
      {"id": "hex", "type": "h3", "config": {"dataId": "ds-h3", "color": [40, 120, 200], "visConfig": {"opacity": 0.4}}}
    ]}}}}' | sed -E 's/.*"id":"([^"]+)".*/\1/')
curl -s -X POST localhost:8080/api/workspace/maps/$ID/datasets -H 'content-type: application/json' \
  -d '{"id":"ds-points","type":"table","connectionName":"osm","source":"demo_points","columns":["name","value"]}'
curl -s -X POST localhost:8080/api/workspace/maps/$ID/datasets -H 'content-type: application/json' \
  -d '{"id":"ds-h3","type":"query","connectionName":"osm","source":"SELECT h3, value FROM demo_points","spatialIndex":"h3","aggregationExp":"sum(value) AS value_sum","aggregationResLevel":4}'
echo "open http://localhost:5173/viewer/$ID"
```

Expected:
- `http://localhost:5173/maps` shows a "Tokyo demo" card.
- Opening it shows the positron OSM basemap with "© OpenStreetMap contributors", red points on a 20×20 grid, and translucent blue H3 hexagons under them.
- The browser network tab shows `/v3/maps/osm/table?...` → `format=tilejson` → `.../{z}/{x}/{y}` MVT requests and `.../8a…` H3 cell requests, all 200 or 204.

If the H3 layer is missing while its tiles return 200, ledger U2 is the likely cause (the client expects a different cell resolution). Compare the tile cell resolution with `maxresolution` in the TileJSON, and record the outcome in the ledger.

- [ ] **Step 8: Commit**

```bash
git add web/src
git commit -m "feat(web): render map documents with deck.gl carto layers over osm basemap"
```

---

## After M1

Write the M2 plan (Builder: styling, widgets + `/v3/sql/{conn}/model/*`, filters UI, SQL parameters, popups, legends, geocoder) once these M1 exit criteria hold (spec §5):
- The contract test passes.
- The manual check in Task 15 renders both layers.
- `go test ./... -race` and `npm test` are green.
