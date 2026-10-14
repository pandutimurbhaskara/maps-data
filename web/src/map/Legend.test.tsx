import type { LayerDescriptor } from '@carto/api-client';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { setH3ColorBy } from '../lib/aggregation';
import { newDataset, newLayer } from '../lib/defaults';
import { Legend, legendEntries } from './Legend';

const pts = newDataset({ type: 'table', source: 'demo_points', geoColumn: 'geom', label: 'Points' });
const hex = newDataset({ type: 'query', source: 'q', geoColumn: 'h3:h3', label: 'Hex' });
const desc = (id: string, scale?: unknown) => ({ type: 'tileset', props: { id }, scales: scale ? { fillColor: scale } : {} }) as unknown as LayerDescriptor;

describe('legendEntries', () => {
  it('single colour, ordinal and binned scales', () => {
    const l = newLayer('tileset', pts, 0);
    expect(legendEntries(l, desc(l.id))).toMatchObject({ empty: false, entries: [{ label: 'Points', color: '#12939a' }] });
    expect(legendEntries(l, desc(l.id, { type: 'ordinal', domain: ['cafe', 'park'], range: ['#111111', '#222222', '#333333'] })).entries).toEqual([
      { label: 'cafe', color: '#111111' },
      { label: 'park', color: '#222222' },
    ]);
    expect(legendEntries(l, desc(l.id, { type: 'quantize', domain: [0, 100], range: ['#a', '#b', '#c', '#d'] })).entries.map((e) => e.label)).toEqual(['≥ 0', '≥ 25', '≥ 50', '≥ 75']);
    expect(legendEntries(l, desc(l.id, { type: 'quantile', domain: [0, 10, 50, 400], range: ['#a', '#b', '#c'] })).entries.map((e) => e.label)).toEqual(['≥ 0', '≥ 10', '≥ 50']);
  });

  it('reports no data for an aggregated H3 layer without a domain', () => {
    const h = setH3ColorBy(newLayer('h3', hex, 0), 'count', undefined, 'quantize', 'Sunset', 5, null);
    expect(legendEntries(h, desc(h.id, { type: 'quantize', domain: [0, 1], range: ['#a'] })).empty).toBe(true);
    render(<Legend layers={[h]} descriptors={[desc(h.id)]} />);
    expect(screen.getByText('No data')).toBeInTheDocument();
  });

  it('hides invisible layers', () => {
    const l = { ...newLayer('tileset', pts, 0) };
    l.config = { ...l.config, isVisible: false };
    const { container } = render(<Legend layers={[l]} descriptors={[desc(l.id)]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
