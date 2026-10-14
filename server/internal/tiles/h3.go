package tiles

import (
	"context"
	"database/sql"
	"fmt"
	"math"
	"strconv"
	"strings"

	"osm-maps/server/internal/describe"
	"osm-maps/server/internal/source"
)

// H3Res returns the resolution encoded in bits 52–55 of an H3 index.
func H3Res(cell uint64) int { return int(cell>>52) & 0xF }

// ParseH3 parses a hexadecimal H3 cell index (mode 1) from a tile URL.
func ParseH3(s string) (uint64, error) {
	v, err := strconv.ParseUint(s, 16, 64)
	if err != nil || (v>>59)&0xF != 1 {
		return 0, fmt.Errorf("%w: invalid H3 cell %q", source.ErrBadRequest, s)
	}
	return v, nil
}

type H3Request struct {
	Relation            string
	Args                []any
	CellColumn          string // quoted
	AggregationExp      string
	AggregationResLevel int
	DataRes             int
	Tile                uint64
}

// H3Tile aggregates the source into cells at min(tileRes + AggregationResLevel, DataRes)
// that descend from r.Tile. Numeric result columns become NumericProps, all others Props.
func H3Tile(ctx context.Context, db *sql.DB, r H3Request) (SpatialTile, error) {
	tileRes := H3Res(r.Tile)
	if r.DataRes < tileRes {
		return SpatialTile{}, nil
	}
	res := tileRes + r.AggregationResLevel
	if res > r.DataRes {
		res = r.DataRes
	}
	agg := strings.TrimSpace(r.AggregationExp)
	if agg == "" {
		agg = "1 AS __aggregationValue"
	}
	q := fmt.Sprintf(`SELECT h3_cell_to_parent(%[1]s, %[2]d)::UBIGINT AS __cell, %[3]s
FROM %[4]s AS _r
WHERE %[1]s IS NOT NULL AND h3_cell_to_parent(%[1]s, %[5]d)::UBIGINT = $p__tile
GROUP BY 1 ORDER BY 1`, r.CellColumn, res, agg, r.Relation, tileRes)

	rows, err := db.QueryContext(ctx, q, append(append([]any{}, r.Args...), sql.Named("p__tile", r.Tile))...)
	if err != nil {
		return SpatialTile{}, err
	}
	defer rows.Close()
	types, err := rows.ColumnTypes()
	if err != nil {
		return SpatialTile{}, err
	}
	numeric := make([]bool, len(types))
	t := SpatialTile{NumericProps: map[string][]float64{}}
	for i := 1; i < len(types); i++ {
		if numeric[i] = describe.Kind(types[i].DatabaseTypeName()) == "number"; numeric[i] {
			t.NumericProps[types[i].Name()] = nil
		}
	}
	vals := make([]any, len(types))
	ptrs := make([]any, len(types))
	for i := range vals {
		ptrs[i] = &vals[i]
	}
	for rows.Next() {
		if err := rows.Scan(ptrs...); err != nil {
			return SpatialTile{}, err
		}
		cell, ok := vals[0].(uint64)
		if !ok {
			return SpatialTile{}, fmt.Errorf("h3 tile: unexpected cell type %T", vals[0])
		}
		t.Cells = append(t.Cells, cell)
		props := map[string]string{}
		for i := 1; i < len(vals); i++ {
			name := types[i].Name()
			if numeric[i] {
				f, ok := toFloat(vals[i])
				if !ok {
					f = math.NaN()
				}
				t.NumericProps[name] = append(t.NumericProps[name], f)
			} else if vals[i] != nil {
				props[name] = fmt.Sprint(vals[i])
			}
		}
		t.Props = append(t.Props, props)
	}
	return t, rows.Err()
}

func toFloat(v any) (float64, bool) {
	switch x := v.(type) {
	case float64:
		return x, true
	case float32:
		return float64(x), true
	case int64:
		return float64(x), true
	case int32:
		return float64(x), true
	case int16:
		return float64(x), true
	case int8:
		return float64(x), true
	case uint64:
		return float64(x), true
	case uint32:
		return float64(x), true
	case uint16:
		return float64(x), true
	case uint8:
		return float64(x), true
	case interface{ Float64() float64 }: // duckdb.Decimal
		return x.Float64(), true
	case fmt.Stringer: // *big.Int (HUGEINT, e.g. sum of BIGINT) and other numeric wrappers
		f, err := strconv.ParseFloat(x.String(), 64)
		return f, err == nil
	}
	return 0, false
}
