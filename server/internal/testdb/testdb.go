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
