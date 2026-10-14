package geocode_test

import (
	"database/sql"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"

	"osm-maps/server/internal/geocode"
	"osm-maps/server/internal/testdb"
)

func search(t *testing.T, db *sql.DB, v url.Values) (int, []geocode.Place) {
	t.Helper()
	mux := http.NewServeMux()
	(&geocode.Handler{DB: db}).Register(mux)
	srv := httptest.NewServer(mux)
	defer srv.Close()
	res, err := http.Get(srv.URL + "/v3/lds/geocoding/geocode?" + v.Encode())
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(res.Body)
	var out struct {
		Rows []geocode.Place `json:"rows"`
	}
	_ = json.Unmarshal(body, &out)
	return res.StatusCode, out.Rows
}

func TestGeocode(t *testing.T) {
	db := testdb.Data(t)
	if status, rows := search(t, db, url.Values{"address": {"東京"}}); status != 200 || len(rows) != 1 || rows[0].Name != "東京駅" || rows[0].Longitude != 139.70 {
		t.Fatalf("unicode: %d %+v", status, rows)
	}
	status, rows := search(t, db, url.Values{"address": {"POI-1"}, "limit": {"3"}})
	if status != 200 || len(rows) != 3 || rows[0].Name != "poi-1" || rows[1].Name != "poi-10" || rows[0].Kind != "shop" {
		t.Fatalf("ranking: %d %+v", status, rows)
	}
	if status, rows := search(t, db, url.Values{"address": {"no-such-place"}}); status != 200 || rows == nil || len(rows) != 0 {
		t.Fatalf("no match: %d %#v", status, rows)
	}
	if status, _ := search(t, db, url.Values{"address": {"  "}}); status != 400 {
		t.Fatalf("empty address: %d, want 400", status)
	}
	if status, _ := search(t, db, url.Values{"address": {"poi"}, "limit": {"50"}}); status != 400 {
		t.Fatalf("limit too large: %d, want 400", status)
	}
}
