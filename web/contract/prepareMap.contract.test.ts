import { compileCustomAggregation } from '@carto/api-client';
import { describe, expect, inject, it } from 'vitest';
import { colorRange, newDataset, newLayer, newMapConfig } from '../src/lib/defaults';
import type { MapDoc } from '../src/lib/mapDoc';
import { prepareMap } from '../src/map/prepareMap';

const ctx = { apiBaseUrl: inject('apiBaseUrl'), accessToken: 'dev' };

describe('prepareMap against mapsd', () => {
  it('styles a vector layer from /v3/stats quantiles and loads an H3 aggregation', async () => {
    const points = newDataset({ type: 'table', source: 'demo_points', geoColumn: 'geom', label: 'Points', columns: ['value', 'category'] });
    const hexExp = 'count(*)';
    const hex = newDataset({
      type: 'query', source: 'SELECT h3, value FROM demo_points', geoColumn: 'h3:h3', label: 'Hex',
      aggregationExp: `1 AS __aggregationValue, ${hexExp} AS ${compileCustomAggregation(hexExp, {} as never)}`,
    });
    const pointLayer = newLayer('tileset', points, 0);
    pointLayer.visualChannels.colorField = { name: 'value', type: 'real' };
    pointLayer.visualChannels.colorScale = 'quantile';
    pointLayer.config.visConfig.colorRange = colorRange('Sunset', 6);
    const hexLayer = newLayer('h3', hex, 1);
    hexLayer.config.visConfig = { ...hexLayer.config.visConfig, colorAggregation: 'custom', colorAggregationExp: hexExp, colorAggregationDomain: [1, 4] };

    const k = newMapConfig();
    k.config.visState.layers = [pointLayer, hexLayer]; // kepler order: top first
    const doc = { id: 'm', title: 't', keplerMapConfig: k } as unknown as MapDoc;

    const { parsed, datasets, errors } = await prepareMap(doc, [points, hex], ctx);
    expect(errors).toEqual({});
    expect(datasets.every((d) => typeof d.data.widgetSource.getFormula === 'function')).toBe(true);
    const byType = Object.fromEntries(parsed.layers.map((l) => [l!.type, l!]));
    expect(Object.keys(byType).sort()).toEqual(['h3', 'tileset']);
    const fill = (byType.tileset.scales as { fillColor: { domain: number[] } }).fillColor;
    expect(fill.domain).toContain(199.5); // median from /v3/stats quantiles
    expect((byType.h3.props as { extruded?: boolean }).extruded).toBeFalsy();
    expect(typeof (byType.h3.props as { getFillColor: unknown }).getFillColor).toBe('function');
  });

  it('reports a broken dataset without failing the map', async () => {
    const bad = newDataset({ type: 'query', source: 'SELECT * FROM missing_table', geoColumn: 'geom', label: 'Bad' });
    const k = newMapConfig();
    k.config.visState.layers = [newLayer('tileset', bad, 0)];
    const { parsed, errors } = await prepareMap({ id: 'm', keplerMapConfig: k } as unknown as MapDoc, [bad], ctx);
    expect(errors[bad.id]).toMatch(/missing_table/);
    expect(parsed.layers.filter(Boolean)).toHaveLength(0);
  });
});
