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
