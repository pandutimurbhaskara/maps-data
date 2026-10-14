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
