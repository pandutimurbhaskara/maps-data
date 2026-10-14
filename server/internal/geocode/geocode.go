// Package geocode searches place names in the OSM data (spec M2 D7: ranked substring, not FTS).
package geocode

import (
	"context"
	"database/sql"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"osm-maps/server/internal/httpx"
)

type Place struct {
	Name      string  `json:"name"`
	Kind      string  `json:"kind"`
	Longitude float64 `json:"longitude"`
	Latitude  float64 `json:"latitude"`
}

// candidates are searched when the table exists; kind and point are SQL expressions over that table.
var candidates = []struct{ table, kind, point string }{
	{"osm_points", "coalesce(amenity, shop, tourism, 'place')", "geom"},
	{"osm_polygons", "coalesce(building, landuse, leisure, 'area')", "ST_Centroid(geom)"},
	{"demo_points", "category", "geom"},
}

func Search(ctx context.Context, db *sql.DB, text string, limit int) ([]Place, error) {
	existing := map[string]bool{}
	rows, err := db.QueryContext(ctx, `SELECT table_name FROM duckdb_tables() WHERE database_name = current_database() AND schema_name = 'main'`)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			rows.Close()
			return nil, err
		}
		existing[n] = true
	}
	rows.Close()

	var parts []string
	for _, c := range candidates {
		if existing[c.table] {
			parts = append(parts, fmt.Sprintf(
				`SELECT name, CAST(%s AS VARCHAR) AS kind, ST_X(%s) AS lon, ST_Y(%s) AS lat FROM %s WHERE name IS NOT NULL AND contains(lower(name), lower($q))`,
				c.kind, c.point, c.point, c.table))
		}
	}
	out := []Place{}
	if len(parts) == 0 {
		return out, nil
	}
	q := `SELECT name, kind, lon, lat FROM (` + strings.Join(parts, " UNION ALL ") + `) AS _p
ORDER BY CASE WHEN lower(name) = lower($q) THEN 0 WHEN starts_with(lower(name), lower($q)) THEN 1 ELSE 2 END, length(name), name
LIMIT ` + strconv.Itoa(limit)
	rs, err := db.QueryContext(ctx, q, sql.Named("q", text))
	if err != nil {
		return nil, err
	}
	defer rs.Close()
	for rs.Next() {
		var p Place
		var kind sql.NullString
		if err := rs.Scan(&p.Name, &kind, &p.Longitude, &p.Latitude); err != nil {
			return nil, err
		}
		p.Kind = kind.String
		out = append(out, p)
	}
	return out, rs.Err()
}

type Handler struct{ DB *sql.DB }

func (h *Handler) Register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v3/lds/geocoding/geocode", h.geocode)
}

func (h *Handler) geocode(w http.ResponseWriter, r *http.Request) {
	text := strings.TrimSpace(r.URL.Query().Get("address"))
	if text == "" || len(text) > 200 {
		httpx.WriteError(w, http.StatusBadRequest, "address must be 1..200 characters")
		return
	}
	limit := 5
	if l := r.URL.Query().Get("limit"); l != "" {
		n, err := strconv.Atoi(l)
		if err != nil || n < 1 || n > 20 {
			httpx.WriteError(w, http.StatusBadRequest, "limit must be 1..20")
			return
		}
		limit = n
	}
	places, err := Search(r.Context(), h.DB, text, limit)
	if err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "geocoding failed")
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"rows": places})
}
