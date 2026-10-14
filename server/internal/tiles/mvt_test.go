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

// Review fix: column names come from user SQL and may contain quotes; they must not break (or inject into) the MVT query.
func TestMVTQuotedColumnName(t *testing.T) {
	db := testdb.Data(t)
	rel, args, err := source.Source{Type: source.TypeQuery, Query: `SELECT name AS "it's ""q""", geom FROM demo_points`, SpatialDataType: source.Geo}.Relation()
	if err != nil {
		t.Fatal(err)
	}
	b, err := tiles.MVT(context.Background(), db, tiles.MVTRequest{
		Relation: rel, Args: args, GeomColumn: `"geom"`, Props: []describe.Column{{Name: `it's "q"`, Type: "string"}}, MaxFeatures: 1000,
	})
	if err != nil {
		t.Fatal(err)
	}
	layers, err := mvt.Unmarshal(b)
	if err != nil {
		t.Fatal(err)
	}
	if got := layers[0].Features[0].Properties[`it's "q"`]; got == nil {
		t.Fatalf("property missing; props = %v", layers[0].Features[0].Properties)
	}
}
