package mapsapi

import (
	"fmt"
	"net/http"
	"strconv"

	"osm-maps/server/internal/describe"
	"osm-maps/server/internal/httpx"
	"osm-maps/server/internal/source"
)

// handleStats serves /v3/stats/{conn}/{attr} (query sources, q=) and /v3/stats/{conn}/{table}/{attr}.
// Only source columns are consulted; the spatial column is not required (tilestats for any layer).
func (s *Server) handleStats(w http.ResponseWriter, r *http.Request) {
	ctx, cancel, db, v, ok := s.begin(w, r)
	defer cancel()
	if !ok {
		return
	}
	typ := "query"
	if table := r.PathValue("table"); table != "" {
		typ = "table"
		v.Set("name", table)
	}
	src, err := SourceFrom(typ, v)
	if err != nil {
		s.fail(ctx, w, err)
		return
	}
	rel, args, schema, err := Resolve(ctx, db, src)
	if err != nil {
		s.fail(ctx, w, err)
		return
	}
	attr := r.PathValue("attr")
	var col *describe.Column
	for i := range schema {
		if schema[i].Name == attr {
			col = &schema[i]
		}
	}
	if col == nil {
		s.fail(ctx, w, fmt.Errorf("%w: unknown attribute %q", source.ErrBadRequest, attr))
		return
	}
	maxCats := 20
	if m := v.Get("maxNumberOfCategories"); m != "" {
		if maxCats, err = strconv.Atoi(m); err != nil || maxCats < 1 || maxCats > 100 {
			s.fail(ctx, w, fmt.Errorf("%w: maxNumberOfCategories must be 1..100", source.ErrBadRequest))
			return
		}
	}
	st, err := describe.ColumnStats(ctx, db, rel, args, *col, maxCats)
	if err != nil {
		s.fail(ctx, w, QueryError(err))
		return
	}
	httpx.WriteJSON(w, http.StatusOK, st)
}
