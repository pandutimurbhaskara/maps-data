import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { newDataset } from '../lib/defaults';
import type { LoadedDataset } from '../map/prepareMap';
import { WidgetsPanel } from './WidgetsPanel';
import type { Action } from './state';

it('adds and removes widgets', () => {
  const ds = newDataset({ type: 'table', source: 'demo_points', geoColumn: 'geom', label: 'Points' });
  const loaded = [{ ...ds, data: { schema: [{ name: 'category', type: 'string' }, { name: 'value', type: 'number' }] } }] as unknown as LoadedDataset[];
  const dispatch = vi.fn<(a: Action) => void>();
  const { rerender } = render(<WidgetsPanel widgets={[]} datasets={[ds]} loaded={loaded} dispatch={dispatch} />);
  fireEvent.change(screen.getByLabelText('Widget type'), { target: { value: 'category' } });
  fireEvent.change(screen.getByLabelText('Widget source'), { target: { value: ds.id } });
  fireEvent.change(screen.getByLabelText('Widget column'), { target: { value: 'category' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add widget' }));
  const added = dispatch.mock.calls[0][0];
  expect(added).toMatchObject({ type: 'addWidget', widget: { type: 'category', dataSource: ds.id, column: 'category', operation: 'count' } });
  if (added.type !== 'addWidget') throw new Error();
  rerender(<WidgetsPanel widgets={[added.widget]} datasets={[ds]} loaded={loaded} dispatch={dispatch} />);
  fireEvent.click(screen.getByRole('button', { name: `Remove ${added.widget.title}` }));
  expect(dispatch.mock.calls[1][0]).toEqual({ type: 'removeWidget', id: added.widget.id });
});
