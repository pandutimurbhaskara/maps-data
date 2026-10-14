package modelapi_test

import (
	"database/sql"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"osm-maps/server/internal/modelapi"
	"osm-maps/server/internal/testdb"
)

const westHalf = `{"geom":{"type":"Polygon","coordinates":[[[139.69,35.64],[139.7475,35.64],[139.7475,35.76],[139.69,35.76],[139.69,35.64]]]}}`

func newServer(t *testing.T) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	(&modelapi.Server{Conns: map[string]*sql.DB{"osm": testdb.Data(t)}, QueryTimeout: 10 * time.Second}).Register(mux)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

type result struct {
	Rows     []map[string]any `json:"rows"`
	Metadata map[string]any   `json:"metadata"`
	Error    string           `json:"error"`
}

// call runs a model on demo_points (or on extra["source"] when given) and decodes the response.
func call(t *testing.T, srv *httptest.Server, model, params string, extra url.Values) (int, result) {
	t.Helper()
	v := url.Values{"type": {"table"}, "source": {"demo_points"}, "params": {params}, "client": {"test"}}
	for k, vs := range extra {
		v[k] = vs
	}
	res, err := http.Get(srv.URL + "/v3/sql/osm/model/" + model + "?" + v.Encode())
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(res.Body)
	var r result
	if err := json.Unmarshal(body, &r); err != nil {
		t.Fatalf("%s: %s", model, body)
	}
	return res.StatusCode, r
}

func TestFormula(t *testing.T) {
	srv := newServer(t)
	for name, tc := range map[string]struct {
		params string
		extra  url.Values
		want   float64
	}{
		"count":         {`{"column":"*","operation":"count"}`, nil, 400},
		"sum":           {`{"column":"value","operation":"sum"}`, nil, 79800},
		"avg filtered":  {`{"column":"value","operation":"avg"}`, url.Values{"filters": {`{"category":{"in":{"values":["cafe"]}}}`}}, 198},
		"viewport":      {`{"column":"*","operation":"count"}`, url.Values{"spatialFilters": {westHalf}}, 200},
		"custom":        {`{"operation":"custom","operationExp":"max(value) - min(value)"}`, nil, 399},
		"quoted column": {`{"column":"it's","operation":"count"}`, url.Values{"type": {"query"}, "source": {`SELECT name AS "it's", geom FROM demo_points`}}, 400},
	} {
		status, r := call(t, srv, "formula", tc.params, tc.extra)
		if status != 200 || len(r.Rows) != 1 || r.Rows[0]["value"] != tc.want {
			t.Errorf("%s: %d %+v, want value %v", name, status, r, tc.want)
		}
	}
	for name, params := range map[string]string{
		"injected custom": `{"operation":"custom","operationExp":"1; DROP TABLE demo_points"}`,
		"unknown column":  `{"column":"nope","operation":"sum"}`,
		"bad operation":   `{"column":"value","operation":"median"}`,
	} {
		if status, r := call(t, srv, "formula", params, nil); status != 400 || r.Error == "" {
			t.Errorf("%s: %d %+v, want 400", name, status, r)
		}
	}
	if status, _ := call(t, srv, "pick", `{}`, nil); status != 400 {
		t.Errorf("unsupported model: %d, want 400", status)
	}
}

func TestRange(t *testing.T) {
	status, r := call(t, newServer(t), "range", `{"column":"value"}`, nil)
	if status != 200 || r.Rows[0]["min"] != 0.0 || r.Rows[0]["max"] != 399.0 {
		t.Fatalf("range: %d %+v", status, r)
	}
}

func TestCategory(t *testing.T) {
	srv := newServer(t)
	status, r := call(t, srv, "category", `{"column":"category","operation":"count"}`, nil)
	if status != 200 || len(r.Rows) != 4 || r.Rows[0]["name"] != "cafe" || r.Rows[0]["value"] != 100.0 {
		t.Fatalf("count: %d %+v", status, r)
	}
	_, r = call(t, srv, "category", `{"column":"category","operation":"count","othersThreshold":2}`, nil)
	if len(r.Rows) != 2 || r.Metadata["others"] != 200.0 {
		t.Fatalf("others: %+v", r)
	}
	_, r = call(t, srv, "category", `{"column":"category","operation":"count","orderBy":"alphabetical_desc"}`, nil)
	if r.Rows[0]["name"] != "shop" {
		t.Fatalf("alphabetical_desc first = %v", r.Rows[0]["name"])
	}
	_, r = call(t, srv, "category", `{"column":"category","operation":"sum","operationColumn":"value"}`, nil)
	if r.Rows[0]["name"] != "school" || r.Rows[0]["value"] != 20100.0 {
		t.Fatalf("sum by category first = %+v", r.Rows[0])
	}
}

func TestHistogram(t *testing.T) {
	status, r := call(t, newServer(t), "histogram", `{"column":"value","operation":"count","ticks":[100,200,300]}`, nil)
	if status != 200 || len(r.Rows) != 4 {
		t.Fatalf("histogram: %d %+v", status, r)
	}
	for i, row := range r.Rows {
		if row["tick"] != float64(i) || row["value"] != 100.0 {
			t.Fatalf("bucket %d = %+v", i, row)
		}
	}
	if status, _ := call(t, newServer(t), "histogram", `{"column":"value","ticks":[]}`, nil); status != 400 {
		t.Fatalf("empty ticks: %d, want 400", status)
	}
}

func TestTable(t *testing.T) {
	srv := newServer(t)
	status, r := call(t, srv, "table", `{"column":["id","name","geom"],"sortBy":"id","sortDirection":"desc","limit":3,"offset":1}`, nil)
	if status != 200 || len(r.Rows) != 3 || r.Rows[0]["id"] != 398.0 || r.Metadata["total"] != 400.0 {
		t.Fatalf("table: %d %+v", status, r)
	}
	if wkt, _ := r.Rows[0]["geom"].(string); len(wkt) < 5 || wkt[:5] != "POINT" {
		t.Fatalf("geom = %v, want WKT", r.Rows[0]["geom"])
	}
	if status, _ := call(t, srv, "table", `{"column":["id"],"limit":5000}`, nil); status != 400 {
		t.Fatalf("limit too large: %d, want 400", status)
	}
}

func TestTimeSeries(t *testing.T) {
	srv := newServer(t)
	status, r := call(t, srv, "timeseries", `{"column":"ts","stepSize":"day","operation":"count"}`, nil)
	if status != 200 || len(r.Rows) != 17 || r.Rows[0]["name"] != 1767225600000.0 || r.Rows[0]["value"] != 24.0 || r.Rows[16]["value"] != 16.0 {
		t.Fatalf("timeseries: %d %+v", status, r)
	}
	if _, ok := r.Metadata["categories"]; !ok {
		t.Fatal("metadata.categories missing")
	}
	// 100-hour buckets are anchored at DuckDB's time_bucket origin (2000-01-03), not at the data start,
	// so assert on the total rather than on bucket boundaries.
	_, r = call(t, srv, "timeseries", `{"column":"ts","stepSize":"hour","stepMultiplier":100,"operation":"sum","operationColumn":"value"}`, nil)
	sum := 0.0
	for _, row := range r.Rows {
		sum += row["value"].(float64)
	}
	if len(r.Rows) < 4 || sum != 79800 {
		t.Fatalf("100-hour buckets: %+v", r.Rows)
	}
	for name, params := range map[string]string{
		"split":     `{"column":"ts","stepSize":"day","splitByCategory":"category"}`,
		"bad step":  `{"column":"ts","stepSize":"fortnight"}`,
		"bad multi": `{"column":"ts","stepSize":"day","stepMultiplier":-2}`,
	} {
		if status, _ := call(t, srv, "timeseries", params, nil); status != 400 {
			t.Errorf("%s: %d, want 400", name, status)
		}
	}
}
