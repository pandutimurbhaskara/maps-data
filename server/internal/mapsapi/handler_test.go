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

func TestSpatialFiltersParam(t *testing.T) {
	srv, _ := newServer(t, 1000)
	sf := `{"geom":{"type":"Polygon","coordinates":[[[139.69,35.64],[139.7475,35.64],[139.7475,35.76],[139.69,35.76],[139.69,35.64]]]}}`
	tj := instantiate(t, srv, "table", url.Values{"name": {"demo_points"}, "spatialFilters": {sf}})
	if tj.Tilestats.Layers[0].Count != 200 {
		t.Fatalf("count = %d, want 200", tj.Tilestats.Layers[0].Count)
	}
}
