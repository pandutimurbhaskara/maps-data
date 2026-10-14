import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { newWidget } from '../lib/defaults';
import type { LoadedDataset } from '../map/prepareMap';
import { equalTicks, toggleCategory, Widget } from './Widget';

function dataset(ws: Record<string, unknown>) {
  return { id: 'd', data: { tiles: ['t'], widgetSource: ws } } as unknown as LoadedDataset;
}

describe('Widget', () => {
  it('shows a formula', async () => {
    const ws = { getFormula: vi.fn(async (_o: unknown) => ({ value: 1234.5 })) };
    render(<Widget widget={newWidget('formula', 'd', '*')} dataset={dataset(ws)} filters={{}} />);
    expect(await screen.findByText('1,234.5')).toBeInTheDocument();
    expect(ws.getFormula).toHaveBeenCalledWith(expect.objectContaining({ column: '*', operation: 'count' }));
  });

  it('category widget excludes its own filter and toggles selections', async () => {
    const w = newWidget('category', 'd', 'category');
    const ws = { getCategories: vi.fn(async (_o: unknown) => [{ name: 'cafe', value: 100 }, { name: 'park', value: 50 }]) };
    const onFilter = vi.fn();
    const filters = { category: { in: { values: ['cafe'], owner: w.id } } };
    render(<Widget widget={w} dataset={dataset(ws)} filters={filters} onFilter={onFilter} />);
    expect(await screen.findByRole('button', { name: /park/ })).toBeInTheDocument();
    expect(ws.getCategories).toHaveBeenCalledWith(expect.objectContaining({ filterOwner: w.id, filters }));
    expect(screen.getByRole('button', { name: /cafe/ })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: /park/ }));
    expect(onFilter).toHaveBeenLastCalledWith({ category: { in: { values: ['cafe', 'park'], owner: w.id } } });
    fireEvent.click(screen.getByRole('button', { name: /cafe/ }));
    expect(onFilter).toHaveBeenLastCalledWith({});
  });

  it('histogram buckets the range into equal ticks', async () => {
    const ws = { getRange: vi.fn(async (_o: unknown) => ({ min: 0, max: 100 })), getHistogram: vi.fn(async (_o: unknown) => [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) };
    render(<Widget widget={newWidget('histogram', 'd', 'value')} dataset={dataset(ws)} filters={{}} />);
    expect(await screen.findAllByRole('listitem')).toHaveLength(10);
    expect(ws.getHistogram).toHaveBeenCalledWith(expect.objectContaining({ ticks: [10, 20, 30, 40, 50, 60, 70, 80, 90] }));
  });

  it('shows errors and an empty state', async () => {
    const failing = { getFormula: vi.fn(async () => Promise.reject(new Error('boom'))) };
    const { unmount } = render(<Widget widget={newWidget('formula', 'd', '*')} dataset={dataset(failing)} filters={{}} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('boom');
    unmount();
    render(<Widget widget={newWidget('formula', 'missing', '*')} filters={{}} />);
    expect(screen.getByText('Source not loaded')).toBeInTheDocument();
  });

  it('pure helpers', () => {
    expect(equalTicks(0, 10, 5)).toEqual([2, 4, 6, 8]);
    expect(equalTicks(3, 3, 5)).toEqual([]);
    const w = newWidget('category', 'd', 'kind');
    expect(toggleCategory({}, w, 'a')).toEqual({ kind: { in: { values: ['a'], owner: w.id } } });
  });
});
