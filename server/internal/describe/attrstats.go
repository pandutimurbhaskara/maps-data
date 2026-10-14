package describe

import (
	"context"
	"database/sql"
	"fmt"
	"strconv"
	"strings"
)

// AttrStats is the /v3/stats response for one attribute (spec M2 D3).
type AttrStats struct {
	Attribute  string               `json:"attribute"`
	Type       string               `json:"type"`
	Min        *float64             `json:"min,omitempty"`
	Max        *float64             `json:"max,omitempty"`
	Avg        *float64             `json:"avg,omitempty"`
	Sum        *float64             `json:"sum,omitempty"`
	Quantiles  map[string][]float64 `json:"quantiles,omitempty"`
	Categories []Category           `json:"categories,omitempty"`
}

const minQuantiles, maxQuantiles = 2, 10

// ColumnStats computes stats for one column: min/max/avg/sum/quantiles for numbers, top categories otherwise.
func ColumnStats(ctx context.Context, db *sql.DB, rel string, args []any, col Column, maxCategories int) (AttrStats, error) {
	out := AttrStats{Attribute: col.Name, Type: statsType(col.Type)}
	if col.Type != "number" {
		cats, err := topCategories(ctx, db, rel, col.Name, args, maxCategories)
		out.Categories = cats
		return out, err
	}
	x := "CAST(" + quote(col.Name) + " AS DOUBLE)"
	sel := []string{"min(" + x + ")", "max(" + x + ")", "avg(" + x + ")", "sum(" + x + ")"}
	for n := minQuantiles; n <= maxQuantiles; n++ {
		fracs := make([]string, n+1)
		for i := 0; i <= n; i++ {
			fracs[i] = strconv.FormatFloat(float64(i)/float64(n), 'f', -1, 64)
		}
		sel = append(sel, "quantile_cont("+x+", ["+strings.Join(fracs, ", ")+"])")
	}
	vals := make([]sql.NullFloat64, 4)
	lists := make([]any, maxQuantiles-minQuantiles+1)
	dest := []any{&vals[0], &vals[1], &vals[2], &vals[3]}
	for i := range lists {
		dest = append(dest, &lists[i])
	}
	q := "SELECT " + strings.Join(sel, ", ") + " FROM " + rel + " AS _r"
	if err := db.QueryRowContext(ctx, q, args...).Scan(dest...); err != nil {
		return out, err
	}
	ptr := func(v sql.NullFloat64) *float64 {
		if !v.Valid {
			return nil
		}
		f := v.Float64
		return &f
	}
	out.Min, out.Max, out.Avg, out.Sum = ptr(vals[0]), ptr(vals[1]), ptr(vals[2]), ptr(vals[3])
	if out.Min == nil {
		return out, nil // no non-null values
	}
	out.Quantiles = map[string][]float64{}
	for i, l := range lists {
		items, ok := l.([]any)
		if !ok {
			return out, fmt.Errorf("describe: quantiles scanned as %T", l)
		}
		qs := make([]float64, len(items))
		for j, it := range items {
			f, ok := it.(float64)
			if !ok {
				return out, fmt.Errorf("describe: quantile value %T", it)
			}
			qs[j] = f
		}
		out.Quantiles[strconv.Itoa(minQuantiles+i)] = qs
	}
	return out, nil
}

func topCategories(ctx context.Context, db *sql.DB, rel, col string, args []any, limit int) ([]Category, error) {
	if limit <= 0 {
		limit = 20
	}
	q := quote(col)
	rows, err := db.QueryContext(ctx, fmt.Sprintf("SELECT CAST(%s AS VARCHAR) AS c, count(*) AS n FROM %s AS _r WHERE %s IS NOT NULL GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT %d", q, rel, q, limit), args...)
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
