import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { newDataset, newMapConfig, newWidget } from '../lib/defaults';
import type { MapDoc } from '../lib/mapDoc';
import { prepareMap } from '../map/prepareMap';
import { ViewerPage } from './ViewerPage';

vi.mock('../map/MapSurface', () => ({ MapSurface: () => <div data-testid="map" /> }));
vi.mock('../map/prepareMap', () => ({ prepareMap: vi.fn() }));

const ds = newDataset({ type: 'query', source: '', queryTemplate: 'SELECT * FROM demo_points WHERE category IN {{kinds}}', geoColumn: 'geom', label: 'Q' });
const k = newMapConfig();
k.config.sqlParameters = [{ id: 'p', type: 'Category', name: 'Kinds', item: { sqlName: 'kinds', value: ['cafe', 'park'] }, values: ['cafe', 'park'], selectionMode: 'multi' }];
k.config.widgets = [newWidget('formula', ds.id, '*', 'Total POIs')];
const doc = { id: 'm', title: 'Public demo', keplerMapConfig: k } as unknown as MapDoc;

describe('ViewerPage', () => {
  it('shows parameter controls and widgets, and re-renders locally on change', async () => {
    const ws = { getFormula: vi.fn(async () => ({ value: 42 })) };
    vi.mocked(prepareMap).mockImplementation(async (_d, datasets) => ({
      parsed: { layers: [] } as never,
      datasets: datasets.map((d) => ({ ...d, data: { tiles: ['t'], widgetSource: ws } })) as never,
      errors: {},
    }));
    const load = vi.fn(async () => ({ doc, datasets: [ds] }));
    render(
      <MemoryRouter initialEntries={['/viewer/m']}>
        <Routes>
          <Route path="/viewer/:id" element={<ViewerPage load={load} />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByRole('heading', { name: 'Public demo' })).toBeInTheDocument();
    expect(await screen.findByText('Total POIs')).toBeInTheDocument();
    expect(await screen.findByText('42')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Kinds: park'));
    await vi.waitFor(() => {
      const last = vi.mocked(prepareMap).mock.calls.at(-1)!;
      expect(last[1][0].queryParameters).toEqual({ kinds: ['cafe'] });
    });
  });
});
