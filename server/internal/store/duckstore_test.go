package store_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"testing"
	"time"

	"osm-maps/server/internal/store"
)

func open(t *testing.T) *store.DuckStore {
	t.Helper()
	s, err := store.OpenDuck(context.Background(), filepath.Join(t.TempDir(), "meta.duckdb"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	clock := time.Date(2026, 10, 14, 0, 0, 0, 0, time.UTC)
	s.Now = func() time.Time { clock = clock.Add(time.Second); return clock }
	return s
}

func create(t *testing.T, s *store.DuckStore, owner, title, privacy string) store.Map {
	t.Helper()
	m, err := s.CreateMap(context.Background(), store.Map{OwnerID: owner, Title: title, Privacy: privacy, KeplerMapConfig: json.RawMessage(`{"version":"v1","config":{}}`)})
	if err != nil {
		t.Fatal(err)
	}
	return m
}

func ptr[T any](v T) *T { return &v }

func TestCreateGetUpdateDelete(t *testing.T) {
	s := open(t)
	ctx := context.Background()
	m := create(t, s, "alice", "First", "")
	if m.ID == "" || m.Privacy != "private" || len(m.Tags) != 0 {
		t.Fatalf("created = %+v", m)
	}
	got, err := s.GetMap(ctx, m.ID)
	if err != nil || got.Title != "First" || string(got.KeplerMapConfig) != `{"version":"v1","config":{}}` {
		t.Fatalf("get = %+v, %v", got, err)
	}

	upd, err := s.UpdateMap(ctx, m.ID, store.MapPatch{Title: ptr("Renamed"), Tags: ptr([]string{"osm"})})
	if err != nil {
		t.Fatal(err)
	}
	if upd.Title != "Renamed" || upd.Tags[0] != "osm" || upd.Description != "" || !upd.UpdatedAt.After(got.UpdatedAt) {
		t.Fatalf("updated = %+v", upd)
	}

	if _, err := s.PutDataset(ctx, m.ID, json.RawMessage(`{"id":"ds1","type":"table","source":"demo_points"}`)); err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteMap(ctx, m.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.GetMap(ctx, m.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("get after delete: %v", err)
	}
	if ds, err := s.ListDatasets(ctx, m.ID); err != nil || len(ds) != 0 {
		t.Fatalf("datasets after delete: %v %v", ds, err)
	}
	if err := s.DeleteMap(ctx, m.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("second delete: %v", err)
	}
	if _, err := s.UpdateMap(ctx, "missing", store.MapPatch{Title: ptr("x")}); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("update missing: %v", err)
	}
}

func TestListMaps(t *testing.T) {
	s := open(t)
	ctx := context.Background()
	for i := 0; i < 13; i++ {
		create(t, s, "alice", fmt.Sprintf("Map %02d", i), "private")
	}
	create(t, s, "bob", "Bob private", "private")
	create(t, s, "bob", "Bob shared", "shared")
	create(t, s, "bob", "100%_literal", "public")

	maps, page, err := s.ListMaps(ctx, store.ListQuery{ViewerID: "alice", PageSize: 12, Desc: true})
	if err != nil {
		t.Fatal(err)
	}
	if page.Total != 15 || page.TotalPages != 2 || page.Current != 1 || len(maps) != 12 {
		t.Fatalf("page = %+v len=%d", page, len(maps))
	}
	if maps[0].Title != "100%_literal" || maps[0].KeplerMapConfig != nil {
		t.Fatalf("first (newest) = %+v", maps[0])
	}
	if _, p2, _ := s.ListMaps(ctx, store.ListQuery{ViewerID: "alice", PageSize: 12, Page: 2, Desc: true}); p2.Current != 2 {
		t.Fatalf("page 2 = %+v", p2)
	}

	byTitle, _, _ := s.ListMaps(ctx, store.ListQuery{ViewerID: "alice", OrderBy: "title", PageSize: 3})
	if byTitle[0].Title != "100%_literal" || byTitle[1].Title != "Bob shared" || byTitle[2].Title != "Map 00" {
		t.Fatalf("title order = %q %q %q", byTitle[0].Title, byTitle[1].Title, byTitle[2].Title)
	}

	for search, want := range map[string]int{"map 0": 10, "%": 1, "_": 1, "nothing": 0} {
		_, p, err := s.ListMaps(ctx, store.ListQuery{ViewerID: "alice", Search: search})
		if err != nil || p.Total != want {
			t.Errorf("search %q: total %d, want %d (%v)", search, p.Total, want, err)
		}
	}
	if _, p, _ := s.ListMaps(ctx, store.ListQuery{ViewerID: "alice", Privacy: "public"}); p.Total != 1 {
		t.Errorf("privacy=public total = %d", p.Total)
	}
	if _, p, _ := s.ListMaps(ctx, store.ListQuery{ViewerID: "alice", OwnerID: "alice"}); p.Total != 13 {
		t.Errorf("owner=alice total = %d", p.Total)
	}
}

func TestDatasets(t *testing.T) {
	s := open(t)
	ctx := context.Background()
	m := create(t, s, "alice", "M", "")
	for _, doc := range []string{`{"id":"a","label":"A"}`, `{"id":"b","label":"B"}`, `{"id":"a","label":"A2"}`} {
		if _, err := s.PutDataset(ctx, m.ID, json.RawMessage(doc)); err != nil {
			t.Fatal(err)
		}
	}
	ds, err := s.ListDatasets(ctx, m.ID)
	if err != nil || len(ds) != 2 || string(ds[0]) != `{"id":"a","label":"A2"}` {
		t.Fatalf("datasets = %s, %v", ds, err)
	}
	if _, err := s.PutDataset(ctx, m.ID, json.RawMessage(`{"label":"no id"}`)); !errors.Is(err, store.ErrInvalid) {
		t.Fatalf("no id: %v", err)
	}
	if _, err := s.PutDataset(ctx, "missing", json.RawMessage(`{"id":"x"}`)); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("missing map: %v", err)
	}
	if err := s.DeleteDataset(ctx, m.ID, "b"); err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteDataset(ctx, m.ID, "b"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("second delete: %v", err)
	}
}

// Review fix: concurrent writes to one row must not fail with DuckDB transaction conflicts.
func TestConcurrentWrites(t *testing.T) {
	s := open(t)
	ctx := context.Background()
	m := create(t, s, "alice", "M", "")
	errs := make(chan error, 32)
	for i := 0; i < 16; i++ {
		go func(i int) {
			_, err := s.UpdateMap(ctx, m.ID, store.MapPatch{Title: ptr(fmt.Sprintf("t%d", i))})
			errs <- err
		}(i)
		go func(i int) {
			_, err := s.PutDataset(ctx, m.ID, json.RawMessage(fmt.Sprintf(`{"id":"same","n":%d}`, i)))
			errs <- err
		}(i)
	}
	for i := 0; i < 32; i++ {
		if err := <-errs; err != nil {
			t.Errorf("concurrent write: %v", err)
		}
	}
}
