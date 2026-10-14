import { createViewportSpatialFilter, vectorQuerySource, vectorTableSource } from '@carto/api-client';
import { describe, expect, inject, it } from 'vitest';

const common = { apiBaseUrl: inject('apiBaseUrl'), connectionName: 'osm', accessToken: 'dev' };

describe('widget models through @carto/api-client', async () => {
  const { widgetSource: ws } = await vectorTableSource({ ...common, tableName: 'demo_points', columns: ['name', 'value', 'category', 'ts'] });

  it('formula, with and without a viewport filter', async () => {
    expect(await ws.getFormula({ column: '*', operation: 'count' })).toEqual({ value: 400 });
    const spatialFilter = createViewportSpatialFilter([139.69, 35.64, 139.7475, 35.76]);
    expect(await ws.getFormula({ column: '*', operation: 'count', spatialFilter })).toEqual({ value: 200 });
  });

  it('categories, histogram, range', async () => {
    const cats = await ws.getCategories({ column: 'category', operation: 'count' });
    expect(cats).toHaveLength(4);
    expect(cats.every((c) => c.value === 100)).toBe(true);
    expect(await ws.getHistogram({ column: 'value', operation: 'count', ticks: [100, 200, 300] })).toEqual([100, 100, 100, 100]);
    expect(await ws.getRange({ column: 'value' })).toEqual({ min: 0, max: 399 });
  });

  it('table and time series', async () => {
    const table = await ws.getTable({ columns: ['id', 'name'], sortBy: 'id', sortDirection: 'desc', limit: 3 });
    expect(table.rows.map((r) => r.id)).toEqual([399, 398, 397]);
    expect(table.totalCount).toBe(400);
    const ts = await ws.getTimeSeries({ column: 'ts', stepSize: 'day', operation: 'count' });
    expect(ts.rows).toHaveLength(17);
    expect(ts.rows[0]).toEqual({ name: 1767225600000, value: 24 });
  });

  it('filters and filterOwner cross-filtering', async () => {
    const filters = { category: { in: { values: ['cafe'], owner: 'w-cat' } } };
    const { widgetSource } = await vectorQuerySource({ ...common, sqlQuery: 'SELECT * FROM demo_points', filters });
    expect(await widgetSource.getFormula({ column: '*', operation: 'count' })).toEqual({ value: 100 });
    // the widget that owns the filter does not filter itself
    const own = await widgetSource.getCategories({ column: 'category', operation: 'count', filterOwner: 'w-cat' });
    expect(own).toHaveLength(4);
  });
});
