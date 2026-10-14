// Command seed writes the deterministic demo tables into a DuckDB file.
package main

import (
	"context"
	"flag"
	"log"

	"osm-maps/server/internal/duck"
	"osm-maps/server/internal/seed"
)

func main() {
	out := flag.String("out", "data.duckdb", "DuckDB file to create or update")
	flag.Parse()
	db, err := duck.Open(duck.Options{Path: *out})
	if err != nil {
		log.Fatal(err)
	}
	defer db.Close()
	if err := seed.Demo(context.Background(), db); err != nil {
		log.Fatal(err)
	}
	log.Printf("seeded demo_points into %s", *out)
}
