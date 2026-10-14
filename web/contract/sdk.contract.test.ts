import { h3QuerySource, vectorQuerySource, vectorTableSource } from '@carto/api-client';
import { latLngToCell } from 'h3-js';
import { describe, expect, inject, it } from 'vitest';

// mapsd's M1 dev auth ignores the token; the SDK requires one unless authMode is 'session'.
const common = { apiBaseUrl: inject('apiBaseUrl'), connectionName: 'osm', accessToken: 'dev' };

describe('@carto/api-client against mapsd', () => {
  it('vectorTableSource instantiates and advertises MVT tiles', async () => {
    const tj = await vectorTableSource({ ...common, tableName: 'demo_points', columns: ['name', 'value'] });
    expect(tj.tiles[0]).toContain('formatTiles=mvt');
    expect(tj.tiles[0]).toContain('/{z}/{x}/{y}');
    expect(tj).toMatchObject({ tilestats: { layers: [{ count: 400 }] } });

    const res = await fetch(tj.tiles[0].replace('{z}', '0').replace('{x}', '0').replace('{y}', '0'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/vnd.mapbox-vector-tile');
    expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(0);
  });

  it('vectorQuerySource passes named queryParameters', async () => {
    const tj = await vectorQuerySource({
      ...common,
      sqlQuery: 'SELECT * FROM demo_points WHERE value >= $min',
      queryParameters: { min: 390 },
      columns: ['name'],
    });
    expect(tj).toMatchObject({ tilestats: { layers: [{ count: 10 }] } });
  });

  it('h3QuerySource serves cell-addressed spatial tiles', async () => {
    const tj = await h3QuerySource({
      ...common,
      sqlQuery: 'SELECT h3, value FROM demo_points',
      spatialDataColumn: 'h3',
      aggregationExp: 'sum(value) AS value_sum',
      aggregationResLevel: 4,
    });
    expect(tj.tiles[0]).toContain('/{i}');
    expect(tj).toMatchObject({ maxresolution: 8 });

    const cell = latLngToCell(35.65, 139.7, 6);
    const res = await fetch(tj.tiles[0].replace('{i}', cell));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/vnd.carto-spatial-tile');
  });
});
