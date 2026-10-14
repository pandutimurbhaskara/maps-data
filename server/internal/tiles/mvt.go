package tiles

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"math"
	"strings"

	"osm-maps/server/internal/describe"
)

const (
	MVTLayer        = describe.LayerName
	FeatureIDColumn = "_carto_feature_id"
	mvtExtent       = 4096
	mvtBuffer       = 256
	defaultMax      = 200_000
)

var ErrTooLarge = errors.New("tile too large")

type MVTRequest struct {
	Relation    string
	Args        []any
	GeomColumn  string // quoted
	Props       []describe.Column
	FeatureID   bool
	Z, X, Y     int
	MaxFeatures int
}

// MVT returns one Mapbox Vector Tile (layer "default", EPSG:3857), or nil when the tile is empty.
func MVT(ctx context.Context, db *sql.DB, r MVTRequest) ([]byte, error) {
	minLon, minLat, maxLon, maxLat := TileBounds(r.Z, r.X, r.Y)
	bx := (maxLon - minLon) * mvtBuffer / mvtExtent
	by := (maxLat - minLat) * mvtBuffer / mvtExtent
	max := r.MaxFeatures
	if max <= 0 {
		max = defaultMax
	}

	fields := []string{"'__geom': __g"}
	for _, c := range r.Props {
		fields = append(fields, fmt.Sprintf("'%s': %s", c.Name, mvtValue(`"`+c.Name+`"`, c.Type)))
	}
	if r.FeatureID {
		// Stable per geometry and below 2^53, so JavaScript reads it exactly.
		fields = append(fields, "'"+FeatureIDColumn+"': CAST(hash(ST_AsWKB(__orig)) % 9007199254740991 AS DOUBLE)")
	}

	q := fmt.Sprintf(`
WITH src AS (
  SELECT *, %[1]s AS __orig FROM %[2]s AS _r
  WHERE %[1]s IS NOT NULL AND ST_Intersects(%[1]s, ST_MakeEnvelope($p__xmin, $p__ymin, $p__xmax, $p__ymax))
  LIMIT %[3]d
), clipped AS (
  SELECT *, ST_AsMVTGeom(ST_Transform(__orig, 'EPSG:4326', 'EPSG:3857', always_xy := true),
                         ST_Extent(ST_TileEnvelope($p__z::INTEGER, $p__x::INTEGER, $p__y::INTEGER)), %[4]d, %[5]d, true) AS __g
  FROM src
)
SELECT (SELECT count(*) FROM src), (SELECT count(*) FROM clipped WHERE __g IS NOT NULL),
       (SELECT ST_AsMVT({%[6]s}, '%[7]s', %[4]d, '__geom') FROM clipped WHERE __g IS NOT NULL)`,
		r.GeomColumn, r.Relation, max+1, mvtExtent, mvtBuffer, strings.Join(fields, ", "), MVTLayer)

	args := append(append([]any{}, r.Args...),
		sql.Named("p__xmin", minLon-bx), sql.Named("p__ymin", math.Max(minLat-by, -90)),
		sql.Named("p__xmax", maxLon+bx), sql.Named("p__ymax", math.Min(maxLat+by, 90)),
		sql.Named("p__z", r.Z), sql.Named("p__x", r.X), sql.Named("p__y", r.Y))

	var (
		n, kept int64
		tile    []byte
	)
	if err := db.QueryRowContext(ctx, q, args...).Scan(&n, &kept, &tile); err != nil {
		return nil, err
	}
	if n > int64(max) {
		return nil, fmt.Errorf("%w: more than %d features; aggregate the source or zoom in", ErrTooLarge, max)
	}
	if kept == 0 { // ST_AsMVT over zero rows still emits an empty layer
		return nil, nil
	}
	return tile, nil
}

func mvtValue(col, kind string) string {
	switch kind {
	case "number":
		return "CAST(" + col + " AS DOUBLE)"
	case "boolean":
		return col
	}
	return "CAST(" + col + " AS VARCHAR)"
}
