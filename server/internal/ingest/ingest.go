// Package ingest turns an OpenStreetMap .osm.pbf extract into map-ready DuckDB tables.
package ingest

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
)

// LoadPBF reads pbfPath into osm_raw with ST_ReadOSM, then builds the derived tables.
func LoadPBF(ctx context.Context, db *sql.DB, pbfPath string) error {
	q := `CREATE OR REPLACE TABLE osm_raw AS
SELECT kind::VARCHAR AS kind, id, tags, refs, lat, lon FROM ST_ReadOSM(` + quoteLiteral(pbfPath) + `)`
	if _, err := db.ExecContext(ctx, q); err != nil {
		return fmt.Errorf("ingest: read %s: %w", pbfPath, err)
	}
	return BuildDerived(ctx, db)
}

func quoteLiteral(s string) string { return "'" + strings.ReplaceAll(s, "'", "''") + "'" }

// Multipolygon relations are not assembled (spec §4.5); closed ways only.
var derivedSQL = []string{
	`CREATE OR REPLACE TEMP MACRO osm_is_area(t) AS
	   (map_contains(t, 'building') OR map_contains(t, 'landuse') OR map_contains(t, 'leisure')
	    OR map_contains(t, 'amenity') OR map_contains(t, 'natural') OR coalesce(t['area'], '') = 'yes')
	   AND coalesce(t['area'], '') <> 'no'`,

	`CREATE OR REPLACE TABLE osm_points AS
	 SELECT id AS osm_id, tags['name'] AS name, tags['amenity'] AS amenity, tags['shop'] AS shop,
	        tags['tourism'] AS tourism, tags, ST_Point(lon, lat) AS geom,
	        h3_latlng_to_cell(lat, lon, 12)::UBIGINT AS h3
	 FROM osm_raw WHERE kind = 'node' AND cardinality(tags) > 0`,

	`CREATE OR REPLACE TEMP TABLE osm_way_lines AS
	 WITH refs AS (
	   SELECT id AS way_id, UNNEST(refs) AS node_id, generate_subscripts(refs, 1) AS ord
	   FROM osm_raw WHERE kind = 'way'
	 )
	 SELECT r.way_id, ST_MakeLine(list(ST_Point(n.lon, n.lat) ORDER BY r.ord)) AS line, count(*) AS n
	 FROM refs r JOIN osm_raw n ON n.kind = 'node' AND n.id = r.node_id
	 GROUP BY r.way_id HAVING count(*) >= 2`,

	`CREATE OR REPLACE TABLE osm_polygons AS
	 SELECT w.id AS osm_id, w.tags['name'] AS name, w.tags['building'] AS building,
	        w.tags['landuse'] AS landuse, w.tags['leisure'] AS leisure, w.tags,
	        ST_MakePolygon(l.line) AS geom
	 FROM osm_raw w JOIN osm_way_lines l ON l.way_id = w.id
	 WHERE w.kind = 'way' AND l.n >= 4 AND w.refs[1] = w.refs[-1] AND osm_is_area(w.tags)`,

	`CREATE OR REPLACE TABLE osm_lines AS
	 SELECT w.id AS osm_id, w.tags['name'] AS name, w.tags['highway'] AS highway,
	        w.tags['railway'] AS railway, w.tags['waterway'] AS waterway, w.tags, l.line AS geom
	 FROM osm_raw w JOIN osm_way_lines l ON l.way_id = w.id
	 WHERE w.kind = 'way' AND NOT (l.n >= 4 AND w.refs[1] = w.refs[-1] AND osm_is_area(w.tags))`,

	`CREATE INDEX IF NOT EXISTS osm_points_geom ON osm_points USING RTREE (geom)`,
	`CREATE INDEX IF NOT EXISTS osm_lines_geom ON osm_lines USING RTREE (geom)`,
	`CREATE INDEX IF NOT EXISTS osm_polygons_geom ON osm_polygons USING RTREE (geom)`,
	`ANALYZE`,
}

// BuildDerived turns osm_raw into osm_points, osm_lines and osm_polygons.
// It runs on one connection because the temp macro and temp table are connection-scoped.
func BuildDerived(ctx context.Context, db *sql.DB) error {
	conn, err := db.Conn(ctx)
	if err != nil {
		return fmt.Errorf("ingest: %w", err)
	}
	defer conn.Close()
	for _, q := range derivedSQL {
		if _, err := conn.ExecContext(ctx, q); err != nil {
			return fmt.Errorf("ingest: %s: %w", firstLine(q), err)
		}
	}
	return nil
}

func firstLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return s[:i]
	}
	return s
}
