import { describe, expect, it } from 'vitest';
import type { DatasetDoc, KeplerMapConfig, LayerDoc } from './mapDoc';
import { layersFromDoc } from './layersFromDoc';

const points: DatasetDoc = { id: 'p', type: 'table', connectionName: 'osm', source: 'osm_points', columns: ['name'] };
const hex: DatasetDoc = { id: 'h', type: 'query', connectionName: 'osm', source: 'SELECT h3 FROM osm_points', spatialIndex: 'h3', aggregationExp: 'count(*) AS n', aggregationResLevel: 5 };

const doc = (layers: LayerDoc[]): KeplerMapConfig => ({ version: 'v1', config: { mapState: { latitude: 0, longitude: 0, zoom: 1 }, visState: { layers } } });

describe('layersFromDoc', () => {
  it('maps tileset and h3 layers, top layer last for deck.gl', () => {
    const { layers, warnings } = layersFromDoc(
      doc([
        { id: 'top', type: 'h3', config: { dataId: 'h', color: [1, 2, 3], visConfig: { opacity: 0.5 } } },
        { id: 'bottom', type: 'tileset', config: { dataId: 'p', visConfig: { radius: 6, stroked: true, strokeColor: [9, 9, 9] } } },
      ]),
      [points, hex],
    );
    expect(warnings).toEqual([]);
    expect(layers.map((l) => l.id)).toEqual(['bottom', 'top']);
    expect(layers[0]).toMatchObject({
      kind: 'vector',
      source: { type: 'table', source: 'osm_points', spatialDataColumn: 'geom', columns: ['name'] },
      style: { fillColor: [18, 147, 154, 204], lineColor: [9, 9, 9, 255], stroked: true, pointRadius: 6 },
    });
    expect(layers[1]).toMatchObject({
      kind: 'h3',
      source: { type: 'query', spatialDataColumn: 'h3', aggregationExp: 'count(*) AS n', aggregationResLevel: 5 },
      style: { fillColor: [1, 2, 3, 128] },
    });
  });

  it('skips hidden layers and warns about missing datasets and unsupported types', () => {
    const { layers, warnings } = layersFromDoc(
      doc([
        { id: 'hidden', type: 'tileset', config: { dataId: 'p', isVisible: false } },
        { id: 'orphan', type: 'tileset', config: { dataId: 'nope' } },
        { id: 'heat', type: 'heatmapTile', config: { dataId: 'p' } },
        { id: 'mismatch', type: 'h3', config: { dataId: 'p' } },
      ]),
      [points],
    );
    expect(layers).toEqual([]);
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toContain('nope');
  });

  it('tolerates a document without visState', () => {
    expect(layersFromDoc({ version: 'v1', config: { mapState: { latitude: 0, longitude: 0, zoom: 1 } } }, [])).toEqual({ layers: [], warnings: [] });
  });
});
