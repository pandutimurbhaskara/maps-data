package describe_test

import (
	"context"
	"math"
	"testing"

	"osm-maps/server/internal/describe"
	"osm-maps/server/internal/testdb"
)

func TestAttributeStats(t *testing.T) {
	db := testdb.Data(t)
	r, args := rel(t, nil)
	ctx := context.Background()

	num, err := describe.ColumnStats(ctx, db, r, args, describe.Column{Name: "value", Type: "number"}, 20)
	if err != nil {
		t.Fatal(err)
	}
	if num.Type != "Number" || *num.Min != 0 || *num.Max != 399 || *num.Avg != 199.5 || *num.Sum != 79800 {
		t.Fatalf("number stats = %+v", num)
	}
	q2 := num.Quantiles["2"]
	if len(q2) != 3 || q2[0] != 0 || q2[1] != 199.5 || q2[2] != 399 || len(num.Quantiles["10"]) != 11 {
		t.Fatalf("quantiles = %v", num.Quantiles)
	}
	if math.Abs(num.Quantiles["4"][1]-99.75) > 1e-9 {
		t.Fatalf("q4[1] = %v", num.Quantiles["4"][1])
	}

	str, err := describe.ColumnStats(ctx, db, r, args, describe.Column{Name: "category", Type: "string"}, 3)
	if err != nil {
		t.Fatal(err)
	}
	if str.Type != "String" || len(str.Categories) != 3 || str.Categories[0].Frequency != 100 || str.Min != nil {
		t.Fatalf("string stats = %+v", str)
	}
}
