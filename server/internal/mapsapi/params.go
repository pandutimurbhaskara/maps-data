package mapsapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"osm-maps/server/internal/source"
)

// ParseParams merges the query string with a JSON object body (the client POSTs long requests, ledger A3).
func ParseParams(r *http.Request) (url.Values, error) {
	v := r.URL.Query()
	if r.Method != http.MethodPost {
		return v, nil
	}
	var body map[string]any
	dec := json.NewDecoder(io.LimitReader(r.Body, 1<<20))
	dec.UseNumber()
	if err := dec.Decode(&body); err != nil && !errors.Is(err, io.EOF) {
		return nil, fmt.Errorf("%w: body must be a JSON object: %v", source.ErrBadRequest, err)
	}
	for k, val := range body {
		switch t := val.(type) {
		case string:
			v.Set(k, t)
		case json.Number:
			v.Set(k, t.String())
		case bool:
			v.Set(k, strconv.FormatBool(t))
		case nil:
		default:
			b, _ := json.Marshal(t)
			v.Set(k, string(b))
		}
	}
	return v, nil
}

// SourceFrom builds a source.Source from request parameters (ledger A2).
func SourceFrom(typ string, v url.Values) (source.Source, error) {
	s := source.Source{
		Type:                source.Type(typ),
		Name:                v.Get("name"),
		Query:               v.Get("q"),
		SpatialDataType:     source.SpatialType(v.Get("spatialDataType")),
		SpatialDataColumn:   v.Get("spatialDataColumn"),
		AggregationExp:      v.Get("aggregationExp"),
		AggregationResLevel: source.DefaultAggregationResLevel,
		FiltersOr:           strings.EqualFold(v.Get("filtersLogicalOperator"), "or"),
	}
	if s.SpatialDataType == "" {
		s.SpatialDataType = source.Geo
	}
	if c := v.Get("columns"); c != "" {
		for _, name := range strings.Split(c, ",") {
			if name = strings.TrimSpace(name); name != "" {
				s.Columns = append(s.Columns, name)
			}
		}
	}
	if q := v.Get("queryParameters"); q != "" && q != "null" {
		if err := json.Unmarshal([]byte(q), &s.QueryParameters); err != nil {
			return s, fmt.Errorf("%w: queryParameters must be a JSON object of named parameters", source.ErrBadRequest)
		}
	}
	if f := v.Get("filters"); f != "" && f != "null" {
		if err := json.Unmarshal([]byte(f), &s.Filters); err != nil {
			return s, fmt.Errorf("%w: filters: %v", source.ErrBadRequest, err)
		}
	}
	if a := v.Get("aggregationResLevel"); a != "" {
		n, err := strconv.Atoi(a)
		if err != nil {
			return s, fmt.Errorf("%w: aggregationResLevel must be an integer", source.ErrBadRequest)
		}
		s.AggregationResLevel = n
	}
	return s, s.Validate()
}
