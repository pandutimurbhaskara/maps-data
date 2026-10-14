package workspace_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"osm-maps/server/internal/auth"
	"osm-maps/server/internal/store"
	"osm-maps/server/internal/workspace"
)

type env struct {
	srv   *httptest.Server
	store *store.DuckStore
}

func newEnv(t *testing.T) env {
	t.Helper()
	st, err := store.OpenDuck(context.Background(), filepath.Join(t.TempDir(), "meta.duckdb"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	mux := http.NewServeMux()
	(&workspace.Handler{Store: st, Connections: []workspace.Connection{{Name: "osm", Provider: "duckdb"}}}).Register(mux, "/api/workspace")
	// Tests pick the user per request with X-Test-User; production uses auth.Dev (M1) or sessions (M3).
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mux.ServeHTTP(w, r.WithContext(auth.WithUser(r.Context(), r.Header.Get("X-Test-User"))))
	})
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return env{srv: srv, store: st}
}

func (e env) do(t *testing.T, user, method, path string, body any) (int, map[string]any) {
	t.Helper()
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, e.srv.URL+path, rd)
	req.Header.Set("X-Test-User", user)
	req.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	var out map[string]any
	if len(raw) > 0 && raw[0] == '{' {
		_ = json.Unmarshal(raw, &out)
	} else if len(raw) > 0 && raw[0] == '[' {
		var arr []any
		_ = json.Unmarshal(raw, &arr)
		out = map[string]any{"items": arr}
	}
	return res.StatusCode, out
}

func TestMapsLifecycle(t *testing.T) {
	e := newEnv(t)
	status, m := e.do(t, "alice", "POST", "/api/workspace/maps", map[string]any{})
	if status != 201 || m["title"] != "Untitled map" || m["privacy"] != "private" {
		t.Fatalf("create: %d %v", status, m)
	}
	cfg := m["keplerMapConfig"].(map[string]any)
	if cfg["version"] != "v1" {
		t.Fatalf("default config = %v", cfg)
	}
	id := m["id"].(string)

	status, list := e.do(t, "alice", "GET", "/api/workspace/maps?page=1&page_size=12&order_by=updated_at&order_direction=DESC", nil)
	data := list["data"].([]any)
	page := list["meta"].(map[string]any)["page"].(map[string]any)
	if status != 200 || len(data) != 1 || page["total"].(float64) != 1 || page["totalPages"].(float64) != 1 {
		t.Fatalf("list: %d %v", status, list)
	}
	if _, has := data[0].(map[string]any)["keplerMapConfig"]; has {
		t.Fatal("list items must not include keplerMapConfig")
	}

	if status, m = e.do(t, "alice", "PATCH", "/api/workspace/maps/"+id, map[string]any{"title": "Tokyo POIs"}); status != 200 || m["title"] != "Tokyo POIs" {
		t.Fatalf("patch: %d %v", status, m)
	}
	// Review fix: a null keplerMapConfig means "unchanged", never "erase the document".
	if status, m = e.do(t, "alice", "PATCH", "/api/workspace/maps/"+id, map[string]any{"keplerMapConfig": nil}); status != 200 || m["keplerMapConfig"] == nil {
		t.Fatalf("patch null config: %d %v", status, m)
	}
	if status, _ = e.do(t, "alice", "PATCH", "/api/workspace/maps/"+id, map[string]any{"title": ""}); status != 400 {
		t.Fatalf("empty title: %d", status)
	}
	if status, _ = e.do(t, "bob", "GET", "/api/workspace/maps/"+id, nil); status != 404 {
		t.Fatalf("other user reads private map: %d, want 404", status)
	}
	if status, _ = e.do(t, "bob", "DELETE", "/api/workspace/maps/"+id, nil); status != 404 {
		t.Fatalf("other user deletes private map: %d, want 404", status)
	}
	if status, _ = e.do(t, "", "GET", "/api/workspace/maps", nil); status != 401 {
		t.Fatalf("anonymous list: %d, want 401", status)
	}
	if status, _ = e.do(t, "alice", "GET", "/api/workspace/maps?order_by=views", nil); status != 400 {
		t.Fatalf("bad order_by: %d, want 400", status)
	}
	if status, _ = e.do(t, "alice", "DELETE", "/api/workspace/maps/"+id, nil); status != 204 {
		t.Fatalf("delete: %d", status)
	}
}

func TestDatasetsAndPublicMap(t *testing.T) {
	e := newEnv(t)
	_, m := e.do(t, "alice", "POST", "/api/workspace/maps", map[string]any{"title": "Public demo"})
	id := m["id"].(string)
	base := "/api/workspace/maps/" + id + "/datasets"

	status, ds := e.do(t, "alice", "POST", base, map[string]any{"type": "table", "connectionName": "osm", "source": "demo_points", "label": "Points"})
	if status != 201 || ds["id"] == nil {
		t.Fatalf("create dataset: %d %v", status, ds)
	}
	dsID := ds["id"].(string)
	for name, body := range map[string]map[string]any{
		"bad type":       {"type": "tileset", "connectionName": "osm", "source": "x"},
		"bad connection": {"type": "table", "connectionName": "bigquery", "source": "x"},
		"empty source":   {"type": "query", "connectionName": "osm", "source": ""},
	} {
		if status, _ := e.do(t, "alice", "POST", base, body); status != 400 {
			t.Errorf("%s: %d, want 400", name, status)
		}
	}
	if status, ds = e.do(t, "alice", "PATCH", base+"/"+dsID, map[string]any{"label": "Renamed"}); status != 200 || ds["label"] != "Renamed" || ds["source"] != "demo_points" {
		t.Fatalf("patch dataset: %d %v", status, ds)
	}
	if status, _ = e.do(t, "bob", "POST", base, map[string]any{"type": "table", "connectionName": "osm", "source": "x"}); status != 404 {
		t.Fatalf("other user adds dataset: %d, want 404", status)
	}

	if status, _ = e.do(t, "", "GET", "/v3/maps/public/"+id, nil); status != 404 {
		t.Fatalf("public endpoint on private map: %d, want 404", status)
	}
	if _, err := e.store.UpdateMap(context.Background(), id, store.MapPatch{Privacy: ptr("public")}); err != nil {
		t.Fatal(err)
	}
	status, pub := e.do(t, "", "GET", "/v3/maps/public/"+id, nil)
	if status != 200 || pub["title"] != "Public demo" || len(pub["datasets"].([]any)) != 1 || pub["keplerMapConfig"] == nil {
		t.Fatalf("public map: %d %v", status, pub)
	}
	if status, _ = e.do(t, "alice", "DELETE", base+"/"+dsID, nil); status != 204 {
		t.Fatalf("delete dataset: %d", status)
	}
	if status, conns := e.do(t, "alice", "GET", "/api/workspace/connections", nil); status != 200 || len(conns["items"].([]any)) != 1 {
		t.Fatalf("connections: %d %v", status, conns)
	}
}

func ptr[T any](v T) *T { return &v }
