// Package describe derives schema, bounds and tilestats for a source relation.
package describe

import (
	"context"
	"database/sql"
	"errors"
	"strings"
)

const LayerName = "default"

type Column struct {
	Name string `json:"name"`
	Type string `json:"type"`
}

// Kind maps a DuckDB type name to the schema type sent to clients.
func Kind(dbType string) string {
	t := strings.ToUpper(dbType)
	switch {
	case t == "BOOLEAN":
		return "boolean"
	case t == "GEOMETRY":
		return "geometry"
	case strings.HasPrefix(t, "DECIMAL"):
		return "number"
	case strings.HasPrefix(t, "TIMESTAMP"), t == "DATE", strings.HasPrefix(t, "TIME"):
		return "timestamp"
	case t == "VARCHAR", t == "UUID", strings.HasPrefix(t, "ENUM"):
		return "string"
	}
	switch t {
	case "TINYINT", "SMALLINT", "INTEGER", "BIGINT", "HUGEINT",
		"UTINYINT", "USMALLINT", "UINTEGER", "UBIGINT", "UHUGEINT", "FLOAT", "DOUBLE":
		return "number"
	}
	return "unknown"
}

// Schema returns the relation's columns without reading any rows.
func Schema(ctx context.Context, db *sql.DB, rel string, args []any) ([]Column, error) {
	rows, err := db.QueryContext(ctx, "SELECT * FROM "+rel+" AS _r LIMIT 0", args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	types, err := rows.ColumnTypes()
	if err != nil {
		return nil, err
	}
	cols := make([]Column, len(types))
	for i, ct := range types {
		cols[i] = Column{Name: ct.Name(), Type: Kind(ct.DatabaseTypeName())}
	}
	return cols, rows.Err()
}

func GeometryType(ctx context.Context, db *sql.DB, rel, geomCol string, args []any) (string, error) {
	var t sql.NullString
	err := db.QueryRowContext(ctx, "SELECT CAST(ST_GeometryType("+geomCol+") AS VARCHAR) FROM "+rel+" AS _r WHERE "+geomCol+" IS NOT NULL LIMIT 1", args...).Scan(&t)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	switch strings.ToUpper(t.String) {
	case "POINT", "MULTIPOINT":
		return "Point", nil
	case "LINESTRING", "MULTILINESTRING":
		return "LineString", nil
	case "POLYGON", "MULTIPOLYGON":
		return "Polygon", nil
	}
	return "", nil
}

func GeoBounds(ctx context.Context, db *sql.DB, rel, geomCol string, args []any) ([4]float64, bool, error) {
	return bounds(ctx, db, "SELECT ST_XMin(e), ST_YMin(e), ST_XMax(e), ST_YMax(e) FROM (SELECT ST_Extent_Agg("+geomCol+") AS e FROM "+rel+" AS _r)", args)
}

// H3Bounds is the bbox of the cell centres.
func H3Bounds(ctx context.Context, db *sql.DB, rel, cellCol string, args []any) ([4]float64, bool, error) {
	return bounds(ctx, db, "SELECT min(h3_cell_to_lng(c)), min(h3_cell_to_lat(c)), max(h3_cell_to_lng(c)), max(h3_cell_to_lat(c)) FROM (SELECT "+cellCol+" AS c FROM "+rel+" AS _r WHERE "+cellCol+" IS NOT NULL)", args)
}

func bounds(ctx context.Context, db *sql.DB, q string, args []any) ([4]float64, bool, error) {
	var v [4]sql.NullFloat64
	if err := db.QueryRowContext(ctx, q, args...).Scan(&v[0], &v[1], &v[2], &v[3]); err != nil {
		return [4]float64{}, false, err
	}
	if !v[0].Valid {
		return [4]float64{}, false, nil
	}
	return [4]float64{v[0].Float64, v[1].Float64, v[2].Float64, v[3].Float64}, true, nil
}

func H3Resolution(ctx context.Context, db *sql.DB, rel, cellCol string, args []any) (int, bool, error) {
	var r sql.NullInt64
	err := db.QueryRowContext(ctx, "SELECT h3_get_resolution("+cellCol+") FROM "+rel+" AS _r WHERE "+cellCol+" IS NOT NULL LIMIT 1", args...).Scan(&r)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, err
	}
	return int(r.Int64), r.Valid, nil
}

type Tilestats struct {
	LayerCount int          `json:"layerCount"`
	Layers     []StatsLayer `json:"layers"`
}

type StatsLayer struct {
	Layer          string      `json:"layer"`
	Count          int64       `json:"count"`
	Geometry       string      `json:"geometry,omitempty"`
	AttributeCount int         `json:"attributeCount"`
	Attributes     []Attribute `json:"attributes"`
}

type Attribute struct {
	Attribute  string     `json:"attribute"`
	Type       string     `json:"type"`
	Min        *float64   `json:"min,omitempty"`
	Max        *float64   `json:"max,omitempty"`
	Categories []Category `json:"categories,omitempty"`
}

type Category struct {
	Category  string `json:"category"`
	Frequency int64  `json:"frequency"`
}

// Stats computes the row count, min/max for numbers and the top 10 categories for strings/booleans.
func Stats(ctx context.Context, db *sql.DB, rel string, args []any, cols []Column, geometry string) (Tilestats, error) {
	sel := []string{"count(*)"}
	var numeric int
	for _, c := range cols {
		if c.Type == "number" {
			q := quote(c.Name)
			sel = append(sel, "min(CAST("+q+" AS DOUBLE))", "max(CAST("+q+" AS DOUBLE))")
			numeric++
		}
	}
	var count int64
	mins := make([]sql.NullFloat64, numeric)
	maxs := make([]sql.NullFloat64, numeric)
	dest := []any{&count}
	for k := 0; k < numeric; k++ {
		dest = append(dest, &mins[k], &maxs[k])
	}
	if err := db.QueryRowContext(ctx, "SELECT "+strings.Join(sel, ", ")+" FROM "+rel+" AS _r", args...).Scan(dest...); err != nil {
		return Tilestats{}, err
	}
	attrs := make([]Attribute, 0, len(cols))
	k := 0
	for _, c := range cols {
		a := Attribute{Attribute: c.Name, Type: statsType(c.Type)}
		switch c.Type {
		case "number":
			if mins[k].Valid {
				a.Min = &mins[k].Float64
			}
			if maxs[k].Valid {
				a.Max = &maxs[k].Float64
			}
			k++
		case "string", "boolean":
			cats, err := categories(ctx, db, rel, c.Name, args)
			if err != nil {
				return Tilestats{}, err
			}
			a.Categories = cats
		}
		attrs = append(attrs, a)
	}
	return Tilestats{LayerCount: 1, Layers: []StatsLayer{{
		Layer: LayerName, Count: count, Geometry: geometry, AttributeCount: len(attrs), Attributes: attrs,
	}}}, nil
}

func categories(ctx context.Context, db *sql.DB, rel, col string, args []any) ([]Category, error) {
	q := quote(col)
	rows, err := db.QueryContext(ctx, "SELECT CAST("+q+" AS VARCHAR) AS c, count(*) AS n FROM "+rel+" AS _r WHERE "+q+" IS NOT NULL GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 10", args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Category
	for rows.Next() {
		var c Category
		if err := rows.Scan(&c.Category, &c.Frequency); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func statsType(kind string) string {
	switch kind {
	case "number":
		return "Number"
	case "boolean":
		return "Boolean"
	case "timestamp":
		return "Date"
	}
	return "String"
}

func quote(name string) string { return `"` + strings.ReplaceAll(name, `"`, `""`) + `"` }
