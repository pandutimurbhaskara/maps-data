package catalog_test

import (
	"context"
	"testing"

	"osm-maps/server/internal/catalog"
	"osm-maps/server/internal/testdb"
)

func TestList(t *testing.T) {
	res, err := catalog.List(context.Background(), testdb.Data(t))
	if err != nil {
		t.Fatal(err)
	}
	if len(res) != 1 || res[0].Name != "demo_points" || res[0].GeoColumn != "geom" || res[0].H3Column != "h3" {
		t.Fatalf("resources = %+v", res)
	}
	types := map[string]string{}
	for _, c := range res[0].Columns {
		types[c.Name] = c.Type
	}
	if types["value"] != "number" || types["category"] != "string" || types["ts"] != "timestamp" {
		t.Fatalf("columns = %+v", res[0].Columns)
	}
}
