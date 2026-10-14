package modelapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"

	"osm-maps/server/internal/describe"
	"osm-maps/server/internal/source"
	"osm-maps/server/internal/sqlguard"
)

// params is the union of every model's `params` object (ledger A9, @carto/api-client WidgetRemoteSource).
type params struct {
	Column          json.RawMessage `json:"column"` // string, or []string for table
	Operation       string          `json:"operation"`
	OperationExp    string          `json:"operationExp"`
	OperationColumn string          `json:"operationColumn"`
	OthersThreshold int             `json:"othersThreshold"`
	OrderBy         string          `json:"orderBy"`
	Ticks           []float64       `json:"ticks"`
	SortBy          string          `json:"sortBy"`
	SortDirection   string          `json:"sortDirection"`
	Limit           int             `json:"limit"`
	Offset          int             `json:"offset"`
	StepSize        string          `json:"stepSize"`
	StepMultiplier  int             `json:"stepMultiplier"`
	SplitByCategory string          `json:"splitByCategory"`
}

func (p params) columnName() string {
	var s string
	if json.Unmarshal(p.Column, &s) == nil {
		return s
	}
	return ""
}

func (p params) columnList() []string {
	var l []string
	if json.Unmarshal(p.Column, &l) == nil {
		return l
	}
	if s := p.columnName(); s != "" {
		return []string{s}
	}
	return nil
}

type query struct {
	db   *sql.DB
	rel  string
	args []any
	cols map[string]describe.Column
}

type modelFunc func(ctx context.Context, q query, p params) (any, error)

var models = map[string]modelFunc{
	"formula":  formula,
	"range":    rangeModel,
	"category": category,
}

func bad(format string, a ...any) error {
	return fmt.Errorf("%w: "+format, append([]any{source.ErrBadRequest}, a...)...)
}

func quote(name string) string { return `"` + strings.ReplaceAll(name, `"`, `""`) + `"` }

func (q query) column(name string) (string, describe.Column, error) {
	c, ok := q.cols[name]
	if !ok {
		return "", c, bad("unknown column %q", name)
	}
	return quote(name), c, nil
}

// aggregate returns the SQL aggregate for a widget operation over column (spec M2 D3).
func (q query) aggregate(ctx context.Context, op, column, exp string) (string, error) {
	switch op {
	case "", "count":
		if column == "" || column == "*" {
			return "count(*)", nil
		}
		c, _, err := q.column(column)
		return "count(" + c + ")", err
	case "avg", "min", "max", "sum":
		c, _, err := q.column(column)
		if err != nil {
			return "", err
		}
		return op + "(CAST(" + c + " AS DOUBLE))", nil
	case "custom":
		if strings.TrimSpace(exp) == "" {
			return "", bad("operationExp is required for custom operation")
		}
		if err := sqlguard.ValidateSelect(ctx, q.db, "SELECT "+exp); err != nil {
			return "", err
		}
		return "(" + exp + ")", nil
	}
	return "", bad("unsupported operation %q", op)
}

func formula(ctx context.Context, q query, p params) (any, error) {
	agg, err := q.aggregate(ctx, p.Operation, p.columnName(), p.OperationExp)
	if err != nil {
		return nil, err
	}
	rows, err := q.rows(ctx, "SELECT "+agg+" AS value FROM "+q.rel+" AS _r")
	return map[string]any{"rows": rows}, err
}

func rangeModel(ctx context.Context, q query, p params) (any, error) {
	c, _, err := q.column(p.columnName())
	if err != nil {
		return nil, err
	}
	x := "CAST(" + c + " AS DOUBLE)"
	rows, err := q.rows(ctx, "SELECT min("+x+") AS min, max("+x+") AS max FROM "+q.rel+" AS _r")
	return map[string]any{"rows": rows}, err
}

func category(ctx context.Context, q query, p params) (any, error) {
	col := p.columnName()
	c, _, err := q.column(col)
	if err != nil {
		return nil, err
	}
	opCol := p.OperationColumn
	if opCol == "" || p.Operation == "" || p.Operation == "count" {
		opCol = "*" // count rows per category, not non-null values of the column
	}
	agg, err := q.aggregate(ctx, p.Operation, opCol, p.OperationExp)
	if err != nil {
		return nil, err
	}
	order := map[string]string{
		"":                  "value DESC NULLS LAST, name",
		"frequency_desc":    "value DESC NULLS LAST, name",
		"frequency_asc":     "value ASC NULLS LAST, name",
		"alphabetical_asc":  "name ASC NULLS LAST",
		"alphabetical_desc": "name DESC NULLS LAST",
	}[p.OrderBy]
	if order == "" {
		return nil, bad("unsupported orderBy %q", p.OrderBy)
	}
	rows, err := q.rows(ctx, "SELECT CAST("+c+" AS VARCHAR) AS name, "+agg+" AS value FROM "+q.rel+" AS _r GROUP BY 1 ORDER BY "+order)
	if err != nil {
		return nil, err
	}
	meta := map[string]any{}
	if p.OthersThreshold > 0 {
		others := 0.0
		if len(rows) > p.OthersThreshold {
			for _, r := range rows[p.OthersThreshold:] {
				others += toFloat(r["value"])
			}
			rows = rows[:p.OthersThreshold]
		}
		meta["others"] = others
	}
	return map[string]any{"rows": rows, "metadata": meta}, nil
}
