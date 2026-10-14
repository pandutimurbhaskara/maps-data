import { describe, expect, it, vi } from 'vitest';
import { ApiError, createMap, listMaps, listMapsUrl } from './workspaceApi';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('workspaceApi', () => {
  it('builds the list URL with CARTO-style snake_case params', () => {
    expect(listMapsUrl({})).toBe('/api/workspace/maps?page=1&page_size=12&order_by=updated_at&order_direction=DESC');
    expect(listMapsUrl({ page: 2, pageSize: 50, search: 'tokyo cafés', orderBy: 'title', orderDirection: 'ASC', privacy: 'public' })).toBe(
      '/api/workspace/maps?page=2&page_size=50&order_by=title&order_direction=ASC&search=tokyo+caf%C3%A9s&privacy=public',
    );
  });

  it('returns the parsed page', async () => {
    const f = vi.fn(async () => json({ data: [], meta: { page: { total: 0, current: 1, pageSize: 12, totalPages: 0 } } }));
    const page = await listMaps({}, f);
    expect(page.meta.page.total).toBe(0);
  });

  it('throws ApiError with the server message', async () => {
    const f = vi.fn(async () => json({ error: 'order_by must be updated_at or title', status: 400 }, 400));
    await expect(listMaps({}, f)).rejects.toEqual(new ApiError(400, 'order_by must be updated_at or title'));
  });

  it('POSTs JSON when creating a map', async () => {
    const f = vi.fn(async () => json({ id: 'm1' }, 201));
    await createMap({ title: 'T' }, f);
    expect(f).toHaveBeenCalledWith('/api/workspace/maps', expect.objectContaining({ method: 'POST', body: '{"title":"T"}' }));
  });
});
