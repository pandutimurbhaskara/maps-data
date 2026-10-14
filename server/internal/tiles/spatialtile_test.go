package tiles_test

import (
	"encoding/hex"
	"math"
	"reflect"
	"testing"

	"osm-maps/server/internal/tiles"
)

func TestSpatialTileGolden(t *testing.T) {
	got := hex.EncodeToString(tiles.SpatialTile{Cells: []uint64{1}}.Encode())
	// Tile.2 len 14 { Cells.1 len 10 { Indices.1 len 8: 01 00.. } Cells.2 len 0 (empty props for cell 0) }
	want := "120e0a0a0a080100000000000000" + "1200"
	if got != want {
		t.Fatalf("encoding = %s, want %s", got, want)
	}
}

func TestSpatialTileRoundTrip(t *testing.T) {
	in := tiles.SpatialTile{
		Cells:        []uint64{0x8a2f5a32a8a7fff, 0x8a2f5a32a8b7fff},
		Props:        []map[string]string{{"cat": "cafe", "名前": "東京"}, {}},
		NumericProps: map[string][]float64{"n": {3, 4}, "avg": {1.5, math.NaN()}},
	}
	out, err := tiles.DecodeSpatialTile(in.Encode())
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(out.Cells, in.Cells) || !reflect.DeepEqual(out.Props, in.Props) {
		t.Fatalf("cells/props = %v %v", out.Cells, out.Props)
	}
	if !reflect.DeepEqual(out.NumericProps["n"], []float64{3, 4}) || out.NumericProps["avg"][0] != 1.5 || !math.IsNaN(out.NumericProps["avg"][1]) {
		t.Fatalf("numeric = %v", out.NumericProps)
	}
}
