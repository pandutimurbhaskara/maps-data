// Command osm-ingest converts an .osm.pbf extract into a DuckDB data database.
package main

import (
	"context"
	"flag"
	"log"

	"osm-maps/server/internal/duck"
	"osm-maps/server/internal/ingest"
)

func main() {
	pbf := flag.String("pbf", "", "path to an .osm.pbf extract (e.g. Geofabrik)")
	out := flag.String("out", "data.duckdb", "DuckDB file to write")
	flag.Parse()
	if *pbf == "" {
		log.Fatal("-pbf is required")
	}
	db, err := duck.Open(duck.Options{Path: *out})
	if err != nil {
		log.Fatal(err)
	}
	defer db.Close()
	if err := ingest.LoadPBF(context.Background(), db, *pbf); err != nil {
		log.Fatal(err)
	}
	for _, table := range []string{"osm_points", "osm_lines", "osm_polygons"} {
		var n int64
		if err := db.QueryRow("SELECT count(*) FROM " + table).Scan(&n); err != nil {
			log.Fatal(err)
		}
		log.Printf("%s: %d rows", table, n)
	}
}
