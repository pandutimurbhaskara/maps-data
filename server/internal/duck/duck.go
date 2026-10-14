// Package duck opens DuckDB databases with the extensions osm-maps needs.
package duck

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"fmt"
	"net/url"
	"strconv"
	"sync"

	"github.com/duckdb/duckdb-go/v2"
)

// Options configures one DuckDB database instance.
type Options struct {
	Path        string // database file; "" means in-memory
	ReadOnly    bool
	Sandbox     bool   // after loading extensions: disable external access, lock configuration
	MemoryLimit string // e.g. "2GB"; "" keeps DuckDB's default
	Threads     int    // 0 keeps DuckDB's default
}

var extensions = []string{
	"INSTALL spatial", "LOAD spatial",
	"INSTALL json", "LOAD json",
	"INSTALL h3 FROM community", "LOAD h3",
}

var sandbox = []string{
	"SET enable_external_access = false",
	"SET lock_configuration = true",
}

// Open returns a pooled *sql.DB. Extensions and sandbox settings are database-global,
// so they are applied once, by the first connection the pool creates.
func Open(o Options) (*sql.DB, error) {
	var (
		mu   sync.Mutex
		done bool
	)
	connector, err := duckdb.NewConnector(dsn(o), func(ex driver.ExecerContext) error {
		mu.Lock()
		defer mu.Unlock()
		if done {
			return nil
		}
		stmts := extensions
		if o.Sandbox {
			stmts = append(append([]string{}, extensions...), sandbox...)
		}
		for _, s := range stmts {
			if _, err := ex.ExecContext(context.Background(), s, nil); err != nil {
				return fmt.Errorf("duck: %s: %w", s, err)
			}
		}
		done = true
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("duck: open %q: %w", o.Path, err)
	}
	return sql.OpenDB(connector), nil
}

func dsn(o Options) string {
	q := url.Values{}
	if o.ReadOnly {
		q.Set("access_mode", "READ_ONLY")
	}
	if o.MemoryLimit != "" {
		q.Set("memory_limit", o.MemoryLimit)
	}
	if o.Threads > 0 {
		q.Set("threads", strconv.Itoa(o.Threads))
	}
	if len(q) == 0 {
		return o.Path
	}
	return o.Path + "?" + q.Encode()
}
