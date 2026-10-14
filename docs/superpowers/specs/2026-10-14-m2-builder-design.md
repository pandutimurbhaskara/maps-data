# M2 Builder: design addendum

Status: draft · Date: 2026-10-14
Parent spec: [`2026-10-14-osm-duckdb-maps-design.md`](2026-10-14-osm-duckdb-maps-design.md) (§5, row M2).
Evidence: [`../../re/2026-10-14-carto-maps-findings-ledger.md`](../../re/2026-10-14-carto-maps-findings-ledger.md).
Where this addendum and the parent spec disagree, this addendum wins for M2.

## 1. Goal and exit criteria

Turn the read-only M1 viewer into an editor (`/builder/:id`). With it, a user can rebuild a
CARTO-style analysis map **entirely in the UI**:

1. Add a source: a table from the `osm` connection, or a custom SQL query.
2. Add layers: points/lines/polygons (`tileset`) or H3 aggregation (`h3`). Style them with a
   fixed colour or with *colour based on a column* (palette + scale).
3. Add widgets (formula, category, histogram, range, table, time series). They are computed
   by the server for the current viewport, and a category widget filters the map and the
   other widgets.
4. Add SQL parameters (Category, Numeric, NumericRange, DateRange). Each is bound to
   `{{name}}` placeholders in a query source, with controls that re-query the map.
5. Click popups, a legend, and an address/place search box.
6. Every change autosaves. The viewer (`/viewer/:id`) shows the same map read-only:
   widgets, legend and parameter controls are included, editing panels are not.

**Exit check:** starting from an empty map, build an "OSM POIs in Tokyo" map in the UI:
- an H3 density layer coloured by `count`,
- a category widget on `amenity` that filters the H3 layer,
- a Category SQL parameter that restricts amenities.

Reload, and the map comes back identical. Open the viewer, and it shows the same map.

## 2. Key decisions

### D1. Render through CARTO's own client pipeline (new, from code reading)

`@carto/api-client` 0.5 (MIT) turns a CARTO map document into styled deck.gl layers:

```
json = {...map, datasets}
await _fillInMapDatasets(json, ctx)   // each dataset → *Source() → dataset.data = TileJSON (+ widgetSource)
await _fillInTileStats(json, ctx)     // GET /v3/stats/... for every styled attribute
const parsed = parseMap(json)         // → {layers: LayerDescriptor[], initialViewState, popupSettings, legendSettings}
parsed.layers.map(LayerFactory)       // @deck.gl/carto: descriptor.type → VectorTileLayer / H3TileLayer / …
```

The client code then interprets styling: colour/size channels, quantize/quantile/ordinal/custom
scales, CARTOColors palettes, opacity, stroke, radius, H3 aggregation accessors (`name`,
`name_<agg>`), and the legend `scales`. That gives semantic parity with CARTO for free, and our
server only has to speak the contract. M1's hand-written `layersFromDoc` / `deckLayers` is
**replaced** by this pipeline.

Two overrides stay in our code (M1 rulings):
- `VectorTileLayer` gets `loaders: [MVTLoader]`.
- All layers get `loadOptions.worker = false`.

The `_fillIn*` helpers are underscore-exported (unstable API). They are pinned by the
installed version in `package-lock.json` and covered by a contract test.

### D2. Datasets use CARTO's format (supersedes parent spec §4.3 "Dataset")

`{id, type: "table"|"query", source, connectionName: "osm", geoColumn, columns, queryTemplate?, queryParameters?, aggregationExp?, aggregationResLevel?, label, format: "tilejson"}`.

- The spatial index is encoded CARTO-style in `geoColumn` as `"h3:<column>"` (ledger D3, sample
  public maps). M1's ad-hoc `spatialIndex: "h3"` field is dropped.
- For a query dataset with SQL parameters, `queryTemplate` holds the SQL with `{{name}}`
  placeholders. `source` and `queryParameters` hold the compiled DuckDB form (D5).
- For H3 datasets, `aggregationExp` is derived from the layers that use the dataset (D6).

### D3. New server endpoints

| Endpoint | Contract source | Response |
|---|---|---|
| `GET /v3/stats/{conn}/{attribute}?q=&queryParameters=` (query) and `GET /v3/stats/{conn}/{table}/{attribute}` (table) | `buildStatsUrl` / `_fetchTilestats` in api-client | Number: `{attribute, type:"Number", min, max, avg, sum, quantiles:{"2":[3 values] … "10":[11 values]}}`. String/Boolean: `{attribute, type:"String", categories:[{category, frequency}]}`. `maxNumberOfCategories` defaults to 20. |
| `GET\|POST /v3/sql/{conn}/model/{formula\|range\|category\|histogram\|table\|timeseries}` | `executeModel` + `WidgetRemoteSource.get*` | `formula` → `{rows:[{value}]}` · `range` → `{rows:[{min,max}]}` · `category` → `{rows:[{name,value}], metadata:{others}}` · `histogram` → `{rows:[{tick,value}]}` (tick = bucket index 0…len(ticks)) · `table` → `{rows:[…], metadata:{total}}` · `timeseries` → `{rows:[{name: bucket-start epoch ms, value}], metadata:{categories:null}}` |
| `GET /api/workspace/connections/{conn}/resources` | ours | `[{name, columns:[{name,type}], geoColumn}]`, where `geoColumn` is `"geom"`, `"h3:h3"` or `""` |
| `GET /v3/lds/geocoding/geocode?address=&limit=` | ours (CARTO's LDS shape is unknown) | `{rows:[{name, kind, longitude, latitude}]}` |

Model request parameters (ledger A9, `executeModel`) are:
- `type`, `source`
- `params` (JSON)
- `queryParameters`, `filters`, `filtersLogicalOperator`
- `spatialDataType`, `spatialDataColumn`, `spatialFilters` (`{<col>: GeoJSON}`), `spatialFiltersMode`

GET switches to POST over 2048 characters. Operations are `count | avg | min | max | sum | custom`
(`custom` uses `operationExp`, which goes through the SELECT guard).

**Not in M2:** the `scatterplot`, `pick` and `aggregations` models, and the timeseries `splitByCategory` (all return 400).

### D4. Spatial filters

`source.Source` gains `SpatialFilter` (GeoJSON geometry).
- **geo sources:** `ST_Intersects(<geom>, ST_GeomFromGeoJSON($p__sf))`.
- **h3 sources:** the cell centre must intersect (`ST_Point(h3_cell_to_lng(c), h3_cell_to_lat(c))`). This is an approximation of CARTO's `intersects` mode, and it is documented.

Widgets send the current viewport as the spatial filter, via `createViewportSpatialFilter`.

### D5. SQL parameters compile to DuckDB in the web app

CARTO compiles `{{name}}` client-side per provider (ledger D9). The DuckDB rules:

| Parameter type | Placeholder becomes | Bound value |
|---|---|---|
| Category (values[]) | `(SELECT unnest(CAST(CAST($name AS JSON) AS VARCHAR[])))`, so `col IN {{name}}` works | JSON array |
| Numeric | `$name` | number |
| NumericRange / DateRange | `{{start.sqlName}}`, `{{end.sqlName}}` → `$start` / `$end` | number / `'YYYY-MM-DD'` string |

Unknown placeholders are a compile error, shown in the source panel.

### D6. H3 aggregation expression

For an H3 dataset:
- `aggregationExp` = `1 AS __aggregationValue`, plus `<agg>(<col>) AS <col>_<agg>` for every H3 layer colour channel on it.
- `agg` is one of `sum`, `avg` (alias `average`), `min` (alias `minimum`), `max` (alias `maximum`), `count`.
- Aliases follow the client's accessor lookup `name_<aggregation>` (`getAccessorKeys`).

### D7. Geocoder: ranked substring search, not DuckDB FTS (deviation from parent §4.1/M2)

DuckDB FTS tokenizes on whitespace, so Japanese and Chinese OSM names (no spaces) would not
match partial queries. M2 uses a ranked substring search instead: exact, then prefix, then
contains, with shorter names first. It runs over `name` in whichever of `osm_points`,
`osm_polygons` (centroid) and `demo_points` exist. The cost is a scan per query; that is
fine below a few million names, and M4 can add an index.

### D8. Builder UI scope

**In M2:**
- Header: title rename, autosave status, Preview → `/viewer/:id`.
- Left panel tabs: Sources, Layers, Widgets, Parameters.
- Right panel: widgets.
- Map: basemap from `basemapConfig.styleId`, legend, click popup, search box.

**Not in M2 (later or never):**
- split/dual maps, layer groups, custom markers, text-label editor, 3D/elevation controls
- heatmap/cluster/raster layers, drawing a spatial filter, measurement, export
- comments, versions, sharing (M3), AI agent

## 3. Testing

- **Go:** unit and handler tests per endpoint, against the seeded demo DB. `demo_points` gains no new columns; `ts` already covers time series.
- **Contract (Node, real SDK against a live mapsd):**
  - `_fillInMapDatasets` + `_fillInTileStats` + `parseMap` on a builder-made map.
  - `widgetSource.getFormula / getCategories / getHistogram / getRange / getTable / getTimeSeries`.
- **Web unit:** the SQL-parameter compiler, the aggregation builder, the builder reducer + autosave, and the panels (Testing Library with faked API / widget sources).
- **Manual:** the exit check in §1, in Chrome.

## 4. Risks

| Risk | Mitigation |
|---|---|
| `_fillIn*` / `parseMap` change between api-client versions | Version pinned in the lockfile; the contract test fails loudly |
| parseMap needs config keys we do not set (it crashes on missing `interactionConfig.tooltip`, etc.) | `newMapConfig()` / `newLayer()` emit complete CARTO-shaped defaults; the contract test runs parseMap on builder output |
| Per-request cost grows: every widget is one SQL query per viewport change | Debounce viewport → widget refresh by 300 ms; M4 adds a cache |
