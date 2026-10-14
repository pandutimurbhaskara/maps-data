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
