package mapsapi_test

import (
	"encoding/json"
	"net/url"
	"testing"
)

func TestStatsEndpoints(t *testing.T) {
	srv, _ := newServer(t, 1000)
	var s struct {
		Attribute  string               `json:"attribute"`
		Type       string               `json:"type"`
		Min        *float64             `json:"min"`
		Max        *float64             `json:"max"`
		Quantiles  map[string][]float64 `json:"quantiles"`
		Categories []struct {
			Category  string `json:"category"`
			Frequency int    `json:"frequency"`
		} `json:"categories"`
	}
	res, body := get(t, srv.URL+"/v3/stats/osm/demo_points/value")
	if err := json.Unmarshal(body, &s); err != nil || res.StatusCode != 200 || s.Attribute != "value" || len(s.Quantiles["3"]) != 4 {
		t.Fatalf("table stats: %d %s", res.StatusCode, body)
	}
	q := url.Values{"q": {`SELECT category AS "kind of place", geom FROM demo_points WHERE value >= $min`}, "queryParameters": {`{"min":200}`}, "maxNumberOfCategories": {"2"}}
	res, body = get(t, srv.URL+"/v3/stats/osm/kind%20of%20place?"+q.Encode())
	s.Categories = nil
	if err := json.Unmarshal(body, &s); err != nil || res.StatusCode != 200 || len(s.Categories) != 2 || s.Categories[0].Frequency != 50 {
		t.Fatalf("query stats with a quoted column name: %d %s", res.StatusCode, body)
	}
	for path, want := range map[string]int{
		"/v3/stats/osm/demo_points/nope":                           400,
		"/v3/stats/nope/demo_points/value":                         404,
		"/v3/stats/osm/value?q=" + url.QueryEscape("DROP TABLE x"): 400,
	} {
		if res, _ := get(t, srv.URL+path); res.StatusCode != want {
			t.Errorf("%s: %d, want %d", path, res.StatusCode, want)
		}
	}
}
