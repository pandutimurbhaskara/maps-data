package main

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"osm-maps/server/internal/duck"
	"osm-maps/server/internal/seed"
)

func TestServerWiring(t *testing.T) {
	dir := t.TempDir()
	data := filepath.Join(dir, "data.duckdb")
	rw, err := duck.Open(duck.Options{Path: data})
	if err != nil {
		t.Fatal(err)
	}
	if err := seed.Demo(context.Background(), rw); err != nil {
		t.Fatal(err)
	}
	rw.Close()

	web := filepath.Join(dir, "web")
	os.MkdirAll(filepath.Join(web, "assets"), 0o755)
	os.WriteFile(filepath.Join(web, "index.html"), []byte("<html>app</html>"), 0o644)
	os.WriteFile(filepath.Join(web, "assets", "app.js"), []byte("console.log(1)"), 0o644)

	h, cleanup, err := newHandler(context.Background(), config{
		Data: data, Meta: filepath.Join(dir, "meta.duckdb"), DevUser: "dev-user", Web: web, QueryTimeout: 10 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()
	srv := httptest.NewServer(h)
	defer srv.Close()

	for path, want := range map[string]string{
		"/healthz":                                 "ok",
		"/api/workspace/maps":                      `"data":[]`,
		"/v3/maps/osm/table?name=demo_points":      `"tilejson"`,
		"/api/workspace/connections":               `"osm"`,
		"/api/workspace/connections/osm/resources": `"geoColumn":"geom"`,
		"/v3/sql/osm/model/formula?type=table&source=demo_points&params=%7B%22column%22%3A%22%2A%22%7D": `"value":400`,
		"/assets/app.js": "console.log(1)",
		"/maps":          "<html>app</html>", // SPA fallback
		"/viewer/123":    "<html>app</html>",
	} {
		res, err := http.Get(srv.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(res.Body)
		res.Body.Close()
		if res.StatusCode != 200 || !strings.Contains(string(body), want) {
			t.Errorf("%s: %d %q, want body containing %q", path, res.StatusCode, body, want)
		}
	}
}
