// Package catalog lists the spatial tables a connection exposes to the builder.
package catalog

import (
	"context"
	"database/sql"
	"strings"

	"osm-maps/server/internal/describe"
)

type Resource struct {
	Name      string            `json:"name"`
	Columns   []describe.Column `json:"columns"`
	GeoColumn string            `json:"geoColumn"`          // geometry column, or "h3:<col>" (CARTO dataset convention)
	H3Column  string            `json:"h3Column,omitempty"` // H3 column usable for aggregation
}

// h3Names mirrors CARTO's spatial-index column aliases (ledger: spatial index detection).
var h3Names = map[string]bool{"h3": true, "hex": true, "h3id": true, "hex_id": true, "h3hex": true}

// List returns every table in the main schema that has a geometry or H3 column, in name order.
// Server-internal catalog query: not user SQL, so it does not pass through sqlguard.
func List(ctx context.Context, db *sql.DB) ([]Resource, error) {
	rows, err := db.QueryContext(ctx, `SELECT table_name, column_name, data_type FROM duckdb_columns()
WHERE database_name = current_database() AND schema_name = 'main' AND NOT internal
ORDER BY table_name, column_index`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var (
		out []Resource
		cur *Resource
	)
	for rows.Next() {
		var table, col, typ string
		if err := rows.Scan(&table, &col, &typ); err != nil {
			return nil, err
		}
		if cur == nil || cur.Name != table {
			out = append(out, Resource{Name: table})
			cur = &out[len(out)-1]
		}
		cur.Columns = append(cur.Columns, describe.Column{Name: col, Type: describe.Kind(typ)})
		upper := strings.ToUpper(typ)
		if upper == "GEOMETRY" && cur.GeoColumn == "" {
			cur.GeoColumn = col
		}
		if cur.H3Column == "" && h3Names[strings.ToLower(col)] && (upper == "UBIGINT" || upper == "BIGINT" || upper == "VARCHAR") {
			cur.H3Column = col
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	spatial := out[:0]
	for _, r := range out {
		if r.GeoColumn == "" && r.H3Column != "" {
			r.GeoColumn = "h3:" + r.H3Column
		}
		if r.GeoColumn != "" {
			spatial = append(spatial, r)
		}
	}
	return spatial, nil
}
