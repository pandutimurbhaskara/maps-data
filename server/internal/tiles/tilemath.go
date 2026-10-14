// Package tiles encodes vector (MVT) and spatial-index (H3) tiles from DuckDB.
package tiles

import "math"

const maxZoom = 24

// TileBounds returns the WGS84 bounding box of an XYZ (slippy map) tile.
func TileBounds(z, x, y int) (minLon, minLat, maxLon, maxLat float64) {
	n := math.Exp2(float64(z))
	minLon = float64(x)/n*360 - 180
	maxLon = float64(x+1)/n*360 - 180
	maxLat = tileLat(float64(y), n)
	minLat = tileLat(float64(y+1), n)
	return
}

func tileLat(y, n float64) float64 {
	return math.Atan(math.Sinh(math.Pi*(1-2*y/n))) * 180 / math.Pi
}

func ValidTile(z, x, y int) bool {
	if z < 0 || z > maxZoom {
		return false
	}
	n := 1 << z
	return x >= 0 && x < n && y >= 0 && y < n
}

// LonLatToTile returns the XYZ tile containing a WGS84 point at zoom z.
func LonLatToTile(lon, lat float64, z int) (x, y int) {
	n := math.Exp2(float64(z))
	r := lat * math.Pi / 180
	x = int(math.Floor((lon + 180) / 360 * n))
	y = int(math.Floor((1 - math.Log(math.Tan(r)+1/math.Cos(r))/math.Pi) / 2 * n))
	return
}
