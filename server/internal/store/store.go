// Package store persists maps and their datasets.
package store

import (
	"context"
	"encoding/json"
	"errors"
	"time"
)

var (
	ErrNotFound = errors.New("not found")
	ErrInvalid  = errors.New("invalid")
)

type Map struct {
	ID              string          `json:"id"`
	Title           string          `json:"title"`
	Description     string          `json:"description"`
	Tags            []string        `json:"tags"`
	Privacy         string          `json:"privacy"`
	Collaborative   bool            `json:"collaborative"`
	OwnerID         string          `json:"ownerId"`
	CreatedAt       time.Time       `json:"createdAt"`
	UpdatedAt       time.Time       `json:"updatedAt"`
	ThumbnailURL    *string         `json:"thumbnailUrl"`
	Views           int64           `json:"views"`
	KeplerMapConfig json.RawMessage `json:"keplerMapConfig,omitempty"`
}

type MapPatch struct {
	Title, Description, Privacy *string
	Tags                        *[]string
	Collaborative               *bool
	KeplerMapConfig             json.RawMessage
}

type ListQuery struct {
	Page, PageSize int
	Search         string
	OrderBy        string // "updated_at" (default) or "title"
	Desc           bool
	Privacy        string
	OwnerID        string
	ViewerID       string // sees own maps plus shared and public ones
}

type Page struct {
	Total      int `json:"total"`
	Current    int `json:"current"`
	PageSize   int `json:"pageSize"`
	TotalPages int `json:"totalPages"`
}

type Store interface {
	ListMaps(ctx context.Context, q ListQuery) ([]Map, Page, error)
	CreateMap(ctx context.Context, m Map) (Map, error)
	GetMap(ctx context.Context, id string) (Map, error)
	UpdateMap(ctx context.Context, id string, p MapPatch) (Map, error)
	DeleteMap(ctx context.Context, id string) error
	ListDatasets(ctx context.Context, mapID string) ([]json.RawMessage, error)
	PutDataset(ctx context.Context, mapID string, doc json.RawMessage) (json.RawMessage, error) // upsert by doc.id
	DeleteDataset(ctx context.Context, mapID, datasetID string) error
}
