import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { newDataset } from '../lib/defaults';
import { SourcesPanel } from './SourcesPanel';
import type { Action } from './state';

const resources = [{ name: 'demo_points', geoColumn: 'geom', h3Column: 'h3', columns: [{ name: 'value', type: 'number' }] }];
const fetcher = vi.fn(async () => new Response(JSON.stringify(resources)));

function setup(props: Partial<Parameters<typeof SourcesPanel>[0]> = {}) {
  const dispatch = vi.fn<(a: Action) => void>();
  render(<SourcesPanel datasets={[]} errors={{}} layerCount={0} dispatch={dispatch} fetcher={fetcher} {...props} />);
  return dispatch;
}

const actions = (d: ReturnType<typeof setup>) => d.mock.calls.map(([a]) => a);

describe('SourcesPanel', () => {
  it('adds a table source together with a layer', async () => {
    const dispatch = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Add source' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Add demo_points' }));
    const [add, layer] = actions(dispatch);
    expect(add).toMatchObject({ type: 'addDataset', dataset: { type: 'table', source: 'demo_points', geoColumn: 'geom', label: 'demo_points' } });
    expect(layer).toMatchObject({ type: 'addLayer', layer: { type: 'tileset' } });
  });

  it('adds the H3 variant of a table with an H3 column', async () => {
    const dispatch = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Add source' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Add demo_points as H3' }));
    const [add, layer] = actions(dispatch);
    expect(add).toMatchObject({ dataset: { geoColumn: 'h3:h3', aggregationResLevel: 4 } });
    expect(layer).toMatchObject({ layer: { type: 'h3' } });
  });

  it('adds a custom SQL source as a query template', () => {
    const dispatch = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Add source' }));
    fireEvent.change(screen.getByLabelText('SQL query'), { target: { value: 'SELECT h3 FROM osm_points' } });
    fireEvent.change(screen.getByLabelText('Spatial column'), { target: { value: 'h3' } });
    fireEvent.click(screen.getByLabelText('H3 index'));
    fireEvent.click(screen.getByRole('button', { name: 'Add query' }));
    expect(actions(dispatch)[0]).toMatchObject({ dataset: { type: 'query', queryTemplate: 'SELECT h3 FROM osm_points', geoColumn: 'h3:h3' } });
  });

  it('shows dataset errors and edits SQL', () => {
    const ds = newDataset({ type: 'query', source: 'SELECT 1', queryTemplate: 'SELECT 1', geoColumn: 'geom', label: 'Q' });
    const dispatch = setup({ datasets: [ds], errors: { [ds.id]: 'unknown parameter {{x}}' } });
    expect(screen.getByRole('alert')).toHaveTextContent('unknown parameter {{x}}');
    fireEvent.click(screen.getByRole('button', { name: 'Edit SQL of Q' }));
    fireEvent.change(screen.getByLabelText('SQL of Q'), { target: { value: 'SELECT 2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(actions(dispatch)[0]).toEqual({ type: 'updateDataset', id: ds.id, patch: { queryTemplate: 'SELECT 2', source: 'SELECT 2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Remove Q' }));
    expect(actions(dispatch)[1]).toEqual({ type: 'removeDataset', id: ds.id });
  });
});
