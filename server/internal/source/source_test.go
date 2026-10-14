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
		"query plus filter": {func() source.Source {
			s := q("SELECT * FROM demo_points", nil)
			s.Filters = filters(t, `{"category":{"in":{"values":["shop"]}}}`)
			return s
		}(), 100},
	} {
		t.Run(name, func(t *testing.T) {
			if got := count(t, db, tc.src); got != tc.want {
				t.Fatalf("count = %d, want %d", got, tc.want)
			}
		})
	}
}

const westHalf = `{"type":"Polygon","coordinates":[[[139.69,35.64],[139.7475,35.64],[139.7475,35.76],[139.69,35.76],[139.69,35.64]]]}`

func TestSpatialFilter(t *testing.T) {
	db := testdb.Data(t)
	geo := table(nil)
	geo.SpatialFilter = json.RawMessage(westHalf)
	if got := count(t, db, geo); got != 200 {
		t.Fatalf("geo spatial filter = %d, want 200", got)
	}
	h3 := source.Source{Type: source.TypeTable, Name: "demo_points", SpatialDataType: source.H3, SpatialFilter: json.RawMessage(westHalf)}
	if got := count(t, db, h3); got != 200 {
		t.Fatalf("h3 spatial filter = %d, want 200", got)
	}
	// the spatial clause is ANDed even when column filters are ORed
	or := table(filters(t, `{"category":{"in":{"values":["cafe"]}},"id":{"in":{"values":[1]}}}`))
	or.FiltersOr, or.SpatialFilter = true, json.RawMessage(westHalf)
	if got := count(t, db, or); got != 61 { // 60 cafes in the west half (j = 0, 4, 8 on 20 rows) + id 1
		t.Fatalf("or + spatial = %d, want 61", got)
	}
	bad := table(nil)
	bad.SpatialFilter = json.RawMessage(`[1,2]`)
	if _, _, err := bad.Relation(); !errors.Is(err, source.ErrBadRequest) {
		t.Fatalf("bad geojson err = %v", err)
	}
}
