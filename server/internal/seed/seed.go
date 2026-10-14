// Package seed creates deterministic demo tables for tests and local development.
package seed

import (
	"context"
	"database/sql"
	"fmt"
)

const demoPointsSQL = `
CREATE OR REPLACE TABLE demo_points AS
SELECT
  i * 20 + j AS id,
  CASE WHEN i * 20 + j = 0 THEN '東京駅' ELSE 'poi-' || (i * 20 + j) END AS name,
  ['cafe', 'shop', 'park', 'school'][((i * 20 + j) % 4) + 1] AS category,
  (i * 20 + j)::DOUBLE AS value,
  TIMESTAMP '2026-01-01 00:00:00' + to_hours(i * 20 + j) AS ts,
  ST_Point(139.70 + j * 0.005, 35.65 + i * 0.005) AS geom,
  h3_latlng_to_cell(35.65 + i * 0.005, 139.70 + j * 0.005, 12)::UBIGINT AS h3
FROM range(20) r1(i), range(20) r2(j)`

// Demo creates demo_points: 400 points on a 20x20 grid over central Tokyo.
func Demo(ctx context.Context, db *sql.DB) error {
	if _, err := db.ExecContext(ctx, demoPointsSQL); err != nil {
		return fmt.Errorf("seed: demo_points: %w", err)
	}
	return nil
}
