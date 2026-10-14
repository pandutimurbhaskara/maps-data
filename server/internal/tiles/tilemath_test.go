package tiles_test

import (
	"math"
	"testing"

	"osm-maps/server/internal/tiles"
)

func near(a, b float64) bool { return math.Abs(a-b) < 1e-4 }

func TestTileBounds(t *testing.T) {
	w, s, e, n := tiles.TileBounds(0, 0, 0)
	if !near(w, -180) || !near(e, 180) || !near(s, -85.05113) || !near(n, 85.05113) {
		t.Fatalf("0/0/0 = %v %v %v %v", w, s, e, n)
	}
	w, s, e, n = tiles.TileBounds(1, 1, 0)
	if !near(w, 0) || !near(e, 180) || !near(s, 0) || !near(n, 85.05113) {
		t.Fatalf("1/1/0 = %v %v %v %v", w, s, e, n)
	}
}

func TestLonLatToTileRoundTrip(t *testing.T) {
	x, y := tiles.LonLatToTile(139.75, 35.7, 12)
	w, s, e, n := tiles.TileBounds(12, x, y)
	if 139.75 < w || 139.75 > e || 35.7 < s || 35.7 > n {
		t.Fatalf("point not inside its tile %d/%d: %v %v %v %v", x, y, w, s, e, n)
	}
}

func TestValidTile(t *testing.T) {
	for _, c := range [][3]int{{0, 0, 0}, {3, 7, 7}, {22, 0, 4194303}} {
		if !tiles.ValidTile(c[0], c[1], c[2]) {
			t.Errorf("%v should be valid", c)
		}
	}
	for _, c := range [][3]int{{-1, 0, 0}, {25, 0, 0}, {3, 8, 0}, {3, 0, -1}} {
		if tiles.ValidTile(c[0], c[1], c[2]) {
			t.Errorf("%v should be invalid", c)
		}
	}
}
