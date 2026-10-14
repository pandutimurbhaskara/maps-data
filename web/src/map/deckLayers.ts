import { h3QuerySource, h3TableSource, type QueryParameters, vectorQuerySource, vectorTableSource } from '@carto/api-client';
import { H3TileLayer, VectorTileLayer } from '@deck.gl/carto';
import { MVTLoader } from '@loaders.gl/mvt';
import type { LayerDescriptor } from '../lib/layersFromDoc';

// M1 dev auth ignores the token. M3 switches to authMode: 'session' (same-origin cookie, ledger A8).
const DEV_TOKEN = 'dev';

function common() {
  return { apiBaseUrl: window.location.origin, connectionName: 'osm', accessToken: DEV_TOKEN };
}

// worker: false keeps loaders in-page instead of fetching worker scripts from a CDN.
const loadOptions = { worker: false };
// mapsd always serves MVT (spec §4.2). The inherited MVTWorkerLoader only parses in a worker, so use the in-page parser.
const vectorLoaders = [MVTLoader];

export function toDeckLayer(d: LayerDescriptor) {
  const { source: s, style } = d;
  // map documents store parameters as plain JSON; the SDK's narrower type describes the same values
  const queryParameters = s.queryParameters as QueryParameters | undefined;
  const params = { spatialDataColumn: s.spatialDataColumn, ...(s.columns ? { columns: s.columns } : {}) };
  if (d.kind === 'vector') {
    const data =
      s.type === 'table'
        ? vectorTableSource({ ...common(), ...params, tableName: s.source })
        : vectorQuerySource({ ...common(), ...params, sqlQuery: s.source, queryParameters });
    return new VectorTileLayer({
      id: d.id, data, loadOptions, loaders: vectorLoaders, pickable: true,
      filled: style.filled, stroked: style.stroked,
      getFillColor: style.fillColor, getLineColor: style.lineColor,
      pointRadiusMinPixels: style.pointRadius, lineWidthMinPixels: style.lineWidth,
    });
  }
  const agg = { aggregationExp: d.source.aggregationExp, aggregationResLevel: d.source.aggregationResLevel };
  const data =
    s.type === 'table'
      ? h3TableSource({ ...common(), ...params, ...agg, tableName: s.source })
      : h3QuerySource({ ...common(), ...params, ...agg, sqlQuery: s.source, queryParameters });
  return new H3TileLayer({
    id: d.id, data, loadOptions, pickable: true,
    extruded: false, // H3HexagonLayer extrudes by default; 3D (visConfig.enable3d) arrives with M2 styling
    filled: style.filled, stroked: style.stroked,
    getFillColor: style.fillColor, getLineColor: style.lineColor, lineWidthMinPixels: style.lineWidth,
  });
}
