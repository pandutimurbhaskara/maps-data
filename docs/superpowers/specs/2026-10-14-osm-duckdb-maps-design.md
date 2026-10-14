# OSM + DuckDB "Maps" platform: design spec

Status: draft for review · Date: 2026-10-14
Evidence: [`docs/re/2026-10-14-carto-maps-findings-ledger.md`](../../re/2026-10-14-carto-maps-findings-ledger.md)
(finding IDs such as `A4` and `M1` below refer to that ledger).

## 1. Goal

Build a self-hostable, full-stack clone of CARTO Workspace **Maps**: the map list page, the
map document, the Builder/viewer, and the Data API that serves tiles and widget numbers.
The data side uses **OpenStreetMap** data, the warehouse is **DuckDB**, and the basemap and
geocoder are OSM-derived. It is a functional reimplementation from observed behavior. It is
not a copy of CARTO's code.

### What "reverse engineer fullstack" means here

CARTO's server is closed and runs against the customer's warehouse (F4). We can only observe
its **contract** (URLs, parameters, document shapes) and the shipped frontend. So:

1. **Frontend:** a new React app that implements the same UX surface (L1–L8, D1–D11).
2. **Backend:** a new Go service that implements a **compatible subset of the Data API v3**
   (A1–A9), plus a workspace REST API for maps (M1–M11).
3. **Key decision: wire compatibility with the open-source CARTO client.** `@deck.gl/carto`
   and `@carto/api-client` are MIT-licensed. They already speak A1–A9, including
   `authMode:"session"` (A8) and MVT tiles when the server says `formatTiles=mvt` (A4). If our
   server matches that contract, we get CARTO's tested layers (VectorTileLayer, H3TileLayer,
   widget sources) for free, and we have an objective compatibility test.

## 2. Non-goals (v1)

- CARTO's proprietary "binary" vector-tile format (we serve MVT, which the client supports, A4)
- Multi-warehouse connections (BigQuery, Snowflake, …). The only connection type is `duckdb`.
- Workflows, Data Observatory, AI agent, Google basemaps, Auth0/SSO, billing/quota, HubSpot,
  LaunchDarkly, TrackJS, Vitally
- Real-time collaborative editing (M7 lock/take-over). Versions (M6) are in M3, but not live co-editing.
- Pre-generated tilesets and rasters (`tileset`/`raster` dataset types, A10). Dynamic tiling only.

## 3. Constraints and legal hygiene

- Do **not** copy CARTO's minified code, zod schema text, i18n strings, icons or CSS. Re-derive
  types from the ledger and from the MIT-licensed SDK type definitions.
- Do not use the "CARTO" name or logo in the product. The working name is **`osm-maps`**.
- OSM data is ODbL. Every map must show "© OpenStreetMap contributors". Derived databases
  produced by `osm-ingest` are ODbL "derivative databases" when redistributed.
- Basemap tiles: use OpenFreeMap (free, OSM-based, no key) for dev, and self-hosted Protomaps
  PMTiles for production. Do not hotlink `basemaps.cartocdn.com`.
- Before going further, check CARTO's Terms of Service for any reverse-engineering clause on
  the trial account. That decision belongs to the account owner.

## 4. Architecture

```
┌──────────────── web (Vite + React + TS) ────────────────┐
│ /maps            list page (grid/list, search, sort,    │
│                  privacy filter, paging, card menu)     │
│ /viewer/:id      read-only map  ─┐                      │
│ /builder/:id     editor (M2)     ├─ deck.gl 9.3 +       │
│ /map/:id         public map      │  @deck.gl/carto +    │
│                                  │  MapLibre basemap    │
└──────────┬───────────────────────┴─────────┬────────────┘
           │ same origin (Vite proxy in dev; one binary in prod)
┌──────────▼──────────── mapsd (Go) ─────────▼────────────┐
│ /api/workspace/*  maps, datasets, (M3: privacy,         │
│                   publish, clone, versions, comments,   │
│                   folders, thumbnails)                  │
│ /v3/maps/{conn}/{table|query}[/{z}/{x}/{y} | /{h3}]     │
│ /v3/maps/public/{id}                                    │
│ /v3/sql/{conn}/model/{name}   (M2)                      │
│ /v3/lds/geocoding/geocode     (M2, DuckDB FTS)          │
├──────────────────┬───────────────────────────────────────┤
│ meta.duckdb (RW) │ data.duckdb (READ_ONLY, sandboxed)    │
│ maps, datasets,  │ osm_points / osm_lines / osm_polygons │
│ users, versions… │ + user tables; spatial + h3 + fts ext │
└──────────────────┴──────────────────▲────────────────────┘
                                      │ offline
                          osm-ingest (Go): .osm.pbf ─ST_ReadOSM→ tables
```

### 4.1 Why DuckDB in both places

- **data.duckdb** is the warehouse. Requires DuckDB ≥ 1.4, which ships `ST_AsMVT`,
  `ST_AsMVTGeom` and `ST_TileEnvelope` (merged Sept 2025, available from 1.4.0). It also uses
  the `spatial` extension (`ST_ReadOSM`, `ST_Transform`, R-tree), the `h3` community
  extension, and `json` (`json_serialize_sql` for the SELECT-only guard). It is opened
  `READ_ONLY`, with `enable_external_access=false` and `lock_configuration=true`. User SQL
  therefore cannot read files, attach databases or write.
- **meta.duckdb** stores maps and other metadata. A single Go process is the only writer, and
  DuckDB transactions are ACID, so this is enough for one node. Everything goes through a
  `Store` interface, so it can move to Postgres later without touching handlers. **Risk:**
  DuckDB is not built for many concurrent small writes. Revisit if write latency or multiple
  replicas become a requirement.
- Per-request connections from `database/sql`'s pool. Never share one `*sql.Conn` across
  concurrent tile requests (a known failure mode under parallel load).

### 4.2 Data API contract (compatibility target)

All endpoints accept the source parameters as query-string params, or as a JSON object body on
`POST` (A3).

**Source parameters (A2):**

| param | type | notes |
|---|---|---|
| `name` | identifier `schema.table` or `table` | `type=table` only. Validated against `^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$` |
| `q` | SQL | `type=query` only. Must pass the SELECT-only guard. DuckDB named params `$name`. |
| `queryParameters` | JSON object | Scalars are bound as-is. Arrays and objects are bound as JSON text (the query casts them, e.g. `CAST(CAST($state AS JSON) AS VARCHAR[])`). |
| `spatialDataType` | `geo` \| `h3` | `quadbin` → 400 in v1 |
| `spatialDataColumn` | identifier | default `geom` for geo, `h3` for h3 |
| `columns` | comma list | property columns to put in tiles. `_carto_feature_id` is synthesized. |
| `filters` | JSON (D8) | `in`, `between`, `closed_open`, `time`, `stringSearch` |
| `filtersLogicalOperator` | `and` \| `or` | default `and` |
| `aggregationExp` | SQL select-list fragment | h3 only, e.g. `sum(n) AS n_sum` |
| `aggregationResLevel` | int 0–15 | h3 only, default 4 |
| `client`, `v`, `deckglVersion`, `tag-*`, `cache`, `tileResolution`, `featureBbox` | ignored | accepted, never rejected |

**Endpoints:**

1. `GET|POST /v3/maps/{conn}/{type}` → `200 {"tilejson":{"url":[U]},"schema":[{"name","type"}]}`.
   `U` = the same path and params, plus `format=tilejson&cache=<dataVersion>`.
2. `GET /v3/maps/{conn}/{type}?…&format=tilejson` → TileJSON 3.0.0:
   - geo: `tiles:["…/{z}/{x}/{y}?…&formatTiles=mvt"]`, `minzoom 0`, `maxzoom 22`, `bounds`,
     `center`, `vector_layers:[{id:"default",fields}]`, `tilestats`, `schema`.
   - h3: `tiles:["…/{i}?…"]`, `minresolution 0`, `maxresolution = dataRes − aggregationResLevel`
     (clamped ≥ 0), `bounds`, `tilestats`, `schema`.
   - `tilestats = {layerCount:1, layers:[{layer:"default", count, geometry, attributeCount,
     attributes:[{attribute, type:"Number"|"String"|"Boolean"|"Date", min?, max?, categories?:[{category,frequency}]}]}]}`
3. `GET /v3/maps/{conn}/{type}/{z}/{x}/{y}` → `application/vnd.mapbox-vector-tile` (layer
   `default`, extent 4096, buffer 256, EPSG:3857). Returns `204` when the tile is empty.
4. `GET /v3/maps/{conn}/{type}/{h3index}` → `application/vnd.carto-spatial-tile`, protobuf per
   ledger A6. Cells are `h3_cell_to_parent(col, min(tileRes + aggregationResLevel, dataRes))`,
   restricted to descendants of `{h3index}`, grouped, with `aggregationExp` evaluated per cell.
   String results go to `properties[i]` and numeric results to `numericProps`.
   (U2: our semantics, validated by the contract test.)
5. `GET /v3/maps/public/{mapId}` → the map document + `datasets[]`, only when `privacy=public`.
6. M2: `GET|POST /v3/sql/{conn}/model/{formula|category|histogram|range|timeseries|table}`.
   Request per A9. Response shapes taken from `@carto/api-client` types (U3).

**Errors:** `{"error": "<message>", "status": <code>}` with 400 (bad params / SQL rejected),
401, 403, 404, 408 (query timeout), 500. Never echo SQL errors that include file paths.

**Limits:** per-query timeout 15 s (context cancel → DuckDB interrupt). Max tile features:
200 000 (more → 400 "tile too large, add aggregation"). `memory_limit` and `threads`
configurable.

### 4.3 Workspace API (`/api/workspace`)

JSON uses camelCase, mirroring M11, so the frontend can treat the CARTO shapes as reference.

| Milestone | Endpoint |
|---|---|
| M1 | `GET /maps?page&page_size&search&order_by(updated_at\|title)&order_direction(ASC\|DESC)&privacy&user_id` → `{data:[MapSummary], meta:{page:{total,current,pageSize,totalPages}}}` |
| M1 | `POST /maps` {title?, description?, tags?, keplerMapConfig?, collaborative?} → 201 Map |
| M1 | `GET /maps/{id}`, `PATCH /maps/{id}` (partial), `DELETE /maps/{id}` → 204 |
| M1 | `GET/POST /maps/{id}/datasets`, `PATCH/DELETE /maps/{id}/datasets/{dsId}` |
| M1 | `GET /connections` → `[{name:"osm", provider:"duckdb"}]` |
| M3 | `POST /maps/{id}/privacy {privacy, publicPassword?}`, `POST /maps/{id}/publish` |
| M3 | `POST /maps/{id}/clone`, `GET/POST /maps/{id}/versions`, `POST …/versions/{vid}/restore` |
| M3 | `POST /storage/sign` + `PUT /storage/thumbnails/{id}.png` (local disk / S3 adapter) |
| M3 | `/maps/{id}/comments`, `/folders`, `/folders/entries`, `PATCH /entries` |

**Map:** `{id, title, description, tags[], privacy, collaborative, ownerId, createdAt,
updatedAt, thumbnailUrl, views, keplerMapConfig}`. `MapSummary` = Map without `keplerMapConfig`.

**Dataset:** stored as an opaque JSON document validated for the required keys
`{id, type:"table"|"query", label, connectionName, source, geoColumn?, spatialIndex?:
"h3"|null, columns?, queryTemplate?, queryParameters?, aggregationExp?, aggregationResLevel?}`.
The `source` of a `query` dataset is DuckDB SQL **already compiled** from `queryTemplate`
(D9; the compiler lives in the web app, M2).

**Authorization (v1):** every request has a user. In M1 the user comes from a dev
middleware (fixed user from config). In M3 it comes from a session (local users table,
argon2id passwords, HttpOnly SameSite=Lax cookie). Owners can mutate. Readers are the owner,
plus any user for `shared`, plus anyone (unauthenticated) for `public` via the public endpoint.

### 4.4 Map document

The canonical type is a TypeScript subset of D1, defined in `web/src/lib/mapDoc.ts` and
grown each milestone:

- M1 renders `mapState`, `visState.layers[]` of type `tileset` and `h3`, `config.color`,
  `visConfig.opacity/radius/filled/stroked/strokeColor`, and `basemapConfig.styleId`.
- M2 adds visualChannels + colorRange (quantize/quantile/ordinal/custom), widgets, filters,
  sqlParameters, popups, legends, layerGrouping and mapSettings.
- Unknown keys are preserved on round-trip (the server stores the JSON blob unchanged).

### 4.5 OSM ingestion (`osm-ingest`)

`osm-ingest -pbf <file.osm.pbf> -out data.duckdb`:

1. `osm_raw ← ST_ReadOSM(pbf)` (nodes, ways, relations, with tags as a MAP).
2. `osm_points`: tagged nodes → `geom POINT`, `h3 UBIGINT` (res 12), plus columns `name,
   amenity, shop, tourism`, and `tags`.
3. Way geometry: unnest `refs` with ordinality → join node coords → `ST_MakeLine`.
4. `osm_polygons`: closed ways (≥ 4 refs, first = last) whose tags imply an area (`building`,
   `landuse`, `leisure`, `amenity`, `natural`, `area=yes`, and not `area=no`) → `ST_MakePolygon`,
   with columns `name, building, landuse, leisure, natural`.
5. `osm_lines`: all other ways, with columns `name, highway, railway, waterway`.
6. An R-tree index on each `geom`, then `ANALYZE`.
7. **Limitation:** multipolygon relations are not assembled in v1. If they are needed, a
   follow-up switches step 3–5 to QuackOSM (Apache-2.0, DuckDB-based PBF→GeoParquet).

Dev fixture: Geofabrik `europe/monaco-latest.osm.pbf` (~0.6 MB). Realistic region: Geofabrik
`asia/japan/kanto-latest.osm.pbf`.

### 4.6 Frontend

- Vite + React 19 + TypeScript, react-router. deck.gl 9.3 (`@deck.gl/core`, `layers`,
  `geo-layers`, `carto`, `mapbox`), `@carto/api-client`, `maplibre-gl`. Vitest + Testing
  Library. Package manager: **npm** (lockfile `package-lock.json`).
- Sources: `vectorQuerySource` / `vectorTableSource` / `h3QuerySource` / `h3TableSource` with
  `apiBaseUrl = window.location.origin`, `connectionName:"osm"`, and `authMode:"session"`
  (fallback: `accessToken:"session"` if the installed SDK predates authMode).
- Basemaps: `positron` and `dark-matter` (OpenFreeMap styles `positron`, `dark`), and
  `voyager` (OpenFreeMap `liberty`). They are mapped by `basemapConfig.styleId`. Attribution
  is always visible.
- Pages: `/maps` (list), `/viewer/:id`, `/map/:id` (public), `/builder/:id` (M2).

## 5. Milestones (one implementation plan each)

| M | Scope | Exit criteria |
|---|---|---|
| **M1** | DuckDB sandbox, OSM ingest, Data API (instantiate, TileJSON, MVT, H3 tiles), workspace maps + datasets CRUD, public map endpoint, Maps list page, read-only viewer | The SDK contract test passes. A seeded map with a vector layer and an H3 layer renders over an OSM basemap. The list page can search, sort, page and create. |
| **M2** | Builder: add a source (table/SQL), layer styling (D4–D6), widgets + `/v3/sql/model/*` (D7, A9), filters (D8), SQL parameters + template compiler (D9), popups and legends (D10), geocoder (DuckDB FTS over `osm_points.name`) | Re-create the NYC-taxi-style demo on OSM POIs (H3 density + category widget + parameter control) entirely in the UI |
| **M3** | Auth (local users, sessions), sharing (private/shared/public + password), publish, duplicate, versions, thumbnails, comments, folders | Two users. The privacy matrix is covered by tests. A public link works logged-out. |
| **M4** | Hardening: query cache (cache key = params + data version), tile cache headers (`Cache-Control: public, max-age` when `cache` is present), quotas, Protomaps self-hosted basemap, single-binary deploy (Go embeds `web/dist`) | p95 tile < 300 ms on the Kanto extract at z10–14 on a laptop. Load test with 16 parallel clients shows no 5xx. |

## 6. Testing strategy

- Go: table-driven unit tests per package, against real DuckDB (temp files). No DB mocks.
- **Contract test (M1 Task 11):** Node/Vitest runs the real `@carto/api-client` sources
  against a running `mapsd`. It covers instantiation → TileJSON → tile fetch for vector + H3.
  This is the objective "compatible with CARTO's client" check.
- Web: Vitest for pure mapping (map doc → layer descriptors, query-string builders), and
  Testing Library for the list page with `fetch` stubbed.
- Optional (M2+): Playwright smoke test that loads `/viewer/:id` and waits for the deck canvas.

## 7. Risks

| Risk | Mitigation |
|---|---|
| DuckDB `ST_AsMVT` signature or behavior differs from PostGIS | M1 Task 1 is a capability test that pins the exact signatures before anything else is built on them |
| The H3 tile semantics (U2) don't match what H3TileLayer expects | The contract test plus a manual render check. Fallback: our own `TileLayer` + `H3HexagonLayer` reading JSON tiles. |
| SDK version drift (`authMode`, TileJSON fields) | Pin exact versions in `package-lock.json`. The contract test runs in CI. |
| User SQL abuse | READ_ONLY DB, external access off, config locked, SELECT-only guard, timeout, memory limit, separate meta DB |
| DuckDB meta store under concurrent writes | `Store` interface. The Postgres adapter is an M4 option. |

## 8. Open decisions for the owner

1. Region for the default OSM extract (Kanto/Japan is assumed).
2. Product name (placeholder `osm-maps`) and whether this becomes a `ventarisprima` repo.
3. Whether M3 auth should integrate with the platform's Ory Kratos/Hydra (listed in
   `aws-pulumi` service names) instead of local users.
