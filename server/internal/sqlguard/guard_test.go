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
		// Review fix: catalog/introspection functions expose server paths and settings.
		"SELECT * FROM duckdb_databases()",
		"SELECT ST_Point(0, 0) AS geom, (SELECT string_agg(install_path, ',') FROM duckdb_extensions()) AS p",
		"SELECT current_setting('home_directory')",
		"SELECT * FROM pragma_database_list",
	} {
		if err := sqlguard.ValidateSelect(ctx, db, q); !errors.Is(err, sqlguard.ErrNotSelect) {
			t.Errorf("ValidateSelect(%q) = %v, want ErrNotSelect", q, err)
		}
	}
}
