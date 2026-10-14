import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import type { MapSummary } from '../lib/mapDoc';
import { MapsPage } from './MapsPage';

function summary(i: number): MapSummary {
  return {
    id: `m${i}`, title: `Map ${i}`, description: '', tags: [], privacy: i % 2 ? 'public' : 'private', collaborative: false,
    ownerId: 'dev-user', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-02T00:00:00Z', thumbnailUrl: null, views: 0,
  };
}

// Fake workspace API: `total` maps, 12 per page; POST creates "new-1".
function fakeApi(total: number) {
  const calls: string[] = [];
  const f = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    if (init?.method === 'POST') return new Response(JSON.stringify({ ...summary(99), id: 'new-1' }), { status: 201 });
    const page = Number(new URL(url, 'http://test').searchParams.get('page'));
    const start = (page - 1) * 12;
    const data = Array.from({ length: Math.max(0, Math.min(12, total - start)) }, (_, k) => summary(start + k + 1));
    return new Response(JSON.stringify({ data, meta: { page: { total, current: page, pageSize: 12, totalPages: Math.ceil(total / 12) } } }));
  });
  return { f, calls };
}

function renderPage(f: typeof fetch) {
  return render(
    <MemoryRouter initialEntries={['/maps']}>
      <Routes>
        <Route path="/maps" element={<MapsPage fetcher={f} />} />
        <Route path="/viewer/:id" element={<p>viewer page</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('MapsPage', () => {
  it('lists maps and loads more pages', async () => {
    const { f } = fakeApi(14);
    renderPage(f);
    expect(await screen.findByText('Map 1')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(12);
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('Map 14')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(14);
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });

  it('refetches when search, sort and permission filter change', async () => {
    const { f, calls } = fakeApi(3);
    renderPage(f);
    await screen.findByText('Map 1');
    fireEvent.change(screen.getByLabelText('Search maps'), { target: { value: 'tokyo' } });
    await waitFor(() => expect(calls.at(-1)).toContain('search=tokyo'));
    fireEvent.change(screen.getByLabelText('Sort'), { target: { value: 'title:ASC' } });
    await waitFor(() => expect(calls.at(-1)).toContain('order_by=title&order_direction=ASC'));
    fireEvent.change(screen.getByLabelText('Permissions'), { target: { value: 'public' } });
    await waitFor(() => expect(calls.at(-1)).toContain('privacy=public'));
  });

  it('shows the empty state and creates a first map', async () => {
    const { f, calls } = fakeApi(0);
    renderPage(f);
    fireEvent.click(await screen.findByRole('button', { name: 'Create your first map' }));
    expect(await screen.findByText('viewer page')).toBeInTheDocument();
    expect(calls).toContain('POST /api/workspace/maps');
  });

  it('shows API errors', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ error: 'boom' }), { status: 500 }));
    renderPage(f);
    expect(await screen.findByRole('alert')).toHaveTextContent('boom');
  });
});
