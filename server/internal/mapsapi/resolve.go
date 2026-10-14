package mapsapi

import (
	"context"
	"database/sql"
	"errors"
	"log"
	"net/http"

	"osm-maps/server/internal/describe"
	"osm-maps/server/internal/httpx"
	"osm-maps/server/internal/source"
	"osm-maps/server/internal/sqlguard"
	"osm-maps/server/internal/tiles"
)

// Resolve validates user SQL, compiles the source relation and reads its schema.
// Shared by the maps, stats and model endpoints.
func Resolve(ctx context.Context, db *sql.DB, src source.Source) (string, []any, []describe.Column, error) {
	if src.Type == source.TypeQuery {
		if err := sqlguard.ValidateSelect(ctx, db, src.Query); err != nil {
			return "", nil, nil, err
		}
	}
	if src.AggregationExp != "" {
		if err := sqlguard.ValidateSelect(ctx, db, "SELECT "+src.AggregationExp); err != nil {
			return "", nil, nil, err
		}
	}
	rel, args, err := src.Relation()
	if err != nil {
		return "", nil, nil, err
	}
	schema, err := describe.Schema(ctx, db, rel, args)
	if err != nil {
		return "", nil, nil, QueryError(err)
	}
	return rel, args, schema, nil
}

// QueryError is the exported form of queryError (first line only, paths redacted).
func QueryError(err error) error { return queryError(err) }

// Fail writes err with the status the Data API uses for it.
func Fail(ctx context.Context, w http.ResponseWriter, err error) {
	switch {
	case ctx.Err() != nil:
		httpx.WriteError(w, http.StatusRequestTimeout, "query timed out")
	case errors.Is(err, source.ErrBadRequest), errors.Is(err, sqlguard.ErrNotSelect),
		errors.Is(err, errQuery), errors.Is(err, tiles.ErrTooLarge):
		httpx.WriteError(w, http.StatusBadRequest, err.Error())
	default:
		log.Printf("mapsapi: %v", err)
		httpx.WriteError(w, http.StatusInternalServerError, "internal error")
	}
}
