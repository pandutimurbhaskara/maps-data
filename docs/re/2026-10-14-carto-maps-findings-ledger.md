# CARTO Workspace "Maps" — reverse-engineering findings ledger

Target: `https://radiata.app.carto.com/maps` (CARTO Workspace, trial account, tenant `radiata`,
region `gcp-australia-southeast1`). Investigation date: 2026-10-14.

Every row says **how** it is known:

- **OBS-RT**: observed at runtime in the signed-in browser session (URL path, query
  parameter *names*, non-sensitive parameter values). Request/response bodies, cookies and
  tokens were never captured.
- **OBS-STATIC**: observed in the shipped, minified JS bundle (chunk file + byte offset when known).
- **OBS-PUBLIC**: observed in an unauthenticated public HTTP response (`config.yaml`, public map JSON).
- **INF**: inferred from the above. Not proven.
- **UNK**: still unknown.

## Evidence sources

| ID | What | Where |
|---|---|---|
| E1 | 364 JS chunks (24 MB) crawled from `/assets/` until no new references. Source maps return 403. | scratchpad `dl/assets/` (not committed; third-party code) |
| E2 | REA `analyze_javascript_application` over E1. Every file was parsed, but the semantic graph is **partial** (result budget exhausted). | REA evidence `ev_a2d273a6fe82b0ebc0984ba183380f29465f71256c22f062958e725a9126e2ff` (summary), parent `ev_d90b2e2757953742f6660ffad3da7b12971acb84e748eb2760e14406b98b08f4` (retained for this session only) |
| E3 | Browser session on `/maps` and on `/builder/{id}` (a copy of the NYC Taxi demo). Resource-timing URLs with query values stripped. | Claude-in-Chrome, 2026-10-14 |
| E4 | `GET https://radiata.app.carto.com/config.yaml` (public) | scratchpad `dl/config.yaml` |
| E5 | 4 public demo map documents, `GET https://gcp-us-east1.api.carto.com/v3/maps/public/{id}?client=workspace` (unauthenticated) | scratchpad `dl/public/*.json` |
| E6 | Targeted grep and byte-range reads of E1 by two static-analysis passes | chunk names cited inline |

Coverage limit: E2's semantic coverage is partial, and E6 is a bounded grep. Features absent from
the trial account (SSO, governance, Data Observatory, Workflows) were not exercised at runtime.

## Platform shape

| # | Finding | Kind | Evidence |
|---|---|---|---|
| F1 | The frontend is a Vite-built React SPA (MUI, redux-saga) with lazy chunks. deck.gl **9.3.3** and MapLibre GL are bundled. | OBS-STATIC | `index-CAHAfrjL.js`, `deck.gl-C5QPoQgs.js`, `maplibre-gl-lhh2END8.js`, `/workers/deck.gl@9.3.3/*` |
| F2 | Runtime config is fetched from `/config.yaml`. It sets Auth0 (`auth.carto.com`, audience `carto-cloud-native-api`) and separate origins: `accountsUrl`, `workspaceUrl` (workspace REST), `baseUrl` (Maps/SQL/Stats API v3), `ldsApiUrl`, `aiApi`, `publicMapUrl`. | OBS-PUBLIC | E4 |
| F3 | **Three backends.** (a) Accounts API (`/users/me`, `/accounts`). (b) Workspace API (`/maps`, `/connections`, `/folders`, `/settings/*`, `/storage/sign`, `/comments`). (c) Data API v3 (`/v3/maps`, `/v3/sql`, `/v3/stats`, `/v3/lds`, `/v3/imports`). | OBS-RT | E3 |
| F4 | Data lives in the customer's warehouse (`carto_dw` = BigQuery here). CARTO compiles SQL and tiles **on the fly** from the warehouse. Maps store only configuration. | OBS-PUBLIC + INF | E5 `datasets[].connectionName/providerId/source` |

## Maps list page (`/maps`)

| # | Finding | Kind | Evidence |
|---|---|---|---|
| L1 | `GET {workspace}/maps?page=1&page_size=12&order_by=updated_at&order_direction=DESC` on load | OBS-RT | E3 |
| L2 | Other list params: `search`, `tags` (JSON array string), `user_id` (filter "mine"), `privacy` (`shared`/`public`), `ai_enabled`, `container_id` (folder/project). List view uses `page_size` from {10,25,50,100}, default 50. | OBS-STATIC | `ReactApp-Dfp9Rs5z.js` builder `CQe` near offset 1609284 |
| L3 | Sort options: `updated_at DESC` ("Last updated"), `title ASC` ("A-Z") | OBS-STATIC | `ReactApp` `RYt` |
| L4 | URL state: `viewMode` (grid/list), `tags`, `permissions` (all/mine/shared/public), `search`, `order` | OBS-STATIC | `ReactApp` page `C5e` |
| L5 | Response paging: `meta.page.current`, `meta.page.totalPages`, `meta.page.total`. The empty state uses `stats.totalMaps`. | OBS-STATIC | `ReactApp` |
| L6 | Card menu: Edit (title/description), Share, Duplicate, Copy ID, Move to, Create shortcut, Remove from container, Delete (owner only), Create from template | OBS-STATIC | `Ao` enum, handler `$Se` |
| L7 | Card click: owner or collaborative editor goes to `/builder/{id}`. Others go to `/viewer/{id}`. Public link is `/map/{id}`. | OBS-STATIC | `VTe`, `Asr` |
| L8 | Demo gallery: `GET /maps/demo/templates?ai_enabled=false`, then each `publicUrl` is fetched. Clicking a demo **creates a copy**: `POST /maps/demo {demoMapUrl}`. | OBS-RT + OBS-STATIC | E3 (`/builder/7e3b…` opened in a new tab), `PQe` |

## Map resource (workspace API)

| # | Finding | Kind | Evidence |
|---|---|---|---|
| M1 | CRUD: `POST /maps` {title, description, tags, keplerMapConfig, collaborative, agent, containerId?}, `GET /maps/{id}?client=builder`, `PATCH /maps/{id}` (+`$saveCurrentVersion`), `DELETE /maps/{id}` | OBS-STATIC (+RT for GET) | `Kor`, `OQe`, `NQe`; E3 |
| M2 | Datasets are a sub-resource: `GET/POST /maps/{id}/datasets`, `PATCH/DELETE /maps/{id}/datasets/{dsId}` | OBS-STATIC + RT | `Xye/Zor/ear/tar`; E3 |
| M3 | Sharing: `POST /maps/{id}/privacy` {privacy, sharingScope, userIds, groupIds, publicPassword} (legacy) or {policies:[{type,id?}], publicPassword}. `POST /maps/{id}/publish` returns {token, lastPublishedAt}. | OBS-STATIC | `rar`, `MapSharingDialog-BWx5f5bz.js`, `nar` |
| M4 | Enums. privacy: `private, shared, public, shared_with_groups`. sharingScope: `organization, specific`. policy type: `organization, public, owner, user, group`. | OBS-STATIC + PUBLIC | `Mn`, `ds`, `yi`; E5 `policies` |
| M5 | Duplicate: `POST /maps/{id}/dry_run_clone` returns {status: fully/partially, restricted_connections}, then `POST /maps/{id}/clone {versionId}` | OBS-STATIC | `MQe`, `jQe` |
| M6 | Versions: list/create/get/patch/restore under `/maps/{id}/versions`. Filter: `all, named, published, …` | OBS-STATIC | `builderSagas-5jVoH7dx.js` |
| M7 | Collaborative lock: `POST /maps/{id}/lock|unlock|take-over/request`, plus a keepalive unlock on page unload | OBS-STATIC | `collaborationSagas-BfJJ41Eb.js` |
| M8 | Comments: `/maps/{id}/comments`, `/comments/{cid}[/resolve|/reopen|/responses]`, `/comments/markAsRead` | OBS-STATIC + RT | `ReactApp` |
| M9 | Thumbnail: the client renders a PNG (viewport width × 0.5625), calls `POST /storage/sign {map_id, filename, type:"thumbnail", content_type}`, then PUTs to the signed GCS URL | OBS-STATIC + RT | `builderSagas` `eae`/`mee`; E3 `storage/sign`, GCS thumbnail GET |
| M10 | Folders/projects: `/folders`, `/folders/entries`, `PATCH /entries {assets, containerId}`, `/shortcuts` | OBS-STATIC | `ReactApp` near 5040251 |
| M11 | Public map document fields: `id, title, description (markdown), tags, privacy, sharingScope, collaborative, ownerId, accountId, createdAt, updatedAt, currentVersionUpdatedAt/By, thumbnailUrl, views, token, policies[], basemaps{settings,customBasemaps}, agent, keplerMapConfig, datasets[]` | OBS-PUBLIC | E5 |

## Map document (`keplerMapConfig`, version `"v1"`)

| # | Finding | Kind | Evidence |
|---|---|---|---|
| D1 | `config` keys: `visState{layers, layerBlending, filters, interactionConfig, animationConfig, splitMaps}, mapState{latitude, longitude, zoom, pitch, bearing, dragRotate}, mapStyle{styleType, visibleLayerGroups}, basemapConfig, customBaseMaps, widgets, filters, sqlParameters, spatialFilter, popupSettings, legendSettings, layerGrouping, mapSettings, uiState, aiSettings` | OBS-PUBLIC | E5 |
| D2 | The bundle ships a zod schema of the whole document (~216 `.describe()` strings, apparently for the AI agent). It is the most complete description of the format. Read it to understand the format; do not copy it. | OBS-STATIC | `ReactApp` offsets ~1.47M–1.67M |
| D3 | Current layer types: `tileset` (vector points/lines/polygons from TileJSON), `h3`, `quadbin`, `heatmapTile`, `clusterTile`, `raster`. The other kepler types (`point, geojson, line, hexagon, trip, …`) are legacy. | OBS-STATIC | `layer-types-C_QvtkUU.js`; zod union |
| D4 | visualChannels: `colorField/strokeColorField/sizeField/radiusField/heightField/rotationField/customMarkersField`, each with `*Scale`. colorScale ∈ `quantile, quantize, ordinal, custom, identity`. sizeScale ∈ `linear, sqrt, log`. | OBS-STATIC + PUBLIC | `pZ`, `N5t`; E5 |
| D5 | visConfig: opacity, filled, colorRange{name,type,category,colors[],colorMap?}, stroked, strokeColor(Range), strokeOpacity, thickness, radius(Range), sizeRange, enable3d, elevationScale, heightRange, per-channel `*Aggregation`/`*AggregationExp`/`*AggregationDomain` for spatial-index layers, textLabel[], custom markers, fill patterns, line dash | OBS-PUBLIC + STATIC | E5; zod |
| D6 | Palettes are CARTOColors (category `"CARTO"`), plus `Uber` and `ColorBrewer` | OBS-STATIC | `ReactApp`, `popupUtils-gjk3XBRP.js` |
| D7 | Widgets: `formula, category, histogram, timeseries, table, range, pie`. Shape: `{id, type, title, dataSource, column, operation, operationExp?, global?, collapsible, …}`. Operations: `count, avg, min, max, sum, custom`. | OBS-STATIC + PUBLIC | `NVe`; E5 |
| D8 | Filter shape `config.filters[datasetId][column][type] = {values, owner}`. Types: `in, between, closed_open, time, stringSearch`. Columns are combined with `filtersLogicalOperator` (default `and`). | OBS-STATIC + PUBLIC | deck.gl `qc`; E5 |
| D9 | SQL parameters: `Category, Numeric, NumericRange, DateRange`. `datasets[].queryTemplate` uses `{{name}}`. The client compiles it per provider (`@name`/`UNNEST(@name)` for BigQuery, `:name` for Databricks, positional for the rest) into `datasets[].source` + `queryParameters`. | OBS-STATIC + PUBLIC | `ReactApp` `UWt`, `EG=/{{(.*?)}}/gm`; E5 |
| D10 | Popups `popupSettings.layers[id].{hover,click}` = {style, fields[], template (HTML + `{{col}}`)}. Legends `legendSettings.layers[id]`. Layer groups `layerGrouping[]` (one level). | OBS-PUBLIC + STATIC | E5; zod |
| D11 | Basemaps: CARTO `positron, dark-matter, voyager` (MapLibre styles at `basemaps.cartocdn.com/gl/*-gl-style/style.json`), Google, custom (`custom:<id>`). Toggleable groups: land, water, road, building, border, label. | OBS-RT + STATIC | E3; zod |

## Data API v3 (what the map viewer calls)

| # | Finding | Kind | Evidence |
|---|---|---|---|
| A1 | **Two-step instantiation.** Step 1: `GET {base}/v3/maps/{connection}/{table|query|tileset|raster}?{source params}&v=3.4&client=builder&deckglVersion=9.3.3` returns `{tilejson:{url:[U]}, schema}`. Step 2: `GET U` (same path + `format=tilejson&cache=<n>`) returns the TileJSON. | OBS-STATIC + RT | `deck.gl-C5QPoQgs.js` fn `qa` @~2203300; E3 |
| A2 | Source params: `name` (table) or `q` (query), `spatialDataType` (`geo`, `h3`, `quadbin`), `spatialDataColumn`, `columns` (comma-joined), `filters` (JSON), `queryParameters` (JSON), `aggregationExp`, `aggregationResLevel`, `tileResolution`, `featureBbox`, `tag-mapId` | OBS-RT + STATIC | E3 |
| A3 | Requests switch from GET to POST with a JSON body when the URL exceeds `maxLengthURL` (7000 for instantiation, 2048 for SQL model calls) | OBS-STATIC | `E8=7e3`, `lae=2048` |
| A4 | Vector tiles: `{…}/{z}/{x}/{y}`. **The client decodes MVT when the TileJSON `tiles[0]` URL has `formatTiles=mvt`. Otherwise it decodes CARTO's protobuf "binary" format.** The server picks the format. | OBS-STATIC + RT | `F_()` @~2232800; E3 `formatTiles=binary` |
| A5 | H3/quadbin tiles are addressed by **cell index**: `/v3/maps/{conn}/query/{h3index}` (e.g. a res-3 cell), with TileJSON `minresolution/maxresolution`. Decoded by `cartoSpatialTile` (protobuf). | OBS-RT + STATIC | E3; `H3TileLayer` @~2403300 |
| A6 | `cartoSpatialTile` wire format: `Tile{1: scheme varint, 2: Cells}`. `Cells{1: Indices{1: bytes = little-endian uint64[]}, 2: repeated Properties (one per cell; repeated {1: KV{1 key str, 2 value str}}), 3: repeated NumericProp{1 key str, 2: {1: bytes = little-endian float64[]}}}`. The client takes the scheme from loader options, not from the tile. | OBS-STATIC | readers `aS`, `cS`, `_0e`, `eh`, `rS`, `th`, `nS`, `rm` @~2393178–2398500 |
| A7 | The client reads `tilestats.layers[0].attributes[]` ({attribute, type, min, max, …}) to compute color/size domains, and also reads `bounds`, `schema`, `raster_metadata` | OBS-STATIC | `AF()` @~2316739 |
| A8 | Auth: `Authorization: Bearer <token>`, **or** `authMode:"session"` (same-origin cookies; tile URLs rewritten onto `apiBaseUrl`) | OBS-STATIC | `nA()`, `s0()`, `iy()` @~2199800 |
| A9 | Widget models: `GET {base}/v3/sql/{conn}/model/{formula|category|histogram|range|timeseries|table|scatterplot|pick|aggregations}?type&source&params(JSON)&queryParameters&filters&filtersLogicalOperator&spatialDataType&spatialDataColumn&spatialFilters&spatialFiltersMode=intersects` | OBS-RT + STATIC | E3; `jx` whitelist |
| A10 | Widgets over pre-generated tilesets/rasters are computed **client-side** in a worker from loaded tiles | OBS-STATIC | `widget-tileset-worker-C4Jyf73p.js` |
| A11 | Other v3: `/v3/stats/{conn}/{table}` (column stats), `/v3/lds/geocoding/geocode`, `/v3/sql/{conn}/query`, `/v3/sql/jobs`, `/v3/imports`, `/v3/exports` | OBS-RT + STATIC | E3, E6 |

## Unknowns (resolve these during implementation, do not guess)

| # | Unknown | How to resolve |
|---|---|---|
| U1 | Exact TileJSON field set and the MVT layer name the client expects | Read `@carto/api-client` / `@deck.gl/carto` TypeScript sources (MIT) in `node_modules`. The contract test (plan Task 11) pins it. |
| U2 | Server semantics of `aggregationResLevel` vs tile cell resolution for H3 | The plan defines our semantics, and the contract test checks that the SDK renders it |
| U3 | Response bodies of `/v3/sql/.../model/*` | Read the `@carto/api-client` widget source response types (M2) |
| U4 | Whether the H3 tile URL template placeholder is `{i}` | Contract test (plan Task 11) |
| U5 | `scheme` varint enum values in the spatial tile | Not needed: the client ignores the field |
| U6 | Comment create body, per-map role model | Not needed for M1 |

## Side effect of the investigation

Clicking the "NYC Taxi Demand" demo card created a copy of that demo in the trial account
(`/builder/7e3b1eae-65fa-4598-9876-c1fffc6d3b2b`). Nothing else was created, edited or deleted.
