// Package modelapi serves CARTO's SQL "model" API used by widgets (/v3/sql/{conn}/model/{model}).
package modelapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"osm-maps/server/internal/describe"
	"osm-maps/server/internal/httpx"
	"osm-maps/server/internal/mapsapi"
	"osm-maps/server/internal/source"
	"osm-maps/server/internal/sqlguard"
)

type Server struct {
	Conns        map[string]*sql.DB
	QueryTimeout time.Duration
}

func (s *Server) Register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v3/sql/{conn}/model/{model}", s.handle)
	mux.HandleFunc("POST /v3/sql/{conn}/model/{model}", s.handle)
}

func (s *Server) handle(w http.ResponseWriter, r *http.Request) {
	timeout := s.QueryTimeout
	if timeout <= 0 {
		timeout = 15 * time.Second
	}
	ctx, cancel := context.WithTimeout(r.Context(), timeout)
	defer cancel()
	db, ok := s.Conns[r.PathValue("conn")]
	if !ok {
		httpx.WriteError(w, http.StatusNotFound, "connection not found")
		return
	}
	model, ok := models[r.PathValue("model")]
	if !ok {
		mapsapi.Fail(ctx, w, bad("unsupported model %q", r.PathValue("model")))
		return
	}
	v, err := mapsapi.ParseParams(r)
	if err != nil {
		mapsapi.Fail(ctx, w, err)
		return
	}
	typ := v.Get("type")
	if typ == "table" {
		v.Set("name", v.Get("source"))
	} else {
		v.Set("q", v.Get("source"))
	}
	src, err := mapsapi.SourceFrom(typ, v)
	if err != nil {
		mapsapi.Fail(ctx, w, err)
		return
	}
	var p params
	if raw := v.Get("params"); raw != "" {
		if err := json.Unmarshal([]byte(raw), &p); err != nil {
			mapsapi.Fail(ctx, w, bad("params must be a JSON object: %v", err))
			return
		}
	}
	rel, args, schema, err := mapsapi.Resolve(ctx, db, src)
	if err != nil {
		mapsapi.Fail(ctx, w, err)
		return
	}
	cols := make(map[string]describe.Column, len(schema))
	for _, c := range schema {
		cols[c.Name] = c
	}
	res, err := model(ctx, query{db: db, rel: rel, args: args, cols: cols}, p)
	if err != nil {
		if !errors.Is(err, source.ErrBadRequest) && !errors.Is(err, sqlguard.ErrNotSelect) && ctx.Err() == nil {
			err = mapsapi.QueryError(err)
		}
		mapsapi.Fail(ctx, w, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, res)
}
