package modelapi

import (
	"context"
	"fmt"
	"strconv"
	"time"
)

// jsonValue converts a DuckDB scan value into something encoding/json writes sensibly.
func jsonValue(v any) any {
	switch x := v.(type) {
	case nil, bool, string, float64, float32, int, int8, int16, int32, int64, uint8, uint16, uint32, uint64:
		return x
	case []byte:
		return nil // blobs (raw geometry) are not JSON values
	case time.Time:
		return x.UTC().Format(time.RFC3339Nano)
	case interface{ Float64() float64 }: // duckdb.Decimal
		return x.Float64()
	case fmt.Stringer: // *big.Int (HUGEINT), UUID, …
		if f, err := strconv.ParseFloat(x.String(), 64); err == nil {
			return f
		}
		return x.String()
	case []any:
		out := make([]any, len(x))
		for i := range x {
			out[i] = jsonValue(x[i])
		}
		return out
	}
	return fmt.Sprint(v)
}

func toFloat(v any) float64 {
	switch x := jsonValue(v).(type) {
	case float64:
		return x
	case float32:
		return float64(x)
	case int64:
		return float64(x)
	case int32:
		return float64(x)
	case int:
		return float64(x)
	case uint64:
		return float64(x)
	case uint32:
		return float64(x)
	}
	return 0
}

// rows runs sqlText with the source args and returns every row as a column→value map.
func (q query) rows(ctx context.Context, sqlText string) ([]map[string]any, error) {
	rs, err := q.db.QueryContext(ctx, sqlText, q.args...)
	if err != nil {
		return nil, err
	}
	defer rs.Close()
	cols, err := rs.Columns()
	if err != nil {
		return nil, err
	}
	out := []map[string]any{}
	vals := make([]any, len(cols))
	ptrs := make([]any, len(cols))
	for i := range vals {
		ptrs[i] = &vals[i]
	}
	for rs.Next() {
		if err := rs.Scan(ptrs...); err != nil {
			return nil, err
		}
		m := make(map[string]any, len(cols))
		for i, c := range cols {
			m[c] = jsonValue(vals[i])
		}
		out = append(out, m)
	}
	return out, rs.Err()
}
