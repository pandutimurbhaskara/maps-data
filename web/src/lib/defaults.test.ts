import { describe, expect, it } from 'vitest';
import { colorRange, newDataset, newLayer, newMapConfig, normalizeConfig } from './defaults';

describe('defaults', () => {
  it('builds CARTO palettes from cartocolor', () => {
    const r = colorRange('Sunset', 5);
    expect(r).toMatchObject({ name: 'Sunset', type: 'sequential', category: 'CARTO' });
    expect(r.colors).toHaveLength(5);
    expect(colorRange('Bold').type).toBe('qualitative');
  });

  it('normalizes a minimal M1 config into the full CARTO shape', () => {
    const k = normalizeConfig({ version: 'v1', config: { mapState: { latitude: 1, longitude: 2, zoom: 3 }, visState: { layers: [] } } as never });
    expect(k.config.mapState).toMatchObject({ latitude: 1, longitude: 2, zoom: 3 });
    expect(k.config.visState.interactionConfig.tooltip.enabled).toBe(true);
    expect(k.config).toMatchObject({ filters: {}, widgets: [], sqlParameters: [], basemapConfig: { styleId: 'positron' } });
    expect(normalizeConfig(null).config.visState.layers).toEqual([]);
  });

  it('fills CARTO layer defaults into M1-style layers (no visualChannels)', () => {
    const m1 = { id: 'pts', type: 'tileset', config: { dataId: 'ds', label: 'Points', color: [230, 80, 60], isVisible: true, visConfig: { opacity: 0.9, radius: 4 } } };
    const k = normalizeConfig({ version: 'v1', config: { mapState: { latitude: 0, longitude: 0, zoom: 1 }, visState: { layers: [m1] } } as never });
    const l = k.config.visState.layers[0];
    expect(l.id).toBe('pts');
    expect(l.visualChannels).toMatchObject({ colorField: null, colorScale: 'quantize' });
    expect(l.config).toMatchObject({ dataId: 'ds', color: [230, 80, 60], textLabel: expect.any(Array) });
    expect(l.config.visConfig).toMatchObject({ opacity: 0.9, radius: 4, filled: true, colorRange: expect.objectContaining({ name: 'Sunset' }) });
  });

  it('creates layers that reference their dataset', () => {
    const ds = newDataset({ type: 'table', source: 'osm_points', geoColumn: 'geom', label: 'POIs' });
    const l = newLayer('tileset', ds, 0);
    expect(l.config).toMatchObject({ dataId: ds.id, label: 'POIs', isVisible: true });
    expect(l.visualChannels.colorField).toBeNull();
    expect(newMapConfig().config.visState.layers).toEqual([]);
  });
});
