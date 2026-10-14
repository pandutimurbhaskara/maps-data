package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"

	"osm-maps/server/internal/duck"
)

var schemaSQL = []string{
	`CREATE TABLE IF NOT EXISTS maps (
	   id VARCHAR PRIMARY KEY,
	   owner_id VARCHAR NOT NULL,
	   title VARCHAR NOT NULL,
	   description VARCHAR NOT NULL DEFAULT '',
	   tags VARCHAR NOT NULL DEFAULT '[]',
	   privacy VARCHAR NOT NULL DEFAULT 'private',
	   collaborative BOOLEAN NOT NULL DEFAULT false,
	   kepler_map_config VARCHAR NOT NULL,
	   thumbnail_url VARCHAR,
	   views BIGINT NOT NULL DEFAULT 0,
	   created_at TIMESTAMPTZ NOT NULL,
	   updated_at TIMESTAMPTZ NOT NULL)`,
	`CREATE TABLE IF NOT EXISTS datasets (
	   map_id VARCHAR NOT NULL,
	   id VARCHAR NOT NULL,
	   doc VARCHAR NOT NULL,
	   created_at TIMESTAMPTZ NOT NULL,
	   updated_at TIMESTAMPTZ NOT NULL,
	   PRIMARY KEY (map_id, id))`,
}

const summaryCols = "id, owner_id, title, description, tags, privacy, collaborative, thumbnail_url, views, created_at, updated_at"

type DuckStore struct {
	db  *sql.DB
	Now func() time.Time
	// mu serializes writes: DuckDB's optimistic concurrency aborts concurrent updates of one row
	// ("Conflict on update"), and this process is the only writer.
	mu sync.Mutex
}

func OpenDuck(ctx context.Context, path string) (*DuckStore, error) {
	db, err := duck.Open(duck.Options{Path: path})
	if err != nil {
		return nil, err
	}
	for _, q := range schemaSQL {
		if _, err := db.ExecContext(ctx, q); err != nil {
			db.Close()
			return nil, fmt.Errorf("store: migrate: %w", err)
		}
	}
	return &DuckStore{db: db, Now: func() time.Time { return time.Now().UTC() }}, nil
}

func (s *DuckStore) Close() error { return s.db.Close() }

type scanner interface{ Scan(...any) error }

func scanMap(row scanner, withConfig bool) (Map, error) {
	var (
		m    Map
		tags string
		cfg  string
	)
	dest := []any{&m.ID, &m.OwnerID, &m.Title, &m.Description, &tags, &m.Privacy, &m.Collaborative, &m.ThumbnailURL, &m.Views, &m.CreatedAt, &m.UpdatedAt}
	if withConfig {
		dest = append(dest, &cfg)
	}
	if err := row.Scan(dest...); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return Map{}, ErrNotFound
		}
		return Map{}, err
	}
	if err := json.Unmarshal([]byte(tags), &m.Tags); err != nil {
		return Map{}, fmt.Errorf("store: tags: %w", err)
	}
	if withConfig {
		m.KeplerMapConfig = json.RawMessage(cfg)
	}
	return m, nil
}

func (s *DuckStore) ListMaps(ctx context.Context, q ListQuery) ([]Map, Page, error) {
	if q.Page < 1 {
		q.Page = 1
	}
	if q.PageSize < 1 || q.PageSize > 100 {
		q.PageSize = 12
	}
	where := []string{"(owner_id = $viewer OR privacy IN ('shared', 'public'))"}
	args := []any{sql.Named("viewer", q.ViewerID)}
	if q.OwnerID != "" {
		where = append(where, "owner_id = $owner")
		args = append(args, sql.Named("owner", q.OwnerID))
	}
	if q.Privacy != "" {
		where = append(where, "privacy = $privacy")
		args = append(args, sql.Named("privacy", q.Privacy))
	}
	if q.Search != "" {
		where = append(where, "contains(lower(title), lower($search))") // literal match: no LIKE wildcards
		args = append(args, sql.Named("search", q.Search))
	}
	w := strings.Join(where, " AND ")

	var total int
	if err := s.db.QueryRowContext(ctx, "SELECT count(*) FROM maps WHERE "+w, args...).Scan(&total); err != nil {
		return nil, Page{}, err
	}
	order := "updated_at"
	if q.OrderBy == "title" {
		order = "lower(title)"
	}
	dir := "ASC"
	if q.Desc {
		dir = "DESC"
	}
	rows, err := s.db.QueryContext(ctx, fmt.Sprintf("SELECT %s FROM maps WHERE %s ORDER BY %s %s, id LIMIT %d OFFSET %d",
		summaryCols, w, order, dir, q.PageSize, (q.Page-1)*q.PageSize), args...)
	if err != nil {
		return nil, Page{}, err
	}
	defer rows.Close()
	maps := []Map{}
	for rows.Next() {
		m, err := scanMap(rows, false)
		if err != nil {
			return nil, Page{}, err
		}
		maps = append(maps, m)
	}
	page := Page{Total: total, Current: q.Page, PageSize: q.PageSize, TotalPages: (total + q.PageSize - 1) / q.PageSize}
	return maps, page, rows.Err()
}

func (s *DuckStore) CreateMap(ctx context.Context, m Map) (Map, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(m.KeplerMapConfig) == 0 {
		return Map{}, fmt.Errorf("%w: keplerMapConfig is required", ErrInvalid)
	}
	now := s.Now()
	m.ID, m.CreatedAt, m.UpdatedAt = uuid.NewString(), now, now
	if m.Tags == nil {
		m.Tags = []string{}
	}
	if m.Privacy == "" {
		m.Privacy = "private"
	}
	tags, _ := json.Marshal(m.Tags)
	_, err := s.db.ExecContext(ctx, `INSERT INTO maps (id, owner_id, title, description, tags, privacy, collaborative, kepler_map_config, thumbnail_url, views, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
		m.ID, m.OwnerID, m.Title, m.Description, string(tags), m.Privacy, m.Collaborative, string(m.KeplerMapConfig), m.ThumbnailURL, now, now)
	if err != nil {
		return Map{}, err
	}
	return m, nil
}

func (s *DuckStore) GetMap(ctx context.Context, id string) (Map, error) {
	return scanMap(s.db.QueryRowContext(ctx, "SELECT "+summaryCols+", kepler_map_config FROM maps WHERE id = ?", id), true)
}

func (s *DuckStore) UpdateMap(ctx context.Context, id string, p MapPatch) (Map, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	sets := []string{"updated_at = ?"}
	args := []any{s.Now()}
	add := func(col string, v any) { sets = append(sets, col+" = ?"); args = append(args, v) }
	if p.Title != nil {
		add("title", *p.Title)
	}
	if p.Description != nil {
		add("description", *p.Description)
	}
	if p.Privacy != nil {
		add("privacy", *p.Privacy)
	}
	if p.Tags != nil {
		b, _ := json.Marshal(*p.Tags)
		add("tags", string(b))
	}
	if p.Collaborative != nil {
		add("collaborative", *p.Collaborative)
	}
	if len(p.KeplerMapConfig) > 0 {
		add("kepler_map_config", string(p.KeplerMapConfig))
	}
	res, err := s.db.ExecContext(ctx, "UPDATE maps SET "+strings.Join(sets, ", ")+" WHERE id = ?", append(args, id)...)
	if err != nil {
		return Map{}, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return Map{}, ErrNotFound
	}
	return s.GetMap(ctx, id)
}

func (s *DuckStore) DeleteMap(ctx context.Context, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, "DELETE FROM datasets WHERE map_id = ?", id); err != nil {
		return err
	}
	res, err := tx.ExecContext(ctx, "DELETE FROM maps WHERE id = ?", id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return tx.Commit()
}

func (s *DuckStore) ListDatasets(ctx context.Context, mapID string) ([]json.RawMessage, error) {
	rows, err := s.db.QueryContext(ctx, "SELECT doc FROM datasets WHERE map_id = ? ORDER BY created_at, id", mapID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []json.RawMessage{}
	for rows.Next() {
		var doc string
		if err := rows.Scan(&doc); err != nil {
			return nil, err
		}
		out = append(out, json.RawMessage(doc))
	}
	return out, rows.Err()
}

func (s *DuckStore) PutDataset(ctx context.Context, mapID string, doc json.RawMessage) (json.RawMessage, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var head struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(doc, &head); err != nil || head.ID == "" {
		return nil, fmt.Errorf("%w: a dataset needs a string id", ErrInvalid)
	}
	var exists bool
	if err := s.db.QueryRowContext(ctx, "SELECT count(*) > 0 FROM maps WHERE id = ?", mapID).Scan(&exists); err != nil {
		return nil, err
	}
	if !exists {
		return nil, ErrNotFound
	}
	now := s.Now()
	_, err := s.db.ExecContext(ctx, `INSERT INTO datasets (map_id, id, doc, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
ON CONFLICT (map_id, id) DO UPDATE SET doc = excluded.doc, updated_at = excluded.updated_at`,
		mapID, head.ID, string(doc), now, now)
	if err != nil {
		return nil, err
	}
	return doc, nil
}

func (s *DuckStore) DeleteDataset(ctx context.Context, mapID, datasetID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	res, err := s.db.ExecContext(ctx, "DELETE FROM datasets WHERE map_id = ? AND id = ?", mapID, datasetID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}
