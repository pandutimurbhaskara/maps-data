package source

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strings"
)

// Filters is the CARTO filter object: column -> filter type -> spec (ledger D8).
type Filters map[string]map[string]FilterSpec

type FilterSpec struct {
	Values []json.RawMessage   `json:"values"`
	Params *StringSearchParams `json:"params,omitempty"`
	Owner  string              `json:"owner,omitempty"`
}

type StringSearchParams struct {
	UseRegExp     bool `json:"useRegExp"`
	MustStart     bool `json:"mustStart"`
	MustEnd       bool `json:"mustEnd"`
	CaseSensitive bool `json:"caseSensitive"`
}

// SQL returns a WHERE expression (without "WHERE") and its named args (p__f0, p__f1, …).
// Clauses for different columns are joined with AND, or with OR when or is true.
func (f Filters) SQL(or bool) (string, []any, error) {
	var (
		clauses []string
		args    []any
	)
	next := func(v any) string {
		name := fmt.Sprintf("%sf%d", InternalParamPrefix, len(args))
		args = append(args, sql.Named(name, v))
		return "$" + name
	}
	for _, col := range sortedKeys(f) {
		// Columns come from the source's own schema (custom SQL may alias "kind of place"), so quote rather than
		// restrict to plain identifiers; an unknown column fails in DuckDB's binder and maps to a 400.
		qc := QuoteIdent(col)
		for _, typ := range sortedKeys(f[col]) {
			c, err := filterClause(qc, typ, f[col][typ], next)
			if err != nil {
				return "", nil, err
			}
			clauses = append(clauses, "("+c+")")
		}
	}
	join := " AND "
	if or {
		join = " OR "
	}
	return strings.Join(clauses, join), args, nil
}

func filterClause(col, typ string, spec FilterSpec, next func(any) string) (string, error) {
	switch typ {
	case "in":
		vals, numeric, err := scalars(spec.Values)
		if err != nil {
			return "", err
		}
		if len(vals) == 0 {
			return "FALSE", nil
		}
		b, _ := json.Marshal(vals)
		if numeric {
			return fmt.Sprintf("list_contains(CAST(CAST(%s AS JSON) AS DOUBLE[]), CAST(%s AS DOUBLE))", next(string(b)), col), nil
		}
		return fmt.Sprintf("list_contains(CAST(CAST(%s AS JSON) AS VARCHAR[]), CAST(%s AS VARCHAR))", next(string(b)), col), nil
	case "between", "closed_open", "time":
		ranges, err := pairs(spec.Values)
		if err != nil {
			return "", err
		}
		if len(ranges) == 0 {
			return "FALSE", nil
		}
		expr, hi := col, "<="
		if typ == "time" {
			expr = "epoch_ms(CAST(" + col + " AS TIMESTAMP))"
		}
		if typ == "closed_open" {
			hi = "<"
		}
		ors := make([]string, len(ranges))
		for i, r := range ranges {
			ors[i] = fmt.Sprintf("%s >= %s AND %s %s %s", expr, next(r[0]), expr, hi, next(r[1]))
		}
		return strings.Join(ors, " OR "), nil
	case "stringSearch":
		strs, err := stringsOf(spec.Values)
		if err != nil {
			return "", err
		}
		if len(strs) == 0 {
			return "TRUE", nil
		}
		var p StringSearchParams
		if spec.Params != nil {
			p = *spec.Params
		}
		opts := "'i'"
		if p.CaseSensitive {
			opts = "''"
		}
		ors := make([]string, len(strs))
		for i, s := range strs {
			pat := s
			if !p.UseRegExp {
				pat = regexp.QuoteMeta(s)
			}
			if p.MustStart {
				pat = "^" + pat
			}
			if p.MustEnd {
				pat += "$"
			}
			ors[i] = fmt.Sprintf("regexp_matches(CAST(%s AS VARCHAR), %s, %s)", col, next(pat), opts)
		}
		return strings.Join(ors, " OR "), nil
	default:
		return "", fmt.Errorf("%w: unknown filter type %q", ErrBadRequest, typ)
	}
}

func scalars(raw []json.RawMessage) ([]any, bool, error) {
	vals := make([]any, 0, len(raw))
	numeric := len(raw) > 0
	for _, r := range raw {
		var v any
		if err := json.Unmarshal(r, &v); err != nil {
			return nil, false, fmt.Errorf("%w: filter value: %v", ErrBadRequest, err)
		}
		switch v.(type) {
		case float64:
		case string, bool:
			numeric = false
		default:
			return nil, false, fmt.Errorf("%w: filter values must be scalars", ErrBadRequest)
		}
		vals = append(vals, v)
	}
	return vals, numeric, nil
}

func pairs(raw []json.RawMessage) ([][2]float64, error) {
	out := make([][2]float64, 0, len(raw))
	for _, r := range raw {
		var p []float64
		if err := json.Unmarshal(r, &p); err != nil || len(p) != 2 {
			return nil, fmt.Errorf("%w: range filter values must be [min, max] number pairs", ErrBadRequest)
		}
		out = append(out, [2]float64{p[0], p[1]})
	}
	return out, nil
}

func stringsOf(raw []json.RawMessage) ([]string, error) {
	out := make([]string, 0, len(raw))
	for _, r := range raw {
		var s string
		if err := json.Unmarshal(r, &s); err != nil {
			return nil, fmt.Errorf("%w: stringSearch values must be strings", ErrBadRequest)
		}
		out = append(out, s)
	}
	return out, nil
}

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
