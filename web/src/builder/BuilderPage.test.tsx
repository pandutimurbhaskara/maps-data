import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { newMapConfig } from '../lib/defaults';
import { BuilderPage } from './BuilderPage';

vi.mock('../map/MapView', () => ({ MapView: () => <div data-testid="map" /> }));
vi.mock('../map/prepareMap', () => ({ prepareMap: vi.fn(async () => ({ parsed: { layers: [] }, datasets: [], errors: {} })) }));

const map = { id: 'm1', title: 'Tokyo', keplerMapConfig: newMapConfig() };
const fetcher = vi.fn(async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url.endsWith('/datasets')) return new Response('[]');
  return new Response(JSON.stringify(map));
});

describe('BuilderPage', () => {
  it('loads the map, renames it and autosaves', async () => {
    const api = { patchMap: vi.fn(async () => ({})), saveDataset: vi.fn(), deleteDataset: vi.fn() };
    render(
      <MemoryRouter initialEntries={['/builder/m1']}>
        <Routes>
          <Route path="/builder/:id" element={<BuilderPage api={api} fetcher={fetcher} autosaveDelayMs={10} />} />
        </Routes>
      </MemoryRouter>,
    );
    const title = await screen.findByLabelText('Map title');
    expect(title).toHaveValue('Tokyo');
    expect(screen.getByTestId('map')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Preview' })).toHaveAttribute('href', '/viewer/m1');
    fireEvent.change(title, { target: { value: 'Tokyo POIs' } });
    await vi.waitFor(() => expect(api.patchMap).toHaveBeenCalledWith('m1', expect.objectContaining({ title: 'Tokyo POIs' })));
    expect(await screen.findByText('Saved')).toBeInTheDocument();
    for (const tab of ['Layers', 'Widgets', 'Parameters', 'Sources']) fireEvent.click(screen.getByRole('tab', { name: tab }));
  });
});
