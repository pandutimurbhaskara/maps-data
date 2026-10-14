import { compileCustomAggregation } from '@carto/api-client';
import { describe, expect, it } from 'vitest';
import { buildAggregationExp, clearColorBy, h3Expression, setColumnColorBy, setH3ColorBy } from './aggregation';
import { newDataset, newLayer } from './defaults';

const hex = newDataset({ type: 'query', source: 'SELECT h3, value FROM demo_points', geoColumn: 'h3:h3', label: 'Hex' });
const pts = newDataset({ type: 'table', source: 'demo_points', geoColumn: 'geom', label: 'Pts' });

describe('H3 aggregation', () => {
  it('quotes columns in aggregate expressions', () => {
    expect(h3Expression('count')).toBe('count(*)');
    expect(h3Expression('sum', 'my "col"')).toBe('sum("my ""col""")');
    expect(() => h3Expression('avg')).toThrow();
  });

  it('builds the dataset aggregationExp from the H3 layers that use it', () => {
    const a = setH3ColorBy(newLayer('h3', hex, 0), 'count', undefined, 'quantize', 'Sunset', 5, [1, 9]);
    const b = setH3ColorBy(newLayer('h3', hex, 1), 'sum', 'value', 'quantile', 'Teal', 4, [0, 10, 20, 30, 40]);
    const other = setColumnColorBy(newLayer('tileset', pts, 2), { name: 'value', kind: 'number' }, 'quantize', 'Sunset', 5);
    const exp = buildAggregationExp(hex.id, [a, b, other, a]);
    expect(exp).toBe(
      `1 AS __aggregationValue, count(*) AS ${compileCustomAggregation('count(*)', {} as never)}, sum("value") AS ${compileCustomAggregation('sum("value")', {} as never)}`,
    );
    expect(buildAggregationExp(pts.id, [a])).toBe('1 AS __aggregationValue');
  });

  it('encodes colour-by the way parseMap reads it', () => {
    const h = setH3ColorBy(newLayer('h3', hex, 0), 'avg', 'value', 'quantile', 'Teal', 4, [1, 2, 3, 4, 5]);
    expect(h.visualChannels).toMatchObject({ colorField: null, colorScale: 'quantile' });
    expect(h.config.visConfig).toMatchObject({ colorAggregation: 'custom', colorAggregationExp: 'avg("value")', colorAggregationDomain: [1, 2, 3, 4, 5] });
    expect(h.config.visConfig.colorRange.colors).toHaveLength(4);
    const v = setColumnColorBy(newLayer('tileset', pts, 0), { name: 'category', kind: 'string' }, 'ordinal', 'Bold', 4);
    expect(v.visualChannels.colorField).toEqual({ name: 'category', type: 'string' });
    expect(clearColorBy(v).visualChannels.colorField).toBeNull();
    expect(clearColorBy(h).config.visConfig).toMatchObject({ colorAggregationExp: null, colorAggregationDomain: null });
  });
});
