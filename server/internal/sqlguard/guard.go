// Package sqlguard accepts only single SELECT statements, using DuckDB's own parser.
package sqlguard

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

var ErrNotSelect = errors.New("only a single SELECT statement is allowed")

// ValidateSelect parses q with json_serialize_sql, which serializes SELECT statements
// only and reports everything else (DDL, COPY, SET, ATTACH, syntax errors) as an error.
func ValidateSelect(ctx context.Context, db *sql.DB, q string) error {
	if strings.TrimSpace(q) == "" {
		return fmt.Errorf("%w: empty query", ErrNotSelect)
	}
	var out string
	if err := db.QueryRowContext(ctx, "SELECT CAST(json_serialize_sql(?::VARCHAR) AS VARCHAR)", q).Scan(&out); err != nil {
		return fmt.Errorf("%w: %v", ErrNotSelect, err)
	}
	var r struct {
		Error        bool              `json:"error"`
		ErrorMessage string            `json:"error_message"`
		Statements   []json.RawMessage `json:"statements"`
	}
	if err := json.Unmarshal([]byte(out), &r); err != nil {
		return fmt.Errorf("sqlguard: decode parser output: %w", err)
	}
	if r.Error {
		return fmt.Errorf("%w: %s", ErrNotSelect, r.ErrorMessage)
	}
	if len(r.Statements) != 1 {
		return fmt.Errorf("%w: got %d statements", ErrNotSelect, len(r.Statements))
	}
	return nil
}
