package tiles_test

import (
	"context"
	"errors"
	"testing"

	"osm-maps/server/internal/source"
	"osm-maps/server/internal/testdb"
	"osm-maps/server/internal/tiles"
)

func TestParseH3(t *testing.T) {
	c, err := tiles.ParseH3("832a10fffffffff")
	if err != nil || tiles.H3Res(c) != 3 {
		t.Fatalf("ParseH3 = %x res %d, %v", c, tiles.H3Res(c), err)
	}
	for _, bad := range []string{"", "zz", "0", "ffffffffffffffff"} {
		if _, err := tiles.ParseH3(bad); !errors.Is(err, source.ErrBadRequest) {
			t.Errorf("ParseH3(%q) err = %v", bad, err)
		}
	}
}

func TestH3Tile(t *testing.T) {
	db := testdb.Data(t)
	ctx := context.Background()
	rel, args, err := source.Source{Type: source.TypeTable, Name: "demo_points", SpatialDataType: source.H3}.Relation()
	if err != nil {
		t.Fatal(err)
	}
	var parent uint64
	var want int
	if err := db.QueryRow(`SELECT h3_cell_to_parent(h3, 6)::UBIGINT FROM demo_points WHERE id = 0`).Scan(&parent); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`SELECT count(*) FROM demo_points WHERE h3_cell_to_parent(h3, 6)::UBIGINT = ?`, parent).Scan(&want); err != nil {
		t.Fatal(err)
	}

	tile, err := tiles.H3Tile(ctx, db, tiles.H3Request{
		Relation: rel, Args: args, CellColumn: `"h3"`,
		AggregationExp: "count(*) AS n, any_value(category) AS cat", AggregationResLevel: 4,
		DataRes: 12, Tile: parent,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(tile.Cells) == 0 || len(tile.Props) != len(tile.Cells) || len(tile.NumericProps["n"]) != len(tile.Cells) {
		t.Fatalf("tile shape: cells=%d props=%d n=%d", len(tile.Cells), len(tile.Props), len(tile.NumericProps["n"]))
	}
	sum := 0.0
	for i, c := range tile.Cells {
		if tiles.H3Res(c) != 10 {
			t.Fatalf("cell %x has res %d, want 10", c, tiles.H3Res(c))
		}
		if tile.Props[i]["cat"] == "" {
			t.Fatalf("cell %x has no cat", c)
		}
		sum += tile.NumericProps["n"][i]
	}
	if int(sum) != want {
		t.Fatalf("sum of n = %v, want %d", sum, want)
	}

	coarse, err := tiles.H3Tile(ctx, db, tiles.H3Request{Relation: rel, Args: args, CellColumn: `"h3"`, AggregationResLevel: 4, DataRes: 5, Tile: parent})
	if err != nil || len(coarse.Cells) != 0 {
		t.Fatalf("data coarser than tile: cells=%d err=%v", len(coarse.Cells), err)
	}
}
