import { MVTLoader } from '@loaders.gl/mvt';
import { describe, expect, it, vi } from 'vitest';
import type { LayerDescriptor } from '../lib/layersFromDoc';
import { toDeckLayer } from './deckLayers';

// Sources would fetch on creation; the adapter's job is only to pass the right options through.
vi.mock('@carto/api-client', () => {
  const source = vi.fn(async (opts: unknown) => ({ opts }));
  return { vectorTableSource: source, vectorQuerySource: source, h3TableSource: source, h3QuerySource: source };
});

const style = { fillColor: [1, 2, 3, 128], lineColor: [4, 5, 6, 255], filled: true, stroked: false, pointRadius: 4, lineWidth: 1 } as const;

describe('toDeckLayer', () => {
  it('renders H3 layers flat (2D) — H3HexagonLayer extrudes by default', () => {
    const d: LayerDescriptor = {
      kind: 'h3', id: 'hex', style: { ...style, fillColor: [...style.fillColor], lineColor: [...style.lineColor] },
      source: { type: 'query', source: 'SELECT h3 FROM t', spatialDataColumn: 'h3', aggregationExp: 'count(*) AS n', aggregationResLevel: 4 },
    };
    expect(toDeckLayer(d).props).toMatchObject({ extruded: false, filled: true });
  });

  it('parses MVT in-page for vector layers', () => {
    const d: LayerDescriptor = {
      kind: 'vector', id: 'pts', style: { ...style, fillColor: [...style.fillColor], lineColor: [...style.lineColor] },
      source: { type: 'table', source: 'demo_points', spatialDataColumn: 'geom' },
    };
    const props = toDeckLayer(d).props as { loaders: unknown[]; loadOptions: { worker: boolean } };
    expect(props.loaders).toContain(MVTLoader);
    expect(props.loadOptions.worker).toBe(false);
  });
});
