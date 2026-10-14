import { describe, expect, it, vi } from 'vitest';
import type { LoadedDataset } from '../map/prepareMap';
import { h3ColorDomain } from './h3Domain';

const dataset = {
  id: 'h', type: 'query', source: 'SELECT h3, value FROM demo_points', geoColumn: 'h3:h3', queryParameters: { min: 1 },
  data: { tiles: ['http://x/v3/maps/osm/query/{i}?aggregationResLevel=4&q=…'], maxresolution: 8 },
} as unknown as LoadedDataset;

const stats = (body: unknown) => vi.fn(async (_u: RequestInfo | URL, _i?: RequestInit) => new Response(JSON.stringify(body)));

describe('h3ColorDomain', () => {
  it('queries per-cell aggregates at the display resolution', async () => {
    const f = stats({ min: 1, max: 9, quantiles: { '4': [1, 2, 3, 5, 9] } });
    const domain = await h3ColorDomain({ dataset, expression: 'count(*)', scale: 'quantile', steps: 4, viewport: { zoom: 12, latitude: 35.7 }, ctx: { apiBaseUrl: 'http://x', accessToken: 't' }, fetcher: f });
    expect(domain).toEqual([1, 2, 3, 5, 9]);
    const url = new URL(String(f.mock.calls[0][0]));
    expect(url.pathname).toBe('/v3/stats/osm/__value');
    const q = url.searchParams.get('q')!;
    expect(q).toMatch(/^SELECT h3_cell_to_parent\("h3", (\d+)\) AS __cell, count\(\*\) AS __value FROM \(SELECT h3, value FROM demo_points\) AS __q GROUP BY 1$/);
    expect(Number(q.match(/, (\d+)\) AS __cell/)![1])).toBeLessThanOrEqual(12); // capped at the data resolution (8 + 4)
    expect(url.searchParams.get('queryParameters')).toBe('{"min":1}');
  });

  it('uses [min, max] for quantize and null when there is no data', async () => {
    const ctx = { apiBaseUrl: 'http://x', accessToken: 't' };
    expect(await h3ColorDomain({ dataset, expression: 'count(*)', scale: 'quantize', steps: 5, viewport: { zoom: 3, latitude: 0 }, ctx, fetcher: stats({ min: 2, max: 7 }) })).toEqual([2, 7]);
    expect(await h3ColorDomain({ dataset, expression: 'count(*)', scale: 'quantize', steps: 5, viewport: { zoom: 3, latitude: 0 }, ctx, fetcher: stats({ attribute: '__value', type: 'Number' }) })).toBeNull();
  });
});
