// Package workspace serves the maps and datasets REST API used by the web app.
package workspace

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"strconv"
	"strings"

	"github.com/google/uuid"

	"osm-maps/server/internal/auth"
	"osm-maps/server/internal/catalog"
	"osm-maps/server/internal/httpx"
	"osm-maps/server/internal/store"
)

// DefaultMapConfig is the keplerMapConfig of a new, empty map (centred on Tokyo Station).
const DefaultMapConfig = `{"version":"v1","config":{"mapState":{"latitude":35.681,"longitude":139.767,"zoom":11,"pitch":0,"bearing":0},"visState":{"layers":[]},"basemapConfig":{"styleId":"positron"}}}`

const maxBody = 5 << 20

type Connection struct {
	Name     string `json:"name"`
	Provider string `json:"provider"`
}

type Handler struct {
	Store       store.Store
	Connections []Connection
	// Resources lists a connection's spatial tables; nil disables the route (404).
	Resources func(ctx context.Context, conn string) ([]catalog.Resource, error)
}

func (h *Handler) Register(mux *http.ServeMux, prefix string) {
	mux.HandleFunc("GET "+prefix+"/maps", h.authed(h.listMaps))
	mux.HandleFunc("POST "+prefix+"/maps", h.authed(h.createMap))
	mux.HandleFunc("GET "+prefix+"/maps/{id}", h.authed(h.getMap))
	mux.HandleFunc("PATCH "+prefix+"/maps/{id}", h.authed(h.patchMap))
	mux.HandleFunc("DELETE "+prefix+"/maps/{id}", h.authed(h.deleteMap))
	mux.HandleFunc("GET "+prefix+"/maps/{id}/datasets", h.authed(h.listDatasets))
	mux.HandleFunc("POST "+prefix+"/maps/{id}/datasets", h.authed(h.createDataset))
	mux.HandleFunc("PATCH "+prefix+"/maps/{id}/datasets/{dsId}", h.authed(h.patchDataset))
	mux.HandleFunc("DELETE "+prefix+"/maps/{id}/datasets/{dsId}", h.authed(h.deleteDataset))
	mux.HandleFunc("GET "+prefix+"/connections", h.authed(h.listConnections))
	mux.HandleFunc("GET "+prefix+"/connections/{name}/resources", h.authed(h.listResources))
	mux.HandleFunc("GET /v3/maps/public/{id}", h.publicMap)
}

type handlerFunc func(w http.ResponseWriter, r *http.Request, user string)

func (h *Handler) authed(fn handlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user := auth.UserID(r.Context())
		if user == "" {
			httpx.WriteError(w, http.StatusUnauthorized, "authentication required")
			return
		}
		fn(w, r, user)
	}
}

func canRead(m store.Map, user string) bool {
	return m.OwnerID == user || m.Privacy == "shared" || m.Privacy == "public"
}

// loadMap returns the map if user may read it (and write it, when write is set).
// Unreadable maps answer 404 so their existence does not leak.
func (h *Handler) loadMap(w http.ResponseWriter, r *http.Request, user string, write bool) (store.Map, bool) {
	m, err := h.Store.GetMap(r.Context(), r.PathValue("id"))
	if err != nil || !canRead(m, user) {
		if err != nil && !errors.Is(err, store.ErrNotFound) {
			fail(w, err)
			return m, false
		}
		httpx.WriteError(w, http.StatusNotFound, "map not found")
		return m, false
	}
	if write && m.OwnerID != user {
		httpx.WriteError(w, http.StatusForbidden, "only the owner can change this map")
		return m, false
	}
	return m, true
}

func (h *Handler) listMaps(w http.ResponseWriter, r *http.Request, user string) {
	v := r.URL.Query()
	q := store.ListQuery{ViewerID: user, Search: v.Get("search"), OwnerID: v.Get("user_id"), OrderBy: "updated_at", Desc: true}
	var err error
	if q.Page, err = intParam(v.Get("page"), 1, 1, 1<<30); err != nil {
		badRequest(w, "page must be a positive integer")
		return
	}
	if q.PageSize, err = intParam(v.Get("page_size"), 12, 1, 100); err != nil {
		badRequest(w, "page_size must be 1..100")
		return
	}
	if s := v.Get("order_by"); s != "" {
		if s != "updated_at" && s != "title" {
			badRequest(w, "order_by must be updated_at or title")
			return
		}
		q.OrderBy = s
	}
	switch strings.ToUpper(v.Get("order_direction")) {
	case "", "DESC":
	case "ASC":
		q.Desc = false
	default:
		badRequest(w, "order_direction must be ASC or DESC")
		return
	}
	if p := v.Get("privacy"); p != "" {
		if !validPrivacy(p) {
			badRequest(w, "privacy must be private, shared or public")
			return
		}
		q.Privacy = p
	}
	maps, page, err := h.Store.ListMaps(r.Context(), q)
	if err != nil {
		fail(w, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"data": maps, "meta": map[string]any{"page": page}})
}

func (h *Handler) createMap(w http.ResponseWriter, r *http.Request, user string) {
	var body struct {
		Title           string          `json:"title"`
		Description     string          `json:"description"`
		Tags            []string        `json:"tags"`
		KeplerMapConfig json.RawMessage `json:"keplerMapConfig"`
		Collaborative   bool            `json:"collaborative"`
	}
	if !decode(w, r, &body) {
		return
	}
	if strings.TrimSpace(body.Title) == "" {
		body.Title = "Untitled map"
	}
	cfg := body.KeplerMapConfig
	if len(cfg) == 0 || string(cfg) == "null" {
		cfg = json.RawMessage(DefaultMapConfig)
	} else if !isObject(cfg) {
		badRequest(w, "keplerMapConfig must be a JSON object")
		return
	}
	m, err := h.Store.CreateMap(r.Context(), store.Map{
		OwnerID: user, Title: body.Title, Description: body.Description, Tags: body.Tags,
		Collaborative: body.Collaborative, KeplerMapConfig: cfg,
	})
	if err != nil {
		fail(w, err)
		return
	}
	httpx.WriteJSON(w, http.StatusCreated, m)
}

func (h *Handler) getMap(w http.ResponseWriter, r *http.Request, user string) {
	if m, ok := h.loadMap(w, r, user, false); ok {
		httpx.WriteJSON(w, http.StatusOK, m)
	}
}

func (h *Handler) patchMap(w http.ResponseWriter, r *http.Request, user string) {
	m, ok := h.loadMap(w, r, user, true)
	if !ok {
		return
	}
	var body struct {
		Title           *string         `json:"title"`
		Description     *string         `json:"description"`
		Tags            *[]string       `json:"tags"`
		KeplerMapConfig json.RawMessage `json:"keplerMapConfig"`
		Collaborative   *bool           `json:"collaborative"`
	}
	if !decode(w, r, &body) {
		return
	}
	if string(body.KeplerMapConfig) == "null" { // null means "unchanged", never "erase the document"
		body.KeplerMapConfig = nil
	}
	if body.Title != nil && (strings.TrimSpace(*body.Title) == "" || len(*body.Title) > 255) {
		badRequest(w, "title must be 1..255 characters")
		return
	}
	if len(body.KeplerMapConfig) > 0 && !isObject(body.KeplerMapConfig) {
		badRequest(w, "keplerMapConfig must be a JSON object")
		return
	}
	// privacy changes go through POST /maps/{id}/privacy (M3), so it is not patchable here
	upd, err := h.Store.UpdateMap(r.Context(), m.ID, store.MapPatch{
		Title: body.Title, Description: body.Description, Tags: body.Tags,
		Collaborative: body.Collaborative, KeplerMapConfig: body.KeplerMapConfig,
	})
	if err != nil {
		fail(w, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, upd)
}

func (h *Handler) deleteMap(w http.ResponseWriter, r *http.Request, user string) {
	m, ok := h.loadMap(w, r, user, true)
	if !ok {
		return
	}
	if err := h.Store.DeleteMap(r.Context(), m.ID); err != nil {
		fail(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) listDatasets(w http.ResponseWriter, r *http.Request, user string) {
	m, ok := h.loadMap(w, r, user, false)
	if !ok {
		return
	}
	ds, err := h.Store.ListDatasets(r.Context(), m.ID)
	if err != nil {
		fail(w, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, ds)
}

func (h *Handler) createDataset(w http.ResponseWriter, r *http.Request, user string) {
	m, ok := h.loadMap(w, r, user, true)
	if !ok {
		return
	}
	var doc map[string]any
	if !decode(w, r, &doc) {
		return
	}
	if id, _ := doc["id"].(string); id == "" {
		doc["id"] = uuid.NewString()
	}
	h.saveDataset(w, r, m.ID, doc, http.StatusCreated)
}

func (h *Handler) patchDataset(w http.ResponseWriter, r *http.Request, user string) {
	m, ok := h.loadMap(w, r, user, true)
	if !ok {
		return
	}
	existing, err := h.Store.ListDatasets(r.Context(), m.ID)
	if err != nil {
		fail(w, err)
		return
	}
	dsID := r.PathValue("dsId")
	var doc map[string]any
	for _, raw := range existing {
		var d map[string]any
		if json.Unmarshal(raw, &d) == nil && d["id"] == dsID {
			doc = d
		}
	}
	if doc == nil {
		httpx.WriteError(w, http.StatusNotFound, "dataset not found")
		return
	}
	var patch map[string]any
	if !decode(w, r, &patch) {
		return
	}
	for k, v := range patch { // shallow merge; the id is fixed by the URL
		if k != "id" {
			doc[k] = v
		}
	}
	h.saveDataset(w, r, m.ID, doc, http.StatusOK)
}

func (h *Handler) saveDataset(w http.ResponseWriter, r *http.Request, mapID string, doc map[string]any, status int) {
	if msg := h.validateDataset(doc); msg != "" {
		badRequest(w, msg)
		return
	}
	raw, _ := json.Marshal(doc)
	saved, err := h.Store.PutDataset(r.Context(), mapID, raw)
	if err != nil {
		fail(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(saved)
}

func (h *Handler) validateDataset(doc map[string]any) string {
	if t, _ := doc["type"].(string); t != "table" && t != "query" {
		return "dataset type must be table or query"
	}
	conn, _ := doc["connectionName"].(string)
	known := false
	for _, c := range h.Connections {
		known = known || c.Name == conn
	}
	if !known {
		return "unknown connectionName"
	}
	if s, _ := doc["source"].(string); strings.TrimSpace(s) == "" {
		return "dataset source is required"
	}
	return ""
}

func (h *Handler) deleteDataset(w http.ResponseWriter, r *http.Request, user string) {
	m, ok := h.loadMap(w, r, user, true)
	if !ok {
		return
	}
	if err := h.Store.DeleteDataset(r.Context(), m.ID, r.PathValue("dsId")); err != nil {
		fail(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) listConnections(w http.ResponseWriter, r *http.Request, _ string) {
	httpx.WriteJSON(w, http.StatusOK, h.Connections)
}

func (h *Handler) listResources(w http.ResponseWriter, r *http.Request, _ string) {
	if h.Resources == nil {
		httpx.WriteError(w, http.StatusNotFound, "connection not found")
		return
	}
	res, err := h.Resources(r.Context(), r.PathValue("name"))
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			httpx.WriteError(w, http.StatusNotFound, "connection not found")
			return
		}
		fail(w, err)
		return
	}
	if res == nil {
		res = []catalog.Resource{}
	}
	httpx.WriteJSON(w, http.StatusOK, res)
}

// publicMap serves a public map with its datasets embedded, without authentication (ledger M11).
func (h *Handler) publicMap(w http.ResponseWriter, r *http.Request) {
	m, err := h.Store.GetMap(r.Context(), r.PathValue("id"))
	if err != nil || m.Privacy != "public" {
		if err != nil && !errors.Is(err, store.ErrNotFound) {
			fail(w, err)
			return
		}
		httpx.WriteError(w, http.StatusNotFound, "map not found")
		return
	}
	ds, err := h.Store.ListDatasets(r.Context(), m.ID)
	if err != nil {
		fail(w, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, struct {
		store.Map
		Datasets []json.RawMessage `json:"datasets"`
	}{m, ds})
}

func decode(w http.ResponseWriter, r *http.Request, dst any) bool {
	err := json.NewDecoder(io.LimitReader(r.Body, maxBody)).Decode(dst)
	if err != nil && !errors.Is(err, io.EOF) {
		badRequest(w, "request body must be JSON: "+err.Error())
		return false
	}
	if m, ok := dst.(*map[string]any); ok && *m == nil {
		*m = map[string]any{}
	}
	return true
}

func isObject(raw json.RawMessage) bool {
	var v map[string]any
	return json.Unmarshal(raw, &v) == nil && v != nil
}

func intParam(s string, def, min, max int) (int, error) {
	if s == "" {
		return def, nil
	}
	n, err := strconv.Atoi(s)
	if err != nil || n < min || n > max {
		return 0, errors.New("out of range")
	}
	return n, nil
}

func validPrivacy(p string) bool { return p == "private" || p == "shared" || p == "public" }

func badRequest(w http.ResponseWriter, msg string) { httpx.WriteError(w, http.StatusBadRequest, msg) }

func fail(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, store.ErrNotFound):
		httpx.WriteError(w, http.StatusNotFound, "not found")
	case errors.Is(err, store.ErrInvalid):
		badRequest(w, err.Error())
	default:
		log.Printf("workspace: %v", err)
		httpx.WriteError(w, http.StatusInternalServerError, "internal error")
	}
}
