import { describe, expect, it } from 'vitest';
import { setColumnColorBy, setH3ColorBy } from '../lib/aggregation';
import { newDataset, newLayer, newMapConfig, newWidget } from '../lib/defaults';
import type { MapDoc, SqlParameter } from '../lib/mapDoc';
import { builderReducer, dirtyDatasets, hasChanges, initState } from './state';

const map = { id: 'm', title: 'T', keplerMapConfig: newMapConfig() } as unknown as MapDoc;

describe('builderReducer', () => {
  it('derives the H3 aggregationExp and marks the dataset dirty', () => {
    const hex = newDataset({ type: 'query', source: 'SELECT h3 FROM demo_points', geoColumn: 'h3:h3', label: 'Hex' });
    let s = initState(map, [hex]);
    expect(hasChanges(s)).toBe(false);
    const layer = newLayer('h3', hex, 0);
    s = builderReducer(s, { type: 'addLayer', layer });
    s = builderReducer(s, { type: 'updateLayer', id: layer.id, update: (l) => setH3ColorBy(l, 'count', undefined, 'quantize', 'Sunset', 5, [1, 5]) });
    expect(s.datasets[0].aggregationExp).toMatch(/^1 AS __aggregationValue, count\(\*\) AS custom_agg_/);
    expect(dirtyDatasets(s).map((d) => d.id)).toEqual([hex.id]);
    expect(hasChanges(s)).toBe(true);
  });

  it('keeps tileset dataset columns in sync with styled and popup fields', () => {
    const pts = newDataset({ type: 'table', source: 'demo_points', geoColumn: 'geom', label: 'Pts' });
    const layer = newLayer('tileset', pts, 0);
    let s = builderReducer(initState(map, [pts]), { type: 'addLayer', layer });
    s = builderReducer(s, { type: 'updateLayer', id: layer.id, update: (l) => setColumnColorBy(l, { name: 'value', kind: 'number' }, 'quantize', 'Sunset', 5) });
    s = builderReducer(s, { type: 'setPopupFields', layerId: layer.id, fields: ['name', 'value'] });
    expect(s.datasets[0].columns).toEqual(['name', 'value']);
    expect(s.map.keplerMapConfig.config.popupSettings.layers[layer.id].click?.fields).toEqual([{ name: 'name' }, { name: 'value' }]);
  });

  it('recompiles query templates when a parameter changes and records compile errors', () => {
    const q = newDataset({ type: 'query', source: '', queryTemplate: 'SELECT * FROM demo_points WHERE category IN {{kinds}}', geoColumn: 'geom', label: 'Q' });
    const param: SqlParameter = { id: 'p', type: 'Category', name: 'Kinds', item: { sqlName: 'kinds', value: ['cafe'] }, values: ['cafe', 'park'], selectionMode: 'multi' };
    let s = initState(map, [q]);
    expect(s.errors[q.id]).toMatch(/unknown parameter/);
    s = builderReducer(s, { type: 'addSqlParameter', param });
    expect(s.errors[q.id]).toBeUndefined();
    expect(s.datasets[0].queryParameters).toEqual({ kinds: ['cafe'] });
    s = builderReducer(s, { type: 'updateSqlParameter', param: { ...param, item: { sqlName: 'kinds', value: [] } } });
    expect(s.datasets[0].queryParameters).toEqual({ kinds: [] });
  });

  it('removing a dataset removes its layers, widgets and filters and queues a delete', () => {
    const pts = newDataset({ type: 'table', source: 'demo_points', geoColumn: 'geom', label: 'Pts' });
    let s = initState(map, [pts]);
    s = builderReducer(s, { type: 'addLayer', layer: newLayer('tileset', pts, 0) });
    s = builderReducer(s, { type: 'addWidget', widget: newWidget('formula', pts.id, '*') });
    s = builderReducer(s, { type: 'setFilters', datasetId: pts.id, filters: { category: { in: { values: ['cafe'], owner: 'w' } } } });
    s = builderReducer(s, { type: 'removeDataset', id: pts.id });
    const c = s.map.keplerMapConfig.config;
    expect([s.datasets.length, c.visState.layers.length, c.widgets.length, c.filters[pts.id]]).toEqual([0, 0, 0, undefined]);
    expect(s.deleted).toEqual([pts.id]);
  });

  it('a save acknowledges only the revisions it sent', () => {
    let s = builderReducer(initState(map, []), { type: 'renameMap', title: 'A' });
    const sentRev = s.rev.map;
    s = builderReducer(s, { type: 'renameMap', title: 'B' }); // edit while saving
    s = builderReducer(s, { type: 'saved', map: sentRev, datasets: {}, deleted: [] });
    expect(hasChanges(s)).toBe(true);
    expect(s.map.title).toBe('B');
  });

  it('moves layers and removes widget filters with their widget', () => {
    const pts = newDataset({ type: 'table', source: 'demo_points', geoColumn: 'geom', label: 'Pts' });
    const a = newLayer('tileset', pts, 0);
    const b = newLayer('tileset', pts, 1);
    const w = newWidget('category', pts.id, 'category');
    let s = initState(map, [pts]);
    for (const layer of [a, b]) s = builderReducer(s, { type: 'addLayer', layer });
    expect(s.map.keplerMapConfig.config.visState.layers.map((l) => l.id)).toEqual([b.id, a.id]); // newest on top
    s = builderReducer(s, { type: 'moveLayer', id: b.id, delta: -1 }); // already on top: no-op
    expect(s.map.keplerMapConfig.config.visState.layers.map((l) => l.id)).toEqual([b.id, a.id]);
    s = builderReducer(s, { type: 'moveLayer', id: b.id, delta: 1 });
    expect(s.map.keplerMapConfig.config.visState.layers.map((l) => l.id)).toEqual([a.id, b.id]);
    s = builderReducer(s, { type: 'addWidget', widget: w });
    s = builderReducer(s, { type: 'setFilters', datasetId: pts.id, filters: { category: { in: { values: ['cafe'], owner: w.id } } } });
    s = builderReducer(s, { type: 'removeWidget', id: w.id });
    expect(s.map.keplerMapConfig.config.filters[pts.id]).toEqual({});
  });
});

describe('initState with M1 datasets', () => {
  const map = { id: 'm', title: 'm', keplerMapConfig: newMapConfig() } as unknown as MapDoc;
  it('maps spatialIndex/missing geoColumn onto the CARTO geoColumn convention', () => {
    const m1 = [
      { id: 'ds-h3', type: 'table', label: 'H3', connectionName: 'osm', source: 'demo_points', spatialIndex: 'h3' },
      { id: 'ds-h3b', type: 'table', label: 'H3b', connectionName: 'osm', source: 'demo_points', geoColumn: 'cell', spatialIndex: 'h3' },
      { id: 'ds-geo', type: 'table', label: 'Geo', connectionName: 'osm', source: 'demo_points' },
    ] as never;
    const s = initState(map, m1);
    expect(s.datasets.map((d) => d.geoColumn)).toEqual(['h3:h3', 'h3:cell', 'geom']);
    expect(s.datasets[0]).not.toHaveProperty('spatialIndex');
    expect(s.datasets[0].aggregationResLevel).toBe(4);
  });
});
