import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { newDataset, newLayer } from '../lib/defaults';
import type { LayerDoc } from '../lib/mapDoc';
import type { LoadedDataset } from '../map/prepareMap';
import { LayersPanel, parseH3Expression } from './LayersPanel';
import type { Action } from './state';

const pts = newDataset({ type: 'table', source: 'demo_points', geoColumn: 'geom', label: 'Points' });
const hex = newDataset({ type: 'query', source: 'SELECT h3, value FROM demo_points', geoColumn: 'h3:h3', label: 'Hex' });
const schema = [{ name: 'geom', type: 'geometry' }, { name: 'h3', type: 'number' }, { name: 'value', type: 'number' }, { name: 'category', type: 'string' }];
const loaded = [pts, hex].map((d) => ({ ...d, data: { tiles: ['http://x/v3/maps/osm/q/{i}?aggregationResLevel=4'], maxresolution: 8, schema, widgetSource: {} } })) as unknown as LoadedDataset[];
const viewport = { west: 139.6, south: 35.6, east: 139.9, north: 35.8, zoom: 12, latitude: 35.7, longitude: 139.75, pitch: 0, bearing: 0 };
const ctx = { apiBaseUrl: 'http://x', accessToken: 't' };

function setup(layers: LayerDoc[], fetcher = vi.fn()) {
  const dispatch = vi.fn<(a: Action) => void>();
  render(<LayersPanel layers={layers} datasets={[pts, hex]} loaded={loaded} popupSettings={{ layers: {} }} dispatch={dispatch} viewport={viewport} ctx={ctx} fetcher={fetcher} />);
  // apply the n-th dispatched updateLayer to the given layer, like the reducer would
  const applied = (n: number, layer: LayerDoc) => {
    const a = dispatch.mock.calls[n][0];
    if (a.type !== 'updateLayer') throw new Error(`dispatch ${n} was ${a.type}`);
    return a.update(layer);
  };
  return { dispatch, applied };
}

describe('LayersPanel', () => {
  it('toggles visibility and recolours a vector layer by a column', () => {
    const layer = newLayer('tileset', pts, 0);
    const { dispatch, applied } = setup([layer]);
    fireEvent.click(screen.getByLabelText('Show Points'));
    expect(applied(0, layer).config.isVisible).toBe(false);
    fireEvent.change(screen.getByLabelText('Color Points by'), { target: { value: 'category' } });
    const byCategory = applied(1, layer);
    expect(byCategory.visualChannels).toMatchObject({ colorField: { name: 'category', type: 'string' }, colorScale: 'ordinal' });
    expect(byCategory.config.visConfig.colorRange.type).toBe('qualitative');
    fireEvent.click(screen.getByLabelText('Popup: value'));
    expect(dispatch.mock.calls[2][0]).toEqual({ type: 'setPopupFields', layerId: layer.id, fields: ['value'] });
    expect(screen.queryByRole('option', { name: 'geom' })).toBeNull(); // the spatial column is not a style field
  });

  it('aggregates an H3 layer and fixes its colour domain from per-cell stats', async () => {
    const layer = newLayer('h3', hex, 0);
    const fetcher = vi.fn(async (_u: RequestInfo | URL) => new Response(JSON.stringify({ min: 1, max: 30 })));
    const { dispatch, applied } = setup([layer], fetcher);
    fireEvent.change(screen.getByLabelText('Color Hex by'), { target: { value: 'count:' } });
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalled());
    expect(String(fetcher.mock.calls[0][0])).toContain('/v3/stats/osm/__value');
    expect(applied(0, layer).config.visConfig).toMatchObject({ colorAggregationExp: 'count(*)', colorAggregationDomain: [1, 30] });
  });

  it('reorders, removes and adds layers', () => {
    const a = newLayer('tileset', pts, 0);
    const b = { ...newLayer('h3', hex, 1), config: { ...newLayer('h3', hex, 1).config, label: 'Hex layer' } };
    const { dispatch } = setup([a, b]);
    fireEvent.click(screen.getByRole('button', { name: 'Move Hex layer up' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove Points' }));
    fireEvent.change(screen.getByLabelText('New layer source'), { target: { value: hex.id } });
    fireEvent.click(screen.getByRole('button', { name: 'Add layer' }));
    const acts = dispatch.mock.calls.map(([x]) => x);
    expect(acts[0]).toEqual({ type: 'moveLayer', id: b.id, delta: -1 });
    expect(acts[1]).toEqual({ type: 'removeLayer', id: a.id });
    expect(acts[2]).toMatchObject({ type: 'addLayer', layer: { type: 'h3', config: { dataId: hex.id } } });
  });

  it('parses saved H3 expressions back into the picker value', () => {
    expect(parseH3Expression('count(*)')).toEqual({ op: 'count' });
    expect(parseH3Expression('sum("my ""v""")')).toEqual({ op: 'sum', column: 'my "v"' });
    expect(parseH3Expression(null)).toBeNull();
  });
});
