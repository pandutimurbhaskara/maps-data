package seed_test

import (
	"context"
	"testing"

	"osm-maps/server/internal/duck"
	"osm-maps/server/internal/seed"
)

func TestDemo(t *testing.T) {
	db, err := duck.Open(duck.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := seed.Demo(context.Background(), db); err != nil {
		t.Fatal(err)
	}
	var n, cats, res int
	if err := db.QueryRow(`SELECT count(*), count(DISTINCT category), min(h3_get_resolution(h3)) FROM demo_points`).Scan(&n, &cats, &res); err != nil {
		t.Fatal(err)
	}
	if n != 400 || cats != 4 || res != 12 {
		t.Fatalf("count=%d categories=%d res=%d, want 400 4 12", n, cats, res)
	}
	var name string
	if err := db.QueryRow(`SELECT name FROM demo_points WHERE id = 0`).Scan(&name); err != nil {
		t.Fatal(err)
	}
	if name != "東京駅" {
		t.Fatalf("name = %q", name)
	}
}
