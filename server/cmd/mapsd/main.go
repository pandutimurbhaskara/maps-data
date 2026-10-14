// Command mapsd serves the osm-maps Data API, workspace API and (optionally) the built web app.
package main

import (
	"context"
	"database/sql"
	"errors"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"syscall"
	"time"

	"osm-maps/server/internal/auth"
	"osm-maps/server/internal/duck"
	"osm-maps/server/internal/mapsapi"
	"osm-maps/server/internal/store"
	"osm-maps/server/internal/workspace"
)

type config struct {
	Addr, Data, Meta, DevUser, Web, MemoryLimit string
	Threads                                     int
	QueryTimeout                                time.Duration
}

func main() {
	var c config
	flag.StringVar(&c.Addr, "addr", "127.0.0.1:8080", "listen address")
	flag.StringVar(&c.Data, "data", "data.duckdb", "data DuckDB file (opened read-only)")
	flag.StringVar(&c.Meta, "meta", "meta.duckdb", "metadata DuckDB file (created if missing)")
	flag.StringVar(&c.DevUser, "dev-user", "dev-user", "user id every request runs as (M1 dev auth)")
	flag.StringVar(&c.Web, "web", "", "directory of the built web app to serve at /")
	flag.StringVar(&c.MemoryLimit, "memory-limit", "", "DuckDB memory_limit for the data DB, e.g. 2GB")
	flag.IntVar(&c.Threads, "threads", 0, "DuckDB threads for the data DB (0 = default)")
	flag.DurationVar(&c.QueryTimeout, "query-timeout", 15*time.Second, "per-request query timeout")
	flag.Parse()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, c); err != nil {
		log.Fatal(err)
	}
}

func run(ctx context.Context, c config) error {
	h, cleanup, err := newHandler(ctx, c)
	if err != nil {
		return err
	}
	defer cleanup()
	srv := &http.Server{Addr: c.Addr, Handler: h, ReadHeaderTimeout: 10 * time.Second}
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdown)
	}()
	log.Printf("mapsd listening on http://%s", c.Addr)
	if err := srv.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

func newHandler(ctx context.Context, c config) (http.Handler, func(), error) {
	fi, err := os.Stat(c.Data)
	if err != nil {
		return nil, nil, fmt.Errorf("data file: %w (create it with cmd/seed or cmd/osm-ingest)", err)
	}
	dataDB, err := duck.Open(duck.Options{Path: c.Data, ReadOnly: true, Sandbox: true, MemoryLimit: c.MemoryLimit, Threads: c.Threads})
	if err != nil {
		return nil, nil, err
	}
	if err := dataDB.PingContext(ctx); err != nil {
		dataDB.Close()
		return nil, nil, fmt.Errorf("data db: %w", err)
	}
	st, err := store.OpenDuck(ctx, c.Meta)
	if err != nil {
		dataDB.Close()
		return nil, nil, err
	}

	mux := http.NewServeMux()
	(&mapsapi.Server{
		Conns:        map[string]*sql.DB{"osm": dataDB},
		DataVersion:  strconv.FormatInt(fi.ModTime().UnixMilli(), 10),
		QueryTimeout: c.QueryTimeout,
		MaxFeatures:  200_000,
	}).Register(mux)
	(&workspace.Handler{Store: st, Connections: []workspace.Connection{{Name: "osm", Provider: "duckdb"}}}).Register(mux, "/api/workspace")
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("ok")) })
	if c.Web != "" {
		mux.Handle("GET /", spa(c.Web))
	}
	cleanup := func() {
		st.Close()
		dataDB.Close()
	}
	return auth.Dev(c.DevUser, mux), cleanup, nil
}

// spa serves files from dir and falls back to index.html for client-side routes.
func spa(dir string) http.Handler {
	files := http.FileServer(http.Dir(dir))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := filepath.Join(dir, filepath.Clean("/"+r.URL.Path))
		if st, err := os.Stat(p); err != nil || st.IsDir() {
			http.ServeFile(w, r, filepath.Join(dir, "index.html"))
			return
		}
		files.ServeHTTP(w, r)
	})
}
