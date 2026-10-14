// Package mapsapi serves the CARTO-v3-compatible map instantiation, TileJSON and tile endpoints.
package mapsapi

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"osm-maps/server/internal/describe"
	"osm-maps/server/internal/httpx"
	"osm-maps/server/internal/source"
	"osm-maps/server/internal/sqlguard"
	"osm-maps/server/internal/tiles"
)

type Server struct {
	Conns        map[string]*sql.DB
	DataVersion  string // emitted as cache=<DataVersion>; changes whenever the data file changes
	QueryTimeout time.Duration
	MaxFeatures  int
}

func (s *Server) Register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v3/maps/{conn}/{type}", s.handleSource)
	mux.HandleFunc("POST /v3/maps/{conn}/{type}", s.handleSource)
	mux.HandleFunc("GET /v3/maps/{conn}/{type}/{z}/{x}/{y}", s.handleMVT)
	mux.HandleFunc("GET /v3/maps/{conn}/{type}/{cell}", s.handleH3)
}

var errQuery = errors.New("query failed")

// pathRe matches absolute filesystem paths (two or more segments) inside DuckDB error messages.
var pathRe = regexp.MustCompile(`(?:[A-Za-z]:)?[/\\](?:[^\s"'/\\]+[/\\])+[^\s"'/\\]*`)

type prepared struct {
	src       source.Source
	rel       string
	args      []any
	schema    []describe.Column
	spatial   string // quoted spatial column
	props     []describe.Column
	featureID bool
}

func (s *Server) begin(w http.ResponseWriter, r *http.Request) (context.Context, context.CancelFunc, *sql.DB, url.Values, bool) {
	timeout := s.QueryTimeout
	if timeout <= 0 {
		timeout = 15 * time.Second
	}
	ctx, cancel := context.WithTimeout(r.Context(), timeout)
	db, ok := s.Conns[r.PathValue("conn")]
	if !ok {
		httpx.WriteError(w, http.StatusNotFound, "connection not found")
		return ctx, cancel, nil, nil, false
	}
	v, err := ParseParams(r)
	if err != nil {
		s.fail(ctx, w, err)
		return ctx, cancel, nil, nil, false
	}
	return ctx, cancel, db, v, true
}

func (s *Server) prepare(ctx context.Context, db *sql.DB, typ string, v url.Values) (prepared, error) {
	src, err := SourceFrom(typ, v)
	if err != nil {
		return prepared{}, err
	}
	if src.Type == source.TypeQuery {
		if err := sqlguard.ValidateSelect(ctx, db, src.Query); err != nil {
			return prepared{}, err
		}
	}
	if src.AggregationExp != "" {
		if err := sqlguard.ValidateSelect(ctx, db, "SELECT "+src.AggregationExp); err != nil {
			return prepared{}, err
		}
	}
	rel, args, err := src.Relation()
	if err != nil {
		return prepared{}, err
	}
	schema, err := describe.Schema(ctx, db, rel, args)
	if err != nil {
		return prepared{}, queryError(err)
	}
	byName := make(map[string]describe.Column, len(schema))
	for _, c := range schema {
		byName[c.Name] = c
	}
	spatial := src.SpatialColumnName()
	if _, ok := byName[spatial]; !ok {
		return prepared{}, fmt.Errorf("%w: spatial column %q not found", source.ErrBadRequest, spatial)
	}
	p := prepared{src: src, rel: rel, args: args, schema: schema, spatial: `"` + spatial + `"`}
	for _, name := range src.Columns {
		switch name {
		case tiles.FeatureIDColumn:
			p.featureID = true
		case spatial:
		default:
			c, ok := byName[name]
			if !ok {
				return prepared{}, fmt.Errorf("%w: unknown column %q", source.ErrBadRequest, name)
			}
			p.props = append(p.props, c)
		}
	}
	return p, nil
}

func (s *Server) handleSource(w http.ResponseWriter, r *http.Request) {
	ctx, cancel, db, v, ok := s.begin(w, r)
	defer cancel()
	if !ok {
		return
	}
	p, err := s.prepare(ctx, db, r.PathValue("type"), v)
	if err != nil {
		s.fail(ctx, w, err)
		return
	}
	if v.Get("format") != "tilejson" {
		q := cloneValues(v)
		q.Set("format", "tilejson")
		q.Set("cache", s.DataVersion)
		httpx.WriteJSON(w, http.StatusOK, map[string]any{
			"tilejson": map[string]any{"url": []string{baseURL(r) + r.URL.Path + "?" + q.Encode()}},
			"schema":   p.schema,
		})
		return
	}
	tj, err := s.tileJSON(ctx, db, r, v, p)
	if err != nil {
		s.fail(ctx, w, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, tj)
}

func (s *Server) tileJSON(ctx context.Context, db *sql.DB, r *http.Request, v url.Values, p prepared) (map[string]any, error) {
	q := cloneValues(v)
	q.Del("format")
	q.Set("cache", s.DataVersion)
	base := baseURL(r) + r.URL.Path
	tj := map[string]any{"tilejson": "3.0.0", "schema": p.schema}

	var (
		b        [4]float64
		hasBound bool
		geometry string
		err      error
	)
	switch p.src.SpatialDataType {
	case source.Geo:
		if geometry, err = describe.GeometryType(ctx, db, p.rel, p.spatial, p.args); err != nil {
			return nil, queryError(err)
		}
		if b, hasBound, err = describe.GeoBounds(ctx, db, p.rel, p.spatial, p.args); err != nil {
			return nil, queryError(err)
		}
		q.Set("formatTiles", "mvt") // the client switches to its MVT decoder on this (ledger A4)
		tj["tiles"] = []string{base + "/{z}/{x}/{y}?" + q.Encode()}
		tj["minzoom"], tj["maxzoom"] = 0, 22
		fields := make(map[string]string, len(p.props))
		for _, c := range p.props {
			fields[c.Name] = c.Type
		}
		tj["vector_layers"] = []map[string]any{{"id": tiles.MVTLayer, "fields": fields}}
	case source.H3:
		res, _, err := describe.H3Resolution(ctx, db, p.rel, p.spatial, p.args)
		if err != nil {
			return nil, queryError(err)
		}
		if b, hasBound, err = describe.H3Bounds(ctx, db, p.rel, p.spatial, p.args); err != nil {
			return nil, queryError(err)
		}
		maxRes := res - p.src.AggregationResLevel
		if maxRes < 0 {
			maxRes = 0
		}
		tj["tiles"] = []string{base + "/{i}?" + q.Encode()}
		tj["minresolution"], tj["maxresolution"], tj["scheme"] = 0, maxRes, "h3"
	}
	stats, err := describe.Stats(ctx, db, p.rel, p.args, p.props, geometry)
	if err != nil {
		return nil, queryError(err)
	}
	tj["tilestats"] = stats
	if hasBound {
		tj["bounds"] = b[:]
		tj["center"] = []float64{(b[0] + b[2]) / 2, (b[1] + b[3]) / 2, 0}
	}
	return tj, nil
}

func (s *Server) handleMVT(w http.ResponseWriter, r *http.Request) {
	ctx, cancel, db, v, ok := s.begin(w, r)
	defer cancel()
	if !ok {
		return
	}
	z, errZ := strconv.Atoi(r.PathValue("z"))
	x, errX := strconv.Atoi(r.PathValue("x"))
	y, errY := strconv.Atoi(r.PathValue("y"))
	if errZ != nil || errX != nil || errY != nil || !tiles.ValidTile(z, x, y) {
		httpx.WriteError(w, http.StatusBadRequest, "invalid tile coordinates")
		return
	}
	p, err := s.prepare(ctx, db, r.PathValue("type"), v)
	if err != nil {
		s.fail(ctx, w, err)
		return
	}
	if p.src.SpatialDataType != source.Geo {
		httpx.WriteError(w, http.StatusBadRequest, "vector tiles need spatialDataType=geo")
		return
	}
	b, err := tiles.MVT(ctx, db, tiles.MVTRequest{
		Relation: p.rel, Args: p.args, GeomColumn: p.spatial, Props: p.props, FeatureID: p.featureID,
		Z: z, X: x, Y: y, MaxFeatures: s.MaxFeatures,
	})
	if err != nil {
		s.fail(ctx, w, queryErrorUnlessKnown(err))
		return
	}
	if len(b) == 0 {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	w.Header().Set("Content-Type", "application/vnd.mapbox-vector-tile")
	_, _ = w.Write(b)
}

func (s *Server) handleH3(w http.ResponseWriter, r *http.Request) {
	ctx, cancel, db, v, ok := s.begin(w, r)
	defer cancel()
	if !ok {
		return
	}
	cell, err := tiles.ParseH3(r.PathValue("cell"))
	if err != nil {
		s.fail(ctx, w, err)
		return
	}
	p, err := s.prepare(ctx, db, r.PathValue("type"), v)
	if err != nil {
		s.fail(ctx, w, err)
		return
	}
	if p.src.SpatialDataType != source.H3 {
		httpx.WriteError(w, http.StatusBadRequest, "cell tiles need spatialDataType=h3")
		return
	}
	dataRes, ok, err := describe.H3Resolution(ctx, db, p.rel, p.spatial, p.args)
	if err != nil {
		s.fail(ctx, w, queryError(err))
		return
	}
	if !ok {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	t, err := tiles.H3Tile(ctx, db, tiles.H3Request{
		Relation: p.rel, Args: p.args, CellColumn: p.spatial, AggregationExp: p.src.AggregationExp,
		AggregationResLevel: p.src.AggregationResLevel, DataRes: dataRes, Tile: cell,
	})
	if err != nil {
		s.fail(ctx, w, queryError(err))
		return
	}
	if len(t.Cells) == 0 {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	w.Header().Set("Content-Type", "application/vnd.carto-spatial-tile")
	_, _ = w.Write(t.Encode())
}

// queryError turns a DuckDB error caused by user input into a 400 with its first line only.
func queryError(err error) error {
	msg := err.Error()
	if i := strings.IndexByte(msg, '\n'); i >= 0 {
		msg = msg[:i]
	}
	msg = pathRe.ReplaceAllString(msg, "<path>") // spec §4.2: never echo server file paths
	if len(msg) > 300 {
		msg = msg[:300]
	}
	return fmt.Errorf("%w: %s", errQuery, msg)
}

func queryErrorUnlessKnown(err error) error {
	if errors.Is(err, tiles.ErrTooLarge) {
		return err
	}
	return queryError(err)
}

func (s *Server) fail(ctx context.Context, w http.ResponseWriter, err error) {
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

func cloneValues(v url.Values) url.Values {
	out := make(url.Values, len(v))
	for k, vs := range v {
		out[k] = append([]string(nil), vs...)
	}
	return out
}

// baseURL is the origin the client used; with the Vite proxy (changeOrigin off) that is the dev server.
func baseURL(r *http.Request) string {
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	if p := r.Header.Get("X-Forwarded-Proto"); p == "http" || p == "https" {
		scheme = p
	}
	host := r.Host
	if h := r.Header.Get("X-Forwarded-Host"); h != "" {
		host = h
	}
	return scheme + "://" + host
}
